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
  /**
   * 任务（排班项）id。同一条航线的每次执行都是同一个 `taskId`、不同 `id`。
   *
   * 进度条的「预计时长」要按它分组算历史实测中位数 —— 用 `id` 分不了组
   * （每次执行 id 都不一样），用 `taskName` 分组会在改名后断档。
   */
  taskId: number | null
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
  /**
   * 所属项目 id。
   *
   * 2026-11-16 起「今日任务」按账号口径取（三格 23 = 向阳村 15 + 光谷元著 8），
   * 列表里会同时出现别的项目的记录，页面靠它区分「这条是不是本项目的」
   * （`当前巡检` 只认本项目 —— 实时遥测是向阳村那台机库的）。
   */
  pid: number | null
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
  /** 当前距起飞点（≈ 机库）的水平距离 m（`homeDistance`） */
  homeDistance: number | null
  /**
   * **累计飞行里程** m（`totalFlightDistance`）—— V2 详情面板「飞行距离」那一行。
   *
   * 别与 `homeDistance` 混用：两者名字像、语义完全不同，量级差 7~8 个数量级。
   * 2026-11-13 实测同一时刻：`totalFlightDistance` 10809054.8（≈10809km，这台机
   * 累计飞了三千多架次），`homeDistance` 0.0136（飞机正停在机库里）。
   * 早先页面那格叫「距起飞点」但用户按 V2 心智读成「飞行距离」，
   * 看到 162m 会以为里程丢了 —— 现在改回 V2 的口径与本字段。
   */
  totalFlightDistance: number | null
  /** 风速 m/s（`windSpeed`） */
  windSpeed: number | null
  /** 预计剩余飞行时间 s（`batteryInfo.remainFlightTime`；在地面为 0） */
  remainFlightTime: number | null
  /** 累计飞行架次（`totalFlightSorties`） */
  totalSorties: number | null
  /**
   * **偏航角** °（`attitudeHead`）—— V2 详情面板「无人机偏航角」那一行。
   *
   * 取值原样保留，**不做 0~360 归一化**：DJI 的 `attitude_head` 是 −180~180，
   * 负值（如实测 −151，朝西北偏西）本身就是合法航向，V2 也是原样打出来的。
   * 归一化会变成 209°，同一方向两个数字，跟 V2 并排一看就对不上。
   */
  heading: number | null
  /** **翻滚角** °（`attitudeRoll`）—— V2 详情面板「无人机翻滚角」那一行 */
  attitudeRoll: number | null
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
  /**
   * 缩略图直链（`oss.keehang.com:19090/thumbnail/iot/...`）。
   *
   * 实测单张 **约 440KB**，原图 6MB —— 列表里用它可以真的把照片显示出来，
   * 而不只是一个「点击查看原图」的灰块（2026-11-16 实测全部有值）。
   * 缺字段时是空串，页面回退到文字占位。
   */
  thumbnail: string
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
  // 项目清单跟着账号走：登出/换账号后必须重取，否则会把上一个账号的项目 id 带进来
  resetProjectIds()
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
      taskId: num(o.taskId),
      lineId: num(o.lineId) ?? 0,
      dockId: num(o.dockId) ?? 0,
      start: str(o.start),
      end: str(o.end),
      status: num(o.status) ?? 0,
      scheduled: o.scheduled === true,
      pid: num(o.pid),
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
    totalFlightDistance: num(o.totalFlightDistance),
    windSpeed: num(o.windSpeed),
    remainFlightTime: num(batt.remainFlightTime),
    totalSorties: num(o.totalFlightSorties),
    heading: num(o.attitudeHead),
    attitudeRoll: num(o.attitudeRoll),
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
 * 账号下所有有设备的项目 id。
 *
 * ## 为什么要它
 *
 * 「今日任务」三格（`fetchTaskStat` 不传 `pid`）算的是**整个账号**，
 * 所以明细也必须跨项目取，否则 23 与列表条数对不上（见 `fetchTodayRecords`）。
 * 而 `/task/exec/list/record` **必须带 pid**，只能先拿到项目清单再逐个取。
 *
 * ## 来源
 *
 * `GET /dashboard/device/list?page=1&size=100` —— 这是唯一一个**不传 pid**
 * 就能列出账号全部设备的端点，顺带就列出了全部项目。实测该账号 5 台设备 / 2 个项目：
 * 向阳村 `193640872670213`（无人机 2 + 机库 1）、光谷元著 `231070463906821`（各 1）。
 *
 * 本项目永远排第一位；请求失败只回本项目 —— 少列一个项目顶多少几条明细，
 * 编一个 pid 会拉回别人的数据。
 */
let projectIdsCache: number[] | null = null

/** 清掉项目清单缓存（登出时调；换账号后项目集可能不同） */
export function resetProjectIds(): void {
  projectIdsCache = null
}

export async function fetchProjectIds(): Promise<number[]> {
  if (projectIdsCache) return projectIdsCache
  const own = [KH_PROJECT_ID]
  try {
    const raw = await khAuthGet<unknown>('/dashboard/device/list?page=1&size=100')
    const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
    const ids: number[] = []
    for (const row of list) {
      const dev = (row?.deviceInfo ?? row) as Record<string, unknown> | undefined
      const pid = num(dev?.pid)
      if (pid !== null && !ids.includes(pid)) ids.push(pid)
    }
    // 本项目排第一：合并后同一时刻起飞的两条能稳定排在本项目之后
    const merged = [...own, ...ids.filter((id) => id !== KH_PROJECT_ID)]
    projectIdsCache = merged
    return merged
  } catch {
    return own
  }
}

