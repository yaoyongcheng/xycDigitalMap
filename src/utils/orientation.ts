/**
 * 「点全屏 → 自动横过来」—— 一次尽力而为的系统级转向（2026-11-23）
 *
 * 为什么不是「设置一下就横屏」：能不能让系统真的转屏，完全取决于宿主浏览器，
 * 而各平台差距极大（逐条实测口径见 docs/api-migration.md「六点三十七」）：
 *
 *   · iOS / iPadOS 上**所有**浏览器（Safari、Chrome、微信、各家 App 内嵌）
 *     —— 没有 `Element.requestFullscreen`，`screen.orientation.lock` 也不支持。
 *     JS 在这里拿不到任何转屏能力，只能引导用户自己把手机横过来。
 *   · Android Chromium 系（Chrome、华为 / 小米 / vivo / OPPO 自带浏览器）
 *     —— 两者都支持，但 `lock()` 必须发生在**已进入全屏**之后，
 *     且系统开了「旋转锁定」时可能被忽略。
 *   · Android 微信内置浏览器（XWeb / X5）—— 版本差异大，多数拿不到全屏，
 *     `lock()` 基本无效。
 *   · HarmonyOS NEXT（ArkWeb）—— `requestFullscreen` 可用，
 *     `orientation.lock` 支持不完整，通常无效。
 *   · 桌面浏览器 —— `requestFullscreen` 可用，`orientation.lock` 抛
 *     `NotSupportedError`（桌面没有方向概念）。
 *
 * 因此这里三件事全都不抛错、失败也不留痕：
 *   1. 对 `documentElement` 申请系统全屏（**不是**某个画布元素 —— 本项目的
 *      弹层都 Teleport 到 body，只对子元素全屏会把弹层藏掉）；
 *   2. 申请 `screen.orientation.lock('landscape')`；
 *   3. 等转屏动画过去，用「视口宽 > 高」这一**观感事实**回报结果，
 *      而不是回报「lock 有没有成功」—— 桌面全屏后天然宽 > 高，
 *      不该被当成失败去提示用户转屏。
 *
 * 调用方（`shell.openMapLand` / `cam.setCamLand` / `utils/landscape.ts`）只做一件事：
 *   · 关闭 / 卸载 → `exitNativeLandscape()`，**必须解锁**，
 *     否则用户整台手机被钉在横屏上（这是本方案唯一的硬风险）。
 *
 * 结果为 false（仍是竖屏）时**不在这里提示**：横屏引导卡只有智眸 VR 360 环视的
 * 项目全景全屏会摆（`utils/landscapeHint.ts`，2026-11-24 口径），其余场景
 * 就留在「铺满视口」那一层，画面照样能看。
 */
type FullscreenDoc = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: (() => Promise<void> | void) | undefined
  /** iOS 视频型全屏时代的老 API，个别内嵌 WebView 只认它 */
  webkitCancelFullScreen?: (() => void) | undefined
}

type FullscreenRoot = HTMLElement & {
  webkitRequestFullscreen?: ((options?: FullscreenOptions) => Promise<void> | void) | undefined
}

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'any' | 'landscape' | 'portrait') => Promise<void>
  unlock?: () => void
}

/** 当前的全屏元素（含 WebKit 前缀老内核） */
function fullscreenElement(): Element | null {
  const doc = document as FullscreenDoc
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

/**
 * 当前是不是在系统全屏里。
 *
 * 注意这是**唯一可见的信号，但它不可靠**：iOS / 微信里即使画面已经进了全屏，
 * 这两个属性也常读成 null（`exitNativeLandscape` 的注释里记过这个毛病），
 * 旋转的那一瞬间更是会先报 null 再恢复。所以：
 *   · 读到 `true` —— 可信，说明确实在全屏；
 *   · 读到 `false` —— **不能**当成「已经退出」，只能当成「看不到」。
 * 凡是要用它做「收 UI / 跳过退出」这类不可逆决定的，都必须二次确认
 * （见 `utils/landscape.ts::scheduleDropCheck`），或者干脆不看它、无条件退一次。
 */
export function isSystemFullscreen(): boolean {
  return Boolean(fullscreenElement())
}

/** 系统全屏能力是否可用（iOS 上恒为 false） */
export function canGoNativeFullscreen(): boolean {
  const root = document.documentElement as FullscreenRoot
  return Boolean(root.requestFullscreen || root.webkitRequestFullscreen)
}

/**
 * 是不是触屏设备。
 *
 * 桌面浏览器也有 Fullscreen API，但桌面没有「横屏」这回事：申请系统全屏
 * 只是把浏览器 UI 藏起来（接着 Esc 退出、还会连带收掉全屏层），对用户是纯干扰。
 * 所以只在触屏设备上走系统满屏，桌面保持原来的「页面内全屏层」。
 */
export function isTouchDevice(): boolean {
  try {
    if (window.matchMedia?.('(any-pointer: coarse)').matches) return true
  } catch {
    /* 老内核不认这个查询 */
  }
  return (navigator.maxTouchPoints ?? 0) > 0
}

/**
 * 当前视口是不是横向。
 *
 * 这是**唯一的成功判据**：全屏也好、锁方向也好，都是为了这一件事。
 */
export function isLandscapeViewport(): boolean {
  return window.innerWidth > window.innerHeight
}

/** 转屏动画大约 300ms，等它落定再量，避免在动画中途误判成竖屏 */
function afterRotate(): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 320)
  })
}

