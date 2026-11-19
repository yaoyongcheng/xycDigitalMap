<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import type { MapAlarm, MapPoint } from '@/types'

/**
 * 交互地图层（新增组件，非原版内容）
 *
 * 把原本静态的 site-map 底图升级为可交互地图：
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
    /**
     * 设施撒点（监控/塔吊/楼栋）。2026-11 设计稿（gx2 换底图）起生产
     * 界面不再传 —— 底图上只保留报警点位；prop 保留供组件能力与
     * 单测复用，接后端后若恢复设施层可直接传回。
     */
    points?: MapPoint[]
    /** cover：铺满容器（裁切多余部分）；contain：完整容纳（留白） */
    fit?: 'cover' | 'contain'
    /**
     * 底图地址，默认取 PWA base 下的 site-map.webp。
     *
     * 2026-11-18：内置兜底图不再用迁移前那张设计稿截图，改成用接口 3D 图
     * 同源导出的 1280×720 快照（原因见下方 natW/natH 的注释）。版本号必须
     * 跟着换图一起改，同名文件会被浏览器缓存住。
     */
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
    /**
     * 挂起：不再观测容器尺寸、不再响应手势。
     *
     * 全项目存在两个常驻实例（首页小地图 + 横屏全屏地图），原先两者都在跑
     * ResizeObserver —— 而未打开的那个容器尺寸恒为 0，观测纯属白烧，且其
     * 回调里的 clampPan 还会参与响应式计算。调用方应让二者互斥挂起，
     * 保证任一时刻只有一个实例活跃。
     */
    suspended?: boolean
    /**
     * 报警撒点（2026-10 版本同步 · 第二批）。
     *
     * 与 points 分开传：报警点是「内容」而不是「设施」，视觉、点击去向
     * 都不同（见 types.ts 的 MapAlarm 说明）。坐标同样是底图百分比，
     * 因此跟着画布一起缩放平移，不需要调用方再做 cover 换算 ——
     * 原版把撒点放在容器尺寸的绝对层里，才不得不写 homeSpot() 去补
     * cover 裁切的偏移。
     */
    alarms?: MapAlarm[]
  }>(),
  {
    points: () => [],
    fit: 'cover',
    src: `${import.meta.env.BASE_URL}img/site-map.webp?v=20261118`,
    compact: false,
    allowZoomOut: false,
    suspended: false,
    alarms: () => [],
  },
)

const emit = defineEmits<{ select: [p: MapPoint]; alarm: [id: string] }>()

const boxEl = ref<HTMLElement | null>(null)

/**
 * 底图自然尺寸，onload 后校准。
 *
 * 默认值必须与**两张**底图同比例：接口图是 1920×1080（16:9），内置兜底图
 * 2026-11-18 起也按同一张源图导出成 1280×720（同为 16:9，见 public/img）。
 *
 * ⚠️ 这一条是「刷新后视角不偏移」的关键。以前默认值是旧的 1024×642
 * （16:10），而接口图是 16:9：cover 在同一个容器里会按不同方向裁切
 * （一个裁上下、一个裁左右），首屏先按旧比例排一帧、图到了再按新比例重排，
 * 用户看到的就是「刷新时画面偏了一下 / 角度变了」。
 */
const natW = ref(1280)
const natH = ref(720)

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

/**
 * 手势期间锁定的容器矩形。
 *
 * 手势进行中容器在屏幕上不会移动，矩形只需在 pointerdown 时取一次。
 * 原先 onPointerMove 每次触发都 getBoundingClientRect() —— 配合随后写入
 * tx/ty，每一枚 pointermove 都会触发「读布局 → 写样式」的强制同步；捏合时
 * 一轮可达 3~5 次，是首页拖拽最先被感知到的掉帧来源。
 * 非手势期（滚轮 / 双击）保持 null，走实时读取即可，那两种事件本就是离散的。
 */
let gestureRect: DOMRect | null = null

/** 容器内坐标（相对容器中心） */
function relPos(clientX: number, clientY: number): { x: number; y: number } {
  const r = gestureRect ?? boxEl.value?.getBoundingClientRect()
  if (!r) return { x: 0, y: 0 }
  return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 }
}

