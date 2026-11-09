import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import SheetHost from '@/components/overlays/SheetHost.vue'
import SubPage from '@/components/overlays/SubPage.vue'
import { craneUnits, liftUnits, uavChecks } from '@/data/device'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useSubpageStore } from '@/stores/subpage'
import EquipPanel from '@/views/home/EquipPanel.vue'
import ClimbPage from '@/views/sub/ClimbPage.vue'

/**
 * 设备详情 / 无人机 / 日报（2026-10 版本同步 · 第四批）
 *
 * 这一批的核心不是样式，而是「入口 → 页面 → 返回」这条链：
 *   智控卡片只对有详情页的设备可点、设备页是深色且带日报入口、
 *   日报的合计与结论跟着昨日数据走、返回键回到设备页而不是首页。
 *
 * 顺带钉住一条容易回归的东西：塔机与电梯在页面上是同一份组件，
 * 但指标名不同 —— 串了就会看到「电梯累计吊重」这种字段。
 */

const Host = defineComponent({
  components: { SubPage, SheetHost },
  setup: () => () => h('div', [h(SubPage), h(SheetHost)]),
})

describe('智控入口', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('塔机 / 电梯 / 无人机 / 爬架均有详情页（2026-11 设计稿：四类全部可下钻）', () => {
    const w = mount(EquipPanel)
    const pages = w.findAll('[data-page]').map((b) => b.attributes('data-page'))
    expect(pages).toEqual(['crane', 'lift', 'uav', 'climb'])

    // 2026-11 设计稿删掉机器人后，全部卡片都可点，没有纯展示卡
    expect(w.findAll('.eq-card.drill')).toHaveLength(4)
    expect(w.findAll('.eq-card:not(.drill)')).toHaveLength(0)
    w.unmount()
  })

  it('爬架卡是专属结构：三格正常数 + 异常行', () => {
    const w = mount(EquipPanel)
    const climb = w.find('[data-page="climb"]')
    expect(climb.classes()).toContain('is-climb')
    // 左右倾斜 35/36（30# 机位超限），前后倾斜与载荷 36/36
    const vals = climb.findAll('.eq-val')
    expect(vals.map((v) => v.classes())).toEqual([['eq-val', 'is-bad'], ['eq-val', 'is-ok'], ['eq-val', 'is-ok']])
    expect(climb.find('.eq-alert').text()).toContain('30#机位 左右倾斜 179.70mm')
    w.unmount()
  })

  it('点爬架卡进入爬架详情', async () => {
    const sub = useSubpageStore()
    const w = mount(EquipPanel)
    await w.find('[data-page="climb"]').trigger('click')
    expect(sub.view).toEqual({ kind: 'climb' })
    expect(sub.title).toBe('智能爬架')
    expect(sub.isDark).toBe(true)
    w.unmount()
  })

  it('点塔机卡进入设备详情', async () => {
    const sub = useSubpageStore()
    const w = mount(EquipPanel)
    await w.find('[data-page="crane"]').trigger('click')
    expect(sub.view).toEqual({ kind: 'device', device: 'crane' })
    expect(sub.title).toBe('智能塔机')
    expect(sub.isDark).toBe(true)
    w.unmount()
  })
})

describe('智能爬架详情页（2026-11 设计稿）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('36 个机位逐行展示，默认左右倾斜页签，30# 机位标红', () => {
    const w = mount(ClimbPage)
    expect(w.findAll('.climb-line')).toHaveLength(36)
    expect(w.findAll('.climb-line.is-bad')).toHaveLength(1)
    expect(w.find('.climb-line.is-bad').text()).toContain('30#')
    expect(w.find('.climb-issue').text()).toContain('179.70mm')
    expect(w.find('.climb-sum').text()).toContain('38')
    w.unmount()
  })

  it('切到前后倾斜 / 载荷页签后无异常行', async () => {
    const w = mount(ClimbPage)
    await w.findAll('.dev-tabs button')[1].trigger('click')
    expect(w.findAll('.climb-line.is-bad')).toHaveLength(0)
    expect(w.find('.climb-lines').text()).toContain('3.11mm')
    await w.findAll('.dev-tabs button')[2].trigger('click')
    expect(w.find('.climb-lines').text()).toContain('1.03吨')
    w.unmount()
  })
})

