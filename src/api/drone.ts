import { ApiError } from './http'

/**
 * 无人机平台（keehang，D 组）
 *
 * 这是本项目**唯一有真实无人机数据**的数据源：航线任务、执行记录、机载遥测、
 * 任务媒体文件全部来自这里。此前无人机页（UavPage）的电量 / 风速 / 今日任务
 * 全是写死的演示值（见 data/device.ts 的 uavLive / uavTodayTasks）。
 *
 * ## 鉴权：CAS 两步登录
 *
 * 与其它几组都不同：keehang 用 CAS（Central Authentication Service），
 * 一次登录拿两个票据，要跑两步才能得到真正的调用令牌：
 *
 *   ① POST https://account.keehang.com:23443/cas/auth/login
 *      body `{account, password}`（**字段名是 account 不是 username**）
 *      → `{ code:200, data:{ tgt, st, userDetail:{ uid, username } } }`
 *
 *   ② POST https://account.keehang.com:23443/cas/auth/validate
 *      body `{st}`
 *      → `{ code:200, data:{ uid, username, rid, token, timestamp } }`
 *
 * 之后所有业务请求带两个头：
 *   `KH-USER-ID: {uid}` 与 `KH-TOKEN: {token}`
 * （头名来自 Unity 端 `DroneAPIHelper` 的 `uidKey` / `tokenKey` 静态字段，
 *   资产文件写死成 "KH-USER-ID" / "KH-TOKEN"）
 *
 * `tgt` 是 CAS 会话票据，`st` 是短期票据 —— validate 用的就是 `st`，
 * 传 `tgt` 会返回「参数输入错误！」。这一点踩过一次：照着 CAS 的通用惯例
 * 先试 `{tgt}`，结果 400。
 *
 * ## 凭据
 *
 * 账号密码硬编码在 Unity 端 `DroneAPIHelper.cctor` 里（原厂方案如此），
 * 这里照搬以拿到数据。风险与 `api/open.ts` 的私钥一样：
 * 能防公开抓取，防不住逆向。
 *
 * ## 响应包
 *
 * keehang 用的是 `{code, msg, success, data}`，`code === 200` 为成功。
 * 失败时 `code` 可能是 400 / 400000 / 401 等，业务错误码不固定，
 * 所以这里一律按「非 200 即失败」处理，错误文案取 `msg`。
 */

/** 平台账号（原厂硬编码在 Unity 端 DroneAPIHelper.cctor） */
const KH_ACCOUNT = 'fanwbZJSJXYC'
const KH_PASSWORD = 'c7xt9Tyc45'

/** CAS 认证服务 */
const KH_AUTH_BASE = 'https://account.keehang.com:23443'
/** 业务服务 */
const KH_IOT_BASE = 'https://iot.keehang.com:23443'

/**
 * 项目 id（Unity 端 `DroneAPIHelper.Pid`，硬编码 int64）。
 *
 * 无人机平台是多项目共用的，不带 pid 会拿到平台上的全部项目
 * （实测 `/task/list` 不带过滤返回 4621 条，含「龙华樟坑径全景」等别的项目）。
 */
const KH_PROJECT_ID = 193640872670213

/** 无人机设备 id（`DroneAPIHelper.DroneDeviceId`） */
const KH_DRONE_DEVICE_ID = 23498
/** 机库设备 id（`DroneAPIHelper.DockDeviceId`） */
const KH_DOCK_DEVICE_ID = 23452

/** 单次请求超时（现场 4G 抖动时不要一直挂着 loading） */
const TIMEOUT = 12_000

/** 令牌有效期：validate 返回的 timestamp 是毫秒时间戳 */
const TOKEN_TTL = 30 * 60 * 1000

/* ---------- 类型 ---------- */

