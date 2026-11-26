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
 * `sn` 是设备序列号 —— 台账（`:8084`）里没有这个字段，早前这里只能得出
 * 「接口可用」的结论。2026-11-13 补齐：**电梯的编号从 V2 场景包里挖出来了**，
 * 见 `data/liftSn.ts`，于是 IOT 这一层现在真的有生产消费方（`api/lift.ts`）。
 *
 * ## 令牌会失效，而网关把它报成「权限不足」（2026-11-13 实测）
 *
 * 同一 ak 重复换 token 通常返回**同一个值**（服务端幂等），所以不存在「多客户端
 * 互相顶号」。但 token 会被轮换 —— 上午 10:15 换到的 `f3ab7b03…`，10:35 变成
 * `30b97c31…`，11:04 又变成 `0dfb9634…`；旧值此时不可用。
 *
 * 失效令牌的返回是 **HTTP 401 + `{"status":11,"msg":"权限不足"}`**（无令牌、空
 * 令牌、随机串三种情况实测一致）。这里有个坑：`status` 是 11 而不是 401，
 * 若按 status 透传，`iotAuthPost` 的「清令牌重换」分支（判 `code === 401`）
 * 永远命中不了 —— 一次 token 轮换就让整个会话卡住。
 * 所以 `iotJson` 把 401/11 统一规整成 `ApiError(401)`，让自愈分支生效。
 *
 * ## ⚠️ 但页面「全横杠」从来不是令牌的锅，是 CORS
 *
 * 上一版把「页面没数据」归因于令牌失效，**那是错的**。真正的原因是换令牌
 * 那个接口没有 CORS 配置，浏览器里连请求都发不出去 —— 详见 `IOT_TOKEN_BASE`。
 * 两者症状相似（都是拿不到数据），能区分它们的是**有没有「重新登录」提示**：
 * 真 401 会留下痕迹并弹提示；CORS 被拦只会得到 `ApiError(0)`，静默成「—」。
 *
 * 顺带纠正另一个误判：`status:11` 只表示**令牌无效**，不代表账号没权限。
 * 而 `status:10 所选设备您无权操作` 才是真的这台设备不归我们 ——
 * 4 个轿厢里 `32251222021` / `32251222023` 就是这种（单独查报 10、不拖累别台）。
 *
 * ## 两个容易踩的点（都是实测出来的）
 *
 * ① **productCode 不是项目码**。塔机/大屏那套用 `P000000076`（= `SCENE_CODE`），
 *    而电梯在网关里注册成另一个产品：`01724121a94f4893b693f253173d1082`
 *    （V2 `ElevatorIotModel` 的常量）。拿项目码查电梯会得到
 *    `status:10 部分产品数据您无权查看，非法的产品列表为：P000000076` ——
 *    看起来像「没权限」，其实只是查错了产品。
 * ② 在线状态是 **`"true"` / `"false"` 字符串**，走的是
 *    `queryRealTimeDataV2` + `field:"online"` + `code:"EVENT_ON_OFF"`。
 *    旧的 `toPoints()` 会把非数字收敛成 `null`，所以这里另给了保留原始字符串的
 *    读取入口（`fetchRealtimeRows`）。
 */

/** 项目级 ak / sk（原厂硬编码） */
const IOT_AK = 'MWHLJ9oqa34Z7xan9OPiw'
const IOT_SK = 'S0gThCxxgFeyFX1elZTje71Rnbb6hfZTut6UJSUw09M'

/** 云网关基址 */
const IOT_BASE = 'https://iot.cscec3b-iti.com'

