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

  it('塔机 / 电梯 / 无人机有详情页，其余设备不可点', () => {
    const w = mount(EquipPanel)
    const pages = w.findAll('[data-page]').map((b) => b.attributes('data-page'))
    expect(pages).toEqual(['crane', 'lift', 'uav'])

    // 只有可点的卡片才画箭头
    expect(w.findAll('.eq-card.drill')).toHaveLength(3)
    // 机器人那批保持不可点：没有详情页，也没有可展开的机组
    expect(w.findAll('.eq-card:not(.drill)').length).toBeGreaterThan(0)
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

  it('深色子页 + 三张设备卡 + 五张趋势图', async () => {
    const w = await openCrane()

    expect(w.find('.subpage').classes()).toContain('is-dark')
    expect(w.find('#subTitle').text()).toBe('智能塔机')
    expect(w.findAll('.dev-card')).toHaveLength(craneUnits.length)
    expect(w.findAll('.dev-chart')).toHaveLength(5)
    // 塔机的指标名不能串到电梯的「循环次数」
    expect(w.find('.dev-chart h4, .dev-chart .dev-chart-hd span').text()).toBe('累计吊次')
    w.unmount()
  })

  it('日报入口只在设备页出现', async () => {
    const sub = useSubpageStore()
    const w = await openCrane()
    expect(w.find('#btnDeviceReport').exists()).toBe(true)

    sub.openReport('crane')
    await nextTick()
    expect(w.find('#btnDeviceReport').exists()).toBe(false)
    expect(w.find('#subTitle').text()).toBe('塔机日报')
    w.unmount()
  })

  it('日报的合计与结论来自昨日数据', async () => {
    const sub = useSubpageStore()
    sub.openReport('crane')
    const w = mount(Host)
    await nextTick()

    // 昨日（history[0]）三台的合计：吊次 9+12+8、吊重 8.60+7.10+4.20
    const kpis = w.findAll('.report-kpi b').map((b) => b.text())
    expect(kpis[0]).toBe('29次')
    expect(kpis[1]).toBe('19.9t')

    const notes = w.findAll('.report-note').map((p) => p.text())
    expect(notes).toHaveLength(3)
    expect(notes[0]).toContain('合计吊次 29 次')
    // 吊次最高的是 2#（12 次），吊重最高的是 1#（8.60t）—— 两台不是同一台
    expect(notes[1]).toContain('2#塔机累计吊次最高')
    expect(notes[1]).toContain('1#塔机吊重最高')
    expect(w.findAll('.report-card')).toHaveLength(3)
    w.unmount()
  })

  it('返回日报回到设备页，再返回才退出子页', async () => {
    const sub = useSubpageStore()
    sub.openDevice('crane')
    sub.openReport('crane')
    expect(sub.back).toEqual({ kind: 'device', device: 'crane' })

    sub.close()
    expect(sub.view.kind).toBe('device')
    sub.close()
    expect(sub.view.kind).toBe('none')
  })

  it('电梯用同一份页面，指标换成循环次数 / 运送人数', async () => {
    const sub = useSubpageStore()
    sub.openDevice('lift')
    const w = mount(Host)
    await nextTick()

    expect(w.find('#subTitle').text()).toBe('智能电梯')
    expect(w.findAll('.dev-card')).toHaveLength(liftUnits.length)
    expect(w.text()).toContain('循环次数')
    expect(w.text()).not.toContain('累计吊次')
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
