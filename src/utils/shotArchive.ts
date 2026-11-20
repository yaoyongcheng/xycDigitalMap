import { camShotImageUrl, fetchCamShotImage } from '@/api/camsnap'
import { dateKey } from './date'

/**
 * 历史抓拍的数据层（2026-11-20 改走服务端历史接口）
 *
 * ## 这次改了什么
 *
 * 更早的版本服务端只有「最近一帧」快照、没有历史（`/snapshots/history` 当时 404），
 * 于是历史抓拍页只能靠**本机档案**：每打开一次监控就把那一帧按「08/12/18 档」
 * 存进 IndexedDB，换设备 / 清缓存后以前的日期全是空的。
 *
 * 现在服务端只有历史接口（《监控快照接口.docx》，近 30 天、按天可查、带 `mark`），
 * 旧的「最近一帧」地址（`…/snapshots?pid&channelId`）已下线，本机档案不再负责
 * 「补一张最新画面」，只做图片缓存：
 *   · **列表与时刻都以服务端为准** —— `mark` / `capturedAt` / `fileSize` 原样用，
 *     不再用本机时钟猜「属于哪一档」；
 *   · 本机只做**图片缓存**：一张 200~340KB，同一张反复看没必要重复下；
 *     缩略图（长边 480 的 WebP）也在首次落盘时生成，列表只挂它。
 *
 * ## 为什么还要本机缓存
 *
 * 图片必须带 `X-API-Key` 头取（文档要求），不能塞 `<img src>`；工地弱网下一张
 * 要一两秒。缓存按 `通道|mark` 存（`mark` 是服务端唯一标识，天然去重），
 * 有效期跟着接口的 30 天走，超出按最旧淘汰。
 *
 * 本文件同时是**唯一取图入口**（{@link ensureShot}）：工作台的「历史抓拍」与
 * 首页智眸的「塔吊 / 出入口抓拍」都调它，两条路径的缓存键、超时、缩略图规则
 * 才不会各写一套。
 */

/** 缓存保留天数：与接口可查范围一致（近 30 个自然日） */
export const SHOT_KEEP_DAYS = 30

/** 缓存总字节上限（超出按最旧淘汰） */
export const SHOT_MAX_BYTES = 64 * 1024 * 1024

/** 缩略图长边（像素） */
const THUMB_MAX_W = 480

/** 一条抓拍缓存 */
export interface ShotRecord {
  /** 主键：`通道|mark`（同一张重复落到同一条） */
  key: string
  channelId: string
  /** 服务端抓拍标识 `YYYYMMDDHHmmss` */
  mark: string
  /** 'YYYY-MM-DD'（按服务端抓拍时刻换算的本地自然日） */
  day: string
  /** 抓拍时刻（ms，服务端给的） */
  at: number
  /** 原图字节数 */
  size: number
  /** 压缩预览 */
  thumb: Blob
  /** 原图 */
  full: Blob
}

/** 列表里一行最少需要的信息（够了就能取到图，也能落到缓存） */
export interface ShotItemRef {
  mark: string
  at: number
  /** 服务端声明的字节数：与缓存一致就直接用缓存，不必再下 */
  size?: number
  /** 服务端给的图片地址（为空时退回「最近一帧」） */
  imageUrl?: string
}

/** 一条缓存的轻量元信息（淘汰 / 找最新用，不带图片字节） */
interface ShotMeta {
  key: string
  channelId: string
  mark: string
  day: string
  at: number
  size: number
}

/** 缓存主键 */
export function shotKey(channelId: string, mark: string): string {
  return `${channelId}|${mark}`
}

/* ------------------------------------------------------------------ *
 * 存储：IndexedDB 优先，环境不支持（单测 / 老 WebView）时退内存
 * ------------------------------------------------------------------ */

const DB_NAME = 'xyc-cam-shots'
/** v2：主键从「通道|日期|档位」换成「通道|mark」，旧键不再有意义，升级时整库重建 */
const DB_VER = 2
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
      // 旧版本（v1）的键是 `通道|日期|档位`，与新口径对不上：与其逐条迁移，
      // 不如丢掉 —— 它只是缓存，重看一遍就能补回来。
      for (const name of [STORE_SHOT, STORE_META]) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
      }
      const os = db.createObjectStore(STORE_SHOT, { keyPath: 'key' })
      os.createIndex('channel_day', ['channelId', 'day'])
      os.createIndex('channel', 'channelId')
      const meta = db.createObjectStore(STORE_META, { keyPath: 'key' })
      meta.createIndex('channel', 'channelId')
    }
    // 某些隐私模式下 open 既不成功也不报错：给个超时，别把页面吊死。
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
 * 用 canvas 缩到长边 480 的 WebP（质量 0.72），实测一张 300KB 的 JPEG 出来
 * 约 20KB —— 三列网格里 3~7 张也只有 100KB 上下。
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