/**
 * 换令牌的基址 —— 默认走**同源反代** `/iot-api`。
 *
 * 这个云网关的 CORS 配置是半拉子：数据接口 `/api/data/v1/tsdb/*` 正常
 * （预检 200、放行 `content-type` 与 `x-app-user`、响应回显 origin），
 * 但 `POST /api/webgateway/v1/access/token` **没进 CORS 过滤链** ——
 * 预检一律 403 且不回任何 `Access-Control-*` 头（2026-11-13 实测，
 * localhost / *.github.io / null 各种 Origin 全试过）。
 *
 * 浏览器发这个 POST 必带 `Content-Type: application/json` → 必触发预检 →
 * 预检 403 → 请求根本出不去，`fetch` 抛 TypeError。于是 `ensureToken()` 永远失败，
 * 所有 IOT 取数拿到 null，页面四格全「—」，而且**连「重新登录」提示都不出现**
 * （那个提示只认 401，这里连状态码都没有）。
 *
 * 这就是「curl / V2 都有数据、页面全横杠」的真正原因 —— 不是参数错、不是权限被收，
 * 是**浏览器跨源策略**。V2 是 Unity 客户端走原生 socket，不受此约束。
 *
 * 绕不过去的路（已逐一实测，别再试）：
 *   · `text/plain` / `x-www-form-urlencoded` 绕预检 → 服务端 415，该接口只吃 json
 *   · 换 Origin 求白名单 → 全部 403
 *   · `mode:'no-cors'` → 请求能发出但响应 opaque，读不到 token
 *
 * 所以只能反代：`npm run dev` / `preview` 见 `vite.config.ts` 的 `iotProxy()`，
 * `npm run deploy:http` 见 `server/serve.mjs` 的同名路由。
 * **GitHub Pages 纯静态没有这层**，那种部署下电梯数据拿不到 ——
 * 要改就指向一个可用反代（`VITE_IOT_TOKEN_BASE`）或请原厂补 CORS。
 */
const IOT_TOKEN_BASE =
  (import.meta.env.VITE_IOT_TOKEN_BASE as string | undefined)?.trim() || '/iot-api'

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

/**
 * 「网关把同一张令牌又发回来了」——
 *
 * 换令牌接口是幂等的：同一 ak 反复换通常返回同一张（实测连换 15 次值全相同）。
 * 所以「刚被判 401 的那张，重换之后一模一样」只有一种解释：网关侧还没轮换、
 * 还没恢复。这时再怎么打数据接口都是白打（4 台 × 3 个接口 = 12 次 401）。
 *
 * 单独成一个类型是为了让上层能把「网关没恢复」和「网络坏了」分开说 ——
 * 对用户是两句话，对日志也是两回事。
 */
export class IotStaleTokenError extends ApiError {
  constructor() {
    super(401, '物联网网关尚未轮换令牌')
    this.name = 'IotStaleTokenError'
  }
}

