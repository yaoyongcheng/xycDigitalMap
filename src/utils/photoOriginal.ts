/**
 * 详情大图的「原图字节」（2026-11-23 第二次调整）
 *
 * ## 现在的口径
 *
 * 详情页不再分「预览 → 点按钮看原图」两步：**打开就是原图**。画面先用列表里
 * 那张缩略图顶一帧（通常已在浏览器缓存里，零请求），原图字节带真实进度到手后
 * 无声换源。所以这里只做三件事：
 *
 *   1. 拉字节，边拉边报进度（`utils/blobFetch.ts`，进度是已收 / `Content-Length`）；
 *   2. 同一地址只下一次（`jobs`），两处弹层先后打开同一张照片共享同一次下载；
 *   3. 最近 {@link CACHE_MAX} 张留在内存里，关了再开不必重下。
 *
 * ## 为什么不在这里缩一版「清晰预览」
 *
 * 上一版（`photoPreview.ts`）会顺手缩一档长边 3840 的 WebP 当中间预览，但那必须
 * 先把原图字节整个下完才能缩 —— 等它出来原图也到了，等于多烧一次解码 + 编码。
 * 详情既然直接给原图，这一档就没有存在意义，整条删掉。
 *
 * ## 三条取数通道（2026-11-24 增加本机落盘）
 *
 *   ① 内存 LRU（{@link cache}，3 份）—— 同一会话里关了再开，零等待；
 *   ② 本机落盘（`utils/photoDetailCache.ts`）—— 刷过页面 / 重开应用仍然命中，
 *      **列表没刷新时再打开同一张，一个网络请求都不发**；体积 / 时刻与列表
 *      声明不符或超过保留期时，缓存自己作废，回落 ③；
 *   ③ 网络（`utils/blobFetch.ts`，带真实字节进度），下完写回 ①②。
 *
 * ## 几条硬规矩
 *
 * 1. **只在详情页触发**：只有 `PatrolSheet` / `AirPlayer` 打开某一张时才调这里；
 *    列表渲染与页面初次加载一个请求都不发。
 * 2. **能取消**：`signal` 一 abort 就掐掉在途请求（关弹层 / 换照片），
 *    几 MB 的流量不留在后台白烧。
 * 3. **失败向上抛**，调用方退回「直接把直链塞给 `<img>`」——慢，但图还是会出来。
 * 4. **只有传了 `scope` 才落盘**：作用域是「这批列表」的标识（`patrol` /
 *    `air|站点|日期`），列表刷新时按它做对账；不传就只走内存，抓拍那种
 *    `blob:` 地址本来也不需要落盘。
 */
import { fetchBlobWithProgress, type ProgressFn } from './blobFetch'
import { detailKeyOf, readDetail, writeDetail, type DetailMeta, type DetailRow } from './photoDetailCache'

/**
 * 本机内存里保留几份原图字节。
 *
 * 3 份 ≈ 12~24MB，够覆盖「同一张关了再开」与「两处弹层先后打开同一张」。
 * 更长期的保留在 `utils/photoDetailCache.ts`（IndexedDB，8 条 / 64MB，登出整库清），
 * 那一层才是刷过页面 / 重开应用之后仍然命中的地方 —— 内存这层只是省掉读盘。
 */
const CACHE_MAX = 3

export interface OriginalOptions {
  /** 关弹层 / 换照片时 abort，掐掉在途请求 */
  signal?: AbortSignal
  /** 真实字节进度（`total` 为 null 表示服务端没给长度） */
  onProgress?: ProgressFn
  /**
   * 详情缓存作用域。传了才落盘（见 `utils/photoDetailCache.ts`）；
   * 列表刷新时用同一个字符串做对账。
   */
  scope?: string
  /** 详情元信息：落盘、失效比对、跳过尺寸探测都靠它 */
  meta?: DetailMeta
  /** 命中本机缓存时回调（带宽高时调用方可跳过图片探测） */
  onLocal?: (row: DetailRow) => void
}

/* ---------- 缓存（按写入顺序淘汰最旧的） ---------- */

