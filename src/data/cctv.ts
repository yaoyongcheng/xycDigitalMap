import {
  CCTV_DEVICE_ID,
  CCTV_FLV_ORIGIN,
  CCTV_FLV_TEMPLATE,
  CCTV_HLS_TEMPLATE,
  CCTV_RTSP_ORIGIN,
} from '@/api/config'

/**
 * 现场监控流媒体地址（2026-11-18，逐项对齐 V2）
 *
 * ## V2 是怎么拿到地址的（反编译 + 线上文件核对）
 *
 * ```
 * StreamingAssets/CdnConfig.txt                     → http://120.26.34.95:9689
 * CdnHelper.GetHostServerURL(fn) = CDN 根 + "/CDN/PC/" + fn
 * MonitorRequester.<LoadMonitorListFromCdnAsync>    → GET /CDN/PC/monitorData.json
 * monitorData.json: [{ "type": "Null", "monitorName": "地磅全景",
 *                      "videoPath": ["rtsp://120.26.34.95:554/rtp/…"] }, …]  // 20 条
 * UIPopCCTV.CheckUrlMode(url): url.Contains("flv") ? PlayFlv(url) : PlayRTSP(url)
 * ```
 *
 * 也就是说 V2 只有两种播法：FLV 或 RTSP，判定条件就是地址里有没有 `flv`。
 * 本文件把这条判定照搬为 `streamModeOf()`，并把地址拼法照搬为 `cctvRtspUrl()`。
 *
 * ## 为什么不能直接把 RTSP 塞给 `<video>`
 *
 * RTSP 不是浏览器能解的东西（桌面 Unity 才支持，必要时还用 `HttpFlv2RtspUtil`
 * 起本地 ffmpeg + mediamtx 转成 `rtsp://localhost:8554/live`）。**移动端浏览器
 * 一律播不了 RTSP**。
 *
 * ## 现在的实际播法（2026-11-18 现场给了 HTTP-FLV 出口）
 *
 * 同一台 ZLMediaKit 开了两个协议端口：`:554` 给桌面客户端（RTSP），
 * `:9092` 给浏览器（HTTP-FLV）。所以：
 *
 * ```
 * http://120.26.34.95:9092/rtp/42010500441188000001_{channelId}.live.flv?originTypeStr=rtp_push
 * ```
 *
 * 这条地址与现场给的模板逐字同构，只换 channelId —— 见 `cctvFlvUrl()`。
 * 它带 CORS 回显（`Access-Control-Allow-Origin`），浏览器可以直连，不需要反代。
 * FLV 由 mpegts.js 解成 fMP4 喂 MSE，Android Chrome / iOS 17+ 都能出画面。
 *
 * RTSP 那条保留不删：万一某个通道 FLV 起不来，页面会把 RTSP 地址原样交出去，
 * 由运维用客户端打开，而不是留一块黑屏。
 */

/**
 * 现场 20 个通道的完整名单（2026-11-18 由现场核对表逐条抄入）。
 *
 * 顺序、名字、编号都照抄，不做「整理」：现场和上游是拿这套编号对话的，
 * 一旦我们自作聪明改名或调序，排查时两边对不上号。
 *
 * `flv` 是**当天实测结论**（`curl -r 0-300` 看 9092 是否回 `FLV` 魔数）：
 *   · `true`  = 当场有流；
 *   · `false` = 当场 404，多为「该通道此刻没推流」—— 国标按需推流的场景下
 *     首次 404、退避重试后才有画面是正常的，所以播放器的重连必须留着，
 *     不能把 404 当「永久不可用」。
 *
 * 页面并不直接遍历这张表（上墙的仍是 `cams.ts` 那 8 个白名单点位），
 * 但它有两个用途：① 放开点位时不用再翻文档；② 单测按它校验地址拼法。
 */
export interface CctvChannel {
  channelId: string
  name: string
  /** 2026-11-18 实测该通道在 9092 上是否有 FLV 流 */
  flv: boolean
}

export const CCTV_CHANNELS: CctvChannel[] = [
  { channelId: '34020000001310000001', name: '监控A', flv: true },
  { channelId: '34020000001310000002', name: '监控B', flv: true },
  { channelId: '34020000001310000003', name: '地磅全景', flv: true },
  { channelId: '34020000001320000001', name: '4#门安全通道门禁监控', flv: true },
  { channelId: '34020000001320000002', name: '场内', flv: true },
  { channelId: '34020000001320000003', name: '2#门监控', flv: true },
  { channelId: '34020000001320000004', name: '4#门外监控', flv: false },
  { channelId: '34020000001320000005', name: '材料堆场', flv: true },
  { channelId: '34020000001320000006', name: '2#门监控', flv: true },
  { channelId: '34020000001320000007', name: '4#门监控', flv: false },
  { channelId: '34020000001320000008', name: '3#门外监控', flv: false },
  { channelId: '34020000001320000009', name: '场内', flv: false },
  { channelId: '34020000001320000010', name: '1#门安全通道门禁监控', flv: false },
  { channelId: '34020000001320000011', name: '1#门监控', flv: false },
  { channelId: '34020000001320000012', name: '5#门监控', flv: false },
  { channelId: '34020000001320000013', name: '5#门外监控', flv: false },
  { channelId: '34020000001320000014', name: '钢筋加工棚', flv: false },
  { channelId: '34020000001320000015', name: '安全讲台', flv: false },
  { channelId: '34020000001320000016', name: '4#塔吊', flv: true },
  { channelId: '34020000001320000017', name: '2#塔吊', flv: false },
]

