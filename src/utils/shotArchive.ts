import { dateKey } from './date'

/**
 * 历史抓拍的本机档案（2026-11-19）
 *
 * ## 为什么需要「本机档案」
 *
 * 《监控快照接口使用说明》写得很明确：`/api/video/snapshots` 只回**最近一次
 * 成功更新**的那一帧，且「万方不保存截图、不做历史快照留存」，实测也不接受
 * `date` / `startTime` 之类的参数（带未知参数直接 400），
 * `/snapshots/history`、`/list`、`/records`、`/count` 全是 nginx 404。
 *
 * 也就是说**服务端根本没有按天查询的能力**。设计稿里「每天 3 张」来自上游的
 * 更新节奏（08:00 / 12:00 / 18:00，每天三次），不是一份可查的历史列表。
 *
 * 所以这里做的是：**每取到一帧就按「通道 + 更新档」存到本机**（IndexedDB），
 * 历史抓拍页读这份档案。好处是照片、时刻、张数全是真的，不拿演示图凑数；
 * 代价是**换设备 / 清缓存后，之前的日期没有记录** —— 页面会明确说出来，
 * 而不是显示一张看着像历史的假图。
 *
 * 将来万方真开了历史接口，只需要替换 `stores/cam.ts` 的 `loadShots()`：
 * 本文件是存储层，不掺业务判断。
 *
 * ## 存什么
 *
 * 每条记录两份字节：
 *   · `thumb` —— 列表用的**压缩预览**（长边 480 的 WebP，约 20KB）；
 *   · `full`  —— 详情「查看原图」用的原始字节（实测 200~500KB）。
 *
 * 原图必须留下：快照接口每次返回的都是同一张，下次未必还在（上游会覆盖），
 * 所以「历史」的意义就在于把当时那张原图留住。
 *
 * 容量靠淘汰兜住：只留最近 {@link SHOT_KEEP_DAYS} 天，总量超过
 * {@link SHOT_MAX_BYTES} 时从最旧的开始删（一张原图 280KB，一个通道一天
 * 最多 3 张，正常用不到上限）。
 */

/** 每天的快照更新档（北京时间 08:00 / 12:00 / 18:00，见接口文档第 3 节） */
export const SHOT_SLOT_HOURS = [8, 12, 18] as const

/**
 * 档案保留天数（超过就淘汰最旧的）。
 *
 * 必须 ≥ `stores/cam.ts` 的 `SHOT_RANGE_DAYS`（可选日期范围）：日期选得进来
 * 档案却已经删了，用户看到的就是一排「没有记录」的死日期。两边对齐到 30 天。
 */
export const SHOT_KEEP_DAYS = 30

/** 档案总字节上限（超出按最旧淘汰） */
export const SHOT_MAX_BYTES = 64 * 1024 * 1024

/** 缩略图长边（像素） */
const THUMB_MAX_W = 480

/** 一条抓拍档案 */
export interface ShotRecord {
  /** 主键：`通道|日期|档位`，同一档重复取图直接覆盖，天然去重 */
  key: string
  channelId: string
  /** 'YYYY-MM-DD'，按**档位归属日**算（凌晨取到的是昨天 18:00 那一档） */
  day: string
  /** 档位序号 0 / 1 / 2 */
  slot: number
  /** 这张图第一次被抓到的时刻（ms）—— 页面上显示的就是它 */
  at: number
  /** 原图字节数 */
  size: number
  /** 压缩预览 */
  thumb: Blob
  /** 原图 */
  full: Blob
}

/** 一条档案的轻量元信息（淘汰 / 计数用，不带图片字节） */
interface ShotMeta {
  key: string
  channelId: string
  day: string
  at: number
  size: number
}

/** 某一时刻属于哪一档 */
export interface ShotSlotRef {
  /** 档位归属日 'YYYY-MM-DD' */
  day: string
  /** 档位序号 */
  slot: number
  /** 该档的整点时刻（ms） */
  boundary: number
}

/**
 * 取 `ts` 所属的更新档。
 *
 * 语义是「**最近一次已经发生的更新**」：09:19 取到的图属于 08:00 那一档；
 * 07:30 取到的还是昨天 18:00 那一档（今天 08:00 的还没生成）。
 * 所以凌晨打开监控时，那张图会记到昨天，不会被算成今天的第一张。
 */