const cache = new Map<string, Blob>()

function remember(src: string, blob: Blob): void {
  cache.set(src, blob)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    cache.delete(oldest)
  }
}

/** 本机已经拿过的（换回来时不用再下一遍） */
export function cachedOriginal(src: string): Blob | null {
  return cache.get(src) ?? null
}

/** 清空（登出 / 单测回收） */
export function clearOriginalCache(): void {
  cache.clear()
}

/* ---------- 在途任务（同一地址只下一次） ---------- */

interface Job {
  ctrl: AbortController
  /** 订阅了进度的回调（多个调用方共享同一次下载） */
  subs: Set<ProgressFn>
  /** 还有几个调用方在等 */
  n: number
  promise: Promise<Blob>
}

const jobs = new Map<string, Job>()

/**
 * 拉一张详情原图。
 *
 * 命中内存缓存立刻返回（并补一发 100% 进度，调用方的进度条能收掉）；
 * 内存没有再查本机落盘（`utils/photoDetailCache.ts`），命中同样跳过网络；
 * 同一个地址已有在途任务时**加入等待**而不是再开一条 —— 两处弹层先后
 * 打开同一张照片，只花一次流量。
 */
export async function fetchDetailOriginal(
  src: string,
  opts: OriginalOptions = {},
): Promise<Blob> {
  if (!src) throw new Error('缺少图片地址')
  if (opts.signal?.aborted) throw new DOMException('已取消', 'AbortError')

  const hit = cache.get(src)
  if (hit) {
    opts.onProgress?.(hit.size, hit.size)
    return hit
  }

  // 本机落盘缓存：列表没刷新时这是常态，命中就完全不走网络
  const key = opts.scope ? detailKeyOf(src) : ''
  if (key && opts.scope) {
    const row = await readDetail(key, opts.meta)
    if (row) {
      remember(src, row.blob)
      opts.onProgress?.(row.bytes, row.bytes)
      opts.onLocal?.(row)
      return row.blob
    }
    // 读盘期间用户已经关掉弹层 / 换了照片：别再发请求
    if (opts.signal?.aborted) throw new DOMException('已取消', 'AbortError')
  }

  const fn = opts.onProgress
  let job = jobs.get(src)
  if (!job) {
    job = startJob(src, opts.scope, opts.meta)
    jobs.set(src, job)
  }

  if (fn) job.subs.add(fn)
  job.n += 1
  const current = job
  const onAbort = (): void => {
    // 关弹层 / 换照片：直接掐掉（同一次下载的其它等待方也会拿到 abort）。
    // 顺手把这条在途任务摘掉 —— 万一底层 fetch 不认 signal（老 WebView / 单测桩），
    // 它的 promise 永远不会落地，留在 `jobs` 里会让下一次打开同一张直接卡死。
    current.ctrl.abort()
    jobs.delete(src)
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    return await job.promise
  } finally {
    if (fn) current.subs.delete(fn)
    current.n -= 1
    // 已经没人等了（成功后的正常退出 / 唯一等待方取消）：让请求早点停
    if (current.n <= 0) current.ctrl.abort()
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

function startJob(src: string, scope?: string, meta?: DetailMeta): Job {
  const ctrl = new AbortController()
  const subs = new Set<ProgressFn>()
  const promise = (async (): Promise<Blob> => {
    const blob = await fetchBlobWithProgress(
      src,
      (loaded, total) => {
        for (const fn of subs) {
          try {
            fn(loaded, total)
          } catch {
            // 某个订阅方自己抛错，不能连累这次下载与其它订阅方
          }
        }
      },
      ctrl.signal,
    )
    // 取消后回来的一律不缓存（那一份没人要，存下来只是白占内存）
    if (!ctrl.signal.aborted) {
      remember(src, blob)
      // 落盘：下次刷新页面再打开同一张，直接本地读
      const key = scope ? detailKeyOf(src) : ''
      if (key && scope) void writeDetail({ key, scope, blob, meta })
    }
    return blob
  })().finally(() => {
    jobs.delete(src)
  })
  return { ctrl, subs, n: 0, promise }
}
