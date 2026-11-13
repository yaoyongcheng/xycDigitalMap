import type { IotEventRow } from '@/api/iot'
import { parseServerTime, sumWork } from '@/utils/lift'
import type { ReportRange, ReportSpan } from '@/utils/craneReport'

/**
 * 电梯作业报表的聚合口径（纯函数，无网络、无 Vue 依赖）
 *
 * ## 数据源与 V2 的对应关系
 *
 * 唯一来源是 IOT 的 `EVENT_WORKDATA`（每次升降一条，带 `runStartTime` /
 * `runEndTime`）—— 与 V2 电梯历史弹层同一份数据：
 * `ElevatorRequester.QueryWorkCycleHistoryAsync(sn, date, token)`，
 * 行项 `UIItemElevatorHistory` 就是「序号 · 司机 · 开始 · 结束」。
 *
 * V2 **只有单日**历史（`date` 一个参数，一个日期选择器），没有周报月报。
 * 设计稿的日报/周报/月报是示意版式，我们照版式做，区间换成自然日/自然周/
 * 自然月（与塔机报表同一套 `reportRange`，两页的「本周」不会差一天）。
 *
 * ## 「在运时段」为什么是「按天切片再累加」
 *
 * 单日那一格（弹层「今日累计运行时间」、首页「今日运行时长」）用的是 V2 的
 * 首尾跨度：`最后一条.runEndTime − 第一条.runStartTime`。这个量在**单日**下
 * 有意义 —— 就是当天从第一次动到最后一次停的时段。
 *
 * 但直接把它套到区间上会崩：30 天首尾相减 = 从月初第一次运行到月末最后一次
 * 运行 ≈ 整月 720 小时，那不是运行时段的量，那是日历。
 *
 * 所以报表按**运行开始那天**把事件切片，每天各算一次首尾跨度再相加：
 *
 * | 粒度 | 结果 |
 * |---|---|
 * | 日报 | 只有一个日切片 → **与弹层/首页逐字节相同**（V2 口径） |
 * | 周报 | 7 个日切片之和 = 这一周「电梯在运的时段」总量 |
 * | 月报 | 30 个日切片之和 |
 *
 * 日报与 V2 一致是本项目的既定要求（2026-11-13 用户决定），而日切片累加是
 * 那个口径在多天区间上唯一说得通的延伸 —— 每一段都还是「当天的工作时段」。
 *
 * ## 不造的三格
 *
 * 设计稿的「合计载重 / 平均利用率 / 运送人数」在区间维度上**没有数据源**：
 * 载重与人数只有 `EVENT_POST_ATTR` 的瞬时帧（无逐次累计），利用率要台班排班。
 * 所以换成同样来自工作循环、且能逐条核验的三个量：
 * 合计循环 / 在运时段 / 覆盖台数，表格再给「最长单次」「在用天数」。
 *
 * 报表页统称「循环」（设计稿用语），与弹层「今日升降次数」、V2 的 `Data.Count`
 * 是同一个量（事件条数）。
 */

/** 一台笼在区间内的作业指标 */
export interface LiftUnitStats {
  /** 升降次数 = 事件条数（与 V2 `Data.Count` 同口径） */
  trips: number
  /** 在运时段合计（秒）= Σ 每个日切片的首尾跨度 */
  spanSec: number
  /** 最长的一次升降（秒）；一条有效时长都没有 → null */
  maxRunSec: number | null
  /** 有运行记录的天数 */
  days: number
}

/** 全场合计 */
export interface LiftTotals {
  trips: number
  spanSec: number
  /** 区间内真的有运行的台数（0 次不算覆盖） */
  covered: number
}

/** 服务端时间串的日期部分：`'2026-11-13 06:23:53'` → `'2026-11-13'` */
function dayKeyOf(v: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '').trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * 一组工作循环事件 → 四个指标。
 *
 * 分日只看 `runStartTime`：跨零点的升降（23:59 → 00:01）算在开始那天，
 * 一条记录只进一个切片，不会两头都算。
 *
 * 次数按**行数**（含时间缺失的脏行），与 `sumWork`、V2 `Data.Count` 一致；
 * 时长只认 `end > start` 的行，脏数据不造负数。
 */
export function summarizeRange(rows: readonly IotEventRow[]): LiftUnitStats {
  const byDay = new Map<string, IotEventRow[]>()
  let maxRunSec: number | null = null

  for (const r of rows) {
    const day = dayKeyOf(r.resultMap?.runStartTime)
    if (day) {
      const list = byDay.get(day)
      if (list) list.push(r)
      else byDay.set(day, [r])
    }

    const start = parseServerTime(r.resultMap?.runStartTime)
    const end = parseServerTime(r.resultMap?.runEndTime)
    if (start === null || end === null || end <= start) continue
    const dur = (end - start) / 1000
    if (maxRunSec === null || dur > maxRunSec) maxRunSec = dur
  }

  let spanSec = 0
  for (const list of byDay.values()) spanSec += sumWork(list).seconds

  return {
    trips: rows.length,
    spanSec: Math.round(spanSec),
    maxRunSec,
    days: byDay.size,
  }
}

/**
 * 多台 → 全场合计。
 *
 * `null`（这台没取到数）**不进合计** —— 少算一台的合计比「—」更容易被当真，
 * 所以报表的结论区必须同时说清「有几台没纳入」。
 */
export function liftTotals(list: (LiftUnitStats | null)[]): LiftTotals {
  const rows = list.filter((s): s is LiftUnitStats => s !== null)
  return {
    trips: rows.reduce((sum, s) => sum + s.trips, 0),
    spanSec: rows.reduce((sum, s) => sum + s.spanSec, 0),
    covered: rows.filter((s) => s.trips > 0).length,
  }
}

/* ---------------- 展示格式 ---------------- */

/** 在运时段 → 「数字 + 单位」两段（KPI 与表格共用一套排版，写法与塔机报表一致） */
export function formatSpan(sec: number | null): { n: string; u: string } {
  if (sec === null) return { n: '—', u: '' }
  // 0 秒是有效结论（区间内确实没跑），照写「0分」；不像塔机那样抬到 1 分钟
  if (sec <= 0) return { n: '0', u: '分' }
  if (sec < 3600) return { n: String(Math.round(sec / 60)), u: '分' }
  return { n: (sec / 3600).toFixed(1), u: 'h' }
}

/** 在运时段的合并文本（表格 / 分享文案用） */
export function spanText(sec: number | null): string {
  const { n, u } = formatSpan(sec)
  return u ? `${n}${u}` : n
}

/** 天数 → `12天`；0 天不写（那是「这台没跑过」，由调用方给「—」） */
export function formatDays(n: number | null): string {
  return n === null || n <= 0 ? '—' : `${n}天`
}

/** 占比（四舍五入到整数百分比） */
export function share(part: number, total: number): number {
  return total ? Math.round((part / total) * 100) : 0
}

export type { ReportRange, ReportSpan }
