import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import type { DroneWorkOrder } from '@/api/drone'
import NavBar from '@/components/shell/NavBar.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useMsgStore } from '@/stores/msg'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { dateKey } from '@/utils/date'
import MsgPage from '@/views/MsgPage.vue'
import InspectList from '@/views/sub/InspectList.vue'
import { camAlarmFixtures } from '../fixtures/camAlarms'

/**
 * 消息页：两类预警分类卡（2026-11-20）
 *
 * 这一页从「一条报警一条消息 + 20 条/页分页」改成了**两块分类汇总**：
 *   · 监控预警 —— `:8085` 视频报警（原数据源，一个字没改）；
 *   · 无人机预警 —— keehang 审核中心的 AI 工单（= V2 大屏「工单列表」）。
 *
 * 这一组钉住四件事，它们合起来才是「两类分得清、又不互相污染」：
 *   ① 只有两张卡，顺序固定（监控在前），不再按条罗列；
 *   ② 两张卡统一报「今日待处理」（2026-11-24 现场口径）：监控 = 今日
 *      `handleStatus !== 1` 的条数，无人机 = 今日 `UNAUDITED` 的条数，
 *      tabbar 角标 = 两者之和；状态只读，App 内不提供任何变更操作；
 *   ③ 条数取不到时写「—」，不写 0；
 *   ④ 点哪张卡进哪条链路：监控 → 今日巡检预警列表，无人机 → 无人机预警列表。
 */

function signIn(): void {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.expiresAt = Date.now() + 3_600_000
}

/** `:8085` 的空信封（报警同步用 text() 解析，不是 json()） */
function emptyAlarms(): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { list: [], total: 0 } }) }
}

