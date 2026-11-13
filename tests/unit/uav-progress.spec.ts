import { describe, expect, it } from 'vitest'

import { estimateByTask, missionProgress, runMinutes } from '@/utils/uavProgress'

/** 造一条已完成执行的起止串 */
function span(taskId: number | null, start: string, end: string) {
  return { taskId, start, end }
}

describe('runMinutes', () => {
  it('按服务端的 ISO 串算分钟（小数）', () => {
    expect(runMinutes('2026-11-13T15:00:00', '2026-11-13T15:11:00')).toBe(11)
    expect(runMinutes('2026-11-13T17:45:00', '2026-11-13T17:52:30')).toBe(7.5)
  })

  it('执行中（end 为空）/ 起止倒挂 / 空串 → null，不当「0 分钟」', () => {
    expect(runMinutes('2026-11-13T17:45:00', '')).toBeNull()
    expect(runMinutes('2026-11-13T17:45:00', '2026-11-13T17:40:00')).toBeNull()
    expect(runMinutes('', '2026-11-13T17:40:00')).toBeNull()
  })
})

describe('estimateByTask', () => {
  it('同任务多次执行取中位数，偶尔一次跑歪不影响', () => {
    // 现场形态：安全巡检 24 次 11 分钟 + 少数几次 20 分钟（中途等待）
    const rows = [
      span(4912, '2026-11-12T09:45:00', '2026-11-12T09:56:00'),
      span(4912, '2026-11-12T13:20:00', '2026-11-12T13:31:00'),
      span(4912, '2026-11-12T15:00:00', '2026-11-12T15:20:00'),
    ]
    expect(estimateByTask(rows)['4912']).toBe(11)
  })

  it('偶数个样本取中间两个的平均，四舍五入', () => {
    const rows = [
      span(1, '2026-11-12T09:00:00', '2026-11-12T09:06:00'), // 6
      span(1, '2026-11-12T10:00:00', '2026-11-12T10:07:00'), // 7
      span(1, '2026-11-12T11:00:00', '2026-11-12T11:09:00'), // 9
      span(1, '2026-11-12T12:00:00', '2026-11-12T12:20:00'), // 20
    ]
    // (7 + 9) / 2 = 8
    expect(estimateByTask(rows)['1']).toBe(8)
  })

  it('按 taskId 分组：不同任务各算各的', () => {
    const rows = [
      span(1, '2026-11-12T09:00:00', '2026-11-12T09:05:00'),
      span(2, '2026-11-12T09:00:00', '2026-11-12T09:19:00'),
    ]
    expect(estimateByTask(rows)).toEqual({ '1': 5, '2': 19 })
  })

  it('执行中的记录不算样本（end 为空），taskId 缺失的丢', () => {
    const rows = [
      span(1, '2026-11-13T17:45:00', ''), // 正在飞，不能拿它当历史
      span(null, '2026-11-12T09:00:00', '2026-11-12T09:05:00'),
      span(1, '2026-11-12T09:00:00', '2026-11-12T09:05:00'),
    ]
    expect(estimateByTask(rows)).toEqual({ '1': 5 })
  })

  it('一次完整执行都没有的任务不出现（没有分母就别画条）', () => {
    expect(estimateByTask([span(9, '2026-11-13T17:45:00', '')])).toEqual({})
    expect(estimateByTask([])).toEqual({})
  })

  it('不足 1 分钟也按 1 分钟，避免分母为 0 算出无穷', () => {
    expect(estimateByTask([span(1, '2026-11-12T09:00:00', '2026-11-12T09:00:20')])['1']).toBe(1)
  })
})

describe('missionProgress', () => {
  const T0 = Date.parse('2026-11-13T17:45:00')

  it('已飞 / 预计 / 百分比三件套', () => {
    // 已飞 4 分钟，历史 11 分钟 → 36%
    const m = missionProgress(T0, 11, T0 + 4 * 60_000)
    expect(m.elapsedMin).toBe(4)
    expect(m.estimateMin).toBe(11)
    expect(m.pct).toBe(36)
  })

  it('封顶 99：还在执行中就不许画成 100%', () => {
    const m = missionProgress(T0, 11, T0 + 30 * 60_000)
    expect(m.pct).toBe(99)
    expect(m.elapsedMin).toBe(30) // 实情由分钟数说，不靠百分比圆谎
  })

  it('时间没到（时钟偏差）也不出负数', () => {
    expect(missionProgress(T0, 11, T0 - 60_000).pct).toBe(0)
  })

  it('没有历史时长 → 不给百分比，但已飞时长照给', () => {
    const m = missionProgress(T0, null, T0 + 3 * 60_000)
    expect(m.pct).toBeNull()
    expect(m.elapsedMin).toBe(3)
    expect(m.estimateMin).toBeNull()
  })

  it('没有起飞时刻 → 全部为 null（页面只写「任务执行中」）', () => {
    expect(missionProgress(null, 11, T0)).toEqual({ pct: null, elapsedMin: null, estimateMin: 11 })
  })

  it('预计时长非正数当没有', () => {
    expect(missionProgress(T0, 0, T0 + 60_000).pct).toBeNull()
  })
})
