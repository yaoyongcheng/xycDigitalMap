import type { ScaffoldSensor } from '@/types'
import { parseSensors } from '@/utils/scaffold'

/**
 * 智能爬架传感器 —— 取数
 *
 * ## 数据源是「静态 JSON」，不是 REST 接口
 *
 * V2（Unity 桌面端）里没有爬架传感器接口，只有定时拉一份静态文件：
 *
 * ```
 * CdnHelper.GetHostServerIP()      // 读 StreamingAssets/CdnConfig.txt
 *   = "http://120.26.34.95:9689"   // 实际内容
 * CdnHelper.GetHostServerURL(fn)   // = 上面 + "/CDN/PC/" + fn
 *   → http://120.26.34.95:9689/CDN/PC/ScaffoldData.json
 * ```
 *
 * 免登录、无鉴权头、无查询参数 —— 从协议上说确实是「一个静态文件」。
 *
 * **但它的内容会变**：现场每几分钟重写一次，38 个机位的读数与 `updateTime`
 * 都在走。所以不能把它当成编译期常量硬编码进代码 —— 那样页面会永远显示
 * 某一刻的旧读数，而且看不出来是旧的。
 *
 * ## 因此采用「线上优先 + 内置快照兜底」
 *
 * 1. 先拉 CDN（6s 超时），拿到就用，`source = 'live'`；
 * 2. 拉不到就用项目内置的 `public/data/scaffold.json`（同一份文件的真实快照，
 *    随仓库发布），`source = 'snapshot'`；
 * 3. 两个都失败 → `null`，页面走空态。
 *
 * 为什么需要兜底：线上站点是 GitHub Pages（**强制 HTTPS**），而这份 CDN 是
 * 纯 HTTP —— 浏览器会按 mixed content 直接拦掉。没有兜底的话，线上环境这一
 * 整块永远是空态。有兜底时至少能看到真实读数；页面只标读数时间戳，不区分来源。
 *
 * ## 约定
 *
 * 与项目其它接口层一致：**永不抛错**。任何失败都收敛成 `null` 或快照。
 */

/** CDN 根（来自 V2 的 StreamingAssets/CdnConfig.txt） */
const CDN_BASE = 'http://120.26.34.95:9689'

/** 爬架传感器文件（V2 的 ScaffoldDataRequester::InitRequest 硬编码） */
export const SCAFFOLD_URL = `${CDN_BASE}/CDN/PC/ScaffoldData.json`

/** 内置快照（随站点发布，免登录；内容与 CDN 同格式） */
export const SCAFFOLD_SNAPSHOT_URL = `${import.meta.env.BASE_URL}data/scaffold.json`

/** 线上请求超时：公网 CDN，但拿不到要尽快退到快照，别让卡片一直转 */
const LIVE_TIMEOUT = 6_000

/** 快照是站内静态资源，正常几十毫秒；给 8s 只防极端情况 */
const SNAPSHOT_TIMEOUT = 8_000

/** 取数结果：读数 + 来源（来源只做内部诊断，不呈现给用户） */
export interface ScaffoldResult {
  sensors: ScaffoldSensor[]
  /** 'live' = CDN 实时取到；'snapshot' = 项目内置离线快照 */
  source: 'live' | 'snapshot'
}

/** 拉一个 URL 并解析成机位读数；失败返回 null（永不抛） */
async function readJson(url: string, timeout: number): Promise<ScaffoldSensor[] | null> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-cache', signal: ctrl.signal })
    if (!res.ok) return null
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // 反代返回 HTML 错误页 / 空体
      return null
    }
    return parseSensors(body)
  } catch {
    // 超时 / 断网 / mixed content 被拦 —— 都算没拿到
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * 取一次爬架传感器数据：CDN 优先，失败退到内置快照。
 *
 * @returns 读数与来源；两者都失败时 `null`（页面据此走空态）
 */
export async function fetchScaffold(): Promise<ScaffoldResult | null> {
  const live = await readJson(SCAFFOLD_URL, LIVE_TIMEOUT)
  if (live) return { sensors: live, source: 'live' }

  const snap = await readJson(SCAFFOLD_SNAPSHOT_URL, SNAPSHOT_TIMEOUT)
  if (snap) return { sensors: snap, source: 'snapshot' }

  return null
}
