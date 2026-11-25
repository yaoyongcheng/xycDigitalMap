import { describe, expect, it } from 'vitest'

import {
  analyze,
  axisLabel,
  axisStep,
  isCurrentPeriod,
  monthOptions,
  peakHourText,
  periodText,
  reportRange,
  summarize,
  weekOptions,
  weekStartOf,
} from '@/utils/craneReport'
import type { CraneWorkCycle } from '@/types'

/**
 * 作业报表的纯函数（2026-11-25 对齐标准版时新增）
 *
 * 这组守的是「分布 / 风险」这类派生指标的口径：分箱边界、夜间时段、
 * 超重判定、均值分母。它们直接印在报表上，错了不会报错、只会静静显示
 * 一个看起来合理的数字 —— 正是最该被用例钉住的那类逻辑。
 */

/** 'yyyy-MM-dd HH:mm:ss' → 工作循环（本地时区，与 api/towerCrane.ts 的解析一致） */
function cycle(start: string | null, weight: number | null, duration: number | null): CraneWorkCycle {
  return {
    start: start === null ? null : Date.parse(start.replace(/-/g, '/')),
    end: null,
    weight,
    duration,
    type: '',
  }
}

describe('reportRange 周期口径', () => {
  // 2026-11-25 是周三
  const today = new Date(2026, 10, 25)

  it('日报 = 当天', () => {
    const r = reportRange('day', today)
    expect(r.key).toBe('2026-11-25~2026-11-25')
    expect(r.text).toBe('2026-11-25')
  })

  it('周报 = 自然周（周一起算），不是近 7 天', () => {
    const r = reportRange('week', today)
    expect(r.key).toBe('2026-11-23~2026-11-29')
    expect(r.text).toBe('2026-11-23 至 11-29')
  })

  it('月报 = 自然月（1 号到月末）', () => {
    const r = reportRange('month', today)
    expect(r.key).toBe('2026-11-01~2026-11-30')
  })

  it('周一起点：周一当天回到自己，周日回到本周一', () => {
    expect(weekStartOf(new Date(2026, 10, 23)).getDate()).toBe(23)
    expect(weekStartOf(new Date(2026, 10, 29)).getDate()).toBe(23)
  })
})

describe('周期文案与预设判定', () => {
  const today = new Date(2026, 10, 25)

  it('periodText：日报 MM/DD、周报区间、月报年月', () => {
    expect(periodText('day', new Date(2026, 10, 12))).toBe('11/12')
    expect(periodText('week', new Date(2026, 10, 12))).toBe('11/09–11/15')
    expect(periodText('month', new Date(2026, 10, 12))).toBe('2026年11月')
  })

  it('isCurrentPeriod：落在今天所在周期才算预设', () => {
    expect(isCurrentPeriod('week', new Date(2026, 10, 23), today)).toBe(true)
    expect(isCurrentPeriod('week', new Date(2026, 10, 16), today)).toBe(false)
    expect(isCurrentPeriod('month', new Date(2026, 10, 1), today)).toBe(true)
    expect(isCurrentPeriod('month', new Date(2026, 9, 1), today)).toBe(false)
  })
})

describe('日历选项', () => {
  const today = new Date(2026, 10, 25)

  it('周列表：跨月那两周也在（11 月 6 行），未来的周不可选', () => {
    // 2026-11-01 是周日 → 首周从 10/26 起；11/30 是周一 → 末周跨进 12 月
    const list = weekOptions(new Date(2026, 10, 1), new Date(2026, 10, 12), today)
    expect(list.map((w) => w.text)).toEqual([
      '10/26–11/01',
      '11/02–11/08',
      '11/09–11/15',
      '11/16–11/22',
      '11/23–11/29',
      '11/30–12/06',
    ])
    expect(list.filter((w) => w.disabled).map((w) => w.text)).toEqual(['11/30–12/06'])
    expect(list.find((w) => w.on)?.text).toBe('11/09–11/15')
  })

  it('周列表：整月都在未来时全部 disabled', () => {
    // 站在 11/25 看 12 月：12/07 起的那几周还没到，11/30 那周也还没到
    const list = weekOptions(new Date(2026, 11, 1), new Date(2026, 11, 1), today)
    expect(list[0].text).toBe('11/30–12/06')
    expect(list.every((w) => w.disabled)).toBe(true)
  })

  it('月网格：12 个月，当月之后 disabled', () => {
    const list = monthOptions(2026, new Date(2026, 10, 12), today)
    expect(list).toHaveLength(12)
    expect(list[10].on).toBe(true)
    expect(list[10].text).toBe('11月')
    expect(list[11].disabled).toBe(true)
    expect(list[0].disabled).toBe(false)
  })
})

