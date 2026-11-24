/**
 * 照片详情的本机缓存（2026-11-24）
 *
 * ## 为什么需要落盘
 *
 * 详情页现在是「打开即原图」（见 `utils/photoOriginal.ts`）：单张 4~8MB，
 * 全景贴图 13MB。之前只在本机内存里留 3 份，**刷一次页面就全没了** ——
 * 同一张照片再看一遍又要走一遍几 MB 的移动网络，而 OSS 预签名直链不保证
 * 浏览器缓存（签名参数每次都不一样，服务端也没回 `Cache-Control`）。
 *
 * 因此把「已经下过的详情字节 + 详情元信息」落到 IndexedDB：只要外层列表没变，
 * 再打开同一张就是本地读盘，一个网络请求都不发。
 *
 * ## 键怎么取（这是能跨刷新的关键）
 *
 * 键 = **URL 去掉签名参数后的部分**（`scheme://host/path`）。同一张照片重新拉列表
 * 会换一组 `X-Amz-Signature`，但对象路径不变，所以缓存还能命中；反过来，
 * 服务端换了图（路径变了）天然就是另一个键，不会串图。
 *
 * `blob:` / `data:` 之类的地址（抓拍档案生成的 objectURL）本身就是本地字节，
 * 这里直接跳过 —— 再存一份纯属浪费配额。
 *
 * ## 失效规则（对应需求里的「缓存命中 / 失效 / 更新」）
 *
 *   1. **过期**：写入超过 {@link DETAIL_KEEP_MS} 天不再使用（照片本身不会变，
 *      这条只是防止缓存无限期躺在本机）；
 *   2. **数据变更**：外层列表声明的体积 / 拍摄时刻与缓存里的不一致 → 删掉重下。
 *      视频监控的抓拍、航拍的媒体接口都会给 `size`，这是最便宜的对账方式；
 *   3. **列表刷新**：列表刷新后调 {@link reconcileDetailScope}，把这一批里
 *      **已经不存在**的照片整条删掉（换班次 / 换站点 / 换日期时旧图不该留着）；
 *   4. **登出 / 换账号**：{@link clearDetailCache} 整库清空 —— 现场照片不留给
 *      下一个人，与 `utils/thumbCache.ts` 同一条规矩。
 *
 * ## 容量与失败
 *
 * 只留最近 {@link DETAIL_MAX_ITEMS} 条、总量 {@link DETAIL_MAX_BYTES}（64MB），
 * 单条超过 {@link DETAIL_MAX_ITEM_BYTES}（24MB，装得下 13MB 的全景）不落盘。
 * 超出按**最近命中时间**淘汰（LRU），而不是写入时间 —— 反复看的那张应该留住。
 *
 * 没有 IndexedDB（隐私模式 / 老 WebView / happy-dom 单测）时退化成进程内 Map：
 * 本次会话内仍能命中，刷新即丢。所有读写都吞异常 —— 缓存是优化，不是前置条件。
 */

const DB_NAME = 'xyc-photo-detail'
/**
 * 版本号。
 *
 * v2（2026-11-24）：元信息多了 `group`（这张属于智眸的哪一格），按格对账要用。
 * `onupgradeneeded` 会把两个 store 删了重建 —— 缓存而已，重看一遍就补回来，
 * 不做数据迁移（省得写一堆只在升级那一刻跑一次的代码）。
 */
const DB_VER = 2
const STORE_ROW = 'detail'
const STORE_META = 'meta'

/** 保留天数（超过的按写入时刻淘汰） */
export const DETAIL_KEEP_MS = 7 * 86400000

/** 条目上限 */
export const DETAIL_MAX_ITEMS = 8

/** 总量上限（字节） */
export const DETAIL_MAX_BYTES = 64 * 1024 * 1024

/** 单条上限（字节）——13MB 的全景贴图要能装下 */
export const DETAIL_MAX_ITEM_BYTES = 24 * 1024 * 1024