/** 实时数据查询项（V2 `DigitalMap.Elevator.QueryListItem`：`productCode / sn / field / code` 全 string） */
export interface RealtimeQueryItem {
  /**
   * 产品码，实测项目码 `P000000076`（= `SCENE_CODE`）。
   *
   * 电梯**不能**用它 —— 电梯在网关里注册成 `01724121a94f4893b693f253173d1082`。
   * 传空串时 `realtimeBody` 会回落到项目码（对塔机/大屏成立），这是本侧保留的
   * 便利；事件查询那侧已取消兜底（见 `EventQueryItem`）。
   */
  productCode: string
  /** 设备序列号（V2 原样透传，不 trim） */
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

/**
 * 事件查询项（2026-11 第三轮：按 V2 端 IL 修正；2026-11-26 按 DTO 收紧必填）。
 *
 * 老代码往 `eventItems` 里塞的是实时数据那套 `{productCode, sn, field, code}` ——
 * 与 `CraneWorkCycleRequester` 还原出来的 `{productCode, sn, eventCode}` 不符。
 * 事件是按**事件码**查的（如 `EVENT_WORKDATA`），没有 field/code 这两个键。
 *
 * 2026-11-26 用 `HotUpdateScripts.dll` 的元数据复核：`DigitalMap.Elevator.EventItems`
 * 三个属性就是 `ProductCode / Sn / EventCode`（全 string），`QueryEventRequest` 是
 * `startTime / endTime / eventItems`。V2 侧 `set_ProductCode` **恒被显式赋值**
 * （`ElevatorIotModel.ProductCode` = `01724121a94f4893b693f253173d1082`），
 * 从来不存在「缺省回落项目码」这条路。
 *
 * 所以这里 `productCode` 由可选改为**必填**，`eventBody` 也不再回落 `SCENE_CODE`：
 * 项目码只对塔机/大屏那套产品成立，用它查电梯换到的是
 * `status:10 所选设备您无权操作`（2026-11-26 实测），看起来像「没权限」，
 * 实际是**查错了产品** —— 静默兜底等于把配置错误伪装成设备故障。
 */
export interface EventQueryItem {
  /** 产品码，必须显式给：电梯 `01724121a94f4893b693f253173d1082` */
  productCode: string
  /** 设备序列号（V2：`BuildingElevatorCage.sn` 原样透传，不 trim、不改大小写） */
  sn: string
  /** 事件码，如 `EVENT_WORKDATA` */
  eventCode: string
}

/* ---------- 内部工具 ---------- */

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

async function iotFetch(path: string, init: RequestInit = {}, base = IOT_BASE): Promise<Response> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    return await fetch(`${base}${path}`, { ...init, signal: ctrl.signal })
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
 *
 * ## 错误码与 HTTP 码的组合（2026-11-26 逐条实测，别再猜）
 *
 * | HTTP | status | msg（原样） | 含义 |
 * |---|---|---|---|
 * | 200 | 0 | — | 成功 |
 * | **400** | 10 | `startTime:查询起始时间戳必传` / `eventItems:待查询事件列表不能为空` / `endTime大于0时，endTime 必须大于 startTime` | 参数不合法（多条用 `;` 拼接） |
 * | **400** | 10 | `所选设备您无权操作` | **sn 空/不认**，或 productCode 传错产品（不是权限被收） |
 * | **400** | 10 | `JSON parse error: Cannot deserialize value of type java.lang.Long …` | 时间传了字符串 |
 * | **401** | 11 | `权限不足` | 令牌无效（见下） |
 * | 200 | 2 | `Content-Type错误` | 只认 `application/json`，但**不回 4xx** |
 *
 * 也就是说：**业务失败也可能回 HTTP 400**，且 `status` 恒为 10 —— 单看状态码
 * 分不清「参数错」「设备不认」「产品错」，必须看 `msg`。反过来，看到 400
 * 基本可以排除反代/跨域（那种情况根本到不了这里，会是 `ApiError(0)`）。
 */
async function iotJson<T>(path: string, init: RequestInit = {}, base = IOT_BASE): Promise<T> {
  const res = await iotFetch(path, init, base)
  let body: Record<string, unknown> | null = null
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    throw new ApiError(res.status || 0, `物联网网关返回异常（HTTP ${res.status}）`)
  }
  const status = num(body?.status)
  // 令牌无效 = HTTP 401 + status 11「权限不足」。必须按 401 上报，
  // 否则 iotAuthPost 的自愈分支（判 code 401/403）永远不触发。
  if (res.status === 401 || status === 11) {
    throw new ApiError(401, str(body?.msg) || '物联网网关鉴权失败')
  }
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

/**
 * 令牌「代次」—— 用户每点一次「重试」就 +1（见 `clearToken`）。
 *
 * 解决的是「旧连接残留」：点重试的瞬间，上一轮可能还有一次换令牌请求在途。
 * 那个请求回来后会无条件 `token = next` 写回缓存，于是新一轮拿到的还是**旧令牌**
 * （甚至是被判 401 的那张），用户点了等于没点。
 *
 * 所以每张在途的换令牌请求都记下发起时的代次，回来时对不上就直接丢弃、不写回。
 * 与 `inflight` 的引用比较配合使用：旧请求结束时也不能把**新一轮**的
 * `inflight` 清掉。
 */
let generation = 0

/**
 * 上一次「重换之后仍然 401」的时刻 —— 冷却期内不再重换。
 *
 * V2 里有个 `LoginCooldownSeconds` 常量（`scan_str` 能在程序集里搜到），
 * 说明它对重新登录是**限频**的。这里必须照办，原因很实在：
 * 电梯一轮要发 12 个请求（3 个接口 × 4 台），令牌一旦失效它们会**同时** 401。
 * 若每个请求各自去换令牌，就是 12 次登录请求打到网关 —— 越点「重试」越回不来。
 *
 * 冷却期内直接按失败返回（页面照旧「—」+ 提示条），不再打扰网关。
 */
const TOKEN_RETRY_GAP = 60_000
let lastAuthFailAt = 0

/**
 * 上一次被判 401 的令牌值 —— 换回来若**原样**返回就说明网关还没恢复。
 *
 * `clearToken()` 刻意**不**清它：用户点「重试」走的正是那条路，清掉就等于
 * 放弃自检。只有在某张令牌真的把数据请求跑通之后才作废（见 `iotAuthPost`）。
 */
let rejectedValue = ''

/**
 * 换令牌这一跳**根本没发出去**（或没回音）的时刻。
 *
 * 与 401 是两件完全不同的事，之前把它们混成了一条「—」：
 *   · 401 / `status:11` → 网关说她认不出这张令牌，会自动重换，页面上有「重试」；
 *   · 请求没出门 → 反代缺失（nginx 没配 `/iot-api`）、域名不可达、服务器不出网。
 *     这种失败**永远不会自愈**，而且一条数据都拿不到。
 *
 * 典型现场情形：把 `dist/` 拷到自建 nginx 上，只配了静态文件规则 —— 浏览器
 * 请求 `/iot-api/...` 命中 nginx 的 404（或 SPA 回退吐回 index.html，JSON 解析
 * 失败），页面全横杠且没有任何提示，用户根本无从判断是「没数据」还是「没配好」。
 * 这里记一笔，让页面能把原因说出来。
 */
let tokenProbeFailAt = 0

/** 换令牌这一跳是否没打通（页面据此提示「反代/网络」而不是沉默的「—」） */
export function iotTokenUnreachable(): boolean {
  return tokenProbeFailAt > 0
}

/** 换令牌；单独导出是为了单测能直接断言请求体与响应解析 */
export async function requestToken(): Promise<IotToken> {
  const data = await iotJson<{
    tokenKey?: string
    tokenValue?: string
    expireTs?: number
  }>(
    '/api/webgateway/v1/access/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ak: IOT_AK, sk: IOT_SK }),
    },
    // 只有这一跳需要反代：该接口没有 CORS，详见 IOT_TOKEN_BASE 的注释
    IOT_TOKEN_BASE,
  )
  const tokenKey = str(data?.tokenKey)
  const tokenValue = str(data?.tokenValue)
  if (!tokenKey || !tokenValue) throw new ApiError(0, '物联网网关未返回令牌')
  const expireTs = num(data?.expireTs) ?? 3600
  return { tokenKey, tokenValue, expiresAt: Date.now() + expireTs * 1000 }
}

