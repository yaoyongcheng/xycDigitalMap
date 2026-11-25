import { axisLabel, axisStep, type Bin } from '@/utils/craneReport'

/**
 * 作业报表的「导出分享」= 当前页面长图
 *
 * ## 为什么自绘 canvas，而不是截 DOM
 *
 * 项目没有 html2canvas 之类的依赖，也不该为一张报表引进一个 200KB 级的库
 * （PWA 要预缓存，现场带宽紧张）。而报表的内容是**结构化的**：6 格数字、
 * 3 张风险卡、3 张柱状图 —— 用 canvas 按同一套版式画一遍，
 * 得到的结果比截图更干净（没有滚动条、没有亚像素、不依赖当前字号），
 * 也不会因为某个卡片正在动画而截到半透明态。
 *
 * 版式与页面一一对应：头部（项目 + 报表名 + 区间 + 范围）→ 数据统计 →
 * 作业风险分析 → 分布可视化 → 页脚。宽度 750（2 倍像素密度的 375pt），
 * 高度按内容算，**没有裁切**：说明文字放不下就折行、卡片随之加高，
 * 数字太长就降一档字号，不允许出现「…」把现场要看的字吃掉。
 *
 * ## 三条交付路径（2026-11-25 补齐桌面与微信内）
 *
 * 1. `canShareFile()` 成立 → `navigator.share({ files })` 弹系统面板，
 *    iOS 选「存储图像」、安卓选「保存到相册」，**也能直接选微信**发给好友/群。
 *    这是手机系统浏览器与部分桌面的主路径。
 * 2. 不成立（桌面书签打开、浏览器无 Web Share）→ `downloadReportImage()`
 *    落成 PNG 文件，用户手里有图。
 * 3. 微信内置浏览器（`MicroMessenger`）：既没有分享面板，也不吃 `a[download]`，
 *    调用方改把图渲染到页面上让用户长按 —— 见 `DeviceReport.vue::showShot()`。
 *
 * 分享面板要求调用时还带着用户手势（iOS 尤甚），所以 `shareReportImage()`
 * 里 `share()` 必须是在调用栈上同步发出的：调用方应预生成文件
 * （`DeviceReport.vue` 的 `warmImage`），点按钮时直接交付。
 */

/** 长图的数据形状（页面算好再传进来，绘制层不碰业务） */
export interface ReportImageData {
  /** `塔机周报` */
  title: string
  /** `2026-11-10 至 11-16` */
  range: string
  /** `全场 3 台` / `2#楼-智能塔机2` */
  scope: string
  /** 6 格：`{ label: '累计吊次', value: '6次' }` */
  kpis: { label: string; value: string }[]
  /** 3 张风险卡 */
  risks: { label: string; text: string; value: string; alert?: boolean }[]
  /** 3 张柱状图 */
  charts: { title: string; note: string; bins: Bin[]; tone: Tone }[]
  /** 页脚副行（生成时间） */
  stamp: string
}

type Tone = 'blue' | 'warn' | 'ok'

/* ---------------- 画布配色（读 CSS 令牌，读不到时用同值兜底） ---------------- */

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch {
    return fallback
  }
}

interface Palette {
  bg: string
  card: string
  line: string
  text: string
  sub: string
  blue: string
  warn: string
  ok: string
  danger: string
  violet: string
}

function palette(): Palette {
  return {
    bg: cssVar('--bg-2', '#0B1626'),
    card: cssVar('--bg-3', '#132033'),
    line: 'rgba(255,255,255,0.07)',
    text: cssVar('--ink-1-dark', '#F2F6FB'),
    sub: cssVar('--ink-3-dark', '#8A9BB0'),
    blue: cssVar('--blue-dark', '#4C9FFF'),
    warn: cssVar('--warn-dark', '#F5C14A'),
    ok: cssVar('--ok-dark', '#2EE6A6'),
    danger: cssVar('--danger-dark', '#FF6B6B'),
    violet: '#C4B5FD',
  }
}

const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'

/* ---------------- 几何 ---------------- */

const W = 750
const PAD = 40
const INNER = W - PAD * 2

