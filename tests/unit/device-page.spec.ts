import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import type { DroneTaskRecord } from '@/api/drone'
import { clearSession } from '@/api/drone'
import type { CraneRealtimeHandlers } from '@/api/craneRealtime'
import { subscribeCraneRealtime } from '@/api/craneRealtime'
import { fetchScaffold } from '@/api/scaffold'
import {
  fetchLiftAttr,
  fetchLiftOnline,
  fetchLiftToday,
  liftAuthFailed,
  liftGatewayStale,
} from '@/api/lift'
import SheetHost from '@/components/overlays/SheetHost.vue'
import SubPage from '@/components/overlays/SubPage.vue'
import CountUp from '@/components/ui/CountUp.vue'
import LivePlayer from '@/components/ui/LivePlayer.vue'
import { CRANE_SNS } from '@/data/craneSn'
import { useAuthStore } from '@/stores/auth'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useScaffoldStore } from '@/stores/scaffold'
import { useSubpageStore } from '@/stores/subpage'
import { useUavStore } from '@/stores/uav'

/*
 * mpegts.js 的桩：happy-dom 没有 MSE，真库既加载失败又慢。
 * 这里给一个「能连上」的假播放器 —— 真正的 MSE 解码测不了，但状态机可以测：
 * 事件回调留在 `globalThis.__mpegts` 上，用例可以手动触发 ERROR，
 * 也可以给 `<video>` 派发 `playing` 来模拟真的出画面。
 */
vi.mock('mpegts.js', () => {
  const handlers: Record<string, () => void> = {}
  ;(globalThis as Record<string, unknown>).__mpegts = handlers
  return {
    default: {
      isSupported: () => true,
      Events: { ERROR: 'error', MEDIA_INFO: 'mediaInfo' },
      createPlayer: () => ({
        attachMediaElement: vi.fn(),
        load: vi.fn(),
        play: () => Promise.resolve(),
        pause: vi.fn(),
        unload: vi.fn(),
        detachMediaElement: vi.fn(),
        destroy: vi.fn(),
        on: (ev: string, cb: () => void) => {
          handlers[ev] = cb
        },
      }),
    },
  }
})
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

/**
 * 爬架传感器夹具（取自 2026-11 现场实测的真实极值）。
 *
 * 故意只放 3 条：够覆盖「最不利机位在哪台、超限只有一条、另一个指标不超限」
 * 这三件事，又不必把 38 条都抄进测试。
 */
const SCAFFOLD_ROWS = [
  { item: '19#机位', lrTilt: 0.4, fbTilt: 6.36, load: 0.1, time: '2026-11-07 13:58:53' },
  { item: '30#机位', lrTilt: 179.5, fbTilt: 2.1, load: 0.2, time: '2026-11-07 14:02:49' },
  { item: '6#机位', lrTilt: 1.2, fbTilt: 3.3, load: 0.61, time: '2026-11-07 13:58:53' },
]

/**
 * 爬架读数改由接口给（2026-11-13）。
 *
 * 智控面板现在每次挂载都会刷新（切回智控标签时的行为，见 `EquipPanel` 的
 * onMounted），所以「用 `apply()` 先灌好数据再 mount」会被这次刷新覆盖掉。
 * 想断言「有读数时怎么渲染」，就得让这次刷新真的拿到读数 —— 因此 mock 掉
 * `api/scaffold`，按用例决定返回 live / snapshot / null。
 */
vi.mock('@/api/scaffold', () => ({ fetchScaffold: vi.fn() }))
const mockScaffold = vi.mocked(fetchScaffold)

/**
 * 电梯数据同样改由接口给（2026-11-13）。
 *
 * 智控面板与电梯详情页挂载时都会 `lift.refresh()`（切回智控 = 重新取数），
 * 真实实现会打 IOT 网关。测试里必须换成假实现：一来不该打真实网络，
 * 二来「有 IOT 数据时怎么渲染」需要按用例决定返回什么。
 *
 * 默认三个都回 null（= 网关没有任何电梯数据），此时电梯卡只剩「在线 x/y」
 * 一格且走台账口径 —— 与改造前的可见结果一致。
 */
vi.mock('@/api/lift', () => ({
  LIFT_PRODUCT: '01724121a94f4893b693f253173d1082',
  fetchLiftOnline: vi.fn(),
  fetchLiftToday: vi.fn(),
  fetchLiftAttr: vi.fn(),
  // 作业报表（电梯分支）：这个 spec 只测实时状态页，报表页有自己的 lift-report.spec
  fetchLiftWorkRange: vi.fn(async () => null),
  // 凭证失效标记：默认「没失效」，用例按需让它为真以驱动提示条
  liftAuthFailed: vi.fn(() => false),
  // 「重试过、网关还没轮换令牌」：默认假，用例按需打开第二句文案
  liftGatewayStale: vi.fn(() => false),
  clearLiftAuthFailure: vi.fn(),
}))
const mockLiftOnline = vi.mocked(fetchLiftOnline)
const mockLiftToday = vi.mocked(fetchLiftToday)
const mockLiftAttr = vi.mocked(fetchLiftAttr)

/**
 * 塔机实时通道改由用例驱动（2026-11-13）。
 *
 * 首页 5G塔机卡的「在线设备」现在按**子页面口径**算：状态取自实时四态
 * （离线 / 待机 / 工作中 / 正在吊装），不是台账的 `online_status`。
 * 想知道「有帧时怎么渲染」，就得能往 store 里推帧 —— 真实 WebSocket 在
 * 测试里连不上，所以这里把订阅函数换成一个可以手动回放的假实现。
 *
 * 默认不推任何帧：此时 `stateOf()` 返回 null，回落到台账 —— 与改造前一致。
 */
vi.mock('@/api/craneRealtime', async (orig) => {
  const actual = await orig<typeof import('@/api/craneRealtime')>()
  return { ...actual, subscribeCraneRealtime: vi.fn() }
})
const mockSubscribe = vi.mocked(subscribeCraneRealtime)

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

/** 当前挂上的实时订阅（用例往里推帧）；没订阅时是 null */
let craneHandlers: CraneRealtimeHandlers | null = null