/**
 * 拿一个可用令牌，过期自动重换。
 *
 * 换到之后先做一道**自检**：若与刚被判 401 的那张逐字节相同，说明网关侧
 * 还没轮换，立刻按失败收手 —— 否则 12 个数据请求会带着同一张废令牌再撞一遍，
 * 用户每点一次「重试」就白打一轮。这是限频之外的第二道闸：`TOKEN_RETRY_GAP`
 * 防的是「自动自愈刷网关」，这里防的是「换了等于没换」。
 */
export async function ensureToken(): Promise<IotToken> {
  if (token && token.expiresAt > Date.now()) return token
  if (inflight) return inflight
  const gen = generation
  const run = (async () => {
    try {
      const next = await requestToken()
      /*
       * 这张令牌是**上一代**的产物（用户在等待期间点了「重试」）→ 整张丢弃。
       * 不写回 `token`、不清 `tokenProbeFailAt`：这一轮的结论已经不作数了，
       * 让新一代的请求自己说结果。
       */
      if (gen !== generation) throw new ApiError(0, '令牌请求已被新的重连取代')
      if (rejectedValue && next.tokenValue === rejectedValue) {
        lastAuthFailAt = Date.now()
        throw new IotStaleTokenError()
      }
      token = next
      tokenProbeFailAt = 0
      return next
    } catch (err) {
      // 只记「请求没打通」那一类：401 归 `authLost` 提示条，这里不抢话。
      // `IotStaleTokenError` 继承自 `ApiError(401)`，一并被排除。
      // 已被取代的那一代也不记 —— 否则会把上一轮的失败痕迹盖到新一轮上。
      if (gen === generation) {
        const credentialIssue = err instanceof ApiError && err.code === 401
        if (!credentialIssue) tokenProbeFailAt = Date.now()
      }
      throw err
    }
  })()
  inflight = run
  try {
    return await run
  } finally {
    // 只清自己那一份：被取代的旧请求结束时，`inflight` 可能已经是新一代的
    if (inflight === run) inflight = null
  }
}