/** 各段高度（绘制与量高共用同一份，改一处即可） */
const H_HEAD = 168
const H_PART = 52
const H_KPI = 116
const H_RISK = 112
const H_CHART = 344
const H_FOOT = 96
const GAP = 16

const KPI_COLS = 3
const KPI_GAP = 14
const KPI_W = (INNER - KPI_GAP * (KPI_COLS - 1)) / KPI_COLS

/** 风险卡说明折行后每多一行的加高（与页面的行高同一量级） */
const RISK_LINE = 27
/** 图表说明折行后每多一行的加高 */
const NOTE_LINE = 26
/**
 * 画布高度上限。超限时浏览器不报错，只给一张空白/黑图 ——
 * 那是最难查的「导出后什么都没有」，所以宁可提前抛错让上层提示重试。
 */
const MAX_H = 16000

/* ---------------- 文字测量（无 DOM 时按单行兜底，绝不抛错） ---------------- */

const F_RISK_TEXT = `400 21px ${FONT}`
const F_RISK_VAL = `700 38px ${FONT}`
const F_NOTE = `400 20px ${FONT}`

let mctx: CanvasRenderingContext2D | null | undefined

function measurer(): CanvasRenderingContext2D | null {
  if (mctx !== undefined) return mctx
  try {
    mctx = document.createElement('canvas').getContext('2d')
  } catch {
    mctx = null
  }
  return mctx
}

function textWidth(text: string, font: string): number {
  const ctx = measurer()
  if (!ctx) return 0
  ctx.font = font
  return ctx.measureText(text).width
}

/**
 * 按宽度折行（中文没有空格可切，逐字累积）。
 *
 * 最多折 3 行：再长就不是「说明」而是段落了，卡面会被撑得离谱；
 * 常规文案（「22–5时 3次占 12.5%」之类）一行就够，折行只是兜底。
 */
function wrapText(text: string, font: string, maxWidth: number): string[] {
  const ctx = measurer()
  if (!ctx) return [text]
  ctx.font = font
  if (ctx.measureText(text).width <= maxWidth) return [text]
  const out: string[] = []
  let line = ''
  for (const ch of text) {
    if (line && ctx.measureText(line + ch).width > maxWidth) {
      out.push(line)
      line = ch
    } else {
      line += ch
    }
  }
  if (line) out.push(line)
  // 超过 3 行：那已经不是「说明」而是段落了，第 3 行收口加省略号（卡面不被撑爆）
  if (out.length > 3) {
    let third = out[2]
    while (third.length > 1 && ctx.measureText(`${third}…`).width > maxWidth) third = third.slice(0, -1)
    return [out[0], out[1], `${third}…`]
  }
  return out
}

/** 长数字降一档字号（`1234.56t` 这种），而不是截断成「1234…」 */
function fitFont(text: string, sizes: number[], weight: number, maxWidth: number): number {
  for (const s of sizes) {
    if (textWidth(text, `${weight} ${s}px ${FONT}`) <= maxWidth) return s
  }
  return sizes[sizes.length - 1]
}

/* ---------------- 量高（画之前先把版式算定） ---------------- */

interface Plan {
  height: number
  risks: { h: number; lines: string[] }[]
  charts: { h: number; lines: string[] }[]
  kpiFonts: number[]
}

function planOf(data: ReportImageData): Plan {
  const risks = data.risks.map((r) => {
    // 右侧数值占的宽度要先让出来，否则折行后的第二行会被数字压住
    const room = INNER - 100 - textWidth(r.value, F_RISK_VAL) - 26
    const lines = wrapText(r.text, F_RISK_TEXT, Math.max(96, room))
    return { h: Math.max(H_RISK, 84 + lines.length * RISK_LINE), lines }
  })
  const charts = data.charts.map((c) => {
    const lines = wrapText(c.note, F_NOTE, INNER - 44)
    return { h: H_CHART + (lines.length - 1) * NOTE_LINE, lines }
  })
  const kpiFonts = data.kpis.map((k) => fitFont(k.value, [34, 30, 26, 22], 700, KPI_W - 18))
  const kpiRows = Math.ceil(data.kpis.length / KPI_COLS)
  const height =
    PAD +
    H_HEAD +
    H_PART +
    kpiRows * (H_KPI + GAP) +
    H_PART +
    risks.reduce((n, r) => n + r.h + 10, 0) +
    H_PART +
    charts.reduce((n, c) => n + c.h + GAP, 0) +
    H_FOOT +
    PAD
  return { height, risks, charts, kpiFonts }
}