describe('智控面板（真实台账）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 默认「传感器没取到」，需要读数的用例自己改返回值
    mockScaffold.mockResolvedValue(null)
    // 默认「IOT 里没有电梯数据」—— 电梯连不上即全部离线，今日运行时长那格念「—」
    mockLiftOnline.mockResolvedValue(null)
    mockLiftToday.mockResolvedValue(null)
    mockLiftAttr.mockResolvedValue(null)
    // 默认「凭证有效」，要测提示条的用例自己打开
    vi.mocked(liftAuthFailed).mockReturnValue(false)
    vi.mocked(liftGatewayStale).mockReturnValue(false)
    craneHandlers = null
    mockSubscribe.mockReset()
    mockSubscribe.mockImplementation((h) => {
      craneHandlers = h
      return () => {}
    })
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
    // 塔机 4 台、2 台在线：智能塔机3 台账就是离线；传统塔机5 没有平台编号，
    // 实时四态恒为「离线」（子页面里它也显示离线）。没推帧的其余车回落台账。
    expect(crane.text()).toContain('2/4')
    // 塔机的作业指标（吊重/吊次）要工作循环接口 + sn，现场没有 →
    // 数值位退回台账里的最大高度；单位走 .eq-stat-unit 单独排（设计稿做法）
    expect(crane.text()).toContain('70')
    expect(crane.find('.eq-stat-unit').text()).toBe('m')
    expect(crane.text()).toContain('最大高度')

    const lift = w.find('[data-page="lift"]')
    // 电梯按**轿厢**算：分母 4（台账那 2 行是「楼」，实时数据是逐笼的）。
    // 这条用例里网关没有应答（默认 mock 回 null）→ **全部算离线 0/4**。
    // 不回落台账：台账登记态不随实时通断变化，拿它顶替会画出「4/4 在线」
    // 而每一格都是「—」（用户 2026-11-13 要求连不上即离线）。
    expect(lift.text()).toContain('0/4')

    const drone = w.find('[data-page="uav"]')
    /*
     * 无人机卡只剩一格「今日作业次数」（用户 2026-11-13 要求）。
     * 不再并排念「设备状态 0/1」——那是台账登记态，与「今天飞了几架次」无关，
     * 两格并排还会被读成「1 架里 0 架在线」。在线与否由标题旁的状态点表达。
     */
    expect(drone.findAll('.eq-val')).toHaveLength(1)
    expect(drone.text()).toContain('今日作业次数')
    // 这一屏没有灌统计 → 「—」，不写 0
    expect(drone.text()).toContain('—')
    expect(drone.text()).not.toContain('设备状态')

    // 页面边界：整页就是「统计两卡 + 9 张卡」，与设计稿 renderEquip 一致。
    // 曾有的「全部设备运行状态」逐台清单已按用户要求移除，逐台状态归详情页。
    expect(w.text()).not.toContain('全部设备运行状态')
    expect(w.findAll('.eq-card')).toHaveLength(9)

    w.unmount()
  })

  it('塔机在线数按子页面口径：有实时帧就算在线，没编号的传统塔机5 恒离线', async () => {
    signIn()
    const w = mount(EquipPanel)
    await nextTick()

    // 还没推帧：通道判断不了这几台 → 回落到台账（智能塔机3 台账离线）
    expect(w.find('[data-page="crane"]').text()).toContain('2/4')

    // 三台车各来一帧、都没动 → 子页面里是「待机」，都算非离线
    craneHandlers?.onState?.('open')
    for (const e of CRANE_SNS) {
      craneHandlers?.onData({
        sn: e.sn,
        deviceName: e.name,
        at: '2026-11-13 09:00:00',
        angle: 0,
        range: 0,
        height: 0,
        weight: 0,
        weightRate: 0,
        hasLoad: false,
        bodyHeight: 0,
        topHeight: 0,
      })
    }
    await nextTick()

    const crane = w.find('[data-page="crane"]')
    expect(crane.text()).toContain('3/4')
    // 3/4 是「部分在线」，状态点跟着走，不能还是满格绿
    expect(crane.find('.eq-dot').classes()).toContain('warn')

    w.unmount()
  })

  it('爬架卡：传感器没取到时三格是「—」，说明行如实说未取到，不标红', async () => {
    signIn()
    const w = mount(EquipPanel)
    await flushPromises()

    const climb = w.find('[data-page="climb"]')
    expect(climb.classes()).toContain('is-climb')

    const cells = climb.findAll('.eq-val')
    expect(cells).toHaveLength(3)
    for (const c of cells) expect(c.find('b').text()).toBe('—')
    expect(cells.map((c) => c.find('span').text())).toEqual(['左右倾斜', '前后倾斜', '载荷'])
    // 没有读数就没有「超限」这个结论：红底一次都不出现
    expect(climb.find('.eq-val.is-bad').exists()).toBe(false)
    expect(climb.find('.eq-climb-note').classes()).not.toContain('is-bad')
    expect(climb.find('.eq-climb-note').text()).toContain('传感器数据未取到')
    // 真实在线数保留在说明行里
    expect(climb.find('.eq-climb-note').text()).toContain('1/1')

    w.unmount()
  })

  it('爬架卡：三格是「正常机位数/有读数的机位数」，超限那格少一台并报出机位名', async () => {
    signIn()
    mockScaffold.mockResolvedValue({ sensors: SCAFFOLD_ROWS, source: 'live' })
    const w = mount(EquipPanel)
    await flushPromises()

    const climb = w.find('[data-page="climb"]')
    const cells = climb.findAll('.eq-val')
    // 夹具 3 台：30# 左右倾斜 179.5mm 越了 60mm，另两台在阈值内
    // → 左右倾斜 2/3、前后倾斜 3/3、载荷 3/3（分母是「有该指标读数」的机位数）
    expect(cells.map((c) => c.find('b').text())).toEqual(['2/3', '3/3', '3/3'])
    expect(cells.map((c) => c.find('span').text())).toEqual(['左右倾斜', '前后倾斜', '载荷'])
    // 分子是「正常台数」，恒绿（不随超限改色 —— 2 台确实是好的）
    for (const c of cells) expect(c.find('b em').classes()).toContain('eq-ok')
    // 超限信号不打在格子上，交给说明行（红底 + 机位名 + 读数 + 阈值）
    expect(climb.find('.eq-val.is-bad').exists()).toBe(false)
    expect(climb.find('.eq-climb-note').text()).toBe('30#机位 左右倾斜 179.5mm，超过 60mm')
    expect(climb.find('.eq-climb-note').classes()).toContain('is-bad')

    w.unmount()
  })

  /**
   * 来源标注的红线：内置快照与 CDN 实时**一视同仁**，页面只说读数时间。
   *
   * 之前快照来源会写「离线快照 · 数据 HH:mm」，用户要求去掉 —— 判断数据
   * 新不新交给时间戳，不要在文案里解释后端链路。
   */
  it('爬架卡：快照来源不写「离线快照」，只报读数时间', async () => {
    signIn()
    mockScaffold.mockResolvedValue({ sensors: SCAFFOLD_ROWS, source: 'snapshot' })
    const w = mount(EquipPanel)
    await flushPromises()

    // 最不利机位仍超限（读数本身不因来源而变）
    const note = w.find('[data-page="climb"] .eq-climb-note').text()
    expect(w.find('[data-page="climb"] .eq-climb-note').classes()).toContain('is-bad')
    expect(note).toContain('30#机位')
    expect(note).not.toContain('快照')
    expect(note).not.toContain('离线')

    w.unmount()
  })

  it('爬架卡：快照来源未超限时也只标「HH:mm 更新」', async () => {
    signIn()
    // 三条读数全部在阈值内 —— 走的是「全部在阈值内」那一支
    mockScaffold.mockResolvedValue({
      sensors: [
        { item: '19#机位', lrTilt: 0.4, fbTilt: 6.36, load: 0.1, time: '2026-11-07 13:58:53' },
        { item: '6#机位', lrTilt: 1.2, fbTilt: 3.3, load: 0.61, time: '2026-11-07 14:02:49' },
      ],
      source: 'snapshot',
    })
    const w = mount(EquipPanel)
    await flushPromises()

    const note = w.find('[data-page="climb"] .eq-climb-note').text()
    expect(note).toContain('2 个机位')
    expect(note).toContain('14:02 更新')
    expect(note).toContain('全部在阈值内')
    expect(note).not.toContain('快照')
    expect(note).not.toContain('离线')

    w.unmount()
  })

  it('5 类机器人是静态卡：div 不可点、作业次数取 V2 预置值、无箭头', async () => {
    signIn()
    const w = mount(EquipPanel)
    await nextTick()

    const all = w.findAll('.eq-card')
    expect(all).toHaveLength(9)

    const robots = w.findAll('div.eq-card')
    expect(robots).toHaveLength(5)
    expect(w.findAll('button.eq-card')).toHaveLength(4)
    // 与 V2 预制体「施工机器人栏」的 Value 一一对应，顺序即 ROBOT_CARDS 顺序
    const trips = ['5次', '4次', '7次', '9次', '3次']
    robots.forEach((r, i) => {
      expect(r.attributes('data-page')).toBeUndefined()
      expect(r.classes()).not.toContain('drill')
      expect(r.find('.eq-more').exists()).toBe(false)
      expect(r.find('.eq-val b').text()).toBe(trips[i])
      expect(r.find('.eq-val span').text()).toBe('今日作业次数')
      // 读屏听不到「卡片不可点」这些视觉线索，必须念出是示意值
      expect(r.attributes('aria-label')).toContain('示意值')
      // 现场这几类机器人常驻在线 → 显式给绿点（不能靠 units 派生：那是灰点=离线）
      const dot = r.find('.eq-dot')
      expect(dot.exists()).toBe(true)
      expect(dot.classes()).toContain('on')
    })

    // 点机器人卡不该跳任何页面
    const sub = useSubpageStore()
    await robots[0].trigger('click')
    expect(sub.view).toEqual({ kind: 'none' })

    w.unmount()
  })

  /*
   * 红线守卫。
   *
   * 2026-11 第三轮：没有数据源时一个数字都不许出现（数值位只有「—」）。
   *
   * 2026-11-12 用户要求「V2 从哪取你也从哪取」，于是机器人卡的作业次数
   * 改为 V2 预制体里写死的那组值 —— 这是**唯一**一处授权例外，所以守卫从
   * 「不许有数字」改成「只许出现 V2 预置的那五个值」：数字必须落在白名单里，
   * 任何别处冒出来的示意值（比如设计稿以外的杜撰数字）仍会被挡下。
   *
   * 爬架三格不在例外内：它们必须来自 CDN 读数，取不到就仍是「—」。
   */
  it('红线：机器人卡只出现 V2 预置值，爬架三格不出现编造读数', async () => {
    signIn()
    const w = mount(EquipPanel)
    await nextTick()

    const v2Preset = ['5次', '4次', '7次', '9次', '3次']
    for (const r of w.findAll('div.eq-card')) {
      const shown = r.find('.eq-val b').text()
      expect(v2Preset, `机器人卡出现白名单外的值「${shown}」`).toContain(shown)
    }

    const climb = w.find('[data-page="climb"]')
    // 说明行里那个「在线 1/1」是台账里的真实在线数，先摘出去再查编造读数
    const note = climb.find('.eq-climb-note').text()
    expect(climb.text().replace(note, '')).not.toMatch(/[0-9]/)
    // 没有读数就是「—」，绝不用 0/0 表示「一台都不正常」
    for (const c of climb.findAll('.eq-val')) expect(c.find('b').text()).toBe('—')

    const text = w.text()
    // 「5次/4次/7次/9次/3次」现在是机器人卡的白名单值（上面已逐张校验），不再列入
    for (const fake of ['35/36', '179.70', '30#机位', '超过 60mm', '今日吊次 26']) {
      expect(text, `编造值「${fake}」不该出现`).not.toContain(fake)
    }

    w.unmount()
  })

  /*
   * 三格只表达「几台正常」，不再承担超限配色：
   * 分子恒绿、分母中性，异常由下面那行说明报红。给格子加 is-bad / is-ok
   * 会把「正常 2 台」涂红，读的人会以为那 2 台有问题。
   */
  it('爬架三格不带 is-bad / is-ok：超限信号只走说明行', async () => {
    signIn()
    const w = mount(EquipPanel)
    await nextTick()

    const climb = w.find('[data-page="climb"]')
    expect(climb.findAll('.is-bad, .is-ok')).toHaveLength(0)
    for (const c of climb.findAll('.eq-val')) expect(c.classes()).toEqual(['eq-val'])

    w.unmount()
  })

  it('统计卡：9 类（4 类台账设备 + 5 类机器人）15 台（卡片分母 10 台 + 机器人 5 台）', async () => {
    signIn()
    vi.useFakeTimers()
    const w = mount(EquipPanel)
    await nextTick()

    const items = w.findAll('.eq-count-item')
    expect(items).toHaveLength(2)
    // 种类 / 台数来自 CountUp 的入参（渲染值要等滚动动画结束）
    const nums = items.map((i) => i.findComponent(CountUp).props('value'))
    expect(nums).toEqual([9, 15])

    // 滚完之后上屏的也是这两个数
    // 种类 = 页面上的设备类别数（4 台账类 + 5 机器人，与 V2 装备管理页同口径）
    // 台数 = 各卡分母之和 10 台（塔机 4 + 电梯 4 + 无人机 1 + 爬架 1）+ 5 类机器人各 1 台
    // 电梯按 4 个轿厢计（台账只有 2 行「楼」，见 data/liftSn.ts）
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(items[0].find('b').text()).toBe('9种')
    expect(items[1].find('b').text()).toBe('15台')

    // 在线 = 塔机 2 + 电梯 0（网关没应答 → 连不上即离线，不回落台账）+ 爬架 1
    //      + 无人机 1 + 5 类机器人各计 1 台 = 9；离线 = 15 - 9 = 6
    // 离线那六台：4 个轿厢（网关连不上）+ 台账就是离线的智能塔机3 + 没有平台编号的传统塔机5
    const leg = w.findAll('.eq-status-leg > div')
    expect(leg).toHaveLength(2)
    expect(leg[0].find('b').text()).toBe('9')
    expect(leg[1].find('b').text()).toBe('6')

    w.unmount()
    vi.useRealTimers()
  })

  it('无人机：统计没取到时写「—」，不写 0/0 也不退回历史条数', async () => {
    signIn()

    // 有执行记录，但都不是今天的 —— 这不再决定卡片数字（数字只认统计接口）。
    // 关键是 `stat` 仍为空 → 卡片必须写「—」，因为「今天没飞」与「没取到」不同。
    const past = '2026-01-05'
    useUavStore().apply([
      {
        id: 1,
        uuid: 'u-1',
        taskName: '向阳村-安全巡检',
        lineId: 1,
        dockId: 263,
        start: `${past}T09:00:00`,
        end: `${past}T09:20:00`,
        status: 2,
        scheduled: true,
      },
    ])

    const w = mount(EquipPanel)
    await nextTick()

    const drone = w.find('[data-page="uav"]')
    expect(drone.findAll('.eq-val')).toHaveLength(1)
    expect(drone.text()).toContain('今日作业次数')
    expect(drone.text()).toContain('—')
    expect(drone.text()).not.toContain('0/0')

    w.unmount()
  })

  it('电梯卡：在线数与今日运行时长来自 IOT，不再拿台账高度顶替', async () => {
    signIn()
    /*
     * 2026-11-13 现场实测的一组数：
     *   1# 楼主笼（3225122202）在线、今日 51 条工作循环共 2841s ≈ 47min；
     *   2# 楼副笼（E03C1CB9F5011824）明确离线；另两个轿厢网关里没有记录。
     * 分母是**轿厢数 4**（台账只有 2 行「楼」，实时数据是逐笼的），
     * 没有记录的两笼按 V2 `IsOnline` 口径算离线 → 1/4。
     */
    mockLiftOnline.mockResolvedValue({ '3225122202': true, E03C1CB9F5011824: false })
    mockLiftToday.mockResolvedValue({ '3225122202': { trips: 51, seconds: 2841 } })

    const w = mount(EquipPanel)
    await flushPromises()

    const lift = w.find('[data-page="lift"]')
    const vals = lift.findAll('.eq-val')
    expect(vals[0].text()).toContain('1')
    expect(vals[0].text()).toContain('/4')
    expect(vals[0].text()).toContain('在线设备')
    // 第二格：设计稿那格（稿上写「累计运行时间」，这里补上「今日」），
    // 2841s → 47min
    expect(vals[1].find('b').text()).toBe('47min')
    expect(vals[1].text()).toContain('今日运行时长')

    w.unmount()
  })

  it('电梯凭证失效：首页给提示条，点「重试」重新取数而不是跳登录页', async () => {
    signIn()
    vi.mocked(liftAuthFailed).mockReturnValue(true)

    const w = mount(EquipPanel)
    await nextTick()
    await flushPromises()

    const bar = w.find('.dev-auth')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('电梯物联网网关凭证失效')
    expect(bar.find('.dev-auth-btn').text()).toBe('重试')

    const before = mockLiftOnline.mock.calls.length
    await bar.find('.dev-auth-btn').trigger('click')
    await flushPromises()
    // 真的又去取了一轮
    expect(mockLiftOnline.mock.calls.length).toBeGreaterThan(before)
    // 但**不跳登录页**：登录换的是 :8081 的 Bearer，跟 IOT 的 ak/sk 令牌不同源
    expect(useSubpageStore().view.kind).not.toBe('login')
    w.unmount()
  })

  /**
   * 「重试过了，网关还是原来那张令牌」—— 网络层已经收手（一个数据请求都没发），
   * 页面上必须换句话，否则用户会以为自己没点上，反复点。
   *
   * 这里连 `authLost` 的文案边界一起钉住：不能再说「重试可重新获取」。
   */
  it('网关未恢复：提示条换成「尚未恢复」，不再承诺重试可得', async () => {
    signIn()
    vi.mocked(liftAuthFailed).mockReturnValue(true)
    vi.mocked(liftGatewayStale).mockReturnValue(true)

    const w = mount(EquipPanel)
    await nextTick()
    await flushPromises()

    const bar = w.find('.dev-auth')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('电梯物联网网关未恢复')
    expect(bar.text()).not.toContain('重新获取')
    w.unmount()
  })

  it('aria-label：可下钻卡念「在线数 + 数值 + 点击去向」，机器人卡念「示意值」', async () => {
    signIn()
    const w = mount(EquipPanel)
    await nextTick()

    // 句式照设计稿 app.js:982-990，但只念真实存在的格子（没有的格子不报）
    expect(w.find('[data-page="crane"]').attributes('aria-label')).toBe(
      '5G塔机，在线设备2/4，最大高度70m，点击查看明细',
    )
    // 电梯「今日运行时长」那格常驻（设计稿是两列），没数就念「—」——
    // 与可视格同口径，不拿台账的高度冒充
    expect(w.find('[data-page="lift"]').attributes('aria-label')).toBe(
      '智能电梯，在线设备0/4，今日运行时长—，点击查看明细',
    )
    // 无人机只有一格「今日作业次数」，没取到就如实说不报数
    expect(w.find('[data-page="uav"]').attributes('aria-label')).toBe('无人机，今日作业次数未取到，点击进入控制')
    // 爬架：传感器没取到这条结论要念出来，在线数是真的
    expect(w.find('[data-page="climb"]').attributes('aria-label')).toBe(
      '智能爬架，传感器数据未取到，在线 1/1，点击查看点位',
    )

    // 机器人卡：数值来自 V2 预制体的模拟值，必须念出「示意值」；
    // 有绿点就要念「在线」（视觉与读屏不能两套信息）
    expect(w.find('div.eq-card').attributes('aria-label')).toBe(
      '地坪研磨机器人，在线，今日作业次数5次，示意值',
    )

    w.unmount()
  })

  it('塔机接上工作循环后：数值位换成「今日吊重 + 今日吊次」，高度让位', async () => {
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000

    // 一台塔机的 extra_fields 里补上序列号 —— 有了 sn 才会去查工作循环
    const rows = deviceRows().map((r) =>
      r.id === 67
        ? {
            ...r,
            device_info: {
              ...r.device_info,
              extra_fields: JSON.stringify([
                { label: '高度', value: 64 },
                { label: '序列号', value: 'TC-67' },
              ]),
            },
          }
        : r,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('getWorkCycleInfoHis')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: 200,
              success: true,
              data: [
                { startTime: 1762000000000, endTime: 1762000060000, maxWeight: 1.2 },
                { startTime: 1762000100000, endTime: 1762000180000, maxWeight: 0.67 },
                { startTime: 1762000200000, endTime: 1762000280000 },
              ],
            }),
          } as unknown as Response
        }
        return ledgerEnvelope(rows)
      }),
    )
    useDeviceLedgerStore().apply(rows)
    await flushPromises()

    const w = mount(EquipPanel)
    await flushPromises()
    await nextTick()

    const crane = w.find('[data-page="crane"]')
    const cells = crane.findAll('.eq-val')
    // 在线格 + 吊重 + 吊次 三格
    expect(cells).toHaveLength(3)
    expect(cells[1].text()).toContain('今日吊重')
    expect(cells[1].find('b').text()).toBe('1.87t')
    expect(cells[2].text()).toContain('今日吊次')
    // 3 条循环 = 吊 3 次（其中一条没有重量，仍然算一次）
    expect(cells[2].find('b').text()).toBe('3次')
    // 有作业指标就不该再显示台账高度那一格
    expect(crane.text()).not.toContain('最大高度')

    w.unmount()
  })

  it('无人机取到今日统计后渲染「今日作业次数 N次」（取已完成，不是任务总数）', async () => {
    signIn()

    // 截图同款：今日任务 15 / 已完成 11 / 失败 0 —— 卡片要的是 11
    useUavStore().apply([], null, {
      taskCount: 15,
      finishedCount: 11,
      failedCount: 0,
      runningCount: 0,
      planCount: 4,
      suspendedCount: 0,
    })

    const w = mount(EquipPanel)
    await nextTick()

    const drone = w.find('[data-page="uav"]')
    const cells = drone.findAll('.eq-val')
    expect(cells).toHaveLength(1)
    expect(cells[0].text()).toContain('今日作业次数')
    expect(cells[0].text()).toContain('11')
    expect(cells[0].text()).toContain('次')
    // 「今日任务 15」含 4 条还没飞的计划，不是作业次数
    expect(cells[0].text()).not.toContain('15')

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
    expect(sub.title).toBe('5G塔机')
    expect(sub.isDark).toBe(true)
    w.unmount()
  })
})

