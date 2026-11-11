import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  clearSession,
  fetchMediaJobs,
  fetchRoutes,
  fetchTaskRecords,
  fetchTelemetry,
  type DroneRoute,
  type DroneTaskRecord,
  type DroneTelemetry,
} from '@/api/drone'

/**
 * 无人机（2026-11 阶段 8：改真实数据）
 *
 * 原先这个 store 不存在，UavPage 直接读 `data/device.ts` 里的三份常量：
 *
 *   uavLive       = { wind: 2, battery: 78, netKbps: 2079, temp: 28.8, rain: false }
 *   uavTodayTasks = 三条写死的任务（08:30 日常巡航 / 10:00 塔吊巡查 / 14:30 作业面）
 *   uavChecks     = 起飞条件校验（由 uavLive 派生，所以五项永远全过）
 *
 * 现在全部改接 keehang 无人机平台（见 `api/drone.ts`）：
 *
 *   · 任务     → `GET /task/exec/list/record?pid=本项目`
 *                实测首屏是「向阳村-安全巡检」（今天 15:00 执行，机库 263）；
 *                历史里还有「测试 / 测试全景」等真实历史记录。
 *   · 机载参数 → `GET /dashboard/device/cache/telemetry/{无人机设备id}/1`
 *                实测电量 88%、电池温度 29.3℃、水平速度 0。
 *
 * **取不到就是取不到**：风速 / 雨量 / 网络速率这三个字段遥测接口没给，
 * 起飞条件校验里对应的项显示「未接入」而不是判成「正常」——
 * 把「没有数据」当成「条件满足」是危险的方向（该拦的飞行没拦）。
 *
 * 登录态：keehang 用的是**项目级服务凭据**，不是用户会话，所以这里不接
 * `auth.token`；但仍保留 `reset()`，登出时清掉缓存的令牌，避免下一个人
 * 用着上一个账号的上下文。
 */

/** 状态：idle 未请求 / loading 请求中 / ok 已取到 / error 失败 */
export type UavState = 'idle' | 'loading' | 'ok' | 'error'

/** 失败后的冷却时间（与 overview / deviceLedger 一致） */
const RETRY_GAP = 60_000

