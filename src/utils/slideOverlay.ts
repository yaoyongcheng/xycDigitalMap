import { onUnmounted } from 'vue'

/**
 * 全屏覆盖层的左右滑入 / 滑出转场（2026-10）
 *
 * 与子页（SubPage）共用同一套视觉语言：进入从右侧滑入（页面向左推进），
 * 返回向右滑出（页面向右退出），动画结束才真正落状态 —— 这样滑出过程中
 * 露出的是下面那一层（工作台 / 全屏地图），而不是瞬间消失。
 *
 * 关键帧复用 app.css 的 subEnter / subLeave，LEAVE_MS 必须与之同步。
 *
 * 三处覆盖层（监控 / 航拍 / 隐患）都是「:hidden 属性 + .open 类」控制显隐：
 * 关闭时必须先播完动画再加 hidden，否则 display:none 会把动画吞掉。
 */
const LEAVE_MS = 220

export function useSlideOverlay(getEl: () => HTMLElement | null) {
  let timer = 0
  let leaving = false

  function playEnter(): void {
    const el = getEl()
    if (!el) return
    el.classList.remove('is-entering', 'is-leaving')
    // 强制重排：连续两次进入（关掉再开）也能重新播放
    void el.offsetWidth
    el.classList.add('is-entering')
  }

  /**
   * 先滑出、再执行 commit。
   * 以下三种情况直接落状态，不播二次动画：
   *   · 元素不在文档里（单测未挂载，动画没有意义）
   *   · 右滑手势已经把这层移到屏幕外（transform 非空）
   *   · 系统开启「减弱动效」
   */
  function leave(commit: () => void): void {
    const el = getEl()
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (!el || !el.isConnected || el.style.transform || reduced) {
      commit()
      return
    }
    if (leaving) return
    leaving = true
    el.classList.remove('is-entering')
    el.classList.add('is-leaving')
    timer = window.setTimeout(() => {
      leaving = false
      el.classList.remove('is-leaving')
      commit()
    }, LEAVE_MS)
  }

  /** 打开时播进入；关闭时清掉可能残留的动画类与定时器 */
  function syncOpen(open: boolean): void {
    if (open) {
      playEnter()
      return
    }
    window.clearTimeout(timer)
    leaving = false
    getEl()?.classList.remove('is-entering', 'is-leaving')
  }

  onUnmounted(() => window.clearTimeout(timer))

  return { syncOpen, leave }
}
