import { MEDIA_KEY, MEDIA_ORIGIN, MEDIA_PID } from './config'
import { ApiError } from './http'

/**
 * 监控快照（万方媒体服务）
 *
 * 依据桌面《监控快照接口.docx》（2026-11-20 简版）+ 当日实测，三个 GET：
 *
 * | 用途 | 地址 |
 * | --- | --- |
 * | 历史列表 | `{MEDIA_ORIGIN}/api/video/snapshots/history?pid&channelId&page&pageSize[&date]` |
 * | 历史图片 | 列表每行的 `imageUrl`（拼 `MEDIA_ORIGIN`，**不要自己拼 mark**） |
 * | 通道列表 | `{MEDIA_ORIGIN}/api/video/snapshots/channels?pid` |
 *
 * **不再有「最新一帧」**（原 `…/snapshots?pid&channelId`，不带 `mark`）：那一版
 * 2026-11-20 晚已随历史接口上线一并移除 —— 要最新一张就查历史列表第 1 页第 1 条。
 * 带 `mark` 的图片地址仍是同一个 path，那是文档指定的取图方式，保留。
 *
 * ## 文档钉死的口径
 *
 * ① 鉴权是请求头 `X-API-Key`，**不是** Bearer，也不放进 URL —— 所以图片不能直接塞
 *    `<img src>`，必须 `fetch` → Blob → objectURL。
 * ② 历史列表 `data.items` 是当前页、`data.total` 是总数；`date=YYYY-MM-DD` 按天查，
 *    只支持北京时间近 30 个自然日（越界 400，服务端会把可用区间写在
 *    `rangeStart/rangeEnd` 里）；`page` 从 1 起、`pageSize` 最大 100（越界 400）。
 * ③ 每行给的是 `{ mark, capturedAt, timestamp, fileSize, imageUrl, latest }` ——
 *    抓拍时刻以服务端为准，**不要**用本机时间猜「属于哪一档」。
 * ④ 图片：文档要求用行的 `imageUrl` 再拼测试环境入口、带同一个密钥头；图片响应还带
 *    `X-Snapshot-Mark` / `X-Snapshot-Time`（CORS 已 Expose），行里字段缺失时正好用它
 *    补上真实抓拍时刻。
 * ⑤ 错误码：400 参数 / 401 密钥 / 403 项目无权限 / 404 无记录或无图 / 429 繁忙
 *    （按 `Retry-After` 重试）/ 502·503 上游或索引异常。
 *
 * ## 这一层不做的事
 *
 * 不缓存、不落盘、不管并发。列表按天查 + 图片逐张取，串行/并发由调用方
 * （`stores/cam.ts`、`stores/patrol.ts` 都走 `utils/shotArchive.ts`）决定。
 */

/** 历史列表单页上限（文档：pageSize 最大 100） */
export const SHOT_PAGE_SIZE = 100

/** 服务端每日更新档（北京时间 08:00 / 12:00 / 18:00，见文档「更新与测试结果」） */
export const SNAP_UPDATE_HOURS = [8, 12, 18] as const

/** 可查天数（文档：北京时间近 30 个自然日，含今天） */
export const SHOT_RANGE_DAYS = 30

/** 历史列表超时 */
const HISTORY_TIMEOUT = 10_000
/** 单张图片超时（实测 200~340KB，现场弱网给足余量） */
const IMAGE_TIMEOUT = 12_000

/** 历史列表的一行（字段名照服务端原样，不做二次包装） */
export interface CamShotItem {
  /** 抓拍标识 `YYYYMMDDHHmmss`，同通道唯一，可直接当缓存主键 */
  mark: string
  /** 抓拍时刻（ms） */
  at: number
  /** 原图字节数 */
  size: number
  /** 图片相对地址（`/api/video/snapshots?...&mark=...`），拼 `MEDIA_ORIGIN` 后带密钥头取 */
  imageUrl: string
  /** 是否该通道最新一张 */
  latest: boolean
}

/** 历史列表一页 */
export interface CamShotPage {
  channelId: string
  items: CamShotItem[]
  page: number
  pageSize: number
  /** 该通道在可查区间内的总张数（不是本页条数） */
  total: number
  /** 服务端认可的可查区间（'YYYY-MM-DD'） */
  rangeStart: string
  rangeEnd: string
}