/**
 * 丢掉旧令牌换一张新的；**并发调用共享同一次请求**。
 *
 * 注意这里**不能**先判「当前令牌还在有效期内就直接复用」—— 调用这个函数的
 * 前提就是「刚才那张被判了 401」，`expireTs` 写着 48 小时却提前失效是常态
 * （实测 11:04 签发的令牌 11:14 就不认了）。判有效期等于把坏令牌原样再交一次。
 *
 * 也不能写成 `clearToken(); ensureToken()`：并发 401 的每个请求都会清掉别人
 * 刚换到的新令牌，形成「换 → 清 → 再换」的抖动。
 */
async function refreshToken(): Promise<IotToken> {
  if (inflight) return inflight
  token = null
  return ensureToken()
}

/** 测试接线点：直接灌一个令牌，跳过换 token */
export function applyToken(t: IotToken | null): void {
  token = t
  lastAuthFailAt = 0
  rejectedValue = ''
  tokenProbeFailAt = 0
}

/**
 * 清令牌（用户点「重试」/ 强制重取时调用）。
 *
 * 顺带清掉自愈冷却 —— 这是**用户显式要重来**，应该立刻真的去换一次；
 * 自动自愈才受 `TOKEN_RETRY_GAP` 约束。也顺手清掉「没打通」的痕迹：
 * 这一下要是再失败，`ensureToken` 会重新记上，不必留着上一轮的旧结论。
 *
 * **还会作废在途的换令牌请求**（`generation += 1` + `inflight = null`）：
 * 用户已经重新发起连接，上一轮还在路上的那次换令牌不该再改写缓存 ——
 * 否则它回来时会写进一张旧令牌，新一轮 `ensureToken` 见「有令牌、没过期」
 * 就直接复用，页面上的表现就是「点了重试，还是那排横杠」。
 *
 * 这里清 `inflight` 不会引起「并发 401 各自换令牌」的抖动：本条路径只在
 * 用户显式重试时走一次，自动自愈走的是 `refreshToken`，两者互不影响。
 */
export function clearToken(): void {
  generation += 1
  token = null
  inflight = null
  lastAuthFailAt = 0
  tokenProbeFailAt = 0
}

/**
 * 放开「废牌自检」（**只在用户显式点「重试」时**调用）。
 *
 * `ensureToken` 有一道自检：换回来的令牌若与被判 401 的那张逐字节相同，就认定
 * 网关还没轮换，直接抛 `IotStaleTokenError` —— 好处是那一轮 6 个数据请求不会
 * 白打，坏处是现场看到的景象很怪：**点一次「重试」，Network 里只多了一条
 * `/access/token`**，在线 / 今日 / 工况一个都没发，页面自然「没有刷新」。
 *
 * 用户主动重来不该被自动自愈的节流拦住：清掉废牌记录后，这一轮会带着新令牌
 * 把三路真的打一遍，结果由它们自己说 —— 还是 401 就由 `authLost` 接住
 * （提示条与按钮保留），确实已轮换就正常刷新。
 *
 * 只清自检用的这两项，**不动** `token` / `inflight` / `generation`：那些归
 * `clearToken()` 管。两者职责分开，免得一次重试把在途请求作废两遍。
 */
export function releaseStaleGuard(): void {
  rejectedValue = ''
  lastAuthFailAt = 0
}

