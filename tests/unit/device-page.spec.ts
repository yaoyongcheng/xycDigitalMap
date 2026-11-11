import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import type { DroneTaskRecord } from '@/api/drone'
import { clearSession } from '@/api/drone'
import SheetHost from '@/components/overlays/SheetHost.vue'
import SubPage from '@/components/overlays/SubPage.vue'
import { useAuthStore } from '@/stores/auth'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useSubpageStore } from '@/stores/subpage'
import { useUavStore } from '@/stores/uav'
import EquipPanel from '@/views/home/EquipPanel.vue'
import { SKEL_DELAY } from '@/utils/slowLoading'
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

  it('已登录 + 台账还没回来：在数据位置铺灰条，不再整块弹「正在加载…」', async () => {
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000
    // 永不 resolve：请求停在「同步中」，模拟现场接口慢
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))

    vi.useFakeTimers()
    const w = mount(EquipPanel)
    await nextTick()

    // 骨架已占位（撑住版式），但阈值未到 → 不给用户看灰条
    expect(w.findAll('.skel').length).toBeGreaterThan(0)
    expect(w.find('.skel-fade.is-on').exists()).toBe(false)
    // 关键回归：加载态不再是一整块「正在加载设备台账…」的空态卡；
    // 这句话只保留给读屏（.sr-only），视觉上是一排灰条
    expect(w.find('[data-empty="equip"]').exists()).toBe(false)
    expect(w.find('.data-empty').exists()).toBe(false)
    expect(w.find('.sr-only[role="status"]').exists()).toBe(true)

    vi.advanceTimersByTime(SKEL_DELAY + 20)
    await nextTick()
    // 统计卡 + 四卡两段骨架同时淡入
    expect(w.findAll('.skel-fade.is-on').length).toBe(2)
    expect(w.findAll('.skel').length).toBeGreaterThan(6)

    w.unmount()
    vi.useRealTimers()
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
  /** stub 返回的执行记录；用例按需改写 */
  let stubRecords: DroneTaskRecord[] = []
  /** stub 返回的遥测 */
  let stubTelemetry: Record<string, unknown> = {}

  beforeEach(() => {
    setActivePinia(createPinia())
    stubRecords = []
    stubTelemetry = {}
    // 无人机页挂载即 load()，不 stub 会真的去请求 keehang 平台。
    // 这里按真实响应形状返回，用例改写 stubRecords / stubTelemetry 即可。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ code: 200, data }) })
        if (u.includes('/cas/auth/login')) return ok({ tgt: 'T', st: 'ST' })
        if (u.includes('/cas/auth/validate')) return ok({ uid: '1', token: 'TK' })
        if (u.includes('/task/exec/list/record')) return ok(stubRecords)
        if (u.includes('/dashboard/device/cache/telemetry')) return ok(stubTelemetry)
        return ok({})
      }),
    )
  })

  afterEach(async () => {
    // 先排空待决请求：上一个用例若没等 load() 结束，桩已被 unstubGlobals
    // 清掉，再放行就会真的打到 keehang 线上，并把会话写回模块级缓存。
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  /** 造一条今天的执行记录（服务端 start 是 ISO 串） */
  function todayRecord(over: Partial<DroneTaskRecord> = {}): DroneTaskRecord {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const start = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T15:00:00`
    return {
      id: 147744,
      taskName: '向阳村-安全巡检',
      lineId: 12,
      dockId: 23452,
      start,
      end: start,
      status: 1,
      scheduled: true,
      ...over,
    }
  }

  it('四块齐备：实时监控 / 任务管理 / 设备参数 / 任务下发', async () => {
    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await nextTick()

    expect(w.find('#subTitle').text()).toBe('无人机')
    expect(w.find('.subpage').classes()).toContain('is-dark')
    expect(w.findAll('.dev-block')).toHaveLength(4)
    w.unmount()
  })

  it('实时画面不再挂静态示意图，明说视频流未接入', async () => {
    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await nextTick()

    expect(w.find('.uav-stage').classes()).toContain('is-wait')
    expect(w.find('.uav-stage img').exists()).toBe(false)
    expect(w.find('.uav-stage').text()).toContain('实时视频流未接入')
    w.unmount()
  })

  it('任务数取真实执行记录，不写死', async () => {
    stubRecords = [todayRecord({ id: 1 }), todayRecord({ id: 2, status: 2 })]

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    const stats = w.findAll('.dev-block')[1].findAll('.uav-stats > div')
    expect(stats).toHaveLength(3)
    expect(stats[0].text()).toContain('2') // 今日任务
    expect(stats[1].text()).toContain('1') // 已完成
    w.unmount()
  })

  it('没有执行记录时给空态，不回落演示任务', async () => {
    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    expect(w.text()).toContain('今日暂无无人机任务')
    w.unmount()
  })

  it('设备参数用真实遥测；取不到的字段显示「—」而不是 0', async () => {
    stubRecords = [todayRecord()]
    stubTelemetry = {
      status: 1,
      lat: '30.5123',
      lng: '114.4567',
      batteryInfo: { batteries: [{ capacityPercent: 88, temperature: 29.3 }] },
      horizontalSpeed: 0,
      verticalSpeed: null,
      altitude: 117,
      attitudeHead: null,
    }

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    const stats = w.findAll('.dev-block')[2].findAll('.uav-stats > div')
    expect(stats).toHaveLength(8)
    expect(stats[1].text()).toContain('88%') // 电量
    expect(stats[3].text()).toContain('0m/s') // 水平速度
    // 垂直速度 / 航向角遥测没给 → 「—」，不能写成 0
    expect(stats[4].text()).toContain('—')
    expect(stats[6].text()).toContain('29.3℃')
    w.unmount()
  })

  it('缺数据的起飞条件按「未知」处理，不可下发并写明缺哪个指标', async () => {
    stubRecords = [todayRecord()]

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    // 风速 / 雨量 / 网络速率遥测接口没提供 → 不放行（把「没数据」当「满足」是放松安全门）
    const uav = useUavStore()
    expect(uav.canDispatch).toBe(false)
    expect(w.find('.uav-gate').text()).toBe('不可下发')
    expect(w.find('.uav-allow').text()).toContain('数据未接入')
    expect(w.find('.uav-send').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('遥测缺失时，电量也按未知处理', async () => {
    stubRecords = [todayRecord()]

    const sub = useSubpageStore()
    sub.openUav()
    mount(Host)
    await flushPromises()

    const uav = useUavStore()
    const battery = uav.checks.find((c) => c.name === '电量')
    expect(battery?.unknown).toBe(true)
    expect(battery?.ok).toBe(false)
  })
})
