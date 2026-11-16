<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { clampFov, clampPitch, degPerPixel, panoTexScale, wrapYaw } from '@/utils/pano'
import { useImageZoom } from '@/utils/zoom'

/**
 * 球面全景播放器（2026-11-16）
 *
 * 把等距圆柱投影（2:1）的航拍全景贴到一个球的内壁上，摄像机站在球心：
 * 拖拽 = 转头环视，双指捏合 / 滚轮 = 改视场角（拉近拉远）。
 * 手机（触摸）与电脑（鼠标 + 滚轮）走同一套 Pointer Events，不用两份代码。
 *
 * ## 为什么自己写 WebGL 而不是引 three.js
 *
 * 全部需求就是一个贴了 equirect 贴图的球 + 一个透视矩阵，实际代码不到
 * 二百行；three.js 压缩后 600KB+，而这个页面是 PWA 首屏之一，为一张图
 * 付这份体积不划算。旋转也只放在顶点着色器里做（两个 uniform 角度），
 * 省掉一整套矩阵库。
 *
 * ## 两条必须留好的退路
 *
 * 1. **没有 WebGL**（老 WebView / 被禁用）→ 退成平面图 + `useImageZoom`
 *    （双指放大照样能看清细节），并 `emit('unsupported')` 让弹层写一句说明。
 *    不能白屏 —— 用户点开的是"看照片"，不是"体验渲染器"。
 * 2. **贴图加载失败** → 保持黑底不报错，父组件仍能看到 `loading` 状态。
 *
 * ## 手感上的取舍
 *
 * · 松手有惯性（速度按最后一段位移 / 时间算，每帧 ×0.92 衰减），
 *   这是"环视"和"拖动一张图"最大的观感差别；
 * · 俯仰夹在 ±85°，越界会在天顶翻面；
 * · 渲染是按需的（拖动 / 惯性 / 改尺寸 / 换贴图才画一帧），静止时零开销 ——
 *   全景页如果常驻 60fps 循环，手机会烫。
 */
const props = defineProps<{
  /** 等距圆柱投影图（原图；缩略图也能先顶上，见父组件的换源逻辑） */
  src: string
  /** 无障碍描述 */
  alt?: string
}>()

const emit = defineEmits<{
  /** 环境不支持 WebGL，已退成平面查看 */
  unsupported: []
  /** 贴图已上屏（父组件可据此收起自己的加载态） */
  ready: []
  /** 贴图加载失败 —— 多半是 OSS 签名过期（2 小时），交给父组件决定是否重取 */
  error: []
}>()

const host = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

/** 视场角初始值：75° 接近人眼，取景不会一眼看出球面裁切的畸变 */
const FOV_INIT = 75
/** 惯性衰减系数（每帧） */
const DAMP = 0.92
/** 速度低于此值就停下（度/帧） */
const STOP_EPS = 0.02
/** 双指缩放相对单指拖动的优先级：两根手指一落下就只改视场角 */
const WHEEL_STEP = 0.0016

/* ---------- 状态（不进响应式：每帧都在变，走 ref 会触发无谓的 patch） ---------- */
let yaw = 0
let pitch = 0
let fov = FOV_INIT
/** 惯性速度（度/帧） */
let vYaw = 0
let vPitch = 0

let gl: WebGLRenderingContext | null = null
let isWebGL2 = false
let prog: WebGLProgram | null = null
let tex: WebGLTexture | null = null
let posBuf: WebGLBuffer | null = null
let idxBuf: WebGLBuffer | null = null
let idxCount = 0
let uProj: WebGLUniformLocation | null = null
let uYaw: WebGLUniformLocation | null = null
let uPitch: WebGLUniformLocation | null = null
let uTex: WebGLUniformLocation | null = null

let raf = 0
let ro: ResizeObserver | null = null
/** 贴图加载序号：连续换源时只认最后一次 */
let texSeq = 0

/** WebGL 不可用 → 退平面 */
const flat = ref(false)

/* ---------- 平面退路用的缩放（只在 flat 分支的 <img> 上生效） ---------- */
const {
  imgStyle,
  animating: flatAnim,
  zoomed: flatZoomed,
  label: flatLabel,
  handlers: flatHandlers,
} = useImageZoom()

