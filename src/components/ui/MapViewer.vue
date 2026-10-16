<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import type { MapPoint } from '@/types'

/**
 * 交互地图层（新增组件，非原版内容）
 *
 * 把原本静态的 site-map.jpg 升级为可交互地图：
 *   - 单指拖拽平移、双指捏合缩放、滚轮缩放、双击在 1x/2.4x 间切换
 *   - 点位撒点（摄像头/塔吊/楼栋），点击经 select 事件上抛
 *   - 点位为恒定屏幕尺寸（px），坐标以底图百分比标定；小容器可传
 *     compact 走更小的一套针标样式
 *
 * 几何模型：
 *   底图按 fit 模式（cover/contain）算出基准缩放 fitScale，用户缩放 scale
 *   是相对它的倍率（1~4）。画布（.map-canvas）尺寸 = 底图自然尺寸 ×
 *   fitScale × scale，居中后叠加平移量 tx/ty，平移被钳制在「画布始终
 *   覆盖/不脱离容器」的区间内。
 *
 * 手势不采用 pointer capture（捕获会把后续事件重定向到容器，点位的
 * click 将永远收不到），改为 pointerdown 后把 move/up 挂到 window，
 * 手势结束再摘除。
 */
const props = withDefaults(
  defineProps<{
    points: MapPoint[]
    /** cover：铺满容器（裁切多余部分）；contain：完整容纳（留白） */
    fit?: 'cover' | 'contain'
    /** 底图地址，默认取 PWA base 下的 site-map.jpg */
    src?: string
    /**
     * 紧凑模式：小容器（首页顶部地图区）用更小的针标与字号，
     * 避免撒点在视觉上喧宾夺主。尺寸差异全部收在 app.css 的
     * .map-viewer.is-compact 规则里，本组件只负责挂 class。
     */
    compact?: boolean
    /**
     * 允许缩小到 1x 以下：全屏大屏场景下，1x（cover 铺满）的图幅
     * 已经很大，下限放开到「完整容纳整图再留 8% 边距」，
     * 用户可以先总览全场再放大看局部。
     */
    allowZoomOut?: boolean
  }>(),
  {
    fit: 'cover',
    src: `${import.meta.env.BASE_URL}img/site-map.jpg`,
    compact: false,
    allowZoomOut: false,
  },
)

const emit = defineEmits<{ select: [p: MapPoint] }>()

const boxEl = ref<HTMLElement | null>(null)

/** 底图自然尺寸，onload 后校准（默认值与 site-map.jpg 一致） */
const natW = ref(1024)
const natH = ref(735)

/** 容器尺寸（ResizeObserver 维护） */
const boxW = ref(0)
const boxH = ref(0)

/** 用户缩放倍率（相对 fitScale）与平移量（px，相对容器中心） */
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)

const MAX_ZOOM = 4

/**
 * 缩放下限。默认 1（fit 尺寸即最小）；allowZoomOut 时放开到
 * contain/cover 的比值再乘 0.92 —— 即「整图完整可见 + 四周 8% 留白」。
 * 例：横屏全屏下 cover/contain ≈ 1.5 时，下限约 0.61。
 */
const minZoom = computed(() => {
  if (!props.allowZoomOut || !boxW.value || !boxH.value) return 1
  const sx = boxW.value / natW.value
  const sy = boxH.value / natH.value
  const contain = Math.min(sx, sy)
  const cover = Math.max(sx, sy)
  return Math.min(1, (contain / cover) * 0.92)
})

const fitScale = computed(() => {
  if (!boxW.value || !boxH.value) return 1
  const sx = boxW.value / natW.value
  const sy = boxH.value / natH.value
  return props.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)
})

/** 当前显示倍率（底图像素 → 屏幕像素） */
const dispScale = computed(() => fitScale.value * scale.value)

const canvasW = computed(() => natW.value * dispScale.value)
const canvasH = computed(() => natH.value * dispScale.value)

const canvasStyle = computed(() => ({
  width: canvasW.value + 'px',
  height: canvasH.value + 'px',
  left: (boxW.value - canvasW.value) / 2 + tx.value + 'px',
  top: (boxH.value - canvasH.value) / 2 + ty.value + 'px',
}))

