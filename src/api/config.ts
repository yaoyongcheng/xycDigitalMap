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
 * 关于「裸源站」的一点实测记要（2026-11-11）。
 *
 * 反编译里 `LoginRequestHelper.LoginOut` 拼的是 `ServerUrl + "/v1/auth/logout"`，
 * 而 `ServerUrl` = `ServerConfig.BaseUrl` = `"http://" + host`（**不带端口**）。
 * 照这个实现后现场实测全是 404：`http://115.159.67.12/v1/auth/logout` 被
 * nginx 直接 404，`:8081` 与 `:8085` 上的同一路径也是 `404 page not found`。
 *
 * 逐个路径试下来，真正可用的是登录域下的 **`POST /api/user/auth/logout`**
 * （`:8081`，返回 `{"code":200,"message":"登出成功"}`）。也就是说 Unity 端那段
 * 拼法要么指向了另一个部署，要么是已经失效的旧逻辑 —— 以实测为准。
 * 因此这里不再导出 `SERVER_ORIGIN`，登出与登录共用 `AUTH_PREFIX`。
 */

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
 * 数据服务基址（设备台账 / 楼栋 / 区域）。
 *
 * 2026-11 第二轮实测发现：`/api/data/*` **既不在 8081 也不在 8085**。
 * 反编译只知道路径，没记端口；两台服务上都回 `404 page not found`。
 * 把 80/443/8080–8091/9000 全扫一遍后定位到 **`:8084`**：
 *
 *   `GET :8084/api/data/deviceinfos` → 200（本项目 8 台设备）
 *   `GET :8084/api/data/buildings`   → 200
 *   `GET :8084/api/data/areas`       → 200
 *
 * 鉴权与登录同一个 Bearer token（无 token → `401 {"error":"Authorization header required"}`），
 * 所以它和 8085 一样受会话守卫约束。响应信封是 `{code:200,message,data:{list,total}}`。
 *
 * 同机器的其它端口（探测记录，省得下次再扫）：
 *   · `:8080` 大屏 SPA（任意路径回 index.html，POST 回 405）
 *   · `:8088` 高德天气代理（免登录，见 WEATHER_BASE）
 *   · `:8090/:9000` 各有一个前端站点
 *   · 其余 8082/8083/8086/8087/8089/8091 均 404
 */
export const DATA_BASE = (
  (import.meta.env.VITE_DATA_BASE as string | undefined)?.trim() || swapPort(API_BASE, 8084)
).replace(/\/+$/, '')

/**
 * 天气代理基址（`:8088`，**免登录**）。
 *
 * 反编译里写的是 `{API_BASE}/api/map/amap/weather/live`，实测 8081/8084 都 404；
 * 真身是 8088 上的同名路径，直接回高德原始结构：
 * `{status:"1", lives:[{province,city,weather,temperature,winddirection,windpower,humidity}]}`。
 *
 * 目前设计稿没有天气位，先留客户端备用（同 `weekEnterpriseAtteStat` 的处理）。
 */
export const WEATHER_BASE = (
  (import.meta.env.VITE_WEATHER_BASE as string | undefined)?.trim() || swapPort(API_BASE, 8088)
).replace(/\/+$/, '')

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