/**
 * 「请横过手机」的引导交给 `utils/landscapeHint.ts` —— 这里只管申请与释放，
 * 不碰任何 UI 状态（而且 2026-11-24 起只有智眸 VR 360 环视的全景全屏会用它）。
 */

/**
 * 进入系统全屏 + 尽量锁横屏。
 *
 * @returns 落定后视口是否已横向。`true` 时调用方什么都不用做；
 *          `false` 时留给调用方自行决定要不要提示（目前只有项目全景会提示，
 *          其余场景静默铺满视口即可）。
 */
export async function enterNativeLandscape(): Promise<boolean> {
  // 桌面不折腾：没有横屏概念，全屏只会藏掉浏览器 UI（见 isTouchDevice 注释）
  if (!isTouchDevice()) return isLandscapeViewport()

  if (!fullscreenElement()) {
    const root = document.documentElement as FullscreenRoot
    try {
      if (root.requestFullscreen) {
        await root.requestFullscreen({ navigationUI: 'hide' })
      } else if (root.webkitRequestFullscreen) {
        await root.webkitRequestFullscreen()
      }
    } catch {
      /* 不支持 / 被拒绝（无用户手势、策略禁止）：留在页面内布局 */
    }
  }

  const orientation = screen.orientation as LockableOrientation | undefined
  try {
    await orientation?.lock?.('landscape')
  } catch {
    /* iOS 没有 lock；桌面 / 未全屏 / 系统锁定旋转时也会走到这里 */
  }

  await afterRotate()
  // 转屏落定：让 dvh / 安全区按新方向重算，顺手清掉可能残留的滚动位
  settleViewport()
  return isLandscapeViewport()
}

/** 等一小会儿（转场 / 退全屏动画） */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

/**
 * 退全屏会发的事件：标准 / WebKit 前缀 / iOS 视频型收尾。
 * `webkitendfullscreen` 不冒泡，所以下面统一用**捕获**阶段监听。
 */
const EXIT_EVENTS = ['fullscreenchange', 'webkitfullscreenchange', 'webkitendfullscreen'] as const

/**
 * 发一次退出请求，等一个「确实退出去了」的信号。
 *
 * 只认三种结局：退出事件（最可信）、`exitFullscreen()` 被拒（说明本来就没在全屏）、
 * 超时后复查属性。刻意**不认**「promise resolve」—— 2026-11-24 现场：iOS 上转场
 * 期间第一次 `exitFullscreen` 会被吞掉，promise 照样 resolve，画面却还在全屏。
 *
 * @returns 是否确认已退出；属性读不到时按「已退出」处理（见 `isSystemFullscreen`）
 */
function fireExitOnce(timeout = 420): Promise<boolean> {
  const doc = document as FullscreenDoc
  return new Promise<boolean>((resolve) => {
    let settled = false
    function finish(ok: boolean): void {
      if (settled) return
      settled = true
      for (const e of EXIT_EVENTS) document.removeEventListener(e, onChange, true)
      window.clearTimeout(timer)
      resolve(ok)
    }
    function onChange(): void {
      if (!isSystemFullscreen()) finish(true)
    }
    for (const e of EXIT_EVENTS) document.addEventListener(e, onChange, true)
    const timer = window.setTimeout(() => finish(!isSystemFullscreen()), timeout)

    const fail = (): void => finish(!isSystemFullscreen())
    try {
      if (doc.exitFullscreen) {
        void doc.exitFullscreen().catch(fail)
      } else if (doc.webkitExitFullscreen) {
        void Promise.resolve(doc.webkitExitFullscreen()).catch(fail)
      } else if (doc.webkitCancelFullScreen) {
        doc.webkitCancelFullScreen()
      } else {
        // 这台设备根本没有全屏 API（iOS 传统路径）：没什么可退的
        finish(true)
      }
    } catch {
      fail()
    }
  })
}