export function slotAt(ts: number): ShotSlotRef {
  const d = new Date(ts)
  for (let i = SHOT_SLOT_HOURS.length - 1; i >= 0; i--) {
    const b = new Date(d)
    b.setHours(SHOT_SLOT_HOURS[i], 0, 0, 0)
    if (b.getTime() <= ts) return { day: dateKey(b), slot: i, boundary: b.getTime() }
  }
  const y = new Date(d)
  y.setDate(y.getDate() - 1)
  y.setHours(SHOT_SLOT_HOURS[SHOT_SLOT_HOURS.length - 1], 0, 0, 0)
  return { day: dateKey(y), slot: SHOT_SLOT_HOURS.length - 1, boundary: y.getTime() }
}

/* ------------------------------------------------------------------ *
 * 存储：IndexedDB 优先，环境不支持（单测 / 老 WebView）时退内存
 * ------------------------------------------------------------------ */

const DB_NAME = 'xyc-cam-shots'
const DB_VER = 1
const STORE_SHOT = 'shots'
const STORE_META = 'meta'

let dbPromise: Promise<IDBDatabase | null> | null = null

/** 内存兜底（没有 IndexedDB 的环境；进程内有效，刷新即丢） */
const memShots = new Map<string, ShotRecord>()

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    let idb: IDBFactory | undefined
    try {
      idb = globalThis.indexedDB
    } catch {
      idb = undefined
    }
    if (!idb) {
      resolve(null)
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = idb.open(DB_NAME, DB_VER)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_SHOT)) {
        const os = db.createObjectStore(STORE_SHOT, { keyPath: 'key' })
        os.createIndex('channel_day', ['channelId', 'day'])
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' })
      }
    }
    // 某些隐私模式下 open 既不成功也不报错：给个超时，别把页面吊死。
    // 成功 / 失败都要把它清掉，否则一条 3 秒的空定时器会把进程多吊一会儿。
    let settled = false
    const done = (db: IDBDatabase | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(db)
    }
    const timer = setTimeout(() => done(null), 3000)
    req.onsuccess = () => done(req.result)
    req.onerror = () => done(null)
    req.onblocked = () => done(null)
  })
  return dbPromise
}

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 操作失败'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
  })
}

/**
 * 生成压缩预览。
 *
 * 用 canvas 缩到长边 480 的 WebP（质量 0.72），实测一张 280KB 的 JPEG 出来
 * 约 18~25KB —— 列表里 3 张也只有 60KB 上下。
 *
 * 任何一步拿不到（单测环境没有 canvas / 解码失败 / toBlob 不支持 webp）都
 * **退回原始字节**：预览大一点不影响正确性，卡住列表才是问题。
 */
export async function makeThumb(blob: Blob, maxW = THUMB_MAX_W): Promise<Blob> {
  try {
    if (typeof document === 'undefined') return blob
    // 先探一下 canvas 能不能用（单测环境 / 老 WebView 会直接没有 2d 上下文）：
    // 拿不到就没必要再去解码 —— 白等一次超时，列表会明显变慢
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return blob

    const url = URL.createObjectURL(blob)
    try {
      const img = await loadImage(url)
      const w = img.naturalWidth || img.width
      const h = img.naturalHeight || img.height
      if (!w || !h) return blob
      const scale = Math.min(1, maxW / w)
      const tw = Math.max(1, Math.round(w * scale))
      const th = Math.max(1, Math.round(h * scale))
      canvas.width = tw
      canvas.height = th
      ctx.drawImage(img, 0, 0, tw, th)
      const out = await toBlob(canvas)
      // 编不出来 / 反而更大（本来就是小图）→ 用原图
      return out && out.size > 0 && out.size < blob.size ? out : blob
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch {
    return blob
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const timer = setTimeout(() => reject(new Error('图片解码超时')), 1500)
    img.onload = () => {
      clearTimeout(timer)
      resolve(img)
    }
    img.onerror = () => {
      clearTimeout(timer)
      reject(new Error('图片解码失败'))
    }
    img.src = url
  })
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/webp', 0.72)
    } catch {
      resolve(null)
    }
  })
}

/** 读一条（只用于判断「这一档是不是同一张图」） */
async function getShot(key: string): Promise<ShotRecord | null> {
  const db = await openDb()
  if (!db) return memShots.get(key) ?? null
  try {
    const tx = db.transaction(STORE_SHOT, 'readonly')
    const rec = await reqDone<ShotRecord | undefined>(tx.objectStore(STORE_SHOT).get(key))
    return rec ?? null
  } catch {
    return null
  }
}

