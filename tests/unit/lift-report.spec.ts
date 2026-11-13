import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchLiftWorkRange, liftAuthFailed, liftGatewayStale } from '@/api/lift'
import { clearToken } from '@/api/iot'
import { LIFT_CAGES } from '@/data/liftSn'
import { useLiftReportStore } from '@/stores/liftReport'
import { useLiftStore } from '@/stores/lift'
import LiftReport from '@/views/sub/LiftReport.vue'
import { sumWork } from '@/utils/lift'
import { formatDays, formatSpan, liftTotals, share, spanText, summarizeRange } from '@/utils/liftReport'
import type { IotEventRow } from '@/api/iot'

/**
 * 电梯作业报表
 *
 * 这一组钉住四件事：
 *   ① 在运时段是**按日切片再累加**，不是区间首尾相减 —— 否则月报会算成
 *      720 小时（那是日历，不是运行时段）；
 *   ② 日报这一格必须与弹层「今日累计运行时间」逐字节相同（同为 V2 口径）；
 *   ③ 「网关不认这个编号」与「区间内没跑」是两句话，页面不能混；
 *   ④ 切粒度时旧的数字必须清掉，不能把日报的 3 次读成月报的数。
 */

vi.mock('@/api/iot', () => ({ clearToken: vi.fn() }))

vi.mock('@/api/lift', () => ({
  LIFT_PRODUCT: '01724121a94f4893b693f253173d1082',
  fetchLiftWorkRange: vi.fn(),
  // 报表页只顺带补一次在线状态（结论里的「当前离线」），这里让它拿不到即可
  fetchLiftOnline: vi.fn(async () => null),
  fetchLiftToday: vi.fn(async () => null),
  fetchLiftAttr: vi.fn(async () => null),
  liftAuthFailed: vi.fn(() => false),
  liftGatewayStale: vi.fn(() => false),
  // 报表页也要读这条（换令牌没打通 / 缺反代），默认「连得上」
  liftGatewayUnreachable: vi.fn(() => false),
  clearLiftAuthFailure: vi.fn(),
}))

const mockRange = vi.mocked(fetchLiftWorkRange)

/** 一条工作循环事件（时间用服务端原格式，带空格不带时区） */
function row(sn: string, start: string, end: string): IotEventRow {
  return {
    timestamp: 0,
    metricIndex: `01724121a94f4893b693f253173d1082~${sn}~EVENT_WORKDATA`,
    resultMap: { runStartTime: start, runEndTime: end },
  }
}

/** 网关认的编号（1# 楼主笼）；另外三个在报表里分别是「认但没跑」与「不认」 */
const SN1 = LIFT_CAGES[0].sn

describe('summarizeRange', () => {
  it('单日与 sumWork 同口径：首尾相减', () => {
    const rows = [
      row(SN1, '2026-11-13 06:23:53', '2026-11-13 06:25:52'),
      row(SN1, '2026-11-13 06:30:29', '2026-11-13 06:32:22'),
    ]
    const stats = summarizeRange(rows)
    // 06:23:53 → 06:32:22 = 509s（不是 119+113）
    expect(stats.spanSec).toBe(509)
    expect(stats.spanSec).toBe(sumWork(rows).seconds)
    expect(stats.trips).toBe(2)
    expect(stats.days).toBe(1)
  })

  it('跨两天：各日首尾相加，不是整段首尾', () => {
    const rows = [
      row(SN1, '2026-11-12 08:00:00', '2026-11-12 08:10:00'), // 600s
      row(SN1, '2026-11-13 09:00:00', '2026-11-13 09:05:00'), // 300s
    ]
    const stats = summarizeRange(rows)
    // 整段首尾会是 25h；按日切片是 900s
    expect(stats.spanSec).toBe(900)
    expect(stats.days).toBe(2)
  })

  it('最长单次取单条最大，不是合计', () => {
    const rows = [
      row(SN1, '2026-11-13 08:00:00', '2026-11-13 08:01:00'),
      row(SN1, '2026-11-13 09:00:00', '2026-11-13 09:04:30'),
    ]
    expect(summarizeRange(rows).maxRunSec).toBe(270)
  })

  it('时间缺失 / end <= start 的脏行：不减次数，不计时长，也不进天数', () => {
    const rows: IotEventRow[] = [
      { timestamp: 0, metricIndex: 'p~SN~EVENT_WORKDATA', resultMap: { runStartTime: '2026-11-13 08:00:00' } },
      row(SN1, '2026-11-13 09:00:00', '2026-11-13 08:00:00'),
      row(SN1, '2026-11-14 10:00:00', '2026-11-14 10:02:00'),
      { timestamp: 0, metricIndex: 'p~SN~EVENT_WORKDATA', resultMap: null },
    ]
    const stats = summarizeRange(rows)
    expect(stats.trips).toBe(4)
    expect(stats.maxRunSec).toBe(120)
    expect(stats.days).toBe(2)
    // 13 号只有一条没结束时间 → 该日切片时长 0；14 号单条 120s
    expect(stats.spanSec).toBe(120)
  })

  it('空数组：次数 0、时长 0、最长 null', () => {
    expect(summarizeRange([])).toEqual({ trips: 0, spanSec: 0, maxRunSec: null, days: 0 })
  })
})

