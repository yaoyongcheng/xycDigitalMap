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
  fetchTodayRecords,
  fetchTodayTaskList,
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

/**
 * 机载遥测的刷新间隔 —— **对齐 V2 的更新节奏**。
 *
 * ## V2 是推送，不是轮询
 *
 * V2 客户端（`MqttDroneRealTimeInfoRequester`）连 broker `47.106.219.250:1883`，
 * 订阅 `/prod/thing/product/{sn}/osd`，一条 OSD 到就更新界面并触发
 * `E_DroneRealTimeInfoUpdated`，页面立刻跟着变；`droneOfflineTimeoutSeconds = 3`，
 * 3 秒收不到消息才判离线。飞控 OSD 本身约 1Hz。**机库那一路（`/telemetry/{id}/2`）
 * V2 也是从同一条 OSD 推送里拿的，它没有单独高频请求过这个接口**
 * （三元里源码全量 grep 无 `cache/telemetry`；向阳村 V2 进程也没有无人机 broker 连接）。
 *
 * ## 浏览器只能近似
 *
 * 那层推送浏览器接不了：broker 裸端口（1883 / WS 8083）在 HTTPS 页面下会被
 * 混合内容拦掉，GitHub Pages 更没有反代。所以退成轮询 ——
 * **2 秒一轮**是最接近的近似：实测服务端遥测缓存就是秒级
 * （每 2s 采样一次，翻滚角 / 水平速度 / 航向每次都在变）。
 * 这一档**只拉飞机**；机库读数按分钟级变化，走 30s 那档（见 `refreshSlow`）。
 *
 * 成本：机载 1.5KB/轮，2s 一轮约 2.7MB/小时（2026-11-16 起机库那一路不再跟 2s，
 * 见表下的 `refreshSlow`）。页面不可见时整轮跳过（见 `startLive`），后台不烧流量。
 */
const LIVE_GAP = 2_000

/**
 * 「慢变」数据的节拍：两路直播流地址 + **机库读数** + 任务三格 + 今日明细。
 *
 * 这几样都不跟 2s 走：直播地址只在开播 / 关播时变，任务记录一条要跑十几分钟，
 * 机库的舱温 / 湿度 / 雨量 / 网络是分钟级变化（V2 那边这些字段随 OSD 推送来，
 * 也不按 2s 单独拉）。
 * 今日明细十几条记录、几 KB，2s 拉一次一小时就是 9MB —— 白烧流量换不来任何观感。
 * 30s 足够让「任务飞完」在页面上及时翻过来。
 */
const SLOW_GAP = 30_000

/** 历史时长（进度条分母）的复用期：6 小时。任务的耗时不会一天之内变样 */
const ESTIMATE_GAP = 6 * 60 * 60 * 1000

/** 历史时长算失败后的重试间隔：5 分钟（30s 刷新会反复触发，别空转） */
const ESTIMATE_RETRY = 5 * 60 * 1000

/**
 * 任务状态 → 展示文案。
 *
 * **两个字段各有分工**（2026-11-23 实测近 14 天 204 行得出）：
 * - `status`：记录处在哪个阶段（`-1` 未执行 / `0` 待执行 / `1` 执行中 / `2` 已执行）。
 *   已执行的记录**恒为 2** —— 飞失败的那条也是 2。
 * - `result`：飞行结果（`0` 成功 / `3` 失败 / `4` 未执行）。**成败只看它**。
 *
 * 早先只读 `status`，于是 15:00 那次失败的「安全巡检」一直显示「已完成」，
 * 而三格里的「失败次数」又确实是 1 —— 同一份数据两处两个说法。
 */
function stateText(s: number, result: number | null, suspended = false): string {
  /**
   * 暂停的排班按「未执行」显示（用户 2026-11-24 定）。
   *
   * 服务端把当天被暂停的排班放在 `unfinishedTaskList` 里（`suspended:true`），
   * 但现场看清单只关心「这一架次飞没飞」——「已暂停」是个平台侧的调度状态，
   * 摆到清单里反而像另一种执行结果。这里与 `result === 4` 合并成「未执行」，
   * 配色也一致（`stateClass` 给 `is-plan` 灰）。暂停条数仍单独统计在
   * `suspendedCount` 里，供三格的「今日任务」把总数补齐。
   */
  if (suspended) return '未执行'
  if (result === 3) return '已失败'
  if (result === 4 || s === -1) return '未执行'
  if (s === 1) return '执行中'
  if (s === 2) return '已完成'
  if (s === 0) return '待执行'
  // 兜底：万一哪天服务端把结果写进了 status
  if (s === 3) return '已失败'
  return '未知'
}