function pairDist(): { dist: number; midX: number; midY: number } | null {
  const [a, b] = [...pointers.values()]
  if (!a || !b || !gestureRect) return null
  const r = gestureRect
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    midX: (a.x + b.x) / 2 - r.left - r.width / 2,
    midY: (a.y + b.y) / 2 - r.top - r.height / 2,
  }
}

/**
 * 位移结算合并到每帧一次。
 *
 * 触屏一次刷新可能派发多枚 pointermove，逐枚写 tx/ty/scale 会触发多轮
 * 渲染调度。这里 pointermove 只更新坐标快照，真正的计算交给 rAF 回调
 * （回调读取的始终是最新的快照，故不丢位移）。
 */
let rafId = 0

function scheduleMove(): void {
  if (rafId) return
  rafId = window.requestAnimationFrame(applyMove)
}

function cancelMove(): void {
  if (!rafId) return
  window.cancelAnimationFrame(rafId)
  rafId = 0
}

function onPointerDown(e: PointerEvent): void {
  if (props.suspended) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  // 手势起点：锁定矩形，后续 move 全部复用它
  gestureRect = boxEl.value?.getBoundingClientRect() ?? null
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
  scheduleMove()
}

/** 每帧结算一次：按最新指针快照算出 tx / ty / scale */
function applyMove(): void {
  rafId = 0

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
    const [cur] = [...pointers.values()]
    if (!cur) return
    const p = relPos(cur.x, cur.y)
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
    cancelMove()
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    panStart = null
    gestureRect = null
    if (movedFar) {
      // 拖拽后的合成 click 不应触发点位跳转；50ms 兜底清除防止误锁
      suppressClick = true
      window.setTimeout(() => {
        suppressClick = false
      }, 50)
    }
  } else if (pointers.size === 1) {
    // 双指抬起一指：切换回单指拖拽基准，避免画面跳变
    cancelMove()
    const [rest] = [...pointers.values()]
    if (rest) {
      const p = relPos(rest.x, rest.y)
      panStart = { x: p.x, y: p.y, tx: tx.value, ty: ty.value }
    }
  }
}

function onWheel(e: WheelEvent): void {
  if (props.suspended) return
  e.preventDefault()
  const p = relPos(e.clientX, e.clientY)
  zoomAt(p.x, p.y, scale.value * (e.deltaY < 0 ? 1.16 : 1 / 1.16))
}