describe('liftTotals', () => {
  it('null（没取到数）不进合计；覆盖台数只数真的跑过的', () => {
    const t = liftTotals([
      { trips: 3, spanSec: 600, maxRunSec: 120, days: 1 },
      { trips: 0, spanSec: 0, maxRunSec: null, days: 0 },
      null,
      null,
    ])
    expect(t.trips).toBe(3)
    expect(t.spanSec).toBe(600)
    // 0 次算「取了数但没跑」，不算覆盖
    expect(t.covered).toBe(1)
  })

  it('全空 → 全 0', () => {
    expect(liftTotals([null, null])).toEqual({ trips: 0, spanSec: 0, covered: 0 })
  })
})

describe('格式化', () => {
  it('在运时段：不足 1 小时按分，超过按一位小数小时', () => {
    expect(formatSpan(600)).toEqual({ n: '10', u: '分' })
    expect(formatSpan(7200)).toEqual({ n: '2.0', u: 'h' })
    expect(formatSpan(0)).toEqual({ n: '0', u: '分' })
    expect(formatSpan(null)).toEqual({ n: '—', u: '' })
  })

  it('spanText / formatDays / share', () => {
    expect(spanText(600)).toBe('10分')
    expect(spanText(null)).toBe('—')
    expect(formatDays(3)).toBe('3天')
    // 0 天不写「0天」——那是「这台没跑过」，页面用「—」与「0次」组合表达
    expect(formatDays(0)).toBe('—')
    expect(share(1, 4)).toBe(25)
    expect(share(1, 0)).toBe(0)
  })
})