describe('设备详情页（真实台账）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 电梯页挂载即拉 IOT；默认回空，不让测试打真实网关
    mockLiftOnline.mockResolvedValue(null)
    mockLiftToday.mockResolvedValue(null)
    mockLiftAttr.mockResolvedValue(null)
    // 默认「凭证有效」，用例要测提示条时自己打开
    vi.mocked(liftAuthFailed).mockReturnValue(false)
    vi.mocked(liftGatewayStale).mockReturnValue(false)
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

    expect(w.find('[data-empty="device"]').text()).toContain('登录后可查看5G塔机运行状态')
    expect(w.findAll('.dev-card')).toHaveLength(0)
    w.unmount()
  })

  it('塔机：四台真实机组，卡片是「今日吊次/吊重 + 当前吊重/负荷」', async () => {
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000
    // 两条链路分流：工作循环接口回 res.json，台账回 res.text —— 混用会解析出空对象
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('getWorkCycleInfoHis')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: 200,
              success: true,
              // 两条循环：2.5 + 1.25 → 吊次 2、吊重 3.75t
              data: [
                { startTime: '2026-11-12 09:00:00', endTime: '2026-11-12 09:03:00', weight: 2.5 },
                { startTime: '2026-11-12 09:10:00', endTime: '2026-11-12 09:12:00', weight: 1.25 },
              ],
            }),
          } as unknown as Response
        }
        return ledgerEnvelope()
      }),
    )
    useDeviceLedgerStore().apply(deviceRows())
    await flushPromises()

    const w = await open('crane')
    await nextTick()

    expect(w.find('#subTitle').text()).toBe('5G塔机')
    const cards = w.findAll('.dev-card')
    expect(cards).toHaveLength(4)

    // 按台号升序（服务端按 id 倒序返回，页面排序；见 utils/deviceLedger.ts: byUnitNo）
    const names = cards.map((c) => c.find('.dev-card-hd strong span').text())
    expect(names).toEqual(['智能塔机2', '智能塔机3', '智能塔机4', '传统塔机5'])

    // 四格照 V2 塔机卡（今日吊次 / 今日吊重 / 当前吊重 / 当前负荷）
    const labels = cards[0].findAll('.dev-card-grid span').map((s) => s.text())
    expect(labels).toEqual(['今日吊次', '今日吊重', '当前吊重', '当前负荷'])

    // 今日两项来自工作循环接口（逐台，不是全场合计）；
    // 当前两项来自实时通道，测试环境连不上 broker → 「—」
    const vals = cards[0].findAll('.dev-card-grid b').map((b) => b.text())
    expect(vals).toEqual(['2次', '3.75t', '—', '—'])
    // 没有实时帧就不画负荷条（画一条 0% 会被读成「负荷为零」）
    expect(cards[0].find('.dev-load').exists()).toBe(false)

    // 传统塔机5 没有平台编号 → 四格全「—」，不拿台账的高度/功效顶替
    expect(cards[3].findAll('.dev-card-grid b').map((b) => b.text())).toEqual(['—', '—', '—', '—'])

    // 状态：实时通道没通 → 回落台账（智能塔机3 的 online_status 是 0）
    expect(cards.some((c) => c.find('.dev-status').classes().includes('is-off'))).toBe(true)
    w.unmount()
  })

  it('塔机：当天一条循环都没有时，今日吊重写 0.00t 而不是横杠', async () => {
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('getWorkCycleInfoHis')) {
          // 接口通了、今天一条都没有 —— 与「接口挂了」是两件事
          return { ok: true, status: 200, json: async () => ({ code: 200, success: true, data: [] }) } as unknown as Response
        }
        return ledgerEnvelope()
      }),
    )
    useDeviceLedgerStore().apply(deviceRows())
    await flushPromises()

    const w = await open('crane')
    await nextTick()

    const cards = w.findAll('.dev-card')
    // 2#/3#/4# 查询成功、当天 0 条：吊次 0次、吊重 0.00t（「今天没吊」是结论）
    expect(cards[0].findAll('.dev-card-grid b').map((b) => b.text())).toEqual(['0次', '0.00t', '—', '—'])
    // 传统塔机5 没有平台编号，连「今天没吊」都无从谈起 → 保持「—」
    expect(cards[3].findAll('.dev-card-grid b').map((b) => b.text())).toEqual(['—', '—', '—', '—'])
    w.unmount()
  })

  it('电梯：按轿厢出 4 张卡（不是台账那 2 行），四格是 IOT 工况', async () => {
    signIn()
    const w = await open('lift')
    await nextTick()

    expect(w.find('#subTitle').text()).toBe('智能电梯')
    const cards = w.findAll('.dev-card')
    // 台账只有「智能电梯1/2」两行（按楼登记），但实时数据是逐笼的 —— 4 个轿厢各一张卡
    expect(cards).toHaveLength(4)
    expect(cards.map((c) => c.find('.dev-card-hd strong span').text())).toEqual([
      '智能电梯1-1',
      '智能电梯1-2',
      '智能电梯2-1',
      '智能电梯2-2',
    ])
    // 四格照设计稿 gx2 的 renderLiftCard；网关没有工况帧时全「—」，
    // 不回落到台账的「高度 60m」—— 档案字段不该冒充实时读数
    expect(cards[0].findAll('.dev-card-grid span').map((s) => s.text())).toEqual([
      '当前楼层',
      '当前高度',
      '当前人数',
      '当前载重',
    ])
    expect(cards[0].findAll('.dev-card-grid b').map((b) => b.text())).toEqual(['—', '—', '—', '—'])
    // 「设备信息」仍指向所属那栋楼的台账档案
    expect(cards[0].find('.dev-link').exists()).toBe(true)
    w.unmount()
  })

  it('电梯详情：四格取最新一帧工况，状态也走 IOT 在线', async () => {
    signIn()
    mockLiftOnline.mockResolvedValue({ '3225122202': true, E03C1CB9F5011824: false })
    mockLiftAttr.mockResolvedValue({
      // 1# 楼主笼：15 层 / 40.1m / 3 人 / 480kg（单位与小数位照 V2
      // `UpdateRealtimeInfo`：楼层 `F`、高度 `F1`、载重 `kg`）
      '3225122202': {
        floor: 15,
        height: 40.1,
        people: 3,
        load: 480.5,
        state: 2,
        speed: 0.3,
        at: new Date(2026, 10, 13, 9, 59).getTime(),
      },
    })

    const w = await open('lift')
    await flushPromises()

    const first = w.findAll('.dev-card')[0]
    expect(first.findAll('.dev-card-grid b').map((b) => b.text())).toEqual([
      '15F',
      '40.1m',
      '3人',
      '480.5kg',
    ])
    // 工况帧时间要露出来：电梯静止时不发包，帧可能是几小时前的
    expect(first.find('.dev-note').text()).toContain('09:59')
    expect(first.find('.dev-status').text()).toBe('在线')
    w.unmount()
  })

  /**
   * 凭证失效（HTTP 401 + `status:11 权限不足`，自动重换也没救回来）时，
   * 卡片还在但每一格都是「—」。这时必须给一条能操作的提示，
   * 否则用户看到的就是满屏横杠 + 不知道为什么。
   *
   * 注意提示给的是「重试」而不是「重新登录」：电梯走 IOT 网关的项目级 ak/sk，
   * 与登录页那套 `:8081` 业务账号（`xiangyangcun`）是两套凭证，登录换不到它。
   */
  it('凭证失效：给「重试」提示条并真的重取，不是干摆一堆「—」', async () => {
    signIn()
    vi.mocked(liftAuthFailed).mockReturnValue(true)

    const w = await open('lift')
    await flushPromises()

    const bar = w.find('.dev-auth')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('电梯物联网网关凭证失效')
    expect(bar.find('.dev-auth-btn').text()).toBe('重试')

    const before = mockLiftOnline.mock.calls.length
    await bar.find('.dev-auth-btn').trigger('click')
    await flushPromises()
    expect(mockLiftOnline.mock.calls.length).toBeGreaterThan(before)

    const sub = useSubpageStore()
    expect(sub.view.kind).not.toBe('login')
    w.unmount()
  })

  it('凭证有效时不出现提示条', async () => {
    signIn()
    const w = await open('lift')
    await flushPromises()

    expect(w.find('.dev-auth').exists()).toBe(false)
    w.unmount()
  })

  it('作业报表：工作循环是真数据源 —— 三格合计 + 机队分台表 + 结论', async () => {
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000
    // 三条 sn 都回同样的两条循环：每台 2 次 / 3.75t / 峰值 2.5t / 5 分钟
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('getWorkCycleInfoHis')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: 200,
              success: true,
              data: [
                { startTime: '2026-11-12 09:00:00', endTime: '2026-11-12 09:03:00', weight: 2.5, duration: 180, type: '上料' },
                { startTime: '2026-11-12 09:10:00', endTime: '2026-11-12 09:12:00', weight: 1.25, duration: 120, type: '下料' },
              ],
            }),
          } as unknown as Response
        }
        return ledgerEnvelope()
      }),
    )
    useDeviceLedgerStore().apply(deviceRows())

    const w = await open('crane')
    await w.findAll('.dev-view-tabs button')[1].trigger('click')
    await flushPromises()

    // 三格合计：3 台车 × (2 次 / 3.75t / 300s) —— 传统塔机5 无编号，不进合计
    const kpis = w.findAll('.report-kpi')
    expect(kpis).toHaveLength(3)
    expect(kpis.map((k) => k.find('span').text())).toEqual(['合计吊次', '合计吊重', '作业时长'])
    expect(kpis.map((k) => k.find('b').text())).toEqual(['6次', '11.25t', '15分'])

    // 机队表：4 台都占一行（缺数的也要露脸），表头是设计稿的位置但换成可核验的量
    expect(w.findAll('.report-line.is-hd span').map((s) => s.text())).toEqual(['吊次', '吊重', '峰值', '时长'])
    const lines = w.findAll('.report-line:not(.is-hd)')
    expect(lines).toHaveLength(4)
    expect(lines[0].find('b').text()).toBe('智能塔机2')
    expect(lines[0].findAll('span').map((s) => s.text())).toEqual(['2次', '3.75t', '2.50t', '5分'])
    // 传统塔机5 没有平台编号：四格全「—」，并在结论里说明未纳入统计
    expect(lines[3].findAll('span').map((s) => s.text())).toEqual(['—', '—', '—', '—'])
    expect(w.find('.report-points').text()).toContain('传统塔机5 无平台编号，未纳入统计')
    expect(w.find('.report-share').exists()).toBe(true)
    w.unmount()
  })

  it('作业报表：一台车都取不到 → 空态，不出现任何合计数字', async () => {
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000
    // 工作循环接口全 500（现场是 CORS/网关/无编号），台账正常
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('getWorkCycleInfoHis')) {
          return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
        }
        return ledgerEnvelope()
      }),
    )
    useDeviceLedgerStore().apply(deviceRows())

    const w = await open('crane')
    await w.findAll('.dev-view-tabs button')[1].trigger('click')
    await flushPromises()

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

  it('设备信息：塔机分「基本信息 / 实时工况信息」两段（照 V2 塔机弹窗）', async () => {
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

    const blocks = w.findAll('.dev-info-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].find('.dev-info-hd').text()).toBe('基本信息')
    expect(blocks[1].find('.dev-info-hd').text()).toBe('实时工况信息')

    // 基本信息的七项与顺序照 V2 `UIPanelCrane`，一行不多
    const labels = blocks[0].findAll('.dev-info-row span').map((s) => s.text())
    expect(labels).toEqual(['当前状态', '塔机编号', '塔机高度', '安检有效期', '质检报告状态', '司机', '功效'])
    // 状态：测试环境连不上 broker（stateOf 返回 null）→ 回落台账的「在线」
    expect(blocks[0].text()).toContain('在线')
    expect(blocks[0].text()).toContain('机师')
    // 台账后台字段不进弹层
    expect(blocks[0].text()).not.toContain('是否隐藏')
    expect(blocks[0].text()).not.toContain('更新时间')
    // 功效绑的是台账真值（键名「功效」），不是空行
    expect(blocks[0].text()).toContain('55 吊次/台班')

    // 「塔机高度」只认实时 bodyHeight，没有帧就是「—」，不回落台账的 70
    const heightRow = blocks[0].findAll('.dev-info-row').find((r) => r.find('span').text() === '塔机高度')
    expect(heightRow?.find('b').text()).toBe('—')
    expect(blocks[0].text()).not.toContain('70m')

    // 实时工况：四行照 V2 DataContent2；测试环境连不上 broker，只能全是「—」
    const liveLabels = blocks[1].findAll('.dev-info-row span').map((s) => s.text())
    expect(liveLabels).toEqual(['实时回转', '实时幅度', '实时高度', '实时时间'])
    expect(blocks[1].findAll('.dev-info-row b.is-dash')).toHaveLength(4)
    // 编号不再是「—」：台号 4 → 向阳村4#塔机 → sn（V2 弹层同一个值）
    expect(blocks[0].text()).toContain('EW4')
    w.unmount()
  })

  it('设备信息：传统塔机5 没有编号与实时工况（与 V2 同口径，照常弹、缺的留「—」）', async () => {
    signIn()
    const sub = useSubpageStore()
    sub.openDevice('crane')
    const sheet = useBottomSheetStore()
    const w = mount(Host)
    await nextTick()

    sheet.openDeviceInfo('crane', '70')
    await nextTick()

    expect(w.find('.pop-sub').text()).toBe('传统塔机5')
    const blocks = w.findAll('.dev-info-block')
    // 段落不隐藏：与 V2 一样照常给出两段
    expect(blocks).toHaveLength(2)

    const rows = new Map(blocks[0].findAll('.dev-info-row').map((r) => [r.find('span').text(), r.find('b').text()]))
    // 状态取实时四态：没有 sn → 平台不推它 → 「离线」（V2 弹层同样是离线，
    // 那里能显示「在线」是因为它读台账；V2 的 GetTowerState("") 也是离线）
    expect(rows.get('当前状态')).toBe('离线')
    // 场景里这台车的 deviceSn 是空的 → 编号「—」
    expect(rows.get('塔机编号')).toBe('—')
    // 不在实时订阅列表 → 高度与四行实时值都是「—」，不拿台账的 10.3 顶替
    expect(rows.get('塔机高度')).toBe('—')
    expect(blocks[0].text()).not.toContain('10.3m')
    // 功效靠平台编号统计：这台车没有 sn → V2 弹层这一行也是 `--`
    // （台账里的「功效统计信息 60 吊次/台班」没有任何界面在用）
    expect(rows.get('功效')).toBe('—')
    expect(blocks[1].findAll('.dev-info-row b.is-dash')).toHaveLength(4)
    w.unmount()
  })

  it('设备信息：电梯按轿厢展示 V2 那八行（状态/编号 + 六项工况与今日）', async () => {
    signIn()
    mockLiftOnline.mockResolvedValue({ '3225122202': true, E03C1CB9F5011824: false })
    mockLiftAttr.mockResolvedValue({
      '3225122202': {
        floor: 8,
        height: 22.4,
        people: 6,
        load: 480.5,
        state: 2,
        speed: 0.3,
        at: new Date(2026, 10, 13, 9, 59).getTime(),
      },
    })
    mockLiftToday.mockResolvedValue({ '3225122202': { trips: 86, seconds: 23_040 } })

    const sub = useSubpageStore()
    sub.openDevice('lift')
    const sheet = useBottomSheetStore()
    const w = mount(Host)
    await nextTick()

    // 台账主键定位档案（'78' = 1#楼那行），sn 定位这一笼的读数
    sheet.openDeviceInfo('lift', '78', '3225122202')
    await flushPromises()

    // 副标题用轿厢名，不用台账那行「智能电梯1」
    expect(w.find('.pop-sub').text()).toBe('智能电梯1-1')

    const blocks = w.findAll('.dev-info-block')
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b) => b.find('.dev-info-hd').text())).toEqual(['基本信息', '实时工况信息'])

    const rows = new Map(
      w.findAll('.dev-info-row').map((r) => [r.find('span').text(), r.find('b').text()]),
    )
    expect([...rows.keys()]).toEqual([
      '当前状态',
      '升降机编号',
      '相对楼层',
      '高度',
      '载重',
      '人数',
      '今日累计运行时间',
      '今日升降次数',
    ])
    // runningState 2 → V2 的 switch 里是「上升」
    expect(rows.get('当前状态')).toBe('上升')
    expect(rows.get('升降机编号')).toBe('3225122202')
    expect(rows.get('相对楼层')).toBe('8F')
    expect(rows.get('高度')).toBe('22.4m')
    // 载重是 V2 硬编码的 kg（不是吨）
    expect(rows.get('载重')).toBe('480.5kg')
    expect(rows.get('人数')).toBe('6人')
    // 23040s = 6.4h，86 次 —— 与 V2 txtTodayRuntimeHours / txtTodayLiftCount 同格式。
    // 不挂任何口径小注（用户 2026-11-13 要求）：弹层是与 V2 并排对照看的，
    // V2 那格只有数字，多两个字反而显得两边不一样
    expect(rows.get('今日累计运行时间')).toBe('6.4h')
    expect(rows.get('今日升降次数')).toBe('86次')
    w.unmount()
  })

  it('设备信息：电梯网关连不上时八行全是「—」，状态按离线', async () => {
    signIn()
    const sub = useSubpageStore()
    sub.openDevice('lift')
    const sheet = useBottomSheetStore()
    const w = mount(Host)
    await nextTick()

    sheet.openDeviceInfo('lift', '78', '3225122202')
    await flushPromises()

    const rows = new Map(
      w.findAll('.dev-info-row').map((r) => [r.find('span').text(), r.find('b').text()]),
    )
    // 在线数据整批没取到 = 连不上 → **离线**。不回落台账：台账那行写的是
    // 「在线」，会与下面一整列「—」自相矛盾（用户 2026-11-13 要求默认离线）
    expect(rows.get('当前状态')).toBe('离线')
    expect(rows.get('升降机编号')).toBe('3225122202')
    for (const k of ['相对楼层', '高度', '载重', '人数', '今日累计运行时间', '今日升降次数']) {
      expect(rows.get(k)).toBe('—')
    }
    // 六个「—」都带 is-dash，与塔机弹层同一套灰字样式
    expect(w.findAll('.dev-info-row b.is-dash')).toHaveLength(6)
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

  it('已登录但传感器没取到：展示台账爬升高度，机位区给空态 + 重试', async () => {
    signIn()
    const sub = useSubpageStore()
    sub.openClimb()
    const w = mount(Host)
    await flushPromises()

    expect(w.find('.climb-sum').text()).toContain('1')
    expect(w.find('.climb-sum').text()).toContain('在线')
    expect(w.text()).toContain('爬升高度')
    expect(w.text()).toContain('21m')
    expect(w.findAll('.climb-line')).toHaveLength(0)
    expect(w.text()).toContain('暂无爬架机位读数')
    w.unmount()
  })

  it('已登录且拿到 CDN 读数：机位列表按机位号从小到大，超限行标红', async () => {
    signIn()
    useScaffoldStore().apply(SCAFFOLD_ROWS)
    const sub = useSubpageStore()
    sub.openClimb()
    const w = mount(Host)
    await flushPromises()

    const lines = w.findAll('.climb-line')
    expect(lines).toHaveLength(3)
    // 默认页签是左右倾斜。顺序按机位号（6 → 19 → 30），不是读数大小 ——
    // 现场的巡检/报修顺序就是机位号顺序
    expect(lines.map((l) => l.find('b').text())).toEqual(['6#机位', '19#机位', '30#机位'])
    expect(lines.map((l) => l.find('span').text())).toEqual(['1.2mm', '0.4mm', '179.5mm'])
    // 超限的 30# 排在最后，靠红字而不是靠排序被人找到
    expect(lines[2].classes()).toContain('is-bad')
    expect(lines[0].classes()).not.toContain('is-bad')
    // 表头是「正常台数 / 有读数的台数」：3 台里 2 台在阈值内 → 2/3，
    // 标签也从「超限机位」改成「正常机位」（主数字不再报坏消息）
    expect(w.find('.climb-board header b').text()).toBe('2/3')
    expect(w.find('.climb-board header').text()).toContain('正常机位')
    expect(w.find('.climb-issue').text()).toBe('30#机位 左右倾斜 179.5mm，超过 60mm')
    w.unmount()
  })
})

