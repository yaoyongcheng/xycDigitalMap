import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import SubPage from '@/components/overlays/SubPage.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useSubpageStore } from '@/stores/subpage'
import { toAlarms } from '@/utils/videoAlarm'

/**
 * 子页内的滚动位置（2026-11-20）
 *
 * 现场问题：报警预警列表滚到中段 → 点一条进详情 → 返回，列表停在顶部。
 *
 * 根因不是列表把位置弄丢了，而是子页栈**共用同一个 `.subpage-body` 换内容**：
 * 进详情时列表组件被 v-if 卸载，容器高度塌成 0，浏览器把 scrollTop 归零。
 * 所以这组用例不测列表组件，直接钉 SubPage 的「切换前记、切换后写回」。
 *
 * 子视图全部 stub 成一行 div —— 这里要验的是容器位置的接力，
 * 与 AlarmHist 的登录守卫、报警数据渲染无关。
 */
vi.mock('@/views/sub/AlarmHist.vue', () => ({
  default: { name: 'AlarmHist', props: ['decorative'], template: '<div class="fake-hist" />' },
}))
vi.mock('@/views/sub/InspectList.vue', () => ({
  default: { name: 'InspectList', props: ['decorative'], template: '<div class="fake-list" />' },
}))
vi.mock('@/views/sub/AlarmDetail.vue', () => ({
  default: { name: 'AlarmDetail', props: ['alarm'], template: '<div class="fake-detail" />' },
}))
vi.mock('@/views/sub/DevicePage.vue', () => ({
  default: { name: 'DevicePage', props: ['kind'], template: '<div />' },
}))
vi.mock('@/views/sub/UavPage.vue', () => ({ default: { name: 'UavPage', template: '<div />' } }))
vi.mock('@/views/sub/ClimbPage.vue', () => ({ default: { name: 'ClimbPage', template: '<div />' } }))
vi.mock('@/views/sub/LoginPage.vue', () => ({ default: { name: 'LoginPage', template: '<div />' } }))

let wrapper: ReturnType<typeof mount> | null = null

/** 当前层（#subpage）的滚动容器 */
function bodyEl(): HTMLElement {
  return document.getElementById('subBody') as HTMLElement
}

/**
 * happy-dom 没有布局，scrollHeight 恒为 0 —— 直接赋 scrollTop 可能被夹回 0。
 * 这里把它改写成普通可写属性，测的是「值有没有被记住并写回」这条逻辑本身。
 */
function makeScrollable(el: HTMLElement): HTMLElement {
  let top = 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v
    },
  })
  return el
}

describe('子页滚动位置', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    wrapper = mount(SubPage, { attachTo: document.body })
    makeScrollable(bodyEl())

    // openAlarmDetail 要求报警已在集合里（否则守卫直接 return）
    // 两条：用例要验「详情 → 另一张详情」时不同 key 各取各的位置
    const list = toAlarms([
      {
        id: '101',
        alertName: '未戴安全帽',
        alertType: 1,
        captureTime: '2026-11-20 07:30:00',
        handleStatus: 0,
        channelNo: 3,
        deviceNo: '06d0680610086',
      },
      {
        id: '102',
        alertName: '未穿反光衣',
        alertType: 2,
        captureTime: '2026-11-20 06:50:00',
        handleStatus: 0,
        channelNo: 4,
        deviceNo: '06d0680610086',
      },
    ])
    useAlarmStore().appendLive(list)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('报警预警列表 → 详情 → 返回：回到进入前的滚动位置', async () => {
    const sub = useSubpageStore()
    sub.openAlarmHist('hist')
    await nextTick()

    bodyEl().scrollTop = 420
    // 再滚一次，确认读到的是「离开那一刻」的值而不是初始值
    bodyEl().scrollTop = 468

    sub.openAlarmDetail('va-101', { kind: 'alarm-hist' })
    await nextTick()
    expect(sub.view.kind).toBe('alarm-detail')
    // 进详情应该从顶部开始 —— 位置属于列表，不该跟到详情页
    expect(bodyEl().scrollTop).toBe(0)

    sub.close()
    await nextTick()
    expect(sub.view.kind).toBe('alarm-hist')
    expect(bodyEl().scrollTop).toBe(468)
  })

  it('巡检列表同样还原', async () => {
    const sub = useSubpageStore()
    sub.openInspectList('today')
    await nextTick()
    bodyEl().scrollTop = 220

    sub.openAlarmDetail('va-101', true)
    await nextTick()
    sub.close()
    await nextTick()
    expect(sub.view.kind).toBe('inspect-list')
    expect(bodyEl().scrollTop).toBe(220)
  })

  it('详情之间切换不串位置：每张详情都从头看', async () => {
    const sub = useSubpageStore()
    sub.openAlarmHist('hist')
    await nextTick()
    bodyEl().scrollTop = 300

    sub.openAlarmDetail('va-101', { kind: 'alarm-hist' })
    await nextTick()
    bodyEl().scrollTop = 700

    // 直接在详情里再打开另一张（首页轮播那种下钻）
    sub.openAlarmDetail('va-102', false)
    await nextTick()
    expect(bodyEl().scrollTop).toBe(0)

    // 返回列表仍然回到列表自己的位置，不是详情那份 700
    sub.view = { kind: 'alarm-hist' }
    await nextTick()
    expect(bodyEl().scrollTop).toBe(300)
  })

  it('关闭子页后再进来：从顶部开始（不恢复上一次的中段）', async () => {
    const sub = useSubpageStore()
    sub.openAlarmHist('today')
    await nextTick()
    bodyEl().scrollTop = 350

    sub.close()
    await nextTick()
    expect(sub.isOpen).toBe(false)

    sub.openAlarmHist('today')
    await nextTick()
    expect(bodyEl().scrollTop).toBe(0)
  })
})
