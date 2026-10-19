import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addDays,
  calMinMonth,
  camStamp,
  dateKey,
  dayOffsetOf,
  formatCamDate,
  formatMD,
  inspCalMaxDay,
  monthStart,
  protoToday,
  sameDay,
  startOfDay,
} from '@/utils/date'

/**
 * 日期工具
 *
 * 这些函数是「所有历史数据相对日期」的唯一入口，一旦偏移算错，
 * 抓拍 / 航拍 / 巡检三个视图会同时显示错日期，且不容易肉眼发现。
 * 全部用假系统时间固定，避免用例随运行日漂移。
 */
describe('utils/date', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 16, 15, 30, 45, 500))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('startOfDay', () => {
    it('清掉时分秒毫秒，保留本地日期', () => {
      const d = startOfDay(new Date(2026, 9, 16, 23, 59, 59, 999))
      expect(d.getFullYear()).toBe(2026)
      expect(d.getMonth()).toBe(9)
      expect(d.getDate()).toBe(16)
      expect(d.getHours()).toBe(0)
      expect(d.getMinutes()).toBe(0)
      expect(d.getSeconds()).toBe(0)
      expect(d.getMilliseconds()).toBe(0)
    })

    it('接受时间戳', () => {
      expect(startOfDay(new Date(2026, 9, 16, 8, 0).getTime()).getDate()).toBe(16)
    })
  })

  describe('sameDay', () => {
    it('同一天不同时刻为 true', () => {
      expect(sameDay(new Date(2026, 9, 16, 0, 0), new Date(2026, 9, 16, 23, 59))).toBe(true)
    })

    it('跨零点为 false', () => {
      expect(sameDay(new Date(2026, 9, 16, 23, 59), new Date(2026, 9, 17, 0, 1))).toBe(false)
    })
  })

  describe('addDays', () => {
    it('向前向后各一天', () => {
      expect(addDays(new Date(2026, 9, 16), 1).getDate()).toBe(17)
      expect(addDays(new Date(2026, 9, 16), -1).getDate()).toBe(15)
    })

    it('跨月边界正确回退', () => {
      const d = addDays(new Date(2026, 9, 1), -1)
      expect(d.getMonth()).toBe(8)
      expect(d.getDate()).toBe(30)
    })

    it('跨年边界正确前进', () => {
      const d = addDays(new Date(2026, 11, 31), 1)
      expect(d.getFullYear()).toBe(2027)
      expect(d.getMonth()).toBe(0)
      expect(d.getDate()).toBe(1)
    })

    it('结果已归零到当天零点', () => {
      expect(addDays(new Date(2026, 9, 16, 22, 10), 2).getHours()).toBe(0)
    })
  })

  describe('dayOffsetOf', () => {
    it('今天是 0，昨天是 1，未来是负数', () => {
      expect(dayOffsetOf(new Date(2026, 9, 16, 3, 0))).toBe(0)
      expect(dayOffsetOf(new Date(2026, 9, 15))).toBe(1)
      expect(dayOffsetOf(new Date(2026, 9, 10))).toBe(6)
      expect(dayOffsetOf(new Date(2026, 9, 18))).toBe(-2)
    })

    it('不管传入时刻是几点，都按整天计算', () => {
      expect(dayOffsetOf(new Date(2026, 9, 16, 0, 0, 1))).toBe(0)
      expect(dayOffsetOf(new Date(2026, 9, 16, 23, 59, 59))).toBe(0)
    })
  })

  describe('formatMD / dateKey', () => {
    it('月份与日期都补零', () => {
      expect(formatMD(new Date(2026, 8, 5))).toBe('09/05')
      expect(formatMD(new Date(2026, 9, 16))).toBe('10/16')
      expect(formatMD(new Date(2026, 11, 31))).toBe('12/31')
    })

    it('dateKey 输出 YYYY-MM-DD', () => {
      expect(dateKey(new Date(2026, 9, 16, 18, 0))).toBe('2026-10-16')
      expect(dateKey(new Date(2026, 0, 1))).toBe('2026-01-01')
    })
  })

  describe('formatCamDate', () => {
    it('今天 / 昨天走中文，更早走 MM/DD', () => {
      expect(formatCamDate(new Date(2026, 9, 16))).toBe('今天')
      expect(formatCamDate(new Date(2026, 9, 15))).toBe('昨天')
      expect(formatCamDate(new Date(2026, 9, 14))).toBe('10/14')
      expect(formatCamDate(new Date(2026, 9, 1))).toBe('10/01')
    })
  })

  describe('原型基准日', () => {
    /*
     * 锚点跟随系统当天（原版硬编码 2026-10-08，导致巡检历史的日历上界与
     * 真实日期脱节）。与趋势图 / 监控抓拍 / 航拍共用同一基准，是「日期对
     * 得上」的前提，这里钉住它。
     */
    it('protoToday 是系统当天零点', () => {
      const p = protoToday()
      expect(p.getFullYear()).toBe(2026)
      expect(p.getMonth()).toBe(9)
      expect(p.getDate()).toBe(16)
      expect(p.getHours()).toBe(0)

      // 注意月份是 0-based：这里是 2027-04-01
      vi.setSystemTime(new Date(2027, 3, 1))
      expect(protoToday().getFullYear()).toBe(2027)
      expect(protoToday().getMonth()).toBe(3)
      expect(protoToday().getDate()).toBe(1)
    })

    it('inspCalMaxDay 是今天的前一天', () => {
      const d = inspCalMaxDay()
      expect(d.getMonth()).toBe(9)
      expect(d.getDate()).toBe(15)
    })
  })

  describe('月份边界', () => {
    it('calMinMonth 是当前月往前 11 个月的首日', () => {
      const d = calMinMonth()
      expect(d.getFullYear()).toBe(2025)
      expect(d.getMonth()).toBe(10)
      expect(d.getDate()).toBe(1)
      expect(d.getHours()).toBe(0)
    })

    it('monthStart 取当月 1 号零点', () => {
      const d = monthStart(new Date(2026, 9, 16, 9, 30))
      expect(d.getMonth()).toBe(9)
      expect(d.getDate()).toBe(1)
      expect(d.getHours()).toBe(0)
    })

    it('monthStart 跨年时年份正确', () => {
      const d = monthStart(new Date(2027, 0, 15))
      expect(d.getFullYear()).toBe(2027)
      expect(d.getMonth()).toBe(0)
      expect(d.getDate()).toBe(1)
    })
  })

  describe('camStamp', () => {
    it('输出「日期 + 星期 + 时间 + 4G」的固定格式', () => {
      expect(camStamp()).toBe('2026-10-16 星期五 15:30:45 4G')
    })

    it('分秒补零到两位', () => {
      vi.setSystemTime(new Date(2026, 9, 4, 9, 5, 7))
      expect(camStamp()).toBe('2026-10-04 星期日 09:05:07 4G')
    })

    it('星期表覆盖周日到周六', () => {
      const week = ['日', '一', '二', '三', '四', '五', '六']
      for (let i = 0; i < 7; i++) {
        // 2026-10-04 是周日，往后推 i 天
        vi.setSystemTime(new Date(2026, 9, 4 + i, 12, 0, 0))
        expect(camStamp()).toContain(`星期${week[i]}`)
      }
    })
  })
})