/** 读一条缓存 */
export async function getShot(channelId: string, mark: string): Promise<ShotRecord | null> {
  if (!channelId || !mark) return null
  const key = shotKey(channelId, mark)
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
    mark: rec.mark,
    day: rec.day,
    at: rec.at,
    size: rec.size,
  }
  tx.objectStore(STORE_META).put(meta)
  await txDone(tx)
}

/**
 * 存一张抓拍。
 *
 * 同一 `mark` 再取到**同样大小**的字节时直接复用原来那条（缩略图也不必重做）——
 * 服务端同一张图不会变，重做只是白烧 CPU。
 */
export async function saveShot(
  channelId: string,
  mark: string,
  at: number,
  blob: Blob,
): Promise<ShotRecord> {
  if (!channelId || !mark) throw new Error('缺少通道号或抓拍标识')
  const key = shotKey(channelId, mark)
  const prev = await getShot(channelId, mark)
  if (prev && prev.size === blob.size) return prev

  const thumb = await makeThumb(blob)
  const rec: ShotRecord = {
    key,
    channelId,
    mark,
    day: dateKey(at),
    at,
    size: blob.size,
    thumb,
    full: blob,
  }
  await putShot(rec)
  await prune()
  return rec
}

/**
 * 取一张抓拍（**唯一取图入口**）：缓存优先，没有再按服务端给的 `imageUrl` 下载。
 *
 * - 缓存命中且字节数与服务端声明一致 → 直接用（不花流量、不用等）；
 * - 不一致（服务端换了图 / 缓存是旧的）→ 重下并覆盖；
 * - `item.imageUrl` 为空 → 直接报「缺少抓拍图片地址」（数据问题，不拿别的地址顶替；
 *   原来的「最近一帧」兜底地址已随旧接口一起下线）。
 */
export async function ensureShot(
  channelId: string,
  item: ShotItemRef,
  signal?: AbortSignal,
): Promise<ShotRecord> {
  const cached = await getShot(channelId, item.mark)
  if (cached && (!item.size || cached.size === item.size)) return cached

  const img = await fetchCamShotImage(camShotImageUrl(item.imageUrl ?? ''), signal)
  return await saveShot(
    channelId,
    item.mark || img.mark,
    item.at || img.at,
    img.blob,
  )
}

/** 某通道某天的缓存（服务端取不到时兜底展示，带上真实 `mark` 与时刻） */
export async function listCachedShots(channelId: string, day: string): Promise<ShotRecord[]> {
  const db = await openDb()
  if (!db) {
    return [...memShots.values()]
      .filter((r) => r.channelId === channelId && r.day === day)
      .sort((a, b) => b.at - a.at)
  }
  try {
    const tx = db.transaction(STORE_SHOT, 'readonly')
    const idx = tx.objectStore(STORE_SHOT).index('channel_day')
    const rows = await reqDone<ShotRecord[]>(idx.getAll([channelId, day]))
    return rows.sort((a, b) => b.at - a.at)
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

/**
 * 某通道缓存里最新的一张（按服务端抓拍时刻倒序）。
 *
 * 用途：接口整体不可用（断网 / 502）时，智眸那一格还能显示上次看过的那张真照片，
 * 而不是空一格。新设备 / 清过缓存时返回 `null` —— 宁可少一张，也不拿别的图顶替。
 */
export async function latestShot(channelId: string): Promise<ShotRecord | null> {
  if (!channelId) return null
  const db = await openDb()
  if (!db) {
    const rows = [...memShots.values()].filter((r) => r.channelId === channelId)
    return rows.sort((a, b) => b.at - a.at)[0] ?? null
  }
  try {
    const tx0 = db.transaction(STORE_META, 'readonly')
    const metas = await reqDone<ShotMeta[]>(
      tx0.objectStore(STORE_META).index('channel').getAll(channelId),
    )
    const mine = metas.slice().sort((a, b) => b.at - a.at)
    if (!mine.length) return null
    return await getShot(channelId, mine[0].mark)
  } catch {
    return null
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
