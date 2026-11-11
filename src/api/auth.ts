import { request } from './http'
import { AUTH_PREFIX, SERVER_ORIGIN } from './config'
import { encryptLoginPayload } from './crypto'

/**
 * 登录域接口（对齐 Unity 端 LoginRequestHelper.LoginRequestAsync）
 *
 * 流程是「先取公钥、再加密登录」两步，不是一次 plain 请求：
 *   ① GET  /api/user/auth/public-key  → { public_key: PEM }
 *   ② POST /api/user/auth/login       → body { encrypted_data: Base64 }
 *      encrypted_data = RSA_PKCS1(JSON.stringify({ username, password }))
 *   ③ 响应 → { access_token, expires_in }
 *
 * 服务端明确拒绝明文登录（返回「为了安全起见，登录请求必须加密」），所以这一步
 * 不能省。字段名 encrypted_data 来自 Unity 端匿名对象 `new { encrypted_data }`，
 * 与普通登录接口常见的 username/password 完全不同。
 */

/** 公钥接口的返回 */
interface PublicKeyData {
  public_key: string
}

/** 登录接口的返回 */
export interface LoginData {
  access_token: string
  /** 有效期（秒）。服务端若返回时间戳也兼容，见 toExpiresAt */
  expires_in?: number
}

/** 本地会话 */
export interface Session {
  token: string
  /** 过期时间戳（ms），0 表示服务端没给有效期 */
  expiresAt: number
}

/** 账号信息（/me 的字段名没有文档，按常见命名兜底解析） */
export interface Profile {
  username: string
  /** 展示名（姓名/昵称），取不到时回落到账号 */
  displayName: string
  /** 角色名（服务端给了才显示） */
  role: string
}

/** expires_in 既可能是「多少秒」，也可能是时间戳，统一成毫秒时间戳 */
function toExpiresAt(expiresIn?: number): number {
  if (!expiresIn || !Number.isFinite(expiresIn)) return 0
  if (expiresIn > 1e12) return expiresIn // 毫秒时间戳
  if (expiresIn > 1e9) return expiresIn * 1000 // 秒时间戳
  return Date.now() + expiresIn * 1000 // 相对秒数（当前服务端行为）
}

/** 取公钥 → 加密 → 登录，成功返回本地会话 */
export async function login(username: string, password: string): Promise<Session> {
  const { public_key: pem } = await request<PublicKeyData>(`${AUTH_PREFIX}/public-key`, {
    auth: false,
  })
  const encrypted = encryptLoginPayload(pem, { username, password })
  const data = await request<LoginData>(`${AUTH_PREFIX}/login`, {
    method: 'POST',
    auth: false,
    body: { encrypted_data: encrypted },
  })
  if (!data?.access_token) {
    throw new Error('登录响应缺少 access_token')
  }
  return { token: data.access_token, expiresAt: toExpiresAt(data.expires_in) }
}

/**
 * 登出（对齐 Unity 端 `LoginRequestHelper.LoginOut`）。
 *
 * 三个容易踩错的点，全部照原样实现：
 *   ① 路径是 `/v1/auth/logout`，**不在** `/api/user/auth` 之下；
 *   ② 基址用 `ServerUrl`（= `http(s)://host`，**不带端口**），而不是登录用的
 *      `GetUrl(8081, …)`。Unity 端这两条路径刻意用了不同的拼法，跟着它走；
 *      要改成同端口 8081，用 `VITE_SERVER_ORIGIN` 覆盖即可；
 *   ③ 方法是 POST、body 为空、只带 `Authorization: Bearer {token}`。
 *
 * 成功判定在调用方做（Unity 端判 `code == 200` 才认为服务端已注销）。
 * 这里不吞异常：由 store 决定「服务端失败也要本地退出」。
 */
export async function logout(token: string): Promise<void> {
  await request<null>(`${SERVER_ORIGIN}/v1/auth/logout`, { method: 'POST', token })
}

interface MeData {
  username?: string
  account?: string
  name?: string
  realName?: string
  real_name?: string
  nickname?: string
  nickName?: string
  roleName?: string
  role_name?: string
  role?: string | { name?: string }
}

/**
 * 拉当前账号信息（带 token 的真实业务请求，用来验证登录态是否仍然有效）。
 *
 * 字段名在服务端没有公开文档，这里按常见命名兜底；全都取不到就回落到登录账号。
 * 调用方应把它当作「锦上添花」：失败不影响已登录状态，除非是 401。
 */
export async function fetchProfile(fallbackName: string): Promise<Profile> {
  const me = await request<MeData>(`${AUTH_PREFIX}/me`)
  const username = me?.username || me?.account || fallbackName
  const role =
    typeof me?.role === 'string' ? me.role : (me?.role?.name ?? me?.roleName ?? me?.role_name ?? '')
  return {
    username,
    displayName: me?.realName || me?.real_name || me?.name || me?.nickname || me?.nickName || username,
    role,
  }
}