/**
 * 「今日任务」明细 —— **账号口径，与三格同源**。
 *
 * ## 为什么不是一次请求
 *
 * `/task/exec/list/record` 不带 `pid` 实测返回 **0 条**（2026-11-16 09:57），
 * 所以账号口径只能「先取项目清单，再逐个取，最后合并」。
 *
 * ## 与三格的关系（2026-11-16 逐条核对）
 *
 * | 项目 | 今日执行记录 |
 * |---|---|
 * | 向阳村 | 15 |
 * | 光谷元著 | 8 |
 * | **合计** | **23** = `/dashboard/task/list/record` 的 `taskCount` |
 *
 * 也就是说三格那个 23 逐条摊开，就是这张清单。用户 2026-11-16 要求
 * 「今日任务把 23 条都放开」，指的就是让明细跟三格对齐。
 *
 * ## 失败策略
 *
 * 逐项目 `allSettled`：某个项目挂了仍返回其它项目的记录（宁可少列，整页不塌）；
 * **全部失败才抛**，让页面写「加载失败」而不是「今日暂无任务」。
 *
 * 注意 `end` 不含当天（查今天要传明天）；服务端会把明天的排班一起返回，
 * 调用方按 `start` 的日期再滤一次（store 的 `todayRecords` 负责）。
 */
export async function fetchTodayRecords(
  opts: { start: string; end: string; pids?: number[] },
): Promise<DroneTaskRecord[]> {
  const ids = opts.pids?.length ? opts.pids : await fetchProjectIds()
  const pages = await Promise.allSettled(
    ids.map((pid) => fetchTaskRecords({ pid, size: 200, start: opts.start, end: opts.end })),
  )
  const rows: DroneTaskRecord[] = []
  let ok = 0
  let firstError: unknown = null
  for (const p of pages) {
    if (p.status !== 'fulfilled') {
      firstError ??= p.reason
      continue
    }
    ok++
    rows.push(...p.value.rows)
  }
  if (ok === 0) {
    // 把服务端原文往上抛（页面直接显示它），比统一文案更好定位
    throw firstError instanceof Error ? firstError : new ApiError(0, '无人机任务列表加载失败')
  }
  // 按 uuid 去重（不同项目不会撞，防的是同一项目跨页重复取到）
  const seen = new Set<string>()
  return rows.filter((r) => {
    const key = r.uuid || String(r.id)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 今日任务统计（三格：今日任务 / 已完成 / 失败次数）。
 *
 * 这个接口**只算今天**（传 start/end 也被忽略），历史统计没有对应端点 ——
 * 设计稿那三格本来也是「今日」。
 *
 * ## 口径：**默认不传 `pid`，与 V2 完全一致**（2026-11-16 用户要求）
 *
 * 实测同一时刻对同一端点取两次（2026-11-16 09:45）：
 *
 * | 请求 | taskCount | 列表里出现的 pid |
 * |---|---|---|
 * | `?pid=193640872670213` | **15** | 只有向阳村 |
 * | 不传 `pid` | **23** | 向阳村 ×7 + **光谷元著 ×3** |
 *
 * 也就是说 23 = 15（向阳村）+ 8（同账号下的光谷元著项目）。V2 取这一格时没带
 * 项目过滤，拿到的是**该账号下所有项目**的今日任务数；向阳村现场那台 V2 的无人机
 * 同样连 keehang（进程实测只连 `110.41.50.115:23443` 与本项目同一个网关），
 * 所以它显示的 23 正是这个未过滤的值。
 *
 * 用户 2026-11-16 明确要求「V2 咋获取的我就咋获取，先不管是不是向阳村」，
 * 因此这里**默认复刻 V2 的无 pid 口径**。要回到只算本项目，传 `{ pid }` 即可
 * （`KH_PROJECT_ID`），不必改这里。
 *
 * 注意 `fetchTaskRecords`（今日明细列表）**必须带 `pid`**：不带会返回 0 条
 * （实测 2026-11-16）。账号口径的明细走 `fetchTodayRecords` —— 它先取项目清单
 * 再逐个 pid 取，合并后的条数与这里的 `taskCount` 一致（23 = 15 + 8）。
 */
export async function fetchTaskStat(opts: { pid?: number } = {}): Promise<DroneTaskStat> {
  // 不传 pid 就是 V2 的口径；显式给了才过滤
  const q = opts.pid ? `?pid=${opts.pid}` : ''
  const raw = await khAuthGet<Record<string, unknown>>(`/dashboard/task/list/record${q}`)
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
      thumbnail: str(o.thumbnail),
      mediaType: str(o.mediaType),
      size: num(o.size) ?? 0,
      lastModified: str(o.lastModified),
    })
  }
  return out
}

/* ---------- 站点（航拍照片：V2「任务记录」里的站点名称，2026-11-19） ---------- */

/**
 * 一个「站点」。
 *
 * V2 的任务记录列表每行都写「站点名称：向阳村安全巡检」，但记录行本身
 * **没有** `spotName` 之类的字段（2026-11-19 实测记录只有
 * `id / uuid / taskId / taskName / start / end / status / pid / dockId`），
 * 界面上那个站点名就是这条航线去掉分隔符的展示。所以这里以 `taskName`
 * 作为站点标识：**一条航线 = 一个采集站点**，去重后就是下拉框的选项。
 */
export interface DroneStation {
  /** 站点名（= 任务/航线名，如「向阳村-全局定点拍照」） */
  name: string
  /** 任务 id（同一条航线每次执行都一样） */
  taskId: number | null
  /** 最近一次已开始的执行时间（站点排序、也是「最新记录」的起点） */
  lastStart: string
  /** 窗口内执行了几个架次 */
  runs: number
}

/**
 * 站点下拉里**不展示**的航线名（2026-11-19 现场确认，两批）。
 *
 * 下拉的语义是「**拍照站点**」——一条航线一个站点，选它看这一班的照片。
 * 下面这些航线要么不是拍照任务，要么是重复建图/联调产物，摆进来只会让人选错：
 *
 *   · `测试` / `测试全景` —— 联调时建的临时航线，没有业务含义；
 *   · `向阳村-三维（新）` / `向阳村-三维（加密）` —— 同一片区的**重复建图**航线，
 *     并排出现在下拉里，现场很容易选到没数据的那条；
 *   · `向阳村-安全巡检` —— 内部巡检航线（11 分钟一圈走一圈），产出是巡检记录，
 *     不是「站点照片」；且与「向阳村-全局定点拍照」的区域大量重叠；
 *   · `向阳村-环绕视频` —— 视频航线，媒体是 `video/*`，本来就没有照片可看。
 *
 * 只作用于下拉选项（{@link toStations}），**不拦数据**：真有人按名字直接查
 * （`loadStation`）、或者巡检模块按航线名取媒体，都照旧能取到。
 * 比较前去掉所有空白、半角括号归到全角，避免接口里多一个空格就漏掉。
 */
