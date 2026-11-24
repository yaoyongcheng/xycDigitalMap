import { MEDIA_KEY, MEDIA_ORIGIN, MEDIA_PID } from './config'
import { ApiError } from './http'

/**
 * 场景截图（2D / 3D 底图）接口 —— 2026-11-18 接入
 *
 * 现场平台（Unity「向阳村-万联装备集群作业系统」）每次截图会把当前场景渲染成
 * 一张图上传，**每个项目分别保存一张 2D 和一张 3D**，同项目同类型再上传就覆盖。
 * 首页背景（.home-map）与全屏地图的「三维 / 二维」两张底图从此都走这里，
 * 不再写死 public/img 下的 site-map / site-flat。
 *
 * 接口文档：桌面 `向阳村工地数字地图/场景截图接口使用.md`（版本 365ea8f3）。
 *
 * | 用途 | 方法与地址 |
 * | --- | --- |
 * | 元数据（含 imageBase64） | `GET {BASE}?pid=..&type=2d\|3d` |
 * | 图片字节 | `GET {BASE}/content?pid=..&type=2d\|3d` |
 * | 上传（本项目只读，不用） | `POST {BASE}`，multipart + 平台 Bearer |
 *
 * ## 三个必须记住的点
 *
 * ① **鉴权头是 `X-API-Key`，不是 Bearer**。查询侧用的是原只读密钥，与平台登录
 *    token 无关（那个只用于上传）。密钥**不能放 URL 参数**，文档明确要求走请求头。
 * ② **不能直接塞进 `<img src>`**。图片 URL 本身是免鉴权的吗？不是 —— 必须带
 *    `X-API-Key`，而 `<img>` 无法自定义请求头。所以只能 `fetch` 拿字节 → `Blob`
 *    → `URL.createObjectURL`。这也是文档「Web 端先 fetch 携带 X-API-Key 再转
 *    Blob 对象 URL」那段的原话。
 * ③ **跨域是通的**（2026-11-18 实测）。`https://115.159.67.12` 对任意 `Origin`
 *    都回 `Access-Control-Allow-Origin` 回显（含 `https://yaoyongcheng.github.io`），
 *    预检也放行 `X-API-Key`，所以**不需要**像 `/iot-api` 那样加同源反代。
 *    页面在 HTTPS 下也不会有混合内容问题 —— 这个接口本身就是 HTTPS。
 *
 * ## 元数据接口为什么不用
 *
 * `GET {BASE}?pid=..&type=..` 会把整张图 Base64 塞进 JSON（实测 2D 那张
 * 5.08MB / 3.81MB 图片），只为拿 `fileName / uploadedAt` 不值当；判断
 * 「有没有图」用 `/content` 的 HTTP 状态码就够（未上传是 404）。
 */

/** 接口基址（`VITE_SCENE_BASE` 可覆盖，换域名/反代时不用改代码） */
export const SCENE_BASE = (
  (import.meta.env.VITE_SCENE_BASE as string | undefined)?.trim() ||
  `${MEDIA_ORIGIN}/api/file/scene-screenshots`
).replace(/\/+$/, '')

/**
 * 第三方只读密钥（文档给的固定值，只对 P000000076 这个项目有效）。
 *
 * 与监控快照共用同一个密钥，值集中在 `api/config.ts` 的 `MEDIA_KEY`
 * （那里有「为什么放在前端不算泄露」的说明）。
 */
export const SCENE_KEY = MEDIA_KEY

/** 项目号（与 `SCENE_CODE` 同值：`P000000076`，即 Unity 端的 ProjectId） */
export const SCENE_PID = MEDIA_PID

/** `2d` = 正射影像（全屏地图的二维）；`3d` = 透视场景（首页背景 + 三维） */
export type SceneType = '2d' | '3d'

/**
 * 「这个类型还没上传过图」。
 *
 * 文档：未上传指定类型返回 **404**，且**不会**自动回退成另一种类型。
 * 它和「网络挂了 / 密钥失效」是两种处境 —— 前者该安静地退回内置底图，
 * 后者值得记一条错误。所以单独一个类型，调用方按 instanceof 分辨。
 */
export class SceneNotFoundError extends ApiError {
  constructor(type: SceneType) {
    super(404, `该项目还没有上传 ${type.toUpperCase()} 场景截图`)
    this.name = 'SceneNotFoundError'
  }
}

/** HTTP 状态码 → 可直接给人看的说明（文档「兼容及错误说明」那张表） */
function sceneErrText(status: number, type: SceneType): string {
  switch (status) {
    case 400:
    case 415:
      return '场景截图参数或图片格式不被接受'
    case 401:
      return '场景截图密钥无效（X-API-Key）'
    case 403:
      return '当前密钥没有该项目的场景截图权限'
    case 404:
      return `该项目还没有上传 ${type.toUpperCase()} 场景截图`
    case 413:
      return '场景截图超出大小限制'
    case 429:
      return '场景截图接口限流，请稍后重试'
    default:
      return `场景截图接口异常（HTTP ${status}）`
  }
}

