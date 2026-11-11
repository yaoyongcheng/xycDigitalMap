import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import SheetHost from '@/components/overlays/SheetHost.vue'
import SubPage from '@/components/overlays/SubPage.vue'
import { uavChecks } from '@/data/device'
import { useAuthStore } from '@/stores/auth'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useSubpageStore } from '@/stores/subpage'
import EquipPanel from '@/views/home/EquipPanel.vue'
import { deviceRows, ledgerEnvelope } from '../fixtures/ledger'

/**
 * 智控 / 设备详情（2026-11 第二轮：全部改为真实台账）
 *
 * 这一组钉住三件事：
 *   ① 智控四卡与设备页的机组、台数、在线数都来自设备台账接口（:8084），
 *      不再有任何写死的台数与编造的作业指标；
 *   ② 接口要 Bearer，所以未登录时智控面板 / 设备页 / 爬架页都先给登录引导；
 *   ③ 没有数据源的区块（作业报表的 tsdb、爬架的传感器）显示明确空态，
 *      不用编造的曲线与机位读数填充。
 */

const Host = defineComponent({
  components: { SubPage, SheetHost },
  setup: () => () => h('div', [h(SubPage), h(SheetHost)]),
})

/** 造一个已登录会话并让台账接口返回夹具数据 */
function signIn(): void {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.expiresAt = Date.now() + 3_600_000
  vi.stubGlobal('fetch', vi.fn(async () => ledgerEnvelope()))
  useDeviceLedgerStore().apply(deviceRows())
}

describe('智控面板（真实台账）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('未登录：只给登录引导，不渲染任何设备数字', () => {
    const w = mount(EquipPanel)

    expect(w.find('[data-empty="equip"]').exists()).toBe(true)
    expect(w.find('[data-empty="equip"]').text()).toContain('登录后可查看设备台账')
    expect(w.findAll('.eq-card')).toHaveLength(0)
    expect(w.find('.eq-count').exists()).toBe(false)
    w.unmount()
  })

  it('已登录：四卡按台账渲染，台数与在线数是真的', async () => {
    signIn()
    const w = mount(EquipPanel)
    await nextTick()

    const pages = w.findAll('[data-page]').map((b) => b.attributes('data-page'))
    expect(pages).toEqual(['crane', 'lift', 'uav', 'climb'])

    const crane = w.find('[data-page="crane"]')
    // 塔机 4 台、3 台在线（智能塔机3 离线）
    expect(crane.text()).toContain('3/4')
    expect(crane.text()).toContain('70m')

    const lift = w.find('[data-page="lift"]')
    expect(lift.text()).toContain('2/2')

    const drone = w.find('[data-page="uav"]')
    // 无人机没有高度字段 → 数值位不渲染，只剩设备状态
    expect(drone.findAll('.eq-val')).toHaveLength(1)
    expect(drone.text()).toContain('设备状态')

    w.unmount()
  })

  it('台账为空：给「暂无设备台账数据」，不显示 0 台卡片', async () => {
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 200, data: { list: [], total: 0 } }),
      }) as unknown as Response),
    )

    const w = mount(EquipPanel)
    await flushPromises()

    expect(w.find('[data-empty="equip"]').text()).toContain('暂无设备台账数据')
    expect(w.findAll('.eq-card')).toHaveLength(0)
    w.unmount()
  })

  it('点卡片进各自的详情页', async () => {
    signIn()
    const sub = useSubpageStore()
    const w = mount(EquipPanel)
    await nextTick()

    await w.find('[data-page="crane"]').trigger('click')
    expect(sub.view).toEqual({ kind: 'device', device: 'crane' })
    expect(sub.title).toBe('智能塔机')
    expect(sub.isDark).toBe(true)
    w.unmount()
  })
})

