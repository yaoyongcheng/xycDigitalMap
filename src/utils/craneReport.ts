import type { CraneWorkCycle } from '@/types'
import { CRANE_RATED_T } from '@/utils/craneLoad'
import { addDays, dateKey, formatMD, monthStart, sameDay, startOfDay } from '@/utils/date'

/**
 * 塔机作业报表的口径与聚合（纯函数，无副作用）
 *
 * ## 数据来自哪里
 *
 * 唯一的源是塔机平台的工作循环接口（`api/towerCrane.ts` 的
 * `getWorkCycleInfoHis`），也就是 V2 桌面端算报表用的那一份：
 * `CraneWorkCycleRequester.QueryAllWorkCycleHistoryAsync(startDate, endDate)`
 * → 逐台 `QueryWorkCycleHistoryAsync(deviceSn, startDate, endDate)`。
 *
 * **V2 的报表界面里没有「利用率」和「负荷」**（`UICraneHistoryPop` 的 IL 只读
 * 工作循环：图表是「吊次 / 吊重」两条序列，列表行是「时间 · 时长 · 重量 ·
 * 幅度 · 角度 · 力矩」）。设计稿那两格是示意图里的占位值，现场没有任何接口
 * 能算出来。所以这里不造指标，改成同样来自工作循环、且能核验的两项：
 *   · `利用率` → **作业时长**（Σ 每次循环的 `duration`）
 *   · `负荷`   → **峰值吊重**（单次循环的最大吊重）
 *
 * ## 区间的口径（照 V2 `UICraneHistoryPop.GetStartDate/GetEndDate`）
 *
 *   日报 = 当天
 *   周报 = 自然周（周一起，到周日）—— 不是「近 7 天」
 *   月报 = 自然月（1 号到月末）  —— 不是「近 30 天」
 *
 * V2 是按自然周期算的，报表要与桌面端对得上就照它来；跨月区间服务端已实测
 * 支持（一次退回 474 条）。
 */

/** 报表粒度 */
export type ReportSpan = 'day' | 'week' | 'month'

export interface ReportRange {
  /** 缓存键：`yyyy-mm-dd~yyyy-mm-dd` */
  key: string
  /** 区间首日 00:00 */
  start: Date
  /** 区间末日 00:00（含当天，发给接口时会被拼成 24:00:00） */
  end: Date
  /** 展示文案：`2026-11-12` / `2026-11-09 至 11-15` */
  text: string
}

/** 空值统一写「—」：不写 0、不写「暂无」 */
export const DASH = '—'

/** 某台塔机在一段区间内的作业指标 */
export interface UnitStats {
  /** 吊次（工作循环条数）；0 是有效结论（接口通了、确实没吊） */
  trips: number
  /** 吊重合计（t）；一条循环都没带重量 → null */
  weight: number | null
  /** 单次循环的最大吊重（t）；同上 → null */
  maxWeight: number | null
  /** 作业时长合计（秒）；一条都没有时长 → null */
  workSec: number | null
}

/**
 * 区间计算。
 *
 * @param span 粒度
 * @param today 「今天」基准（由调用方注入，便于测试与原型日期统一）
 */
export function reportRange(span: ReportSpan, today: Date): ReportRange {
  const t = startOfDay(today)

  if (span === 'day') {
    return { key: `${dateKey(t)}~${dateKey(t)}`, start: t, end: t, text: dateKey(t) }
  }

  if (span === 'week') {
    // getDay(): 周日是 0。换算成「周一是 0」再回退，得到本周一
    const back = (t.getDay() + 6) % 7
    const start = addDays(t, -back)
    const end = addDays(start, 6)
    return {
      key: `${dateKey(start)}~${dateKey(end)}`,
      start,
      end,
      text: `${dateKey(start)} 至 ${dateKey(end).slice(5)}`,
    }
  }

  const start = monthStart(t)
  // 下个月的第 0 天 = 本月最后一天
  const end = startOfDay(new Date(start.getFullYear(), start.getMonth() + 1, 0))
  return {
    key: `${dateKey(start)}~${dateKey(end)}`,
    start,
    end,
    text: `${dateKey(start)} 至 ${dateKey(end).slice(5)}`,
  }
}