/**
 * channelId → 点位名（由 `CCTV_CHANNELS` 派生，只有一份数据源）。
 *
 * 用来在「清单没取到、只有通道号」时给个可读名字。注意上游本来就重名
 * （两个「2#门监控」、两个「场内」），所以**匹配一律以 channelId 为准**，
 * 名字只做展示，绝不拿来当 key。
 */
export const CCTV_V2_NAME: Record<string, string> = Object.fromEntries(
  CCTV_CHANNELS.map((c) => [c.channelId, c.name]),
)

/** ZLMediaKit 的流 ID：`{国标设备编号}_{通道编号}`（见 monitorData.json 的地址段） */
export function cctvStreamId(channelId: string): string {
  return `${CCTV_DEVICE_ID}_${channelId}`
}

/**
 * 某个通道的 **HTTP-FLV** 地址（浏览器/手机可播的那一路）。
 *
 * 与现场给的模板逐字同构，只换 channelId：
 * ```
 * http://120.26.34.95:9092/rtp/42010500441188000001_{channelId}.live.flv?originTypeStr=rtp_push
 * ```
 * 域名、端口、`/rtp/` 前缀、`.live.flv` 后缀、`originTypeStr=rtp_push` 一个都不能动：
 * 少了 `originTypeStr` 会被 ZLM 当成回放请求。
 */
export function cctvFlvUrl(channelId: string): string {
  if (!channelId) return ''
  return `${CCTV_FLV_ORIGIN}/rtp/${cctvStreamId(channelId)}.live.flv?originTypeStr=rtp_push`
}

/**
 * 某个通道的 RTSP 地址（与 V2 清单逐字同构）。
 *
 * 只作为「浏览器播不了时的兜底交付物」：手机播不了它，但运维/桌面客户端能用。
 * `originTypeStr=rtp_push` 是 ZLMediaKit 标识「国标推流」的参数，同样不能省。
 */
export function cctvRtspUrl(channelId: string): string {
  if (!channelId) return ''
  return `${CCTV_RTSP_ORIGIN}/rtp/${cctvStreamId(channelId)}?originTypeStr=rtp_push`
}

/** 地址类型：V2 只分 flv / rtsp，这里多认一个 hls（手机原生能播）用于将来接网关 */
export type StreamMode = 'flv' | 'hls' | 'rtsp' | 'other' | 'none'

/** 与 V2 `CheckUrlMode` 同一条判定：地址里含 `flv` 就是 FLV，其余按 RTSP 处理 */
export function streamModeOf(url: string): StreamMode {
  const u = (url || '').toLowerCase()
  if (!u) return 'none'
  if (u.includes('flv')) return 'flv'
  if (u.startsWith('rtsp://')) return 'rtsp'
  if (u.includes('.m3u8')) return 'hls'
  if (u.startsWith('http://') || u.startsWith('https://')) return 'other'
  return 'other'
}

/** 把模板里的占位符换成实际地址 */
function fillTemplate(tpl: string, channelId: string): string {
  if (!tpl) return ''
  return tpl
    .replaceAll('{channelId}', encodeURIComponent(channelId))
    .replaceAll('{streamId}', cctvStreamId(channelId))
}

/**
 * 该通道最终喂给播放器的地址。
 *
 * 优先级（从上到下，命中即用）：
 *   1. `VITE_CCTV_FLV_TEMPLATE` —— 网关换了路径约定时的整体覆盖；
 *   2. `VITE_CCTV_HLS_TEMPLATE` —— 明确要走 HLS 时；
 *   3. **默认**：`cctvFlvUrl()` 按 `CCTV_FLV_ORIGIN` 逐通道拼的 HTTP-FLV。
 *
 * 第 3 条是 2026-11-18 新增的：现场已给到可用的 ZLM HTTP-FLV 出口（`:9092`），
 * 所以不再需要「先留空、等运维开端口」——八个点位开箱即有一路浏览器可播地址。
 */
export function cctvPlayableUrl(channelId: string): string {
  if (!channelId) return ''
  return (
    fillTemplate(CCTV_FLV_TEMPLATE, channelId) ||
    fillTemplate(CCTV_HLS_TEMPLATE, channelId) ||
    cctvFlvUrl(channelId)
  )
}
