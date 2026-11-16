/**
 * 带进度的二进制拉取（2026-11-16）
 *
 * ## 为什么要它
 *
 * 航拍原图单张 5~8MB（实测 4 411 392 / 7 825 440 字节）。手机上点「原图」
 * 之后如果只是把 `img.src` 换成原图直链，用户会盯着同一张缩略图干等十几秒，
 * 完全不知道是在下载还是卡死了 —— 微信的做法是把进度显示出来。
 *
 * `fetch` + `ReadableStream` 能在下载过程中拿到已接收字节数（OSS 直链带
 * `Content-Length`，实测也有 `Accept-Ranges: bytes`），于是进度是真的，
 * 不是按体积估的假动画。
 *
 * ## 两个必须记住的点
 *
 * 1. **必须能跨域**：OSS / moss 两个域名都回 `Access-Control-Allow-Origin`
 *    （实测回显 Origin，2026-11-16），否则这里会抛 TypeError，调用方要能退回
 *    「直接塞给 `<img>`」那条路（浏览器加载图片不受 CORS 限制）。
 * 2. **不能只信 `content-length`**：gzip / 分块传输时它是空的或不准，
 *    拿不到就退化成 `null`，页面只显示不确定态进度条，别硬凑百分比。
 */

/** 进度回调：`total` 为 null 表示服务端没给长度（只报已收字节） */
export type ProgressFn = (loaded: number, total: number | null) => void

/** 读一个流，边读边报进度，最后拼成一个 Blob */
async function readStream(res: Response, onProgress?: ProgressFn): Promise<Blob> {
  const len = Number(res.headers.get('content-length'))
  const total = Number.isFinite(len) && len > 0 ? len : null

  const body = res.body
  // 没有流（老 WebView / 被 polyfill 掉）：一次性拿，进度只能给到 100%
  if (!body || typeof body.getReader !== 'function') {
    const blob = await res.blob()
    onProgress?.(blob.size, blob.size)
    return blob
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    loaded += value.byteLength
    onProgress?.(loaded, total)
  }
  // 空响应体一次回调都没有：补一发 0，让调用方有机会收掉进度条
  if (!chunks.length) onProgress?.(0, total)
  return new Blob(chunks as BlobPart[], {
    type: res.headers.get('content-type') ?? 'application/octet-stream',
  })
}

/**
 * 拉一个二进制资源并回报进度。失败向上抛（调用方决定降级方式）。
 *
 * `signal` 用于「用户还没下载完就关掉弹层 / 换了另一张照片」时中止，
 * 免得几 MB 的流量在后头白烧。
 */
export async function fetchBlobWithProgress(
  url: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(url, { signal, credentials: 'omit' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readStream(res, onProgress)
}
