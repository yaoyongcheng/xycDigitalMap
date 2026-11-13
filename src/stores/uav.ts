import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  KH_IDS,
  clearSession,
  fetchDockTelemetry,
  fetchLiveStream,
  fetchMediaJobs,
  fetchRoutes,
  fetchTaskRecords,
  fetchTaskStat,
  fetchTelemetry,
  type DroneDock,
  type DroneLiveStream,
  type DroneRoute,
  type DroneTaskRecord,
  type DroneTaskStat,
  type DroneTelemetry,
} from '@/api/drone'
import { estimateByTask } from '@/utils/uavProgress'
import { droneStateIsDown, droneStateText } from '@/utils/uavState'

/**
 * 无人机（2026-11 阶段 8 起接真实数据，2026-11-13 复盘补全字段）
 *
 * 数据源只有一个：keehang 无人机平台（`api/drone.ts`）。V2 用的是同一批接口。
 *
 * ## 2026-11-13 复盘：三处「以为没数据」，其实是没接
 *
 * ① **今日任务永远是 0**。`/task/exec/list/record` 不带日期时按开始时间**升序**
 *    返回，`page=1` 拿到的是 2026-07-14 那几条；本地再按今天过滤 → 0 条。
 *    现在按 `start=今天&end=明天` 查（`end` 不含当天）。
 * ② **三格统计没有源**。其实有专门端点：`/dashboard/task/list/record` 直接回
 *    `taskCount / finishedCount / failedCount / runningCount / planCount`，
 *    就是设计稿「任务管理」那三格。
 * ③ **风速 / 雨量 / 网络 / 距机库没有源**。机载遥测（type 1）里有 `windSpeed`、
 *    `homeDistance`、`remainFlightTime`；机库遥测（type 2）里有 `windSpeed`、
 *    `rainfall`、`networkRate`、`networkQuality`。原先是解析时只取了 9 个字段，
 *    把另一半丢了 —— 不是厂家没给。
 *
 * ## 仍然取不到 / 不敢判的
 *
 * · **剩余续航**：`remainFlightTime` 在地面是 0，与「电池真的只剩 0 分钟」
 *   无法区分，页面按「—」处理（电量格另有真数）。
 * · **雨量口径**：`rainfall` 实测为 1，同日机库湿度 99%、天气阴，无法确认
 *   1 是「有雨」还是「无雨」。**起飞条件里按未知处理**（不放行），
 *   同时把原值如实显示出来，等厂家确认口径再改判定。
 * · **航线下发**：没有 REST 端点，页面只做只读选择 + 告知平台地址。
 *
 * 登录态：keehang 用的是**项目级服务凭据**，不是用户会话，所以这里不接
 * `auth.token`；但仍保留 `reset()`，登出时清掉缓存的令牌。
 */

/** 状态：idle 未请求 / loading 请求中 / ok 已取到 / error 失败 */
export type UavState = 'idle' | 'loading' | 'ok' | 'error'

/** 失败后的冷却时间（与 overview / deviceLedger 一致） */
const RETRY_GAP = 60_000

/** 实时遥测的刷新间隔：机库+机载两个 GET，30s 够用又不费流量 */
const LIVE_GAP = 30_000

/** 历史时长（进度条分母）的复用期：6 小时。任务的耗时不会一天之内变样 */
const ESTIMATE_GAP = 6 * 60 * 60 * 1000

/** 历史时长算失败后的重试间隔：5 分钟（30s 刷新会反复触发，别空转） */
const ESTIMATE_RETRY = 5 * 60 * 1000

/** 任务执行状态 → 展示文案（服务端实测：2 = 已完成、1 = 执行中、-1 = 未执行） */
function stateText(s: number): string {
  switch (s) {
    case -1:
      return '未执行'
    case 0:
      return '待执行'
    case 1:
      return '执行中'
    case 2:
      return '已完成'
    case 3:
      return '已失败'
    default:
      return '未知'
  }
}

/** 任务执行状态 → 展示 class（沿用页面已有的 is-ok / is-done 语义） */
function stateClass(s: number): string {
  if (s === 1) return 'is-ok'
  if (s === 2) return 'is-done'
  if (s === 3) return 'is-bad'
  return ''
}