const HIDDEN_STATIONS = [
  '向阳村-三维（新）',
  '向阳村-三维（加密）',
  '向阳村-安全巡检',
  '向阳村-环绕视频',
  '测试',
  '测试全景',
]

/** 归一化后判断这条航线是否要从下拉里隐藏（半角括号也归到全角，免得漏匹配） */
function isHiddenStation(name: string): boolean {
  const n = name
    .replace(/\s+/g, '')
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
  return HIDDEN_STATIONS.includes(n)
}

/**
 * 把执行记录收敛成站点清单（按最近一次执行时间倒序）。
 *
 * 只做「分组 + 去重 + 排序」，不碰网络 —— 窗口与过滤在 `fetchRecentRecords`；
 * 展示层的剔除见 {@link HIDDEN_STATIONS}。
 */
export function toStations(rows: DroneTaskRecord[]): DroneStation[] {
  const map = new Map<string, DroneStation>()
  for (const r of rows) {
    const name = r.taskName.trim()
    if (!name) continue
    if (isHiddenStation(name)) continue
    const cur = map.get(name)
    if (!cur) {
      map.set(name, { name, taskId: r.taskId, lastStart: r.start, runs: 1 })
    } else {
      cur.runs += 1
      if (r.start > cur.lastStart) {
        cur.lastStart = r.start
        cur.taskId = r.taskId ?? cur.taskId
      }
    }
  }
  return [...map.values()].sort((a, b) => b.lastStart.localeCompare(a.lastStart))
}

/**
 * 航拍历史窗口（天）。
 *
 * 两个地方必须用同一个值，否则会出现「日期能选、站点却没有」这种半截状态：
 *   · 站点清单从这个长度的任务记录里取（下拉里才有上个月飞过的站点）；
 *   · 日期控件的下界 = 今天往前这么多天（`stores/airHazard.ts` 的 `airMinDate`）。
 */
export const STATION_WINDOW_DAYS = 90

/**
 * 取航拍历史窗口内的执行记录 —— 站点名称下拉框的数据源。
 *
 * 口径与 V2 任务记录一致：本项目 pid、按日期区间、**只留已开始的班次**
 * （记录里混着明天/后天的排班，`status` 还是 -1，没有媒体）。
 *
 * 2026-11-19：窗口从「30 天没有就退到 180 天」改成**固定**
 * {@link STATION_WINDOW_DAYS} 天 —— 日期控件恢复后要能选更早的日子，
 * 站点清单必须覆盖同一段区间。停飞一段时间的站点仍在列表里，
 * 不会因为「最近 30 天没飞」就从下拉里消失。
 *
 * 注意 `size` 不生效（见 `fetchTaskRecords`），一次会把整段区间拉回来；
 * 90 天实测约一千余条，会话内还缓存 5 分钟，可以接受。
 */
export async function fetchRecentRecords(): Promise<DroneTaskRecord[]> {
  const now = spotNow()
  const page = await fetchTaskRecords({
    page: 1,
    size: 200,
    start: spotDay(1 - STATION_WINDOW_DAYS),
    end: spotDay(1),
  })
  return page.rows
    .filter((r) => !r.start || r.start <= now)
    .sort((a, b) => b.start.localeCompare(a.start))
}

/** 每换一个站点，最多探几班媒体（每班一次请求，keehang 有限流） */
const STATION_PROBE = 4
/** 媒体被限流时的等待（服务端提示 2 秒，与 `stores/patrol.ts` 一致） */
const STATION_THROTTLE_WAIT = 2_200
const STATION_THROTTLE_CODE = 42901

/** 取一班的媒体；被限流（42901）等 2 秒重试一次，其余失败返回 null */
async function stationMedia(jobId: number): Promise<DroneMedia[] | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchMediaJobs(jobId)
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 0
      if (code === STATION_THROTTLE_CODE && attempt === 0) {
        await new Promise((r) => setTimeout(r, STATION_THROTTLE_WAIT))
        continue
      }
      return null
    }
  }
}

/**
 * 某站点**最新一次采集**的全部照片（含采集顺序）。
 *
 * 「最新一次」= 该站点 `status === 2` 且已开始的班次里，按 `start` 倒序
 * **第一个有图片媒体**的那班 —— 实测存在「已完成但 0 条媒体」的班次
 * （2026-11-18 08:20 那班），直接取最新一条会显示空白，所以往下找。
 *
 * 返回**全部** `image/*`（不再截 9 张）：用户要求「该站点最新记录中的所有
 * 采集照片」，全局定点拍照那班正好 9 张，正射那种上百张也照给，列表靠
 * 懒加载顶住。每班混着的 1 个 `.DAT` 飞行日志不算照片。
 *
 * 返回 null = 这个站点近期确实没有照片。
 */
export async function fetchLatestGalleryOf(
  taskName: string,
  rows: DroneTaskRecord[],
): Promise<DroneSpotGallery | null> {
  const now = spotNow()
  const jobs = rows
    .filter((r) => r.taskName.trim() === taskName)
    .filter((r) => r.status === 2 && (!r.start || r.start <= now))
    .sort((a, b) => b.start.localeCompare(a.start))

  return probeGallery(jobs)
}

/**
 * 某站点在**指定日期**的采集（航拍照片恢复日期控件之后的数据源）。
 *
 * 不开窗口、也不翻页：服务端 `start` / `end` 是 `YYYY-MM-DD` 且 `end` 不含当天，
 * 直接传「这一天 + 次日」就只回这一天的记录（`size` 不生效，正好一次拿全）。
 * 因此历史任意一天都能查，与 `recordings` 那份 90 天窗口互不影响。
 *
 * 口径与「最新一次」一致：只认 `status === 2` 且已开始的班次，按 `start`
 * 倒序挑第一个**有图片媒体**的 — 同一天飞了两班时给的是后一班。
 *
 * 返回 null = 这一天该站点没有照片（页面据此给空态，不拿别的日期凑）。
 */