/** 一条航线任务的执行记录 */
export interface DroneTaskRecord {
  /** 执行记录 id（媒体文件接口按它取 job） */
  id: number
  /**
   * 服务端 uuid。
   *
   * **用做列表 key 的原因**：`id` 是 int64，部分行超过 JS 安全整数
   * （实测 `8093284258806579000`），`JSON.parse` 会丢精度、两条不同记录可能
   * 撞成同一个 id。uuid 是字符串，不会丢。
   */
  uuid: string
  /** 任务名，如「向阳村-安全巡检」 */
  taskName: string
  /** 航线 id */
  lineId: number
  /** 机库 id */
  dockId: number
  /** 开始时间，'YYYY-MM-DDTHH:mm:ss'（服务端原样是 ISO 串） */
  start: string
  /** 结束时间 */
  end: string
  /** 执行状态：服务端枚举，未知值统一按「未知」处理 */
  status: number
  /** 是否排班任务 */
  scheduled: boolean
}

/** 任务执行记录分页 */
export interface DroneTaskPage {
  rows: DroneTaskRecord[]
  total: number
}

/**
 * 今日任务统计（`GET /dashboard/task/list/record`）。
 *
 * 这是设计稿「任务管理」那三格的唯一来源，也是首页「今日作业次数」的来源。
 * 实测该接口**不吃 `start` / `end`**（传与不传返回值一样），算的始终是「今天」，
 * 所以别指望用它查历史 —— 历史走 `fetchTaskRecords({start,end})`。
 *
 * 2026-11-13 实测：`taskCount 15 = finishedCount 11 + planCount 4`，
 * `failedCount 0`、`runningCount 0`、`suspendedCount 0`。
 */
export interface DroneTaskStat {
  /** 今日任务总数（= 已完成 + 已完成之外的计划数） */
  taskCount: number
  /** 已完成架次 */
  finishedCount: number
  /** 失败架次 */
  failedCount: number
  /** 执行中 */
  runningCount: number
  /** 已计划但还没执行 */
  planCount: number
  /** 已暂停 */
  suspendedCount: number
}


/**
 * 无人机机载遥测（`/dashboard/device/cache/telemetry/{无人机id}/1`）。
 *
 * ## 2026-11-13 复核：字段比原先解析的多一倍
 *
 * 之前只解析了 9 个字段，把「风速 / 距机库 / 剩余续航 / 累计架次」全丢了，
 * 于是页面与文档都写成「这些指标没有数据源」。实测响应里它们都在 ——
 * 是**我们的解析漏了**，不是厂家没给。设计稿的设备参数八格因此全部有源。
 *
 * 顺带修正一个读错：相对高度在 `relativeAltitude`，`height` 是海拔
 * （机库与无人机同时刻都约 12.06，说明 `height` 是同一个绝对基准）。
 * 原先读 `altitude`（服务端没有这个键）退到 `height`，等于把海拔当成了
 * 相对高度 —— 地面停着也显示「12m」。
 */
export interface DroneTelemetry {
  /** 状态码（DJI `drone_status` 枚举；-1 = 飞控未上报，库里断电时就是这个值） */
  status: number | null
  /** 同一套枚举的另一个字段，`status` 不刷新时用它兜底 */
  modeCode: number | null
  lat: string
  lng: string
  /** 电池电量百分比 */
  battery: number | null
  /** 电池温度 ℃ */
  temp: number | null
  /** 水平速度 m/s */
  horizontalSpeed: number | null
  /** 垂直速度 m/s */
  verticalSpeed: number | null
  /** 相对起飞点高度 m（`relativeAltitude`；未起飞时为 0） */
  relativeAltitude: number | null
  /** 海拔 m（`height`） */
  height: number | null
  /** 距起飞点（≈ 机库）的水平距离 m（`homeDistance`） */
  homeDistance: number | null
  /** 风速 m/s（`windSpeed`） */
  windSpeed: number | null
  /** 预计剩余飞行时间 s（`batteryInfo.remainFlightTime`；在地面为 0） */
  remainFlightTime: number | null
  /** 累计飞行架次（`totalFlightSorties`） */
  totalSorties: number | null
  /** 航向角 */
  heading: number | null
}

/**
 * 机库遥测（`/dashboard/device/cache/telemetry/{机库id}/2`）。
 *
 * 第二个路径段是**设备类型**：1 = 无人机、2 = 机库。传 `1` 查机库只会拿到
 * 一堆 null（GPS / 电池 / 速度那套字段它没有），必须用 `2`。
 *
 * 风、雨、网络这三个「起飞条件」缺的指标全在这里 —— 也正因为它们在这里，
 * 起飞条件校验才能从「三项未知」变成真实判定。
 */