/**
 * 点位尺寸说明：
 * 画布用 px 尺寸直接布局（无 transform 缩放），撒点天然保持恒定屏幕
 * 尺寸，无需反比补偿 —— 曾按「transform 缩放」模型加过 1/dispScale
 * 补偿，实际效果是把针标放大了 1/fitScale 倍（首页小容器下 ~2.1x），
 * 已移除。大小差异统一交给 .is-compact 的 CSS 规则。
 */
const canReset = computed(
  () => scale.value > 1.01 || scale.value < 0.99 || tx.value !== 0 || ty.value !== 0,
)

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 平移钳制：画布不得离开容器边缘（contain 初始小于容器时钳到 0） */
function clampPan(): void {
  const mx = Math.max(0, (canvasW.value - boxW.value) / 2)
  const my = Math.max(0, (canvasH.value - boxH.value) / 2)
  tx.value = clamp(tx.value, -mx, mx)
  ty.value = clamp(ty.value, -my, my)
}

/**
 * 以容器内某点为锚缩放（px/py 相对容器中心）。
 * 保持锚点下的画布内容在缩放前后处于同一屏幕位置。
 */
function zoomAt(px: number, py: number, next: number): void {
  const ns = clamp(next, minZoom.value, MAX_ZOOM)
  if (ns === scale.value) return
  const k = ns / scale.value
  tx.value = px - (px - tx.value) * k
  ty.value = py - (py - ty.value) * k
  scale.value = ns
  clampPan()
}

function zoomBy(factor: number): void {
  zoomAt(0, 0, scale.value * factor)
}

function reset(): void {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

/* ---------------- 手势 ---------------- */

const pointers = new Map<number, { x: number; y: number }>()

interface PanStart {
  x: number
  y: number
  tx: number
  ty: number
}
interface PinchStart {
  dist: number
  scale: number
  midX: number
  midY: number
  tx: number
  ty: number
}

let panStart: PanStart | null = null
let pinchStart: PinchStart | null = null
let movedFar = false
let suppressClick = false

/** 容器内坐标（相对容器中心） */
function relPos(clientX: number, clientY: number): { x: number; y: number } {
  const r = boxEl.value?.getBoundingClientRect()
  if (!r) return { x: 0, y: 0 }
  return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 }
}

function pairDist(): { dist: number; midX: number; midY: number } | null {
  const [a, b] = [...pointers.values()]
  if (!a || !b) return null
  const r = boxEl.value?.getBoundingClientRect()
  if (!r) return null
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    midX: (a.x + b.x) / 2 - r.left - r.width / 2,
    midY: (a.y + b.y) / 2 - r.top - r.height / 2,
  }
}

function onPointerDown(e: PointerEvent): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  movedFar = false
  if (pointers.size === 1) {
    const p = relPos(e.clientX, e.clientY)
    panStart = { x: p.x, y: p.y, tx: tx.value, ty: ty.value }
    pinchStart = null
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  } else if (pointers.size === 2) {
    const m = pairDist()
    if (m) {
      panStart = null
      pinchStart = { dist: m.dist, scale: scale.value, midX: m.midX, midY: m.midY, tx: tx.value, ty: ty.value }
    }
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

  if (pinchStart && pointers.size === 2) {
    const m = pairDist()
    if (!m || pinchStart.dist <= 0) return
    if (Math.abs(m.dist - pinchStart.dist) > 4) movedFar = true
    const ns = clamp((pinchStart.scale * m.dist) / pinchStart.dist, minZoom.value, MAX_ZOOM)
    const k = ns / pinchStart.scale
    // 以当前双指中点为锚，从捏合起始快照推算平移
    tx.value = m.midX - (pinchStart.midX - pinchStart.tx) * k
    ty.value = m.midY - (pinchStart.midY - pinchStart.ty) * k
    scale.value = ns
    clampPan()
    return
  }

  if (panStart && pointers.size === 1) {
    const p = relPos(e.clientX, e.clientY)
    const dx = p.x - panStart.x
    const dy = p.y - panStart.y
    if (Math.hypot(dx, dy) > 6) movedFar = true
    tx.value = panStart.tx + dx
    ty.value = panStart.ty + dy
    clampPan()
  }
}

