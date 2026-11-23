import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/**
 * 嵌套滚动「接力」：内层滚到边界后，把剩下的滚动量交给外层滚动容器。
 *
 * 背景：首页抽屉（滚动容器是抽屉内的 `.home-panels`，2026-11-23 之前是
 * 外层的 `.home-sheet`）里塞了一块限高的名单（`.people-groups`，
 * `max-height: 320px`）。两层都能纵向滚，就必然遇到两个
 * 老问题 —— 要么内层到底后把整个手势吃掉（外层纹丝不动，手感像粘住），
 * 要么内层刚到底就被外层抢走（方向一变要先把外层滚回去才能继续看名单）。
 *
 * 2026-11-23：人员分布改成「卡片 + 底部浮窗」后，这个内联名单已经下线
 * （名单现在在 `PeopleDistSheet` 的 `.pd-list` 里，弹层自身 contain，不需要
 * 接力）。本工具与它的单测保留 —— 逻辑是通用的，将来再有「抽屉里套限高
 * 列表」的场景直接复用。
 *
 * 分工：
 *
 *   · **触摸**（手指）完全交给浏览器原生滚动链。CSS 侧把
 *     `overscroll-behavior-y` 从 `contain` 放开成 `auto` 即可，同时**不加**
 *     `-webkit-overflow-scrolling: touch` —— 那个属性会把这个 div 变成独立的
 *     滚动层，老 iOS 上内层滚到底就不再往父级传，正好是我们要去掉的行为。
 *     不用 JS 接管触摸是刻意的：一旦 `preventDefault` 掉 touchmove，惯性
 *     （松手后的滑行）就没了，那才是真正的「卡顿」。
 *
 *   · **滚轮**（桌面 / 触控板 / 部分安卓浏览器）做一层确定性的兜底。
 *     浏览器的余量传递各家实现略有差异（Safari 桌面尤其），而滚轮一个事件
 *     可能带着几百像素，若只把「内层剩下那 20px」吃掉、余量丢掉，就会觉得
 *     滚一下顿一下。所以只要内层在该方向已经到边界，本函数自己把 delta
 *     交给外层并 `preventDefault`（避免浏览器再链一次造成双倍速度）。
 *
 * 判断「该不该接力」每次都现读 scrollTop，不缓存方向：这样同一手势里手指
 * 一反转，内层只要还能滚就立刻归还原生滚动 —— 不做 scroll latching。
 *
 * @param inner 内层滚动容器（`overflow-y: auto` 且限高的那个）
 */
export interface ScrollChain {
  /** 上方还有内容（顶边可以显示「上面还有」的渐隐） */
  canUp: Ref<boolean>
  /** 下方还有内容 */
  canDown: Ref<boolean>
  /** 滚回顶部并重新量边界（切换下钻层级时用，否则会停在上一层的中间） */
  reset: () => void
}

/** 1px 容差：高分屏 scrollTop 是小数，严格比较永远判不到边界 */
const EPS = 1

export function useScrollChain(inner: Ref<HTMLElement | null>): ScrollChain {
  const canUp = ref(false)
  const canDown = ref(false)
  /** 内层是否真的溢出了；只有溢出时才谈得上「边界」 */
  let scrollable = false

  /** 外层滚动容器：找到就留着（同一棵子树里不会变），undefined = 还没找过 */
  let outer: HTMLElement | null | undefined
  /** 当前挂着监听的元素，解绑时要用同一个引用 */
  let bound: HTMLElement | null = null
  let ro: ResizeObserver | null = null

  function measure(el: HTMLElement): void {
    const max = el.scrollHeight - el.clientHeight
    scrollable = max > EPS
    canUp.value = el.scrollTop > EPS
    canDown.value = max > EPS && el.scrollTop < max - EPS
  }

  function onScroll(): void {
    if (bound) measure(bound)
  }

  /** 往上找第一个「纵向上真的能滚」的祖先；只认 auto/scroll/overlay */
  function findOuter(el: HTMLElement): HTMLElement | null {
    let p = el.parentElement
    while (p && p !== document.documentElement) {
      if (p.scrollHeight > p.clientHeight + EPS) {
        const oy = getComputedStyle(p).overflowY
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p
      }
      p = p.parentElement
    }
    return null
  }

  function onWheel(e: WheelEvent): void {
    const el = inner.value
    if (!el) return
    // 捏合缩放（ctrl + wheel）不是滚动；横向手势不掺和
    if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    // deltaMode 1/2 是按行/按页，换算成像素会失真，交回浏览器
    if (e.deltaMode !== 0) return
    // 内层没溢出：手势本来就直接落在外层，不需要接力
    if (!scrollable) return

    const down = e.deltaY > 0
    // 内层在这个方向还能滚 → 原生滚动，保留它自己的平滑与惯性
    if (down ? canDown.value : canUp.value) return

    if (outer === undefined) outer = findOuter(el)
    const host = outer
    if (!host) return

    const max = host.scrollHeight - host.clientHeight
    const next = Math.min(max, Math.max(0, host.scrollTop + e.deltaY))
    // 外层也到头了：这一下本来就滚不动，别 preventDefault，让浏览器自己收尾
    if (next === host.scrollTop) return

    e.preventDefault()
    host.scrollTop = next
  }

  function bind(el: HTMLElement | null): void {
    if (bound) {
      bound.removeEventListener('scroll', onScroll)
      bound.removeEventListener('wheel', onWheel)
    }
    bound = el
    ro?.disconnect()
    ro = null
    if (!el) {
      scrollable = false
      canUp.value = false
      canDown.value = false
      return
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // passive: false —— 接力时要 preventDefault
    el.addEventListener('wheel', onWheel, { passive: false })
    measure(el)
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure(el))
      ro.observe(el)
    }
  }

  // 内层元素多半在 `v-if` 里，挂载时还不存在 —— 交给 watch 处理挂载/卸载
  watch(inner, (el) => bind(el), { immediate: true })

  function reset(): void {
    const el = inner.value
    if (!el) return
    el.scrollTop = 0
    measure(el)
  }

  onBeforeUnmount(() => {
    bind(null)
  })

  return { canUp, canDown, reset }
}