/** 写一条（同时更新元信息） */
async function putShot(rec: ShotRecord): Promise<void> {
  const db = await openDb()
  if (!db) {
    memShots.set(rec.key, rec)
    return
  }
  const tx = db.transaction([STORE_SHOT, STORE_META], 'readwrite')
  tx.objectStore(STORE_SHOT).put(rec)
  const meta: ShotMeta = {
    key: rec.key,
    channelId: rec.channelId,
    day: rec.day,
    at: rec.at,
    size: rec.size,
  }
  tx.objectStore(STORE_META).put(meta)
  await txDone(tx)
}

/**
 * 存一帧快照。
 *
 * 同一档（同一天同一个更新时段）再取到**同样大小**的字节时，认为服务端还没
 * 更新，保留原来那条（时刻也不动）—— 否则每打开一次监控，照片的「拍摄时刻」
 * 就往后跳一次，看着像刚刚拍的。字节大小变了才覆盖：那是真的换了新一张。
 */
export async function saveShot(
  channelId: string,
  blob: Blob,
  at: number = Date.now(),
): Promise<ShotRecord> {
  const ref = slotAt(at)
  const key = `${channelId}|${ref.day}|${ref.slot}`
  const prev = await getShot(key)
  if (prev && prev.size === blob.size) return prev

  const thumb = await makeThumb(blob)
  const rec: ShotRecord = {
    key,
    channelId,
    day: ref.day,
    slot: ref.slot,
    at,
    size: blob.size,
    thumb,
    full: blob,
  }
  await putShot(rec)
  await prune()
  return rec
}

/** 读某通道某天的全部抓拍（按档位正序：08:00 → 12:00 → 18:00） */
export async function listShots(channelId: string, day: string): Promise<ShotRecord[]> {
  const db = await openDb()
  if (!db) {
    return [...memShots.values()]
      .filter((r) => r.channelId === channelId && r.day === day)
      .sort((a, b) => a.slot - b.slot)
  }
  try {
    const tx = db.transaction(STORE_SHOT, 'readonly')
    const idx = tx.objectStore(STORE_SHOT).index('channel_day')
    const rows = await reqDone<ShotRecord[]>(idx.getAll([channelId, day]))
    return rows.sort((a, b) => a.slot - b.slot)
  } catch {
    return []
  }
}

/**
 * 淘汰：先按天数，再按总量。
 *
 * 顺序很重要 —— 先删过期的那批，剩下的总量还超标时才动最近的，
 * 避免「最近拍的反而先被删」。
 */
export async function prune(now = Date.now()): Promise<void> {
  const minDay = dateKey(new Date(now - SHOT_KEEP_DAYS * 86400000))
  const db = await openDb()

  if (!db) {
    const old = [...memShots.values()].filter((r) => r.day < minDay)
    for (const r of old) memShots.delete(r.key)
    let total = [...memShots.values()].reduce((s, r) => s + r.size + r.thumb.size, 0)
    if (total <= SHOT_MAX_BYTES) return
    const rest = [...memShots.values()].sort((a, b) => a.at - b.at)
    for (const r of rest) {
      if (total <= SHOT_MAX_BYTES) break
      total -= r.size + r.thumb.size
      memShots.delete(r.key)
    }
    return
  }

  try {
    const tx0 = db.transaction(STORE_META, 'readonly')
    const metas = await reqDone<ShotMeta[]>(tx0.objectStore(STORE_META).getAll())
    const dead = metas.filter((m) => m.day < minDay).map((m) => m.key)

    let total = metas.filter((m) => m.day >= minDay).reduce((s, m) => s + m.size, 0)
    if (total > SHOT_MAX_BYTES) {
      const byAge = metas
        .filter((m) => m.day >= minDay)
        .sort((a, b) => a.at - b.at)
      for (const m of byAge) {
        if (total <= SHOT_MAX_BYTES) break
        total -= m.size
        dead.push(m.key)
      }
    }
    if (!dead.length) return

    const tx = db.transaction([STORE_SHOT, STORE_META], 'readwrite')
    const shots = tx.objectStore(STORE_SHOT)
    const meta = tx.objectStore(STORE_META)
    for (const key of dead) {
      shots.delete(key)
      meta.delete(key)
    }
    await txDone(tx)
  } catch {
    /* 淘汰失败不影响本次展示，下次再说 */
  }
}

/** 清空（登出 / 换账号时用） */
export async function clearShots(): Promise<void> {
  const db = await openDb()
  memShots.clear()
  if (!db) return
  try {
    const tx = db.transaction([STORE_SHOT, STORE_META], 'readwrite')
    tx.objectStore(STORE_SHOT).clear()
    tx.objectStore(STORE_META).clear()
    await txDone(tx)
  } catch {
    /* 忽略 */
  }
}
