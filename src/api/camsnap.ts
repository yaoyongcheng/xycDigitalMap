import { MEDIA_KEY, MEDIA_ORIGIN, MEDIA_PID } from './config'
import { ApiError } from './http'

/**
 * 监控快照（万方媒体服务，2026-11-18 接入）
 *
 * 现场 20 路通道各有一张「最近一次成功更新」的截图，**直出图片字节**
 * （不是 JSON、不是 base64）。文档：桌面 `监控快照接口使用说明-向阳村.md`。
 *
 * | 用途 | 方法与地址 |
 * | --- | --- |
 * | 图片字节（**本页用这个**） | `GET {MEDIA_ORIGIN}/api/video/snapshots?pid=..&channelId=..` |
 * | 通道列表 | `GET {MEDIA_ORIGIN}/api/video/snapshots/channels?pid=..` |
 *
 * ## 三条必须记住的
 *
 * ① **鉴权是 `X-API-Key`，不是 Bearer**，与登录会话无关；密钥不能放 URL。
 * ② **不能直接塞 `<img src>`**（带不了请求头）→ `fetch` → `Blob` →
 *    `URL.createObjectURL`。这也是文档给的 Web 示例写法。
 * ③ **不是实时流**。服务端读的是上游已有快照，一天只更新几次（08:00/12:00/18:00，
 *    个别通道会更勤）。所以页面按「现场画面」展示，**不演直播**：没有播放按钮、
 *    不做轮询 —— 同一通道连续请求会拿到完全相同的字节。
 *
 * 关于限流：文档明确「多通道逐张请求，遇 429 按 `Retry-After` 重试，避免并发占带宽」。
 * 本页一次只显示一个点位，天然串行；这里仍对 429 做一次重试，避免现场网络抖动时
 * 直接把「正在取另一张图」报成失败。
 */

/** 单张快照的请求地址（`channelId` 是 20 位 GB28181 通道号） */
export function camSnapshotUrl(channelId: string): string {
  return `${MEDIA_ORIGIN}/api/video/snapshots?pid=${encodeURIComponent(MEDIA_PID)}&channelId=${encodeURIComponent(channelId)}`
}

/** HTTP 状态码 → 可直接给人看的说明（文档「错误说明」那张表） */
function snapErrText(status: number): string {
  switch (status) {
    case 400:
      return '通道参数无效'
    case 401:
      return '监控密钥无效'
    case 403:
      return '当前密钥没有该项目的监控权限'
    case 404:
      return '该通道没有可用画面'
    case 429:
      return '监控服务忙（取图排队），请稍后重试'
    case 502:
      return '上游视频服务异常，请稍后重试'
    default:
      return `监控画面获取失败（HTTP ${status}）`
  }
}

/** `Retry-After` 可能是秒数，也可能是 HTTP 日期；解析成毫秒，兜底 1s、上限 5s */
function retryAfterMs(header: string | null): number {
  const raw = (header ?? '').trim()
  if (!raw) return 1000
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.min(5000, Math.max(300, secs * 1000))
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.min(5000, Math.max(300, at - Date.now()))
  return 1000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 拉一个通道的当前画面。
 *
 * 返回已校验的图片 Blob（`image/*` 且非空），调用方负责建/撤 objectURL。
 * `signal` 用于「图还没回来用户已经切到别的点位」时放弃这次请求。
 */
export async function fetchCamSnapshot(
  channelId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!channelId) throw new ApiError(0, '缺少监控通道号')

  const attempt = async (): Promise<Response> => {
    try {
      return await fetch(camSnapshotUrl(channelId), {
        method: 'GET',
        headers: { 'X-API-Key': MEDIA_KEY, Accept: 'image/*' },
        // 带密钥 → 必须走 CORS；服务端对任意 Origin 回显 ACAO，不需要 credentials
        signal,
      })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e
      throw new ApiError(0, '监控服务访问失败（网络或跨域被拦）')
    }
  }

  let res = await attempt()
  if (res.status === 429) {
    // 只重试一次：再忙就让用户自己点「刷新」，别在这儿静默排队
    await sleep(retryAfterMs(res.headers.get('retry-after')))
    res = await attempt()
  }

  if (!res.ok) throw new ApiError(res.status, snapErrText(res.status))

  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!ct.startsWith('image/')) throw new ApiError(0, '监控服务没有返回图片')

  const blob = await res.blob()
  if (!blob.size) throw new ApiError(0, '监控画面为空文件')
  return blob
}
