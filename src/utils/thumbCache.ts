/**
 * 报警缩略图的本机缓存（2026-11-19）
 *
 * ## 为什么需要落盘
 *
 * 缩略图的唯一来源是 `GET /api/video/alarms/{id}/picture` —— 实测（2026-11-19）：
 *
 *   · 单张响应 **820KB ~ 1.3MB**（JSON 里的 base64，`Transfer-Encoding: chunked`）；
 *   · **没有 `Content-Encoding`**（服务端没开 gzip，base64 白带着 33% 膨胀）；
 *   · 也**没有 `Cache-Control` / `ETag` / `Last-Modified`** —— 浏览器无从缓存，
 *     每次进页面都是完整重下一遍；
 *   · 单张 2.7~3.4s，服务器偶发卡住（实测有请求 30s 不返回）。
 *
 * 也就是说：只要用户重开一次页面，那几个 MB 就得重走一遍移动网络。
 * 但缩略图本身缩完只有 **4~6KB**（见 `utils/imageThumb.ts`），把它存进
 * IndexedDB 之后，二次进入是 **毫秒级** 的，且完全不占网络。
 *
 * ## 存什么、留多久
 *
 *   · 只存**已经缩小的 data URL**（96px / JPEG 0.62，约 4~6KB），不存原图
     （原图 1MB × N 条会把配额吃光）；
 *   · 保留 {@link THUMB_KEEP_DAYS} 天、最多 {@link THUMB_MAX_ITEMS} 条，
 *     超出按 `at` 从旧到新淘汰（一条 5KB，400 条约 2MB，对配额无压力）；
 *   · 登出时由 `stores/alarm.ts::clearThumbs()` 整库清空 —— 现场照片不能留给
 *     下一个人，这一点与内存缓存同一条规则。
 *
 * ## 失败绝不阻塞页面
 *
 * 没有 IndexedDB（隐私模式 / 老 WebView / happy-dom 单测）时退化成进程内 Map：
 * 本次会话内仍能命中，刷新即丢。读写一律 `catch` 吞掉 —— 缓存是优化，
 * 不是前置条件，任何异常都不能让列表出不来图。
 */

const DB_NAME = 'xyc-alarm-thumb'
/**
 * v2：缩略图尺寸策略改成「性能优先」（144px/0.72 → 96px/0.62）。
 * 旧条目是不可逆的（本机只有缩小后的图），所以升版时整库重建 ——
 * 缓存丢了只是首屏多下一次，留着会让列表里新旧两种清晰度混排。
 */
const DB_VER = 2
const STORE = 'thumb'

/** 保留天数（超过的条目按 `at` 淘汰） */
export const THUMB_KEEP_DAYS = 7

/** 条目上限（一条 4~6KB） */
export const THUMB_MAX_ITEMS = 400

interface ThumbRow {
  /** 主键：报警 id（`va-<服务端id>`），同一条报警只留一份 */
  id: string
  /** 写入时刻（ms），淘汰与过期都按它算 */
  at: number
  /** 缩小后的 data URL */
  data: string
}

let dbPromise: Promise<IDBDatabase | null> | null = null

/** 无 IndexedDB 时的兜底（进程内） */
const mem = new Map<string, ThumbRow>()

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
      // 升版即重建：旧尺寸的缩略图没有保留价值（本机只有小图，无法重新缩）
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE)
      const os = db.createObjectStore(STORE, { keyPath: 'id' })
      os.createIndex('at', 'at')
    }
    // 隐私模式下 open 可能既不成功也不报错：给个超时，别把列表吊死
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

/**
 * 读一条缓存；没有 / 过期 / 环境不支持都返回空串。
 *
 * 过期条目顺手删掉，避免它们占着配额（读的时候最清楚它还在不在）。
 */
export async function readThumb(id: string): Promise<string> {
  if (!id) return ''
  const db = await openDb()
  if (!db) {
    const row = mem.get(id)
    if (!row) return ''
    if (expired(row)) {
      mem.delete(id)
      return ''
    }
    return row.data
  }
  try {
    const tx = db.transaction(STORE, 'readonly')
    const row = await reqDone<ThumbRow | undefined>(tx.objectStore(STORE).get(id))
    if (!row) return ''
    if (expired(row)) {
      void dropThumb(id)
      return ''
    }
    return row.data || ''
  } catch {
    return ''
  }
}

/** 写一条缓存（不等待、不抛错；写失败就当没缓存） */
export function writeThumb(id: string, data: string): void {
  if (!id || !data) return
  const row: ThumbRow = { id, at: Date.now(), data }
  void (async () => {
    const db = await openDb()
    if (!db) {
      mem.set(id, row)
      return
    }
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(row)
      await txDone(tx)
      void prune()
    } catch {
      /* 配额满 / 事务失败：忽略，页面已有内存里那张 */
    }
  })()
}

/** 删一条（过期清理用） */
async function dropThumb(id: string): Promise<void> {
  const db = await openDb()
  if (!db) {
    mem.delete(id)
    return
  }
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    await txDone(tx)
  } catch {
    /* 忽略 */
  }
}

/** 过期（超 {@link THUMB_KEEP_DAYS} 天） */
function expired(row: ThumbRow): boolean {
  return !row.at || Date.now() - row.at > THUMB_KEEP_DAYS * 86400_000
}

/**
 * 淘汰：超过 {@link THUMB_MAX_ITEMS} 条时从最旧的开始删。
 *
 * 只在写入后跑，且整批最多删 20 条 —— 一次写就触发一次全量删除会在列表
 * 快速滚动时反复开游标，反而拖慢。
 */
async function prune(): Promise<void> {
  const db = await openDb()
  if (!db) {
    if (mem.size <= THUMB_MAX_ITEMS) return
    const rows = [...mem.values()].sort((a, b) => a.at - b.at)
    for (const r of rows.slice(0, mem.size - THUMB_MAX_ITEMS)) mem.delete(r.id)
    return
  }
  try {
    const tx1 = db.transaction(STORE, 'readonly')
    const count = await reqDone<number>(tx1.objectStore(STORE).count())
    if (count <= THUMB_MAX_ITEMS) return

    const over = Math.min(20, count - THUMB_MAX_ITEMS)
    const tx = db.transaction(STORE, 'readwrite')
    const idx = tx.objectStore(STORE).index('at')
    let removed = 0
    await new Promise<void>((resolve) => {
      const cur = idx.openCursor()
      cur.onsuccess = () => {
        const c = cur.result
        if (!c || removed >= over) {
          resolve()
          return
        }
        c.delete()
        removed += 1
        c.continue()
      }
      cur.onerror = () => resolve()
    })
    await txDone(tx).catch(() => undefined)
  } catch {
    /* 忽略：缓存清不掉不影响功能，下次写入继续尝试 */
  }
}

/** 清空整个缓存（登出 / 换账号） */
export async function clearThumbCache(): Promise<void> {
  mem.clear()
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await txDone(tx)
  } catch {
    /* 忽略 */
  }
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
  })
}