/** 两位小数取整（浮点累加会出 4.970000000000001 这种尾巴） */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 一组工作循环 → 四个指标。
 *
 * 三条规矩：
 *   ① `trips` 数的是**条数**，与字段完整度无关 —— 一条没有重量的循环仍然是
 *      吊了一次；
 *   ② 重量 / 时长**分开累加**：有重量的才进吊重，有时长的才进作业时长，
 *      一条都没有时给 `null`（不是 0）；
 *   ③ 峰值吊重取单次最大，不是合计。
 */
export function summarize(list: CraneWorkCycle[]): UnitStats {
  let weight = 0
  let weighed = 0
  let maxWeight: number | null = null
  let workSec = 0
  let worked = 0

  for (const c of list) {
    if (c.weight !== null) {
      weight += c.weight
      weighed += 1
      if (maxWeight === null || c.weight > maxWeight) maxWeight = c.weight
    }
    if (c.duration !== null) {
      workSec += c.duration
      worked += 1
    }
  }

  return {
    trips: list.length,
    weight: weighed ? round2(weight) : null,
    maxWeight,
    // 秒已经逐条取整过，这里只是去掉可能的浮点尾巴
    workSec: worked ? Math.round(workSec) : null,
  }
}

/** 全场合计（只统计拿得到数的机组） */
export interface ReportTotals {
  trips: number
  weight: number | null
  workSec: number | null
}

/**
 * 多台机组 → 全场合计。
 *
 * `stats` 为 null 的机组（没有平台编号 / 请求失败）**不进合计** ——
 * 少算一台的合计比「—」更容易被当真，所以调用方要同时把「有几台没纳入」
 * 说清楚（报表的结论区就是干这个的）。
 */
export function totals(list: (UnitStats | null)[]): ReportTotals {
  const rows = list.filter((s): s is UnitStats => s !== null)
  let weight = 0
  let weighed = 0
  let workSec = 0
  let worked = 0
  for (const s of rows) {
    if (s.weight !== null) {
      weight += s.weight
      weighed += 1
    }
    if (s.workSec !== null) {
      workSec += s.workSec
      worked += 1
    }
  }
  return {
    trips: rows.reduce((sum, s) => sum + s.trips, 0),
    weight: weighed ? round2(weight) : null,
    workSec: worked ? workSec : null,
  }
}

/* ---------------- 展示格式 ---------------- */

/** 吨位：`8.72t`，没有值「—」 */
export function formatTons(v: number | null): string {
  return v === null ? DASH : `${v.toFixed(2)}t`
}

/**
 * 作业时长：拆成「数字 + 单位」两段，好让 KPI 与表格共用同一套排版。
 *
 * 不足 1 小时按分钟（日报常见 18 分钟，写成 0.3h 读不出量级），
 * 超过 1 小时按小时保留一位小数。
 */
export function formatWork(sec: number | null): { n: string; u: string } {
  if (sec === null) return { n: DASH, u: '' }
  if (sec < 3600) return { n: String(Math.max(1, Math.round(sec / 60))), u: '分' }
  return { n: (sec / 3600).toFixed(1), u: 'h' }
}

/** 作业时长的合并文本（表格 / 分享文案用） */
export function workText(sec: number | null): string {
  const { n, u } = formatWork(sec)
  return u ? `${n}${u}` : n
}

/** 占比（四舍五入到整数百分比） */
export function share(part: number, total: number): number {
  return total ? Math.round((part / total) * 100) : 0
}

/* ---------------- 周期切换（选日期） ---------------- */

/**
 * 该日所在自然周的周一。
 *
 * `getDay()` 里周日是 0，先换成「周一 = 0」再回退。报表的周口径与
 * `reportRange('week')`、V2 `GetStartDate` 完全一致，这里只是把同一个
 * 起算点单独暴露出来给日历铺格子用。
 */
export function weekStartOf(d: Date): Date {
  const t = startOfDay(d)
  return addDays(t, -((t.getDay() + 6) % 7))
}

/** 预设芯片文案：今天 / 本周 / 本月 */
export function presetLabel(span: ReportSpan): string {
  if (span === 'day') return '今天'
  return span === 'week' ? '本周' : '本月'
}