function onDblClick(e: MouseEvent): void {
  if (props.suspended) return
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

/** 报警点与设施点的「拖拽后不触发点击」共用同一个抑制标记 */
function onAlarmClick(id: string): void {
  if (suppressClick) {
    suppressClick = false
    return
  }
  emit('alarm', id)
}

/**
 * 报警标签是否翻到点的左侧。
 *
 * 数据里的 left 只是设计稿在**横屏取景**下的意图：同一组百分比坐标，
 * 在手机上全屏竖屏（cover 裁掉两侧）会落到完全不同的屏幕位置 ——
 * 照搬数据会出现「左边那条标签顶出屏幕只剩半个字，右边那条被裁掉一截」。
 *
 * 所以按当前实际位置判断：右边放不下、左边放得下就翻；左边也放不下
 * （点在屏幕左缘）就保持向右，宁可右边溢出一点也不要整条看不见。
 * 药丸宽度按字号与字数估算 —— 实测 4 字 × 11px + 24 = 68px，与 DOM 量到的一致。
 */
function flipLeft(a: MapAlarm): boolean {
  if (!boxW.value) return Boolean(a.left)
  const fs = props.compact ? 10 : 11
  const w = a.title.length * fs + (props.compact ? 20 : 24)
  const cx = (a.x / 100) * canvasW.value + (boxW.value - canvasW.value) / 2 + tx.value
  if (cx + w > boxW.value && cx - w >= 0) return true
  if (cx - w < 0) return false
  return Boolean(a.left)
}

function onImgLoad(e: Event): void {
  const img = e.target as HTMLImageElement
  // 只有前景层的尺寸代表「当前正在显示的这张」；背层预挂的图不参与，
  // 否则换图瞬间旧层的 load 会把 natW/natH 又写回去
  if (!img.classList.contains('is-front')) return
  if (img.naturalWidth > 0) {
    natW.value = img.naturalWidth
    natH.value = img.naturalHeight
  }
}

/* ---------------- 底图双缓冲（换图不闪） ---------------- */

interface BaseLayer {
  /** 该层承载的地址，空串表示空闲 */
  src: string
  /** 是否前景（唯一可见、真正在出像素的那层） */
  on: boolean
}

/**
 * 换底图为什么要两层。
 *
 * 直接改同一个 `<img>` 的 `src`，浏览器在新图解出像素之前会先呈现一帧空白
 * （移动端尤其明显）—— 用户看到的就是「闪一下黑」「闪一下旧图又跳回来」。
 * 所以画布里叠两张图交替承载：
 *   1. 新图先挂到背层（opacity 0），此时画面仍是旧图，什么都不闪；
 *   2. 等它真的 load（像素可渲染，顺带拿到自然尺寸）再把前景换过去；
 *   3. 旧层淡出后清空 src，别让两张 1920×1080 的解码位图同时占内存。
 *
 * 两个使用方都受益：全屏地图的二维/三维切换，以及首页从内置兜底图切到
 * 接口图那一下。
 */
const layers = ref<BaseLayer[]>([{ src: props.src, on: true }, { src: '', on: false }])
/** 前景层下标（0 / 1） */
let front = 0
/** 换图序号：连续切换时只有最后一次生效，慢请求不会把旧图挂回来 */
let swapSeq = 0

/** 淡出时长，与 CSS 里 `.map-base` 的 transition 保持一致 */
const FADE_MS = 200

interface ImgDim {
  w: number
  h: number
}

/**
 * 预加载一张图，返回自然尺寸。
 *
 * 无论成功、失败还是超时都会落地：失败给 `{w:0,h:0}`，调用方沿用原尺寸
 * （破图本身有 onerror 兜底，不该让切换卡死在「加载中」）。
 */
function preloadSize(src: string): Promise<ImgDim> {
  const Ctor = (globalThis as { Image?: typeof Image }).Image
  if (typeof Ctor !== 'function') return Promise.resolve({ w: 0, h: 0 })
  return new Promise<ImgDim>((resolve) => {
    let done = false
    const im = new Ctor()
    const fin = (): void => {
      if (done) return
      done = true
      resolve({ w: im.naturalWidth || 0, h: im.naturalHeight || 0 })
    }
    im.onload = fin
    im.onerror = fin
    im.src = src
    if (im.complete) fin()
    // 已缓存的图（本地 webp / 刚下完的 objectURL）会立刻 complete；
    // 600ms 还没落地就按「拿不到尺寸」处理，宁可沿用原尺寸也要把图换上去
    window.setTimeout(fin, 600)
  })
}

/* ---------------- 生命周期 ---------------- */

let ro: ResizeObserver | null = null

/** 挂起期间不再观测容器：尺寸恒为 0 的隐藏实例无需维持布局计算 */
function stopObserving(): void {
  ro?.disconnect()
}

/** 恢复观测。ResizeObserver 在 observe 时会立刻回调一次，尺寸自动校准回来 */
function startObserving(): void {
  const el = boxEl.value
  if (!el || !ro) return
  ro.observe(el)
}

onMounted(() => {
  const el = boxEl.value
  if (!el) return
  ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect()
    boxW.value = r.width
    boxH.value = r.height
    clampPan()
  })
  if (!props.suspended) startObserving()
  // wheel 需要 preventDefault，显式注册为非 passive
  el.addEventListener('wheel', onWheel, { passive: false })
})

watch(
  () => props.suspended,
  (s) => (s ? stopObserving() : startObserving()),
)

/**
 * 换底图（二维 / 三维切换）：新图就绪才上屏，旧图淡出。
 *
 * 顺带解决一个老问题：两张底图比例不同（内置图 1024×642 / 接口图
 * 1920×1080），画布尺寸一变，原先合法的 tx/ty 就可能把画布拖出容器外。
 * 所以自然尺寸与钳制都在**切换的同一帧**里做完，不会出现「先按旧比例
 * 拉一帧、再跳成新比例」。缩放倍率保留：用户切图后仍处在相同的相对
 * 缩放级别，不会「突然回到 1x」。
 */