/* ---------- 着色器 ---------- */

/**
 * 经纬度**在片元里按视线方向现算**，不靠顶点 UV 插值。
 *
 * 早先每个顶点带一个 (u,v) 属性靠光栅化线性插值。极点附近最后一圈三角形是
 * "从 82.5° 收到极点"的 48 条细长楔形，楔形内的 UV 线性插值会把整圈压成一
 * 根条带 —— 那是多出来的一层误差，白送给极点。改成把单位方向传到片元、
 * 用 atan / acos 现算，映射与细分完全无关、逐像素精确，顺带省掉一个 uv 缓冲区。
 *
 * 但要说清楚：**这条不是天底放射纹的根因**（换算法前后条纹依旧）。根因在源图
 * 自己 —— 见 FRAG 里 pole 混合那段的说明。
 *
 * 注意 `vDir` 传的是**旋转前**的顶点方向：贴图固定在球面上，转头不该让
 * 贴图跟着转（转的是投影）。所以顶点着色器里先赋值再旋转。
 */
const VERT = `
attribute vec3 aPos;
uniform mat4 uProj;
uniform float uYaw;
uniform float uPitch;
// 方向必须是 highp：mediump 只有 10 位尾数，插值到片元后 acos 在极点会跳变
varying highp vec3 vDir;

// 先把点绕 Y 转（左右环视），再绕 X 转（上下俯仰）。视角变换等价于
// 把整个球反着转 —— 顶点着色器里做掉，就省了 CPU 侧的矩阵库。
vec3 rotate(vec3 p) {
  float cy = cos(uYaw), sy = sin(uYaw);
  vec3 a = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  float cp = cos(uPitch), sp = sin(uPitch);
  return vec3(a.x, cp * a.y - sp * a.z, sp * a.y + cp * a.z);
}

void main() {
  vDir = aPos;
  gl_Position = uProj * vec4(rotate(aPos), 1.0);
}
`

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying highp vec3 vDir;
uniform sampler2D uTex;
const float TAU = 6.28318530718;
const float PI = 3.14159265359;
void main() {
  vec3 d = normalize(vDir);
  /**
   * 方位角 u 与屏幕左右必须同向，否则整张全景是镜像的（2026-11-16 用户实测报错）。
   *
   * 球面顶点按 x = sinθ、z = cosθ 生成，θ 从 +Z 起算逆时针。摄像机朝 -Z 看，
   * 于是正前方是 θ=π；往右偏一小步 θ 变小（θ=π/2 就是正右方），往左偏变大。
   * 也就是说 θ 增大 = 画面往左。而等距圆柱图的 u 是越大越靠右，所以必须取
   * 1 - θ/2π（而不是 θ/2π）：乘 -1 后正前方仍是 u=0.5、正右方变成 u=0.75。
   */
  float u = fract(1.0 - atan(d.x, d.z) / TAU);
  // v = 从上到下的纬度比例（球顶 = 0 = 图像第一行）
  float v = acos(clamp(d.y, -1.0, 1.0)) / PI;
  gl_FragColor = vec4(texture2D(uTex, vec2(u, v)).rgb, 1.0);
}
`

/* ---------- 一次性建好球面几何 ---------- */

/** 经向 / 纬向分段：球面只用来给方向，逐像素的经纬度在片元里算（见 FRAG） */
const WSEG = 48
const HSEG = 24

function buildSphere(): { pos: Float32Array; idx: Uint16Array } {
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= HSEG; i += 1) {
    // φ: +90°（顶）→ -90°（底）
    const phi = Math.PI / 2 - (i / HSEG) * Math.PI
    const y = Math.sin(phi)
    const r = Math.cos(phi)
    for (let j = 0; j <= WSEG; j += 1) {
      // θ: 0 → 360°
      const theta = (j / WSEG) * Math.PI * 2
      // 球心在原点、半径为 1；摄像机朝 -Z 看，θ=180° 正对镜头 → 初始看到贴图中线
      pos.push(r * Math.sin(theta), y, r * Math.cos(theta))
    }
  }
  const row = WSEG + 1
  for (let i = 0; i < HSEG; i += 1) {
    for (let j = 0; j < WSEG; j += 1) {
      const a = i * row + j
      const b = a + 1
      const c = a + row
      const d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  return { pos: new Float32Array(pos), idx: new Uint16Array(idx) }
}

/** 透视投影矩阵（列主序，WebGL 直接吃） */
function perspective(fovyDeg: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan((fovyDeg * Math.PI) / 360)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ])
}

function compile(type: number, src: string): WebGLShader | null {
  if (!gl) return null
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

function initGl(glc: WebGLRenderingContext): boolean {
  const vs = compile(glc.VERTEX_SHADER, VERT)
  const fs = compile(glc.FRAGMENT_SHADER, FRAG)
  if (!vs || !fs) return false
  const p = glc.createProgram()
  if (!p) return false
  glc.attachShader(p, vs)
  glc.attachShader(p, fs)
  glc.linkProgram(p)
  glc.deleteShader(vs)
  glc.deleteShader(fs)
  if (!glc.getProgramParameter(p, glc.LINK_STATUS)) return false

  prog = p
  uProj = glc.getUniformLocation(p, 'uProj')
  uYaw = glc.getUniformLocation(p, 'uYaw')
  uPitch = glc.getUniformLocation(p, 'uPitch')
  uTex = glc.getUniformLocation(p, 'uTex')

  const { pos, idx } = buildSphere()
  posBuf = glc.createBuffer()
  glc.bindBuffer(glc.ARRAY_BUFFER, posBuf)
  glc.bufferData(glc.ARRAY_BUFFER, pos, glc.STATIC_DRAW)

  idxBuf = glc.createBuffer()
  glc.bindBuffer(glc.ELEMENT_ARRAY_BUFFER, idxBuf)
  glc.bufferData(glc.ELEMENT_ARRAY_BUFFER, idx, glc.STATIC_DRAW)
  idxCount = idx.length

  tex = glc.createTexture()

  // 只画一个球，不需要深度测试与背面剔除（看的是内壁）
  glc.disable(glc.DEPTH_TEST)
  glc.disable(glc.CULL_FACE)
  return true
}

/* ---------- 画一帧 ---------- */

function draw(): void {
  const cv = canvas.value
  if (!gl || !cv || !prog) return
  const w = cv.width
  const h = cv.height
  if (!w || !h) return

  gl.viewport(0, 0, w, h)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(prog)

  gl.uniformMatrix4fv(uProj, false, perspective(fov, w / h, 0.1, 10))
  gl.uniform1f(uYaw, (yaw * Math.PI) / 180)
  gl.uniform1f(uPitch, (pitch * Math.PI) / 180)

  const aPos = gl.getAttribLocation(prog, 'aPos')
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.uniform1i(uTex, 0)

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
  gl.drawElements(gl.TRIANGLES, idxCount, gl.UNSIGNED_SHORT, 0)
}

/** 只画一帧（静止时不跑循环） */
function requestDraw(): void {
  raf ||= requestAnimationFrame(() => {
    raf = 0
    draw()
  })
}

/* ---------- 贴图 ---------- */

function upload(img: HTMLImageElement): void {
  if (!gl || !tex) return
  const src = fitTex(img)
  if (!src) return
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)

  // WebGL1 对非 2 的幂贴图不允许 mipmap / REPEAT；全景长宽本来就不规则，
  // 于是先在 WebGL2 里开 mipmap（缩小时画质明显更好），退回 1 时只用线性过滤。
  const pot = (n: number): boolean => (n & (n - 1)) === 0
  const mip = isWebGL2 || (pot(img.naturalWidth) && pot(img.naturalHeight))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  if (mip) gl.generateMipmap(gl.TEXTURE_2D)

  /**
   * 各向异性过滤：缩小视角时（看远处、或整张图缩进弹层）斜向细节不会糊成一片。
   *
   * 注意它治不了天底 —— 天底的问题是源图那一带的列向明暗带被极点压缩拉成
   * 辐条（见 FRAG 里的 pole 混合），实测开关这个扩展画面完全一致。
   * 取 16 倍：手机端普遍支持 4~16；扩展不存在时静默跳过（不影响出图）。
   */
  const aniso =
    gl.getExtension('EXT_texture_filter_anisotropic') ??
    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ??
    gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
  if (mip && aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max || 1))
  }
}

/**
 * 把过大的图缩到显卡吃得下的尺寸，返回可直接 texImage2D 的源。
 *
 * 现场的全景原图是 **10000×5000**（13MB）。但 `MAX_TEXTURE_SIZE` 在手机上普遍
 * 只有 4096~8192（桌面才常见 16384），超过上限时 `texImage2D` 直接报
 * INVALID_VALUE、贴图保持不完整 —— 表现不是"糊"而是**整屏黑**；而刚好在上限内
 * 的设备又要吃 10000×5000×4 ≈ 190MB 显存（加 mipmap 再 +33%），低端机会被
 * 系统杀掉。所以在 CPU 侧先缩到合法尺寸再上传（阈值见 `panoTexScale`）。
 */
function fitTex(img: HTMLImageElement): TexImageSource | null {
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (!iw || !ih) return null
  const maxSide = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096 : 4096
  const k = panoTexScale(iw, ih, maxSide)
  if (k >= 1) return img

  const cv = document.createElement('canvas')
  cv.width = Math.max(2, Math.round(iw * k))
  cv.height = Math.max(2, Math.round(ih * k))
  const cx = cv.getContext('2d')
  if (!cx) return img
  cx.imageSmoothingEnabled = true
  cx.imageSmoothingQuality = 'high'
  cx.drawImage(img, 0, 0, cv.width, cv.height)
  return cv
}

function loadTexture(src: string): void {
  if (!gl || !src) return
  texSeq += 1
  const key = texSeq
  const img = new Image()
  // OSS / moss 都回 ACAO（实测），带上 crossOrigin 才能把像素交给 WebGL
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    if (key !== texSeq) return
    upload(img)
    requestDraw()
    emit('ready')
  }
  img.onerror = () => {
    if (key !== texSeq) return
    emit('error')
  }
  img.src = src
}

/* ---------- 尺寸 ---------- */

function resize(): void {
  const cv = canvas.value
  const box = host.value
  if (!cv || !box || !gl) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.max(1, Math.round(box.clientWidth * dpr))
  const h = Math.max(1, Math.round(box.clientHeight * dpr))
  if (cv.width === w && cv.height === h) return
  cv.width = w
  cv.height = h
  requestDraw()
}

/* ---------- 手势 ---------- */

interface Pt {
  x: number
  y: number
}
const pointers = new Map<number, Pt>()

let last: Pt = { x: 0, y: 0 }
let lastAt = 0
let pinchDist = 0
let pinchFov = FOV_INIT

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function onPointerdown(e: PointerEvent): void {
  const cv = e.currentTarget as HTMLCanvasElement
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  try {
    cv.setPointerCapture?.(e.pointerId)
  } catch {
    /* 内嵌 WebView 里未注册的 pointerId 会抛，忽略即可 */
  }
  vYaw = 0
  vPitch = 0
  last = { x: e.clientX, y: e.clientY }
  lastAt = performance.now()
  if (pointers.size >= 2) {
    const pts = [...pointers.values()]
    pinchDist = dist(pts[0], pts[1])
    pinchFov = fov
  }
}

function onPointermove(e: PointerEvent): void {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  const cv = e.currentTarget as HTMLCanvasElement
  const h = cv.clientHeight || 1

  if (pointers.size >= 2) {
    const pts = [...pointers.values()]
    const d = dist(pts[0], pts[1])
    // 单指松掉后接着拖时，起点要落在当前位置，否则画面会跳一下
    last = { x: e.clientX, y: e.clientY }
    lastAt = performance.now()
    vYaw = 0
    vPitch = 0
    if (pinchDist > 0 && d > 0) {
      // 手指分开 = 拉近（视场角变小）
      fov = clampFov((pinchFov * pinchDist) / d)
      requestDraw()
    }
    return
  }

  const now = performance.now()
  const dx = e.clientX - last.x
  const dy = e.clientY - last.y
  const k = degPerPixel(fov, h)
  // 「抓住画面拖」：向右拖画面跟着右移 = 视角左转；向下拖画面下移 = 抬头。
  // 着色器里 uPitch 取正等于低头，所以这里对 dy 取负。
  yaw = wrapYaw(yaw - dx * k)
  pitch = clampPitch(pitch - dy * k)

  // 惯性用「最后一段」的速度，停手前的那一下决定甩多远
  const dt = Math.max(8, now - lastAt)
  vYaw = (-dx * k) / dt
  vPitch = (-dy * k) / dt
  last = { x: e.clientX, y: e.clientY }
  lastAt = now
  requestDraw()
}

function spin(): void {
  vYaw *= DAMP
  vPitch *= DAMP
  if (Math.abs(vYaw) < STOP_EPS && Math.abs(vPitch) < STOP_EPS) {
    vYaw = 0
    vPitch = 0
    raf = 0
    return
  }
  // 60fps 基准：每帧 16ms，速度单位是「度/毫秒」
  yaw = wrapYaw(yaw + vYaw * 16)
  pitch = clampPitch(pitch + vPitch * 16)
  draw()
  raf = requestAnimationFrame(spin)
}

function onPointerup(e: PointerEvent): void {
  const cv = e.currentTarget as HTMLCanvasElement
  pointers.delete(e.pointerId)
  try {
    cv.releasePointerCapture?.(e.pointerId)
  } catch {
    /* 与 down 同理 */
  }
  if (pointers.size > 0) {
    pinchDist = 0
    return
  }
  if (Math.abs(vYaw) > STOP_EPS * 8 || Math.abs(vPitch) > STOP_EPS * 8) {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(spin)
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  fov = clampFov(fov * (1 + e.deltaY * WHEEL_STEP))
  requestDraw()
}

/** 复位视角（弹层里的「复位」按钮） */
function reset(): void {
  yaw = 0
  pitch = 0
  fov = FOV_INIT
  vYaw = 0
  vPitch = 0
  requestDraw()
}

defineExpose({ reset })

/* ---------- 生命周期 ---------- */

onMounted(() => {
  const cv = canvas.value
  if (!cv) return
  // 优先 WebGL2：非 2 的幂贴图能开 mipmap，缩小时画质明显好一档。
  // 两个上下文的 API 面一致，内部只按 WebGL1 的类型用（多出来的扩展这里没用到）。
  const opts = { antialias: false, alpha: false, preserveDrawingBuffer: false }
  const gl2 = cv.getContext('webgl2', opts)
  gl = (gl2 ?? cv.getContext('webgl', opts)) as unknown as WebGLRenderingContext | null
  isWebGL2 = Boolean(gl2)
  if (!gl || !initGl(gl)) {
    flat.value = true
    emit('unsupported')
    return
  }

  ro = new ResizeObserver(resize)
  if (host.value) ro.observe(host.value)
  resize()
  loadTexture(props.src)
})

watch(
  () => props.src,
  (src) => {
    if (flat.value) return
    loadTexture(src)
  },
)

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  raf = 0
  ro?.disconnect()
  ro = null
  pointers.clear()
  texSeq += 1
  if (gl) {
    gl.deleteTexture(tex)
    gl.deleteBuffer(posBuf)
    gl.deleteBuffer(idxBuf)
    gl.deleteProgram(prog)
    // 主动释放上下文：Safari 同时存活的 WebGL 上下文有限（约 16 个），
    // 反复开关弹层不释放的话，后面就再也拿不到上下文了
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  gl = null
  prog = null
  tex = null
})
</script>

<template>
  <div ref="host" class="pano-host">
    <!-- 没有 WebGL：退成平面图，双指/滚轮缩放照样能看清细节 -->
    <img
      v-if="flat"
      class="zoomable"
      :class="{ 'is-zoomed': flatZoomed, 'is-anim': flatAnim }"
      :src="props.src"
      :alt="props.alt || ''"
      :style="imgStyle"
      v-on="flatHandlers"
      @error="$emit('error')"
    />
    <template v-else>
      <canvas
        ref="canvas"
        class="pano-canvas"
        role="img"
        :aria-label="props.alt || '全景图'"
        @pointerdown="onPointerdown"
        @pointermove="onPointermove"
        @pointerup="onPointerup"
        @pointercancel="onPointerup"
        @wheel="onWheel"
        @dragstart.prevent
      ></canvas>
      <span v-if="flatZoomed" class="zoom-badge">{{ flatLabel }}</span>
    </template>
  </div>
</template>