/** 任务执行状态 → 展示文案 */
function stateText(s: number): string {
  switch (s) {
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
  return ''
}

/** 任务的展示视图 */
export interface UavTaskView {
  id: number
  /** 开始时间 'HH:mm'（从 ISO 串截取） */
  time: string
  name: string
  state: string
  stateClass: string
}

export const useUavStore = defineStore('uav', () => {
  /** 任务执行记录（原始） */
  const records = ref<DroneTaskRecord[]>([])
  /** 机载遥测 */
  const telemetry = ref<DroneTelemetry | null>(null)
  /** 可选航线（真实航线任务，本项目实测 15 条） */
  const routes = ref<DroneRoute[]>([])

  const state = ref<UavState>('idle')
  const error = ref('')
  /** 成功取数的时刻（HH:mm） */
  const updatedAt = ref('')

  let lastFailAt = 0
  let inflight: Promise<void> | null = null

  /** 今天的执行记录（按开始时间倒序） */
  const todayRecords = computed<DroneTaskRecord[]>(() => {
    const today = new Date()
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
    const prefix = `${y}-${m}-${d}`
    return records.value
      .filter((r) => r.start.startsWith(prefix))
      .sort((a, b) => b.start.localeCompare(a.start))
  })

  /** 今日任务（视图） */
  const todayTasks = computed<UavTaskView[]>(() =>
    todayRecords.value.map((r) => ({
      id: r.id,
      time: r.start.slice(11, 16),
      name: r.taskName,
      state: stateText(r.status),
      stateClass: stateClass(r.status),
    })),
  )

  /** 执行中的任务（页面用它显示「当前巡检」进度条） */
  const running = computed<UavTaskView | null>(
    () => todayTasks.value.find((t) => t.stateClass === 'is-ok') ?? null,
  )

  /** 今日已完成任务数 */
  const doneCount = computed(() => todayTasks.value.filter((t) => t.stateClass === 'is-done').length)

  /** 今日任务总数 */
  const totalCount = computed(() => todayTasks.value.length)

  /** 设备参数（机载读数；取不到的字段是 null，页面显示「—」） */
  const live = computed(() => {
    const t = telemetry.value
    return {
      /** 电量 % */
      battery: t?.battery ?? null,
      /** 电池温度 ℃ */
      temp: t?.temp ?? null,
      /** 水平速度 m/s */
      speed: t?.horizontalSpeed ?? null,
      /** 垂直速度 m/s */
      verticalSpeed: t?.verticalSpeed ?? null,
      /** 相对高度 m */
      altitude: t?.altitude ?? null,
      /** 航向角 ° */
      heading: t?.heading ?? null,
      /** 经纬度 */
      lat: t?.lat || null,
      lng: t?.lng || null,
    }
  })

  /**
   * 起飞条件校验。
   *
   * 三态而不是两态：`ok` = 条件满足，`bad` = 明确不满足，
   * `unknown` = **该指标没有数据源**（风速 / 雨量 / 网络速率）。
   *
   * 「没有数据」绝不能算成「条件满足」—— 那是把安全门放松的方向。
   * 未知项会让「可下发」显示为不可下发，并在原因里写明缺哪个指标。
   */
  const checks = computed<{ name: string; ok: boolean; unknown: boolean; risk: string }[]>(() => {
    const l = live.value
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
        name: '水平速度',
        ok: l.speed !== null && l.speed <= 12,
        unknown: l.speed === null,
        risk: '水平速度过高',
      },
      { name: '风速', ok: false, unknown: true, risk: '风速数据未接入' },
      { name: '雨量', ok: false, unknown: true, risk: '雨量数据未接入' },
      { name: '网络质量', ok: false, unknown: true, risk: '网络速率数据未接入' },
    ]
  })

  /** 明确不满足的条件（页面列风险项） */
  const risks = computed(() => checks.value.filter((c) => !c.ok && !c.unknown))

  /** 未知指标（数据未接入） */
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
      return '起飞条件校验通过：电量、电池温度、水平速度符合要求'
    }
    const bad = risks.value.map((c) => c.name)
    const unknown = unknowns.value.map((c) => c.name)
    const parts: string[] = []
    if (bad.length) parts.push(`${bad.join('、')}未达标`)
    if (unknown.length) parts.push(`${unknown.join('、')}数据未接入`)
    return parts.length ? `当前不可下发：${parts.join('；')}` : '当前条件不支持手动下发'
  })

  function stamp(): string {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /**
   * 拉无人机数据。
   *
   * 任务与遥测**各自成败互不影响**：遥测挂了不该让任务列表也变成失败态
   * （任务列表是更基本的信息）。
   */
  async function load(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && state.value === 'ok') return
    if (!force && state.value === 'error' && Date.now() - lastFailAt < RETRY_GAP) return

    state.value = 'loading'
    inflight = (async () => {
      try {
        const list = await fetchTaskRecords({ page: 1, size: 50 })
        records.value = list.rows
        state.value = 'ok'
        error.value = ''
        updatedAt.value = stamp()
        lastFailAt = 0
      } catch (e) {
        state.value = 'error'
        error.value = e instanceof Error ? e.message : '无人机任务加载失败'
        records.value = []
        lastFailAt = Date.now()
      } finally {
        // 遥测与航线是附加信息，各自失败只影响自己，不影响任务列表状态
        try {
          telemetry.value = await fetchTelemetry()
        } catch {
          telemetry.value = null
        }
        try {
          routes.value = await fetchRoutes()
        } catch {
          routes.value = []
        }
        inflight = null
      }
    })()
    return inflight
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
  function apply(recs: DroneTaskRecord[], tel: DroneTelemetry | null = null): void {
    records.value = recs
    telemetry.value = tel
    state.value = 'ok'
    error.value = ''
  }

  /** 退出登录 / 换账号时清空 */
  function reset(): void {
    records.value = []
    telemetry.value = null
    routes.value = []
    state.value = 'idle'
    error.value = ''
    updatedAt.value = ''
    lastFailAt = 0
    clearSession()
  }

  return {
    records,
    telemetry,
    routes,
    state,
    error,
    updatedAt,
    todayRecords,
    todayTasks,
    running,
    doneCount,
    totalCount,
    live,
    checks,
    risks,
    unknowns,
    canDispatch,
    dispatchNote,
    apply,
    load,
    mediaOf,
    reset,
  }
})
