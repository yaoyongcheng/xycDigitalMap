import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import SubPage from '@/components/overlays/SubPage.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useSubpageStore } from '@/stores/subpage'
import SafetyPanel from '@/views/home/SafetyPanel.vue'
import { alarmFixtures } from '../fixtures/alarms'

/**
 * 登录守卫（2026-11，支付宝式）
 *
 * 全站唯一「需要 token」的数据是视频报警（:8085，Bearer）。未登录时它必然
 * 401，页面上只会剩一片「暂无」—— 用户分不清是没数据还是没权限。所以：
 *   · 打开应用时未登录 → 直接摆出登录页并写明原因；
 *   · 点进报警相关页面（历史 / 巡检列表）→ 先登录，登录成功后落到本来要看的那页；
 *   · 会话中途失效（401 / 过期）→ 清会话 + 提示 + 回登录页。
 *
 * 这组用例钉住「拦截点」和「登录后的落点」，避免以后把守卫删了或改成
 * 只弹 toast（用户就卡在空页面上了）。
 */
describe('登录守卫', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }) as unknown as Response),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 造一个已登录会话（不真的打登录接口） */
  function signIn(): ReturnType<typeof useAuthStore> {
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000
    return auth
  }

  it('未登录点「历史」：打开登录页并记住目标页', async () => {
    const w = mount(SafetyPanel)
    const sub = useSubpageStore()

    await w.find('[data-alarm-hist]').trigger('click')

    expect(sub.view).toEqual({ kind: 'login' })
    expect(sub.loginNotice).toContain('登录')
    // 登录成功后要恢复到的页面
    expect(sub.loginNext).toEqual({ kind: 'alarm-hist' })
  })

  it('登录成功后落到被拦下的页面，而不是回到首页', () => {
    const sub = useSubpageStore()
    sub.openLogin('登录后可查看报警预警历史', { kind: 'alarm-hist' })

    sub.resumeAfterLogin()

    expect(sub.view).toEqual({ kind: 'alarm-hist' })
    expect(sub.loginNotice).toBe('')
    expect(sub.loginNext).toBeNull()
  })

  it('用户取消登录：恢复目标一并清掉，下次登录不会莫名跳页', () => {
    const sub = useSubpageStore()
    sub.openLogin('登录后可查看报警预警历史', { kind: 'alarm-hist' })
    sub.close()

    expect(sub.view).toEqual({ kind: 'none' })
    expect(sub.loginNext).toBeNull()
  })

  it('已登录点「历史」：直接进历史页，不再弹登录', async () => {
    signIn()
    const w = mount(SafetyPanel)
    const sub = useSubpageStore()

    await w.find('[data-alarm-hist]').trigger('click')

    expect(sub.view).toEqual({ kind: 'alarm-hist' })
    expect(sub.loginNotice).toBe('')
  })

  it('未登录直接打开巡检列表：页面自己把人带到登录页', async () => {
    const sub = useSubpageStore()
    const alarm = useAlarmStore()
    alarm.liveAlarms = alarmFixtures()
    sub.openInspectList('today')

    const w = mount(SubPage, { attachTo: document.body })
    await nextTick()

    expect(sub.view).toEqual({ kind: 'login' })
    expect(sub.loginNext).toEqual({ kind: 'inspect-list' })
    w.unmount()
  })

  it('首页未登录：不显示报警数字，只给登录引导', async () => {
    const w = mount(SafetyPanel)

    expect(w.find('[data-empty="alarm"]').exists()).toBe(true)
    expect(w.find('.alarm-feed-item').exists()).toBe(false)
    // 「今日预警数」这张卡整体不渲染 —— 0 也会被误读成「今天没有报警」
    expect(w.find('.home-stat.alert').exists()).toBe(false)
  })

  it('首页已登录且有数据：正常渲染真实报警', async () => {
    signIn()
    const alarm = useAlarmStore()
    alarm.liveAlarms = alarmFixtures()
    const w = mount(SafetyPanel)
    await nextTick()

    expect(w.find('[data-empty="alarm"]').exists()).toBe(false)
    // 计数卡走 CountUp 滚数，不等动画，直接看数据与列表渲染
    expect(alarm.latest).toHaveLength(4)
    expect(w.find('.home-stat.alert').exists()).toBe(true)
    expect(w.findAll('.alarm-feed-item').length).toBeGreaterThan(0)
  })
})
