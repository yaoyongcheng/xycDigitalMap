/**
 * 首页实时数据（大屏 open 只读接口）。
 *
 * 设计意图：**接口拿不到就退回演示数据**，不让首页出现空数字。
 * 现场网络、接口权限（实测有接口返回 57007「接口权限未获取」）、accessKey 失效
 * 都会导致取数失败，而这些都不该让首页变成一片 0 或转圈 —— 所以这里保存的是
 * 「可选的成功结果」，展示层用计算属性统一做回落。
 *
 * 三个接口各自独立成败：人员总览挂了不影响班组出勤，反之亦然。所以取数用
 * `Promise.allSettled`，绝不用 `Promise.all` —— 后者一个失败就整组丢结果。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchPersonHour, fetchTeamsAtte, type PersonHour, type TeamAtte } from '@/api/home'
import { fetchPersonOverall, type PersonOverall } from '@/api/overview'
import { crewKpis, squadRows } from '@/data/config'
import type { HourLiveData } from '@/utils/chart'

/** 一次取数到失败后的冷却时间：避免每次进首页都打一遍失败请求 */
const RETRY_GAP = 60_000

export const useOverviewStore = defineStore('overview', () => {
  /** 最近一次成功的人员总览；null = 尚未成功过 */
  const overall = ref<Partial<PersonOverall> | null>(null)

  /** 今日班组出勤（空数组 = 还没取到 / 取到空，展示层回落演示数据） */
  const teams = ref<TeamAtte[]>([])

  /** 今日分时人数；null = 还没取到 */
  const hours = ref<PersonHour | null>(null)

  const loading = ref(false)
  const error = ref('')

  /** 成功取数的时刻（HH:mm），用于「更新于」 */
  const updatedAt = ref('')

  let lastFailAt = 0
  let inflight: Promise<void> | null = null

  const hasLive = computed(() => overall.value !== null)

  /**
   * 人员总览四指标。
   *
   * 与 `data/config.ts` 的 `crewKpis` 顺序、单位、标签完全一致，
   * 只是数值优先取接口。任一项缺失就逐项回落，不会出现「三个真数一个假数
   * 但整体错位」的情况。
   */
  const kpis = computed<[number, string, string][]>(() => {
    const o = overall.value
    const pick = (v: number | undefined, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback

    return [
      [pick(o?.managedNum, crewKpis[0][0]), crewKpis[0][1], crewKpis[0][2]],
      [pick(o?.workingNum, crewKpis[1][0]), crewKpis[1][1], crewKpis[1][2]],
      [pick(o?.atteNum, crewKpis[2][0]), crewKpis[2][1], crewKpis[2][2]],
      [Number(pick(o?.atteRate, crewKpis[3][0]).toFixed(1)), crewKpis[3][1], crewKpis[3][2]],
    ]
  })

  /**
   * 今日班组出勤：`[班组名, 出勤人数, 出勤率文案]`，与 `squadRows` 同构。
   *
   * 接口是空的（现场还没建班组）时也回落演示数据 —— 一个空的「今日班组出勤」
   * 卡片比演示数据更容易被误读成「今天没人上班」。
   */
  const teamRows = computed<[string, number, string][]>(() => {
    if (!teams.value.length) return squadRows
    return teams.value.map((t) => [t.organName, t.atteNum, `${t.atteRate.toFixed(2)}%`])
  })

  /**
   * 分时人数曲线的入参；数据不足两个整点时为 undefined（图表回落演示曲线）。
   *
   * 两条系列的小时集合可能不一致（接口里管理/工人各自的整点不完全相同），
   * 这里取并集做横轴，缺的一侧补 0 —— 补 0 而不是 null，因为「该整点这条线
   * 没人」和「该整点没数据」在现场口径上是一回事，画成断线反而像接口缺数据。
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
        error.value = ''
        updatedAt.value = stamp()
      } else {
        error.value = o.reason instanceof Error ? o.reason.message : '取数失败'
        lastFailAt = Date.now()
      }
      if (t.status === 'fulfilled') teams.value = t.value
      if (h.status === 'fulfilled') hours.value = h.value

      loading.value = false
      inflight = null
    })()
    return inflight
  }

  return { overall, teams, hours, loading, error, updatedAt, hasLive, kpis, teamRows, hourLive, load }
})