export async function fetchStationDay(
  taskName: string,
  day: string,
): Promise<DroneSpotGallery | null> {
  const name = taskName.trim()
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const page = await fetchTaskRecords({ page: 1, size: 200, start: day, end: nextDayKey(day) })
  const now = spotNow()
  const jobs = page.rows
    .filter((r) => r.taskName.trim() === name)
    .filter((r) => r.status === 2 && (!r.start || r.start <= now))
    .filter((r) => (r.start || '').slice(0, 10) === day)
    .sort((a, b) => b.start.localeCompare(a.start))

  return probeGallery(jobs)
}

/** 在给定的班次里按新→旧探媒体，返回第一个有图片的班 */
async function probeGallery(jobs: DroneTaskRecord[]): Promise<DroneSpotGallery | null> {
  for (const job of jobs.slice(0, STATION_PROBE)) {
    const media = await stationMedia(job.id)
    if (!media) continue
    const imgs = media
      .filter((m) => m.mediaType.startsWith('image/'))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (!imgs.length) continue
    return { jobId: job.id, start: job.start, taskId: job.taskId, taskName: job.taskName, media: imgs }
  }
  return null
}

/** 'YYYY-MM-DD' → 次日（服务端 `end` 不含当天） */
function nextDayKey(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  d.setDate(d.getDate() + 1)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------- 某个站点最新一班的全景（重建成果，V2「采集数据 → 全景图片」） ---------- */

/**
 * 重建成果索引：`recordId` → 该次飞行最新的一条全景。
 *
 * V2 的「采集数据 → 全景图片(3)」就是按**执行记录**取这一批成果；但接口
 * `/dashboard/recreate/getProjectRecreateInfo` **不支持按 recordId 过滤**
 * （2026-11-19 实测：带 `recordId` / `recordIds` / `id` 参数返回值一模一样，
 * `taskType` 也一样被忽略），只能按时间倒序翻页自己挑。
 *
 * 所以这里做一个会话级索引：翻过的页缓存下来（同一批成果不重复下），
 * 每条 PANO 成果按它所属任务的 `recordId` 落表。翻页到「比目标记录更早」
 * 就停，不会为了一个没有全景的站点把几十页翻完。
 */
const panoIndex = new Map<number, DronePano>()
/** 已翻到第几页（0 = 还没翻过） */
let panoPages = 0
/** 已翻到的最旧一条成果的 createTime（越往后越旧） */
let panoOldest = ''
/** 索引建立时刻（重建成果会不断新增，过期就重来） */
let panoIndexAt = 0
const PANO_INDEX_TTL = 5 * 60 * 1000

/** 把一页成果里属于本项目的 PANO 成果登记进索引（同一 recordId 只留最新） */
function indexPanoPage(raw: unknown): void {
  const list = Array.isArray((raw as { list?: unknown })?.list)
    ? ((raw as { list: unknown[] }).list as unknown[])
    : []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (num(o.taskType) !== RECREATE_TASK_PANO) continue
    if (num(o.status) !== RECREATE_STATUS_DONE) continue
    if (num(o.projectId) !== KH_PROJECT_ID) continue

    const recordId = num(o.recordId)
    if (recordId === null || panoIndex.has(recordId)) continue
    const rows = Array.isArray(o.resultRecordDTOList) ? (o.resultRecordDTOList as unknown[]) : []
    const first = rows
      .map(toAchievement)
      .filter((a): a is DroneAchievement => a !== null && a.recreateType === 'PANO')
      .sort((a, b) => a.name.localeCompare(b.name))[0]
    if (!first) continue
    panoIndex.set(recordId, {
      id: first.id,
      secret: first.secret,
      recordId,
      projectId: num(o.projectId) ?? 0,
      projectName: str(o.projectName),
      taskName: str(o.taskName) || str(o.lineName),
      name: first.name,
      time: str(o.endTime) || str(o.updateTime) || str(o.createTime),
      preview: first.thumbnail || first.download,
      full: first.download || first.thumbnail,
      size: first.size,
    })
  }
}

/**
 * 在这批执行记录里找**最新一张全景图**。
 *
 * 用途：航拍照片选中站点后，如果该站点有全景成果，就把它排到照片列表首位
 * （球面环视）。`recordIds` 传该站点的全部记录 id，按新→旧找，
 * 命中的第一张就是「最新」—— 因为索引本身按 `createTime` 倒序建立。
 *
 * `since` 是停止翻页的下界（一般是该站点最新一次采集的时间减几天）：
 * 成果列表比它更旧了就没必要再翻 —— 新一班的全景最快也要十几分钟才拼完，
 * 留几天余量正好覆盖「今天刚飞、全景还在拼」这种情况，能退到上一班的成果。
 */
export async function fetchRecordPano(recordIds: number[], since = ''): Promise<DronePano | null> {
  const hit = (): DronePano | null => {
    for (const id of recordIds) {
      const p = panoIndex.get(id)
      if (p) return p
    }
    return null
  }

  if (Date.now() - panoIndexAt > PANO_INDEX_TTL) {
    panoIndex.clear()
    panoPages = 0
    panoOldest = ''
  }

  let found = hit()
  while (!found) {
    // 已经翻到比目标记录更早：这条航线的成果在更早的页里也不会有
    if (since && panoOldest && panoOldest < since) break
    if (panoPages >= PANO_MAX_PAGE) break

    const page = panoPages + 1
    let raw: unknown
    try {
      raw = await khAuthGet<unknown>(
        `/dashboard/recreate/getProjectRecreateInfo?pid=${KH_PROJECT_ID}&pageNo=${page}&size=${PANO_PAGE_SIZE}`,
      )
    } catch {
      // 翻页失败按「翻到底」处理：已有索引还能用，别把整块照片墙拖挂
      break
    }
    panoPages = page
    panoIndexAt = Date.now()
    indexPanoPage(raw)
    found = hit()
    if (found) break
    const rows = (raw as { list?: unknown[] })?.list
    if (!Array.isArray(rows) || !rows.length) break
    panoOldest = str((rows[rows.length - 1] as Record<string, unknown>)?.createTime)
    if (rows.length < PANO_PAGE_SIZE) break
  }
  return found
}