/**
 * 一次取图的结果。
 *
 * `notModified` 是 2026-11-24 新增的条件请求分支：服务端对 `/content` 会回
 * `ETag` + `Last-Modified`（实测 nginx 直接支持 `If-None-Match` → 304），
 * 图没变时只回一个空响应（几百字节），**3.3~3.8MB 的字节一个都不传**。
 * 这时 `blob` 为 `null`，调用方用本地那张（IndexedDB 里的兜底图）。
 */
export interface SceneImage {
  /** 304 时为 null：字节没变，本地那张就是最新的 */
  blob: Blob | null
  /** 服务端给的强 ETag（`"…"` 带引号），下次带回 `If-None-Match`；空串 = 服务端没给 */
  etag: string
  /** `Last-Modified`，ETag 缺失时的退路（`If-Modified-Since`） */
  lastModified: string
  /** 是否 304（本地副本可直接用） */
  notModified: boolean
}

/**
 * 拉某个类型的场景截图，**带条件请求**。
 *
 * 为什么要自己带 `If-None-Match` 而不是靠浏览器 HTTP 缓存（2026-11-24 优化）：
 *   · 响应头是 `Cache-Control: private, no-cache` + `Vary: X-API-Key`，浏览器
 *     每次都要发条件请求，但它存的那份 3.3MB 副本我们从来不用（我们有自己的
 *     IndexedDB 兜底图），纯占手机存储；
 *   · `cache: 'no-store'` 明确不要浏览器再存一份，条件判断完全由我们控制 ——
 *     ETag 存在本地图旁边，冷启动先读它，再拿它换一次 304。
 */
export async function fetchSceneImage(
  type: SceneType,
  opts: { signal?: AbortSignal; etag?: string; lastModified?: string } = {},
): Promise<SceneImage> {
  const url = `${SCENE_BASE}/content?pid=${encodeURIComponent(SCENE_PID)}&type=${type}`

  const headers: Record<string, string> = { 'X-API-Key': SCENE_KEY, Accept: 'image/*' }
  /*
   * 强 ETag 优先；没有才退回 `If-Modified-Since`（秒级精度，只在同一秒内改两次
   * 时可能漏判，概率可忽略）。两个都不带就是普通 GET。
   */
  if (opts.etag) headers['If-None-Match'] = opts.etag
  else if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      // 密钥进了请求头 → 必须走 CORS；不加 credentials（服务端虽然回
      // Allow-Credentials，但我们不需要携带任何 Cookie）
      signal: opts.signal,
      // 本地已有一份（IDB），不要浏览器再存 3.3MB 的 HTTP 缓存副本
      cache: 'no-store',
    })
  } catch (e) {
    // 用户主动取消：原样抛，调用方按 AbortError 忽略
    if ((e as Error)?.name === 'AbortError') throw e
    throw new ApiError(0, '场景截图接口访问失败（网络或跨域被拦）')
  }

  const etag = res.headers.get('etag') ?? opts.etag ?? ''
  const lastModified = res.headers.get('last-modified') ?? opts.lastModified ?? ''

  // 图没变：只回一个空响应，本地副本直接继续用
  if (res.status === 304) return { blob: null, etag, lastModified, notModified: true }

  if (res.status === 404) throw new SceneNotFoundError(type)
  if (!res.ok) throw new ApiError(res.status, sceneErrText(res.status, type))

  // 服务端异常时也可能 200 + 空体 / JSON：先看类型，再验体积
  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!ct.startsWith('image/')) {
    throw new ApiError(0, '场景截图接口没有返回图片')
  }

  const blob = await res.blob()
  if (!blob.size) throw new ApiError(0, '场景截图为空文件')
  return { blob, etag, lastModified, notModified: false }
}

/**
 * 拉取某个类型的场景截图字节（无条件版，返回 Blob）。
 *
 * 保留这个签名：调用方只有 store，但单测直接用它钉「鉴权头 / 地址 / 404 语义」。
 * 需要「图没变就别重下」时用 `fetchSceneImage`。
 *
 * 带 `signal` 是为了「请求还没回来用户已经离开页面」时不白下 3MB。
 */
export async function fetchSceneBlob(type: SceneType, signal?: AbortSignal): Promise<Blob> {
  const res = await fetchSceneImage(type, { signal })
  if (!res.blob) throw new ApiError(0, '场景截图接口返回 304，但没有本地副本可用')
  return res.blob
}