/**
 * 退出：解锁方向 → 退全屏 → 再解锁一次。
 *
 * 顺序不能反 —— 先进全屏再锁方向的逆过程，反了会有一段时间方向仍被钉住；
 * 而退出之后再补一次 `unlock()` 是给「iOS 退完全屏按物理方向重排、又把锁套回去」
 * 这一档留的。两个动作都不抛错（本来就没进全屏时是空操作）。
 *
 * **不靠 `fullscreenElement()` 决定要不要退**（2026-11-23 修）：
 * iOS / 微信内置浏览器里这个属性常常读不到（标准与 `webkit` 前缀都可能是 null，
 * 即使画面已经进了全屏），一旦据此提前 return，用户就永远退不出系统全屏 ——
 * 现场表现正是「智眸里点了全屏，怎么都关不掉」。没在全屏时调 `exitFullscreen`
 * 只会 reject，catch 掉即可，代价是一次无害的异常。
 *
 * **退三次**（2026-11-24 修）：一次不够。iOS 上「横屏 → 竖屏」之后第一次调用
 * 会被转场吞掉，且不发任何事件，只发一次就变成「退不出来」。间隔 0 / 260 / 700ms
 * 覆盖转场动画；只有「仍读得到全屏」时才继续 —— 读不到（iOS 常态）当它退掉了，
 * 不做无谓等待。三次都没退掉就返回 `false`，**由调用方决定怎么把用户放出来**
 * （`utils/landscape.ts::exit()` 会保留退出按钮、900ms 后再试一次）。
 *
 * @returns 是否确认已退出（`false` 表示还读得到全屏，调用方应保留退出入口）
 */
export async function exitNativeLandscape(): Promise<boolean> {
  const orientation = screen.orientation as LockableOrientation | undefined
  try {
    // 同步调用，绝不 await —— 后面紧跟着的 exitFullscreen 还要靠这次点击的手势
    orientation?.unlock?.()
  } catch {
    /* 忽略 */
  }

  const gaps = [0, 260, 700]
  let exited = false
  for (const gap of gaps) {
    if (gap > 0) await wait(gap)
    exited = await fireExitOnce(420)
    // 还读得到全屏 → 再试一次；读不到就收手，不空转
    if (exited || !isSystemFullscreen()) {
      exited = true
      break
    }
  }

  try {
    orientation?.unlock?.()
  } catch {
    /* 忽略 */
  }

  return exited
}

/** 落定后广播 resize 的定时器（进 / 退连着点，只留最后一次） */
let settleTimer = 0

/** 再给一次「写样式 → 读布局」，催 iOS 重算 `dvh` 与 `env(safe-area-inset-*)` */
function forceReflow(): void {
  const root = document.documentElement
  const KEY = '--vp-settle'
  const prev = root.style.getPropertyValue(KEY)
  // 先写：自定义属性会继承到整棵树，样式随之失效
  root.style.setProperty(KEY, '1')
  // 再读：同步冲刷布局，新的方向 / 安全区在这一次重排里生效
  void root.offsetHeight
  if (prev) root.style.setProperty(KEY, prev)
  else root.style.removeProperty(KEY)
}

/**
 * 全屏进出 / 转屏落定后的收尾（2026-11-23）。
 *
 * iOS 上「退出全屏回竖屏后整页向上偏移」有三条来源，这里一次兜住：
 *   1. `documentElement` 全屏进出会改写 `scrollY`，而 `html,body{overflow:hidden}`
 *      只禁止手势滚动，**拦不住系统写值** —— 残留几十 px 就永久上移，用户也滑不回来；
 *   2. `dvh` 与自定义属性里的 `env()` 在旋转后可能沿用旧方向的值，
 *      要一次同步重排才刷新（CSS 侧另用 `max(..., env())` 兜底，见 `.navbar` 注释）；
 *   3. 依赖视口的组件（首页抽屉半开位是 inline px）只听 `resize`，
 *      而转屏动画期间的 `resize` 读到的还是旧高度。
 *
 * 顺序要紧：先重排（让尺寸已经是新的），再把滚动位归零，最后在动画结束后广播。
 */
export function settleViewport(): void {
  forceReflow()

  if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0) {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }

  window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => {
    window.dispatchEvent(new Event('resize'))
  }, 340)
}

/**
 * 监听「用户用系统方式退出全屏」（Android 返回键 / 桌面 Esc / 手势退全屏）。
 *
 * 回调只在**从有全屏变成没全屏**时触发；进入全屏那一下不触发。
 * 返回解除监听的函数。
 */
export function onFullscreenExit(cb: () => void): () => void {
  let had = Boolean(fullscreenElement())

  function check(): void {
    const now = Boolean(fullscreenElement())
    if (had && !now) cb()
    had = now
  }

  document.addEventListener('fullscreenchange', check)
  document.addEventListener('webkitfullscreenchange', check)
  return () => {
    document.removeEventListener('fullscreenchange', check)
    document.removeEventListener('webkitfullscreenchange', check)
  }
}