/** `anchor` 是否就落在今天所在的那个周期（预设芯片是否高亮） */
export function isCurrentPeriod(span: ReportSpan, anchor: Date, today: Date = new Date()): boolean {
  return reportRange(span, anchor).key === reportRange(span, today).key
}

/** 「选日期」芯片上的文案：MM/DD · MM/DD–MM/DD · YYYY年M月 */
export function periodText(span: ReportSpan, anchor: Date): string {
  if (span === 'day') return formatMD(anchor)
  if (span === 'week') {
    const start = weekStartOf(anchor)
    return `${formatMD(start)}–${formatMD(addDays(start, 6))}`
  }
  const d = startOfDay(anchor)
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}

/** 周列表的一项（周报的「选日期」用小格子铺一周一行） */
export interface WeekOption {
  /** 该周周一（点它就是新的 anchor） */
  anchor: Date
  /** `11/10–11/16` */
  text: string
  /** 是否就是当前区间 */
  on: boolean
  /** 还没到（未来的周不给选） */
  disabled: boolean
}

/**
 * 某个月里的所有自然周（含跨月那两周）。
 *
 * 从「1 号所在周的周一」铺到「月末所在周」，与设计稿的 `.report-weeks`
 * 一致：一个月通常 5 行，最多 6 行。
 */
export function weekOptions(month: Date, anchor: Date, today: Date = new Date()): WeekOption[] {
  const m = monthStart(month)
  const last = startOfDay(new Date(m.getFullYear(), m.getMonth() + 1, 0))
  const picked = weekStartOf(anchor).getTime()
  const limit = startOfDay(today).getTime()
  const out: WeekOption[] = []
  for (let start = weekStartOf(m); start.getTime() <= last.getTime(); start = addDays(start, 7)) {
    out.push({
      anchor: start,
      text: `${formatMD(start)}–${formatMD(addDays(start, 6))}`,
      on: start.getTime() === picked,
      disabled: start.getTime() > limit,
    })
  }
  return out
}

/** 月份列表的一项（月报的「选日期」用 4×3 网格） */
export interface MonthOption {
  /** 该月 1 号 */
  anchor: Date
  /** `11月` */
  text: string
  on: boolean
  disabled: boolean
}

/** 某年的 12 个月，未来的月份不给选（与周列表同一口径） */
export function monthOptions(year: number, anchor: Date, today: Date = new Date()): MonthOption[] {
  const limit = monthStart(today).getTime()
  const picked = monthStart(anchor).getTime()
  return Array.from({ length: 12 }, (_, i) => {
    const d = startOfDay(new Date(year, i, 1))
    return { anchor: d, text: `${i + 1}月`, on: d.getTime() === picked, disabled: d.getTime() > limit }
  })
}

/** 某天是否落在 `[start, end]` 里（日期选中态判断） */
export function inRange(d: Date, start: Date, end: Date): boolean {
  const t = startOfDay(d).getTime()
  return t >= startOfDay(start).getTime() && t <= startOfDay(end).getTime()
}

/* ---------------- 明细分析（分布可视化 + 风险分析） ---------------- */

/** 一个分箱：标签 + 条数 */
export interface Bin {
  label: string
  value: number
}

/**
 * 载荷分箱（吨）：步长 0.5，左闭右开
 *
 * `[0,0.5) [0.5,1) [1,1.5) [1.5,2) [2,2.5) [2.5,3) [3,+∞)`
 *
 * 2026-11-25 现场按截图改定：原来的 `0–1 … 4–5 / ≥5` 六箱太粗 —— 现场绝大多数
 * 吊重在 0.5–3t 之间，六箱里有三箱基本是 0，看不出分布形状。换成 0.5 一档
 * 后前六箱覆盖 0–3t，最后一箱是「3t 及以上」的开区间。
 *
 * 边界统一**左闭右开**：恰好 1.0 落进 `[1,1.5)`，恰好 0.5 落进 `[0.5,1)` ——
 * 同一个数只会进一个箱，不会出现「1 吨算在 0–1 也算在 1–2」。
 */
