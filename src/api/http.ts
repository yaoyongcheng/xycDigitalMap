import { API_BASE, isMixedContent } from './config'

/**
 * 统一的 HTTP 客户端
 *
 * 服务端是 Go 写的统一响应包：`{ code, message, data }`，业务成功时 code === 200
 * （不是 HTTP 200 —— 业务错误也可能带 4xx/5xx 状态码与同样的包体）。
 *
 * 三件事收在这里，业务代码不再各写一遍：
 *   ① 拼 URL、序列化 JSON、统一 Content-Type；
 *   ② 往需要鉴权的请求上注入 `Authorization: Bearer {token}`；
 *   ③ 把响应/网络错误收敛成 ApiError，并在 401 时清会话（回调注入，避免与
 *      store 循环依赖）。
 */

/** 响应包 */
interface Envelope<T> {
  code: number
  message?: string
  data?: T
}

/** 统一错误：code 为服务端业务码（0 表示本地/网络错误），message 可直接展示 */
export class ApiError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/* ---------- 会话钩子 ---------- */

let tokenProvider: () => string = () => ''
let unauthorizedHandler: (() => void) | null = null

/**
 * 由 auth store 在创建时注入：怎么取当前 token、401 时怎么清会话。
 *
 * 不直接 import store 是为了避免 http ↔ store ↔ http 的循环依赖，也让这一层
 * 在单测里可以单独跑（注入一个假 token 即可断言请求头）。
 */
export function bindSession(hooks: {
  token: () => string
  unauthorized: () => void
}): void {
  tokenProvider = hooks.token
  unauthorizedHandler = hooks.unauthorized
}

/* ---------- 请求 ---------- */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  /** JSON 请求体（自动序列化） */
  body?: unknown
  /**
   * 是否带登录态，默认 true。
   * 登录相关接口（public-key / login）必须传 false —— 那时还没有 token。
   */
  auth?: boolean
  signal?: AbortSignal
}

/** 网络层失败时给用户看的话（区分「被混合内容拦了」与「真没网」） */
function networkMessage(err: unknown): string {
  if (isMixedContent()) {
    return '网络请求被浏览器拦截（HTTPS 页面访问 HTTP 接口）'
  }
  if (err instanceof DOMException && err.name === 'AbortError') return '请求已取消'
  return '网络不可用，请检查网络后重试'
}

/** 发一个请求并返回 `data`；任何非 200 的业务码都抛 ApiError */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = /^https?:\/\//.test(path) ? path : `${API_BASE}${path}`
  const token = opts.auth === false ? '' : tokenProvider()

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    })
  } catch (err) {
    throw new ApiError(0, networkMessage(err))
  }

  const text = await res.text()
  let env: Envelope<T> | null = null
  try {
    env = text ? (JSON.parse(text) as Envelope<T>) : null
  } catch {
    // 网关/代理返回的 HTML 错误页也会走到这里，不能直接 JSON.parse 炸给用户
    throw new ApiError(res.status || 0, `服务返回异常（HTTP ${res.status}）`)
  }

  if (res.status === 401 || env?.code === 401) {
    unauthorizedHandler?.()
    throw new ApiError(401, env?.message || '登录已过期，请重新登录')
  }

  if (!res.ok || !env || env.code !== 200) {
    throw new ApiError(env?.code ?? res.status, env?.message || `请求失败（HTTP ${res.status}）`)
  }

  return env.data as T
}
