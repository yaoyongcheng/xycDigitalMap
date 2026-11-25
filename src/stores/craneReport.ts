/**
 * 塔机作业报表的数据层（日报 / 周报 / 月报）
 *
 * ## 为什么单独一个 store
 *
 * 报表是详情页里的一个页签，用户会「实时状态 ↔ 作业报表」来回切，而组件在
 * 切走时会被卸载。若取数状态放在组件里，每切一次就要重打一遍接口 —— 月报
 * 一次是三台车 × 200KB 级响应，反复切换会很浪费现场带宽。所以：
 *   · 结果与区间留在 store（跨挂载存活）；
 *   · 同一区间 45s 内复用缓存（`cache`），换粒度 / 换周期才重新查。
 *
 * `cache` 定义在 store 的 setup 里而不是模块级，是为了让每个 pinia 实例
 * （= 每次测试、每次重新登录）拿到干净的一份，不把上一个会话的数字带过来。
 *
 * ## 为什么留原始明细
 *
 * 2026-11-25 报表改版（对齐标准版）后，页面除了合计还要画「时段 / 载荷 /
 * 时长」三张分布图与夜间、超重两项风险 —— 这些只能从**每条循环**算出来，
 * 汇总过的四个数不够用。所以 `series` 留着接口原样返回的数组（每台几百条
 * 小对象，月报三台也就几百 KB），`rows` 仍是给表格与合计用的汇总。
 *
 * ## 口径
 *
 * 全部经 `utils/craneReport.ts` 的纯函数（区间、汇总、分箱），这里只负责
 * 「按 sn 并发取数 + 丢弃过期结果」。数据源见 `api/towerCrane.ts` 的说明：
 * 与 V2 桌面端报表同一条链路（`getWorkCycleInfoHis`）。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

import { fetchCraneWorkCycles } from '@/api/towerCrane'
import { reportRange, summarize, type ReportRange, type ReportSpan, type UnitStats } from '@/utils/craneReport'
import { startOfDay } from '@/utils/date'
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

/** 一台机组的原始明细（分布图 / 风险分析用）；没取到数时是空数组 */
export interface ReportSeries {
  id: string
  cycles: CraneWorkCycle[]
}

export const useCraneReportStore = defineStore('craneReport', () => {
  /**
   * 默认粒度是周报。
   *
   * 2026-11-25 报表页按现场要求去掉「日报」这一档（只剩周报 / 月报），
   * 而 `ReportSpan` 仍保留 `'day'` —— 区间工具、缓存键、单测都还认它，
   * 将来要恢复日报只改页面上的两颗按钮即可。
   */
  const span = ref<ReportSpan>('week')
  /**
   * 用户选的「哪一天 / 哪一周 / 哪一月」。
   *
   * 只存锚点日期，具体区间一律由 `reportRange(span, anchor)` 现算 ——
   * 这样切粒度时不用重算边界（月报 10/05 → 日报就是 10/05 那天）。
   */
  const anchor = ref<Date>(startOfDay(new Date()))
  const range = ref<ReportRange>(reportRange('week', anchor.value))
  const rows = ref<ReportRow[]>([])
  const series = ref<ReportSeries[]>([])
  const state = ref<ReportState>('idle')

  /** 区间缓存（键含 sn 与具体日期，换周期自然失效） */
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
   * @param day 周期锚点；默认沿用已选周期
   *
   * 永不 throw：`fetchCraneWorkCycles` 的失败已经收敛成 null，
   * 这里的 `stats` 也就自然是 null，页面据此显示「—」。
   */
  async function load(
    units: ReportUnit[],
    next: ReportSpan = span.value,
    day: Date = anchor.value,
  ): Promise<void> {
    const token = ++seq
    span.value = next
    anchor.value = startOfDay(day)
    range.value = reportRange(next, anchor.value)
    state.value = 'loading'
    // 清掉上一档的数字：区间文案已经换成新档，留着旧结果会让人把日报的
    // 22 次读成周报的数。缓存命中时下一个微任务就回填，看不到闪
    rows.value = []
    series.value = []

    const { start, end, key } = range.value

    const results = await Promise.all(
      units.map(async (unit): Promise<{ row: ReportRow; list: CraneWorkCycle[] }> => {
        if (!unit.sn) return { row: { id: unit.id, stats: null }, list: [] }

        const hit = cache.get(`${unit.sn}|${key}`)
        if (hit && Date.now() - hit.at < TTL) {
          return { row: { id: unit.id, stats: summarize(hit.value) }, list: hit.value }
        }

        const value = await fetchCraneWorkCycles(unit.sn, start, end)
        // 失败不进缓存：让下次重进页面时还能再试一次
        if (value) cache.set(`${unit.sn}|${key}`, { at: Date.now(), value })
        return { row: { id: unit.id, stats: value ? summarize(value) : null }, list: value ?? [] }
      }),
    )

    // 过期结果直接丢：它对应的粒度已经被用户换掉了
    if (token !== seq) return

    rows.value = results.map((r) => r.row)
    series.value = results.map((r, i) => ({ id: units[i].id, cycles: r.list }))
    state.value = results.some((r) => r.row.stats !== null) ? 'ready' : 'empty'
  }

  /** 登出 / 换项目时清空（缓存里的数字属于上一个会话） */
  function reset(): void {
    seq += 1
    cache.clear()
    rows.value = []
    series.value = []
    state.value = 'idle'
    span.value = 'week'
    anchor.value = startOfDay(new Date())
    range.value = reportRange('week', anchor.value)
  }

  return { span, anchor, range, rows, series, state, load, reset }
})
