import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import SheetHost from '@/components/overlays/SheetHost.vue'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useShellStore } from '@/stores/shell'
import { useSwipeBack } from '@/utils/swipeBack'
import PatrolPanel from '@/views/home/PatrolPanel.vue'

import { makePointerEvent } from '../helpers/dom'

/**
 * 底部弹层外壳（2026-10 版本同步 · 第一批）
 *
 * 内容侧的断言在 patrol.spec / 各自的页面用例里，这里只钉「壳」：
 *   1. 对话框语义（role / aria-modal / 标题关联）
 *   2. 三条关闭路径：遮罩、关闭键、Esc
 *   3. 上下文变化时自动收起（切 tab）
 *   4. 焦点：打开进面板、关闭回原处
 *   5. 模态：弹层开着时右滑返回必须让路，不能把底下的子页推走
 */
const Host = defineComponent({
  components: { PatrolPanel, SheetHost },
  setup: () => () => h('div', [h(PatrolPanel), h(SheetHost)]),
})

/** 只挂手势层 */
const GestureHost = defineComponent({
  setup() {
    useSwipeBack()
    return () => h('div')
  },
})

let wrapper: ReturnType<typeof mount> | null = null

/** 打开一张巡检大图（弹层唯一的稳定入口现在是智巡照片墙） */
function openPhoto(w: ReturnType<typeof mount>) {
  return w.findAll('.patrol-card')[0].trigger('click')
}

describe('底部弹层外壳', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('打开后是模态对话框，标题与 aria 关联正确', async () => {
    wrapper = mount(Host)
    expect(wrapper.find('.pop-panel').exists()).toBe(false)

    await openPhoto(wrapper)

    const panel = wrapper.find('.pop-panel')
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
    expect(panel.attributes('aria-labelledby')).toBe('sheetTitle')
    expect(wrapper.find('#sheetTitle').text()).toBe('项目全景')
    expect(wrapper.find('.pop-close').attributes('aria-label')).toBe('关闭')
  })

  it('遮罩与关闭键都能收起', async () => {
    wrapper = mount(Host)

    await openPhoto(wrapper)
    await wrapper.find('.pop-mask').trigger('click')
    expect(wrapper.find('.pop-panel').exists()).toBe(false)

    await openPhoto(wrapper)
    await wrapper.find('.pop-close').trigger('click')
    expect(wrapper.find('.pop-panel').exists()).toBe(false)
  })

  it('Esc 关闭', async () => {
    wrapper = mount(Host)
    await openPhoto(wrapper)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.find('.pop-panel').exists()).toBe(false)
  })

  it('切 tab 时自动收起（弹层属于当前页面上下文）', async () => {
    wrapper = mount(Host)
    await openPhoto(wrapper)

    useShellStore().activeTab = 'work'
    await nextTick()
    expect(wrapper.find('.pop-panel').exists()).toBe(false)
  })

  it('焦点进面板，关闭后回到触发它的那张卡', async () => {
    wrapper = mount(Host, { attachTo: document.body })
    const card = wrapper.findAll('.patrol-card')[0]
    ;(card.element as HTMLElement).focus()

    await card.trigger('click')
    expect(document.activeElement).toBe(wrapper.find('.pop-panel').element)

    await wrapper.find('.pop-close').trigger('click')
    expect(document.activeElement).toBe(card.element)
  })

  it('弹层开着时，右滑返回不接管手势', async () => {
    const gesture = mount(GestureHost)

    // 伪造一层子页：真实场景里弹层也可能是从子页里打开的
    const layer = document.createElement('div')
    layer.className = 'subpage open'
    const back = document.createElement('button')
    back.setAttribute('data-back', '')
    const backSpy = vi.fn()
    back.addEventListener('click', backSpy)
    layer.appendChild(back)
    document.body.appendChild(layer)

    useBottomSheetStore().openPatrol('pano')
    await nextTick()

    window.dispatchEvent(makePointerEvent('pointerdown', { pointerId: 1, clientX: 10, clientY: 300 }))
    window.dispatchEvent(makePointerEvent('pointermove', { pointerId: 1, clientX: 160, clientY: 300 }))
    window.dispatchEvent(makePointerEvent('pointerup', { pointerId: 1, clientX: 160, clientY: 300 }))

    expect(layer.style.transform).toBe('')
    expect(backSpy).not.toHaveBeenCalled()

    gesture.unmount()
  })
})