/** 清掉全景索引（登出 / 换账号时；成果是按项目取的，换账号后要重取） */
export function resetPanoIndex(): void {
  panoIndex.clear()
  panoPages = 0
  panoOldest = ''
  panoIndexAt = 0
}

/* ---------- 「全局定点拍照」最新九张（V2 任务记录 → 采集数据 同一条链） ---------- */

/**
 * 现场那条定时拍照航线的**全名**。
 *
 * V2 的「任务记录 → 选中一条 → 采集数据 → 采集图片」就是这条航线的一次执行
 * （2026-11-17 15:30 那班，界面写着「巡检时长 5 分钟 / 采集图片 9」）。
 * 名字要完全对上：`/task/exec/list/record` 里同一时段还有「分区定点拍照」，
 * 用 includes('定点拍照') 会把两条混在一起。
 */
export const SPOT_TASK_NAME = '向阳村-全局定点拍照'

/** 这组照片固定取多少张（V2 采集图片一栏就是 9 张） */
export const SPOT_LIMIT = 9

/**
 * 回溯窗口（天），与照片墙同一套策略：先近 30 天，没有相片再退到 180 天。
 * 现场每天两班，30 天足够；退一次是为了停飞一段时间后进来仍能看到最后一批。
 */
const SPOT_WINDOWS = [30, 180] as const

/** 一条「定点拍照」航线的执行结果（照片 + 来自哪一班） */
export interface DroneSpotGallery {
  /** 执行记录 id（媒体就是按它取的） */
  jobId: number
  /** 该班次的开始时间 */
  start: string
  /** 任务 id（同一条航线每次执行都一样） */
  taskId: number | null
  /** 任务名 */
  taskName: string
  /** 图片媒体，按文件名（拍摄先后）升序；挑几张由调用方决定（9 张 / 第 1、2、37 张 / 第 2、7 张） */
  media: DroneMedia[]
}

