import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  alarmTrendModel,
  alarmTrendSvg,
  lineThrough,
  peopleHourModel,
  peopleHourSvg,
  smoothPath,
} from '@/utils/chart'

/**
 * 图表几何
 *
 * chart.ts 的输出是拼出来的 SVG 字符串，错了不会报错、只会画歪，
 * 所以这里用「精确字符串 + 结构性约束」两层断言：
 *   - 少量关键点位用精确值锁死（防止无意改几何）
 *   - 其余用单调性 / 值域 / 段数约束（对合法的重构保持容忍）
 */
describe('utils/chart', () => {
  describe('lineThrough', () => {
    it('空数组返回空串', () => {
      expect(lineThrough([])).toBe('')
    })

    it('单点只输出 M', () => {
      expect(lineThrough([[10, 20]])).toBe('M10.0,20.0')
    })

    it('两点在 tension=0 时退化为直线控制点', () => {
      expect(lineThrough([[0, 0], [10, 10]], 0)).toBe('M0.0,0.0 C0.0,0.0 10.0,10.0 10.0,10.0')
    })

    it('默认 tension 为 0.7', () => {
      expect(lineThrough([[0, 0], [10, 10]])).toBe('M0.0,0.0 C1.2,1.2 8.8,8.8 10.0,10.0')
    })

    it('n 个点产生 n-1 段三次贝塞尔', () => {
      const d = lineThrough([[0, 0], [10, 10], [20, 0]])
      expect(d.match(/C/g)).toHaveLength(2)
      expect(d).toBe('M0.0,0.0 C1.2,1.2 7.7,10.0 10.0,10.0 C12.3,10.0 18.8,1.2 20.0,0.0')
    })

    it('所有坐标保留一位小数', () => {
      const d = lineThrough([[0, 0], [3, 7], [11, 2], [19, 9]])
      expect(d).toMatch(/^M-?\d+\.\d,-?\d+\.\d( C-?\d+\.\d,-?\d+\.\d -?\d+\.\d,-?\d+\.\d -?\d+\.\d,-?\d+\.\d)+$/)
    })
  })

  describe('smoothPath', () => {
    it('控制点取相邻两点的中点', () => {
      expect(smoothPath([[0, 0], [10, 10]])).toBe('M0.0,0.0 C5.0,0.0 5.0,10.0 10.0,10.0')
    })

    it('多段时每段中点各不相同', () => {
      const d = smoothPath([[0, 0], [10, 10], [20, 0]])
      expect(d).toBe('M0.0,0.0 C5.0,0.0 5.0,10.0 10.0,10.0 C15.0,10.0 15.0,0.0 20.0,0.0')
    })
  })

  describe('alarmTrendModel', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      // 基准日 2026-10-08 恰好是 hist 字典覆盖的最后一天
      vi.setSystemTime(new Date(2026, 9, 8, 10, 0, 0))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('刻度是近 7 天', () => {
      const m = alarmTrendModel(4)
      expect(m.ticks).toEqual(['10/2', '10/3', '10/4', '10/5', '10/6', '10/7', '10/8'])
    })

    it('历史值按距今天数查已知分布，最后一天用传入的当日条数', () => {
      expect(alarmTrendModel(4).series[0].values).toEqual([2, 3, 6, 16, 13, 8, 4])
      expect(alarmTrendModel(9).series[0].values).toEqual([2, 3, 6, 16, 13, 8, 9])
    })

    it('2026-11 设计稿：历史值改按偏移查表，日期漂移不再回退为 3', () => {
      vi.setSystemTime(new Date(2026, 10, 20, 10, 0, 0))
      const vals = alarmTrendModel(10).series[0].values
      // 已知分布 [8,13,16,6,3,2] 与日期解耦（原 app.js:133-145 alarmDayCount）
      expect(vals.slice(0, 6)).toEqual([2, 3, 6, 16, 13, 8])
      expect(vals[6]).toBe(10)
    })

    it('横轴坐标严格递增且落在绘图区内', () => {
      const m = alarmTrendModel(4)
      expect(m.xs).toHaveLength(7)
      for (let i = 1; i < m.xs.length; i++) {
        expect(m.xs[i]).toBeGreaterThan(m.xs[i - 1])
      }
      // pl=24, w-pr=244
      expect(m.xs[0]).toBe(24)
      expect(m.xs[6]).toBe(244)
    })

    it('纵轴按 maxY=20 归一，峰值 16 对应最高点', () => {
      const ys = alarmTrendModel(4).ys[0]
      const nums = ys.filter((v): v is number => v !== null)
      expect(nums).toHaveLength(ys.length)

      // yAt(v) = 10 + (1 - v/20) * 48
      expect(nums[3]).toBeCloseTo(19.6, 5)
      expect(nums[0]).toBeCloseTo(53.2, 5)
      expect(Math.min(...nums)).toBeCloseTo(19.6, 5)
      expect(ys.indexOf(Math.min(...nums))).toBe(3)
      for (const y of nums) {
        expect(y).toBeGreaterThanOrEqual(10)
        expect(y).toBeLessThanOrEqual(58)
      }
    })

    it('系列元数据与点位对齐（交互层依赖它定位气泡）', () => {
      const m = alarmTrendModel(4)
      expect(m.series).toHaveLength(1)
      expect(m.series[0].name).toBe('预警')
      expect(m.series[0].values).toHaveLength(m.xs.length)
      expect(m.ys[0]).toHaveLength(m.xs.length)
      expect(m.w).toBe(260)
      expect(m.h).toBe(78)
    })

    it('SVG 里带上动效钩子与渐变填充', () => {
      const svg = alarmTrendModel(4).svg
      expect(svg).toContain('class="alarm-svg"')
      expect(svg).toContain('viewBox="0 0 260 78"')
      expect(svg).toContain('id="alarmFill"')
      expect(svg).toContain('fill="url(#alarmFill)"')
      expect(svg).toContain('class="dl" pathLength="1"')
      expect(svg).toContain('class="alarm-dot"')
      // 数据点入场延迟逐点递增
      expect(svg).toContain('animation-delay:350ms')
      expect(svg).toContain('animation-delay:420ms')
    })

    it('可自定义渐变 id，空串回退默认值', () => {
      expect(alarmTrendModel(4, 'customFill').svg).toContain('id="customFill"')
      expect(alarmTrendModel(4, '').svg).toContain('id="alarmFill"')
    })

    it('alarmTrendSvg 与模型版的 SVG 完全一致（旧调用签名不能漂移）', () => {
      expect(alarmTrendSvg('alarmFill', 4)).toBe(alarmTrendModel(4, 'alarmFill').svg)
      expect(alarmTrendSvg('', 7)).toBe(alarmTrendModel(7, '').svg)
    })

    /*
     * 2026-10 视觉改造第二批：线是平的、没有重点，7 天走势看不出信息。
     * 加了三样：贴合同一路径的发光层、末点呼吸光晕、峰值只给点不给字
     * （170px 宽的迷你图里 7 个日期标签已经挤到约 7px，再加文字必糊）。
     */
    it('发光层与末点光晕都在，且几何没有被改动', () => {
      const m = alarmTrendModel(4)
      expect(m.svg).toContain('class="dl-glow"')
      expect(m.svg).toContain('class="alarm-live-halo"')
      expect(m.svg).toContain('class="alarm-live"')
      // 光晕落在最后一个点上
      const lastX = m.xs[m.xs.length - 1].toFixed(1)
      expect(m.svg).toContain(`class="alarm-live" cx="${lastX}"`)
      // 新增元素不改变坐标系
      expect(m.w).toBe(260)
      expect(m.h).toBe(78)
    })
  })

  describe('peopleHourModel', () => {
    it('只画到当前小时，未到时段为 null', () => {
      const m = peopleHourModel(11)
      // hourNums 里 <= 11 的有 1/3/5/7/9/11 共 6 个
      expect(m.series[0].values.slice(0, 6)).toEqual([2, 2, 2, 8, 36, 33])
      expect(m.series[0].values.slice(6)).toEqual([null, null, null, null, null, null])
      expect(m.series[1].values.slice(0, 6)).toEqual([2, 2, 2, 2, 7, 19])
      expect(m.ys[0][6]).toBeNull()
      expect(m.ys[1][6]).toBeNull()
    })

    it('两个系列（工人 / 管理）长度一致', () => {
      const m = peopleHourModel(15)
      expect(m.series.map((s) => s.name)).toEqual(['工人', '管理'])
      expect(m.series[0].values).toHaveLength(12)
      expect(m.series[1].values).toHaveLength(12)
      expect(m.ticks).toHaveLength(12)
      expect(m.xs).toHaveLength(12)
    })

    it('已到时段的值会换算成 y 坐标', () => {
      const m = peopleHourModel(11)
      // yAt(2) = 10 + (1 - 2/40) * 116
      expect(m.ys[0][0]).toBeCloseTo(10 + (1 - 2 / 40) * 116, 5)
      expect(m.ys[0][5]).toBeCloseTo(10 + (1 - 33 / 40) * 116, 5)
    })

    it('一天刚开始时无数据：曲线为空但结构完整', () => {
      const m = peopleHourModel(0)
      expect(m.series[0].values.every((v) => v === null)).toBe(true)
      expect(m.ys[0].every((v) => v === null)).toBe(true)
      expect(m.svg).toContain('class="fa" d=""')
      expect(m.xs).toHaveLength(12)
    })

    it('到当天末尾时全部时段都有数据', () => {
      const m = peopleHourModel(23)
      expect(m.series[0].values.every((v) => v != null)).toBe(true)
      expect(m.ys[1].every((v) => v != null)).toBe(true)
    })

    it('未到时段的刻度标签淡化', () => {
      const svg = peopleHourModel(11).svg
      expect(svg).toContain('opacity="0.35"')
      // 23:00 尚未到来，对应标签应带淡化
      expect(svg).toContain('>23:00</text>')
    })

    it('两条曲线都带描边入场动画', () => {
      const svg = peopleHourModel(15).svg
      expect(svg).toContain('stroke="#3DDC97"')
      expect(svg).toContain('stroke="#4C9FFF"')
      expect(svg.match(/class="dl" pathLength="1"/g)).toHaveLength(2)
      expect(svg).toContain('animation-delay:.25s')
    })

    it('peopleHourSvg 与模型版一致', () => {
      expect(peopleHourSvg(9)).toBe(peopleHourModel(9).svg)
    })

    /* 大图放得下文字，峰值标出来比让用户自己找最高点有用 */
    it('大图标出峰值，凌晨无数据时不产生空标注', () => {
      const svg = peopleHourModel(11).svg
      expect(svg).toContain('class="peak-lab"')
      // 工人峰值 36 出现在 9:00
      expect(svg).toContain('峰值 36人')

      // 0 点：一个时段都还没到，不应留下一个没有坐标的标注
      const empty = peopleHourModel(0).svg
      expect(empty).not.toContain('class="peak-lab"')
      expect(empty).not.toContain('class="dl-glow"')
    })
  })
})

