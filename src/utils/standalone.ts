/**
 * 主屏独立运行（PWA 安装态）与设备环境判定
 *
 * 背景（2026-11-19）：现场要求「iPhone iOS 18 添加到主屏幕后能独立运行，安卓各
 * 机型也一样」。配置层面的活在各处（index.html 的 apple-* meta、vite.config.ts 的
 * manifest、public/ 下的图标与启动图），这个文件只负责**运行期**那三件绕不开的事：
 *
 *   1. **认出当前是不是独立窗口** —— 独立窗口没有地址栏、没有下拉刷新，
 *      一旦首屏烂掉用户只能杀进程；诊断浮层、排障日志、将来的引导提示都要用它。
 *   2. **给 <html> 打环境标记** —— 其中 `no-has` 是真正的兼容性兜底：
 *      样式表里有 20 多处 `:has()`，而小米 / 华为 / OPPO / vivo 部分自带浏览器仍是
 *      Chrome 105 之前的内核，`:has()` 整条规则会被丢弃。表现是「子页开着、底栏
 *      还在下面露着」。检测到不支持就打 `no-has`，CSS 里用等价 class 规则顶上。
 *   3. **接管安卓的安装入口** —— Chromium 的 `beforeinstallprompt` 默认会弹一条
 *      自己的 mini-infobar，拦掉之后才轮得到应用自己决定时机（现在不主动弹，
 *      只把能力开放给页面，避免在监控页正看着画面时突然弹安装条）。
 *
 * iOS 侧没有 `beforeinstallprompt`，只能由用户在「分享 → 添加到主屏幕」里手动加，
 * 所以这里不提供、也无法提供程序化安装入口。
 */

import { isAppleMobile } from './env'

/** 当前显示模式；`browser` 表示还在浏览器标签页里 */
export type DisplayMode = 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser'

/** 安卓 install prompt 事件（Chromium 非标准事件，需自己声明） */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const UA = (): string => (typeof navigator === 'undefined' ? '' : navigator.userAgent)

/**
 * 是否 iOS / iPadOS。
 *
 * 直接复用 `env.ts` 的判定：它已经处理了 iPadOS 13+「请求桌面网站」时
 * 自报 `Macintosh` 的情况（靠 `maxTouchPoints > 1` 认）。这里不重复实现，
 * 否则两处判定迟早分叉 —— 一处认、一处不认，症状是「有的地方当苹果有的不当」。
 */
export function isIOS(): boolean {
  return isAppleMobile()
}

/**
 * 是否安卓系（含鸿蒙）。
 *
 * 鸿蒙 NEXT 的 UA 可能不带 `Android`，只写 `HarmonyOS` / `OpenHarmony`，
 * 两者都归到这里：它们都是 Chromium/ArkWeb 内核，manifest 与安装行为一致。
 */
export function isAndroid(): boolean {
  return /Android|HarmonyOS|OpenHarmony/i.test(UA())
}

/**
 * 当前显示模式。
 *
 * 先看 `display-mode` 媒体查询（Chromium 与 iOS 15+ 都支持）；再兜 `navigator.standalone`
 * —— iOS 17 及更早在独立窗口里 `(display-mode: standalone)` 不一定为真，而那个
 * 非标准字段一直是可靠的。两条都读不到就按浏览器处理。
 */
export function displayMode(): DisplayMode {
  if (typeof window === 'undefined') return 'browser'
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone'
    if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen'
    if (window.matchMedia('(display-mode: minimal-ui)').matches) return 'minimal-ui'
  } catch {
    // 老内核可能没有 matchMedia 或不认 display-mode，落到下面的 iOS 字段
  }
  if (typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true) {
    return 'standalone'
  }
  return 'browser'
}

/** 是不是从主屏启动的独立窗口（standalone / fullscreen / minimal-ui 都算） */
export function isStandalone(): boolean {
  return displayMode() !== 'browser'
}

/**
 * 监听显示模式变化（安卓上「安装后立刻进入独立模式」会触发）。
 *
 * 返回取消订阅函数。注意各内核只在**跨模式**时派发 change，
 * 同模式内 resize 不算 —— 这里也不该管 resize。
 */