/** 带令牌的 POST（401 时自愈一次，失败进冷却） */
async function iotAuthPost<T>(path: string, body: unknown): Promise<T> {
  const send = (tk: IotToken): Promise<T> =>
    iotJson<T>(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        [tk.tokenKey]: tk.tokenValue,
      },
      body: JSON.stringify(body),
    })

  const t = await ensureToken()
  try {
    const ok = await send(t)
    // 这张令牌真的把数据跑通了 → 之前记的「废牌」作废
    rejectedValue = ''
    return ok
  } catch (err) {
    const is401 = err instanceof ApiError && (err.code === 401 || err.code === 403)
    if (!is401) throw err
    // 记下这张废牌：重换之后还是它，就说明网关没轮换（见 ensureToken 的自检）
    rejectedValue = t.tokenValue
    // 冷却中：刚换过还是 401，说明不是「令牌过期」这么简单，别再打了
    if (Date.now() - lastAuthFailAt < TOKEN_RETRY_GAP) throw err

    const t2 = await refreshToken()
    try {
      return await send(t2)
    } catch (e2) {
      if (e2 instanceof ApiError && (e2.code === 401 || e2.code === 403)) {
        lastAuthFailAt = Date.now()
      }
      throw e2
    }
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
  const list = usableSn(items)
  if (!list.length) return []
  const raw = await iotAuthPost<unknown>('/api/data/v1/tsdb/queryRealTimeDataV2', realtimeBody(list))
  return toPoints(raw)
}

/**
 * 按 V2 口径清洗查询项：**空 sn 丢掉、重复 sn 只留第一条**。
 *
 * 出处是 V2 `ElevatorModel.RebuildCageCache`（IL 实证，2026-11-26）：
 *
 * ```csharp
 * foreach (var cage in ...) {
 *     if (cage == null) continue;
 *     if (string.IsNullOrEmpty(cage.sn)) continue;   // ← 空编号不进字典
 *     if (cache.ContainsKey(cage.sn)) continue;     // ← 同号只留一台
 *     cache[cage.sn] = cage;
 * }
 * ```
 *
 * `GetSceneDeviceSnList()` 返回的就是这份字典的键集合，`ElevatorRequester` 再逐台发。
 * 注意它**只判空、不 Trim、不改大小写** —— 网关也照原样比对，`"3225122202 "`
 * 这种带空格的编号查不到设备，会回 `status:10 所选设备您无权操作`。
 * 所以这里同样不做任何「顺手清洗」，只把空值挡在门外：
 * 空 sn 发出去换回来的就是那句误导人的「无权操作」（2026-11-26 实测 400）。
 */
function usableSn<T extends { sn: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const i of items) {
    const sn = typeof i?.sn === 'string' ? i.sn : ''
    if (!sn || seen.has(sn)) continue
    seen.add(sn)
    out.push(i)
  }
  return out
}

/**
 * 事件查询项再紧一道：`productCode` 为空的也丢掉。
 *
 * V2 的 `EventItems.ProductCode` 恒有值，所以「空产品码」只会出现在我们自己的
 * 调用方写漏。发出去换回来的是 `status:10 所选设备您无权操作`（实测），
 * 与「设备没接入」完全同码同文案，事后根本分不清 —— 不如不发、直接空态。
 */
function usableEventItems(items: EventQueryItem[]): EventQueryItem[] {
  return usableSn(items).filter((i) => typeof i.productCode === 'string' && i.productCode.length > 0)
}

function realtimeBody(items: RealtimeQueryItem[]): unknown {
  return {
    queryList: items.map((i) => ({
      // 实时这侧仍有兜底：项目码对塔机/大屏成立（电梯必须显式传自己的产品码）
      productCode: i.productCode || SCENE_CODE,
      sn: i.sn,
      field: i.field,
      code: i.code,
    })),
  }
}

/**
 * 查询设备事件（告警 / 工作循环这类按事件码上报的数据）。
 *
 * 请求体 `{startTime, endTime, eventItems:[{productCode, sn, eventCode}]}` ——
 * 时间用 **Unix ms**（V2 端传的是 `date.Date` 与 `date.Date+1day-1ms` 的毫秒），
 * 兼容传 `'yyyy-MM-dd HH:mm:ss'` 字符串：本函数只负责透传，格式由调用方定。
 *
 * 每个查询项只发 `eventCode` —— 事件没有 field/code 两个维度（见 EventQueryItem）。
 */
