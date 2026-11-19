import { CDN_ORIGIN } from './config'

/**
 * 现场监控地址清单（V2 `monitorData.json`）—— 取数
 *
 * ## 数据源是 CDN 上的静态 JSON，不是 REST 接口
 *
 * V2 里没有任何「取流地址」的接口，只有一份定时重写的静态文件：
 *
 * ```
 * CdnHelper.GetHostServerIP()        // 读 StreamingAssets/CdnConfig.txt
 *   = "http://120.26.34.95:9689"
 * CdnHelper.GetHostServerURL(fn)     // = 上面 + "/CDN/PC/" + fn
 *   → http://120.26.34.95:9689/CDN/PC/monitorData.json
 * ```
 *
 * 文件结构（20 条，字段名照抄 V2，不要改名）：
 *
 * ```json
 * [{ "type": "Null", "monitorName": "地磅全景",
 *    "videoPath": ["rtsp://120.26.34.95:554/rtp/42010500441188000001_34020000001310000003?originTypeStr=rtp_push"] }]
 * ```
 *
 * ## 线上优先 + 内置快照兜底
 *
 * 与 `api/scaffold.ts` 同一套做法（同一台 CDN、同样没有 CORS 头、线上站点还是
 * HTTPS —— 直连 HTTP 会被混合内容拦掉）：
 *
 *   1. 先拉 CDN（6s 超时），成功 → `source = 'live'`；
 *   2. 失败 → 用 `public/data/cctv.json`（2026-11-18 从 CDN 取回的真实副本）；
 *   3. 都失败 → `null`，页面按「没有流地址」处理。
 *
 * ## 约定
 *
 * 与项目其它接口层一致：**永不抛错**，失败收敛成 `null`；解析不认识的结构也当没取到。
 */

/** CDN 清单地址（V2 `LoadMonitorListFromCdnAsync` 里 `monitorData.json` + GetHostServerURL） */
export const CCTV_MANIFEST_URL = `${CDN_ORIGIN}/CDN/PC/monitorData.json`

/** 内置快照（随站点发布，免登录，格式与 CDN 一致） */
export const CCTV_MANIFEST_SNAPSHOT_URL = `${import.meta.env.BASE_URL}data/cctv.json`

/** 线上 CDN 是公网 HTTP：拿不到就尽快退快照，别让画面一直转 */
const LIVE_TIMEOUT = 6_000

const SNAPSHOT_TIMEOUT = 8_000

/** 一条监控点位（字段名与 V2 完全一致） */
export interface MonitorEntry {
  /** V2 的播放类型标记，当前 20 条全是 "Null"（由 CheckUrlMode 决定实际播法） */
  type: string
  /** V2 的显示名（带空格，如「2#门监控 1」） */
  monitorName: string
  /** 候选地址，按优先级排列 */
  videoPath: string[]
}

/** 清单 + 来源（来源只做内部诊断，不呈现） */
export interface MonitorList {
  list: MonitorEntry[]
  source: 'live' | 'snapshot'
}

/** 把 CDN 返回的未知结构收敛成 MonitorEntry[]；不是数组或全无有效项 → null */
export function parseMonitorList(body: unknown): MonitorEntry[] | null {
  if (!Array.isArray(body)) return null
  const out: MonitorEntry[] = []
  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const name = typeof o.monitorName === 'string' ? o.monitorName : ''
    const paths = Array.isArray(o.videoPath)
      ? o.videoPath.filter((u): u is string => typeof u === 'string' && u.trim() !== '')
      : []
    if (!name || paths.length === 0) continue
    out.push({
      type: typeof o.type === 'string' ? o.type : '',
      monitorName: name,
      videoPath: paths,
    })
  }
  return out.length > 0 ? out : null
}

/**
 * 从地址里取出 channelId。
 *
 * 地址形如 `…/rtp/42010500441188000001_34020000001310000003?originTypeStr=rtp_push`，
 * 流 ID 是「设备编号_通道编号」，取最后一个下划线之后的那段。
 *
 * 用地址而不是名字来对点位：上游有重名通道（两个「2#门监控」、两个「场内」），
 * 名字对不上就会张冠李戴。
 */
export function channelIdOfEntry(entry: MonitorEntry): string {
  for (const u of entry.videoPath) {
    const seg = u.split('/rtp/')[1]
    if (!seg) continue
    const id = seg.split('?')[0].split('_').pop()
    if (id && /^\d{20}$/.test(id)) return id
  }
  return ''
}

/**
 * 一条清单里挑一个地址。
 *
 * 与 V2 `UIPopCCTV.CheckUrlMode` 的口径一致：含 `flv` 的当 FLV 播，其余当 RTSP。
 * 这里额外把 m3u8 排在 RTSP 前面 —— 清单将来若同时给 RTSP 与 HLS，手机优先能播的那个。
 */
export function pickStreamUrl(entry: MonitorEntry): string {
  const flv = entry.videoPath.find((u) => /flv/i.test(u))
  if (flv) return flv
  const hls = entry.videoPath.find((u) => /\.m3u8/i.test(u))
  if (hls) return hls
  return entry.videoPath[0] ?? ''
}

/** 按 channelId 找清单条目（找不到返回 undefined） */
export function findMonitorEntry(list: MonitorEntry[], channelId: string): MonitorEntry | undefined {
  if (!channelId) return undefined
  return list.find((e) => channelIdOfEntry(e) === channelId)
}

/** 拉一个 URL 并解析；失败返回 null（永不抛） */
async function readList(url: string, timeout: number): Promise<MonitorEntry[] | null> {
  const ctrl = new AbortController()
  const timer = typeof window !== 'undefined' ? window.setTimeout(() => ctrl.abort(), timeout) : null
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-cache', signal: ctrl.signal })
    if (!res.ok) return null
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      return null
    }
    return parseMonitorList(body)
  } catch {
    // 超时 / 断网 / 混合内容被拦 —— 都算没拿到
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 取监控清单：线上优先，失败退内置快照，都失败返回 null */
export async function loadMonitorList(): Promise<MonitorList | null> {
  const live = await readList(CCTV_MANIFEST_URL, LIVE_TIMEOUT)
  if (live) return { list: live, source: 'live' }
  const snap = await readList(CCTV_MANIFEST_SNAPSHOT_URL, SNAPSHOT_TIMEOUT)
  if (snap) return { list: snap, source: 'snapshot' }
  return null
}
