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
 * 监控预警子页：标题 + 今日未读红点（2026-11-20）
 *
 * 现场口径：
 *   · 这一页标题就叫「监控预警」（它是消息页那张卡的明细）；
 *   · **今日预警**里未读的条目在图标位右上角点一颗红点（微信的位置），已读没有；
 *   · 已读/未读只对今日生效 —— 历史预警不打点，点开也不改已读状态；
 *   · 消息页那张卡的「今日未读」必须与红点个数一致（同一个判据）。
 *
 * 这一组钉的正是「数字和红点不能各算一套」：卡片按 `handleStatus` 数、
 * 列表按同一判据点，两边一旦分叉，用户会立刻发现「写 3 条未读却只有 1 颗红点」。
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

describe('今日预警：未读红点', () => {
  it('未读的条目有红点，已读的没有', async () => {
    signIn()
    const alarm = useAlarmStore()
    alarm.liveAlarms = feed()
    alarm.liveState = 'ok'

    const w = mount(InspectList)
    await nextTick()

    const items = w.findAll('.insp-pane:not(.insp-hist) .insp-item')
    expect(items).toHaveLength(4)
    // 101 未读 / 102 已读 / 103、104 未读
    expect(items.map((i) => i.find('.insp-dot').exists())).toEqual([true, false, true, true])
    w.unmount()
  })

  it('历史预警不打点（就算 handleStatus 还是未读）', async () => {
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
    expect(hist[0].find('.insp-dot').exists()).toBe(false)
    w.unmount()
  })
})

describe('已读只发生在今日', () => {
  it('点开今日某条：乐观置已读、发一次 PATCH、红点随即消失', async () => {
    signIn()
    const alarm = useAlarmStore()
    const rows = feed()
    alarm.liveAlarms = rows
    alarm.liveState = 'ok'

    const w = mount(InspectList)
    const target = w.findAll('.insp-pane:not(.insp-hist) .insp-item')[0]
    expect(target.find('.insp-dot').exists()).toBe(true)
    expect(useMsgStore().monitorUnread).toBe(3)

    await target.trigger('click')
    await flushPromises()

    expect(alarm.byId(rows[0].id)?.handleStatus).toBe(1)
    expect(target.find('.insp-dot').exists()).toBe(false)
    // 卡片上的「今日未读」跟着掉一条 —— 两处同一个判据，不允许一个动一个不动
    expect(useMsgStore().monitorUnread).toBe(2)

    const asMock = fetch as unknown as ReturnType<typeof vi.fn>
    const patch = asMock.mock.calls.filter((c) => String(c[1]?.method) === 'PATCH')
    expect(patch).toHaveLength(1)
    expect(String(patch[0][0])).toContain('/api/video/alarms/101/status')
    w.unmount()
  })

  it('点开历史某条：只进详情，不发 PATCH、不改已读', async () => {
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
    // 详情还是打开的（历史只是不参与已读，不影响看详情）
    expect(useSubpageStore().view).toEqual({ kind: 'alarm-detail', id: rows[4].id })
    w.unmount()
  })
})

describe('消息页「监控预警」入口的今日未读数', () => {
  it('只数今日、只数未读，与列表红点个数一致', async () => {
    signIn()
    const alarm = useAlarmStore()
    alarm.liveAlarms = feedWithYesterday() // 今日 4 条（1 已读）+ 昨天 1 条（未读）
    alarm.liveState = 'ok'

    const msg = useMsgStore()
    // 今日 4 条里 1 条已读 → 3；昨天那条未读**不算**（历史不参与未读判断）
    expect(msg.monitorUnread).toBe(3)
    expect(msg.categories[0].hint).toBe('今日未读')

    const w = mount(MsgPage)
    await nextTick()
    const card = w.find('[data-kind="monitor"]')
    expect(card.find('.msg-hint').text()).toBe('今日未读')
    expect(card.find('.msg-badge').text()).toBe('3')

    // 同一份数据下，今日列表的红点正好也是 3 颗
    const list = mount(InspectList)
    await nextTick()
    const today = list.findAll('.insp-pane:not(.insp-hist) .insp-item')
    expect(today.filter((i) => i.find('.insp-dot').exists())).toHaveLength(3)
    expect(list.findAll('.insp-pane.insp-hist .insp-item').filter((i) => i.find('.insp-dot').exists())).toHaveLength(0)

    w.unmount()
    list.unmount()
  })

  it('今日全部已读 → 不打角标（0 不是「未知」，不写 —）', async () => {
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