describe('设备详情页', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function openCrane() {
    const sub = useSubpageStore()
    sub.openDevice('crane')
    const w = mount(Host)
    await nextTick()
    return w
  }

  it('深色子页 + 实时卡 + live/report 双页签（2026-11 设计稿改版）', async () => {
    const w = await openCrane()

    expect(w.find('.subpage').classes()).toContain('is-dark')
    expect(w.find('#subTitle').text()).toBe('智能塔机')
    expect(w.findAll('.dev-card')).toHaveLength(craneUnits.length)
    // 旧版的五张趋势图随设计稿改版移除，页签只剩实时 / 报表两个
    expect(w.find('.dev-view-tabs')).toBeTruthy()
    expect(w.find('.dev-view-tabs').text()).toContain('设备实时状态')
    expect(w.find('.dev-view-tabs').text()).toContain('作业报表')
    expect(w.find('.dev-chart').exists()).toBe(false)
    // 塔机实时卡是「今日吊次 / 今日吊重」两格
    expect(w.find('.dev-card').text()).toContain('今日吊次')
    expect(w.find('.dev-card').text()).toContain('今日吊重')
    w.unmount()
  })

  it('作业报表：日报合计与结论来自昨日数据（2026-11 设计稿）', async () => {
    const w = await openCrane()
    await w.findAll('.dev-view-tabs button')[1].trigger('click')
    await nextTick()

    // 昨日（history[0]）三台的合计：吊次 9+12+8、吊重 8.60+7.10+4.20
    const kpis = w.findAll('.report-kpi b').map((b) => b.text())
    expect(kpis[0]).toBe('29次')
    expect(kpis[1]).toBe('19.9t')
    // 结论按数据挑重点：利用率最低 + 报警台
    const points = w.findAll('.report-points li').map((li) => li.text())
    expect(points.length).toBeGreaterThanOrEqual(3)
    expect(points[0]).toContain('关注')
    expect(w.text()).toContain('3#塔机报警')
    // 机队表：表头 + 三台
    const lines = w.findAll('.report-line')
    expect(lines).toHaveLength(4)
    expect(lines[0].text()).toContain('吊次')
    expect(lines[1].text()).toContain('1#塔机')
    w.unmount()
  })

  it('作业报表：周报按 history 7 天汇总、月报用 21 天派生序列', async () => {
    const w = await openCrane()
    await w.findAll('.dev-view-tabs button')[1].trigger('click')
    const pills = w.findAll('.report-span button')
    expect(pills.map((p) => p.text())).toEqual(['日报', '周报', '月报'])

    await pills[1].trigger('click')
    await nextTick()
    // 周报 = 7 天合计：1# 59 + 2# 75 + 3# 63 = 197
    expect(w.findAll('.report-kpi b')[0].text()).toBe('197次')
    const weekRange = w.find('.report-date').text()
    expect(weekRange).toContain(' 至 ')

    await pills[2].trigger('click')
    await nextTick()
    // 月报区间是「2026-MM-DD 至 2026-MM-DD」，共 21 天（不含今日），可跨月
    expect(w.find('.report-date').text()).toMatch(/\d{4}-\d{2}-\d{2} 至 \d{4}-\d{2}-\d{2}/)
    const monthTrips = Number.parseInt(w.findAll('.report-kpi b')[0].text(), 10)
    expect(monthTrips).toBeGreaterThan(197)
    w.unmount()
  })

  it('报表内嵌在详情页里，实时/报表互切不换子页', async () => {
    const w = await openCrane()
    await w.findAll('.dev-view-tabs button')[1].trigger('click')
    await nextTick()
    expect(w.find('.report-share').exists()).toBe(true)

    await w.findAll('.dev-view-tabs button')[0].trigger('click')
    await nextTick()
    expect(w.find('.report-share').exists()).toBe(false)
    expect(w.findAll('.dev-card')).toHaveLength(3)
    w.unmount()
  })

  it('电梯用同一份页面，报表换成循环 / 载重 / 运送口径', async () => {
    const sub = useSubpageStore()
    sub.openDevice('lift')
    const w = mount(Host)
    await nextTick()

    expect(w.find('#subTitle').text()).toBe('智能电梯')
    expect(w.findAll('.dev-card')).toHaveLength(liftUnits.length)
    // 实时卡是当前状态四格
    expect(w.find('.dev-card').text()).toContain('当前楼层')
    await w.findAll('.dev-view-tabs button')[1].trigger('click')
    await nextTick()
    expect(w.find('.report-kpis').text()).toContain('合计循环')
    expect(w.find('.report-fleet').text()).toContain('运送')
    expect(w.find('.report-fleet').text()).not.toContain('吊重')
    w.unmount()
  })
})