export function watchDisplayMode(cb: (mode: DisplayMode) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined
  }
  const queries = ['(display-mode: standalone)', '(display-mode: fullscreen)', '(display-mode: minimal-ui)']
    .map((q) => {
      try {
        return window.matchMedia(q)
      } catch {
        return null
      }
    })
    .filter((m): m is MediaQueryList => m !== null)

  const onChange = (): void => cb(displayMode())
  queries.forEach((m) => m.addEventListener('change', onChange))
  return () => queries.forEach((m) => m.removeEventListener('change', onChange))
}

/**
 * 这台内核认不认 `:has()`。
 *
 * 判定一次就够（内核能力不会变），结果打在 `<html class="no-has">` 上，
 * CSS 里用 `.no-has .app.has-subpage .tabbar` 这类等价选择器兜住关键规则。
 * 只兜「底栏显隐」与「更新提示条避让」两条 —— 它们不生效会直接盖住内容；
 * 状态栏配色那几条退化只影响色条颜色，不值得为此增加选择器维护成本。
 */
function supportsHas(): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('selector(:has(*))')
  } catch {
    return false
  }
}

/* ---------------- 安装入口（仅 Chromium） ---------------- */

let deferred: BeforeInstallPromptEvent | null = null

function bindInstallPrompt(): void {
  if (typeof window === 'undefined') return

  window.addEventListener('beforeinstallprompt', (e) => {
    /*
     * 必须 preventDefault：否则 Chromium 会立刻弹自己的 mini-infobar，
     * 现场正在看监控画面时被一条安装条压住，且无法收回。
     * 拦下来之后由页面在合适时机调 `promptInstall()`。
     */
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    window.dispatchEvent(new CustomEvent('xyc:installable'))
  })

  window.addEventListener('appinstalled', () => {
    deferred = null
    window.dispatchEvent(new CustomEvent('xyc:installed'))
  })
}

/** 当前能否由代码发起安装（iOS 永远为 false，只能手动添加） */
export function canInstall(): boolean {
  return deferred !== null
}

/**
 * 发起安装。返回用户的选择；`unavailable` 表示当前环境没有可用的安装入口
 * （iOS、已安装、或浏览器还没派发 `beforeinstallprompt`）。
 *
 * 只能在用户手势的调用链里调（按钮 click），否则部分内核会直接拒绝。
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const ev = deferred
  if (!ev) return 'unavailable'
  // 一个事件只能用一次，先清空再 await，避免连点第二发报 InvalidStateError
  deferred = null
  try {
    await ev.prompt()
    const { outcome } = await ev.userChoice
    return outcome
  } catch {
    return 'dismissed'
  }
}

/* ---------------- 启动与标记 ---------------- */

/**
 * 给 `<html>` 打环境标记，供 CSS 与排障使用。
 *
 * 只在启动时调一次。`is-standalone` 供样式微调（例如独立模式下不需要再提示
 * 「添加到主屏」）；`no-has` 是兼容兜底，见 `supportsHas()` 的说明。
 */
export function markEnvironment(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.toggle('is-standalone', isStandalone())
  root.classList.toggle('is-ios', isIOS())
  root.classList.toggle('is-android', isAndroid())
  root.classList.toggle('no-has', !supportsHas())
}

/**
 * 移除 index.html 里的启动骨架。
 *
 * 为什么要等两帧：`mount()` 返回时 DOM 已经建好，但浏览器还没把它画出来。
 * 此刻就改 `opacity` 会出现「骨架先消失、下面还是白的」那一帧 —— 在深色应用上
 * 是一次明显白闪。等两帧（第一次布局、第二次绘制）再淡出，衔接才是无缝的。
 *
 * 另有一条 2 秒兜底：标签页在后台时 `requestAnimationFrame` 不执行，
 * 不能因为「用户切走了」就让骨架永远盖在应用上。
 */
export function hideBootSplash(): void {
  if (typeof document === 'undefined') return
  const boot = document.getElementById('boot')
  if (!boot) return

  let done = false
  const drop = (): void => {
    if (done || !boot.isConnected) return
    done = true
    boot.classList.add('is-gone')
    window.setTimeout(() => boot.remove(), 320)
  }

  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.requestAnimationFrame(drop))
  } else {
    drop()
  }
  window.setTimeout(drop, 2_000)
}

bindInstallPrompt()