function onPointerUp(e: PointerEvent): void {
  pointers.delete(e.pointerId)
  if (pointers.size < 2) pinchStart = null
  if (pointers.size === 0) {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    panStart = null
    if (movedFar) {
      // 拖拽后的合成 click 不应触发点位跳转；50ms 兜底清除防止误锁
      suppressClick = true
      window.setTimeout(() => {
        suppressClick = false
      }, 50)
    }
  } else if (pointers.size === 1) {
    // 双指抬起一指：切换回单指拖拽基准，避免画面跳变
    const [rest] = [...pointers.values()]
    if (rest) {
      const p = relPos(rest.x, rest.y)
      panStart = { x: p.x, y: p.y, tx: tx.value, ty: ty.value }
    }
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const p = relPos(e.clientX, e.clientY)
  zoomAt(p.x, p.y, scale.value * (e.deltaY < 0 ? 1.16 : 1 / 1.16))
}

function onDblClick(e: MouseEvent): void {
  const p = relPos(e.clientX, e.clientY)
  if (scale.value > 1.01) reset()
  // 总览态（<1x）下双击先回到 1x 铺满，避免 0.6x → 2.4x 的跳变
  else if (scale.value < 0.99) zoomAt(p.x, p.y, 1)
  else zoomAt(p.x, p.y, 2.4)
}

function onPinClick(p: MapPoint): void {
  if (suppressClick) {
    suppressClick = false
    return
  }
  emit('select', p)
}

function onImgLoad(e: Event): void {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth > 0) {
    natW.value = img.naturalWidth
    natH.value = img.naturalHeight
  }
}

/* ---------------- 生命周期 ---------------- */

let ro: ResizeObserver | null = null

onMounted(() => {
  const el = boxEl.value
  if (!el) return
  ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect()
    boxW.value = r.width
    boxH.value = r.height
    clampPan()
  })
  ro.observe(el)
  // wheel 需要 preventDefault，显式注册为非 passive
  el.addEventListener('wheel', onWheel, { passive: false })
})

onUnmounted(() => {
  ro?.disconnect()
  boxEl.value?.removeEventListener('wheel', onWheel)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
})

const pinIcons: Record<MapPoint['kind'], string> = {
  cam: '<path d="M4.5 8.2h10.2v9.2H4.5z"/><path d="M14.7 11.2 19.5 8.8v8.2l-4.8-2.4z"/>',
  crane:
    '<path d="M9 20V5l9-2v3l-6 1.4"/><path d="M9 8h13"/><path d="M18 8v3h2v3h-2z"/><path d="M6 20h6"/>',
  building: '<path d="M5 20V6l7-2.5V20"/><path d="M12 8l7 2v10"/><path d="M3.5 20h17"/>',
}
</script>

<template>
  <div
    ref="boxEl"
    class="map-viewer"
    :class="{ 'is-compact': props.compact }"
    @pointerdown="onPointerDown"
    @dblclick="onDblClick"
  >
    <div class="map-canvas" :style="canvasStyle">
      <img :src="props.src" alt="工地数字地图" draggable="false" @load="onImgLoad" />
      <button
        v-for="p in props.points"
        :key="p.id"
        class="map-pin"
        :class="p.kind"
        type="button"
        :style="{ left: p.x + '%', top: p.y + '%' }"
        :aria-label="p.name"
        @click="onPinClick(p)"
      >
        <span class="pin-body">
          <i class="pin-dot">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" v-html="pinIcons[p.kind]" />
          </i>
          <span class="pin-name">{{ p.name }}</span>
        </span>
      </button>
    </div>

    <div class="map-ctrls">
      <button type="button" aria-label="放大" @click="zoomBy(1.4)">+</button>
      <button type="button" aria-label="缩小" @click="zoomBy(1 / 1.4)">−</button>
      <!-- 总览：一键缩到整图完整可见（allowZoomOut 场景才有意义） -->
      <button
        v-if="props.allowZoomOut && scale > minZoom + 0.01"
        type="button"
        class="map-ctrl-reset"
        @click="zoomAt(0, 0, minZoom)"
      >
        总览
      </button>
      <button v-if="canReset" type="button" class="map-ctrl-reset" @click="reset">复位</button>
    </div>
  </div>
</template>