export interface CamShotQuery {
  /** 'YYYY-MM-DD'（北京时间的自然日）；不传 = 近 30 天全部 */
  date?: string
  /** 从 1 起 */
  page?: number
  /** 1~100 */
  pageSize?: number
}

/** 一张抓拍图片 + 服务端给的真实抓拍时刻 */
export interface CamShotImage {
  blob: Blob
  /** `YYYYMMDDHHmmss`（响应头 `X-Snapshot-Mark`，缺省时按时刻本地拼） */
  mark: string
  /** 抓拍时刻（ms，响应头 `X-Snapshot-Time`，缺省时用取到时刻） */
  at: number
}

/* ---------------- 地址 ---------------- */

/** 历史列表地址（参数顺序照文档示例，`date` 可选） */
export function camShotHistoryUrl(channelId: string, query: CamShotQuery = {}): string {
  const page = clampInt(query.page, 1, 1, Number.MAX_SAFE_INTEGER)
  const pageSize = clampInt(query.pageSize, SHOT_PAGE_SIZE, 1, SHOT_PAGE_SIZE)
  let url =
    `${MEDIA_ORIGIN}/api/video/snapshots/history` +
    `?pid=${encodeURIComponent(MEDIA_PID)}` +
    `&channelId=${encodeURIComponent(channelId)}` +
    `&page=${page}` +
    `&pageSize=${pageSize}`
  if (query.date) url += `&date=${encodeURIComponent(query.date)}`
  return url
}

/**
 * 历史图片地址：文档给的 `imageUrl` 拼测试环境入口。
 *
 * 已经是绝对地址（将来换 CDN）就原样用；空串原样返回，交给
 * `fetchCamShotImage()` 报「缺少抓拍图片地址」——**不拼任何默认地址**
 * （历史行缺失 `imageUrl` 是数据问题，拿别的地址顶替只会取到一张不对的图）。
 */
export function camShotImageUrl(imageUrl: string): string {
  if (!imageUrl) return ''
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl
  return `${MEDIA_ORIGIN}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`
}

function clampInt(v: number | undefined, dflt: number, lo: number, hi: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

/* ---------------- 错误文案（照文档「常见状态」） ---------------- */

function errText(status: number, fallback = ''): string {
  switch (status) {
    case 400:
      return fallback || '请求参数不合法'
    case 401:
      return '监控密钥无效'
    case 403:
      return '当前密钥没有该项目的监控权限'
    case 404:
      return '这条抓拍已不可用'
    case 429:
      return '监控服务忙（正在处理另一张图），请稍后重试'
    case 502:
    case 503:
      return '上游视频服务或索引异常，请稍后重试'
    default:
      return fallback || `监控快照请求失败（HTTP ${status}）`
  }
}

/** `Retry-After` 可能是秒数也可能是 HTTP 日期；解析成毫秒，兜底 1s、上限 5s */
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

/** 服务端错误信封 `{ code, message, data }` 里的那句人话（没有就空串） */
async function errMessage(res: Response): Promise<string> {
  try {
    const text = await res.text()
    const json = JSON.parse(text) as { message?: unknown }
    return typeof json.message === 'string' ? json.message : ''
  } catch {
    return ''
  }
}

/** 带超时 + 外部取消 + 429 重试一次的 GET */
async function getOnce(
  url: string,
  timeout: number,
  accept: string,
  signal?: AbortSignal,
  retry429 = true,
): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  const onOuterAbort = (): void => ac.abort()
  // 进来就已经被取消了（切点位 / 关层）：别再发这一枪
  if (signal?.aborted) ac.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    const attempt = async (): Promise<Response> => {
      try {
        return await fetch(url, {
          method: 'GET',
          headers: { 'X-API-Key': MEDIA_KEY, Accept: accept },
          // 带密钥 → 必须走 CORS；服务端回显任意 Origin，不需要 credentials
          signal: ac.signal,
        })
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        throw new ApiError(0, '监控服务访问失败（网络或跨域被拦）')
      }
    }

    let res = await attempt()
    if (res.status === 429 && retry429) {
      // 文档：429 按 Retry-After 稍后重试。只重试一次 —— 再忙就让调用方给用户重试入口，
      // 不在这里静默排队（5 张图串行时排队会拖成半分钟）。
      await sleep(retryAfterMs(res.headers.get('retry-after')))
      res = await attempt()
    }
    return res
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/* ---------------- 历史列表 ---------------- */

/**
 * 查某通道的历史抓拍。
 *
 * - 传 `date` 就是「这一天」，不传是近 30 天（按抓拍时刻倒序，服务端已排好）；
 * - 404 视为「没有记录」→ 回空页，不报错（部分通道服务端没有历史索引，实测 200 空列表
 *   与 404 都会出现，对页面而言都是「这天没有」，不该弹红字）；
 * - 其它错误按文档文案抛 `ApiError`，`message` 优先用服务端给的那句
 *   （例如「date只能查询北京时间近30个自然日」）。
 */
export async function fetchCamShotHistory(
  channelId: string,
  query: CamShotQuery = {},
  signal?: AbortSignal,
): Promise<CamShotPage> {
  if (!channelId) throw new ApiError(0, '缺少监控通道号')

  const res = await getOnce(camShotHistoryUrl(channelId, query), HISTORY_TIMEOUT, 'application/json', signal)
  if (res.status === 404) {
    const now = new Date().toISOString().slice(0, 10)
    return {
      channelId,
      items: [],
      page: clampInt(query.page, 1, 1, Number.MAX_SAFE_INTEGER),
      pageSize: clampInt(query.pageSize, SHOT_PAGE_SIZE, 1, SHOT_PAGE_SIZE),
      total: 0,
      rangeStart: now,
      rangeEnd: now,
    }
  }
  if (!res.ok) throw new ApiError(res.status, errText(res.status, await errMessage(res)))

  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new ApiError(0, '监控服务返回了无法解析的内容')
  }

  const data = (json as { data?: unknown })?.data
  const box = (data ?? {}) as Record<string, unknown>
  const rawItems = Array.isArray(box.items) ? (box.items as unknown[]) : []
  const items = rawItems.map(toShotItem).filter((x): x is CamShotItem => x !== null)

  return {
    channelId,
    items,
    page: Number(box.page) || 1,
    pageSize: Number(box.pageSize) || items.length,
    total: Number(box.total) || 0,
    rangeStart: typeof box.rangeStart === 'string' ? box.rangeStart : '',
    rangeEnd: typeof box.rangeEnd === 'string' ? box.rangeEnd : '',
  }
}

