import { onMounted, onUnmounted } from 'vue'

import { useAirHazardStore } from '@/stores/airHazard'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'

/**
 * 右滑返回（2026-10 新增，微信式）
 *
 * 手指从左边缘起手向右滑，当前覆盖层跟手右移；松手时超过阈值就滑出并返回
 * 上一级，未超过则回弹。返回动作本身不重写各层的三级优先逻辑，而是去点
 * 该层顶部的 `[data-back]` 按钮 —— 这样「子页先回列表再关」「监控先关大图
 * 再收日历」这些既有回路一条都不用复制，手势与点按钮永远同一套行为。
 *
 * 几个刻意为之的约束：
 *   · 只在左边缘 24px 内起手（与微信一致）。页面里的普通横向拖动、图表
 *     触控、卡片滑动都不受影响。
 *   · 进入手势前先判方向：纵向为主就立刻撒手，不干扰列表滚动。
 *   · 全屏地图不接管 —— 它的拖拽本身就是平移地图，边缘手势会跟它抢。
 *   · 横屏（监控）不接管 —— 坐标系变了，手势方向与视觉不符。
 *   · 图片已放大时不接管 —— 那会儿单指拖动是平移图片。
 */

/** 左边缘起手区宽度 */
const EDGE = 24
/** 判定为水平手势前允许的抖动 */
const SLOP = 8
/** 松手触发返回的位移阈值 */
const TRIGGER = 76
/** 快速轻扫的速度阈值（px/ms），达到即不必滑满 TRIGGER */
const FLING = 0.45
/** 跟手阻尼：手指走 100px，页面走 55px */
const DAMPING = 0.55
/** 滑出 / 回弹时长 */
const SLIDE_MS = 200

export function useSwipeBack() {
  const sub = useSubpageStore()
  const cam = useCamStore()
  const air = useAirHazardStore()
  const shell = useShellStore()

  let tracking = false
  let active = false
  let busy = false
  let layer: HTMLElement | null = null
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastT = 0
  let velocity = 0
  let timers: number[] = []

  /** 当前最上层、可被「返回」关闭的覆盖层（互斥打开，最多一个） */
  function topLayer(): HTMLElement | null {
    if (cam.isOpen) return document.querySelector<HTMLElement>('.cam-player.open')
    if (air.isOpen) return document.querySelector<HTMLElement>('.air-player.open')
    if (air.hazardOpen) return document.querySelector<HTMLElement>('.hazard-page.open')
    // 排除 subpage-under：那一层是垫在下面供右滑露出的只读上一页，不该被位移
    if (sub.isOpen) return document.querySelector<HTMLElement>('.subpage.open:not(.subpage-under)')
    return null
  }

  /** 复用各层自己的返回按钮，避免复制三级优先逻辑 */
  function fireBack(): void {
    document
      .querySelector<HTMLElement>(
        '.cam-player.open [data-back], .air-player.open [data-back], .hazard-page.open [data-back], .subpage.open:not(.subpage-under) [data-back]',
      )
      ?.click()
  }

  function clearInline(el: HTMLElement): void {
    el.style.transition = ''
    el.style.transform = ''
  }

  function appEl(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.app')
  }

  /** 收起跟手期间揭示的底栏（子页归位或被关闭后调用） */
  function releaseSwipeState(): void {
    appEl()?.classList.remove('is-swipe-back')
  }

  function onDown(e: PointerEvent): void {
    if (busy || shell.isLand) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.clientX > EDGE) return
    // 图片放大态下，单指拖动是在平移图片，别抢
    if ((e.target as Element | null)?.closest?.('img.zoomable.is-zoomed')) return

    const el = topLayer()
    if (!el) return

    tracking = true
    active = false
    layer = el
    startX = e.clientX
    startY = e.clientY
    lastX = e.clientX
    lastT = performance.now()
    velocity = 0
  }

  function onMove(e: PointerEvent): void {
    if (!tracking) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY

    if (!active) {
      // 纵向为主 → 用户要滚页面；向左 → 不是返回手势。立刻撒手，不做任何接管
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) {
        tracking = false
        return
      }
      if (dx < -SLOP) {
        tracking = false
        return
      }
      if (dx < SLOP) return
      active = true
      document.body.style.userSelect = 'none'
      // 入场动画进行中就被右滑：动画（animation 优先级高于内联 style）会吃掉
      // 跟手位移，必须先摘掉它
      layer?.classList.remove('is-entering', 'is-leaving')
      // 子页打开时底栏是「不可见但仍占位」（见 app.css 的 :has 规则）。
      // 跟手一开始就把它显出来：右滑揭示的是一级页面 + 底栏的完整形态，
      // 与松手后落点的布局完全一致，不会出现「页面往上跳一下」。
      if (sub.isOpen) appEl()?.classList.add('is-swipe-back')
      // 刻意不重置 lastX/lastT：一次「快速轻扫」往往只产生一两个 move 事件，
      // 若在这里把基准挪到当前点，这一帧永远算不出速度，轻扫就会失灵。
      // 基准保持 pointerdown 时的位置与时刻（见 onDown）。
    }

    const now = performance.now()
    if (now > lastT) velocity = (e.clientX - lastX) / (now - lastT)
    lastX = e.clientX
    lastT = now

    if (layer) {
      layer.style.transition = 'none'
      layer.style.transform = `translate3d(${Math.max(0, dx * DAMPING)}px, 0, 0)`
    }
  }

  /** commit=true 走滑出并返回；否则回弹归位 */
  function finish(commit: boolean): void {
    tracking = false
    const node = layer
    layer = null
    document.body.style.userSelect = ''
    active = false
    if (!node) {
      if (commit) fireBack()
      releaseSwipeState()
      return
    }

    node.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1)`
    busy = true
    const done = (): void => {
      clearInline(node)
      releaseSwipeState()
      busy = false
    }

    if (commit) {
      // 先滑出再真正关闭，避免「啪」地一下闪回
      node.style.transform = 'translate3d(100%, 0, 0)'
      timers.push(
        window.setTimeout(() => {
          fireBack()
          done()
        }, SLIDE_MS - 20),
      )
      return
    }

    node.style.transform = ''
    timers.push(window.setTimeout(done, SLIDE_MS + 60))
  }

  function onUp(e: PointerEvent): void {
    if (!tracking) return
    if (!active) {
      // 只是点了一下左边缘，什么也不做
      tracking = false
      return
    }
    const dx = e.clientX - startX
    finish(dx >= TRIGGER || (dx >= 40 && velocity >= FLING))
  }

  function onCancel(): void {
    if (!tracking) return
    finish(false)
  }

  onMounted(() => {
    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onUp, { passive: true })
    window.addEventListener('pointercancel', onCancel, { passive: true })
  })

  onUnmounted(() => {
    window.removeEventListener('pointerdown', onDown)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    timers.forEach((t) => window.clearTimeout(t))
    timers = []
    document.body.style.userSelect = ''
    releaseSwipeState()
    if (layer) clearInline(layer)
  })
}