/** 任务状态 → 展示 class（沿用页面已有的 is-ok / is-done / is-bad 语义） */
function stateClass(s: number, result: number | null, suspended = false): string {
  if (suspended) return 'is-plan'
  if (result === 3 || s === 3) return 'is-bad'
  if (s === 1) return 'is-ok'
  if (s === 2) return 'is-done'
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
  /**
   * 是否本项目的任务。
   *
   * 2026-11-16 起「今日任务」曾按账号口径取（三格 23 = 向阳村 15 + 光谷元著 8），
   * 列表里会混进别的项目的记录；2026-11-23 用户要求**剔除光谷元著**后，
   * 明细接口只传本项目 pid（见 `load()`），所以这里当前恒为 `true`。
   * 字段保留：`running`（当前巡检）仍按它过滤，将来若要恢复账号口径不用再改结构。
   */
  own: boolean
}

/**
 * 演示用的「执行中任务」曾在这里（`?simMission=1`，`import.meta.env.DEV` 守卫）。
 *
 * 2026-11-23 验收完即下线：进度条的两处一致性由 `utils/missionClock.ts` 保证，
 * 不再需要一条假任务来制造「执行中」。`running` / `runningEstimate` 已恢复成
 * **只认真实记录**，没有模拟分支。
 */

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
   *
   * 2026-11-16 起是**账号口径**（`fetchTodayRecords` 合并了账号下各项目），
   * 条数与三格 `taskCount` 对齐（23 = 15 + 8）。
   *
   * 2026-11-23 起改回**只本项目**（用户要求剔除「光谷元著」）：明细只传
   * `pids: [KH_IDS.pid]`，统计只传 `pid: KH_IDS.pid`，两边条数依然对得上。
   *
   * 2026-11-24：清单主源换成 `fetchTodayTaskList`（全量端点，见 `loadTodayList`），
   * `records` 现在是**当天全部排班**（已完成 / 执行中 / 未执行，含平台标 `suspended`
   * 的暂停项 —— 暂停在清单里按「未执行」显示，见 `stateText`），
   * 不再只是「已产生记录的项」。这里的日期过滤留着 —— 它拦的是服务端把
   * 次日排班混进来的边界差异，与新数据源无关。
   */
  const todayRecords = computed<DroneTaskRecord[]>(() => {
    const key = dayKey(0)
    return records.value
      .filter((r) => r.start.slice(0, 10) === key)
      .sort((a, b) => b.start.localeCompare(a.start))
  })

  /**
   * 当天还没飞的任务（统计接口的 `unfinishedTaskList`）—— 现在只是**补漏**。
   *
   * 2026-11-24 实测这个字段会被截断：三格 `taskCount 15`、`planCount 11`，
   * 而 `unfinishedTaskList` 只回 7 条（当天最后 5 条排班不在里面）。
   * 所以清单主源改成全量端点（`loadTodayList`），它已经把 15 条给全；
   * 这里只在「主源少给了某条」时补上，保证清单条数不低于三格。
   *
   * 与记录去重：同一 `taskId + 开始时间` 已经在记录里（例如正在执行的任务，
   * 统计里仍算「未完成」但也已有记录），就不再补一条 —— 否则会出现
   * 「执行中 + 未执行」两条同名同时间的行。
   */
  const todayPending = computed<UavTaskView[]>(() => {
    const rows = stat.value?.pending ?? []
    if (!rows.length) return []
    const key = dayKey(0)
    const seen = new Set(todayRecords.value.map((r) => `${r.taskId ?? r.taskName}|${r.start}`))
    const out: UavTaskView[] = []
    for (const p of rows) {
      // 统计接口的 `unfinishedTaskList` 偶尔会跨到次日，按日期再滤一次
      if (p.start.slice(0, 10) !== key) continue
      const k = `${p.taskId ?? p.taskName}|${p.start}`
      if (seen.has(k)) continue
      seen.add(k)
      const a = Date.parse(p.start)
      out.push({
        key: `plan-${k}`,
        time: p.start.slice(11, 16),
        name: p.taskName,
        taskId: p.taskId,
        // 还没起飞：不写「待执行」以免与 status=0 混淆，就写「未执行」
        state: '未执行',
        stateClass: 'is-plan',
        startAt: Number.isFinite(a) ? a : null,
        own: true,
      })
    }
    return out
  })

  /**
   * 今日任务（视图）：**当天全部排班 + 统计里没回传的那几条补漏**，按开始时间倒序。
   *
   * 条数必须与三格的 `taskCount` 一致（用户 2026-11-24 明确要求「永远一致」）：
   * 主源是全量端点，已包含已完成 / 执行中 / 未执行（含暂停）三类文案；
   * `todayPending` 只补主源漏掉的，按 `taskId + start` 去重后不会重复。
   */
  const todayTasks = computed<UavTaskView[]>(() => {
    const done = todayRecords.value.map((r) => {
      const a = Date.parse(r.start)
      return {
        key: r.uuid || String(r.id),
        time: r.start.slice(11, 16),
        name: r.taskName,
        taskId: r.taskId,
        state: stateText(r.status, r.result, r.suspended === true),
        stateClass: stateClass(r.status, r.result, r.suspended === true),
        startAt: Number.isFinite(a) ? a : null,
        // pid 缺失（老数据）按本项目算，不确定时不要凭空扣掉一条
        own: r.pid === null || r.pid === KH_IDS.pid,
      }
    })
    return [...done, ...todayPending.value].sort((a, b) => (b.startAt ?? 0) - (a.startAt ?? 0))
  })

  /**
   * 今日列表里是否有别的项目的任务（有才在弹层底部加一句说明）。
   *
   * 2026-11-23 起明细只取本项目，正常恒为 `false`；保留它作兜底 ——
   * 服务端若又混进别的项目的记录，弹层至少会说明「含其它项目」，不闷着。
   */
  const todayHasOthers = computed(() => todayTasks.value.some((t) => !t.own))

  /**
   * 执行中的任务（页面用它显示「当前巡检」）。
   *
   * 只认本项目：遥测是向阳村那台机库的，挂上光谷元著的航线会给出错误的
   * 「已飞多久 / 预计多久」。别的项目在执行中的任务仍在今日列表里照常显示。
   */
  const running = computed<UavTaskView | null>(
    () => todayTasks.value.find((t) => t.own && t.stateClass === 'is-ok') ?? null,
  )

  /** 当前巡检的预计时长（同任务历史实测中位数）；这个任务没跑完过就是 null */
  const runningEstimate = computed<number | null>(() => {
    const r = running.value
    if (!r || r.taskId === null) return null
    return estimates.value[String(r.taskId)] ?? null
  })

  /**
   * 三格统计：接口没取到就是 null（页面写「—」，不拿本地条数冒充）。
   *
   * 「今日任务」= `taskCount + suspendedCount`（用户 2026-11-24 定）：
   * 服务端的 `taskCount` **不含已暂停**，而当天排班（清单）含。
   * 10:13 实测 `taskCount 4`（2 完成 + 1 失败 + 1 执行中）+ `suspendedCount 11`
   * = 15，正好等于全量清单 15 条 —— 只显示 4 就会重现「卡上 4、清单 15」。
   * 暂停的行在清单里按「未执行」显示（见 `stateText`），不再单列一种状态。
   */
  const taskTotal = computed(() => {
    const s = stat.value
    if (!s) return null
    return s.taskCount + (s.suspendedCount ?? 0)
  })
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
      /**
       * 偏航角 °（遥测 `attitudeHead`）—— 飞行参数「偏航角」那格，对齐 V2。
       * 负值原样保留（−180~180），见 `DroneTelemetry.heading` 的说明。
       */
      heading: t?.heading ?? null,
      /** 翻滚角 °（遥测 `attitudeRoll`）—— 飞行参数「翻滚角」那格 */
      roll: t?.attitudeRoll ?? null,
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
   * 风速（m/s）：**只取机库**那一份。
   *
   * 为什么不是「机载优先、机库兜底」（2026-11-16 用户指出与 V2 对不上）：
   *
   * V2 无人机弹层显示的正是机库那一侧 —— `UIDronePop.cs:189`
   * `txtWindSpeed.text = dockNet.wind_speed + "m/s"`，`dockNet` 是机库
   * `EnvPosNetStorageSideData`。飞机自己那份 `windSpeed` V2 从来没往面板上打过。
   *
   * 两个数值实测确实不同（同一时刻机载 2 / 2.6 / 2.4，机库 2.6 / 2.2 / 1.6）——
   * 一个是机上气流计、一个是机库气象站，本来就不是一个量。要跟 V2 对得上，
   * 就只能取机库这一份。
   */
  const windSpeed = computed<number | null>(() => dock.value?.windSpeed ?? null)

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
   * 今日任务清单：**先取全量端点，挂了才退回老拼法**。
   *
   * 2026-11-24 实测：三格 `taskCount` 是 15，而统计响应里的
   * `unfinishedTaskList` 只有 7 条（+ `completedTaskList` 3 条 = 10）——
   * 15:00 / 15:30 / 16:15 / 17:00 / 17:45 这 5 条排班服务端不回，
   * 于是「查看今日任务」永远比卡上的 15 少 5 行。全量端点
   * （`/dashboard/task/list/execRecord/today`）把这 15 条一次给全，
   * 清单与三格才对得上（见 `api/drone.ts::fetchTodayTaskList`）。
   *
   * 兜底路径不动：老网关没有这个端点时用旧的两段式（执行记录 + 未完成排班），
   * 少列几条也强过整页报错。
   */
  async function loadTodayList(): Promise<DroneTaskRecord[]> {
    try {
      const rows = await fetchTodayTaskList(KH_IDS.pid)
      if (rows.length) return rows
    } catch {
      // 端点不存在 / 被网关拦 / 超时：落到下面的兜底
    }
    return fetchTodayRecords({ start: dayKey(0), end: dayKey(1), pids: [KH_IDS.pid] })
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
        loadTodayList(),
        fetchTaskStat({ pid: KH_IDS.pid }),
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
        records.value = list.value
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
        /*
         * **不清空 `records`**（2026-11-24）。
         *
         * 原来这里写 `records.value = []`，代价是「一次刷新失败 = 当前巡检消失」：
         * 页面 mount 与点「重试」都走这条强制刷新，失败一次就会让 `running` 变
         * null —— 「当前巡检」卡片、进度条、实时画面（门禁是 `running`）一起下线，
         * 而飞机其实还在飞。30s 那轮 `refreshSlow` 本来就不清，两条路口径还打架。
         *
         * 现在与 `refreshSlow` 一致：失败只改状态和原因，手上有什么就留着什么；
         * 页面在 `state === 'error'` 时补一句「以上为上一次的数据」，不假装实时。
         * 真正该清空的是退出登录（`reset()`），不是一次网络抖动。
         */
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
        // `end` 不含当天，所以要传明天；`start` 取 6 天前 = 近 7 天。
        // 只取本项目：分母是给「当前巡检」用的，而它只认本项目任务
        const page = await fetchTaskRecords({ start: dayKey(-6), end: dayKey(1), pid: KH_IDS.pid })
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
   *
   * 2026-11-23：`pid` 只传本项目 —— 统计口径与无人机页那三格统一，
   * 不再把「光谷元著」的架次算进向阳村的「今日作业次数」。
   */
  async function loadStat(): Promise<void> {
    if (stat.value) return
    if (Date.now() - lastFailAt < RETRY_GAP) return
    try {
      stat.value = await fetchTaskStat({ pid: KH_IDS.pid })
    } catch {
      lastFailAt = Date.now()
    }
  }

  /** `loadMission` 的最小间隔：首页常驻时 30s 的本地 tick 会反复调到这里 */
  const MISSION_GAP = 60_000
  let missionAt = 0
  let missionInflight: Promise<void> | null = null

  /**
   * 首页卡片「当前巡检」进度条的取数。
   *
   * 首页原先只打一个统计请求（`loadStat`），拿不到今日明细 → `running` 永远是空，
   * 进度条也就无从显示。这里补一条**轻量**明细请求：只取本项目今日记录；
   * 真有执行中的任务时才再补「预计时长」（`loadEstimates`，内部带 6 小时缓存）。
   *
   * - **失败静默**：取不到就不画进度条，不编一个百分比（与无人机页同一原则）。
   * - **60s 冷却**：首页常驻时每 30s 会调一次，实际约两拍打一个请求；
   *   一小时 ≈ 60 个请求，换来「任务一开始就自动出现」。
   * - **不动 `state`**：这是卡片的补充信息，接口挂了不该把整页判成加载失败。
   */
  async function loadMission(force = false): Promise<void> {
    if (missionInflight) return missionInflight
    if (!force && Date.now() - missionAt < MISSION_GAP) return
    missionAt = Date.now()
    missionInflight = (async () => {
      try {
        records.value = await loadTodayList()
        if (running.value) await loadEstimates()
      } catch {
        // 静默：卡片上少一条进度条，比摆一条假的进度条好
      } finally {
        missionInflight = null
      }
    })()
    return missionInflight
  }

  /* ---------------- 实时刷新（子页「实时监控」） ---------------- */

  let liveTimer: number | null = null
  let slowTimer: number | null = null
  const liveOwners = new Set<string>()
  /** 上一轮遥测还没回来就跳过这一拍 —— 2s 可能比一次请求还短，别把请求堆起来 */
  let telemetryBusy = false

/**
 * 刷一轮**遥测**（2s 节拍）：机载 `/1` + 机库 `/2` 两路 GET。
 *
 * 机库为什么也放进 2s 档（2026-11-16 用户要求）：
 * 设备参数里「风速」与「网络速率 / 网络质量」三项**都取自机库**（风速尤其，
 * V2 面板 `txtWindSpeed` 打的就是 `dockNet.wind_speed`）。早先机库只跟 30s 那档，
 * 结果风速 2 秒动一次、网络速率半分钟才动一次，同一屏两格节奏不一样，
 * 看着像网络那格卡住了。两路同频后它们一起跳。
 *
 * 代价是机库这套（约 0.8KB）从 120 次/小时 变成 1800 次/小时；单价可忽略，
 * 而「同一屏读数同频」是可读性问题，优先。
 *
 * 失败一律保留旧值、不把页面清空：刷新失败不等于「飞机没了」。
 */
async function refreshTelemetry(): Promise<void> {
  // 机载与机库**同一个节拍**（2026-11-16 用户要求：网络速率的刷新频率要跟风速一致）。
  // 风速按 V2 口径只取机库那一份，网络质量 / 网络速率也来自机库 —— 三者同源同频，
  // 页面上的风速和网络速率才会一起动，不会一个 2 秒跳、一个 30 秒才跳。
  // 两路并发、各失败各的：机库挂了不该让机载那几格一起停。
  const [t, d] = await Promise.allSettled([fetchTelemetry(), fetchDockTelemetry()])
  if (t.status === 'fulfilled') telemetry.value = t.value
  if (d.status === 'fulfilled') dock.value = d.value
}

/**
 * 刷一轮**慢变数据**（30s 节拍）：两路直播流 + 任务三格 + 今日明细。
 *
 * 机库读数**不在这里**了 —— 它跟机载一起走 2s 档（见 `refreshTelemetry`）。
 *
 * 任务统计为什么也要刷（2026-11-13 用户要求）：早先只刷遥测，任务飞完、
 * 执行记录变「已完成」，页面那三格还停在起飞前的样子，得退出子页再进来才更新。
 */
async function refreshSlow(): Promise<void> {
  const [fly, dockFly, s, list] = await Promise.allSettled([
    fetchLiveStream(KH_IDS.droneDeviceId),
    fetchLiveStream(KH_IDS.dockDeviceId),
    fetchTaskStat({ pid: KH_IDS.pid }),
    loadTodayList(),
    fetchDockTelemetry(),
  ])
  // `online` 会从 false 变 true（机库摄像头开始推流），页面靠它决定要不要挂播放器
  if (fly.status === 'fulfilled') droneStream.value = fly.value
  if (dockFly.status === 'fulfilled') dockStream.value = dockFly.value
  if (s.status === 'fulfilled') stat.value = s.value
  if (list.status === 'fulfilled') records.value = list.value
  // 任务刚起飞（进页面时还没跑）：这时才去补历史时长，补到就出进度条
  if (running.value) void loadEstimates()
}

  /** 整页刷一轮：进页面、切回标签页时用，两档节拍都走一遍 */
  async function refreshLive(): Promise<void> {
    await Promise.all([refreshTelemetry(), refreshSlow()])
  }

  /** 页面可见性变化：切回来立刻补一轮，不用干等下一个 2 秒 */
  function onVisible(): void {
    if (document.visibilityState === 'visible') void refreshLive()
  }

  /**
   * 登记一个「正在看实时读数」的页面。
   *
   * 按 owner 名登记而不是计数：组件重复挂载/卸载不会把计数弄歪。
   */
  function startLive(owner: string): void {
    if (liveOwners.has(owner)) return
    liveOwners.add(owner)
    if (liveTimer !== null) return
    document.addEventListener('visibilitychange', onVisible)
    // 2s 档：只打两路遥测。页面在后台就整轮跳过 —— 2s 的节拍不在后台烧流量
    liveTimer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      if (telemetryBusy) return
      telemetryBusy = true
      void refreshTelemetry().finally(() => {
        telemetryBusy = false
      })
    }, LIVE_GAP)
    slowTimer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void refreshSlow()
    }, SLOW_GAP)
  }

  function stopLive(owner: string): void {
    if (!liveOwners.delete(owner)) return
    if (liveOwners.size) return
    if (liveTimer !== null) window.clearInterval(liveTimer)
    if (slowTimer !== null) window.clearInterval(slowTimer)
    liveTimer = null
    slowTimer = null
    document.removeEventListener('visibilitychange', onVisible)
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
    todayHasOthers,
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
    loadMission,
    startLive,
    stopLive,
    refreshLive,
    mediaOf,
    reset,
  }
})