export interface DroneDock {
  status: number
  /** 舱门状态（枚举，原样保留） */
  hatchStatus: number | null
  /** 推杆状态 */
  putterState: number | null
  /** 无人机是否在库（`droneOnlineStatus`，1 = 在） */
  droneOnline: boolean | null
  /** 无人机在哪个位置（枚举：1 = 在库内） */
  droneLocation: number | null
  /** 无人机充电状态（枚举：0 = 未充电） */
  chargeState: number | null
  /** 舱内温度 ℃ */
  cabinTemp: number | null
  /** 环境温度 ℃ */
  envTemp: number | null
  /** 环境湿度 % */
  humidity: number | null
  /** 雨量（厂家原值，**口径未确认**，见 `stores/uav.ts` 的说明） */
  rainfall: number | null
  /** 风速 m/s */
  windSpeed: number | null
  /** 网络质量等级（厂家原值） */
  networkQuality: number | null
  /** 网络速率 kbps */
  networkRate: number | null
  /** 存储总量 / 已用（GB） */
  storageTotal: number | null
  storageUsed: number | null
  /** 是否告警 */
  alarmState: boolean | null
  lat: string
  lng: string
  height: number | null
}


/** 航线（任务下发的可选航线） */
export interface DroneRoute {
  id: number
  /** 航线任务 id（下发时用） */
  taskId: number
  /** 航线 id */
  lineId: number
  /** 航线任务名，如「向阳村-安全巡检」 */
  name: string
  /** 飞行高度（米）；服务端字段是 rth */
  height: number | null
  /** 是否正在执行 */
  running: boolean
}

/** 一个媒体文件（航拍照片 / 视频） */
export interface DroneMedia {
  /** 文件名，如 `DJI_20260715093839_0001_V.jpeg` */
  name: string
  /** OSS 直链（带签名，有有效期） */
  url: string
  /** MIME 类型 */
  mediaType: string
  /** 文件大小（字节） */
  size: number
  /** 上传/生成时间 */
  lastModified: string
}

/* ---------- 内部工具 ---------- */

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (v === undefined || v === null) return ''
  return String(v)
}

/** 带超时的 fetch；网络错统一收敛成 ApiError */
async function khFetch(path: string, init: RequestInit & { base?: string } = {}): Promise<Response> {
  const base = init.base ?? KH_IOT_BASE
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    return await fetch(`${base}${path}`, { ...init, signal: ctrl.signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, '无人机平台请求超时')
    }
    throw new ApiError(0, '无人机平台不可达')
  } finally {
    window.clearTimeout(timer)
  }
}

/** 解析 keehang 响应包；`code !== 200` 视为业务失败 */
async function khJson<T>(path: string, init: RequestInit & { base?: string } = {}): Promise<T> {
  const res = await khFetch(path, init)
  let body: Record<string, unknown> | null = null
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    throw new ApiError(res.status || 0, `无人机平台返回异常（HTTP ${res.status}）`)
  }
  const code = num(body?.code) ?? (res.ok ? 200 : res.status)
  if (!res.ok || code !== 200) {
    throw new ApiError(code, str(body?.msg) || `请求失败（HTTP ${res.status}）`)
  }
  return body.data as T
}

/* ---------- 令牌 ---------- */

/** 一次 CAS 登录后的会话 */
export interface KhSession {
  uid: string
  token: string
  /** 过期时刻（ms） */
  expiresAt: number
}

let session: KhSession | null = null
/** 并发登录去重：多个页面同时要令牌时只跑一次 CAS */
let inflight: Promise<KhSession> | null = null

/**
 * 跑完 CAS 两步，拿到业务令牌。
 *
 * 单独导出是为了单测能直接断言两步的请求体与头名，
 * 业务侧请用 `ensureSession()`。
 */