describe('设备详情页（真实台账）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function open(kind: 'crane' | 'lift') {
    const sub = useSubpageStore()
    sub.openDevice(kind)
    const w = mount(Host)
    await nextTick()
    return w
  }

  it('未登录：先给登录引导，不渲染机组卡', async () => {
    const w = await open('crane')

    expect(w.find('[data-empty="device"]').text()).toContain('登录后可查看智能塔机运行状态')
    expect(w.findAll('.dev-card')).toHaveLength(0)
    w.unmount()
  })

  it('塔机：四台真实机组，四格来自台账字段（不再有今日吊次/吊重）', async () => {
    signIn()
    const w = await open('crane')
    await nextTick()

    expect(w.find('#subTitle').text()).toBe('智能塔机')
    const cards = w.findAll('.dev-card')
    expect(cards).toHaveLength(4)

    // 顺序照台账返回顺序：传统塔机5 → 智能塔机4 → 3 → 2
    expect(cards.map((c) => c.text())).toEqual(
      expect.arrayContaining([expect.stringContaining('智能塔机2'), expect.stringContaining('传统塔机5')]),
    )
    // 台账字段：高度带单位、司机、安检有效期、质检报告
    const card = cards[0].text()
    expect(card).toContain('高度')
    expect(card).toContain('10.3m')
    expect(card).toContain('安检有效期')
    // 没有数据源的两个指标必须消失
    expect(w.text()).not.toContain('今日吊次')
    expect(w.text()).not.toContain('今日吊重')
    // 离线机组的状态色走 is-off
    expect(cards.some((c) => c.find('.dev-status').classes().includes('is-off'))).toBe(true)
    w.unmount()
  })

  it('电梯：同一份页面，机组来自台账（2 台）', async () => {
    signIn()
    const w = await open('lift')
    await nextTick()

    expect(w.find('#subTitle').text()).toBe('智能电梯')
    const cards = w.findAll('.dev-card')
    expect(cards).toHaveLength(2)
    // 两台电梯的高度分别是 30m / 60m，顺序照台账返回
    expect(w.text()).toContain('30m')
    expect(w.text()).toContain('60m')
    w.unmount()
  })

  it('作业报表：没有 tsdb 数据 → 空态，不出现任何合计数字', async () => {
    signIn()
    const w = await open('crane')
    await nextTick()

    await w.findAll('.dev-view-tabs button')[1].trigger('click')
    await nextTick()

    expect(w.find('[data-empty="device-report"]').text()).toContain('暂无作业报表数据')
    expect(w.find('.report-kpi').exists()).toBe(false)
    expect(w.find('.report-share').exists()).toBe(false)
    w.unmount()
  })
})

describe('设备弹层（真实台账）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('设备信息：台账字段 + 责任人 + 更新时间', async () => {
    signIn()
    const sub = useSubpageStore()
    sub.openDevice('crane')
    const sheet = useBottomSheetStore()
    const w = mount(Host)
    await nextTick()

    // id 是台账主键（真实是 67/68/69/70/78/99/100/55），不是台号
    sheet.openDeviceInfo('crane', '69')
    await nextTick()

    expect(w.find('.pop-title').text()).toBe('设备信息')
    expect(w.find('.pop-sub').text()).toBe('智能塔机4')
    const rows = w.findAll('.dev-info-row').map((r) => r.text())
    expect(rows).toEqual(
      expect.arrayContaining([expect.stringContaining('高度'), expect.stringContaining('70m'), expect.stringContaining('塔吊司机')]),
    )
    w.unmount()
  })

  it('历史数据：没有 tsdb 数据 → 空态', async () => {
    signIn()
    const sub = useSubpageStore()
    sub.openDevice('crane')
    const sheet = useBottomSheetStore()
    const w = mount(Host)
    await nextTick()

    sheet.openDeviceHistory('crane', '69')
    await nextTick()

    expect(w.find('[data-empty="device-history"]').text()).toContain('暂无历史作业数据')
    expect(w.find('.dev-dates').exists()).toBe(false)
    w.unmount()
  })
})

describe('智能爬架（真实台账 + 空态）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('未登录：登录引导', async () => {
    const sub = useSubpageStore()
    sub.openClimb()
    const w = mount(Host)
    await nextTick()

    expect(w.find('[data-empty="climb"]').text()).toContain('登录后可查看智能爬架状态')
    w.unmount()
  })

  it('已登录：展示台账里的爬升高度，机位读数区为空态', async () => {
    signIn()
    const sub = useSubpageStore()
    sub.openClimb()
    const w = mount(Host)
    await nextTick()

    expect(w.find('.climb-sum').text()).toContain('1')
    expect(w.find('.climb-sum').text()).toContain('在线')
    expect(w.text()).toContain('爬升高度')
    expect(w.text()).toContain('21m')
    // 36 条编造机位读数已删除
    expect(w.findAll('.climb-line')).toHaveLength(0)
    expect(w.text()).toContain('暂无爬架机位读数')
    w.unmount()
  })
})

describe('无人机页', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('实时监控 / 任务 / 参数 / 下发四块齐备（阶段 6 前仍为设计稿常量）', async () => {
    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await nextTick()

    expect(w.find('#subTitle').text()).toBe('无人机')
    expect(w.find('.subpage').classes()).toContain('is-dark')
    expect(w.findAll('.dev-block')).toHaveLength(4)
    expect(w.findAll('.uav-stats > div')).toHaveLength(11)
    expect(w.findAll('.dev-block')[2].findAll('.uav-stats > div')).toHaveLength(8)
    expect(w.find('.uav-gate').text()).toBe('可下发')
    w.unmount()
  })

  it('五项起飞条件全过时才能下发', () => {
    expect(uavChecks.every((c) => c.ok)).toBe(true)
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
