import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'

import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useShellStore } from '@/stores/shell'
import { useTabRefresh } from '@/utils/tabRefresh'
import MsgPage from '@/views/MsgPage.vue'

/**
 * 切 tab 刷新（2026-11-24）
 *
 * 四个 tab 页是**常驻挂载**的（`App.vue` 里一直挂着，靠 `.page.active` 切显隐），
 * 所以 `onMounted` 只跑一次。用户「首页看未读 → 消息页一键已读 → 切回首页」时，
 * 首页那三个数字原本一动不动 —— 看起来就是「已读没生效」。
 *
 * 这一组钉住 `useTabRefresh` 的时机语义：
 *   ① 切到目标 tab 才刷新，别的不动；
 *   ② 点当前 tab（activeTab 没变）不刷新；
 *   ③ 600ms 内来回横跳只刷一次（真正的去重仍在各 store 里）。
 * 外加一条接线用例：消息页真的在切回时调了 `alarm.refresh`。
 */

/** 只带一个计数器的探针组件 */
function probe(tab: 'home' | 'work' | 'msg' | 'mine', minGap?: number) {
  const hits = ref(0)
  const C = defineComponent({
    setup() {
      useTabRefresh(tab, () => (hits.value += 1), minGap)
      return { hits }
    },
    template: '<i>{{ hits }}</i>',
  })
  return { C, hits }
}

function signIn(): void {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.expiresAt = Date.now() + 3_600_000
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"code":200,"data":{"list":[],"total":0}}' })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useTabRefresh', () => {
  it('切到目标 tab 才刷新；点当前 tab 不动', async () => {
    const shell = useShellStore()
    // minGap = 0：这条用例只看「哪些切换算数」，节流另有专门的用例
    const { C, hits } = probe('msg', 0)
    const w = mount(C)
    expect(hits.value).toBe(0) // 初次挂载不加载（各页自己的 onMounted 负责首屏）

    shell.activeTab = 'work'
    await nextTick()
    expect(hits.value).toBe(0) // 别的 tab 与它无关

    shell.activeTab = 'msg'
    await nextTick()
    expect(hits.value).toBe(1)

    shell.activeTab = 'msg' // 再点一次当前 tab：值没变，watch 不触发
    await nextTick()
    expect(hits.value).toBe(1)

    shell.activeTab = 'home'
    await nextTick()
    shell.activeTab = 'msg'
    await nextTick()
    expect(hits.value).toBe(2)
    w.unmount()
  })

  it('快速来回横跳只刷一次（600ms 内）', async () => {
    vi.useFakeTimers()
    const shell = useShellStore()
    const { C, hits } = probe('home')
    const w = mount(C)

    shell.activeTab = 'msg'
    await nextTick()
    shell.activeTab = 'home' // 立刻切回来
    await nextTick()
    expect(hits.value).toBe(1)

    vi.advanceTimersByTime(700)
    shell.activeTab = 'msg'
    await nextTick()
    shell.activeTab = 'home'
    await nextTick()
    expect(hits.value).toBe(2)
    w.unmount()
  })

  it('卸载后不再刷新（不给已经离开的页面拉数据）', async () => {
    const shell = useShellStore()
    const { C, hits } = probe('msg')
    const w = mount(C)
    w.unmount()

    shell.activeTab = 'msg'
    await nextTick()
    expect(hits.value).toBe(0)
  })
})

describe('消息页 · 切回 tab 真的重新取数', () => {
  it('从别的 tab 切回消息页：监控预警走 refresh（force），无人机补一次', async () => {
    signIn()
    const alarm = useAlarmStore()
    const drone = useDroneAlarmStore()
    const shell = useShellStore()
    const refresh = vi.spyOn(alarm, 'refresh').mockResolvedValue(true)
    const load = vi.spyOn(drone, 'load').mockResolvedValue(undefined)
    // 首屏那两个入口不参与这条用例
    vi.spyOn(alarm, 'syncFromVideo').mockResolvedValue(true)

    shell.activeTab = 'msg'
    const w = mount(MsgPage)
    await flushPromises()
    refresh.mockClear()
    load.mockClear()

    shell.activeTab = 'home'
    await nextTick()
    expect(refresh).not.toHaveBeenCalled() // 离开消息页不刷

    shell.activeTab = 'msg'
    await nextTick()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('test-token')
    expect(load).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('未登录时切回不发请求', async () => {
    const alarm = useAlarmStore()
    const shell = useShellStore()
    const refresh = vi.spyOn(alarm, 'refresh').mockResolvedValue(true)
    vi.spyOn(alarm, 'syncFromVideo').mockResolvedValue(true)

    shell.activeTab = 'msg'
    const w = mount(MsgPage)
    await flushPromises()
    refresh.mockClear()

    shell.activeTab = 'home'
    await nextTick()
    shell.activeTab = 'msg'
    await nextTick()
    expect(refresh).not.toHaveBeenCalled()
    w.unmount()
  })
})