describe('无人机页', () => {
  /** stub 返回的执行记录；用例按需改写 */
  let stubRecords: DroneTaskRecord[] = []
  /** stub 返回的机载遥测（无人机 id 23498 / 类型 1） */
  let stubTelemetry: Record<string, unknown> = {}
  /** stub 返回的机库遥测（机库 id 23452 / 类型 2） */
  let stubDock: Record<string, unknown> = {}
  /** stub 返回的今日任务统计 */
  let stubStat: Record<string, unknown> = {}
  /** stub 返回的无人机直播流 */
  let stubStream: Record<string, unknown>[] = []
  /** stub 返回的机库直播流 */
  let stubDockStream: Record<string, unknown>[] = []

  beforeEach(() => {
    setActivePinia(createPinia())
    stubRecords = []
    stubTelemetry = {}
    stubDock = {}
    stubStat = { taskCount: 0, finishedCount: 0, failedCount: 0, runningCount: 0, planCount: 0, suspendedCount: 0 }
    stubStream = []
    stubDockStream = []
    // 无人机页挂载即 load()，不 stub 会真的去请求 keehang 平台。
    // 这里按真实响应形状返回，用例改写 stub* 即可。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ code: 200, data }) })
        if (u.includes('/cas/auth/login')) return ok({ tgt: 'T', st: 'ST' })
        if (u.includes('/cas/auth/validate')) return ok({ uid: '1', token: 'TK' })
        if (u.includes('/task/exec/list/record')) return ok(stubRecords)
        if (u.includes('/dashboard/task/list/record')) return ok(stubStat)
        // 两个设备类型分开：/1 是无人机、/2 是机库，混了会互相顶掉读数
        if (u.includes('/telemetry/23498/1')) return ok(stubTelemetry)
        if (u.includes('/telemetry/23452/2')) return ok(stubDock)
        if (u.includes('/live/stream/list')) return ok(u.includes('23452') ? stubDockStream : stubStream)
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
      uuid: 'u-147744',
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

  it('完全没有直播流时整块说明，不挂静态示意图', async () => {
    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()

    expect(w.find('.uav-stage').classes()).toContain('is-wait')
    // 示意图长得像现场画面，会被当成实时情况 —— 一律不挂
    expect(w.find('.uav-stage img').exists()).toBe(false)
    expect(w.find('.live-player').exists()).toBe(false)
    expect(w.find('.uav-stage').text()).toContain('实时画面未开播')
    expect(w.find('.uav-stage').text()).toContain('平台没有这台无人机的直播流')
    w.unmount()
  })

  it('有地址就先连：不等 online，LIVE 角标只认真的出画面', async () => {
    stubRecords = [todayRecord()]
    stubStream = [
      {
        deviceId: 23498,
        streams: [
          {
            id: 934,
            name: '中建三局-向阳村项目无人机2',
            // 快照说没在推流 —— 但地址在，照样先连（起飞瞬间的空窗就是这么填的）
            online: false,
            playStreams: [
              { type: 'flv', protocol: 'https', url: 'https://live.example.com/djiDock/uav.live.flv' },
              { type: 'rtsp', protocol: 'rtsp', url: 'rtsp://live.example.com/djiDock/uav' },
            ],
          },
        ],
      },
    ]

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    expect(w.find('.uav-stage').classes()).not.toContain('is-wait')
    expect(w.find('.live-player').exists()).toBe(true)
    // 还在连：转圈 + 说明，没有 LIVE（没画面就挂 LIVE 是撒谎）
    expect(w.find('.live-player').classes()).toContain('is-loading')
    expect(w.find('.uav-stage').text()).toContain('正在连接实时画面')
    expect(w.find('.uav-live').exists()).toBe(false)

    // 真的出画面（video 开始解码）才挂 LIVE
    w.find('.live-video').element.dispatchEvent(new Event('playing'))
    await nextTick()
    expect(w.find('.uav-live').text()).toContain('LIVE')
    w.unmount()
  })

  it('连不上时说「画面未开播」并给重试，不说「画面中断」', async () => {
    stubRecords = [todayRecord()]
    stubStream = [
      {
        deviceId: 23498,
        streams: [
          {
            id: 934,
            name: '无人机',
            online: false,
            playStreams: [{ type: 'flv', protocol: 'https', url: 'https://live.example.com/uav.live.flv' }],
          },
        ],
      },
    ]

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    // 一次都没出过画面就断了 → 是「没在推流」，不是「播着播着断了」
    const handlers = (globalThis as unknown as { __mpegts: Record<string, () => void> }).__mpegts
    handlers.error()
    await nextTick()

    expect(w.find('.live-player').classes()).toContain('is-offair')
    expect(w.find('.uav-stage').text()).toContain('画面未开播')
    expect(w.find('.uav-stage').text()).toContain('起飞推流后会自动出画面')
    expect(w.find('.uav-stage').text()).not.toContain('画面中断')
    expect(w.find('.live-play').text()).toContain('重试')
    w.unmount()
  })

  it('机库页签换机库那一路流；待机没推流也先连，不拿无人机画面顶替', async () => {
    stubRecords = [todayRecord()]
    stubStream = [
      {
        deviceId: 23498,
        streams: [
          {
            id: 934,
            name: '无人机',
            online: true,
            playStreams: [{ type: 'flv', protocol: 'https', url: 'https://live.example.com/uav.live.flv' }],
          },
        ],
      },
    ]
    // 机库：地址在，但 `online:false`（在库待机时不推流）
    stubDockStream = [
      {
        deviceId: 23452,
        streams: [
          {
            id: 874,
            name: '机库1',
            online: false,
            playStreams: [{ type: 'flv', protocol: 'https', url: 'https://live.example.com/dock.live.flv' }],
          },
        ],
      },
    ]

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()
    expect(w.findComponent(LivePlayer).props('src')).toBe('https://live.example.com/uav.live.flv')

    await w.findAll('.dev-tabs button')[1].trigger('click')
    // 新组件要等一次动态 import 才建好播放器、挂上事件回调
    await flushPromises()
    await nextTick()
    // 换的是地址，不是整块撤掉
    expect(w.findComponent(LivePlayer).props('src')).toBe('https://live.example.com/dock.live.flv')
    expect(w.find('.live-player').exists()).toBe(true)

    // 机库没推流 → 说机库的原因，不冒充无人机画面
    const handlers = (globalThis as unknown as { __mpegts: Record<string, () => void> }).__mpegts
    handlers.error()
    await nextTick()
    expect(w.find('.live-player').classes()).toContain('is-offair')
    expect(w.find('.uav-stage').text()).toContain('机库摄像头在库待机时不推流')
    w.unmount()
  })

  it('网络质量跟着速率走：9kbps 只亮一格红', async () => {
    stubRecords = [todayRecord()]
    stubDock = { networkRate: 9 }

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    const on = w.findAll('.dev-block')[2].findAll('.uav-sig i').filter((b) => b.classes().includes('is-on'))
    expect(on).toHaveLength(1)
    expect(w.find('.uav-sig').classes()).toContain('is-weak')
    w.unmount()
  })

  it('网络质量跟着速率走：900kbps 亮满五格转绿', async () => {
    stubRecords = [todayRecord()]
    stubDock = { networkRate: 900 }

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    const on = w.findAll('.dev-block')[2].findAll('.uav-sig i').filter((b) => b.classes().includes('is-on'))
    expect(on).toHaveLength(5)
    expect(w.find('.uav-sig').classes()).toContain('is-ok')
    w.unmount()
  })

  it('任务三格取统计接口，不数本地条数', async () => {
    // 本地今天只有 1 条记录，但统计接口说 15 / 11 / 2 —— 页面认接口的数
    stubRecords = [todayRecord()]
    stubStat = { taskCount: 15, finishedCount: 11, failedCount: 2, runningCount: 0, planCount: 4, suspendedCount: 0 }

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    const stats = w.findAll('.dev-block')[1].findAll('.uav-stats > div')
    expect(stats).toHaveLength(3)
    expect(stats[0].text()).toContain('15') // 今日任务
    expect(stats[1].text()).toContain('11') // 已完成
    expect(stats[2].text()).toContain('2') // 失败次数
    w.unmount()
  })

  it('没有任务时给空态，不回落演示任务', async () => {
    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    expect(w.text()).toContain('今日暂无无人机任务')
    w.unmount()
  })

  it('两个页签切的是两套读数：机载飞行参数 ↔ 机库状态', async () => {
    // 2026-11-13 实测形态：海拔 12.4m、相对高度 0（在地面）、距起飞点 0.05m
    stubTelemetry = {
      relativeAltitude: 0,
      height: 12.4,
      homeDistance: 126,
      horizontalSpeed: 4.2,
      verticalSpeed: 0.3,
      windSpeed: 2.4,
    }
    stubDock = {
      droneOnlineStatus: 1,
      droneChargeState: 0,
      cabinTemperature: 18.1,
      humidity: 99,
      networkRate: 441,
    }

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    // 无人机页签：设计稿五格
    let fly = w.find('.uav-fly')
    expect(fly.text()).toContain('海拔')
    expect(fly.text()).toContain('12.4m')
    expect(fly.text()).toContain('126m')
    expect(fly.text()).toContain('4.2m/s')
    expect(fly.text()).toContain('0.3m/s')

    // 机库页签：切过去要看到机库自己的读数，而不是同一套飞行参数
    await w.findAll('.dev-tabs button')[1].trigger('click')
    fly = w.find('.uav-fly')
    expect(fly.text()).toContain('在库')
    expect(fly.text()).toContain('未充电')
    expect(fly.text()).toContain('18.1℃')
    expect(fly.text()).toContain('99%')
    expect(fly.text()).toContain('441kbps')
    expect(fly.text()).not.toContain('海拔')

    w.unmount()
  })

  it('状态格取厂家状态码：库里断电显示「关机」（与 V2 一致），不是「停泊」', async () => {
    stubRecords = [todayRecord()]
    // 2026-11-13 实测：飞机在库、飞控断电
    stubTelemetry = { status: -1, modeCode: 14, batteryInfo: { capacityPercent: 88 } }

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    const cell = w.findAll('.dev-block')[2].findAll('.uav-stats > div')[0]
    expect(cell.text()).toContain('关机')
    expect(cell.text()).not.toContain('停泊')
    // 关机要压红，跟「待机」区分开
    expect(cell.find('b').classes()).toContain('is-down')
    w.unmount()
  })

  it('设备参数八格全有源：电量 / 距机库 / 续航 / 风速 / 网络 / 温度', async () => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    stubRecords = [
      todayRecord({ start: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T15:00:00` }),
    ]
    stubTelemetry = {
      relativeAltitude: 86.2,
      height: 98.3,
      homeDistance: 126,
      batteryInfo: { batteries: [{ capacityPercent: 88, temperature: 26.4 }], remainFlightTime: 1520 },
      horizontalSpeed: 4.2,
      verticalSpeed: 0.3,
      windSpeed: 2.4,
    }
    stubDock = { networkRate: 441, networkQuality: 1, cabinTemperature: 18.1 }

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    const stats = w.findAll('.dev-block')[2].findAll('.uav-stats > div')
    expect(stats).toHaveLength(8)
    expect(stats[1].text()).toContain('88%') // 电量
    expect(stats[2].text()).toContain('126m') // 距机库
    expect(stats[3].text()).toContain('25分') // 续航（1520s）
    expect(stats[4].text()).toContain('2.4m/s') // 风速
    // 网络质量画五格递增信号，亮几格由**速率**分档（441kbps → 三格），
    // 不读恒为 1 的 `networkQuality`，也不写「偏低」两字
    const sig = stats[5].findAll('.uav-sig i')
    expect(sig).toHaveLength(5)
    expect(sig.filter((b) => b.classes().includes('is-on'))).toHaveLength(3)
    expect(stats[5].find('.uav-sig').classes()).toContain('is-mid')
    expect(stats[5].text()).not.toContain('偏低')
    expect(stats[6].text()).toContain('441kbps') // 网络速率
    expect(stats[7].text()).toContain('26.4℃') // 电池温度
    w.unmount()
  })

  it('取不到的字段显示「—」而不是 0', async () => {
    stubRecords = [todayRecord()]
    stubTelemetry = { status: 1, batteryInfo: null, horizontalSpeed: null }
    stubDock = {}

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    const stats = w.findAll('.dev-block')[2].findAll('.uav-stats > div')
    // 电量 / 距机库 / 续航 / 风速 / 网络质量 / 网络速率 / 电池温度 都没有 → 全「—」
    for (const i of [1, 2, 3, 4, 5, 6, 7]) expect(stats[i].text()).toContain('—')
    // 网络质量没数时不画五格空条（那会读成「有信号但一格都没有」）
    expect(w.find('.uav-sig').exists()).toBe(false)
    w.unmount()
  })

  /*
   * 任务下发从「条件校验 + 选择航线」改成二期占位（用户 2026-11-13 定）。
   * 守两点：①「任务下发」这一块还在（四块版式不变）；② 不留假按钮 ——
   * disabled 的「选择航线」看起来像点得动、点了没反应，会被当成 bug。
   * 起飞条件那套判定（canDispatch / dispatchNote / risks）仍在 store 里，
   * 由 drone.spec 覆盖，二期直接拿来接下发。
   */
  it('任务下发改成二期占位：接入中，敬请期待', async () => {
    stubRecords = [todayRecord()]

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()
    await nextTick()

    const blk = w.findAll('.dev-block')[3]
    expect(blk.find('h4').text()).toBe('任务下发')
    expect(blk.text()).toContain('接入中，敬请期待')
    // 旧的三件套全部撤掉：状态胶囊 / 放行说明 / 航线按钮
    expect(w.find('.uav-gate').exists()).toBe(false)
    expect(w.find('.uav-allow').exists()).toBe(false)
    expect(w.find('.uav-send').exists()).toBe(false)
    w.unmount()
  })

  it('遥测缺失时，电量也按未知处理', async () => {
    stubRecords = [todayRecord()]

    const sub = useSubpageStore()
    sub.openUav()
    const w = mount(Host)
    await flushPromises()

    const uav = useUavStore()
    const battery = uav.checks.find((c) => c.name === '电量')
    expect(battery?.unknown).toBe(true)
    expect(battery?.ok).toBe(false)
    // 必须卸载：页面开着 30s 实时刷新定时器，不 unmount 会让 vitest 进程挂着不退
    w.unmount()
  })
})
