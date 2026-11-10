/**
 * 首页实时数据（大屏 open 只读接口）。
 *
 * 设计意图：**接口拿不到就退回演示数据**，不让首页出现空数字。
 * 现场网络、接口权限（实测有接口返回 57007「接口权限未获取」）、accessKey 失效
 * 都会导致取数失败，而这些都不该让首页变成一片 0 或转圈 —— 所以这里保存的是
 * 「可选的成功结果」，展示层用 `kpis` 计算属性统一做回落。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchPersonOverall, type PersonOverall } from '@/api/overview'
import { crewKpis } from '@/data/config'

/** 一次取数到失败后的冷却时间：避免每次进首页都打一遍失败请求 */
const RETRY_GAP = 60_000

export const useOverviewStore = defineStore('overview', () => {
  /** 最近一次成功的人员总览；null = 尚未成功过 */
  const overall = ref<Partial<PersonOverall> | null>(null)

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

  function stamp(): string {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /**
   * 取数。`force=false` 时遵守失败冷却；并发调用会复用同一个 Promise，
   * 免得首页几个面板同时挂载时打出多份相同请求。
   */
  async function load(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && error.value && Date.now() - lastFailAt < RETRY_GAP) return

    loading.value = true
    inflight = (async () => {
      try {
        const data = await fetchPersonOverall()
        overall.value = data
        error.value = ''
        updatedAt.value = stamp()
      } catch (e) {
        error.value = e instanceof Error ? e.message : '取数失败'
        lastFailAt = Date.now()
      } finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }

  return { overall, loading, error, updatedAt, hasLive, kpis, load }
})
