/**
 * 接口环境配置
 *
 * 端点与端口全部照搬 Unity 端（向阳村-万联装备集群作业系统）的 LoginParameter：
 * 域名读 StreamingAssets/LoginUrl.txt（当前 http://115.159.67.12），登录相关
 * 接口固定挂在 :8081 的 /api/user/auth 下。
 *
 * 为什么留一个 VITE_API_BASE 覆盖点：本页是 GitHub Pages 上的静态站点（HTTPS），
 * 而现场服务器只开了 HTTP 8081 —— 浏览器会以「混合内容」为由直接拦掉请求。
 * 换域名 / 上 TLS / 走反向代理时不用改代码，构建时给 VITE_API_BASE 即可。
 */

/** 接口根地址（不含尾斜杠） */
export const API_BASE = (
  (import.meta.env.VITE_API_BASE as string | undefined)?.trim() || 'http://115.159.67.12:8081'
).replace(/\/+$/, '')

/** 登录域下的接口前缀（Unity 端 LoginParameter.RSAKeyUrl / LoginUrl / UnityPermissionUrl 同前缀） */
export const AUTH_PREFIX = '/api/user/auth'

/**
 * 当前环境是否是「HTTPS 页面 + HTTP 接口」。
 *
 * 这种组合下浏览器会按混合内容拦截，fetch 抛 TypeError，控制台报
 * "Mixed Content"，而用户只看到「网络不可用」。登录页据此提前给出可读提示，
 * 免得把服务端问题误判成账号问题。
 */
export function isMixedContent(): boolean {
  if (typeof window === 'undefined') return false
  return window.location.protocol === 'https:' && API_BASE.startsWith('http://')
}

/** 页面在 HTTPS 下访问 HTTP 接口时的提示文案 */
export const MIXED_CONTENT_HINT =
  '当前页面是 HTTPS，而登录接口是 HTTP，浏览器会拦截该请求。请改用 HTTP 访问本页，或让服务端为接口配置 HTTPS。'