/** 本地 `YYYY-MM-DD`，offset 为天 */
function spotDay(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地当前时刻，格式与记录里的 `start` 一致（`YYYY-MM-DDTHH:mm:ss`） */
function spotNow(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 取某条「定点拍照」航线**最近一班有照片的飞行**的全部图片（两条航线共用）。
 *
 * 「全景航拍」（`fetchSpotGallery`）、「材料堆场」（`fetchYardGallery`）与
 * 「设备设施」（`fetchFacilityGallery`）都走这里，差别只在"从这一班里挑哪几张"。
 * 这样几个模块的**数据源、过滤与排序规则**天然一致，不会一处改了另一处忘 ——
 * 用户明确要求「不要另建不一致的逻辑」。
 *
 * 规则（与 V2「任务记录 → 采集数据 → 采集图片」同一条链）：
 *   · 任务名 **完全相等**；
 *   · 只要 `status === 2` 且 `start <= now`（记录里混着未来排班）；
 *   · 按 `start` 倒序，跳过媒体为空的那班（实测有 `status=2` 但 0 条媒体的班）；
 *   · 只留 `image/*`（每班混着 1 个 `.DAT` 飞行日志）；
 *   · 按文件名升序 = DJI 拍摄序号。
 *
 * 返回 `null` = 近期确实没有照片；抛错 = 两个窗口都请求失败（页面要写"取不到"）。
 */
async function latestTaskMedia(taskName: string): Promise<DroneSpotGallery | null> {
  const now = spotNow()
  let firstErr: unknown = null
  let okWindows = 0

  for (const days of SPOT_WINDOWS) {
    let rows: DroneTaskRecord[]
    try {
      rows = (await fetchTaskRecords({ page: 1, size: 100, start: spotDay(-days), end: spotDay(1) })).rows
      okWindows += 1
    } catch (e) {
      firstErr ??= e
      continue
    }

    const jobs = rows
      .filter((r) => r.taskName.trim() === taskName)
      .filter((r) => r.status === 2 && (!r.start || r.start <= now))
      .sort((a, b) => b.start.localeCompare(a.start))

    for (const job of jobs) {
      let media: DroneMedia[]
      try {
        media = await fetchMediaJobs(job.id)
      } catch {
        // 某一班取不到（限流 / 404）不该让整组照片消失，继续往下一班找
        continue
      }
      const imgs = media.filter((m) => m.mediaType.startsWith('image/'))
      if (!imgs.length) continue
      imgs.sort((a, b) => a.name.localeCompare(b.name))
      return { jobId: job.id, start: job.start, taskId: job.taskId, taskName: job.taskName, media: imgs }
    }
  }

  // 两个窗口都请求失败 ≠ 没有照片，得让页面写「加载失败」而不是「暂无」
  if (!okWindows && firstErr) throw firstErr instanceof Error ? firstErr : new ApiError(0, `${taskName}加载失败`)
  return null
}

/**
 * 取「全局定点拍照」**最近一班有照片的飞行**里的最新 9 张图。
 *
 * ## 这条链是怎么来的（对齐 V2，不是另起一套）
 *
 * V2 的任务记录页拿的就是同两个接口：
 *   `GET /task/exec/list/record`（本项目 pid + 日期区间）→ 该航线的一班班执行
 *   `GET /media/task/job/{执行记录id}` → 这一班的采集文件
 *
 * 所以这里一条都不新造，只把「哪一班、哪些文件、什么顺序」按 V2 的口径钉死：
 *
 *   · **只认 `taskName === 向阳村-全局定点拍照`**，不是按关键词模糊匹配；
 *   · **只要已完成（`status === 2`）且已过开始时刻**的班次 —— 记录里混着未来
 *     排班（11-19 那些 `status: -1`），它们没有媒体，取到就是空白；
 *   · 按 `start` **倒序**从最近一班往下找，**跳过媒体为空的那班**
 *     （实测 11-18 08:20 那班 `status=2` 但媒体 0 条，直接取它会显示空）；
 *   · 媒体里**只留 `image/*`**：每班都混着 1 个 `.DAT` 飞行日志，
 *     V2 的「采集图片 9」= 9 张 JPEG，日志不算图片；
 *   · 按**文件名升序** = DJI 的拍摄序号（`_0001_V` → `_0009_V`），
 *     与 V2 那排缩略图从左到右的顺序一致；多于 9 张时取**最后 9 张**
 *     （最新拍的），再按升序排。
 *
 * 返回 `null` 表示「这条航线近期确实没有照片」—— 页面给空态，不拿别的航线顶。
 */
export async function fetchSpotGallery(limit = SPOT_LIMIT): Promise<DroneSpotGallery | null> {
  const g = await latestTaskMedia(SPOT_TASK_NAME)
  if (!g) return null
  return { ...g, media: g.media.slice(-Math.max(1, limit)) }
}

/* ---------- 「分区定点拍照」固定三张（材料堆场，2026-11-18） ---------- */

/**
 * 材料堆场那条航线的**全名**（与 SPOT 一样要完全相等，不能用关键词）。
 *
 * 现场同时有「全局定点拍照」和「分区定点拍照」两条定时航线，`includes('定点拍照')`
 * 会把两条混在一起，取到哪条全靠运气。
 */
export const YARD_TASK_NAME = '向阳村-分区定点拍照'

/**
 * 材料堆场固定取哪几张（**1 基**，按拍摄顺序 = 文件名升序）。
 *
 * 用户按 V2「任务记录 → 向阳村-分区定点拍照 → 采集数据 → 采集照片(41)」那张网格
 * 逐格点出来的：第 1、第 2 张和**第 37 张**是材料堆场那几堆料，其余 38 张是别处。
 * 所以这里写死序号，不做任何"看起来像堆场"的画面猜测。
 */
export const YARD_PICKS = [1, 2, 37] as const

/**
 * 按 **1 基序号**从一班的图片里挑几张（不足序号就少给，不凑数）。
 *
 * 「材料堆场」与「设备设施」共用：两条链只在"挑哪几个位置"上不同，
 * 取数（窗口 / 任务名全等 / 已完成 / 已开始 / 跳过空媒体 / 文件名升序）
 * 全在 `latestTaskMedia` 里，别各写一份。
 */
function pickByIndex(g: DroneSpotGallery, picks: readonly number[]): DroneSpotGallery {
  const picked = picks.map((n) => g.media[n - 1]).filter((m): m is DroneMedia => Boolean(m))
  return { ...g, media: picked }
}

/**
 * 取「分区定点拍照」**最近一班有照片的飞行**里的第 1、2、37 张。
 *
 * 走的是和 `fetchSpotGallery` **同一条**取数链（`latestTaskMedia`：同一套窗口、
 * 同一套任务名全等 + 已完成 + 已开始 + 跳过空媒体的规则、同一套文件名升序），
 * 只有"从这班里挑哪几张"不一样 —— 那边取末尾 9 张，这边按序号点三个位置。
 *
 * 班次照片数不足 37 张时**只返回存在的那几张**（不拿最后一张凑数，也不跨班补）：
 * 凑出来的第 3 张不是用户指的那张，宁可少一张。
 */
export async function fetchYardGallery(): Promise<DroneSpotGallery | null> {
  const g = await latestTaskMedia(YARD_TASK_NAME)
  return g ? pickByIndex(g, YARD_PICKS) : null
}

/* ---------- 「塔吊定点」固定两张（设备设施，2026-11-18） ---------- */

/**
 * 设备设施那条航线的**全名**（与 SPOT / YARD 同规矩：完全相等，不用关键词）。
 *
 * 现场同时有「巡检」「安全巡检」「塔吊定点」「分区定点拍照」几条，用 `includes`
 * 会串台。V2 的任务记录里它就是一条独立航线（2026-11-17 14:15 那班采集 16 张）。
 */
export const FACILITY_TASK_NAME = '向阳村-塔吊定点'

/**
 * 设备设施固定取哪几张（**1 基**，按拍摄顺序 = 文件名升序）。
 *
 * 用户按 V2「任务记录 → 向阳村-塔吊定点 → 采集数据 → 采集照片(16)」那张网格
 * 逐格点出来的：**第 2 张和第 7 张**才是设备设施那几台塔吊，其余是别处。
 *
 * ## 另外两张（本轮不做）
 *
 * 「视频监控-塔吊-2#塔吊」「视频监控-塔吊-4#塔吊」各自最新的一张也是这一格的
 * 来源，但监控侧目前**没有照片查询接口**（keehang 那套只有无人机媒体，
 * 塔吊监控走的是 tciccs，只有实时流 / 抓拍报警），用户 2026-11-18 明确
 * 「本轮先保持现状，不做该接口接入」。所以这一格现在稳定是 **2 张**；
 * 等接口通了再加一条链拼进来，`PatrolPanel` 那边不用改。
 */
export const FACILITY_PICKS = [2, 7] as const

/**
 * 取「塔吊定点」**最近一班有照片的飞行**里的第 2、第 7 张。
 *
 * 与 `fetchYardGallery` 同一套（共用 `latestTaskMedia` + `pickByIndex`），
 * 差别只有航线名与序号；不足 7 张时只给存在的那几张。
 */
export async function fetchFacilityGallery(): Promise<DroneSpotGallery | null> {
  const g = await latestTaskMedia(FACILITY_TASK_NAME)
  return g ? pickByIndex(g, FACILITY_PICKS) : null
}

/* ---------- 「安全巡查」：两条航线各取一张（2026-11-18） ---------- */

/**
 * 「土方1」的**全名**（安全巡查的第一张来源，同时 `probe` 用它跳过整班照片）。
 *
 * 名字带数字 1，不能写成 `向阳村-土方`：现场还有「土方2 / 土方3」时，
 * 模糊匹配会把几片开挖区混成一条。
 */
export const SAFETY_SOIL_TASK_NAME = '向阳村-土方1'

/**
 * 安全巡查那 2 张的来源。**不是一条航线**，所以这里是一张来源表，
 * 每项 = 一条航线 + 该班取第几张（1 基，按拍摄顺序）。
 *
 * 用户对着 V2 的两张截图点出来的：
 *   · 「向阳村-土方1」2026-11-17 17:00 那班（采集 50 张）→ 第 **1** 张；
 *   · 「向阳村-分区定点拍照」2026-11-17 12:30 那班（采集 41 张）→ 第 **34** 张。
 *
 * 顺序就是表里的顺序（土方1 在前）：页面两张卡片按这个顺序铺。
 * 第二条复用的就是「材料堆场」那条航线（`YARD_TASK_NAME`），只是取的张不同。
 */
export const SAFETY_SOURCES = [
  { taskName: SAFETY_SOIL_TASK_NAME, pick: 1 },
  { taskName: YARD_TASK_NAME, pick: 34 },
] as const

/**
 * 取「安全巡查」那 2 张：每条航线各取**最近一班有照片的飞行**里指定的那一张。
 *
 * 与 `fetchYardGallery` / `fetchFacilityGallery` 同一套（`latestTaskMedia` +
 * `pickByIndex`），只是这里跨**两条**航线：所以返回的是一个数组（每个有图
 * 的来源一项），而不是单条 `DroneSpotGallery` —— 两班的 `jobId / taskName`
 * 不同，合成一条会让卡片标题和弹层 id 都错。
 *
 * 逐条**串行**取（每条一次列表 + 一次媒体）：并行会在同一秒打两个媒体请求，
 * keehang 那侧直接 42901。
 *
 * 容错：一条挂了不影响另一条（只少一张）；两条都挂才抛错，页面才写「取不到」。
 */
export async function fetchSafetyGallery(): Promise<DroneSpotGallery[]> {
  const out: DroneSpotGallery[] = []
  let firstErr: unknown = null

  for (const s of SAFETY_SOURCES) {
    try {
      const g = await latestTaskMedia(s.taskName)
      const picked = g ? pickByIndex(g, [s.pick]) : null
      if (picked?.media.length) out.push(picked)
    } catch (e) {
      firstErr ??= e
    }
  }

  if (!out.length && firstErr) {
    throw firstErr instanceof Error ? firstErr : new ApiError(0, '安全巡查加载失败')
  }
  return out
}

/* ---------- 项目全景（重建成果，V2「控制 → 成果」同一条链） ---------- */

/**
 * 一条重建成果（`achievementList` / `resultRecordDTOList` 的元素）。
 *
 * ⚠️ 这是**拼接好的成果**，不是原始拍摄件，和 `DroneMedia` 是两套东西：
 * 媒体接口（`/media/task/job/{id}`）给的是无人机上传的原片，一次全景飞行
 * 26 张 4032×3024 的碎片；成果接口给的是服务端拼好的等距圆柱图。
 *
 * 三种成果靠 `recreateType` 区分：`PANO` 全景 / `MODEL` 三维 / 正射是 tif。
 */
export interface DroneAchievement {
  /** 成果 id（与 `secret` 一起换签名直链：`POST /share/recreate/fileUrl/{id}/{secret}`） */
  id: number
  /** 成果密钥（服务端签直链用） */
  secret: string
  /** 文件名（全景是 `…_0.jpg`，下划线后是该次飞行的第几个全景点） */
  name: string
  /** 成果体积（字节） */
  size: number
  /** 全景：立方体切片清单 `pano.json`（V2 的 `#/pano` 用 PSV 读它） */
  url: string
  /** 全景：**3162×1581 等距圆柱预览图**（约 185KB，OSS 缩略图桶） */
  thumbnail: string
  /** 全景：**10000×5000 等距圆柱原图**（`origin.jpg`，约 13MB，moss 域名） */
  download: string
  /** `PANO` / `MODEL` / … */
  recreateType: string
}

/**
 * 一个「项目全景」点。
 *
 * 平台已经把 26 张碎片拼好了，本项目的智眸面板**只放这一张**（用户要求）。
 * 预览与原图都是 2:1 等距圆柱投影，`ui/PanoViewer.vue` 直接贴上球面。
 */
export interface DronePano {
  /** 成果 id（不是执行记录 id） */
  id: number
  /** 成果密钥 */
  secret: string
  /** 执行记录 id（同一次飞行的原片 id） */
  recordId: number
  /** 所属项目 id（与 `KH_PROJECT_ID` 同源，见 `pickLatestPano` 的守卫） */
  projectId: number
  /** 所属项目名（实测「中建三局-向阳村项目」） */
  projectName: string
  /** 航线名（现场「向阳村-全景_202611151130181616」） */
  taskName: string
  /** 成果文件名（`…_0.jpg`，存盘时用） */
  name: string
  /**
   * 成果**拼接完成**时间 `YYYY-MM-DD HH:mm:ss`（任务的 `endTime`）。
   *
   * ⚠️ 不是 `createTime`：那是「重建开始」的时刻（11-17 本次 11:58:40），
   * 跑完要几分钟（12:07:30）。V2 列表（`#/control` 的重建成果）显示的是完成
   * 时刻，这里跟它对齐 —— 同一张图在两处文案一致，别让人误以为取到了旧图。
   */
  time: string
  /** 预览图（等距圆柱，约 185KB）—— 首屏 / 列表卡片都用它 */
  preview: string
  /** 原图（等距圆柱，约 13MB）—— 点「看高清」才拉 */
  full: string
  /** 原图体积（字节） */
  size: number
}

/** `taskType`：1=三维 2=全景 3=正射 */
const RECREATE_TASK_PANO = 2
/** `status`：2=已完成 */
const RECREATE_STATUS_DONE = 2

/**
 * 每页条数。
 *
 * 平台**不支持按类型过滤**（`taskType` / `status` 传了被忽略，实测返回还是最新的
 * 正射），所以只能按时间倒序翻页再自己挑。现场节奏是「正射 → 三维 → 正射 → 全景」
 * 循环，全景大约每 4 条出现一次；30 条一页既够命中，响应也只有 80KB
 * （100 条是 270KB —— 每条都内嵌成果直链，很占）。
 */
const PANO_PAGE_SIZE = 30
/** 最多翻几页（够不着就认「最近没有全景」） */
const PANO_MAX_PAGE = 4

/** 把一条成果收敛成前端类型；缺直链的行丢掉（没有图就没有意义） */
function toAchievement(raw: unknown): DroneAchievement | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = num(o.id)
  if (id === null) return null
  const thumbnail = str(o.thumbnail)
  const download = str(o.download)
  if (!thumbnail && !download) return null
  return {
    id,
    secret: str(o.secret),
    name: str(o.name),
    size: num(o.size) ?? 0,
    url: str(o.url),
    thumbnail,
    download,
    recreateType: str(o.recreateType),
  }
}

/**
 * 从重建任务列表里挑出最新的一条全景。
 *
 * 优先取 `taskType === 2 && status === 2`（已完成的全景），按 `createTime` 倒序；
 * 一条成果都没有（只有 pano.json、没有等距圆柱图）就接着往下挑，不硬顶第一条。
 *
 * 注意两个时间不是一回事：`createTime` 是**重建开始**（11-17 那次 11:58:40），
 * `endTime` 是**拼接完成**（12:07:30）。排序用 `createTime`（和服务端列表一致），
 * 展示的 `time` 用 `endTime`（和 V2 列表一致，见 `DronePano.time`）。
 *
 * 一次飞行会产出**多个**全景点（向阳村实测 3 个、光谷元著 5 个），按名字排序
 * 取第一个 —— 用户要求（2026-11-16）「只存最新的一张」，对应 V2 截图里那张
 * `向阳村-全景_202611151130181616_0.jpg`（13.05MB）。
 *
 * ⚠️ `projectId` 是**客户端守卫**，不是多余的一道：这个接口的 `pid` 传了不一定
 * 被服务端采纳（`taskType` / `status` 就是传了被忽略的实测例子），一旦漏了，
 * 返回的会是全平台最新 —— 光谷元著 11-15 13:29 比向阳村 11-15 12:10 晚一小时，
 * 「项目全景」里就会静默变成另一个工地。宁可没有，也不能张冠李戴。
 */
export function pickLatestPano(raw: unknown, projectId?: number): DronePano | null {
  const list = Array.isArray((raw as { list?: unknown })?.list)
    ? ((raw as { list: unknown[] }).list as unknown[])
    : []
  const tasks: Record<string, unknown>[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (num(o.taskType) !== RECREATE_TASK_PANO) continue
    if (num(o.status) !== RECREATE_STATUS_DONE) continue
    if (projectId !== undefined && num(o.projectId) !== projectId) continue
    tasks.push(o)
  }
  tasks.sort((a, b) => str(b.createTime).localeCompare(str(a.createTime)))

  for (const t of tasks) {
    const rows = Array.isArray(t.resultRecordDTOList) ? (t.resultRecordDTOList as unknown[]) : []
    const panos = rows
      .map(toAchievement)
      .filter((a): a is DroneAchievement => a !== null && a.recreateType === 'PANO')
      .sort((a, b) => a.name.localeCompare(b.name))
    const first = panos[0]
    if (!first) continue
    return {
      id: first.id,
      secret: first.secret,
      recordId: num(t.recordId) ?? 0,
      projectId: num(t.projectId) ?? 0,
      projectName: str(t.projectName),
      taskName: str(t.taskName) || str(t.lineName),
      name: first.name,
      // 完成时刻优先，缺了才退 updateTime / createTime（老记录可能没 endTime）
      time: str(t.endTime) || str(t.updateTime) || str(t.createTime),
      preview: first.thumbnail || first.download,
      full: first.download || first.thumbnail,
      size: first.size,
    }
  }
  return null
}

/**
 * 取本项目最近一个「项目全景」点（拼接成果）。
 *
 * 数据链与 V2 的「控制 → 成果预览」一致（V2 的 `getProjectRecreateInfo` 也是
 * `{pid, pageNo}` 一起传）：
 *   `GET /dashboard/recreate/getProjectRecreateInfo?pid=&pageNo=&size=`
 *   → 每行内嵌 `resultRecordDTOList`（含 `thumbnail` / `download` 签名直链）
 *
 * **按项目筛**（`pid` + 本地 `projectId` 双保险，见 `pickLatestPano`）：光谷元著
 * 11-15 13:29 那张虽然更新，但那是另一个工地，不能顶到向阳村的「项目全景」里。
 *
 * **不需要再调 `recordInfo`** —— 列表里已经把成果直链带回来了（实测）。
 * 直链是 OSS 预签名，`X-Amz-Expires=7200`（2 小时），所以不能长期缓存，
 * 每次进页面重取一遍拿新签名。
 *
 * 两种「没有」要分开：**真没有全景**返回 null；**接口挂了**抛错（第一页就失败
 * 才抛，翻页失败当翻到底）。调用方据此区分「暂无全景」和「取不到，可重试」。
 */
export async function fetchLatestPano(): Promise<DronePano | null> {
  for (let page = 1; page <= PANO_MAX_PAGE; page += 1) {
    let raw: unknown
    try {
      raw = await khAuthGet<unknown>(
        `/dashboard/recreate/getProjectRecreateInfo?pid=${KH_PROJECT_ID}&pageNo=${page}&size=${PANO_PAGE_SIZE}`,
      )
    } catch (e) {
      if (page === 1) throw e
      // 后面几页失败：已有结果就按「翻到底」处理，别把前几页挑到的丢掉
      return null
    }
    const hit = pickLatestPano(raw, KH_PROJECT_ID)
    if (hit) return hit
    const rows = (raw as { list?: unknown[] })?.list
    if (!Array.isArray(rows) || rows.length < PANO_PAGE_SIZE) return null
  }
  return null
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