/** `YYYY-MM-DD`，offset 为天数偏移（查区间用：start = 今天、end = 明天） */
function dayKey(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 任务的展示视图 */
export interface UavTaskView {
  /** 列表 key：用 uuid（服务端 id 是 int64，部分行会丢精度） */
  key: string
  /** 开始时间 'HH:mm'（从 ISO 串截取） */
  time: string
  name: string
  /** 任务（排班项）id：按它查历史实测时长 */
  taskId: number | null
  state: string
  stateClass: string
  /**
   * 起飞时刻（毫秒）。执行中的任务进度条用它算「已飞多久」。
   *
   * 只有 `start` 一个时刻 —— 执行中那条记录的 `end` 是 `null`，服务端也没有
   * 计划结束时间，所以进度条的分母另走历史实测（`runningEstimate`）。
   */
  startAt: number | null
}

/** 起飞条件的一项 */
export interface UavCheck {
  name: string
  ok: boolean
  unknown: boolean
  risk: string
}

export const useUavStore = defineStore('uav', () => {
  /** 今日任务执行记录 */
  const records = ref<DroneTaskRecord[]>([])
  /** 今日任务统计（三格） */
  const stat = ref<DroneTaskStat | null>(null)
  /** 机载遥测 */
  const telemetry = ref<DroneTelemetry | null>(null)
  /** 机库遥测 */
  const dock = ref<DroneDock | null>(null)
  /** 可选航线（真实航线任务，本项目实测 15 条） */
  const routes = ref<DroneRoute[]>([])
  /** 无人机直播流（`/live/stream/list?deviceId=`，V2 同源） */
  const droneStream = ref<DroneLiveStream | null>(null)
  /** 机库摄像头直播流（在库待机时 `online:false`，有地址但不推流） */
  const dockStream = ref<DroneLiveStream | null>(null)
  /**
   * 各任务的历史实测时长中位数（分钟），按 `taskId` 索引。
   *
   * 服务端没有「计划时长」这个字段（详见 `utils/uavProgress.ts` 开头），
   * 所以进度条的分母只能用同一任务过去几次真跑出来的时长中位数。
   * 取不到就没有分母 —— 页面只写已飞时长，不画条。
   */
  const estimates = ref<Record<string, number>>({})

  const state = ref<UavState>('idle')
  const error = ref('')
  /** 成功取数的时刻（HH:mm） */
  const updatedAt = ref('')

  let lastFailAt = 0
  let inflight: Promise<void> | null = null
  /** 历史时长算出来的时刻（ms）；6 小时内复用，不每次进页面都拉一遍 7 天记录 */
  let estimatesAt = 0
  /** 上一次算失败的时刻：失败后 5 分钟再试，别让 30s 的刷新把它打成循环重试 */
  let estimatesFailAt = 0
  let estimatesInflight: Promise<void> | null = null

  /**
   * 今日任务（按开始时间倒序）。
   *
   * 请求已经带 `start=今天&end=明天`，这里仍按日期本地再滤一次：`end` 是
   * **不含当天**的区间语义，一旦服务端按含端点解释就会把昨天最后一条串进来，
   * 而「今日」这个标签不该被这种边界差异影响。
   */
  const todayRecords = computed<DroneTaskRecord[]>(() => {
    const key = dayKey(0)
    return records.value
      .filter((r) => r.start.slice(0, 10) === key)
      .sort((a, b) => b.start.localeCompare(a.start))
  })

  /** 今日任务（视图） */
  const todayTasks = computed<UavTaskView[]>(() =>
    todayRecords.value.map((r) => {
      const a = Date.parse(r.start)
      return {
        key: r.uuid || String(r.id),
        time: r.start.slice(11, 16),
        name: r.taskName,
        taskId: r.taskId,
        state: stateText(r.status),
        stateClass: stateClass(r.status),
        startAt: Number.isFinite(a) ? a : null,
      }
    }),
  )

  /** 执行中的任务（页面用它显示「当前巡检」） */
  const running = computed<UavTaskView | null>(
    () => todayTasks.value.find((t) => t.stateClass === 'is-ok') ?? null,
  )

  /** 当前巡检的预计时长（同任务历史实测中位数）；这个任务没跑完过就是 null */
  const runningEstimate = computed<number | null>(() => {
    const r = running.value
    if (!r || r.taskId === null) return null
    return estimates.value[String(r.taskId)] ?? null
  })

  /** 三格统计：接口没取到就是 null（页面写「—」，不拿本地条数冒充） */
  const taskTotal = computed(() => stat.value?.taskCount ?? null)
  const taskDone = computed(() => stat.value?.finishedCount ?? null)
  const taskFailed = computed(() => stat.value?.failedCount ?? null)

  /** 机载读数（取不到的字段是 null，页面显示「—」） */
  const live = computed(() => {
    const t = telemetry.value
    return {
      /** 飞机状态文案（厂家状态码映射；-1 = 关机、取不到 = 「—」） */
      state: droneStateText(t?.status ?? null, t?.modeCode ?? null),
      /** 状态是否「关机 / 未连接」，页面据此上色 */
      stateDown: droneStateIsDown(t?.status ?? null, t?.modeCode ?? null),
      /** 电量 % */
      battery: t?.battery ?? null,
      /** 电池温度 ℃ */
      temp: t?.temp ?? null,
      /** 水平速度 m/s */
      speed: t?.horizontalSpeed ?? null,
      /** 垂直速度 m/s */
      verticalSpeed: t?.verticalSpeed ?? null,
      /** 相对起飞点高度 m */
      altitude: t?.relativeAltitude ?? null,
      /** 海拔 m */
      height: t?.height ?? null,
      /** 距起飞点（≈ 机库）当前水平距离 m —— 设备参数「距机库」那格 */
      homeDistance: t?.homeDistance ?? null,
      /** 累计飞行里程 m —— 飞行参数「飞行距离」那格（V2 同字段 `totalFlightDistance`） */
      flightDistance: t?.totalFlightDistance ?? null,
      /** 剩余飞行时间 s */
      remainFlight: t?.remainFlightTime ?? null,
      /**
       * 是否处在地面（待机 / 升级 / 未连接 / 飞控未上报）。
       *
       * 只用来说明「为什么续航是 —」：`remainFlightTime` 在地面恒为 0，
       * 与「真的只剩 0 分钟」区分不开，页面按「—」处理并给一句解释。
       * 这不是安全判定，别拿它做业务门禁。
       */
      onGround:
        t !== null &&
        (t.status === -1 || t.modeCode === 0 || t.modeCode === 13 || t.modeCode === 14),
      /** 累计架次 */
      totalSorties: t?.totalSorties ?? null,
      /** 航向角 ° */
      heading: t?.heading ?? null,
      /** 经纬度 */
      lat: t?.lat || null,
      lng: t?.lng || null,
    }
  })

  /** 机库读数 */
  const dockLive = computed(() => {
    const d = dock.value
    return {
      /** 无人机是否在库（null = 机库遥测没取到） */
      droneIn: d?.droneOnline ?? null,
      /** 舱内温度 ℃ */
      cabinTemp: d?.cabinTemp ?? null,
      /** 环境温度 ℃ */
      envTemp: d?.envTemp ?? null,
      /** 环境湿度 % */
      humidity: d?.humidity ?? null,
      /** 雨量（厂家原值，口径未确认） */
      rainfall: d?.rainfall ?? null,
      /** 网络速率 kbps */
      networkRate: d?.networkRate ?? null,
      /** 网络质量等级（厂家原值） */
      networkQuality: d?.networkQuality ?? null,
      /** 充电状态（厂家枚举） */
      chargeState: d?.chargeState ?? null,
      /** 存储：已用 / 总量（GB） */
      storageUsed: d?.storageUsed ?? null,
      storageTotal: d?.storageTotal ?? null,
      /** 告警 */
      alarm: d?.alarmState ?? null,
    }
  })

  /**
   * 风速（m/s）：机载优先，机库兜底。
   *
   * 两个都对同一片空域——机载是飞机自己测的，机库是地面站测的；
   * 飞机在地面时机载读数可能为 0，这时用机库的值更有意义。
   */
  const windSpeed = computed<number | null>(() => {
    const d = telemetry.value?.windSpeed
    if (d !== null && d !== undefined) return d
    return dock.value?.windSpeed ?? null
  })

  /**
   * 起飞条件校验。
   *
   * 三态：`ok` 满足 / `bad` 明确不满足 / `unknown` **没有可信数据**。
   * 「没有数据」绝不能算成「满足」—— 那是把安全门放松的方向。
   *
   * 2026-11-13 之后，风速与网络从「未接入」变成真实判定（机库遥测里有）；
   * 雨量仍是未知，原因是**口径**不明（rainfall=1 到底是晴是雨无法确认），
   * 不是没数据 —— 页面同时显示原值，便于人工判断。
   */
  const checks = computed<UavCheck[]>(() => {
    const l = live.value
    const d = dockLive.value
    const wind = windSpeed.value
    return [
      {
        name: '电量',
        ok: l.battery !== null && l.battery >= 30,
        unknown: l.battery === null,
        risk: '电量低于 30%',
      },
      {
        name: '电池温度',
        ok: l.temp !== null && l.temp >= 0 && l.temp <= 45,
        unknown: l.temp === null,
        risk: '电池温度异常',
      },
      {
        name: '风速',
        ok: wind !== null && wind <= 8,
        unknown: wind === null,
        risk: '风速超过 8m/s',
      },
      {
        name: '网络',
        // 这里看的是**速率**（图传够不够传回视频），不是「网络质量」那格的等级：
        // 等级只有四档、粗得很，做安全门太松。两者都来自机库遥测，但不是一个量。
        ok: d.networkRate !== null && d.networkRate >= 500,
        unknown: d.networkRate === null,
        risk: '网络速率低于 500kbps',
      },
      {
        name: '水平速度',
        ok: l.speed !== null && l.speed <= 12,
        unknown: l.speed === null,
        risk: '水平速度过高',
      },
      {
        name: '雨量',
        ok: false,
        unknown: true,
        // 带上原值：用户/运维能一眼看到「机库报了 1」，而不是一句空泛的「未接入」
        risk: `机库雨量口径未确认（rainfall=${d.rainfall ?? '—'}）`,
      },
    ]
  })

  /** 明确不满足的条件（页面列风险项） */
  const risks = computed(() => checks.value.filter((c) => !c.ok && !c.unknown))

  /** 未知指标（数据未接入 / 口径未确认） */
  const unknowns = computed(() => checks.value.filter((c) => c.unknown))

  /**
   * 是否允许下发任务。
   *
   * 有明确不满足项 → 不可；有未知项 → 也**不可**（保守侧），
   * 因为起飞条件是安全门，宁可让用户看到「还差什么」也不要放行未知状态。
   */
  const canDispatch = computed(() => checks.value.every((c) => c.ok))

  /** 下发条件说明文案 */
  const dispatchNote = computed(() => {
    if (canDispatch.value) {
      return '起飞条件校验通过：电量、电池温度、风速、网络、水平速度符合要求'
    }
    const bad = risks.value.map((c) => c.name)
    const unknown = unknowns.value.map((c) => c.name)
    const parts: string[] = []
    if (bad.length) parts.push(`${bad.join('、')}未达标`)
    if (unknown.length) parts.push(`${unknown.join('、')}口径未确认`)
    return parts.length ? `当前不可下发：${parts.join('；')}` : '当前条件不支持手动下发'
  })

  function stamp(): string {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /**
   * 拉一轮无人机数据（子页用）。
   *
   * 四块各自成败互不影响：任务列表是主信息（决定 state），遥测/统计/航线
   * 失败只让自己的格子写「—」，不该把整页判成失败。
   */
  async function load(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && state.value === 'ok') return
    if (!force && state.value === 'error' && Date.now() - lastFailAt < RETRY_GAP) return

    state.value = 'loading'
    inflight = (async () => {
      const [list, s, tel, dk, rt, fly, dockFly] = await Promise.allSettled([
        fetchTaskRecords({ start: dayKey(0), end: dayKey(1) }),
        fetchTaskStat(),
        fetchTelemetry(),
        fetchDockTelemetry(),
        fetchRoutes(),
        fetchLiveStream(KH_IDS.droneDeviceId),
        fetchLiveStream(KH_IDS.dockDeviceId),
      ])

      if (s.status === 'fulfilled') stat.value = s.value
      if (tel.status === 'fulfilled') telemetry.value = tel.value
      if (dk.status === 'fulfilled') dock.value = dk.value
      if (rt.status === 'fulfilled') routes.value = rt.value
      // 直播流取不到就当「没有这一路」，页面写「未开播」；不保留上一轮的旧地址，
      // 免得停播后仍拿旧 url 连（连上去是黑的，比明说未开播更糟）
      if (fly.status === 'fulfilled') droneStream.value = fly.value
      if (dockFly.status === 'fulfilled') dockStream.value = dockFly.value

      if (list.status === 'fulfilled') {
        records.value = list.value.rows
        state.value = 'ok'
        error.value = ''
        updatedAt.value = stamp()
        lastFailAt = 0
        // 有执行中的任务才需要「预计时长」；不必为静态页多打一个 7 天的请求
        if (running.value) void loadEstimates()
      } else {
        state.value = 'error'
        const e = list.reason
        error.value = e instanceof Error ? e.message : '无人机任务加载失败'
        records.value = []
        lastFailAt = Date.now()
      }
      inflight = null
    })()
    return inflight
  }

  /**
   * 算「每个任务跑一趟要多久」—— 拉最近 7 天的执行记录取中位数。
   *
   * 只在页面存在执行中的任务时打（`load()` / `refreshLive()` 里判 `running`），
   * 一次 7 天实测 114 行 / 32KB，6 小时内复用。失败静默：没有历史就没有分母，
   * 页面不画进度条也不编时长，不影响别的块。
   */
  async function loadEstimates(): Promise<void> {
    if (estimatesInflight) return estimatesInflight
    if (Date.now() - estimatesAt < ESTIMATE_GAP) return
    if (Date.now() - estimatesFailAt < ESTIMATE_RETRY) return
    estimatesInflight = (async () => {
      try {
        // `end` 不含当天，所以要传明天；`start` 取 6 天前 = 近 7 天
        const page = await fetchTaskRecords({ start: dayKey(-6), end: dayKey(1) })
        estimates.value = estimateByTask(page.rows)
        estimatesAt = Date.now()
      } catch {
        // 静默失败：预计时长是补充信息，不该让整页报错。
        // 但 30s 刷新会反复调到这里，失败一次压 5 分钟再试，不空转
        estimatesFailAt = Date.now()
      } finally {
        estimatesInflight = null
      }
    })()
    return estimatesInflight
  }

  /**
   * 只拉「今日任务统计」—— 给首页卡片用。
   *
   * 首页只要一个「今日作业次数」，不该为它触发 CAS + 四个请求。失败静默
   * （卡片留「—」），60s 冷却避免每次切回首页都重打。
   */
  async function loadStat(): Promise<void> {
    if (stat.value) return
    if (Date.now() - lastFailAt < RETRY_GAP) return
    try {
      stat.value = await fetchTaskStat()
    } catch {
      lastFailAt = Date.now()
    }
  }

  /* ---------------- 实时刷新（子页「实时监控」） ---------------- */

  let liveTimer: number | null = null
  const liveOwners = new Set<string>()

  /**
   * 刷一轮「实时监控」看到的东西：两路遥测 + 两路直播流 + 任务三格与今日明细。
   *
   * ## 任务统计为什么也在这里刷（2026-11-13 用户要求）
   *
   * 早先只刷遥测，理由是「任务统计变化慢」。实际用起来很别扭：任务飞完、
   * 执行记录变成「已完成」，页面那三格（今日任务 / 已完成 / 失败次数）和
   * 「当前巡检 · xxx」卡还停在起飞前的样子，得退出子页再进来才更新。
   *
   * 两路加起来也就十几条记录（今天全部执行记录），KB 级，和一张遥测快照差不多，
   * 所以按同一节拍（30s）走，不另开定时器、也不做双周期节流 ——
   * 「换个数字要等一分钟」在作业现场就是没对齐。
   *
   * 失败一律保留旧值、不把页面清空：刷新失败不等于「今天没有任务」。
   */
  async function refreshLive(): Promise<void> {
    const [tel, dk, fly, dockFly, s, list] = await Promise.allSettled([
      fetchTelemetry(),
      fetchDockTelemetry(),
      fetchLiveStream(KH_IDS.droneDeviceId),
      fetchLiveStream(KH_IDS.dockDeviceId),
      fetchTaskStat(),
      fetchTaskRecords({ start: dayKey(0), end: dayKey(1) }),
    ])
    if (tel.status === 'fulfilled') telemetry.value = tel.value
    if (dk.status === 'fulfilled') dock.value = dk.value
    // `online` 会从 false 变 true（机库摄像头开始推流），页面靠它决定要不要挂播放器
    if (fly.status === 'fulfilled') droneStream.value = fly.value
    if (dockFly.status === 'fulfilled') dockStream.value = dockFly.value
    if (s.status === 'fulfilled') stat.value = s.value
    if (list.status === 'fulfilled') records.value = list.value.rows
    // 任务刚起飞（进页面时还没跑）：这时才去补历史时长，补到就出进度条
    if (running.value) void loadEstimates()
  }

  /**
   * 登记一个「正在看实时读数」的页面。
   *
   * 按 owner 名登记而不是计数：组件重复挂载/卸载不会把计数弄歪。
   */
  function startLive(owner: string): void {
    liveOwners.add(owner)
    if (liveTimer !== null) return
    liveTimer = window.setInterval(() => {
      void refreshLive()
    }, LIVE_GAP)
  }

  function stopLive(owner: string): void {
    liveOwners.delete(owner)
    if (liveOwners.size || liveTimer === null) return
    window.clearInterval(liveTimer)
    liveTimer = null
  }

  /**
   * 取某个任务的媒体文件（航拍照片 / 视频）。
   *
   * jobId 是**执行记录 id**（不是 taskId）—— 服务端按 job 维度返回媒体。
   * 返回空数组表示「该任务没有媒体文件」，不是错误。
   */
  async function mediaOf(jobId: number): Promise<unknown[]> {
    try {
      return await fetchMediaJobs(jobId)
    } catch {
      return []
    }
  }

  /** 测试接线点：直接灌数据（不走网络） */
  function apply(recs: DroneTaskRecord[], tel: DroneTelemetry | null = null, st: DroneTaskStat | null = null): void {
    records.value = recs
    telemetry.value = tel
    stat.value = st
    state.value = 'ok'
    error.value = ''
  }

  /** 测试接线点：机库遥测 */
  function applyDock(dk: DroneDock | null): void {
    dock.value = dk
  }

  /** 测试接线点：直播流 */
  function applyStream(fly: DroneLiveStream | null, dockFly: DroneLiveStream | null = null): void {
    droneStream.value = fly
    dockStream.value = dockFly
  }

  /** 退出登录 / 换账号时清空 */
  function reset(): void {
    records.value = []
    stat.value = null
    telemetry.value = null
    dock.value = null
    routes.value = []
    droneStream.value = null
    dockStream.value = null
    state.value = 'idle'
    error.value = ''
    updatedAt.value = ''
    lastFailAt = 0
    estimates.value = {}
    estimatesAt = 0
    clearSession()
  }

  return {
    records,
    stat,
    telemetry,
    dock,
    routes,
    droneStream,
    dockStream,
    state,
    error,
    updatedAt,
    todayRecords,
    todayTasks,
    running,
    runningEstimate,
    taskTotal,
    taskDone,
    taskFailed,
    live,
    dockLive,
    windSpeed,
    checks,
    risks,
    unknowns,
    canDispatch,
    dispatchNote,
    apply,
    applyDock,
    applyStream,
    load,
    loadStat,
    startLive,
    stopLive,
    refreshLive,
    mediaOf,
    reset,
  }
})