describe('stores/liftReport', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockRange.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('按登记表出 4 行：网关不认的编号 stats 为 null，空数组算「没跑」', async () => {
    mockRange.mockResolvedValue({
      [SN1]: [row(SN1, '2026-11-13 06:23:53', '2026-11-13 06:32:22')],
      // 网关认这个编号但区间内没有事件 → 0 次，是有效结论
      [LIFT_CAGES[3].sn]: [],
    })

    const store = useLiftReportStore()
    await store.load('day')

    expect(store.state).toBe('ready')
    expect(store.rows).toHaveLength(4)
    expect(store.rows[0].stats?.trips).toBe(1)
    expect(store.rows[3].stats?.trips).toBe(0)
    // 键没回来 = 网关不认这个编号 → null（页面据此说「未纳入统计」）
    expect(store.rows[1].stats).toBeNull()
    expect(store.rows[2].stats).toBeNull()
  })

  it('区间请求覆盖当日 23:59:59（末日不减一天）', async () => {
    mockRange.mockResolvedValue({})
    const store = useLiftReportStore()
    await store.load('day')

    const [from, to] = mockRange.mock.calls[0]
    expect(from).toBe(new Date(new Date().toDateString()).getTime())
    expect(to - from).toBe(86_400_000 - 1)
  })

  it('45 秒内同区间复用缓存，不重复打接口', async () => {
    mockRange.mockResolvedValue({ [SN1]: [] })
    const store = useLiftReportStore()
    await store.load('day')
    await store.load('day')
    expect(mockRange).toHaveBeenCalledTimes(1)
  })

  it('一台都没应答 → empty（页面出空态，而不是 4 行「—」）', async () => {
    mockRange.mockResolvedValue(null)
    const store = useLiftReportStore()
    await store.load('day')
    expect(store.state).toBe('empty')
    expect(store.rows.every((r) => r.stats === null)).toBe(true)
  })

  it('连点粒度只认最后一次：先发的慢响应回来不覆盖', async () => {
    let release: (v: Record<string, IotEventRow[]>) => void = () => {}
    const slow = new Promise<Record<string, IotEventRow[]>>((r) => {
      release = r
    })
    mockRange.mockImplementationOnce(() => slow) // 日报：挂住
    mockRange.mockResolvedValueOnce({ [SN1]: [row(SN1, '2026-11-01 08:00:00', '2026-11-01 09:00:00')] }) // 月报

    const store = useLiftReportStore()
    void store.load('day')
    await store.load('month')
    release({ [SN1]: [] })
    await flushPromises()

    // 日报的响应迟到了，不能把月报的结果盖掉
    expect(store.span).toBe('month')
    expect(store.rows[0].stats?.trips).toBe(1)
  })
})

