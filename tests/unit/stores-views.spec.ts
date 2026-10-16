import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAlarmStore } from '@/stores/alarm'
import { useHomeStore } from '@/stores/home'
import { useSubpageStore } from '@/stores/subpage'
import type { Equip } from '@/types'

/** 构造一台仅用于 equipCount 分支覆盖的设备 */
function equipWith(...onFlags: boolean[]): Equip {
  return {
    id: 'test',
    name: '测试设备',
    value: '-',
    metric: '-',
    ico: 'robot',
    units: onFlags.map((on, i) => ({ name: `单元${i}`, on, rows: [['指标', '值']] })),
  }
}

/**
 * 巡检预警 / 首页 / 子页栈
 *
 * 这三个 store 是「同一份数据被多处消费」的关键环节：
 *   - alarm  的 8 条记录被首页趋势图、巡检列表、详情页、预警轮播四处读取
 *   - home   的楼栋 / 人员 / 设备数据带派生计算（楼层人数、设备在线状态）
 *   - subpage 的三级返回优先级 + is-alarm 由视图派生（原版在这里有过 bug）
 */
describe('stores · alarm / home / subpage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 16, 15, 30, 0))
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /* ============================================================ */

  describe('alarm', () => {
    it('8 条预警，当日 4 条 + 历史 4 条', () => {
      const alarm = useAlarmStore()
      expect(alarm.alarms).toHaveLength(8)
      expect(alarm.alarms.filter((a) => a.day === 'today')).toHaveLength(4)
      expect(alarm.alarms.filter((a) => a.day === 'hist')).toHaveLength(4)
    })

    it('latest 只含当日，且保持原始顺序', () => {
      const alarm = useAlarmStore()
      expect(alarm.latest.map((a) => a.id)).toEqual(['trash', 'cable', 'net', 'soil'])
      expect(alarm.latest.every((a) => a.day === 'today')).toBe(true)
    })

    it('每条都有完整的展示字段', () => {
      const alarm = useAlarmStore()
      for (const a of alarm.alarms) {
        expect(a.id).toBeTruthy()
        expect(a.type).toBeTruthy()
        expect(a.title).toBeTruthy()
        expect(a.desc).toBeTruthy()
        expect(a.rel).toBeTruthy()
        expect(a.img).toMatch(/^img\/.+\.webp$/)
        expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
        // geo 形如 "114.24751233100210,30.53310211883421"
        expect(a.geo).toMatch(/^-?\d+\.\d+,-?\d+\.\d+$/)
      }
    })

    it('id 唯一（详情页与轮播都靠它定位）', () => {
      const alarm = useAlarmStore()
      const ids = alarm.alarms.map((a) => a.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('图源只用了 4 张预警图', () => {
      const alarm = useAlarmStore()
      const imgs = [...new Set(alarm.alarms.map((a) => a.img))].sort()
      expect(imgs).toEqual([
        'img/alarm-cable.webp',
        'img/alarm-net.webp',
        'img/alarm-soil.webp',
        'img/alarm-trash.webp',
      ])
    })

    describe('alarmsOnDate', () => {
      it('按 at 的日期部分筛选历史记录', () => {
        const alarm = useAlarmStore()
        expect(alarm.alarmsOnDate(new Date(2026, 9, 7)).map((a) => a.id)).toEqual(['h-trash'])
        expect(alarm.alarmsOnDate(new Date(2026, 9, 6)).map((a) => a.id)).toEqual(['h-cable'])
        expect(alarm.alarmsOnDate(new Date(2026, 9, 5)).map((a) => a.id)).toEqual(['h-soil'])
      })

      it('没有记录的日子返回空数组', () => {
        const alarm = useAlarmStore()
        expect(alarm.alarmsOnDate(new Date(2026, 9, 9))).toEqual([])
      })

      it('当日记录不会出现在历史筛选里', () => {
        const alarm = useAlarmStore()
        // today 组的 at 是 2026-10-08，但 day === 'today'
        expect(alarm.alarmsOnDate(new Date(2026, 9, 8))).toEqual([])
      })

      it('传入日期的时间部分不影响结果', () => {
        const alarm = useAlarmStore()
        expect(alarm.alarmsOnDate(new Date(2026, 9, 7, 23, 59, 59)).map((a) => a.id)).toEqual([
          'h-trash',
        ])
      })
    })

    it('byId 命中与未命中', () => {
      const alarm = useAlarmStore()
      expect(alarm.byId('net')?.type).toBe('安全网缺失')
      expect(alarm.byId('nope')).toBeUndefined()
    })

    it('初始页签与日历锚点对齐原型基准日', () => {
      const alarm = useAlarmStore()
      expect(alarm.inspTab).toBe('today')
      expect(alarm.inspCalOpen).toBe(false)
      // protoToday() 固定 2026-10-08 → 历史默认选中前一天
      expect(alarm.inspHistDate.getFullYear()).toBe(2026)
      expect(alarm.inspHistDate.getMonth()).toBe(9)
      expect(alarm.inspHistDate.getDate()).toBe(7)
      // 日历显示选中日所在月的首日
      expect(alarm.inspCalMonth.getDate()).toBe(1)
      expect(alarm.inspCalMonth.getMonth()).toBe(9)
    })

    it('历史锚点不随系统时间漂移（原型基准日）', () => {
      const alarm = useAlarmStore()
      vi.setSystemTime(new Date(2027, 3, 1))
      // 已创建的 store 状态不受影响，重新读取也仍指向 2026-10
      expect(alarm.inspHistDate.getMonth()).toBe(9)
      expect(alarm.inspHistDate.getFullYear()).toBe(2026)
    })
  })

  /* ============================================================ */

  describe('home', () => {
    it('默认停在安全管理面板', () => {
      expect(useHomeStore().homeMod).toBe('safety')
    })

    it('人员树三层结构，2#楼楼层数与稀疏表对齐', () => {
      const home = useHomeStore()
      expect(home.peopleTree.map((n) => n.id)).toEqual(['yard', 'b2', 'base'])

      const b2 = home.peopleTree.find((n) => n.id === 'b2')!
      expect(b2.children).toHaveLength(5)
      expect(b2.children!.map((c) => c.name)).toEqual(['1F', '2F', '3F', '4F', '5F'])
      // 稀疏表只填了 1F=5、4F=1，其余补 0
      expect(b2.children!.map((c) => c.count)).toEqual([5, 0, 0, 1, 0])
      // 楼层之和应等于该楼栋统计数
      const sum = b2.children!.reduce((s, c) => s + c.count, 0)
      expect(sum).toBe(b2.count)
    })

    it('人员总数 = 各区之和', () => {
      const home = useHomeStore()
      const total = home.peopleTree.reduce((s, n) => s + n.count, 0)
      expect(total).toBe(38 + 6 + 2)
    })

    describe('peopleChildren', () => {
      it('未下钻时返回区域列表', () => {
        const home = useHomeStore()
        expect(home.peopleChildren()).toBe(home.peopleTree)
      })

      it('下钻到有子节点的区域时返回其楼层', () => {
        const home = useHomeStore()
        home.peopleNode = home.peopleTree.find((n) => n.id === 'b2')!
        expect(home.peopleChildren().map((c) => c.name)).toEqual(['1F', '2F', '3F', '4F', '5F'])
      })

      it('下钻到无子节点的区域返回空数组', () => {
        const home = useHomeStore()
        home.peopleNode = home.peopleTree.find((n) => n.id === 'yard')!
        expect(home.peopleChildren()).toEqual([])
      })
    })

    it('9 台设备，id 唯一且都有单元明细', () => {
      const home = useHomeStore()
      expect(home.siteEquip).toHaveLength(9)
      const ids = home.siteEquip.map((d) => d.id)
      expect(new Set(ids).size).toBe(9)
      for (const d of home.siteEquip) {
        expect(d.units.length).toBeGreaterThan(0)
        expect(d.name).toBeTruthy()
        expect(d.value).toBeTruthy()
        expect(d.metric).toBeTruthy()
      }
    })

    describe('equipCount', () => {
      it('全部在线 → on', () => {
        const home = useHomeStore()
        expect(home.equipCount(equipWith(true, true))).toEqual({ on: 2, total: 2, st: 'on' })
      })

      it('部分在线 → warn', () => {
        const home = useHomeStore()
        expect(home.equipCount(equipWith(true, false, false))).toEqual({
          on: 1, total: 3, st: 'warn',
        })
      })

      it('全部离线 → off', () => {
        const home = useHomeStore()
        expect(home.equipCount(equipWith(false, false))).toEqual({ on: 0, total: 2, st: 'off' })
      })

      it('真实数据的在线状态与手写明细一致', () => {
        const home = useHomeStore()
        const lift = home.siteEquip.find((d) => d.id === 'lift')!
        expect(home.equipCount(lift)).toEqual({ on: 2, total: 4, st: 'warn' })

        const crane = home.siteEquip.find((d) => d.id === 'crane')!
        expect(home.equipCount(crane)).toEqual({ on: 1, total: 1, st: 'on' })
      })
    })

    it('6 栋楼，完成数不超过总数、进度率为百分数', () => {
      const home = useHomeStore()
      expect(home.siteBuildings.map((b) => b.name)).toEqual([
        '酒店', '1#楼', '2#楼', '3#楼', '4#楼', '幼儿园',
      ])
      for (const b of home.siteBuildings) {
        expect(b.done).toBeGreaterThanOrEqual(0)
        expect(b.done).toBeLessThanOrEqual(b.total)
        expect(b.rate).toBeGreaterThanOrEqual(0)
        expect(b.rate).toBeLessThanOrEqual(100)
      }
    })

    it('质量类目 5 项，当前值与上次值同源', () => {
      const home = useHomeStore()
      expect(home.qaCats).toHaveLength(5)
      for (const c of home.qaCats) {
        expect(c.now).toBe(c.last)
        expect(c.name).toBeTruthy()
      }
    })
  })

  /* ============================================================ */

  describe('subpage', () => {
    it('初始关闭且无标题', () => {
      const sub = useSubpageStore()
      expect(sub.view).toEqual({ kind: 'none' })
      expect(sub.isOpen).toBe(false)
      expect(sub.isAlarm).toBe(false)
      expect(sub.title).toBe('')
      expect(sub.back).toBeNull()
    })

    describe('openInspectList', () => {
      it('打开列表并切页签', () => {
        const alarm = useAlarmStore()
        const sub = useSubpageStore()
        sub.openInspectList('hist')
        expect(sub.view).toEqual({ kind: 'inspect-list' })
        expect(alarm.inspTab).toBe('hist')
        expect(sub.title).toBe('巡检预警')
        expect(sub.isOpen).toBe(true)
        expect(sub.isAlarm).toBe(false)
      })

      it('不传参时保持当前页签', () => {
        const alarm = useAlarmStore()
        const sub = useSubpageStore()
        alarm.inspTab = 'hist'
        sub.openInspectList()
        expect(alarm.inspTab).toBe('hist')
      })

      it('会收起日历并清掉上一级', () => {
        const alarm = useAlarmStore()
        const sub = useSubpageStore()
        alarm.inspCalOpen = true
        sub.openSub('我的工地')
        sub.openInspectList('today')
        expect(alarm.inspCalOpen).toBe(false)
        expect(sub.back).toBeNull()
      })
    })

    describe('openAlarmDetail', () => {
      it('打开存在的预警并记住返回目标', () => {
        const sub = useSubpageStore()
        sub.openAlarmDetail('trash')
        expect(sub.view).toEqual({ kind: 'alarm-detail', id: 'trash' })
        expect(sub.title).toBe('预警详情')
        expect(sub.isAlarm).toBe(true)
        expect(sub.back).toEqual({ kind: 'inspect-list' })
      })

      it('id 不存在时不改变任何状态', () => {
        const sub = useSubpageStore()
        sub.openSub('关于')
        const before = sub.view
        sub.openAlarmDetail('nope')
        expect(sub.view).toBe(before)
      })

      it('fromList=false 时不记返回目标', () => {
        const sub = useSubpageStore()
        sub.openAlarmDetail('net', false)
        expect(sub.back).toBeNull()
      })
    })

    it('openSub 用菜单名作为标题（占位页）', () => {
      const sub = useSubpageStore()
      sub.openSub('我的工地')
      expect(sub.view).toEqual({ kind: 'placeholder', name: '我的工地' })
      expect(sub.title).toBe('我的工地')
      expect(sub.isOpen).toBe(true)
      expect(sub.isAlarm).toBe(false)
    })

    describe('close 的三级优先返回', () => {
      it('① 日历展开时先收日历，视图不动', () => {
        const alarm = useAlarmStore()
        const sub = useSubpageStore()
        sub.openInspectList('hist')
        alarm.inspCalOpen = true

        sub.close()
        expect(alarm.inspCalOpen).toBe(false)
        expect(sub.view).toEqual({ kind: 'inspect-list' })
        expect(sub.isOpen).toBe(true)
      })

      it('② 有上一级则回退一级', () => {
        const sub = useSubpageStore()
        sub.openInspectList('today')
        sub.openAlarmDetail('trash')
        expect(sub.isAlarm).toBe(true)

        sub.close()
        expect(sub.view).toEqual({ kind: 'inspect-list' })
        expect(sub.back).toBeNull()
        // 关键：is-alarm 必须随视图回落，否则列表页会残留深色导航栏
        expect(sub.isAlarm).toBe(false)
        expect(sub.isOpen).toBe(true)
      })

      it('③ 无上一级时关闭子页', () => {
        const sub = useSubpageStore()
        sub.openInspectList('today')
        sub.close()
        expect(sub.view).toEqual({ kind: 'none' })
        expect(sub.isOpen).toBe(false)
        expect(sub.title).toBe('')
      })

      it('force 跳过日历与上一级，直接关闭', () => {
        const alarm = useAlarmStore()
        const sub = useSubpageStore()
        sub.openInspectList('today')
        sub.openAlarmDetail('cable')
        alarm.inspCalOpen = true

        sub.close(true)
        expect(alarm.inspCalOpen).toBe(true)
        expect(sub.view).toEqual({ kind: 'none' })
        expect(sub.back).toBeNull()
      })
    })

    it('isAlarm 完全由当前视图派生', () => {
      const sub = useSubpageStore()
      sub.openInspectList('today')
      expect(sub.isAlarm).toBe(false)
      sub.openAlarmDetail('soil')
      expect(sub.isAlarm).toBe(true)
      sub.openSub('设置')
      expect(sub.isAlarm).toBe(false)
    })
  })
})