const LOAD_LABELS = ['0–0.5', '0.5–1', '1–1.5', '1.5–2', '2–2.5', '2.5–3', '≥3']
/** 载荷分箱宽度（吨）—— 与 `LOAD_LABELS` 一一对应，改标签必须同步改这个 */
const LOAD_STEP_T = 0.5
/**
 * 时长分箱（分钟）：步长 2，左闭右开
 *
 * `[0,2) [2,4) [4,6) [6,8) [8,10) [10,12) [12,14) [14,+∞)`
 *
 * 2026-11-25 现场按截图改定：原来的 `<1 / 1–2 / 2–3 / 3–5 / 5–10 / ≥10`
 * 六箱档距不齐（1/1/1/2/5/开区间），中间两箱太宽，看不出 10 分钟附近的形状。
 * 换成统一 2 分钟一档后，八箱覆盖 0–14 分钟，最后一箱是「14 分钟及以上」。
 *
 * 边界同样**左闭右开**：恰好 2 分钟落进 `[2,4)`、恰好 14 分钟落进最后一箱。
 */
const DUR_LABELS = ['0–2', '2–4', '4–6', '6–8', '8–10', '10–12', '12–14', '≥14']
/** 时长分箱宽度（秒）—— 2 分钟 = 120s；用秒算，避免先除 60 再除 2 的浮点误差 */
const DUR_STEP_SEC = 120
/** 夜间时段：22 点到次日 5 点（设计稿口径） */
const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4, 5])

/**
 * 一段工作循环明细 → 分布 + 风险指标。
 *
 * 全部来自**同一条链路**的原始记录（`api/towerCrane.ts` 的 `getWorkCycleInfoHis`），
 * 不引入任何新数据源、也不补任何占位值：
 *   · 小时分布 —— 每条循环的 `start` 落在哪个小时；
 *   · 载荷分布 —— 每条循环的 `weight` 落在哪个吨位箱；
 *   · 时长分布 —— 每条循环的 `duration` 落在哪个分钟箱；
 *   · 夜间 / 超重 —— 由上面两个字段直接判定（超重 = 单次吊重 ≥ 额定 5t）。
 *
 * 缺字段的记录**不进对应的箱**（没有时间戳就不知道落在哪个小时），
 * 但仍然是「吊了一次」—— 吊次由 `summarize()` 单独数，不由这里负责。
 */
export interface CycleAnalysis {
  /** 24 个小时桶（label 为 00…23） */
  hours: Bin[]
  /** 载荷分箱（吨） */
  loads: Bin[]
  /** 时长分箱（分钟） */
  durs: Bin[]
  /** 吊次最多的小时（并列时全部给出）；一条有时间戳的都没有 → 空数组 */
  peakHours: number[]
  /** 高峰小时的吊次 */
  peakCount: number
  /** 22–5 时的吊次 */
  night: number
  /** 夜间占「有时间戳的吊次」的百分比（一位小数） */
  nightPct: number
  /** 达到额定 5t 的次数 */
  over: number
  /** 单次最大吊重（t） */
  overMax: number | null
  /** 平均单次吊重（t，只统计带重量的记录） */
  avgWeight: number | null
  /** 平均单次作业时长（秒） */
  avgDurSec: number | null
  /** 平均载荷利用率（平均吊重 ÷ 额定 5t，百分比一位小数） */
  utilPct: number | null
}

/**
 * 落哪一箱（左闭右开）。
 *
 * `Math.floor(w / 0.5)`：0.5 是二进制精确值，除它等于乘 2（同样精确），
 * 所以 0.5 / 1 / 1.5 / 2 / 2.5 这些边界值不会因为浮点误差掉到前一箱。
 * 0.4999 → 0、0.5 → 1、1.0 → 2、1.4999 → 2、1.5 → 3，依此类推；
 * 3 及以上统一进最后一箱（开区间，没有上限）。
 */
function loadBinOf(w: number): number {
  const last = LOAD_LABELS.length - 1
  if (w >= LOAD_STEP_T * last) return last
  const i = Math.floor(w / LOAD_STEP_T)
  return Math.max(0, Math.min(last - 1, i))
}

/**
 * 时长落哪一箱（左闭右开，2 分钟一档）。
 *
 * 全程按**秒**算：`120` 与 `840` 都是精确整数，`Math.floor(sec / 120)` 不会像
 * 「先除 60 变成分钟、再除 2」那样在恰好 2 / 4 / 6… 分钟时掉一箱。
 * 恰好 14 分钟（840s）进最后一箱；脏数据（负数）夹回第 0 箱。
 */