describe('analyze 明细分析', () => {
  const list = [
    cycle('2026-11-12 09:00:00', 2.5, 180),
    cycle('2026-11-12 22:30:00', 5.5, 600),
    cycle('2026-11-13 03:10:00', 0.8, 30),
  ]

  it('小时分布：只统计有时间戳的吊次', () => {
    const a = analyze(list)
    expect(a.hours).toHaveLength(24)
    expect(a.hours[9].value).toBe(1)
    expect(a.hours[22].value).toBe(1)
    expect(a.hours[3].value).toBe(1)
    expect(a.hours.reduce((s, b) => s + b.value, 0)).toBe(3)
  })

  it('高峰时段：并列时全部给出', () => {
    const a = analyze(list)
    expect(a.peakCount).toBe(1)
    expect(a.peakHours).toEqual([3, 9, 22])
    expect(peakHourText(a.peakHours)).toBe('3时、9时、22时')
  })

  it('夜间 22–5 时', () => {
    const a = analyze(list)
    expect(a.night).toBe(2)
    expect(a.nightPct).toBe(66.7)
  })

  it('载荷分箱：0.5 一档、左闭右开', () => {
    const a = analyze(list)
    // 0.8 → [0.5,1)、2.5 → [2.5,3)、5.5 → [3,+∞)
    expect(a.loads.map((b) => b.label)).toEqual([
      '0–0.5',
      '0.5–1',
      '1–1.5',
      '1.5–2',
      '2–2.5',
      '2.5–3',
      '≥3',
    ])
    expect(a.loads.map((b) => b.value)).toEqual([0, 1, 0, 0, 0, 1, 1])
    // 超重口径没变：仍是「达到额定 5t」，与载荷分箱是两个概念
    expect(a.over).toBe(1)
    expect(a.overMax).toBe(5.5)
  })

  /**
   * 边界归属（2026-11-25）：区间左闭右开，同一个数只能进一个箱。
   * 0.5 是二进制精确值，除它等于乘 2，不会因浮点误差掉到前一箱。
   */
  it('载荷分箱边界：左闭右开，每个数只落一箱', () => {
    const one = (w: number) => analyze([cycle('2026-11-12 09:00:00', w, 60)]).loads.map((b) => b.value)
    expect(one(0)).toEqual([1, 0, 0, 0, 0, 0, 0])
    expect(one(0.49)).toEqual([1, 0, 0, 0, 0, 0, 0])
    expect(one(0.5)).toEqual([0, 1, 0, 0, 0, 0, 0])
    expect(one(0.99)).toEqual([0, 1, 0, 0, 0, 0, 0])
    expect(one(1)).toEqual([0, 0, 1, 0, 0, 0, 0])
    expect(one(1.5)).toEqual([0, 0, 0, 1, 0, 0, 0])
    expect(one(2)).toEqual([0, 0, 0, 0, 1, 0, 0])
    expect(one(2.5)).toEqual([0, 0, 0, 0, 0, 1, 0])
    expect(one(2.99)).toEqual([0, 0, 0, 0, 0, 1, 0])
    expect(one(3)).toEqual([0, 0, 0, 0, 0, 0, 1])
    expect(one(12.5)).toEqual([0, 0, 0, 0, 0, 0, 1])
  })

  it('时长分箱：2 分钟一档、左闭右开', () => {
    const a = analyze(list)
    // 30s → [0,2)、180s(3分) → [2,4)、600s(10分) → [10,12)
    expect(a.durs.map((b) => b.label)).toEqual([
      '0–2',
      '2–4',
      '4–6',
      '6–8',
      '8–10',
      '10–12',
      '12–14',
      '≥14',
    ])
    expect(a.durs.map((b) => b.value)).toEqual([1, 1, 0, 0, 0, 1, 0, 0])
  })

  /**
   * 时长边界（2026-11-25）：区间左闭右开，恰好 2/4/6… 分钟进后一箱；
   * 全程按秒算（120 / 840 都是精确整数），不会因浮点误差掉箱。
   */
  it('时长分箱边界：左闭右开，每个数只落一箱', () => {
    const one = (sec: number) => analyze([cycle('2026-11-12 09:00:00', 1, sec)]).durs.map((b) => b.value)
    expect(one(0)).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect(one(119)).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect(one(120)).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
    expect(one(239)).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
    expect(one(240)).toEqual([0, 0, 1, 0, 0, 0, 0, 0])
    expect(one(360)).toEqual([0, 0, 0, 1, 0, 0, 0, 0])
    expect(one(480)).toEqual([0, 0, 0, 0, 1, 0, 0, 0])
    expect(one(600)).toEqual([0, 0, 0, 0, 0, 1, 0, 0])
    expect(one(720)).toEqual([0, 0, 0, 0, 0, 0, 1, 0])
    expect(one(839)).toEqual([0, 0, 0, 0, 0, 0, 1, 0])
    expect(one(840)).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(one(5400)).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  })

  it('均值：分母是「有该字段的条数」，利用率按额定 5t', () => {
    const a = analyze(list)
    expect(a.avgWeight).toBe(2.93)
    expect(a.avgDurSec).toBe(270)
    expect(a.utilPct).toBe(58.7)
  })

  it('缺字段的行不进对应的箱，但仍不该让均值变成 0', () => {
    const a = analyze([cycle(null, 2, null), cycle(null, null, 120)])
    expect(a.hours.every((b) => b.value === 0)).toBe(true)
    expect(a.peakHours).toEqual([])
    expect(a.night).toBe(0)
    expect(a.nightPct).toBe(0)
    expect(a.over).toBe(0)
    expect(a.avgWeight).toBe(2)
    expect(a.avgDurSec).toBe(120)
  })

  it('一条都没有：全 0 / null，不编数字', () => {
    const a = analyze([])
    expect(a.peakCount).toBe(0)
    expect(a.peakHours).toEqual([])
    expect(a.over).toBe(0)
    expect(a.overMax).toBeNull()
    expect(a.avgWeight).toBeNull()
    expect(a.avgDurSec).toBeNull()
    expect(a.utilPct).toBeNull()
    expect(a.loads.every((b) => b.value === 0)).toBe(true)
  })

  it('叠加 summarize：吊次数的是条数，与分箱互不影响', () => {
    const a = analyze(list)
    const s = summarize(list)
    expect(s.trips).toBe(3)
    expect(a.hours.reduce((sum, b) => sum + b.value, 0)).toBe(3)
  })
})

