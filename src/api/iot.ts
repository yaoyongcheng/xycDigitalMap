import { ApiError } from './http'
import { SCENE_CODE } from './config'

/**
 * 物联网网关（C 组 `https://iot.cscec3b-iti.com`）
 *
 * ## 这一组之前被记成「全端口 404」，是查错了地方
 *
 * 早期结论写的是「`/api/data/v1/tsdb/queryRealTimeDataV2` 在 80/443/8080–8091/9000
 * 全试过都是 404」。那说的是**项目自己的机器**（115.159.67.12）上的路径 ——
 * 确实没有。但 tsdb 真实托管在 C 组这台云网关上，路径同形、机器不同。
 * 换到正确主机后换 token 成功、接口返回「查询条件为空」，说明路由是通的。
 *
 * ## 鉴权：ak/sk 换令牌
 *
 *   POST https://iot.cscec3b-iti.com/api/webgateway/v1/access/token
 *   body `{"ak": "...", "sk": "..."}`（**字段名是 ak/sk，不是 appKey/appSecret**）
 *   → `{ status:0, data:{ tokenKey:"X-APP-USER", tokenValue:"...", expireTs:172800 } }`
 *
 * 之后每个请求带 `tokenKey: tokenValue` 这个头（实测是 `X-APP-USER: <token>`）。
 * `expireTs` 单位是秒（172800 = 48 小时）。
 *
 * 凭据硬编码在 Unity 端 `ElevatorRequester.LoginOnceAsync` 里（原厂方案如此）。
 *
 * ## 查询体
 *
 * `queryRealTimeDataV2` 收 `{"queryList":[{productCode, sn, field, code}]}`，
 * `productCode` 就是项目码 `P000000076`（与 `StaticParameter.ProjectId` 同值，
 * 也与报警接口的 `sceneCode` 是同一个东西）。
 *
 * `sn` 是设备序列号 —— 但**本项目的设备台账（`:8084`）里没有 sn 字段**，
 * 只有 `device_name` 与 `device_info.extra_fields`。所以在拿到 SN 之前，
 * 这一层只能拿到「接口可用」这个结论，页面继续用台账字段。
 */

/** 项目级 ak / sk（原厂硬编码） */
const IOT_AK = 'MWHLJ9oqa34Z7xan9OPiw'
const IOT_SK = 'S0gThCxxgFeyFX1elZTje71Rnbb6hfZTut6UJSUw09M'

/** 云网关基址 */
const IOT_BASE = 'https://iot.cscec3b-iti.com'

/** 单次请求超时 */
const TIMEOUT = 12_000

/* ---------- 类型 ---------- */

/** 换到的令牌 */
export interface IotToken {
  /** 令牌头名（实测 `X-APP-USER`） */
  tokenKey: string
  /** 令牌值 */
  tokenValue: string
  /** 过期时刻（ms） */
  expiresAt: number
}

/** 实时数据查询项 */
export interface RealtimeQueryItem {
  /** 项目码，实测 `P000000076` */
  productCode: string
  /** 设备序列号 */
  sn: string
  /** 度量字段名，如 `height` / `angleSpeed` */
  field: string
  /** 度量编码 */
  code: string
}

/** 一条实时数据点 */
export interface RealtimePoint {
  /** 设备 uuid */
  uuid: string
  /** 时间戳 */
  timestamp: number | null
  /** 度量下标 */
  metricIndex: number | null
  /** 数值 */
  value: number | null
}

/* ---------- 内部工具 ---------- */

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

async function iotFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    return await fetch(`${IOT_BASE}${path}`, { ...init, signal: ctrl.signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, '物联网网关请求超时')
    }
    throw new ApiError(0, '物联网网关不可达')
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * 解析云网关响应包。
 *
 * 注意它与大屏 open 不同：**成功码是 `status === 0`**（不是 200），
 * 业务失败是 `status: 10`（缺少必要输入）、`status: 1` 之类。
 */
async function iotJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await iotFetch(path, init)
  let body: Record<string, unknown> | null = null
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    throw new ApiError(res.status || 0, `物联网网关返回异常（HTTP ${res.status}）`)
  }
  const status = num(body?.status)
  if (!res.ok || (status !== null && status !== 0)) {
    throw new ApiError(status ?? res.status, str(body?.msg) || `请求失败（HTTP ${res.status}）`)
  }
  return body.data as T
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (v === undefined || v === null) return ''
  return String(v)
}