function durBinOf(sec: number): number {
  const last = DUR_LABELS.length - 1
  if (sec >= DUR_STEP_SEC * last) return last
  return Math.max(0, Math.min(last - 1, Math.floor(sec / DUR_STEP_SEC)))
}

export function analyze(list: CraneWorkCycle[]): CycleAnalysis {
  const hours: Bin[] = Array.from({ length: 24 }, (_, h) => ({
    label: String(h).padStart(2, '0'),
    value: 0,
  }))
  const loads: Bin[] = LOAD_LABELS.map((label) => ({ label, value: 0 }))
  const durs: Bin[] = DUR_LABELS.map((label) => ({ label, value: 0 }))

  let stamped = 0
  let night = 0
  let weightSum = 0
  let weighed = 0
  let durSum = 0
  let timed = 0
  let over = 0
  let overMax: number | null = null

  for (const c of list) {
    if (c.start !== null) {
      const h = new Date(c.start).getHours()
      if (h >= 0 && h < 24) {
        hours[h].value += 1
        stamped += 1
        if (NIGHT_HOURS.has(h)) night += 1
      }
    }
    if (c.weight !== null) {
      weightSum += c.weight
      weighed += 1
      loads[loadBinOf(c.weight)].value += 1
      if (c.weight >= CRANE_RATED_T) over += 1
      if (overMax === null || c.weight > overMax) overMax = c.weight
    }
    if (c.duration !== null) {
      durSum += c.duration
      timed += 1
      durs[durBinOf(c.duration)].value += 1
    }
  }

  let peakCount = 0
  for (const b of hours) if (b.value > peakCount) peakCount = b.value
  const peakHours = peakCount
    ? hours.map((b, h) => (b.value === peakCount ? h : -1)).filter((h) => h >= 0)
    : []

  const avgWeight = weighed ? round2(weightSum / weighed) : null
  const avgDurSec = timed ? Math.round(durSum / timed) : null
  const utilPct =
    avgWeight === null ? null : Math.round((avgWeight / CRANE_RATED_T) * 1000) / 10

  return {
    hours,
    loads,
    durs,
    peakHours,
    peakCount,
    night,
    nightPct: stamped ? Math.round((night / stamped) * 1000) / 10 : 0,
    over,
    overMax,
    avgWeight,
    avgDurSec,
    utilPct,
  }
}

/** 高峰小时的文案：`9时、14时`（没有吊次时给空串，由调用方写占位） */
export function peakHourText(hours: number[]): string {
  return hours.map((h) => `${h}时`).join('、')
}

/** 分钟数 → `3.5`（一位小数） */
export function minutesOf(sec: number | null): string {
  return sec === null ? DASH : (sec / 60).toFixed(1)
}

/** 一位小数百分比，null 写「—」 */
export function percentText(v: number | null): string {
  return v === null ? DASH : `${v.toFixed(1)}%`
}

/* ---------------- 图表的横轴刻度 ---------------- */

/**
 * 横轴标签：纯数字的去掉前导 0（`01` → `1`、`09` → `9`，`10` 及以上原样）。
 *
 * 24 小时桶原来的标签是 `00/01/…/23`，每个都多占一个字宽，是横轴糊成一条
 * 黑边的一半原因（另一半是 24 个标签全画）。非纯数字的标签（载荷的 `0–1`、
 * 时长的 `<1`）原样返回 —— 那里没有前导 0 可去，也不该被 `Number()` 拆坏。
 */
export function axisLabel(label: string): string {
  return /^\d+$/.test(label) ? String(Number(label)) : label
}

/**
 * 横轴标签的抽稀步长。
 *
 * 判定只看格数，不看像素：同一套步长在页面（窄屏 ~300pt）与长图（750px）
 * 上必须一致，否则「导出的图」与「看到的图」刻度对不上。
 *
 * 24 小时这种密桶（≥20 格）每 2 格标一个 → `0 2 4 … 22` 共 12 个；
 * 载荷 / 时长分箱只有 6 格，全部标出。
 */
export function axisStep(n: number): number {
  return n >= 20 ? 2 : 1
}

/** 两个日期是否同一周（供日历高亮） */
export function sameWeek(a: Date, b: Date): boolean {
  return sameDay(weekStartOf(a), weekStartOf(b))
}