export async function fetchEvents(
  items: EventQueryItem[],
  startTime: number | string,
  endTime: number | string,
): Promise<RealtimePoint[]> {
  const list = usableEventItems(items)
  if (!list.length) return []
  const raw = await iotAuthPost<unknown>('/api/data/v1/tsdb/queryEvent', eventBody(list, startTime, endTime))
  return toPoints(raw)
}

/**
 * 事件查询的**原始行** —— 保留 `resultMap`。
 *
 * `fetchEvents` 把每条事件压成 `{uuid, timestamp, metricIndex, value}`，而
 * `value` 对事件来说恒为 null（值在 `resultMap` 里）。电梯的今日运行时长
 * （`runStartTime` / `runEndTime`）与实时工况（`relFloor` / `height` /
 * `load` / `numberOfPeople`）**全部只在 resultMap 里**，所以必须走这个入口。
 */
export interface IotEventRow {
  timestamp: number | null
  /** `productCode~sn~eventCode`，用第二段把行分回设备 */
  metricIndex: string
  /** 事件载荷；服务端给 null 时保持 null（不伪造空对象） */
  resultMap: Record<string, unknown> | null
}

/** 实时数据查询的原始行 —— `value` 保持服务端原始类型（在线状态是 "true"/"false"） */
export interface IotRealtimeRow {
  timestamp: number | null
  metricIndex: string
  value: string
}

function eventBody(items: EventQueryItem[], startTime: number | string, endTime: number | string): unknown {
  return {
    startTime,
    endTime,
    eventItems: items.map((i) => ({
      // 不再回落 SCENE_CODE：V2 恒显式赋值，缺了就是配置错，别伪装成「设备无权」
      productCode: i.productCode,
      sn: i.sn,
      eventCode: i.eventCode,
    })),
  }
}

/** `metricIndex` → 空格分隔的第 2 段（sn）；解析不出来返回空串 */
export function snOfMetric(metricIndex: string): string {
  const parts = String(metricIndex ?? '').split('~')
  return parts.length >= 2 ? parts[1] : ''
}

/** 原始事件行收敛：没有 metricIndex 的行丢掉（分不回设备），resultMap 原样保留 */
export function toEventRows(raw: unknown): IotEventRow[] {
  const list = Array.isArray(raw) ? raw : []
  const out: IotEventRow[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const metricIndex = str(o.metricIndex)
    if (!metricIndex) continue
    const rm = o.resultMap
    out.push({
      timestamp: num(o.timestamp),
      metricIndex,
      resultMap: rm && typeof rm === 'object' ? (rm as Record<string, unknown>) : null,
    })
  }
  return out
}

/** 原始实时行收敛：同上，`value` 转字符串（`false` 不能被当空值丢掉） */
export function toRealtimeRows(raw: unknown): IotRealtimeRow[] {
  const list = Array.isArray(raw) ? raw : []
  const out: IotRealtimeRow[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const metricIndex = str(o.metricIndex)
    if (!metricIndex) continue
    if (o.value === undefined || o.value === null) continue
    out.push({ timestamp: num(o.timestamp), metricIndex, value: String(o.value) })
  }
  return out
}

/** 查询事件并保留 resultMap（电梯用） */
export async function fetchEventRows(
  items: EventQueryItem[],
  startTime: number | string,
  endTime: number | string,
): Promise<IotEventRow[]> {
  const list = usableEventItems(items)
  if (!list.length) return []
  const raw = await iotAuthPost<unknown>('/api/data/v1/tsdb/queryEvent', eventBody(list, startTime, endTime))
  return toEventRows(raw)
}

/** 查询实时数据并保留原始字符串（电梯在线状态用） */
export async function fetchRealtimeRows(items: RealtimeQueryItem[]): Promise<IotRealtimeRow[]> {
  const list = usableSn(items)
  if (!list.length) return []
  const raw = await iotAuthPost<unknown>('/api/data/v1/tsdb/queryRealTimeDataV2', realtimeBody(list))
  return toRealtimeRows(raw)
}
