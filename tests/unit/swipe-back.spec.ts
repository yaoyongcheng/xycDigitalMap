import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import { useSubpageStore } from '@/stores/subpage'
import { useSwipeBack } from '@/utils/swipeBack'
import { makePointerEvent } from '../helpers/dom'

/**
 * 右滑返回手势（2026-10 新增）
 *
 * 判定逻辑全是数值条件（起手区、方向、阈值、速度），肉眼很难验准，
 * 必须用用例钉住：误判成返回会把用户正在滚的列表「弹走」，
 * 漏判则手势形同不存在。
 */

const Host = defineComponent({
  setup() {
    useSwipeBack()
    return () => h('div')
  },
})

let wrapper: ReturnType<typeof mount> | null = null
let layer: HTMLElement
let backSpy: ReturnType<typeof vi.fn>

function setupLayer(): void {
  layer = document.createElement('div')
  layer.className = 'subpage open'
  const btn = document.createElement('button')
  btn.setAttribute('data-back', '')
  btn.addEventListener('click', backSpy)
  layer.appendChild(btn)
  document.body.appendChild(layer)
}

function down(x: number, y = 300): void {
  window.dispatchEvent(makePointerEvent('pointerdown', { pointerId: 1, clientX: x, clientY: y }))
}

function move(x: number, y = 300, id = 1): void {
  window.dispatchEvent(makePointerEvent('pointermove', { pointerId: id, clientX: x, clientY: y }))
}

function up(x: number, y = 300): void {
  window.dispatchEvent(makePointerEvent('pointerup', { pointerId: 1, clientX: x, clientY: y }))
}

/** 一次完整拖拽（按下 → 单次移动到终点 → 抬起） */
function drag(fromX: number, toX: number, fromY = 300, toY = 300): void {
  down(fromX, fromY)
  move(toX, toY)
  up(toX, toY)
}

describe('右滑返回手势', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    setActivePinia(createPinia())
    backSpy = vi.fn()
    setupLayer()
    wrapper = mount(Host)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    document.body.style.userSelect = ''
    vi.useRealTimers()
  })

  function openSubpage(): void {
    useSubpageStore().view = { kind: 'inspect-list' }
  }

  it('左边缘起手、右滑超过阈值 → 触发该层的返回按钮', () => {
    openSubpage()
    drag(10, 200)
    vi.advanceTimersByTime(400)
    expect(backSpy).toHaveBeenCalledTimes(1)
  })

  it('滑动过程中页面跟手位移（带阻尼）', () => {
    openSubpage()
    down(10)
    move(110, 302)
    // 阻尼 0.55：手指走 100px，页面走 55px（值可能带浮点尾数）
    expect(layer.style.transform).toMatch(/^translate3d\(55(\.\d+)?px, 0, 0\)$/)
  })

  it('位移不足阈值 → 回弹，不返回', () => {
    openSubpage()
    drag(10, 40)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
    expect(layer.style.transform).toBe('')
  })

  it('快速轻扫（位移不大但速度够）也触发返回', () => {
    openSubpage()
    down(10)
    vi.advanceTimersByTime(20)
    move(60)
    up(60)
    vi.advanceTimersByTime(400)
    expect(backSpy).toHaveBeenCalledTimes(1)
  })

  it('纵向为主的滑动不接管（否则列表滚不动）', () => {
    openSubpage()
    drag(10, 12, 300, 430)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
    expect(layer.style.transform).toBe('')
  })

  it('非左边缘起手不接管（页面中间横向拖拽不应触发返回）', () => {
    openSubpage()
    drag(100, 320)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
  })

  it('只点左边缘不滑动 → 什么也不发生', () => {
    openSubpage()
    down(10)
    up(10)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
  })

  it('没有覆盖层时不接管（一级页面右滑无副作用）', () => {
    useSubpageStore().view = { kind: 'none' }
    drag(10, 300)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
  })

  it('滑出动画期间不重复触发', () => {
    openSubpage()
    drag(10, 200)
    // 第一次已在滑出（busy），紧接着再滑一次应被忽略
    drag(10, 200)
    vi.advanceTimersByTime(400)
    expect(backSpy).toHaveBeenCalledTimes(1)
  })

  /*
   * 子页栈不是真叠加，详情页右滑时下面是 .pages（消息页）。SubPage 会垫一层
   * 只读的 .subpage-under 作为真实上一页 —— 手势必须只位移/只点当前层，
   * 否则要么露出错页面，要么点错按钮。
   */
  it('存在垫底上一层时，只位移当前层、只点当前层的返回键', () => {
    openSubpage()

    const underSpy = vi.fn()
    const under = document.createElement('div')
    under.className = 'subpage subpage-under open'
    const underBtn = document.createElement('button')
    underBtn.setAttribute('data-back', '')
    underBtn.addEventListener('click', underSpy)
    under.appendChild(underBtn)
    // 插到最前面：under 会成为 querySelector 的第一个匹配，专挑「没排除干净」的实现
    document.body.insertBefore(under, layer)

    down(10)
    move(110)
    expect(layer.style.transform).not.toBe('')
    expect(under.style.transform).toBe('')

    up(200)
    vi.advanceTimersByTime(400)
    expect(backSpy).toHaveBeenCalledTimes(1)
    expect(underSpy).not.toHaveBeenCalled()
  })
})
