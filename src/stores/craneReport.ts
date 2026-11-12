/**
 * 塔机作业报表的数据层（日报 / 周报 / 月报）
 *
 * ## 为什么单独一个 store
 *
 * 报表是详情页里的一个页签，用户会「实时状态 ↔ 作业报表」来回切，而组件在
 * 切走时会被卸载。若取数状态放在组件里，每切一次就要重打一遍接口 —— 月报
 * 一次是三台车 × 200KB 级响应，反复切换会很浪费现场带宽。所以：
 *   · 结果与区间留在 store（跨挂载存活）；
 *   · 同一区间 45s 内复用缓存（`cache`），换粒度才重新查。
 *
 * `cache` 定义在 store 的 setup 里而不是模块级，是为了让每个 pinia 实例
 * （= 每次测试、每次重新登录）拿到干净的一份，不把上一个会话的数字带过来。
 *
 * ## 口径
 *
 * 全部经 `utils/craneReport.ts` 的纯函数（区间、汇总、格式），这里只负责
 * 「按 sn 并发取数 + 丢弃过期结果」。数据源见 `api/towerCrane.ts` 的说明：
 * 与 V2 桌面端报表同一条链路（`getWorkCycleInfoHis`）。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

import { fetchCraneWorkCycles } from '@/api/towerCrane'
import { reportRange, summarize, type ReportRange, type ReportSpan, type UnitStats } from '@/utils/craneReport'
import type { CraneWorkCycle } from '@/types'

/** 同一区间的结果复用时长：足够应付来回切页签，又不至于让数据陈旧过久 */
const TTL = 45_000

/** 取数状态：idle 未请求 / loading 请求中 / ready 有数 / empty 一台都没取到 */
export type ReportState = 'idle' | 'loading' | 'ready' | 'empty'

/** 报表要查的一台机组：id 是台账主键，sn 是塔机平台编号（可能没有） */
export interface ReportUnit {
  id: string
  sn: string | null
}

/** 一台机组的结果；`stats` 为 null = 这台车没取到数（无编号 / 请求失败） */
export interface ReportRow {
  id: string
  stats: UnitStats | null
}

export const useCraneReportStore = defineStore('craneReport', () => {
  const span = ref<ReportSpan>('day')
  const range = ref<ReportRange>(reportRange('day', new Date()))
  const rows = ref<ReportRow[]>([])
  const state = ref<ReportState>('idle')

  /** 区间缓存（键含 sn 与具体日期，换天自然失效） */
  const cache = new Map<string, { at: number; value: CraneWorkCycle[] }>()

  /**
   * 请求序号。
   *
   * 用户快速连点三个页签时，三次请求会并发在飞；先发的反而可能后回。
   * 只认最后一次的结果，避免「月报的数字闪回日报」。
   */
  let seq = 0

  /**
   * 拉一次报表。
   *
   * @param units 当前机组（塔机页面的 set.units 派生，只有 id 与 sn 有用）
   * @param next 目标粒度；默认沿用当前粒度（同粒度重进页面就是刷新）
   *
   * 永不 throw：`fetchCraneWorkCycles` 的失败已经收敛成 null，
   * 这里的 `stats` 也就自然是 null，页面据此显示「—」。
   */
  async function load(units: ReportUnit[], next: ReportSpan = span.value): Promise<void> {
    const token = ++seq
    span.value = next
    range.value = reportRange(next, new Date())
    state.value = 'loading'
    // 清掉上一档的数字：区间文案已经换成新档，留着旧结果会让人把日报的
    // 22 次读成周报的数。缓存命中时下一个微任务就回填，看不到闪
    rows.value = []

    const { start, end, key } = range.value

    const results = await Promise.all(
      units.map(async (unit): Promise<ReportRow> => {
        if (!unit.sn) return { id: unit.id, stats: null }

        const hit = cache.get(`${unit.sn}|${key}`)
        if (hit && Date.now() - hit.at < TTL) return { id: unit.id, stats: summarize(hit.value) }

        const value = await fetchCraneWorkCycles(unit.sn, start, end)
        // 失败不进缓存：让下次重进页面时还能再试一次
        if (value) cache.set(`${unit.sn}|${key}`, { at: Date.now(), value })
        return { id: unit.id, stats: value ? summarize(value) : null }
      }),
    )

    // 过期结果直接丢：它对应的粒度已经被用户换掉了
    if (token !== seq) return

    rows.value = results
    state.value = results.some((r) => r.stats !== null) ? 'ready' : 'empty'
  }

  /** 登出 / 换项目时清空（缓存里的数字属于上一个会话） */
  function reset(): void {
    seq += 1
    cache.clear()
    rows.value = []
    state.value = 'idle'
    span.value = 'day'
    range.value = reportRange('day', new Date())
  }

  return { span, range, rows, state, load, reset }
})