watch(
  () => props.src,
  (next) => {
    if (!next) return
    const backIdx = 1 - front
    const cur = layers.value[front]
    // 目标就是当前正在显示的那张（来回切、或 store 换了同一地址）：不动画面
    if (cur && cur.src === next) return

    const back = layers.value[backIdx]
    // 背层恰好已经是这张（上次刚淡出的那张）：省掉预加载，直接换回去
    const cached = Boolean(back && back.src === next)
    if (back) {
      back.src = next
      back.on = false
    }

    const my = ++swapSeq
    const ready = cached ? Promise.resolve<ImgDim>({ w: 0, h: 0 }) : preloadSize(next)
    void ready.then((dim) => {
      // 期间又切了别的图 / 关掉地图：这次作废，绝不把过期的一张挂上屏
      if (my !== swapSeq) return
      const b = layers.value[backIdx]
      const c = layers.value[front]
      if (!b || b.src !== next) return

      if (dim.w && dim.h && (dim.w !== natW.value || dim.h !== natH.value)) {
        natW.value = dim.w
        natH.value = dim.h
        clampPan()
      }
      b.on = true
      if (c) c.on = false
      front = backIdx

      // 淡出结束后释放旧层：两张图同时留着解码位图，手机上等于翻倍占用
      window.setTimeout(() => {
        if (my !== swapSeq) return
        const old = layers.value[1 - front]
        if (old && !old.on) old.src = ''
      }, FADE_MS + 80)
    })
  },
)

onUnmounted(() => {
  cancelMove()
  ro?.disconnect()
  boxEl.value?.removeEventListener('wheel', onWheel)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
})

/**
 * 扎针图标（每个 kind 一组 path 的 d）。
 *
 * 原先存的是拼好的 `<path .../>` HTML 片段，模板里靠 v-html 注入 ——
 * 该 svg 位于 props.points 的 v-for 内（首页 + 全屏地图两处共约 24 枚），
 * 每一枚都要走一次 innerHTML 解析，拖拽重渲染时还会重复解析。
 * 改为纯 path 数据 + 模板直出，零解析、零 v-html。
 */
const PIN_PATHS: Record<MapPoint['kind'], string[]> = {
  cam: ['M4.5 8.2h10.2v9.2H4.5z', 'M14.7 11.2 19.5 8.8v8.2l-4.8-2.4z'],
  crane: ['M9 20V5l9-2v3l-6 1.4', 'M9 8h13', 'M18 8v3h2v3h-2z', 'M6 20h6'],
  building: ['M5 20V6l7-2.5V20', 'M12 8l7 2v10', 'M3.5 20h17'],
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
      <!--
        两层底图交替承载（见脚本里「底图双缓冲」）：同一时刻只有一层带
        .is-front 是可见的，换图时新层就绪后才把 is-front 交过去。
      -->
      <template v-for="(l, i) in layers" :key="i">
        <img
          v-if="l.src"
          class="map-base"
          :class="{ 'is-front': l.on }"
          :src="l.src"
          alt="工地数字地图"
          draggable="false"
          @load="onImgLoad"
        />
      </template>
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
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path v-for="(d, i) in PIN_PATHS[p.kind]" :key="i" :d="d" />
            </svg>
          </i>
          <span class="pin-name">{{ p.name }}</span>
        </span>
      </button>

      <!--
        报警撒点：锚在坐标上，标签向右展开（靠近右边界时翻到左侧）。
        层级比设施点高一级：预警是当下要处理的事，不该被设施图标压住。
      -->
      <button
        v-for="a in props.alarms"
        :key="a.id"
        class="alarm-pin"
        :class="{ 'is-left': flipLeft(a) }"
        type="button"
        :style="{ left: a.x + '%', top: a.y + '%' }"
        :aria-label="a.title"
        @click="onAlarmClick(a.id)"
      >
        <i aria-hidden="true"></i><b>{{ a.title }}</b>
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
