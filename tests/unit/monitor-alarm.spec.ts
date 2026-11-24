import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useMsgStore } from '@/stores/msg'
import { titleOf, useSubpageStore } from '@/stores/subpage'
import { inspCalMaxDay } from '@/utils/date'
import MsgPage from '@/views/MsgPage.vue'
import InspectList from '@/views/sub/InspectList.vue'
import { camAlarmFixtures } from '../fixtures/camAlarms'

/**
 * 监控预警子页：标题 + 今日待处理 + 状态徽标（2026-11-24 口径）
 *
 * 现场口径：
 *   · 这一页标题就叫「监控预警」（它是消息页那张卡的明细）；
 *   · 每行右侧显示「相对时间 + 待处理/已完成」，与无人机预警列表同一套样式与判据
 *     （`handleStatus === 1` 才算已完成）；
 *   · 状态**只读**：点开只进详情，不发 PATCH、不改状态；
 *   · 未读红点已下线（本 App 没有「标记已读」这个动作，红点点开也清不掉）；
 *   · 消息页那张卡的「今日待处理」必须与列表里「待处理」徽标个数一致。
 *
 * 这一组钉的正是「数字和徽标不能各算一套」：卡片按 `handleStatus` 数、
 * 列表按同一判据显示，两边一旦分叉，用户会立刻发现。
 */

function signIn(): void {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.expiresAt = Date.now() + 3_600_000
}

/** `:8085` 的信封走 text()；PATCH 状态也只回一个 code */
function okResponse(): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200 }) }
}

/** 3 条今日（中间那条已读）+ 1 条昨天未读 */
function feed(): ReturnType<typeof camAlarmFixtures> {
  const rows = camAlarmFixtures().slice(0, 4) // 101/102/103 今日 + 104 今日 3 号通道
  rows[1].handleStatus = 1
  return rows
}

/** 今日 3 条 + 昨天 1 条（夹具里的 va-105） */
function feedWithYesterday(): ReturnType<typeof camAlarmFixtures> {
  const rows = camAlarmFixtures()
  rows[1].handleStatus = 1 // 今日 102 已读
  return rows
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
})

