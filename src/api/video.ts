import { SCENE_CODE, WF_BASE } from './config'
import { ApiError } from './http'

/**
 * 视频报警（A′ 组，工作流服务 :8085）
 *
 * 这是本项目**唯一有真实数据的报警源**。另一条看起来更正统的路径
 * `/open/bigScreen/bigAlarm/*` 对当前项目恒为空（`total` 恒 0、月度统计恒 `[]`），
 * 现场没启用大屏报警模块 —— 详见 docs/api-migration.md。
 *
 * 契约来自 Unity 端反编译（`AIAlarmListRequester`），三条要点：
 *   ① 基址是 8085 而不是 8081（`GetWFUrl(8085, …)`），鉴权与业务接口同一个 Bearer；
 *   ② 列表在 `data.list`（**不是** `data.rows`），行字段是 Pascal 命名；
 *   ③ 截图 `/api/video/alarms/{Id}/picture` 直接返回 **base64 字符串**，
 *      不是图片二进制的 Content-Type，所以要自己拼 data URL。
 *
 * 这一层刻意不复用 http.ts 的 request()：基址、响应包、字段命名都与 Go 业务接口
 * 不同，硬塞进去会把这个文件变成一堆 if。但它沿用同一个 ApiError，
 * 调用方处理错误的方式保持一致。
 */

/** 一条视频报警（已收敛字段） */
export interface VideoAlarm {
  /** 服务端主键，同时也是截图接口的 {id} */
  id: string
  /** 报警名称，如「未戴安全帽」 */
  alertName: string
  /** 报警类型码（服务端枚举，展示时按 alertName 即可） */
  alertType: number
  /** 抓拍时间，'YYYY-MM-DD HH:mm:ss' */
  captureTime: string
  /** 处理状态：0 待处理 / 1 已处理（服务端行为，取不到时按 0） */
  handleStatus: number
  /** 通道号（摄像头），用于「现场快照」定位是哪个点位 */
  channelNo: number
}

/** 列表结果 */
export interface VideoAlarmPage {
  rows: VideoAlarm[]
  total: number
}

/** 大小写不敏感地取一个字段（服务端 Pascal / camel 混用都见过） */
function pick(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n]
    const lower = n[0].toLowerCase() + n.slice(1)
    if (obj[lower] !== undefined && obj[lower] !== null) return obj[lower]
  }
  return undefined
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v)
}

/**
 * 从信封里把列表挖出来。
 *
 * 三种形状都实测/反编译见过：`data.list`、`data.rows`、`data` 直接是数组。
 * 缺 Id 或名称的行丢掉 —— 没有 Id 点不进详情、拉不到截图，留着只会变成死卡片。
 */
export function parseVideoAlarms(payload: unknown): VideoAlarmPage {
  const env = (payload ?? {}) as Record<string, unknown>
  const data = (env.data ?? env) as unknown

  let list: unknown = data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    list = d.list ?? d.rows ?? d.records ?? []
  }
  const arr = Array.isArray(list) ? list : []

  const rows: VideoAlarm[] = []
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = str(pick(r, 'Id', 'id', 'alarmId'))
    const alertName = str(pick(r, 'AlertName', 'alertName', 'name'))
    if (!id || !alertName) continue
    rows.push({
      id,
      alertName,
      alertType: num(pick(r, 'AlertType', 'alertType')),
      captureTime: str(pick(r, 'CaptureTime', 'captureTime', 'createTime')),
      handleStatus: num(pick(r, 'HandleStatus', 'handleStatus')),
      channelNo: num(pick(r, 'ChannelNo', 'channelNo')),
    })
  }

  const totalRaw = data && typeof data === 'object' && !Array.isArray(data)
    ? num((data as Record<string, unknown>).total, rows.length)
    : rows.length

  return { rows, total: totalRaw || rows.length }
}

/**
 * 发一个 GET 并把原始文本拿回来。
 *
 * 分两层是因为**同一个服务有两种响应**：列表是 JSON 信封，截图是 base64 纯文本。
 * 一开始两条都走 JSON 解析，结果截图接口每次都报「服务返回异常」——
 * 请求其实是成功的，只是解析错了。
 */
async function wfText(
  path: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; text: string }> {
  let res: Response
  try {
    res = await fetch(`${WF_BASE}${path}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new ApiError(0, '请求已取消')
    throw new ApiError(0, '视频报警服务不可达')
  }
  return { ok: res.ok, status: res.status, text: await res.text() }
}

/** 统一的 fetch 包装：网络错、非 JSON、业务码非成功都收敛成 ApiError */
async function wfGet(path: string, token: string, signal?: AbortSignal): Promise<unknown> {
  const { ok, status, text } = await wfText(path, token, signal)

  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new ApiError(status || 0, `视频报警服务返回异常（HTTP ${status}）`)
  }

  const code = num((body as Record<string, unknown>)?.code, ok ? 200 : status)
  // 该服务的成功码是 200（与 Go 业务接口的 200、大屏的 20000 都不同）
  if (code === 401) throw new ApiError(401, '登录已过期，请重新登录')
  if (!ok || code !== 200) {
    const msg = str((body as Record<string, unknown>)?.message) || `请求失败（HTTP ${status}）`
    throw new ApiError(code, msg)
  }
  return body
}

/**
 * 拉一页视频报警。
 *
 * 只读接口 —— 同组还有 DELETE /api/video/alarms/{id} 与 PATCH .../status，
 * 按项目约定（写接口一律接但不调用）不在客户端暴露。
 */
export async function fetchVideoAlarms(
  token: string,
  opts: { page?: number; pageSize?: number; sceneCode?: string; signal?: AbortSignal } = {},
): Promise<VideoAlarmPage> {
  const { page = 1, pageSize = 50, sceneCode = SCENE_CODE, signal } = opts
  const q = `?page=${page}&page_size=${pageSize}&sceneCode=${encodeURIComponent(sceneCode)}`
  return parseVideoAlarms(await wfGet(`/api/video/alarms${q}`, token, signal))
}

/**
 * 拉一条报警的抓拍图，返回可直接塞进 img.src 的 data URL。
 *
 * 服务端返回的是 base64 纯文本（不是 image/jpeg 响应），个别版本会带
 * `data:image` 前缀或 JSON 包一层，三种都兜住。
 */
export async function fetchAlarmPicture(
  token: string,
  id: string,
  signal?: AbortSignal,
): Promise<string> {
  const { ok, status, text } = await wfText(
    `/api/video/alarms/${encodeURIComponent(id)}/picture`,
    token,
    signal,
  )
  if (status === 401) throw new ApiError(401, '登录已过期，请重新登录')
  if (!ok) throw new ApiError(status, `抓拍图获取失败（HTTP ${status}）`)

  // 正常是裸 base64；个别部署会包一层 JSON 或带 data URL 前缀，一并兜住
  let raw = text.trim()
  if (raw.startsWith('{')) {
    try {
      const env = JSON.parse(raw) as Record<string, unknown>
      raw = str(env.data ?? env.picture ?? '')
    } catch {
      /* 不是 JSON，按原样当 base64 */
    }
  }
  const b64 = raw.replace(/^data:image\/\w+;base64,/, '').trim()
  if (!b64) throw new ApiError(0, '该报警没有抓拍图')
  return `data:image/jpeg;base64,${b64}`
}