/** 造一条 AI 工单（字段照 `api/drone.ts::toWorkOrder` 的输出） */
function wo(n: number, patch: Partial<DroneWorkOrder> = {}): DroneWorkOrder {
  // 按秒往回推：n 越大越旧，`relTime` 稳定给出「刚刚」
  const d = new Date(Date.now() - n * 1_000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return {
    id: `wo-${n}`,
    at: `${dateKey(d)} ${hh}:${mm}:${ss}`,
    title: '道路垃圾',
    label: '道路垃圾',
    jobName: '向阳村-道路垃圾和杂草生长',
    projectName: '向阳村数字工地',
    status: 'UNAUDITED',
    auditType: 'MANUAL_AUDIT',
    level: 'NOTIFICATION_LEVEN_2',
    lng: '114.2651',
    lat: '30.5312',
    alt: '35',
    image: '',
    recordId: String(n),
    ...patch,
  }
}

/** 昨天同一时刻的时间戳（'YYYY-MM-DD HH:mm:ss'）—— 历史条目不参与任何计数 */
function yesterdayStamp(): string {
  const d = new Date(Date.now() - 86_400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dateKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 挂载前把两边都摆成「已有一批」，避免 onMounted 又去打首屏 */
function seedAll(monitor = 3, droneCount = 2): void {
  const alarm = useAlarmStore()
  alarm.liveAlarms = camAlarmFixtures().slice(0, monitor)
  alarm.liveState = 'ok'
  const drone = useDroneAlarmStore()
  drone.apply(Array.from({ length: droneCount }, (_, i) => wo(i + 1)))
}

describe('消息页 · 两类预警分类卡', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn(async () => emptyAlarms()))
    // 这些用例只看「渲染口径」，不看同步过程：拦掉 onMounted 的首屏同步，
    // 免得它在断言之间把 liveState 改掉。同步本身由 alarm / droneAlarm 的
    // 自己的 spec 覆盖。
    vi.spyOn(useAlarmStore(), 'syncFromVideo').mockResolvedValue(true)
    vi.spyOn(useDroneAlarmStore(), 'load').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('只有两张卡：监控在前、无人机在后（不再一条报警一条消息）', async () => {
    seedAll(3, 2)
    signIn()
    const w = mount(MsgPage)
    await nextTick()

    const cards = w.findAll('.msg-item')
    expect(cards).toHaveLength(2)
    expect(cards.map((c) => c.attributes('data-kind'))).toEqual(['monitor', 'drone'])
    expect(cards[0].find('h4').text()).toBe('监控预警')
    expect(cards[1].find('h4').text()).toBe('无人机预警')
    // 副标题说清数据来源，两类不再混成一句「报警」
    expect(cards[0].find('p').text()).toContain('视频监控')
    expect(cards[1].find('p').text()).toContain('无人机')
    w.unmount()
  })

  it('两张卡都报今日待处理；底栏角标是两处之和', async () => {
    const feed = camAlarmFixtures().slice(0, 3)
    feed[1].handleStatus = 1 // 这条已完成
    const alarm = useAlarmStore()
    alarm.liveAlarms = feed
    alarm.liveState = 'ok'
    const drone = useDroneAlarmStore()
    // 今日 3 条（2 条待处理 + 1 条已完成）+ 一条昨天的待处理（**不算**）
    drone.apply(
      [
        wo(1),
        wo(2),
        wo(3, { status: 'AUDITED' }),
        wo(4, { at: yesterdayStamp() }),
      ],
      { total: 1048 },
    )
    signIn()

    const msg = useMsgStore()
    expect(msg.monitorPending).toBe(2) // 3 条里 1 条已完成
    expect(msg.dronePending).toBe(2) // 今日 3 条里 1 条已完成
    // 角标 = 监控 + 无人机（2026-11-24 现场口径：两处相加）
    expect(msg.pendingTotal).toBe(4)
    expect(msg.categories[0].count).toBe(2)
    expect(msg.categories[0].hint).toBe('今日待处理')
    expect(msg.categories[1].count).toBe(2)
    expect(msg.categories[1].hint).toBe('今日待处理')

    const w = mount(MsgPage)
    await nextTick()
    const cards = w.findAll('.msg-item')
    expect(cards[0].find('.msg-badge').text()).toBe('2')
    expect(cards[0].find('.msg-hint').text()).toBe('今日待处理')
    // 无人机也是待处理数（不是今日总数），标签与配色和监控一致
    expect(cards[1].find('.msg-badge').text()).toBe('2')
    expect(cards[1].find('.msg-hint').text()).toBe('今日待处理')
    expect(cards[1].find('.msg-badge').classes()).not.toContain('is-plain')
    w.unmount()
  })

  it('无人机卡：时间来自最新一条，数字是今日待处理', async () => {
    useAlarmStore().liveState = 'ok'
    const drone = useDroneAlarmStore()
    drone.apply([wo(1), wo(2), wo(3, { status: 'AUDITED' })], { total: 1048 })

    const msg = useMsgStore()
    const cat = msg.categories[1]
    expect(cat.title).toBe('无人机预警')
    expect(cat.count).toBe(2) // 今日 3 条里 1 条已完成
    expect(cat.hint).toBe('今日待处理')
    expect(cat.known).toBe(true)
    // 相对时间取自最新一条（服务端按 businessTime 倒序）
    expect(cat.time).toBe('刚刚')
  })

  it('条数还没拿到时写「—」，不写 0（0 是个结论）', async () => {
    useAlarmStore().liveState = 'ok'
    const drone = useDroneAlarmStore()
    drone.state = 'ok' // 拉过了但一条都没有

    const msg = useMsgStore()
    expect(msg.categories[0].known).toBe(true) // 监控：ok 就算已知
    expect(msg.categories[1].known).toBe(false)

    signIn()
    const w = mount(MsgPage)
    await nextTick()
    expect(w.findAll('.msg-item')[1].find('.msg-unknown').text()).toBe('—')
    expect(w.findAll('.msg-item')[1].find('.msg-badge').exists()).toBe(false)
    w.unmount()
  })

  it('两类都空才说「暂无预警消息」；有一类有数据就不说', async () => {
    useAlarmStore().liveState = 'ok'
    const drone = useDroneAlarmStore()
    drone.state = 'ok'
    signIn()

    expect(useMsgStore().isEmpty).toBe(true)
    const empty = mount(MsgPage)
    await nextTick()
    expect(empty.find('.msg-empty-note').text()).toBe('暂无预警消息')
    // 分类卡仍在：点进去能看各自的原因（接口失败 / 真的没有）
    expect(empty.findAll('.msg-item')).toHaveLength(2)
    empty.unmount()

    drone.apply([wo(1)])
    expect(useMsgStore().isEmpty).toBe(false)
    const one = mount(MsgPage)
    await nextTick()
    expect(one.find('.msg-empty-note').exists()).toBe(false)
    one.unmount()
  })

  it('点「监控预警」进今日巡检预警列表，点「无人机预警」进无人机预警列表', async () => {
    seedAll(2, 2)
    signIn()
    const w = mount(MsgPage)
    const sub = useSubpageStore()

    await w.find('[data-kind="monitor"]').trigger('click')
    expect(sub.view).toEqual({ kind: 'inspect-list' })
    expect(useAlarmStore().inspTab).toBe('today')

    sub.dismiss()
    await w.find('[data-kind="drone"]').trigger('click')
    expect(sub.view).toEqual({ kind: 'work-orders' })
    w.unmount()
  })

  it('未登录：只说一句 + 去登录，不发任何请求', async () => {
    const w = mount(MsgPage)

    expect(w.find('[data-empty="msg"]').text()).toContain('登录后可查看现场预警消息')
    expect(w.find('.msg-item').exists()).toBe(false)

    await w.find('.data-empty-btn').trigger('click')
    const sub = useSubpageStore()
    expect(sub.view).toEqual({ kind: 'login' })
    expect(sub.loginNotice).toContain('登录后可查看现场预警消息')
    expect(fetch).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('消息页 · 首屏骨架不提前下结论', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn(async () => emptyAlarms()))
    vi.spyOn(useAlarmStore(), 'syncFromVideo').mockResolvedValue(true)
    vi.spyOn(useDroneAlarmStore(), 'load').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('同步越过 280ms 灰条才淡入，数据到了立刻撤', async () => {
    vi.useFakeTimers()
    signIn()
    const alarm = useAlarmStore()
    alarm.liveState = 'loading'
    // 无人机侧还没结论（todayKnown 仍 false）：这一屏就是「什么都还不知道」
    useDroneAlarmStore().state = 'ok'

    const w = mount(MsgPage)
    await nextTick()
    const skel = () => w.find('[data-skel="msg"]')
    // 灰条位先占着（避免先出内容再换成灰条），但前 280ms 是隐形的
    expect(skel().exists()).toBe(true)
    expect(skel().classes()).not.toContain('is-on')
    expect(w.find('.msg-empty-note').exists()).toBe(false)

    vi.advanceTimersByTime(279)
    await nextTick()
    expect(skel().classes()).not.toContain('is-on')

    vi.advanceTimersByTime(2)
    await nextTick()
    expect(skel().classes()).toContain('is-on')

    // 数据到了：撤灰条不等延迟
    alarm.liveState = 'ok'
    await nextTick()
    expect(skel().exists()).toBe(false)
    w.unmount()
  })

  it('无人机侧先有结果就先立卡，不等监控那几百毫秒', async () => {
    vi.useFakeTimers()
    signIn()
    const alarm = useAlarmStore()
    alarm.liveState = 'loading'
    useDroneAlarmStore().apply([wo(1)])

    const w = mount(MsgPage)
    expect(w.find('[data-skel="msg"]').exists()).toBe(false)
    expect(w.findAll('.msg-item')).toHaveLength(2)

    // 监控还没回来：它那格写「—」而不是 0
    expect(w.findAll('.msg-item')[0].find('.msg-unknown').text()).toBe('—')
    w.unmount()
  })
})

/**
 * 状态只读（2026-11-24）
 *
 * 「一键已读」整体下线，进详情也不再顺手置状态。这一组钉的是：
 *   ① 消息页顶栏没有任何动作按钮；
 *   ② 点开监控预警只进详情，一个 PATCH 都不发，待处理数不变；
 *   ③ 列表状态徽标只读 `handleStatus`（待处理 / 已完成）。
 */
describe('消息页 · 状态只读', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn(async () => emptyAlarms()))
    vi.spyOn(useAlarmStore(), 'syncFromVideo').mockResolvedValue(true)
    vi.spyOn(useDroneAlarmStore(), 'load').mockResolvedValue(undefined)
    useShellStore().activeTab = 'msg'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('顶栏没有任何动作按钮（一键已读已下线）', () => {
    signIn()
    const alarm = useAlarmStore()
    alarm.liveAlarms = camAlarmFixtures().slice(0, 3)
    alarm.liveState = 'ok'

    const w = mount(NavBar)
    expect(w.find('[data-read-all]').exists()).toBe(false)
    expect(w.find('.nav-action').exists()).toBe(false)
    expect(w.findAll('button')).toHaveLength(0)
    w.unmount()
  })

  it('点开监控预警：只进详情，不发 PATCH、待处理数不变', async () => {
    signIn()
    const alarm = useAlarmStore()
    alarm.liveAlarms = camAlarmFixtures().slice(0, 3)
    alarm.liveState = 'ok'

    const w = mount(InspectList)
    const items = w.findAll('.insp-pane:not(.insp-hist) .insp-item')
    await items[0].trigger('click')
    await flushPromises()

    const asMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(asMock.mock.calls.filter((c) => String(c[1]?.method) === 'PATCH')).toHaveLength(0)
    expect(alarm.liveAlarms[0].handleStatus).not.toBe(1)
    expect(useSubpageStore().view.kind).toBe('alarm-detail')
    // 待处理是事实状态，不会因为「看过」减少
    expect(useMsgStore().monitorPending).toBe(3)
    w.unmount()
  })

  it('列表徽标：待处理 / 已完成 来自 handleStatus', () => {
    signIn()
    const feed = camAlarmFixtures().slice(0, 2)
    feed[1].handleStatus = 1
    const alarm = useAlarmStore()
    alarm.liveAlarms = feed
    alarm.liveState = 'ok'

    const w = mount(InspectList)
    const items = w.findAll('.insp-pane:not(.insp-hist) .insp-item')
    expect(items[0].find('.alarm-src-todo').text()).toBe('待处理')
    expect(items[1].find('.alarm-src-done').text()).toBe('已完成')
    w.unmount()
  })
})