afterEach(async () => {
  await flushPromises()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('标题', () => {
  it('子页标题是「监控预警」（不再叫巡检预警）', () => {
    expect(titleOf({ kind: 'inspect-list' })).toBe('监控预警')
  })
})

describe('今日预警：处理状态徽标（与无人机列表一致）', () => {
  it('待处理 / 已完成 来自服务端 handleStatus，缺省按待处理', async () => {
    signIn()
    const alarm = useAlarmStore()
    alarm.liveAlarms = feed()
    alarm.liveState = 'ok'

    const w = mount(InspectList)
    await nextTick()

    const items = w.findAll('.insp-pane:not(.insp-hist) .insp-item')
    expect(items).toHaveLength(4)
    // 101 待处理 / 102 已完成 / 103、104 待处理
    expect(items.map((i) => i.find('.alarm-src-todo').exists())).toEqual([true, false, true, true])
    expect(items.map((i) => i.find('.alarm-src-done').exists())).toEqual([false, true, false, false])
    expect(items[0].find('.alarm-src-todo').text()).toBe('待处理')
    expect(items[1].find('.alarm-src-done').text()).toBe('已完成')
    // 未读红点已下线（本 App 不改状态，红点会永远清不掉）
    expect(w.findAll('.insp-dot')).toHaveLength(0)
    w.unmount()
  })

  it('历史预警同样显示状态徽标（状态是事实，不是「今天看没看过」）', async () => {
    signIn()
    const alarm = useAlarmStore()
    alarm.liveAlarms = feedWithYesterday()
    alarm.liveState = 'ok'
    alarm.inspHistDate = inspCalMaxDay() // 昨天
    alarm.inspTab = 'hist'

    const w = mount(InspectList)
    await nextTick()

    const hist = w.findAll('.insp-pane.insp-hist .insp-item')
    expect(hist).toHaveLength(1)
    expect(hist[0].find('.alarm-src-todo').text()).toBe('待处理')
    expect(hist[0].find('.insp-dot').exists()).toBe(false)
    w.unmount()
  })
})

describe('状态只读：点开只进详情，不改状态', () => {
  it('点开今日某条：不发 PATCH、handleStatus 保持原值', async () => {
    signIn()
    const alarm = useAlarmStore()
    const rows = feed()
    alarm.liveAlarms = rows
    alarm.liveState = 'ok'

    const w = mount(InspectList)
    const target = w.findAll('.insp-pane:not(.insp-hist) .insp-item')[0]

    await target.trigger('click')
    await flushPromises()

    expect(alarm.byId(rows[0].id)?.handleStatus).toBe(0)
    const asMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(asMock.mock.calls.filter((c) => String(c[1]?.method) === 'PATCH')).toHaveLength(0)
    // 详情照常打开（只读展示原状态）
    expect(useSubpageStore().view).toEqual({ kind: 'alarm-detail', id: rows[0].id })
    w.unmount()
  })

  it('点开历史某条：同样只进详情、不改状态', async () => {
    signIn()
    const alarm = useAlarmStore()
    const rows = feedWithYesterday()
    alarm.liveAlarms = rows
    alarm.liveState = 'ok'
    alarm.inspHistDate = inspCalMaxDay()
    alarm.inspTab = 'hist'

    const w = mount(InspectList)
    const hist = w.findAll('.insp-pane.insp-hist .insp-item')
    expect(hist).toHaveLength(1)

    await hist[0].trigger('click')
    await flushPromises()

    const asMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(asMock.mock.calls.filter((c) => String(c[1]?.method) === 'PATCH')).toHaveLength(0)
    expect(alarm.byId(rows[4].id)?.handleStatus).not.toBe(1)
    expect(useSubpageStore().view).toEqual({ kind: 'alarm-detail', id: rows[4].id })
    w.unmount()
  })
})

describe('消息页「监控预警」入口的今日待处理数', () => {
  it('只数今日、只数待处理，与列表状态徽标一致', async () => {
    signIn()
    const alarm = useAlarmStore()
    alarm.liveAlarms = feedWithYesterday() // 今日 4 条（1 已读）+ 昨天 1 条（未读）
    alarm.liveState = 'ok'

    const msg = useMsgStore()
    // 今日 4 条里 1 条已完成 → 3 条待处理；昨天那条**不算**（历史不参与待办统计）
    expect(msg.monitorPending).toBe(3)
    expect(msg.categories[0].hint).toBe('今日待处理')

    const w = mount(MsgPage)
    await nextTick()
    const card = w.find('[data-kind="monitor"]')
    expect(card.find('.msg-hint').text()).toBe('今日待处理')
    expect(card.find('.msg-badge').text()).toBe('3')

    // 同一份数据下，今日列表里「待处理」徽标正好也是 3 个
    const list = mount(InspectList)
    await nextTick()
    const today = list.findAll('.insp-pane:not(.insp-hist) .insp-item')
    expect(today.filter((i) => i.find('.alarm-src-todo').exists())).toHaveLength(3)
    // 历史那 1 条不参与统计，但状态徽标照实显示
    const hist = list.findAll('.insp-pane.insp-hist .insp-item')
    expect(hist).toHaveLength(1)
    expect(hist[0].find('.alarm-src-todo').exists()).toBe(true)

    w.unmount()
    list.unmount()
  })

  it('今日全部已完成 → 不打角标（0 不是「未知」，不写 —）', async () => {
    signIn()
    const alarm = useAlarmStore()
    const rows = camAlarmFixtures().slice(0, 3)
    for (const r of rows) r.handleStatus = 1
    alarm.liveAlarms = rows
    alarm.liveState = 'ok'

    const w = mount(MsgPage)
    await nextTick()
    const card = w.find('[data-kind="monitor"]')
    expect(card.find('.msg-badge').exists()).toBe(false)
    expect(card.find('.msg-unknown').exists()).toBe(false)
    w.unmount()
  })
})