/** 一行 → 视图能用的字段（字段缺失/时刻非法就丢掉这一行，不编时间） */
function toShotItem(raw: unknown): CamShotItem | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const mark = typeof r.mark === 'string' ? r.mark.trim() : ''
  if (!mark) return null
  const at = Number(r.timestamp) || Date.parse(String(r.capturedAt ?? ''))
  if (!Number.isFinite(at) || at <= 0) return null
  return {
    mark,
    at,
    size: Number(r.fileSize) || 0,
    imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : '',
    latest: r.latest === true,
  }
}

/* ---------------- 图片 ---------------- */

/** `20261120120000` → ms（本地时区就是北京时间，与服务的 `X-Snapshot-Time` 同源） */
export function markToMs(mark: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(mark)
  if (!m) return 0
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

/** ms → `20261120120000`（服务端缺头时兜底，仅用于缓存主键） */
function msToMark(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 取一张图片（只给历史行里那个 `imageUrl` 用）。
 *
 * 返回 Blob + 真实抓拍时刻：时刻优先读响应头 `X-Snapshot-Time`（服务端 Expose 了），
 * 没有才退回 `X-Snapshot-Mark`，都没有才用取到时刻 —— 三者都缺时页面会退化成
 * 「刚取到」，但不会编造成某个历史时刻。
 */
export async function fetchCamShotImage(
  url: string,
  signal?: AbortSignal,
): Promise<CamShotImage> {
  if (!url) throw new ApiError(0, '缺少抓拍图片地址')

  const res = await getOnce(url, IMAGE_TIMEOUT, 'image/*', signal)
  if (!res.ok) {
    const status = res.status
    throw new ApiError(status, errText(status, status === 404 ? '这条抓拍已不可用' : ''))
  }

  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!ct.startsWith('image/')) throw new ApiError(0, '监控服务没有返回图片')

  const blob = await res.blob()
  if (!blob.size) throw new ApiError(0, '抓拍图片为空文件')

  const mark = (res.headers.get('x-snapshot-mark') ?? '').trim()
  const at =
    Date.parse(res.headers.get('x-snapshot-time') ?? '') || markToMs(mark) || Date.now()

  return { blob, mark: mark || msToMark(at), at }
}