describe('电梯报表页', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockRange.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('出三格合计 + 四行分台表 + 未纳入统计的结论', async () => {
    mockRange.mockResolvedValue({
      [SN1]: [
        row(SN1, '2026-11-13 06:23:53', '2026-11-13 06:25:52'),
        row(SN1, '2026-11-13 06:30:29', '2026-11-13 06:32:22'),
      ],
      [LIFT_CAGES[2].sn]: [row(LIFT_CAGES[2].sn, '2026-11-13 07:00:00', '2026-11-13 07:10:00')],
    })

    const w = mount(LiftReport)
    await flushPromises()

    const kpis = w.findAll('.report-kpi')
    expect(kpis).toHaveLength(3)
    expect(kpis[0].text()).toContain('合计循环')
    expect(kpis[0].text()).toContain('3')
    expect(kpis[1].text()).toContain('在运时段')
    // 1# 509s + 2-1 600s = 1109s → 18分
    expect(kpis[1].text()).toContain('18')
    expect(kpis[2].text()).toContain('覆盖台数')
    expect(kpis[2].text()).toContain('2/4台')

    // 表头 + 四行（每台都占一行，缺数的写「—」）
    const lines = w.findAll('.report-line')
    expect(lines).toHaveLength(5)
    expect(lines[0].text()).toContain('在用天数')
    expect(lines[1].text()).toContain('智能电梯1-1')
    expect(lines[1].text()).toContain('2次')

    // 结论里必须点名未纳入统计的两台，否则「合计 3 次」会被当成全场
    expect(w.find('.report-points').text()).toContain('未纳入统计')
    expect(w.find('.report-points').text()).toContain('智能电梯1-2')

    // 主体分台表里没有「—」以外的编造值
    expect(w.findAll('.report-line')[2].text()).toContain('—')

    w.unmount()
  })

  it('结论四段照设计稿：关注（使用最弱）/ 主力 / 短板 / 当前', async () => {
    // 4 个编号都回了数（模拟网关侧补齐登记之后；这里只验文案与顺序）。
    // 1-1：2天2次 · 1-2：1天1次 · 2-1：1天4次 · 2-2：0次
    mockRange.mockResolvedValue({
      [LIFT_CAGES[0].sn]: [
        row(LIFT_CAGES[0].sn, '2026-11-12 08:00:00', '2026-11-12 08:30:00'),
        row(LIFT_CAGES[0].sn, '2026-11-13 09:00:00', '2026-11-13 09:10:00'),
      ],
      [LIFT_CAGES[1].sn]: [row(LIFT_CAGES[1].sn, '2026-11-13 10:00:00', '2026-11-13 10:05:00')],
      [LIFT_CAGES[2].sn]: [
        row(LIFT_CAGES[2].sn, '2026-11-13 07:00:00', '2026-11-13 07:01:00'),
        row(LIFT_CAGES[2].sn, '2026-11-13 07:10:00', '2026-11-13 07:11:00'),
        row(LIFT_CAGES[2].sn, '2026-11-13 07:20:00', '2026-11-13 07:21:00'),
        row(LIFT_CAGES[2].sn, '2026-11-13 07:30:00', '2026-11-13 07:31:00'),
      ],
      [LIFT_CAGES[3].sn]: [],
    })

    // 在线状态直接灌：2-2 离线，「当前」那段才有话可说
    useLiftStore().apply({
      online: {
        [LIFT_CAGES[0].sn]: true,
        [LIFT_CAGES[1].sn]: true,
        [LIFT_CAGES[2].sn]: true,
        [LIFT_CAGES[3].sn]: false,
      },
    })

    const w = mount(LiftReport)
    await flushPromises()

    // 顺序照设计稿，且最多四段 —— 峰值并进「主力」，不单独占段
    expect(w.findAll('.report-points li b').map((b) => b.text())).toEqual(['关注', '主力', '短板', '当前'])

    const text = w.find('.report-points').text()
    // 关注：天数最少的台（1-1 跑了 2 天，1-2 与 2-1 都只 1 天 → 再看次数）
    expect(text).toContain('智能电梯1-2 仅 1天有运行')
    // 主力：次数最多 + 占比，单次最长并在这句里
    expect(text).toContain('智能电梯2-1 循环 4次，占 57%，单次最长 1分')
    // 短板：次数最少的那台
    expect(text).toContain('智能电梯1-2 循环 1次，只占 14%')
    // 当前：只有在线状态确实拿到时才说「离线」
    expect(text).toContain('智能电梯2-2 离线')

    w.unmount()
  })

  it('全部 0 条：不说「短板」，说明这段真的没跑', async () => {
    mockRange.mockResolvedValue(Object.fromEntries(LIFT_CAGES.map((c) => [c.sn, []])))

    const w = mount(LiftReport)
    await flushPromises()

    const tags = w.findAll('.report-points li b').map((b) => b.text())
    expect(tags).toEqual(['关注'])
    expect(w.find('.report-points').text()).toContain('均无升降记录')

    w.unmount()
  })

  it('一台都没取到 → 明确空态，且保留粒度切换（日报空、周报有是常见形态）', async () => {
    mockRange.mockResolvedValueOnce(null)
    const w = mount(LiftReport)
    await flushPromises()

    const empty = w.find('[data-empty="lift-report"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('暂无作业报表数据')
    expect(w.findAll('.report-kpi')).toHaveLength(0)
    // 空态下 pill 仍在：电梯的空手很可能是「这个区间恰好没跑」
    expect(w.findAll('.report-span button')).toHaveLength(3)

    // 换粒度拿到数据 → 空态消失、正常出报表
    mockRange.mockResolvedValueOnce({ [SN1]: [row(SN1, '2026-11-13 06:00:00', '2026-11-13 06:10:00')] })
    await w.findAll('.report-span button')[1].trigger('click')
    await flushPromises()

    expect(w.find('[data-empty="lift-report"]').exists()).toBe(false)
    expect(w.findAll('.report-kpi')).toHaveLength(3)
    expect(useLiftReportStore().span).toBe('week')

    w.unmount()
  })

  it('切到周报会按新粒度重查', async () => {
    mockRange.mockResolvedValue({ [SN1]: [] })
    const w = mount(LiftReport)
    await flushPromises()
    expect(mockRange).toHaveBeenCalledTimes(1)

    const week = w.findAll('.report-span button')[1]
    await week.trigger('click')
    await flushPromises()

    expect(mockRange).toHaveBeenCalledTimes(2)
    expect(useLiftReportStore().span).toBe('week')
    // 区间文案换成 7 天（含「至」）
    expect(w.find('.report-date').text()).toContain('至')

    w.unmount()
  })
})