export async function casLogin(): Promise<KhSession> {
  const loginData = await khJson<{
    tgt: string
    st: string
    userDetail?: { uid?: number | string; username?: string }
  }>('/cas/auth/login', {
    base: KH_AUTH_BASE,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ account: KH_ACCOUNT, password: KH_PASSWORD }),
  })

  const st = str(loginData?.st)
  if (!st) throw new ApiError(0, '无人机平台登录未返回票据')

  // 第二步用 st 换真正的调用令牌（传 tgt 会 400）
  const validated = await khJson<{
    uid?: number | string
    token?: string
    timestamp?: number
  }>('/cas/auth/validate', {
    base: KH_AUTH_BASE,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ st }),
  })

  const uid = str(validated?.uid)
  const token = str(validated?.token)
  if (!uid || !token) throw new ApiError(0, '无人机平台校验未返回令牌')

  return { uid, token, expiresAt: Date.now() + TOKEN_TTL }
}

/**
 * 拿一个可用会话；过期或缺失时自动重登。
 *
 * 令牌在内存里缓存 —— keehang 的令牌是项目级服务凭据换来的，
 * 不落 localStorage（落盘等于把长期凭据留在浏览器里）。
 */
export async function ensureSession(): Promise<KhSession> {
  if (session && session.expiresAt > Date.now()) return session
  if (inflight) return inflight
  inflight = (async () => {
    try {
      session = await casLogin()
      return session
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 测试接线点：直接灌一个会话，跳过 CAS */
export function applySession(s: KhSession | null): void {
  session = s
}

/** 清会话（登出 / 换账号时调用） */
export function clearSession(): void {
  session = null
}

/** 带业务令牌的 GET */
async function khAuthGet<T>(path: string): Promise<T> {
  const s = await ensureSession()
  try {
    return await khJson<T>(path, {
      headers: {
        Accept: 'application/json',
        'KH-USER-ID': s.uid,
        'KH-TOKEN': s.token,
      },
    })
  } catch (err) {
    // 令牌失效：清一次再重登重试，避免用户每次进页面都卡在鉴权失败
    if (err instanceof ApiError && (err.code === 401 || err.code === 403)) {
      clearSession()
      const s2 = await ensureSession()
      return khJson<T>(path, {
        headers: {
          Accept: 'application/json',
          'KH-USER-ID': s2.uid,
          'KH-TOKEN': s2.token,
        },
      })
    }
    throw err
  }
}

/* ---------- 收敛 ---------- */

/** 把执行记录收敛成前端类型；缺关键字段的行直接丢 */
export function toTaskRecords(raw: unknown): DroneTaskRecord[] {
  const list = Array.isArray(raw) ? raw : []
  const out: DroneTaskRecord[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = num(o.id)
    const name = str(o.taskName)
    if (id === null || !name) continue
    out.push({
      id,
      uuid: str(o.uuid),
      taskName: name,
      lineId: num(o.lineId) ?? 0,
      dockId: num(o.dockId) ?? 0,
      start: str(o.start),
      end: str(o.end),
      status: num(o.status) ?? 0,
      scheduled: o.scheduled === true,
    })
  }
  return out
}

/** 把机载遥测收敛成前端类型；取不到的字段是 null（页面显示「—」，不写 0） */
export function toTelemetry(raw: unknown): DroneTelemetry {
  const o = (raw ?? {}) as Record<string, unknown>
  const batt = (o.batteryInfo ?? {}) as Record<string, unknown>
  const cells = Array.isArray(batt.batteries) ? (batt.batteries as Record<string, unknown>[]) : []
  const first = (cells[0] ?? {}) as Record<string, unknown>
  return {
    // 取不到就是 null，不拿 0（「待机」）冒充
    status: num(o.status),
    modeCode: num(o.modeCode),
    lat: str(o.lat),
    lng: str(o.lng),
    battery: num(batt.capacityPercent) ?? num(first.capacityPercent),
    temp: num(first.temperature),
    horizontalSpeed: num(o.horizontalSpeed),
    verticalSpeed: num(o.verticalSpeed),
    // 旧桩里写的是 altitude（服务端没有这个键），保留它作兜底，免得既有数据断供
    relativeAltitude: num(o.relativeAltitude) ?? num(o.altitude) ?? num(o.relativeHeight),
    height: num(o.height),
    homeDistance: num(o.homeDistance),
    windSpeed: num(o.windSpeed),
    remainFlightTime: num(batt.remainFlightTime),
    totalSorties: num(o.totalFlightSorties),
    heading: num(o.attitudeHead),
  }
}

/** 把机库遥测收敛成前端类型（同样是「取不到 → null」，不写 0） */
export function toDock(raw: unknown): DroneDock {
  const o = (raw ?? {}) as Record<string, unknown>
  const online = num(o.droneOnlineStatus)
  return {
    status: num(o.status) ?? 0,
    hatchStatus: num(o.hatchStatus),
    putterState: num(o.putterState),
    droneOnline: online === null ? null : online === 1,
    droneLocation: num(o.droneLocation),
    chargeState: num(o.droneChargeState),
    cabinTemp: num(o.cabinTemperature),
    envTemp: num(o.environmentTemperature),
    humidity: num(o.humidity),
    rainfall: num(o.rainfall),
    windSpeed: num(o.windSpeed),
    networkQuality: num(o.networkQuality),
    networkRate: num(o.networkRate),
    storageTotal: num(o.storageTotal),
    storageUsed: num(o.storageUsed),
    alarmState: typeof o.alarmState === 'boolean' ? o.alarmState : null,
    lat: str(o.latitude),
    lng: str(o.longitude),
    height: num(o.height),
  }
}

/** 今日任务统计的收敛（字段缺就是 0 —— 这几个都是「今天几条」，0 是有效结论） */
export function toTaskStat(raw: unknown): DroneTaskStat {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    taskCount: num(o.taskCount) ?? 0,
    finishedCount: num(o.finishedCount) ?? 0,
    failedCount: num(o.failedCount) ?? 0,
    runningCount: num(o.runningCount) ?? 0,
    planCount: num(o.planCount) ?? 0,
    suspendedCount: num(o.suspendedCount) ?? 0,
  }
}


/* ---------- 业务接口 ---------- */

/**
 * 任务的执行记录（本项目的）。
 *
 * ## 必须带 `start` / `end`，否则拿到的是**最旧**的记录
 *
 * 不带日期时服务端按**开始时间升序**返回，实测 `page=1&size=8` 回来的是
 * 2026-07-14 那几条 —— 拿它当「今天的任务」过滤，结果永远是 0 条。
 * `start` / `end` 是 `YYYY-MM-DD`，**`end` 不含当天**（查今天要传明天）。
 *
 * ## `size` 不生效
 *
 * 实测 `size=20` 仍返回该区间全部记录（11 月整月 424 条、今天 30 条）。
 * 所以别用它做分页，也别一次拉太大的区间（手机流量）。
 */
export async function fetchTaskRecords(
  opts: { page?: number; size?: number; pid?: number; start?: string; end?: string } = {},
): Promise<DroneTaskPage> {
  const { page = 1, size = 50, pid = KH_PROJECT_ID, start, end } = opts
  let q = `?page=${page}&size=${size}&pid=${pid}`
  if (start) q += `&start=${start}`
  if (end) q += `&end=${end}`
  const raw = await khAuthGet<unknown>(`/task/exec/list/record${q}`)
  const rows = toTaskRecords(raw)
  return { rows, total: rows.length }
}

/**
 * 今日任务统计（三格：今日任务 / 已完成 / 失败次数）。
 *
 * 这个接口**只算今天**（传 start/end 也被忽略），历史统计没有对应端点 ——
 * 设计稿那三格本来也是「今日」。
 */
export async function fetchTaskStat(opts: { pid?: number } = {}): Promise<DroneTaskStat> {
  const { pid = KH_PROJECT_ID } = opts
  const raw = await khAuthGet<Record<string, unknown>>(`/dashboard/task/list/record?pid=${pid}`)
  // 缺 `taskCount` 说明拿到的不是统计（比如被别的网关拦了返回一个空信封）。
  // 抛出去比「当 0 条」安全：0 会被读成「今天一架次都没飞」。
  if (!raw || typeof raw !== 'object' || !('taskCount' in raw)) {
    throw new ApiError(0, '无人机任务统计返回异常')
  }
  return toTaskStat(raw)
}


/**
 * 无人机机载遥测（电量 / 温度 / 速度 / 位置 / 风 / 距机库）。
 *
 * 实测：设备 id 23498 返回电量 68%、电池温度 26.4℃、风速 0、距起飞点 0.05m。
 * 第二个路径段是「设备类型」，原厂用 1（无人机）/ 2（机库）。
 */
export async function fetchTelemetry(deviceId: number = KH_DRONE_DEVICE_ID): Promise<DroneTelemetry> {
  const raw = await khAuthGet<unknown>(`/dashboard/device/cache/telemetry/${deviceId}/1`)
  return toTelemetry(raw)
}

/**
 * 机库遥测（舱门 / 充电 / 舱温 / 湿度 / 雨量 / 风速 / 网络）。
 *
 * 类型段必须是 **2**：用 1 查机库只会拿到一屏 null。
 */
export async function fetchDockTelemetry(deviceId: number = KH_DOCK_DEVICE_ID): Promise<DroneDock> {
  const raw = await khAuthGet<unknown>(`/dashboard/device/cache/telemetry/${deviceId}/2`)
  return toDock(raw)
}

/**
 * 航线任务清单（本项目的）。
 *
 * 请求：`GET /task/list?recycle=0&deviceId={机库id}&pid={项目id}`
 *
 * 响应是 `{data:{total, list:[{task:{...}, device:{...}}]}}`，
 * 航线信息在**内层**的 `task` 对象里（外层还有设备信息）。
 *
 * 实测本项目 15 条真实航线（向阳村-全景 / 安全巡检 / 塔吊定点 …），
 * `rth` 是飞行高度（实测 117~120 米）。
 *
 * ⚠️ 不带 `pid` 过滤会拿到平台**全部项目**的航线（实测数千条，含别的项目），
 * 所以 pid 必须带。
 */
export async function fetchRoutes(
  opts: { pid?: number; dockId?: number } = {},
): Promise<DroneRoute[]> {
  const { pid = KH_PROJECT_ID, dockId = KH_DOCK_DEVICE_ID } = opts
  const q = `?recycle=0&deviceId=${dockId}&pid=${pid}`
  const raw = await khAuthGet<{ list?: unknown[] }>(`/task/list${q}`)
  const list = Array.isArray(raw?.list) ? raw.list : []
  const out: DroneRoute[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    // 航线信息在内层 task 上；外层是设备
    const t = (o.task ?? o) as Record<string, unknown>
    const id = num(t.id)
    const name = str(t.name)
    if (id === null || !name) continue
    out.push({
      id: id,
      taskId: id,
      lineId: num(t.lineId) ?? 0,
      name,
      height: num(t.rth),
      running: t.running === true,
    })
  }
  return out
}

/**
 * 任务媒体文件（航拍照片 / 视频）的 job 列表。
 *
 * 路径是 `{iotUrl}/media/task/job/{jobId}` —— jobId 是**执行记录 id**
 * （`/task/exec/list/record` 返回的那一行的 `id`），不是 taskId。
 * 实测传对 jobId 会返回数组（该任务暂无媒体时是空数组）；
 * 传错 id 是 404，页面据此给「该任务暂无媒体文件」。
 *
 * 返回的 `url` 是 OSS 签名直链（`X-Amz-Expires` 有限，实测 7200 秒），
 * 所以不能长期缓存 —— 过期后再取媒体要重新拉一遍拿新签名。
 */
export async function fetchMediaJobs(jobId: number): Promise<DroneMedia[]> {
  const raw = await khAuthGet<unknown>(`/media/task/job/${jobId}`)
  if (!Array.isArray(raw)) return []
  const out: DroneMedia[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const url = str(o.url)
    const name = str(o.name)
    if (!url || !name) continue
    out.push({
      name,
      url,
      mediaType: str(o.mediaType),
      size: num(o.size) ?? 0,
      lastModified: str(o.lastModified),
    })
  }
  return out
}

/**
 * 一路直播流（无人机 / 机库摄像头）。
 *
 * **这是 V2 里那套「实时监控」画面的真实来源**（2026-11-13 打通）。
 * V2 走的也是这条路：keehang 自建的 ZLMediaKit 流媒体服务器分发，
 * 只是桌面端用 mediamtx/VLC 二次转协议，浏览器端直接吃 HTTP-FLV。
 *
 * 关键事实（都实测过，不是推断）：
 *
 * · 接口 `GET /live/stream/list?deviceId=23498` 直接回**播放地址**，
 *   1197 组全量有 1.5MB，按 deviceId 过滤只有 1.2KB —— 必须带参数。
 * · 流地址**不需要 token**，也不带签名，`Access-Control-Allow-Origin: *`，
 *   浏览器可直接连；证书是 `*.keehang.com` 的正式 DV 证书（无需忽略校验）。
 * · `type: 'flv'` + `protocol: 'https'` 是浏览器唯一能直接播的形态；
 *   `rtsp` / `rtmp` 浏览器不支持，`http` 版本在 HTTPS 站点会被混合内容拦掉。
 * · `online` 是**当前是否在推流**：无人机飞行中为 true；机库摄像头在库待机时
 *   为 false（此时地址还在，但连上去没有画面），页面据此说「未推流」而不是干等。
 */
export interface DroneLiveStream {
  /** 流 id（`/live/stream/list` 的 `streams[].id`） */
  id: number
  /** 流名（实测「中建三局-向阳村项目无人机2」） */
  name: string
  /** 服务端是否在推流 */
  online: boolean
  /** 浏览器可直连的 HTTPS-FLV 地址 */
  flv: string | null
  /** wss 版 FLV（WebSocket 承载，预留） */
  wsFlv: string | null
  /** RTSP（浏览器放不了，留给原厂工具 / 服务端转协议） */
  rtsp: string | null
}

/**
 * 把 `/live/stream/list` 的响应收敛成一路流。
 *
 * 响应形状是 `[{deviceId, streams:[{id,name,online,playStreams:[{type,protocol,url}]}]}]`。
 * 一个设备有多路流时取排序最靠前的那路（本项目无人机 / 机库各只有一路）。
 */
export function toLiveStream(raw: unknown): DroneLiveStream | null {
  const groups = Array.isArray(raw) ? raw : []
  for (const g of groups) {
    const streams = (g as Record<string, unknown>)?.streams
    if (!Array.isArray(streams)) continue
    for (const s of streams) {
      const o = s as Record<string, unknown>
      const id = num(o.id)
      const plays = Array.isArray(o.playStreams) ? o.playStreams : []
      let flv: string | null = null
      let wsFlv: string | null = null
      let rtsp: string | null = null
      for (const p of plays) {
        const q = p as Record<string, unknown>
        const type = str(q.type)
        const proto = str(q.protocol)
        const url = str(q.url)
        if (!url) continue
        if (type === 'flv' && proto === 'https') flv = flv ?? url
        else if (type === 'flv' && proto === 'wss') wsFlv = wsFlv ?? url
        else if (type === 'rtsp') rtsp = rtsp ?? url
      }
      if (id === null || (!flv && !wsFlv)) continue
      return { id, name: str(o.name), online: o.online === true, flv, wsFlv, rtsp }
    }
  }
  return null
}

/**
 * 取某台设备的直播流。
 *
 * `deviceId` 用 `KH_IDS.droneDeviceId` / `KH_IDS.dockDeviceId`。
 * 设备没有配流（或接口失败）→ `null`，页面写「未开播」，不拿别处的图冒充。
 */
export async function fetchLiveStream(deviceId: number): Promise<DroneLiveStream | null> {
  const raw = await khAuthGet<unknown>(`/live/stream/list?deviceId=${deviceId}`)
  return toLiveStream(raw)
}

/** 本项目的 pid / 设备 id（页面要显示项目归属时用） */
export const KH_IDS = {
  pid: KH_PROJECT_ID,
  droneDeviceId: KH_DRONE_DEVICE_ID,
  dockDeviceId: KH_DOCK_DEVICE_ID,
} as const