/* ---------- 令牌 ---------- */

let token: IotToken | null = null
let inflight: Promise<IotToken> | null = null

/** 换令牌；单独导出是为了单测能直接断言请求体与响应解析 */
export async function requestToken(): Promise<IotToken> {
  const data = await iotJson<{
    tokenKey?: string
    tokenValue?: string
    expireTs?: number
  }>('/api/webgateway/v1/access/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ak: IOT_AK, sk: IOT_SK }),
  })
  const tokenKey = str(data?.tokenKey)
  const tokenValue = str(data?.tokenValue)
  if (!tokenKey || !tokenValue) throw new ApiError(0, '物联网网关未返回令牌')
  const expireTs = num(data?.expireTs) ?? 3600
  return { tokenKey, tokenValue, expiresAt: Date.now() + expireTs * 1000 }
}

/** 拿一个可用令牌，过期自动重换 */
export async function ensureToken(): Promise<IotToken> {
  if (token && token.expiresAt > Date.now()) return token
  if (inflight) return inflight
  inflight = (async () => {
    try {
      token = await requestToken()
      return token
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 测试接线点：直接灌一个令牌，跳过换 token */
export function applyToken(t: IotToken | null): void {
  token = t
}

/** 清令牌（登出 / 换账号时调用） */
export function clearToken(): void {
  token = null
}

/** 带令牌的 POST */
async function iotAuthPost<T>(path: string, body: unknown): Promise<T> {
  const t = await ensureToken()
  try {
    return await iotJson<T>(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        [t.tokenKey]: t.tokenValue,
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    // 令牌失效：清一次重换再试
    if (err instanceof ApiError && (err.code === 401 || err.code === 403)) {
      clearToken()
      const t2 = await ensureToken()
      return iotJson<T>(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          [t2.tokenKey]: t2.tokenValue,
        },
        body: JSON.stringify(body),
      })
    }
    throw err
  }
}

/* ---------- 业务接口 ---------- */

/** 把实时数据点收敛成前端类型；脏行丢掉 */
export function toPoints(raw: unknown): RealtimePoint[] {
  const list = Array.isArray(raw) ? raw : []
  const out: RealtimePoint[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const uuid = str(o.uuid)
    if (!uuid) continue
    out.push({
      uuid,
      timestamp: num(o.timestamp),
      metricIndex: num(o.metricIndex),
      value: num(o.value),
    })
  }
  return out
}

/**
 * 查询设备实时数据。
 *
 * 请求体 `{queryList:[{productCode, sn, field, code}]}`；`productCode` 传项目码
 * （`P000000076`）。响应是数据点数组，字段为 `uuid / timestamp / metricIndex / value`。
 *
 * ⚠️ **本项目目前拿不到 `sn`**：`:8084` 的设备台账只有 `device_name` 与
 * `device_info.extra_fields`，没有序列号字段。所以这个接口在当前数据条件下
 * 仍无法产出真实作业指标（吊次 / 吊重 / 利用率），页面保持空态。
 * 这一层先建好，等台账补上 sn 即可直接用。
 */
export async function fetchRealtimeData(items: RealtimeQueryItem[]): Promise<RealtimePoint[]> {
  if (!items.length) return []
  const raw = await iotAuthPost<unknown>('/api/data/v1/tsdb/queryRealTimeDataV2', {
    queryList: items.map((i) => ({
      productCode: i.productCode || SCENE_CODE,
      sn: i.sn,
      field: i.field,
      code: i.code,
    })),
  })
  return toPoints(raw)
}

/**
 * 查询设备事件（告警事件时间线）。
 *
 * 请求体 `{startTime, endTime, eventItems:[...]}` —— 与实时数据同一族接口，
 * 时间格式是服务端自己的字符串，原厂传的是 `'yyyy-MM-dd HH:mm:ss'`。
 */
export async function fetchEvents(
  items: RealtimeQueryItem[],
  startTime: string,
  endTime: string,
): Promise<RealtimePoint[]> {
  if (!items.length) return []
  const raw = await iotAuthPost<unknown>('/api/data/v1/tsdb/queryEvent', {
    startTime,
    endTime,
    eventItems: items.map((i) => ({
      productCode: i.productCode || SCENE_CODE,
      sn: i.sn,
      field: i.field,
      code: i.code,
    })),
  })
  return toPoints(raw)
}