/** 详情元信息：既能省一次尺寸探测，也是失效比对的依据 */
export interface DetailMeta {
  /** 业务 id（照片 id / `pano-<成果id>`），只用于排查 */
  id?: string
  /** 拍摄（或成果完成）时刻，与列表里的字段同源 */
  time?: string
  /** 外层列表声明的字节数 */
  size?: number
  /** 原图宽（探测到才有） */
  width?: number
  /** 原图高 */
  height?: number
  /**
   * 属于懒加载的哪一格（智眸的 `pano / pit / equip / face / layout / yard`）。
   *
   * 智眸一次只取当前选中的那一格，刷新后的对账也就只知道这一格有哪些照片；
   * 带上 group 才能「只清这一格已经没有的」，不误删还没打开过的格子
   * （见 `reconcileDetailScope` 的第三个参数）。
   */
  group?: string
}

/** 一条详情缓存 */
export interface DetailRow extends DetailMeta {
  /** 主键：URL 去掉签名参数 */
  key: string
  /** 所属外层列表（`patrol` / `air|站点|日期`） */
  scope: string
  /** 写入时刻（ms），过期按它算 */
  at: number
  /** 最近命中时刻（ms），淘汰按它算 */
  hitAt: number
  /** 字节数（与 `blob.size` 一致；`meta` 里也存一份，淘汰时不必读大对象） */
  bytes: number
  /** 原始字节 */
  blob: Blob
}

/** 不带字节的元信息行（枚举 / 淘汰用，避免把几十 MB 一起读出来） */
type DetailMetaRow = Omit<DetailRow, 'blob'>

/** 对账用：外层列表里的一个条目 */
export interface DetailItem {
  key: string
  size?: number
  time?: string
}

/**
 * 地址 → 缓存键。
 *
 * 只留 `scheme://host/path`，去掉 `?签名` 与 `#hash`。非 http(s) 地址
 * （`blob:` / `data:` / 相对路径）一律返回空串，表示**不进本机缓存**。
 */
export function detailKeyOf(url: string): string {
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) return ''
  return url.split('#')[0].split('?')[0]
}

/* ------------------------------------------------------------------ *
 * 存储：IndexedDB 优先，不支持时退内存
 * ------------------------------------------------------------------ */

let dbPromise: Promise<IDBDatabase | null> | null = null

/** 无 IndexedDB 时的兜底（进程内有效） */
const memRows = new Map<string, DetailRow>()

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
      // 缓存而已：结构变了就整库重建，重看一遍就能补回来
      for (const name of [STORE_ROW, STORE_META]) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
      }
      db.createObjectStore(STORE_ROW, { keyPath: 'key' })
      const meta = db.createObjectStore(STORE_META, { keyPath: 'key' })
      meta.createIndex('scope', 'scope')
    }
    // 隐私模式下 open 可能既不成功也不报错：给个超时，别把详情页吊死
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

function toMetaRow(row: DetailRow): DetailMetaRow {
  const { blob: _blob, ...rest } = row
  return rest
}

async function getRow(key: string): Promise<DetailRow | null> {
  if (!key) return null
  const db = await openDb()
  if (!db) return memRows.get(key) ?? null
  try {
    const tx = db.transaction(STORE_ROW, 'readonly')
    const row = await reqDone<DetailRow | undefined>(tx.objectStore(STORE_ROW).get(key))
    return row ?? null
  } catch {
    return null
  }
}

async function getMetaRow(key: string): Promise<DetailMetaRow | null> {
  if (!key) return null
  const db = await openDb()
  if (!db) {
    const row = memRows.get(key)
    return row ? toMetaRow(row) : null
  }
  try {
    const tx = db.transaction(STORE_META, 'readonly')
    const row = await reqDone<DetailMetaRow | undefined>(tx.objectStore(STORE_META).get(key))
    return row ?? null
  } catch {
    return null
  }
}

