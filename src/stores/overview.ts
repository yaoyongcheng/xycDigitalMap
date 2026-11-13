/**
 * 首页实时数据（大屏 open 只读接口）。
 *
 * 设计口径（2026-11 调整）：**只展示真实数据，不再回落演示值**。
 *
 * 早先的做法是「接口失败就退回 data/config.ts 的演示数字」，理由是不让首页
 * 出现空数字。但现场实际上分不清哪个数是接口来的、哪个是写死的 —— 拿着
 * 「项目人数 160」去对账，服务端其实是 352，比空着更容易出事。现在：
 *   · 取不到就 `null`，页面上显示「—」并给出「暂无数据」提示；
 *   · 每个数据块各自记录状态（idle / ok / error），互不牵连。
 *
 * 三个接口各自独立成败：人员总览挂了不影响班组出勤，反之亦然。所以取数用
 * `Promise.allSettled`，绝不用 `Promise.all` —— 后者一个失败就整组丢结果。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchPersonHour, fetchTeamsAtte, type PersonHour, type TeamAtte } from '@/api/home'
import { fetchPersonOverall, type PersonOverall } from '@/api/overview'
import type { HourLiveData, TrendPoint } from '@/utils/chart'

/** 一次取数到失败后的冷却时间：避免每次进首页都打一遍失败请求 */
const RETRY_GAP = 60_000

/** 数据块状态：idle 还没请求过 / ok 取到了 / error 取失败 */
export type BlockState = 'idle' | 'ok' | 'error'

/**
 * 人员总览四指标的标签与单位（顺序固定）。
 *
 * 只保留「标签」，不再持有演示数值 —— 数值一律来自接口，取不到就是 null。
 */
export const KPI_META: readonly (readonly [string, string])[] = [
  ['人', '项目人数'],
  ['人', '正在上班'],
  ['人', '今日出勤'],
  ['%', '出勤率'],
]