/**
 * 空态的两种原因不能混为一谈。
 *
 * 凭证失效时「换个粒度看看」是**假建议** —— 周报月报走同一个网关、同一张令牌，
 * 换了照样空，用户白点三档再回来。所以这一组钉住：凭证失效给「重试」，
 * 只有「网关应答但区间内 0 条」才提示换区间。
 */
describe('LiftReport · 凭证失效的空态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockRange.mockReset()
    vi.mocked(liftAuthFailed).mockReturnValue(false)
    vi.mocked(liftGatewayStale).mockReturnValue(false)
  })

  afterEach(() => {
    // mockReturnValue 不会被 clearAllMocks 清掉，必须手动复原，否则串到下一条
    vi.mocked(liftAuthFailed).mockReturnValue(false)
    vi.mocked(liftGatewayStale).mockReturnValue(false)
    vi.clearAllMocks()
  })

  it('凭证失效 → 说网关凭证问题 + 给重试，不劝人换粒度', async () => {
    vi.mocked(liftAuthFailed).mockReturnValue(true)
    mockRange.mockResolvedValueOnce(null)

    const w = mount(LiftReport)
    await flushPromises()

    const empty = w.find('[data-empty="lift-report"]')
    expect(empty.text()).toContain('电梯物联网网关凭证失效，请稍后重试')
    // 「换个粒度看看」会把人带错方向：三档走的是同一个网关
    expect(empty.text()).not.toContain('换个粒度')
    expect(empty.find('.data-empty-btn').text()).toBe('重试')

    w.unmount()
  })

  it('重试过还是同一张令牌 → 文案换成「未恢复」，且仍可重试', async () => {
    vi.mocked(liftAuthFailed).mockReturnValue(true)
    vi.mocked(liftGatewayStale).mockReturnValue(true)
    mockRange.mockResolvedValueOnce(null)

    const w = mount(LiftReport)
    await flushPromises()

    const empty = w.find('[data-empty="lift-report"]')
    expect(empty.text()).toContain('电梯物联网网关未恢复，请稍后再试')
    expect(empty.find('.data-empty-btn').exists()).toBe(true)

    w.unmount()
  })

  it('点重试：先丢 IOT 缓存令牌，再按当前粒度重查', async () => {
    vi.mocked(liftAuthFailed).mockReturnValue(true)
    mockRange.mockResolvedValueOnce(null)
    const w = mount(LiftReport)
    await flushPromises()

    // 网关把令牌轮换好了 → 第二次拿到数
    mockRange.mockResolvedValueOnce({ [SN1]: [row(SN1, '2026-11-13 06:00:00', '2026-11-13 06:10:00')] })
    await w.find('.data-empty-btn').trigger('click')
    await flushPromises()

    // 不清令牌的话，`ensureToken` 会把那张刚被判 401 的令牌原样再交一次
    expect(vi.mocked(clearToken)).toHaveBeenCalled()
    expect(mockRange).toHaveBeenCalledTimes(2)
    expect(w.find('[data-empty="lift-report"]').exists()).toBe(false)
    expect(w.findAll('.report-kpi')).toHaveLength(3)

    w.unmount()
  })

  it('网关应答但区间内 0 条 → 仍然是「换个粒度看看」那套文案', async () => {
    // 键在、值是空数组：网关认这个编号，只是这段时间没跑
    mockRange.mockResolvedValue({ [SN1]: [] })

    const w = mount(LiftReport)
    await flushPromises()

    // 有 stats（0 次）就算有数，走的是正常报表，不是空态
    expect(w.find('[data-empty="lift-report"]').exists()).toBe(false)
    expect(useLiftReportStore().state).toBe('ready')

    w.unmount()
  })
})