describe('peopleHourModel 接真实数据', () => {
  const live = {
    hours: [8, 9, 10, 11, 12],
    workers: [2, 18, 18, 15, 14],
    managers: [1, 5, 6, 6, 4],
  }

  it('刻度用接口的小时数，系列值原样上屏', () => {
    const m = peopleHourModel(12, live)
    expect(m.ticks).toEqual(['8:00', '9:00', '10:00', '11:00', '12:00'])
    expect(m.series[0].values).toEqual([2, 18, 18, 15, 14])
    expect(m.series[1].values).toEqual([1, 5, 6, 6, 4])
  })

  it('纵轴上限按实际峰值放大到 10 的整数倍', () => {
    // 峰值 18 → 20，最高点不该贴边
    const m = peopleHourModel(12, live)
    const top = Math.min(...(m.ys[0].filter((v) => v != null) as number[]))
    expect(top).toBeGreaterThan(10)
    expect(top).toBeLessThan(148 - 22)
  })

  it('未结算的当前整点不画成 0（否则右端会垂直跳水）', () => {
    const m = peopleHourModel(12, { ...live, hours: [8, 9, 10, 11, 12], workers: [2, 18, 18, 15, 0], managers: [1, 5, 6, 6, 0] })
    expect(m.ticks).not.toContain('12:00')
    expect(m.series[0].values).toEqual([2, 18, 18, 15])
  })

  it('历史时段里真正的 0 保留，不会被误掐', () => {
    const m = peopleHourModel(12, { hours: [6, 7, 8], workers: [0, 0, 5], managers: [0, 0, 2] })
    expect(m.series[0].values).toEqual([0, 0, 5])
  })

  it('数据不足两个整点时回落演示曲线', () => {
    const demo = peopleHourModel(12)
    expect(peopleHourModel(12, { hours: [9], workers: [1], managers: [1] }).svg).toBe(demo.svg)
  })
})