export const useOverviewStore = defineStore('overview', () => {
  /** 最近一次成功的人员总览；null = 尚未成功过 */
  const overall = ref<Partial<PersonOverall> | null>(null)

  /** 今日班组出勤（空数组 = 没取到或确实没有班组） */
  const teams = ref<TeamAtte[]>([])

  /** 今日分时人数；null = 没取到 */
  const hours = ref<PersonHour | null>(null)

  const loading = ref(false)
  const error = ref('')

  /** 各数据块的独立状态（页面据此区分「加载中」与「暂无数据」） */
  const overallState = ref<BlockState>('idle')
  const teamsState = ref<BlockState>('idle')
  const hoursState = ref<BlockState>('idle')

  /** 成功取数的时刻（HH:mm），用于「更新于」 */
  const updatedAt = ref('')

  let lastFailAt = 0
  let inflight: Promise<void> | null = null

  const hasLive = computed(() => overall.value !== null)

  /**
   * 人员总览四指标。
   *
   * 数值取不到就是 `null`（页面渲染成「—」），**不再用演示数值填充** ——
   * 四项各自独立，缺哪项就空哪项，不会出现「三个真数一个假数」但整体看不出
   * 哪个是假的。
   */
  const kpis = computed<[number | null, string, string][]>(() => {
    const o = overall.value
    const pick = (v: number | undefined): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null

    return [
      [pick(o?.managedNum), KPI_META[0][0], KPI_META[0][1]],
      [pick(o?.workingNum), KPI_META[1][0], KPI_META[1][1]],
      [pick(o?.atteNum), KPI_META[2][0], KPI_META[2][1]],
      [pick(o?.atteRate), KPI_META[3][0], KPI_META[3][1]],
    ]
  })

  /**
   * 今日班组出勤：`[班组名, 出勤人数, 出勤率文案]`。
   *
   * 接口没数据就是空数组 —— 页面显示「暂无班组出勤数据」，不再拿演示的
   * 9 个班组顶上去。
   */
  const teamRows = computed<[string, number, string][]>(() =>
    teams.value.map((t) => [t.organName, t.atteNum, `${t.atteRate.toFixed(2)}%`]),
  )

  /**
   * 分时人数曲线的入参；数据不足两个整点时为 undefined（页面显示空态）。
   *
   * 两条系列的小时集合可能不一致（接口里管理/工人各自的整点不完全相同），
   * 这里取并集做横轴，缺的一侧补 0 —— 补 0 而不是 null，因为「该整点这条线
   * 没人」和「该整点没数据」在现场口径上是一回事。
   */
  const hourLive = computed<HourLiveData | undefined>(() => {
    const h = hours.value
    if (!h || h.manager.length < 2 || h.worker.length < 2) return undefined
    const hs = [...new Set([...h.manager.map((p) => p.hour), ...h.worker.map((p) => p.hour)])].sort((a, b) => a - b)
    const align = (arr: PersonHour['manager']): number[] => {
      const map = new Map(arr.map((p) => [p.hour, p.num]))
      return hs.map((x) => map.get(x) ?? 0)
    }
    return { hours: hs, workers: align(h.worker), managers: align(h.manager) }
  })

  /** 近 7 日企业出勤暂未上屏，保留空占位以免调用方误判 */
  const weekTrend = ref<TrendPoint[]>([])

  function stamp(): string {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /**
   * 取数。`force=false` 时遵守失败冷却；并发调用会复用同一个 Promise，
   * 免得首页几个面板同时挂载时打出多份相同请求。
   *
   * 三个接口并发发出（串行会让首屏多等两个 RTT），任一失败只影响它自己那块。
   */
  async function load(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && error.value && Date.now() - lastFailAt < RETRY_GAP) return

    loading.value = true
    inflight = (async () => {
      // allSettled 而不是 all：一个接口 403 不该把另外两块的真实数据一起丢掉
      const [o, t, h] = await Promise.allSettled([fetchPersonOverall(), fetchTeamsAtte(), fetchPersonHour()])

      if (o.status === 'fulfilled') {
        overall.value = o.value
        overallState.value = 'ok'
        // 只要人员总览通了，就认为整组网络/签名是通的
        error.value = ''
        updatedAt.value = stamp()
      } else {
        overallState.value = 'error'
        error.value = o.reason instanceof Error ? o.reason.message : '取数失败'
        lastFailAt = Date.now()
      }
      if (t.status === 'fulfilled') {
        teams.value = t.value
        teamsState.value = 'ok'
      } else {
        teamsState.value = 'error'
      }
      if (h.status === 'fulfilled') {
        hours.value = h.value
        hoursState.value = 'ok'
      } else {
        hoursState.value = 'error'
      }

      loading.value = false
      inflight = null
    })()
    return inflight
  }

  /**
   * 切回智巡面板时的刷新（首页标签切换会调用）。
   *
   * 与 `load(true)` 的区别：**失败冷却仍然生效**。用户在三个标签之间连点时，
   * 弱网下每切一次就打一遍注定失败的请求没有意义；真想立刻重试，页面上
   * 那个「重试」按钮走的是 `load(true)`，会绕过冷却。
   *
   * 已成功取过也要重拉：首页的「更新于 HH:mm」与今日出勤都是会变的，
   * 切回来看到的应该是此刻的数，而不是上次进首页那一刻的数。
   */
  async function refresh(): Promise<void> {
    if (error.value && Date.now() - lastFailAt < RETRY_GAP) return
    return load(true)
  }

  /** 退出登录 / 换账号时清空，避免展示上一个人的现场 */
  function reset(): void {
    overall.value = null
    teams.value = []
    hours.value = null
    overallState.value = 'idle'
    teamsState.value = 'idle'
    hoursState.value = 'idle'
    error.value = ''
    updatedAt.value = ''
    lastFailAt = 0
  }

  return {
    overall,
    teams,
    hours,
    loading,
    error,
    overallState,
    teamsState,
    hoursState,
    updatedAt,
    hasLive,
    kpis,
    teamRows,
    hourLive,
    weekTrend,
    load,
    refresh,
    reset,
  }
})