/* ---------------- 绘制工具 ---------------- */

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function card(ctx: CanvasRenderingContext2D, p: Palette, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = p.card
  roundRect(ctx, x, y, w, h, 16)
  ctx.fill()
  ctx.strokeStyle = p.line
  ctx.lineWidth = 1
  ctx.stroke()
}

/** 一行文字放不下时截断加省略号（只用于「放不下也没法折行」的位置，如页眉右侧） */
function clampText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1)
  return `${out}…`
}

/** 段标题：左侧 6×26 色条 + 26px 粗体 */
function partTitle(ctx: CanvasRenderingContext2D, p: Palette, x: number, y: number, text: string, color: string): void {
  ctx.fillStyle = color
  roundRect(ctx, x, y + 2, 6, 26, 3)
  ctx.fill()
  ctx.fillStyle = p.text
  ctx.font = `700 27px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(text, x + 18, y)
}

function toneColor(p: Palette, tone: Tone): string {
  if (tone === 'warn') return p.warn
  if (tone === 'ok') return p.ok
  return p.blue
}

/**
 * 柱状图。几何与 `components/ui/BarChart.vue` 同一套（4 条网格、柱顶标值、
 * 24 小时桶缩字号），只是画在 670×300 的画布区域里。
 */
function drawBars(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  y: number,
  w: number,
  h: number,
  bins: Bin[],
  color: string,
): void {
  const pl = 46
  const pr = 12
  const pt = 26
  const pb = 34
  const plotW = w - pl - pr
  const plotH = h - pt - pb
  const dense = bins.length > 16
  const maxV = Math.max(1, ...bins.map((b) => b.value))
  const step = maxV <= 20 ? 4 : maxV <= 80 ? 10 : 20
  const top = Math.max(step, Math.ceil(maxV / step) * step)
  const yAt = (v: number): number => y + pt + (1 - v / top) * plotH

  ctx.font = `400 19px ${FONT}`
  ctx.textBaseline = 'middle'
  for (let i = 0; i <= 4; i++) {
    const value = Math.round((top * i) / 4)
    const gy = Math.round(yAt(value)) + 0.5
    ctx.strokeStyle = p.line
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x + pl, gy)
    ctx.lineTo(x + w - pr, gy)
    ctx.stroke()
    ctx.fillStyle = p.sub
    ctx.textAlign = 'right'
    ctx.fillText(String(value), x + pl - 8, gy)
  }

  const n = bins.length
  const gap = dense ? 2 : 6
  const tickStep = axisStep(n)
  const bw = (plotW - gap * (n - 1)) / n
  const base = yAt(0)
  ctx.textAlign = 'center'
  for (let i = 0; i < n; i++) {
    const b = bins[i]
    const bx = x + pl + i * (bw + gap)
    if (b.value > 0) {
      const bh = Math.max(2, base - yAt(b.value))
      ctx.fillStyle = color
      roundRect(ctx, bx, base - bh, Math.max(bw, 1.5), bh, 2)
      ctx.fill()
      ctx.fillStyle = color
      ctx.font = `700 ${dense ? 15 : 18}px ${FONT}`
      ctx.textBaseline = 'bottom'
      ctx.fillText(String(b.value), bx + bw / 2, base - bh - 3)
    }
    ctx.fillStyle = p.sub
    ctx.font = `400 ${dense ? 15 : 18}px ${FONT}`
    ctx.textBaseline = 'middle'
    // 横轴刻度与页面同一套规则（`axisLabel` 去前导 0、`axisStep` 抽稀）：
    // 长图 750 宽虽然放得下 24 个标签，但「看到的图」与「导出的图」刻度
    // 必须一致，否则会以为导错了报表
    if (i % tickStep === 0) ctx.fillText(axisLabel(b.label), bx + bw / 2, base + 18)
  }
}

/* ---------------- 主绘制 ---------------- */

function draw(data: ReportImageData): HTMLCanvasElement {
  const p = palette()
  const plan = planOf(data)
  if (plan.height > MAX_H) throw new Error('too-tall')

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = plan.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas')

  ctx.fillStyle = p.bg
  ctx.fillRect(0, 0, W, plan.height)
  let y = PAD

  /* 头部 */
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = p.sub
  ctx.font = `400 22px ${FONT}`
  ctx.fillText('向阳村项目智能建造管理平台', PAD, y + 4)
  ctx.fillStyle = p.text
  ctx.font = `700 40px ${FONT}`
  ctx.fillText(data.title, PAD, y + 40)
  ctx.fillStyle = p.blue
  ctx.font = `600 24px ${FONT}`
  ctx.fillText(data.range, PAD, y + 96)
  // 右侧机组名与左侧区间同一行：先量出区间占的宽，剩下的才给机组名，
  // 否则 `2#楼-智能塔机2` 这种长名会压在「2026-11-10 至 11-16」上（原来就压）
  const rangeW = ctx.measureText(data.range).width
  ctx.textAlign = 'right'
  ctx.fillStyle = p.sub
  ctx.font = `400 22px ${FONT}`
  ctx.fillText(clampText(ctx, data.scope, Math.max(72, W - PAD * 2 - rangeW - 16)), W - PAD, y + 96)
  ctx.strokeStyle = p.line
  ctx.beginPath()
  ctx.moveTo(PAD, y + H_HEAD - 24.5)
  ctx.lineTo(W - PAD, y + H_HEAD - 24.5)
  ctx.stroke()
  y += H_HEAD

  /* 数据统计 */
  partTitle(ctx, p, PAD, y + 6, '数据统计', p.sub)
  y += H_PART
  data.kpis.forEach((k, i) => {
    const col = i % KPI_COLS
    const row = Math.floor(i / KPI_COLS)
    const x = PAD + col * (KPI_W + KPI_GAP)
    const ky = y + row * (H_KPI + GAP)
    card(ctx, p, x, ky, KPI_W, H_KPI)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = p.sub
    ctx.font = `400 21px ${FONT}`
    ctx.fillText(k.label, x + KPI_W / 2, ky + 24)
    ctx.fillStyle = k.value === '—' ? p.sub : p.text
    ctx.font = `700 ${plan.kpiFonts[i]}px ${FONT}`
    ctx.fillText(k.value, x + KPI_W / 2, ky + 58)
  })
  y += Math.ceil(data.kpis.length / KPI_COLS) * (H_KPI + GAP)

  /* 作业风险分析 */
  partTitle(ctx, p, PAD, y + 6, '作业风险分析', p.warn)
  y += H_PART
  data.risks.forEach((r, i) => {
    const cell = plan.risks[i]
    card(ctx, p, PAD, y, INNER, cell.h)
    const accent = r.alert ? p.danger : i === 1 ? p.violet : p.warn
    ctx.fillStyle = r.alert ? 'rgba(255,107,107,0.18)' : i === 1 ? 'rgba(196,181,253,0.18)' : 'rgba(245,193,74,0.16)'
    roundRect(ctx, PAD + 18, y + 24, 64, 64, 16)
    ctx.fill()
    // 图标：三角（峰值/超重）/ 月亮（夜间）——纯几何，不依赖字体
    ctx.strokeStyle = accent
    ctx.lineWidth = 3
    ctx.beginPath()
    if (i === 1) {
      ctx.arc(PAD + 50, y + 56, 16, Math.PI * 0.35, Math.PI * 1.65)
    } else {
      ctx.moveTo(PAD + 50, y + 40)
      ctx.lineTo(PAD + 34, y + 72)
      ctx.lineTo(PAD + 66, y + 72)
      ctx.closePath()
    }
    ctx.stroke()

    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = p.text
    ctx.font = `700 26px ${FONT}`
    ctx.fillText(r.label, PAD + 100, y + 24)
    ctx.fillStyle = p.sub
    ctx.font = F_RISK_TEXT
    cell.lines.forEach((line, li) => {
      ctx.fillText(line, PAD + 100, y + 62 + li * RISK_LINE)
    })
    ctx.textAlign = 'right'
    ctx.fillStyle = accent
    ctx.font = F_RISK_VAL
    ctx.fillText(r.value, PAD + INNER - 22, y + 32)
    y += cell.h + 10
  })

  /* 分布可视化 */
  partTitle(ctx, p, PAD, y + 6, '分布可视化', p.ok)
  y += H_PART
  data.charts.forEach((c, ci) => {
    const cell = plan.charts[ci]
    card(ctx, p, PAD, y, INNER, cell.h)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = p.text
    ctx.font = `700 25px ${FONT}`
    ctx.fillText(c.title, PAD + 20, y + 18)
    ctx.fillStyle = p.sub
    ctx.font = F_NOTE
    cell.lines.forEach((line, li) => {
      ctx.fillText(line, PAD + 20, y + 50 + li * NOTE_LINE)
    })
    // 说明折了几行，图就整体下移几行，绘图区高度同步收一点 —— 不压在说明上
    const drop = (cell.lines.length - 1) * NOTE_LINE
    drawBars(ctx, p, PAD + 10, y + 82 + drop, INNER - 20, cell.h - 92 - drop, c.bins, toneColor(p, c.tone))
    y += cell.h + GAP
  })

  /* 页脚 */
  y += 18
  ctx.strokeStyle = p.line
  ctx.beginPath()
  ctx.moveTo(PAD, y + 0.5)
  ctx.lineTo(W - PAD, y + 0.5)
  ctx.stroke()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = p.sub
  ctx.font = `400 20px ${FONT}`
  ctx.fillText(clampText(ctx, data.stamp, INNER / 2), PAD, y + 24)
  ctx.textAlign = 'right'
  ctx.fillText('数据来源：塔机工作循环接口', W - PAD, y + 24)

  return canvas
}

