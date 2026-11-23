/**
 * 动态主题色
 *
 * 用途：让 iOS / Android 的**系统状态栏区域**始终跟随当前页面顶部的实际颜色。
 *
 * 背景：项目以 PWA 独立窗口运行（manifest display: standalone）时，系统状态栏
 * 占据屏幕最顶端约 43~62pt，那部分**不属于网页内容**，其底色由 theme-color
 * 决定。iOS 还会按该底色亮度自动选状态栏文字颜色（深色底配白字、浅色底配黑字）。
 *
 * 写死单一颜色的两个问题：
 *   - 写深色：工作台等浅色页面顶部会出现一条黑带（原先的问题）
 *   - 写浅色：首页（深色地图）与横屏地图（深色底）顶部会切出白边
 *
 * 因此按当前视图动态取值，取值口径与 src/styles/app.css 中
 * .phone-screen:has(...) .status-bar 的 5 组配色规则保持一致。
 *
 * ## 2026-11-23：同时写页面根色（`--chrome-bg`）
 *
 * iOS 26 的系统状态栏不再是「刷一块纯色」，而是一层**玻璃**：它会取页面
 * 根背景（html/body）的颜色向上延伸，再叠一点模糊/提亮。于是只改
 * theme-color 已经不够 —— body 底色固定为浅蓝灰时，工作台（白顶栏）和
 * 首页（深色地图）的顶端都被糊成同一条灰蓝带，即现场看到的「顶部色块」。
 *
 * 把同一个色同时写进 `--chrome-bg`，让玻璃取到顶栏本身的颜色：白顶栏页
 * 延伸出白、首页延伸出底图那片黑，状态栏区与页面顶栏连成一片。
 *
 * ## 2026-11-23（第二批）：首页改用底图上沿的实测黑
 *
 * 首页原先取 #0b1a2b（深蓝），比底图顶部的纯黑 rgb(1, 11, 21) 更亮更蓝，
 * 宿主把状态栏涂成这个色后就在黑图上压出一条蓝带。现统一为 #010b15，
 * 与 `app.css` 的 `--home-top`、`#page-home` / `.home-map` 的底色三者同值。
 */

/** 取值与 app.css 的 :status-bar 配色规则一一对应 */
export const THEME_COLORS = {
  /** 普通浅色页面（工作台 / 消息 / 我的 / 子页）：与 .navbar 同为 #fff */
  light: '#ffffff',
  /**
   * 首页：home-mode 深色主题，顶部是航拍底图那片纯黑天空。
   *
   * 必须与底图上沿的实际像素一致（`public/img/site-map.webp` 顶行取样
   * rgb(1, 11, 21)），也与 app.css 的 `--home-top` 同值。原先写 #0b1a2b
   * （深蓝）比图更亮更蓝，宿主把状态栏涂成这个色后，就在黑色图顶上压出
   * 一条可见的蓝带 —— 即「顶栏与背景图两种颜色拼接」。
   */
  home: '#010b15',
  /** 横屏地图覆盖层 */
  mapLand: '#0b0f14',
  /** 监控横屏播放 */
  camLandscape: '#000000',
  /** 深色子页（设备详情 / 日报 / 无人机）：与 --bg-2 同值，顶部不能白一条 */
  dark: '#0B1626',
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

/**
 * 设置系统状态栏区域的底色
 *
 * 同时更新 `<meta name="theme-color">`（安卓工具栏 / iOS 状态栏文字配色）
 * 与页面根色 `--chrome-bg`（iOS 26 顶栏玻璃取色用，见文件头说明）。
 */
export function setThemeColor(color: string): void {
  if (!metaEl) metaEl = ensureMeta()
  if (metaEl.content !== color) metaEl.content = color
  const root = document.documentElement
  if (root.style.getPropertyValue('--chrome-bg') !== color) {
    root.style.setProperty('--chrome-bg', color)
  }
}
