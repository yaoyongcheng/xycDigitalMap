import type { SceneType } from '@/api/scene'

/**
 * 场景截图的「本地兜底图」持久化（2026-11-18）
 *
 * ## 为什么需要它
 *
 * 接口每截一次图就覆盖服务端那一张，前端每次刷新拿到的可能是**新的取景**。
 * 而打包在 `public/img` 里的 `site-map.webp` / `site-flat.webp` 是构建产物，
 * 运行时**写不回去**（静态站，改不了自己的发布包）。所以「本地兜底图」只能
 * 存在浏览器侧：第一次取到接口图就落盘，以后每次刷新先拿它当画面基准，再和
 * 新取回的那张比 ——
 *
 *   · 一模一样 → 继续用兜底图，**不换 URL、不重写**，画面零跳变；
 *   · 不一样   → 立刻换新图，并把兜底图替换掉，下次刷新以它为新基准；
 *   · 接口挂了 → 用兜底图顶上（比打包图新，至少取景是对的）。
 *
 * ## 为什么是 IndexedDB，不是 localStorage
 *
 * 单张 3.2~3.8MB，localStorage 上限 5MB 且只能存字符串 —— base64 一膨胀
 * 就顶满配额，还会把主线程卡住。IndexedDB 能直接存 Blob（不复制、不编码），
 * 配额按磁盘剩余比例给，正好用来放这种大对象。
 *
 * ## 为什么指纹自己算，不用 `crypto.subtle.digest`
 *
 * `crypto.subtle` **只在安全上下文（HTTPS / localhost）存在**，而本项目日常
 * 要在局域网 `http://192.168.x.x:5173` 真机调（非安全上下文，`subtle` 是
 * `undefined`）；完整 SHA-256 还得把 3MB 字节全读一遍。这里改用**首/中/尾
 * 各 64KB 采样**的双通道 FNV-1a：只读 192KB，同步、无环境依赖，足以区分
 * 「同一次上传」与「重新截的一张」。
 *
 * 判等口径是**字节级**：内容完全一致才算「同一张」。现场重新截的图即使画面
 * 看起来一样，PNG 里也会带新的时间戳/差分编码，字节不同 → 走「换图」分支，
 * 这正是需求要的（宁可多换一次，也不能让画面停在旧取景上）。
 */

/** 库里每条记录就是这个形状（`key` 是 `SceneType`，不另存字段） */
export interface SceneCacheEntry {
  /** 图片字节（原样保存，不转码） */
  blob: Blob
  /** 采样指纹（见 `fingerprint`），用来判断「和上次那张是不是同一张」 */
  hash: string
  /** 落盘时间（ms），仅供排查/将来做过期策略 */
  savedAt: number
  /**
   * 这张图对应的服务端 `ETag`（2026-11-24 加）。
   *
   * 存它是为了让下次冷启动能带 `If-None-Match`：图没变时服务端回 304，
   * 3.3~3.8MB 一个字节都不用传，本地这张直接上屏。旧记录没有这个字段，
   * 读出来是空串 —— 那时按「没有校验器」处理，走一次普通 GET，不报错。
   */
  etag?: string
  /** `Last-Modified`（ETag 缺失时的退路） */
  lastModified?: string
}

const DB_NAME = 'xyc-scene'
const DB_VERSION = 1
const STORE = 'shots'

/**
 * 打开数据库的超时。
 *
 * Safari 隐私模式、配额耗尽、以及某些 WebView 里 `open()` 既不 success
 * 也不 error，会一直挂着 —— 底图加载不能被一个打不开的库卡死，超时后
 * 降级到内存（本会话内仍然按缓存逻辑跑，只是刷新后丢失）。
 */
const OPEN_TIMEOUT = 1500

/** 单次读/写事务的超时：同样不能被一个卡住的事务吊死整个底图加载 */
const TX_TIMEOUT = 1200

/**
 * 内存副本（也是 IDB 不可用时的降级后端）。
 *
 * 读一次就写进来：同一会话里第二次读不必再开事务；写入先落内存再落盘，
 * 落盘失败也不影响「本次刷新画面稳定」这件事。
 */
const mem = new Map<SceneType, SceneCacheEntry>()

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (!idb) {
      resolve(null)
      return
    }
    let done = false
    const fin = (db: IDBDatabase | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(db)
    }
    const timer = setTimeout(() => fin(null), OPEN_TIMEOUT)
    try {
      const req = idb.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => {
        // 已经按「打不开」处理过（超时）：把迟到的连接关掉，别让它一直挂着
        if (done) {
          req.result.close()
          return
        }
        fin(req.result)
      }
      req.onerror = () => fin(null)
      // 别的标签页还开着旧版本：不能一直等它关闭
      req.onblocked = () => fin(null)
    } catch {
      fin(null)
    }
  })
  return dbPromise
}

function requestAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * 给读写事务加一个上限。
 *
 * IndexedDB 的事务在「库被另一个标签页升级 / 磁盘满 / WebView 实现有 bug」时
 * 可能永远不 settle，而这两处都在底图加载的关键路径上（读在 fetch 之前），
 * 一旦挂住就是「图永远不出来」。超时后按「没有兜底图」处理即可 —— 下一次
 * 刷新再试，比卡死强。
 */
function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false
    const fin = (v: T): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => fin(fallback), ms)
    task.then(fin, () => fin(fallback))
  })
}

function normalize(raw: unknown): SceneCacheEntry | null {
  const e = raw as Partial<SceneCacheEntry> | null | undefined
  if (!e || !(e.blob instanceof Blob) || !e.blob.size) return null
  if (typeof e.hash !== 'string' || !e.hash) return null
  return {
    blob: e.blob,
    hash: e.hash,
    savedAt: Number(e.savedAt) || 0,
    // 旧记录没有这两个字段：空串 = 「没有校验器」，下次普通 GET
    etag: typeof e.etag === 'string' ? e.etag : '',
    lastModified: typeof e.lastModified === 'string' ? e.lastModified : '',
  }
}

/**
 * 读某个类型的兜底图。没有 / 读不出来都返回 `null`（调用方退回打包图）。
 *
 * 失败一律吞掉：底图这东西「没有」是可接受状态，不该让页面看到异常。
 */
export async function readSceneCache(type: SceneType): Promise<SceneCacheEntry | null> {
  const db = await openDb()
  if (!db) return mem.get(type) ?? null

  const entry = await withTimeout(
    (async (): Promise<SceneCacheEntry | null> => {
      const tx = db.transaction(STORE, 'readonly')
      return normalize(await requestAsPromise(tx.objectStore(STORE).get(type)))
    })(),
    TX_TIMEOUT,
    null,
  )
  if (entry) mem.set(type, entry)
  return entry ?? mem.get(type) ?? null
}

/**
 * 把某张图存成新的兜底图（覆盖同一 type 的旧记录，不会越攒越多）。
 *
 * `meta` 里的 ETag / Last-Modified 一起存 —— 下次冷启动带上去做条件请求，
 * 图没变就是一次 304，不用再下 3MB。
 *
 * 返回是否真的落盘成功；失败时内存副本仍然更新 —— 本次会话的「比较基准」
 * 已经是最新那张，只是下次刷新会退回上一次成功落盘的那张，画面不会坏。
 */
export async function writeSceneCache(
  type: SceneType,
  blob: Blob,
  hash: string,
  meta?: { etag?: string; lastModified?: string },
): Promise<boolean> {
  const entry: SceneCacheEntry = {
    blob,
    hash,
    savedAt: Date.now(),
    etag: meta?.etag ?? '',
    lastModified: meta?.lastModified ?? '',
  }
  mem.set(type, entry)

  const db = await openDb()
  if (!db) return false

  return withTimeout(
    (async (): Promise<boolean> => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(entry, type)
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
      return true
    })().catch(() => false),
    TX_TIMEOUT,
    false,
  )
}

/** 清掉兜底图（给排查/测试用；正常业务不会调 —— 换项目也仍可复用同一张底图） */
export async function clearSceneCache(type?: SceneType): Promise<void> {
  if (type) mem.delete(type)
  else mem.clear()

  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    if (type) store.delete(type)
    else store.clear()
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    /* 清不掉也不算错 */
  }
}

/** 采样窗口：首 / 中 / 尾各取 64KB（共 192KB，与 3.8MB 的全量比几乎不花时间） */
const SAMPLE = 64 * 1024

/**
 * 图片指纹：`体积-通道A-通道B`（36 进制，肉眼不可读，只用于判等）。
 *
 * 首/中/尾三段采样足以覆盖「不同截图」的差异（PNG 头里的尺寸、IDAT 中段、
 * IEND 前的内容都会变）。三段窗口在文件很小时会重叠，重叠不影响判等 ——
 * 同样的字节永远算出同样的值。
 */
export async function fingerprint(blob: Blob): Promise<string> {
  const size = blob.size
  if (!size) return 'empty'

  const parts: BlobPart[] = []
  const take = (start: number): void => {
    if (start < 0) return
    const end = Math.min(size, start + SAMPLE)
    if (end > start) parts.push(blob.slice(start, end))
  }
  take(0)
  take(Math.floor(size / 2 - SAMPLE / 2))
  take(size - SAMPLE)

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await new Blob(parts).arrayBuffer())
  } catch {
    // 极老环境 / 测试桩没有 arrayBuffer：退化成「只按体积判等」。
    // 体积相同但内容不同时会漏判成「同一张」，后果只是不换图 —— 不崩、不写坏
    return `s${size.toString(36)}`
  }

  // FNV-1a 32 + 一个混合累加器：两条独立通道，撞车概率远低于单条
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number
    a = Math.imul(a ^ byte, 0x01000193) >>> 0
    b = (b + byte) >>> 0
    b = Math.imul(b ^ (b >>> 13), 0x5bd1e995) >>> 0
  }
  return `${size.toString(36)}-${a.toString(36)}-${b.toString(36)}`
}
