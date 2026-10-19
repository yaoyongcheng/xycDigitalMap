import { computed, ref } from 'vue'

/**
 * 图片缩放（2026-10 新增，非原版内容）
 *
 * 改造前预警详情大图与航拍大图都是死图：现场照片里看不清的细节没有任何
 * 办法放大，用户只能截图再放大 —— 而这恰恰是「看隐患照片」的核心诉求。
 *
 * 这里提供四种入口，覆盖触屏与桌面：
 *   · 双指捏合（以两指中点为锚，锚点下的画面不漂移）
 *   · 已放大时单指拖动平移（有边界，不会拖出黑边）
 *   · 双击 1× ↔ 2.4×（桌面与触屏都可用）
 *   · 桌面滚轮缩放（以光标为锚）
 *
 * 刻意返回「绑在 img 上的事件 + 一个 transform 字符串」而不是包一层容器：
 * 全站图片样式都是 `.alarm-hero img` / `.cam-shot-pop img` 这类元素/后代
 * 选择器，加包裹层会把布局整片改掉（max-height 百分比、flex item 语义都会变）。
 *
 * 与 MapViewer 手势层的区别：那边刻意不用 pointer capture（会把点位的
 * click 吞掉），这里图片没有子元素点击诉求，用 capture 才能保证手指移出
 * 图片边缘后仍能连续收到 move。
 */
export interface ImageZoomOptions {
  /** 最大倍率，默认 4 */
  max?: number
  /** 双击放大到的倍率，默认 2.4 */
  doubleTapScale?: number
}

interface Pt {
  x: number
  y: number
}

/** 位移小于该像素值视为「没动」，用来区分点击与拖动 */
const TAP_SLOP = 8
/** 两次点击间隔小于该值算双击 */
const DOUBLE_TAP_MS = 280
/** 与 1 的差值小于该值视为已还原，避免浮点残留让倍率角标常驻 */
const REST_EPS = 0.02
/** 滚轮每一格的缩放系数 */
const WHEEL_STEP = 1.12

