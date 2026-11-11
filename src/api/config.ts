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
 * 服务器「裸」源站（**不带端口**）。
 *
 * 登出与 token 刷新不在 `AUTH_PREFIX` 下，而是 Unity 端 `LoginRequestHelper`
 * 直接拼的 `ServerUrl + "/v1/auth/logout"`，其中 `ServerUrl` = `ServerConfig.BaseUrl`
 * = `"http://" + LoginUrl.txt 里的 host`（**没有端口**）。
 * 登录用的是 `GetUrl(8081, path)`（带端口），这两者刻意不同，照原样实现。
 *
 * 若要改成同端口 8081，构建时给 `VITE_SERVER_ORIGIN` 即可，不必改代码。
 */
export const SERVER_ORIGIN = (
  (import.meta.env.VITE_SERVER_ORIGIN as string | undefined)?.trim() || stripPort(API_BASE)
).replace(/\/+$/, '')

/** 去掉 URL 的端口（解析失败时按字符串砍） */
function stripPort(base: string): string {
  try {
    const u = new URL(base)
    return `${u.protocol}//${u.hostname}`
  } catch {
    return base.replace(/:(\d+)$/, '')
  }
}

/**
 * 工作流服务基址（**视频报警只有它在提供**）。
 *
 * Unity 端是 `GetWFUrl(8085, path)` —— 同一台机器、只换端口：
 * `:8081/api/video/alarms` 返回 `404 page not found`，`:8085` 返回
 * `{"code":401,"message":"未提供认证令牌"}`。两者共用同一个 Bearer token。
 *
 * 默认由 API_BASE 换端口推导，所以只改 VITE_API_BASE 也能跟上；
 * 工作流将来独立部署时用 VITE_WF_BASE 单独指。
 */
export const WF_BASE = (
  (import.meta.env.VITE_WF_BASE as string | undefined)?.trim() || swapPort(API_BASE, 8085)
).replace(/\/+$/, '')

/** 把 URL 的端口换成指定端口；解析失败时退回字符串替换 */
function swapPort(base: string, port: number): string {
  try {
    const u = new URL(base)
    u.port = String(port)
    return u.toString().replace(/\/+$/, '')
  } catch {
    return base.replace(/:(\d+)$/, `:${port}`)
  }
}

/**
 * 视频报警的场景码（= Unity 端 `StaticParameter.ProjectId`）。
 *
 * 项目固定值，不是用户输入；换项目时用 VITE_SCENE_CODE 覆盖。
 */
export const SCENE_CODE = (import.meta.env.VITE_SCENE_CODE as string | undefined)?.trim() || 'P000000076'

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