/**
 * 横轴刻度（2026-11-25）
 *
 * 这两条守的是图上「看到什么」：24 个小时标签以前是 `00 01 02 …` 全画，
 * 在 375 宽的屏上连成一条黑边。口径必须与长图共用同一套函数，否则导出的
 * 图与页面刻度对不上。
 */
describe('图表横轴刻度', () => {
  it('axisLabel：纯数字去前导 0，10 及以上保持', () => {
    expect(axisLabel('00')).toBe('0')
    expect(axisLabel('01')).toBe('1')
    expect(axisLabel('09')).toBe('9')
    expect(axisLabel('10')).toBe('10')
    expect(axisLabel('23')).toBe('23')
  })

  it('axisLabel：非纯数字的标签原样（不给 Number() 拆坏）', () => {
    expect(axisLabel('0–0.5')).toBe('0–0.5')
    expect(axisLabel('2.5–3')).toBe('2.5–3')
    expect(axisLabel('12–14')).toBe('12–14')
    expect(axisLabel('≥14')).toBe('≥14')
    expect(axisLabel('≥3')).toBe('≥3')
  })

  it('axisStep：24 小时抽稀到隔一个标，8 格以内的分箱全标', () => {
    expect(axisStep(24)).toBe(2)
    expect(axisStep(20)).toBe(2)
    expect(axisStep(8)).toBe(1)
    expect(axisStep(7)).toBe(1)
    expect(axisStep(6)).toBe(1)
  })
})
