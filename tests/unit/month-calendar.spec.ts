import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import { useShellStore } from '@/stores/shell'
import { startOfDay } from '@/utils/date'

/**
 * 月份日历的可选区间（2026-11-19）
 *
 * 历史抓拍只允许查「近 30 天」，日历这边负责「点不到」，真正的裁决在
 * store 的 `setShotDate()`。两边边界必须一致，否则会出现「日历能点、
 * 点了又弹回来」的怪现象。
 *
 * 用固定系统时间（2026-11-19）把边界钉死：区间 = 2026-10-21 ~ 2026-11-19，
 * 这样「本月里的未来日期」与「上月里的过界日期」都一定存在，断言与跑测的
 * 真实日期无关。
 */
const TODAY = new Date(2026, 10, 19, 10, 0, 0)
const MIN = startOfDay(new Date(2026, 9, 21))

function mountCal(month = new Date(2026, 10, 1)) {
  return mount(MonthCalendar, {
    props: { month, selected: startOfDay(TODAY), minDay: MIN, maxDay: startOfDay(TODAY) },
  })
}

/** 按 data-cal 找格子（'2026-11-25' 这种，月份不补零） */
function cellOf(w: ReturnType<typeof mountCal>, d: Date) {
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  const cell = w.find(`[data-cal="${key}"]`)
  if (!cell.exists()) throw new Error(`找不到格子 ${key}`)
  return cell
}

describe('月份日历：可选区间', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('未来日期禁用，点了只给说明、不派发选择', async () => {
    const w = mountCal()
    const future = cellOf(w, new Date(2026, 10, 25))

    expect(future.classes()).toContain('is-disabled')
    expect(future.attributes('aria-disabled')).toBe('true')

    await future.trigger('click')
    expect(useShellStore().toast).toContain('记录还没生成')
    expect(w.emitted('select')).toBeUndefined()
  })

  it('早于 30 天的日期禁用，并说出边界在哪天', async () => {
    const w = mountCal(new Date(2026, 9, 1)) // 10 月：20 日及更早都过界
    const tooOld = cellOf(w, new Date(2026, 9, 15))

    expect(tooOld.classes()).toContain('is-disabled')

    await tooOld.trigger('click')
    expect(useShellStore().toast).toContain('10/21')
    expect(w.emitted('select')).toBeUndefined()
  })

  it('区间内的日期照常可选（含两端）', async () => {
    const w = mountCal()

    await cellOf(w, TODAY).trigger('click')
    expect(w.emitted('select')?.at(-1)).toEqual([startOfDay(TODAY)])

    // 上界之外的月份才能看到下界那天，这里换成 10 月视图点 21 日
    const oct = mountCal(new Date(2026, 9, 1))
    await cellOf(oct, MIN).trigger('click')
    expect(oct.emitted('select')?.at(-1)).toEqual([MIN])
  })

  it('翻月按钮卡在区间当月：不能翻到 10 月之前，也不能翻到本月之后', () => {
    const oct = mountCal(new Date(2026, 9, 1))
    const nav = oct.findAll('.cam-cal-nav')
    expect((nav[0].element as HTMLButtonElement).disabled).toBe(true) // 上一月（9 月）
    expect((nav[1].element as HTMLButtonElement).disabled).toBe(false) // 下一月（11 月）

    const nov = mountCal()
    const nav2 = nov.findAll('.cam-cal-nav')
    expect((nav2[0].element as HTMLButtonElement).disabled).toBe(false) // 上一月（10 月）
    expect((nav2[1].element as HTMLButtonElement).disabled).toBe(true) // 下一月（12 月，超上界）
  })

  it('不传 minDay 时行为不变（航拍 / 巡检历史沿用旧范围）', async () => {
    const w = mount(MonthCalendar, {
      props: { month: new Date(2026, 10, 1), selected: startOfDay(TODAY), maxDay: startOfDay(TODAY) },
    })
    // 没给下界：本月里今天之前的日期都可选
    const past = cellOf(w, new Date(2026, 10, 1))
    expect(past.classes()).not.toContain('is-disabled')
    await past.trigger('click')
    expect(w.emitted('select')?.at(-1)).toEqual([new Date(2026, 10, 1)])
  })
})
