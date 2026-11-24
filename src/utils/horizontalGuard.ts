import { onMounted, onUnmounted } from 'vue'

/**
 * 横向手势守卫（2026-11-24）
 *
 * 现场要求：**只有首页预警轮播能响应左右滑**，其它任何地方横滑都不该动内容 ——
 * 不滚页面、不切页、不把浏览器的手势导航带起来。
 *
 * 为什么还要单独一层（前面已经有 `.page{overflow-x:hidden}`、轮播上有
 * `touch-action: pan-y`、`historyBack` 前进零导航）：
 *
 *   · `overflow-x: hidden` 只保证「没有可滚的横向内容」，管不住**子元素**自己
 *     开的横滑（`.pd-units` 那种刻意横滑条）之外的情况 —— 一旦某个新组件写了
 *     `overflow-x: auto` 又刚好溢出，整页又能被横着拖；
 *   · `touch-action: pan-y` 是**逐元素**声明，散落在各组件里，漏一个就有一个
 *     能横滑的洞；而且要小心别写到图表、地图、图片缩放这些真的需要横向拖的
 *     元素上；
 *   · `historyBack` 只能管「已经发生的浏览器导航」，管不住内容先被拖走。
 *
 * 所以这里在 document 层做**一处判定**，规则只有三条：
 *
 *   ① **纵向永不干预。** 一旦判定纵向为主就整指撒手，页面该滚就滚 ——
 *      列表、抽屉、看板全都走浏览器原生滚动，一帧都不抢。
 *   ② **横滑只有两类区域放行**：首页轮播（`.alarm-feed-win`，它自己用 pointer
 *      事件跟手）与「起手元素往上真的有横向可滚容器」的地方（`.pd-units` 这类
 *      刻意横滑条）。其余横向移动一律 `preventDefault()`，把这次 touch 序列的
 *      滚动/手势判码整个掐掉 —— 内容不动，浏览器也就没有「横滑」可消费。
 *   ③ **一次手势只表态一次。** 判定后锁到 `touchend`：中途改变方向也不改判，
 *      否则「斜着划一半再改横」会让页面先滚半屏再横移，比不放行还乱。
 *
 * 为什么用 touch 事件而不是 pointer：这里要的是「阻止默认行为」（取消滚动与
 * 手势导航），只有 touchmove 能 `preventDefault` 且必须 `passive: false`；
 * pointer 事件不可取消，用它拦不住内容被拖走。
 *
 * 已知平台边界（写在这里免得以后再查）：iOS Safari / 微信内置浏览器的
 * **边缘侧滑导航**是系统级手势，`preventDefault` 对它无效 —— 能保证的只是
 * 「应用内内容不动、不发任何 history 遍历」，系统那层快照预览拦不住（
 * 见 `utils/historyBack.ts` 文件头 ④）。装了 PWA（standalone）后该手势消失。
 */

/** 唯一被允许响应横向手势的区域：首页预警轮播 */
const OWNER_SELECTOR = '.alarm-feed-win'

/** 判定横向所需的最小位移（与轮播的 8px 抖动区同量级，略宽一点免得误杀点击） */
const SLOP = 10

/** 本次 touch 序列的判定结果 */
type Mode = 'pending' | 'pass' | 'block'

interface TouchPoint {
  clientX: number
  clientY: number
}

export function useHorizontalGuard(): void {
  /** 初始 pass：没有 touchstart 就收到 move（不该发生）时什么都不做 */
  let mode: Mode = 'pass'
  let startX = 0
  let startY = 0
  let startEl: Element | null = null

  function firstTouch(e: TouchEvent): TouchPoint | null {
    const t = e.touches[0]
    return t ? { clientX: t.clientX, clientY: t.clientY } : null
  }

  /**
   * 起手元素到根，是否有「真的能横滚」的容器。
   *
   * 只认 `auto | scroll`：`hidden` 虽然技术上也能 `scrollLeft`，但用户拖不动，
   * 把它算进来会让 `.page` 这种刚锁死的容器反而放行（见文件头）。
   * 比较 `scrollWidth > clientWidth` 而不是看 overflow 声明 —— 声明了 auto
   * 但内容没溢出的容器横滑本来也没反应，没必要为它放行。
   */
  function ancestorScrollsX(el: Element | null): boolean {
    let node = el
    while (node && node !== document.documentElement) {
      const ox = getComputedStyle(node).overflowX
      if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 2) {
        return true
      }
      node = node.parentElement
    }
    return false
  }

  function onStart(e: TouchEvent): void {
    startEl = e.target instanceof Element ? e.target : null
    // 双指及以上：捏合缩放，整指不干预
    const t = e.touches.length === 1 ? firstTouch(e) : null
    if (!t) {
      mode = 'pass'
      return
    }
    startX = t.clientX
    startY = t.clientY
    // 轮播内的横滑归它自己（pointer 跟手 + touch-action: pan-y）
    mode = startEl?.closest(OWNER_SELECTOR) ? 'pass' : 'pending'
  }

  function onMove(e: TouchEvent): void {
    if (mode === 'pass') return
    if (mode === 'block') {
      // 已经定性为横滑：后续每一帧都按住，否则浏览器会在中途接手滚动
      if (e.cancelable) e.preventDefault()
      return
    }
    const t = e.touches.length === 1 ? firstTouch(e) : null
    if (!t) {
      mode = 'pass'
      return
    }
    const dx = Math.abs(t.clientX - startX)
    const dy = Math.abs(t.clientY - startY)
    // 抖动区里不表态：可能只是一次点击
    if (dx < SLOP) return
    // 纵向为主 → 交给浏览器滚动，这一指后面都不再干预
    if (dy > dx) {
      mode = 'pass'
      return
    }
    // 局部横滑条（楼层 / 区域按钮那类）自己滚，放行
    if (ancestorScrollsX(startEl)) {
      mode = 'pass'
      return
    }
    mode = 'block'
    if (e.cancelable) e.preventDefault()
  }

  function onEnd(): void {
    mode = 'pass'
    startEl = null
  }

  onMounted(() => {
    document.addEventListener('touchstart', onStart, { passive: true })
    // passive: false 是必须的：被动监听里 preventDefault 会被忽略
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onEnd, { passive: true })
  })

  onUnmounted(() => {
    document.removeEventListener('touchstart', onStart)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', onEnd)
    document.removeEventListener('touchcancel', onEnd)
  })
}
