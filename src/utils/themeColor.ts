/**
 * 动态主题色
 *
 * 用途：让 iOS / Android 的**系统状态栏区域**始终跟随当前页面顶部的实际颜色。
 *
 * 背景：项目以 PWA 独立窗口运行（manifest display: standalone）时，系统状态栏
 * 占据屏幕最顶端约 43~59pt，那部分**不属于网页内容**，其底色由 theme-color
 * 决定。iOS 还会按该底色亮度自动选状态栏文字颜色（深色底配白字、浅色底配黑字）。
 *
 * 写死单一颜色的两个问题：
 *   - 写深色：工作台等浅色页面顶部会出现一条黑带（原先的问题）
 *   - 写浅色：首页（深色地图）与横屏地图（深色底）顶部会切出一道白边
 *
 * 因此按当前视图动态取值，取值口径与 src/styles/app.css 中
 * .phone-screen:has(...) .status-bar 的 5 组配色规则保持一致。
 */

/** 取值与 app.css 的 :status-bar 配色规则一一对应 */
export const THEME_COLORS = {
  /** 普通浅色页面（工作台 / 消息 / 我的 / 子页）：与 .navbar 同为 #fff */
  light: '#ffffff',
  /** 首页：home-mode 深色主题，顶部为深色地图 */
  home: '#0b1a2b',
  /** 横屏地图覆盖层 */
  mapLand: '#0b0f14',
  /** 监控横屏播放 */
  camLandscape: '#000000',
} as const

const META_ID = 'app-theme-color'

/** 首次调用时创建/复用 <meta name="theme-color">，之后只改内容 */
function ensureMeta(): HTMLMetaElement {
  const existing =
    document.querySelector<HTMLMetaElement>(`meta[name="theme-color"][data-app]`) ??
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')

  if (existing) {
    existing.dataset.app = META_ID
    return existing
  }

  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.dataset.app = META_ID
  document.head.appendChild(meta)
  return meta
}

let metaEl: HTMLMetaElement | null = null

/** 设置系统状态栏区域的底色 */
export function setThemeColor(color: string): void {
  if (!metaEl) metaEl = ensureMeta()
  if (metaEl.content !== color) metaEl.content = color
}