async function putRow(row: DetailRow): Promise<void> {
  const db = await openDb()
  if (!db) {
    memRows.set(row.key, row)
    return
  }
  const tx = db.transaction([STORE_ROW, STORE_META], 'readwrite')
  tx.objectStore(STORE_ROW).put(row)
  tx.objectStore(STORE_META).put(toMetaRow(row))
  await txDone(tx)
}

/** 只改元信息（命中续期 / 补宽高）：不动字节，所以不会重写几 MB */
async function putMetaOnly(row: DetailMetaRow): Promise<void> {
  const db = await openDb()
  if (!db) {
    const cur = memRows.get(row.key)
    if (cur) memRows.set(row.key, { ...cur, ...row, blob: cur.blob })
    return
  }
  const tx = db.transaction(STORE_META, 'readwrite')
  tx.objectStore(STORE_META).put(row)
  await txDone(tx)
}

async function dropKeys(keys: string[]): Promise<void> {
  if (!keys.length) return
  const db = await openDb()
  if (!db) {
    for (const k of keys) memRows.delete(k)
    return
  }
  try {
    const tx = db.transaction([STORE_ROW, STORE_META], 'readwrite')
    for (const k of keys) {
      tx.objectStore(STORE_ROW).delete(k)
      tx.objectStore(STORE_META).delete(k)
    }
    await txDone(tx)
  } catch {
    /* 删不掉就下次再说：缓存多留一条不影响正确性 */
  }
}