/* ---------------- 对外：生成 ---------------- */

/** 当前报表 → PNG 长图文件（不落盘，直接给分享面板或下载用） */
export async function reportImageFile(data: ReportImageData, name: string): Promise<File> {
  const canvas = draw(data)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('encode')
  return new File([blob], `${name}.png`, { type: 'image/png' })
}

/* ---------------- 对外：交付 ---------------- */

/** 交付结果：shared=已交给系统面板 / cancel=用户取消 / unsupported=环境不支持 / failed=面板没弹出来 */
export type ShareOutcome = 'shared' | 'cancel' | 'unsupported' | 'failed'

interface FileShareData {
  files: File[]
  title?: string
}
type ShareCapable = Navigator & {
  canShare?: (data?: FileShareData) => boolean
  share?: (data?: FileShareData) => Promise<void>
}

/**
 * 这张图能不能交给系统分享面板。
 *
 * **故意不按 `pointer: coarse` 拦桌面**（与 `photoHd.canShareFiles()` 不同）：
 * 照片那套的语义是「存相册」，桌面上该落文件；而这里按钮就写着「导出分享」，
 * 桌面浏览器若真的支持文件分享（Windows 的分享面板里就有微信），弹出来是对的。
 * 判不出来（`canShare` 抛错 / 返回 false）就当不支持，走下载。
 */
export function canShareFile(file: File): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as ShareCapable
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false
  try {
    return nav.canShare({ files: [file] }) === true
  } catch {
    return false
  }
}

/**
 * 交给系统分享面板。
 *
 * **调用即发**：`share()` 在第一个 `await` 之前同步发出，所以从点击处理里
 * 直接调（哪怕函数是 async）也不会丢用户手势。反过来，若先 `await` 一次
 * 生成图片再调，iOS 会报 NotAllowedError —— 那就退回下载。
 */
export async function shareReportImage(file: File, name: string): Promise<ShareOutcome> {
  if (!canShareFile(file)) return 'unsupported'
  try {
    await (navigator as ShareCapable).share!({ files: [file], title: name })
    return 'shared'
  } catch (err) {
    if ((err as DOMException | undefined)?.name === 'AbortError') return 'cancel'
    return 'failed'
  }
}

/** 兜底：落成 PNG 文件（桌面进下载目录，手机进「文件/下载」） */
export function downloadReportImage(file: File, name: string): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.png`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}
