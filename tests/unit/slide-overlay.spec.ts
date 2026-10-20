import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import { useSlideOverlay } from '@/utils/slideOverlay'

/**
 * 全屏覆盖层转场（监控 / 航拍 / 隐患）
 *
 * 这一层的核心约束是「关闭必须晚于动画」：三个覆盖层都靠 :hidden 属性 +
 * .open 类控制显隐，一旦先落状态，display:none 会把滑出动画直接吞掉。
 * 同时有两条必须直落的例外（手势已在位移、元素不在文档里），否则会出现
 * 二次动画或测试环境里永远关不掉。
 */

const Host = defineComponent({
  setup(_, { expose }) {
    const el = ref<HTMLElement | null>(null)
    const overlay = useSlideOverlay(() => el.value)
    expose({ overlay })
    return () => h('div', { ref: el, class: 'layer' })
  },
})

let wrapper: ReturnType<typeof mount> | null = null

function setup(attach = true): { overlay: ReturnType<typeof useSlideOverlay>; el: HTMLElement } {
  wrapper = mount(Host, attach ? { attachTo: document.body } : {})
  const el = wrapper.find('.layer').element as HTMLElement
  const overlay = (wrapper.vm as unknown as { overlay: ReturnType<typeof useSlideOverlay> })
    .overlay
  return { overlay, el }
}

describe('全屏覆盖层转场', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('打开时加 is-entering（进入从右滑入）', () => {
    const { overlay, el } = setup()
    overlay.syncOpen(true)
    expect(el.classList.contains('is-entering')).toBe(true)
  })

  it('关闭时清掉残留的动画类', () => {
    const { overlay, el } = setup()
    overlay.syncOpen(true)
    overlay.syncOpen(false)
    expect(el.classList.contains('is-entering')).toBe(false)
    expect(el.classList.contains('is-leaving')).toBe(false)
  })

  it('返回先播滑出，动画结束才落状态', () => {
    const { overlay, el } = setup()
    overlay.syncOpen(true)
    const commit = vi.fn()

    overlay.leave(commit)
    expect(el.classList.contains('is-leaving')).toBe(true)
    expect(commit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(220)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(el.classList.contains('is-leaving')).toBe(false)
  })

  it('右滑手势已在位移时直接落状态，不播二次动画', () => {
    const { overlay, el } = setup()
    overlay.syncOpen(true)
    el.style.transform = 'translate3d(100%, 0, 0)'

    const commit = vi.fn()
    overlay.leave(commit)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(el.classList.contains('is-leaving')).toBe(false)
  })

  it('元素不在文档中（如单测未挂载）时直接落状态', () => {
    const { overlay, el } = setup(false)
    expect(el.isConnected).toBe(false)

    const commit = vi.fn()
    overlay.leave(commit)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('连点返回只触发一次', () => {
    const { overlay } = setup()
    overlay.syncOpen(true)
    const commit = vi.fn()

    overlay.leave(commit)
    overlay.leave(commit)
    vi.advanceTimersByTime(220)
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
