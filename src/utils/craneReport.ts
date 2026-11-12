import type { CraneWorkCycle } from '@/types'
import { addDays, dateKey, monthStart, startOfDay } from '@/utils/date'

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
