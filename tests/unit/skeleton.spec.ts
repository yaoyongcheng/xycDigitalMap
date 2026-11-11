import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { SKEL_DELAY, useSlowLoading } from '@/utils/slowLoading'
import AlarmHist from '@/views/sub/AlarmHist.vue'

/**
 * 骨架屏（2026-11，对齐支付宝的加载观感）
 *
 * 这一组钉住三件事，它们合起来才是「支付宝那样」：
 *   ① **快请求不闪**：骨架等 SKEL_DELAY 才上屏，之前只有占位没有灰条；
 *   ② **慢请求一定有**：越过阈值就出现，不会因为某种状态没刷新而永远空白；
 *   ③ **数据到了立刻撤**：撤下不等延迟 —— 延迟只加在上屏那一侧。
 */

/** 探针组件：把 composable 的返回值渲染出来，模拟真实组件里的用法 */
const Probe = defineComponent({
  props: { pending: { type: Boolean, default: false } },
  setup(props) {
    const show = useSlowLoading(() => props.pending, 100)
    return { show }
  },
  template: '<i>{{ show }}</i>',
})

describe('useSlowLoading：延迟上屏、立刻撤下', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('阈值之前不上屏（快请求全程看不到骨架）', async () => {
    const w = mount(Probe, { props: { pending: true } })
    await nextTick()
    expect(w.text()).toBe('false')

    vi.advanceTimersByTime(99)
    await nextTick()
    expect(w.text()).toBe('false')

    vi.advanceTimersByTime(2)
    await nextTick()
    expect(w.text()).toBe('true')
    w.unmount()
  })

  it('请求在阈值内完成：一个灰条都不闪，之后也不再出现', async () => {
    const w = mount(Probe, { props: { pending: true } })
    await nextTick()

    vi.advanceTimersByTime(60)
    await w.setProps({ pending: false })
    // 关键：定时器必须被清掉，否则 40ms 后还会冒出来一条没有数据的灰条
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(w.text()).toBe('false')
    w.unmount()
  })

  it('数据到了立刻撤，不等延迟', async () => {
    const w = mount(Probe, { props: { pending: true } })
    await nextTick()
    vi.advanceTimersByTime(150)
    await nextTick()
    expect(w.text()).toBe('true')

    await w.setProps({ pending: false })
    await nextTick()
    expect(w.text()).toBe('false')
    w.unmount()
  })

  it('卸载后不再写状态（定时器被清掉）', async () => {
    const w = mount(Probe, { props: { pending: true } })
    await nextTick()
    w.unmount()
    // 若定时器没清，这里会在已卸载的组件上触发一次写入（Vue 会告警）
    expect(() => vi.advanceTimersByTime(SKEL_DELAY * 4)).not.toThrow()
  })
})

describe('Skel 灰条', () => {
  it('尺寸由调用方按真实元素传入（骨架与原内容同构）', () => {
    const w = mount(Skel, { props: { w: '48px', h: '14px', r: 'var(--r-8)' } })
    const el = w.find('.skel')
    expect(el.attributes('style')).toContain('width: 48px')
    expect(el.attributes('style')).toContain('height: 14px')
    expect(el.attributes('style')).toContain('border-radius: var(--r-8)')
  })

  it('circle 走正圆（环形图 / 头像位）', () => {
    const w = mount(Skel, { props: { circle: true, w: '40px', h: '40px' } })
    expect(w.find('.skel').attributes('style')).toContain('border-radius: 50%')
  })

  it('对读屏隐藏：它只是占位，不该被念出来', () => {
    const w = mount(Skel)
    expect(w.find('.skel').attributes('aria-hidden')).toBe('true')
  })
})

/**
 * 「加载中不提前下结论」是这一轮最容易回退的一条：翻到还没拉过的日期时
 * `ensureDate` 会按需回补，此时列表还是空的 —— 如果只看列表长度，页面会
 * 先说「该日暂无预警记录 / 0条」，数据到了又跳成 41 条，像在自相矛盾。
 */
describe('历史窗格：回补期间铺骨架，不提前说「暂无」', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })))
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loading → 计数是「…」、列表是灰条，不出现空态结论', async () => {
    const alarm = useAlarmStore()
    alarm.histTab = 'hist'
    alarm.liveState = 'loading'

    const w = mount(AlarmHist)
    await nextTick()
    const pane = w.find('.insp-pane.insp-hist')

    expect(pane.find('.insp-hist-hd span').text()).toBe('…')
    expect(pane.findAll('.insp-item.is-skel').length).toBeGreaterThan(0)
    expect(pane.find('.insp-empty').exists()).toBe(false)
    w.unmount()
  })

  it('回补结束仍无数据 → 撤骨架、才给出空态', async () => {
    const alarm = useAlarmStore()
    alarm.histTab = 'hist'
    alarm.liveState = 'loading'

    const w = mount(AlarmHist)
    await nextTick()
    alarm.liveState = 'ok'
    await nextTick()
    const pane = w.find('.insp-pane.insp-hist')

    expect(pane.findAll('.skel')).toHaveLength(0)
    expect(pane.find('.insp-empty').text()).toContain('该日暂无预警记录')
    w.unmount()
  })
})