async function listMeta(scope?: string): Promise<DetailMetaRow[]> {
  const db = await openDb()
  if (!db) {
    const all = [...memRows.values()]
    return all.filter((r) => !scope || r.scope === scope).map(toMetaRow)
  }
  try {
    const tx = db.transaction(STORE_META, 'readonly')
    const store = tx.objectStore(STORE_META)
    return scope
      ? await reqDone<DetailMetaRow[]>(store.index('scope').getAll(scope))
      : await reqDone<DetailMetaRow[]>(store.getAll())
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * 对外：读 / 写 / 对账 / 清空
 * ------------------------------------------------------------------ */

/** 命中后续期（节流：一分钟内不重复写） */
function touch(row: DetailRow): void {
  const now = Date.now()
  if (now - row.hitAt < 60_000) return
  void putMetaOnly({ ...toMetaRow(row), hitAt: now }).catch(() => undefined)
}

function expired(row: DetailRow, now = Date.now()): boolean {
  return now - row.at > DETAIL_KEEP_MS
}

/**
 * 读一条缓存（命中即续期）。
 *
 * `expect` 传进来时按外层列表的最新声明对账：体积或拍摄时刻对不上，说明
 * 服务端换了图（或列表换了一班），**当场删掉并返回 null**，让调用方去重新下载 ——
 * 宁可多下一次，也不拿旧像素冒充新照片。
 */
export async function readDetail(key: string, expect?: DetailMeta): Promise<DetailRow | null> {
  const row = await getRow(key)
  if (!row || !row.blob) return null

  if (expired(row)) {
    void dropKeys([key])
    return null
  }
  if (expect?.size && row.bytes !== expect.size) {
    void dropKeys([key])
    return null
  }
  if (expect?.time && row.time && expect.time !== row.time) {
    void dropKeys([key])
    return null
  }

  touch(row)
  return row
}

/** 写一条（超过单条上限、缺键或缺作用域都直接跳过） */
export async function writeDetail(input: {
  key: string
  scope: string
  blob: Blob
  meta?: DetailMeta
}): Promise<void> {
  const { key, scope, blob, meta } = input
  if (!key || !scope || !blob) return
  if (!blob.size || blob.size > DETAIL_MAX_ITEM_BYTES) return

  const now = Date.now()
  const row: DetailRow = {
    key,
    scope,
    at: now,
    hitAt: now,
    bytes: blob.size,
    id: meta?.id,
    time: meta?.time,
    size: meta?.size ?? blob.size,
    width: meta?.width,
    height: meta?.height,
    group: meta?.group,
    blob,
  }
  try {
    await putRow(row)
    await pruneDetail()
  } catch {
    /* 配额满了 / 写失败：不影响这次展示 */
  }
}

/**
 * 补一条已存在缓存的元信息（比如原图解码后才拿到的宽高）。
 *
 * 找不到对应行就什么都不做 —— 这张没进缓存（blob URL / 超上限）时很正常。
 */
export async function patchDetailMeta(src: string, meta: DetailMeta): Promise<void> {
  const key = detailKeyOf(src)
  if (!key) return
  const row = await getMetaRow(key)
  if (!row) return
  const next: DetailMetaRow = {
    ...row,
    time: meta.time ?? row.time,
    size: meta.size ?? row.size,
    width: meta.width ?? row.width,
    height: meta.height ?? row.height,
  }
  try {
    await putMetaOnly(next)
  } catch {
    /* 忽略 */
  }
}

/**
 * 与某一批列表对账（列表刷新 / 换站点 / 换日期后调用）。
 *
 *   · 列表里已经没有的键 → 删；
 *   · 体积或时刻与列表声明不一致 → 删（下次打开会重新下）。
 *
 * 只动 `scope` 这一个作用域的条目 —— 别的站点 / 别的班次的缓存不受影响。
 *
 * `group` 可选：传了就只对账**这一格**。智眸的六个子页是懒加载的，一次刷新
 * 只知道自己这一格有哪些照片，不带 group 地整作用域对账会把还没打开过的
 * 子页的缓存全删掉；航拍那边（`air|站点|日期`）一次就把整批取齐，不需要它。
 */
export async function reconcileDetailScope(
  scope: string,
  items: DetailItem[],
  group?: string,
): Promise<void> {
  if (!scope) return
  const valid = new Map<string, DetailItem>()
  for (const it of items) {
    if (it.key) valid.set(it.key, it)
  }
  const all = await listMeta(scope)
  const rows = group ? all.filter((r) => r.group === group) : all
  const dead: string[] = []
  for (const r of rows) {
    const it = valid.get(r.key)
    if (!it) {
      dead.push(r.key)
      continue
    }
    if (it.size && r.bytes !== it.size) {
      dead.push(r.key)
      continue
    }
    if (it.time && r.time && it.time !== r.time) dead.push(r.key)
  }
  await dropKeys(dead)
}

/** 过期 + 超量淘汰（先按天数，再按最近命中时间 LRU） */
export async function pruneDetail(now = Date.now()): Promise<void> {
  const rows = await listMeta()
  const dead: string[] = []
  const alive: DetailMetaRow[] = []
  for (const r of rows) {
    if (now - r.at > DETAIL_KEEP_MS) dead.push(r.key)
    else alive.push(r)
  }
  alive.sort((a, b) => a.hitAt - b.hitAt)
  let total = alive.reduce((s, r) => s + r.bytes, 0)
  let count = alive.length
  for (const r of alive) {
    if (total <= DETAIL_MAX_BYTES && count <= DETAIL_MAX_ITEMS) break
    total -= r.bytes
    count -= 1
    dead.push(r.key)
  }
  await dropKeys(dead)
}

/** 整库清空（登出 / 换账号） */
export async function clearDetailCache(): Promise<void> {
  memRows.clear()
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction([STORE_ROW, STORE_META], 'readwrite')
    tx.objectStore(STORE_ROW).clear()
    tx.objectStore(STORE_META).clear()
    await txDone(tx)
  } catch {
    /* 忽略 */
  }
}

/** 当前缓存了几条（诊断 / 单测用，不读字节） */
export async function detailCacheCount(): Promise<number> {
  return (await listMeta()).length
}
