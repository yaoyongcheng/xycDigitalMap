import { WEATHER_BASE } from './config'
import { ApiError } from './http'

/**
 * 天气代理（E 组 `:8088`，**免登录**）
 *
 * 这是高德天气 API 的服务端代理，返回的是高德的原始结构（不是 Go 信封），
 * 所以与 `http.ts` 的 `request()` 不兼容，单独实现。
 *
 * ## 一个必须注意的参数：city 要的是 adcode，不是城市名
 *
 * 实测 `?city=河源` 返回 `{"code":400,"message":"city must be a six-digit adcode"}`。
 * 传六位行政区划码才正常（武汉是 `420100`）。
 *
 * 项目位置在武汉（`:8084` 网关 GPS 实测 30.53N / 114.25E），
 * 所以默认 adcode 用武汉的 `420100`。
 *
 * ## 响应结构
 *
 * 实测（2026-11-11 16:31）：
 *   live      → `{status:"1", lives:[{province,city,weather,temperature,winddirection,windpower,humidity,reporttime}]}`
 *   forecast  → `{status:"1", forecasts:[{city,adcode,province,reporttime,casts:[{date,week,dayweather,nightweather,daytemp,nighttemp,daywind,nightwind,daypower,nightpower}]}]}`
 *
 * `status` 是字符串 `"1"`（高德的老约定，成功是 "1" 不是 "0"）。
 */

/** 本项目所在城市的行政区划码（武汉） */
export const DEFAULT_ADCODE = '420100'

/** 实时天气 */
export interface LiveWeather {
  province: string
  city: string
  adcode: string
  /** 天气现象，如「阴」 */
  weather: string
  /** 温度（℃） */
  temperature: string
  /** 风向，如「东南」 */
  winddirection: string
  /** 风力等级，如「≤3」 */
  windpower: string
  /** 湿度（%） */
  humidity: string
  /** 报告时间 */
  reporttime: string
}

/** 逐日预报中的一天 */
export interface ForecastCast {
  date: string
  /** 星期，'1'=周一 … '7'=周日 */
  week: string
  dayweather: string
  nightweather: string
  daytemp: string
  nighttemp: string
  daywind: string
  nightwind: string
  daypower: string
  nightpower: string
}

/** 天气预报 */
export interface ForecastWeather {
  city: string
  adcode: string
  province: string
  reporttime: string
  casts: ForecastCast[]
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (v === undefined || v === null) return ''
  return String(v)
}

/**
 * 拉一个 JSON；高德信封的失败是 `{code:400, message:"..."}`（HTTP 也是 400）。
 */
async function weatherGet<T>(path: string, adcode: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${WEATHER_BASE}${path}?city=${encodeURIComponent(adcode)}`, {
      headers: { Accept: 'application/json' },
    })
  } catch {
    throw new ApiError(0, '天气服务不可达')
  }
  let body: Record<string, unknown> | null = null
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    throw new ApiError(res.status || 0, `天气服务返回异常（HTTP ${res.status}）`)
  }
  // 高德：业务失败时带 code 字段（400 = 参数错）；成功时 status === '1'
  const code = typeof body?.code === 'number' ? body.code : null
  if (!res.ok || (code !== null && code !== 200)) {
    throw new ApiError(code ?? res.status, str(body?.message) || `请求失败（HTTP ${res.status}）`)
  }
  return body as T
}

/** 把实时天气收敛成前端类型 */
export function toLiveWeather(raw: unknown): LiveWeather | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const lives = Array.isArray(o.lives) ? (o.lives as Record<string, unknown>[]) : []
  const f = lives[0]
  if (!f) return null
  return {
    province: str(f.province),
    city: str(f.city),
    adcode: str(f.adcode),
    weather: str(f.weather),
    temperature: str(f.temperature),
    winddirection: str(f.winddirection),
    windpower: str(f.windpower),
    humidity: str(f.humidity),
    reporttime: str(f.reporttime),
  }
}

/** 把天气预报收敛成前端类型 */
export function toForecast(raw: unknown): ForecastWeather | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(o.forecasts) ? (o.forecasts as Record<string, unknown>[]) : []
  const f = list[0]
  if (!f) return null
  const casts = Array.isArray(f.casts) ? (f.casts as Record<string, unknown>[]) : []
  return {
    city: str(f.city),
    adcode: str(f.adcode),
    province: str(f.province),
    reporttime: str(f.reporttime),
    casts: casts.map((c) => ({
      date: str(c.date),
      week: str(c.week),
      dayweather: str(c.dayweather),
      nightweather: str(c.nightweather),
      daytemp: str(c.daytemp),
      nighttemp: str(c.nighttemp),
      daywind: str(c.daywind),
      nightwind: str(c.nightwind),
      daypower: str(c.daypower),
      nightpower: str(c.nightpower),
    })),
  }
}

/** 实时天气 */
export async function fetchLiveWeather(adcode: string = DEFAULT_ADCODE): Promise<LiveWeather | null> {
  return toLiveWeather(await weatherGet<unknown>('/api/map/amap/weather/live', adcode))
}

/** 天气预报（未来几天） */
export async function fetchForecastWeather(
  adcode: string = DEFAULT_ADCODE,
): Promise<ForecastWeather | null> {
  return toForecast(await weatherGet<unknown>('/api/map/amap/weather/forecast', adcode))
}