describe('设备弹层', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('设备信息：五行台账', async () => {
    const sub = useSubpageStore()
    sub.openDevice('crane')
    const sheet = useBottomSheetStore()
    const w = mount(Host)
    await nextTick()

    // 注意 id 是设备序列号（2/3/4），不是台号（1#/2#/3#）：3 → 2#塔机
    sheet.openDeviceInfo('crane', '3')
    await nextTick()

    expect(w.find('.pop-title').text()).toBe('设备信息')
    expect(w.findAll('.dev-info-row')).toHaveLength(5)
    expect(w.text()).toContain('鄂AA-T32018')
    w.unmount()
  })

  it('历史数据：七个日期胶囊，可切换', async () => {
    const sub = useSubpageStore()
    sub.openDevice('crane')
    const sheet = useBottomSheetStore()
    const w = mount(Host)
    await nextTick()

    sheet.openDeviceHistory('crane', '4')
    await nextTick()

    expect(w.find('.pop-sub').text()).toBe('3#塔机')
    const dates = w.findAll('.dev-dates button')
    expect(dates).toHaveLength(7)
    expect(dates[0].classes()).toContain('on')

    await dates[3].trigger('click')
    expect(dates[3].classes()).toContain('on')
    expect(dates[0].classes()).not.toContain('on')
    w.unmount()
  })
})

describe('无人机页', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('实时监控 / 任务 / 参数 / 下发四块齐备', async () => {
    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await nextTick()

    expect(w.find('#subTitle').text()).toBe('无人机')
    expect(w.find('.subpage').classes()).toContain('is-dark')
    expect(w.findAll('.dev-block')).toHaveLength(4)
    // 任务管理 3 格 + 设备参数 8 格
    expect(w.findAll('.uav-stats > div')).toHaveLength(11)
    expect(w.findAll('.dev-block')[2].findAll('.uav-stats > div')).toHaveLength(8)
    expect(w.find('.uav-gate').text()).toBe('可下发')
    w.unmount()
  })

  it('五项起飞条件全过时才能下发', () => {
    expect(uavChecks.every((c) => c.ok)).toBe(true)
    // 任何一项不过，风险文案必须能指出来是哪一项
    for (const c of uavChecks) expect(c.risk).toBeTruthy()
  })

  it('切到机库是加载态，不显示实时画面', async () => {
    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await nextTick()

    expect(w.find('.uav-stage img').exists()).toBe(true)
    const dock = w.findAll('.dev-tabs button').find((b) => b.text() === '机库')
    await dock!.trigger('click')
    expect(w.find('.uav-stage').classes()).toContain('is-wait')
    expect(w.find('.uav-stage img').exists()).toBe(false)
    w.unmount()
  })
})