export function useImageZoom(options: ImageZoomOptions = {}) {
  const maxScale = options.max ?? 4
  const dblScale = Math.min(options.doubleTapScale ?? 2.4, maxScale)

  const scale = ref(1)
  const tx = ref(0)
  const ty = ref(0)

  /**
   * 过渡开关：回弹 / 双击 / 滚轮需要动画，而手势跟手期间必须关掉，
   * 否则每一帧都在追上一帧的插值，手感会「拖泥带水」。
   */
  const animating = ref(false)

  const zoomed = computed(() => scale.value > 1 + REST_EPS)
  const label = computed(() => `${scale.value.toFixed(1)}×`)
  const imgStyle = computed(() => ({
    transform: `translate3d(${tx.value.toFixed(2)}px, ${ty.value.toFixed(2)}px, 0) scale(${scale.value.toFixed(4)})`,
  }))

  /** 活跃指针（双指时同时跟踪两个） */
  const pointers = new Map<number, Pt>()
  let target: HTMLElement | null = null

  /** 手势起始快照 */
  let startScale = 1
  let startTx = 0
  let startTy = 0
  let startMid: Pt = { x: 0, y: 0 }
  let startDist = 0
  /** 元素未变换时的中心（视口坐标） */
  let center: Pt = { x: 0, y: 0 }
  let startPoint: Pt = { x: 0, y: 0 }
  let moved = false
  let lastTapAt = 0

  function clampScale(s: number): number {
    return Math.min(maxScale, Math.max(1, s))
  }

  function sizeOf(): { w: number; h: number } {
    const el = target
    // offsetWidth/Height 是布局尺寸，不含 transform；getBoundingClientRect 会含缩放
    return el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 0, h: 0 }
  }

  /** 平移上限：以中心为原点放大后左右各多出 (s-1)*w/2，超出就会露底 */
  function clampPan(s: number, x: number, y: number): Pt {
    const { w, h } = sizeOf()
    const mx = Math.max(0, ((s - 1) * w) / 2)
    const my = Math.max(0, ((s - 1) * h) / 2)
    return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) }
  }

  /**
   * 求「锚点下的图像内容不漂移」所需的 translate。
   *
   * 以中心为原点缩放时，屏幕相对中心的坐标满足 `s * p + t`（p 为图像点）。
   * 令起始锚点 a0 与当前锚点 a1 对应同一图像点，则
   *   a1 = s1 * p + t1，p = (a0 - t0) / s0
   * 代入得 t1 = (a1 - C) - (s1 / s0) * ((a0 - C) - t0)
   */
  function translateFor(a0: Pt, a1: Pt, s0: number, t0: Pt, s1: number): Pt {
    const k = s1 / s0
    const ax = a0.x - center.x
    const ay = a0.y - center.y
    return {
      x: a1.x - center.x - k * (ax - t0.x),
      y: a1.y - center.y - k * (ay - t0.y),
    }
  }

  function apply(s: number, t: Pt): void {
    const next = clampScale(s)
    const p = clampPan(next, t.x, t.y)
    scale.value = next
    tx.value = p.x
    ty.value = p.y
  }

  /** 元素未变换时的中心 —— rect 的几何中心等于「原中心 + 当前位移」 */
  function centerOf(): Pt {
    const el = target
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2 - tx.value, y: r.top + r.height / 2 - ty.value }
  }

  function distOf(a: Pt, b: Pt): number {
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  function midOf(pts: Pt[]): Pt {
    if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 }
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
  }

  function beginGesture(): void {
    const pts = [...pointers.values()]
    startScale = scale.value
    startTx = tx.value
    startTy = ty.value
    startMid = midOf(pts)
    startDist = pts.length > 1 ? distOf(pts[0], pts[1]) : 0
    center = centerOf()
  }

  function onPointerdown(e: PointerEvent): void {
    target = e.currentTarget as HTMLElement
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    // 未注册的 pointerId（合成事件、部分内嵌 WebView）会抛 NotFoundError，
    // 捕获失败不影响手势本身，只是手指移出元素后会断流，故降级而非中断
    try {
      target.setPointerCapture?.(e.pointerId)
    } catch {
      /* 忽略 */
    }

    if (pointers.size === 1) {
      startPoint = { x: e.clientX, y: e.clientY }
      moved = false
      animating.value = false
    } else {
      // 第二指落下：以当前姿态重新起手，双指捏合与单指拖动无缝衔接
      animating.value = false
    }
    beginGesture()
  }

  function onPointermove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (Math.hypot(e.clientX - startPoint.x, e.clientY - startPoint.y) > TAP_SLOP) moved = true

    const pts = [...pointers.values()]

    if (pts.length >= 2) {
      if (startDist <= 0) return
      const s1 = clampScale((startScale * distOf(pts[0], pts[1])) / startDist)
      apply(s1, translateFor(startMid, midOf(pts), startScale, { x: startTx, y: startTy }, s1))
      return
    }

    // 未放大时单指不接管，交给页面滚动（touch-action: pan-y）
    if (!zoomed.value) return
    apply(startScale, translateFor(startMid, { x: e.clientX, y: e.clientY }, startScale, { x: startTx, y: startTy }, startScale))
  }

  function onPointerup(e: PointerEvent): void {
    const wasSingle = pointers.size === 1
    pointers.delete(e.pointerId)
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    } catch {
      /* 与 pointerdown 同理，未捕获成功时释放会抛错 */
    }

    if (pointers.size > 0) {
      // 还有手指在屏幕上：以剩余指针重新起手，避免画面跳变
      beginGesture()
      return
    }

    if (scale.value < 1 + REST_EPS) {
      animating.value = true
      apply(1, { x: 0, y: 0 })
    }

    if (!wasSingle || moved) return
    const now = Date.now()
    if (now - lastTapAt < DOUBLE_TAP_MS) {
      lastTapAt = 0
      toggleZoom(e.clientX, e.clientY)
    } else {
      lastTapAt = now
    }
  }

  function onPointercancel(e: PointerEvent): void {
    pointers.delete(e.pointerId)
    if (pointers.size) {
      beginGesture()
      return
    }
    if (scale.value < 1 + REST_EPS) {
      animating.value = true
      apply(1, { x: 0, y: 0 })
    }
    lastTapAt = 0
  }

  /** 双击：放大到 dblScale（以双击点为锚）或还原 */
  function toggleZoom(x: number, y: number): void {
    animating.value = true
    if (zoomed.value) {
      apply(1, { x: 0, y: 0 })
      return
    }
    center = centerOf()
    const at = { x, y }
    apply(dblScale, translateFor(at, at, scale.value, { x: tx.value, y: ty.value }, dblScale))
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    target = e.currentTarget as HTMLElement
    center = centerOf()
    animating.value = true
    const s1 = clampScale(scale.value * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP))
    if (s1 === 1) {
      apply(1, { x: 0, y: 0 })
      return
    }
    const at = { x: e.clientX, y: e.clientY }
    apply(s1, translateFor(at, at, scale.value, { x: tx.value, y: ty.value }, s1))
  }

  /** 换图 / 关闭弹层时复原 */
  function reset(): void {
    pointers.clear()
    animating.value = false
    lastTapAt = 0
    apply(1, { x: 0, y: 0 })
  }

  /**
   * 直接用于 `v-on="handlers"`。
   * 注意键名必须是事件名本身：Vue 的 toHandlers 会拼成 `on<Key>`，
   * 写成 `onPointerdown` 会得到 `onOnPointerdown`，监听器静默失效。
   */
  const handlers = {
    pointerdown: onPointerdown,
    pointermove: onPointermove,
    pointerup: onPointerup,
    pointercancel: onPointercancel,
    wheel: onWheel,
    /** 长按图片会触发原生拖拽，和手势打架 */
    dragstart: (e: Event) => e.preventDefault(),
  }

  return { scale, zoomed, label, imgStyle, animating, handlers, reset }
}
