/**
 * 设备差异判定（2026-11-18，2026-11-18 二次改：从「只认苹果」放宽到「所有手机」）。
 *
 * ## 现在只用它做一件事：手机上不显示重连计数
 *
 * 播放**不分流** —— 所有设备都走 FLV（现场要求「恢复到 FLV、无限重连」）。
 * 手机上的重连进度对人没有意义：他既不会去数次数，也没法照着「3 秒后」做什么，
 * 一直跳动的数字只会让人以为坏了。所以手机端把计数裁掉（`stripRetryCount`），
 * 桌面照旧显示引擎原话（排查时「第几次、几秒后」是有用的信息）。
 *
 * 判定刻意做宽：安卓、鸿蒙、各家内置 WebView、iPadOS 自报桌面 UA 的都要算进来。
 * 机型判定不做响应式：UA 在一次页面生命周期里不会变。
 */

/**
 * 是不是苹果手机 / 平板。
 *
 * 三处都要判，缺一不可：
 *   · `iPhone` / `iPod` —— 手机直白；
 *   · `iPad` —— 老 iPadOS；
 *   · `Macintosh` + 多点触控 —— **iPadOS 13+ 默认「请求桌面网站」**，UA 自报
 *     是 Mac，只能靠 `maxTouchPoints > 1` 认出来。真正的 Mac 触点是 0，不会误伤。
 *
 * @param ua 便于单测注入；默认取 `navigator.userAgent`
 * @param touchPoints 便于单测注入；默认取 `navigator.maxTouchPoints`
 */
export function isAppleMobile(ua?: string, touchPoints?: number): boolean {
  const s = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (/iPhone|iPod|iPad/i.test(s)) return true
  if (!/Macintosh/i.test(s)) return false
  const points =
    touchPoints ?? (typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints || 0)
  return points > 1
}

/**
 * 本机是不是「触屏优先」的设备（`pointer: coarse`）。
 *
 * 用来兜住一类认不出来的移动浏览器：UA 自报桌面（部分国产 App 内置 WebView、
 * 浏览器「请求桌面网站」），但它其实只有手指这一种输入。
 *
 * 单测（happy-dom）里 `matchMedia` 可能不存在或恒 false，所以整段用 try 包住 ——
 * 这里只是「多裁一条文案」的加分项，判不出来就当不是，绝不能抛错。
 */
function coarsePointer(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

/**
 * 是不是手机 / 平板（**所有**移动端，不只是苹果）。
 *
 * 说明条要不要显示「重连次数」按它判断：手机上一律不显示，桌面保留。
 * 三种来源都要认，缺一条就会漏掉一整类设备：
 *   · 苹果：iPhone / iPod / iPad，以及 iPadOS 13+ 自报 Mac 的 UA（{@link isAppleMobile}）；
 *   · 安卓 / 鸿蒙 / 其它移动系统：`Android`、`Mobile`、`HarmonyOS`、`Windows Phone` 等；
 *   · 兜底：自报桌面 UA 但只有触摸输入（{@link coarsePointer} + 触点）。
 *
 * 宽一点没有代价 —— 它只影响一句话里带不带数字，不影响播放与重连；
 * 判窄了反而会让某几台手机上又露出计数。
 *
 * @param ua 便于单测注入；默认取 `navigator.userAgent`
 * @param touchPoints 便于单测注入；默认取 `navigator.maxTouchPoints`
 */
export function isMobileDevice(ua?: string, touchPoints?: number): boolean {
  const s = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)

  // 苹果（含 iPadOS 的桌面 UA）先过一遍：这段逻辑在 isAppleMobile 里
  if (isAppleMobile(s, touchPoints)) return true

  if (/Android|Mobile|Windows Phone|IEMobile|BlackBerry|Opera Mini|Kindle|Silk/i.test(s)) {
    return true
  }
  // 鸿蒙与部分国产系统的 UA 不带 Mobile 字样，但都是手机/平板
  if (/HarmonyOS|OpenHarmony|Symbian|Tablet|PlayBook/i.test(s)) return true

  // 自报桌面 UA 的移动浏览器：没有 `Mobile` 字样，只有手指这一种输入
  const points =
    touchPoints ?? (typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints || 0)
  return coarsePointer() && points > 0
}

/**
 * 本机有没有可用的 MSE。
 *
 * **不用它来判断机型、也不用来决定播什么**：SSR、单测（happy-dom）、以及一些
 * 内嵌 WebView 里 `MediaSource` 也不存在，拿它判定会把「本来能播 FLV 的环境」
 * 全部当成不能播。这个函数只用于日志与排障，**不参与任何分流**。
 */
export function hasMse(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { MediaSource?: unknown; ManagedMediaSource?: unknown }
  return typeof w.MediaSource !== 'undefined' || typeof w.ManagedMediaSource !== 'undefined'
}

/**
 * 是不是在微信内置浏览器里打开的（含企业微信、小程序 web-view）。
 *
 * 只看 UA 里的 `MicroMessenger`：企业微信与小程序 web-view 的 UA 都带这一段，
 * 它们的内核同样**不给 Web Share**（`navigator.share` 不存在），`a[download]`
 * 也不生效。所以「导出分享」必须在这里换一条路（把图摆到页面上长按保存），
 * 否则用户点了按钮会觉得没反应。
 *
 * 判定只读 UA、不做响应式：UA 在一次页面生命周期里不会变。
 *
 * @param ua 便于单测注入；默认取 `navigator.userAgent`
 */
export function isWeChatBrowser(ua?: string): boolean {
  const s = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  return /MicroMessenger/i.test(s)
}

/**
 * 把重连提示里的「次数 / 倒计时」裁掉（手机端不展示计数）。
 *
 * 引擎的原话是有用的（出什么事了），只是不该让人盯着数次数：
 * ```
 * 「直播流连接失败，2 秒后自动重连（1/3）」        → 「直播流连接失败，正在自动重连」
 * 「画面停住了，正在重连（第 2/3 次）」            → 「画面停住了，正在自动重连」
 * 「直播流连接失败（已连续重试 3 次，每 10 秒…）」 → 「直播流连接失败，正在自动重连」
 * 「当前浏览器不支持 MSE，无法播放 FLV 直播」      → 原样保留（这句没有计数，必须留）
 * ```
 * 最后那道 `\d+ 次 / 秒` 检查是兜底：宁可整句换成「正在自动重连」，
 * 也不让任何形式的计数漏到界面上。
 */
export function stripRetryCount(note: string): string {
  const raw = (note || '').trim()
  if (!raw) return ''

  let s = raw
    // 「（1/3）」「（第 2/3 次）」「（第 2/3 次重连）」
    .replace(/[（(]\s*第?\s*\d+\s*\/\s*\d+\s*次?\s*(?:重连?)?\s*[）)]/g, '')
    // 「（已连续重试 3 次，每 10 秒继续自动重连；点播放键可立即重试）」
    .replace(/[（(][^（）()]*重试\s*\d+\s*次[^（）()]*[）)]/g, '')
    // 「，2 秒后自动重连」→「，正在自动重连」
    .replace(/[，,]\s*\d+\s*秒后(?:自动)?重连/g, '，正在自动重连')
    // 剩下的「正在重连（…）」整体改写
    .replace(/正在重连[（(][^）)]*[）)]/g, '正在自动重连')
    // 「正在重连」统一成「正在自动重连」（同一句话，不同引擎状态用词略有差异）
    .replace(/正在重连/g, '正在自动重连')
    // 碎片兜底
    .replace(/第\s*\d+\s*\/\s*\d+\s*次/g, '')
    .replace(/每\s*\d+\s*秒/g, '')
    .replace(/[，,]\s*[；;]/g, '，')
    .replace(/[，,]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  // 计数删干净之后，把「还在重连」这件事补回去 —— 否则只剩「直播流连接失败」，
  // 看起来像已经放弃了。环境类错误（不支持 / 无法播放）不补，它们本来就不重连。
  if (/重试|重连/.test(raw) && !/重连/.test(s) && !/不支持|无法播放/.test(s)) {
    s = `${s}，正在自动重连`
  }

  // 兜底：仍然带次数/秒数就整句收口，绝不让计数露出去
  if (/\d+\s*(?:次|秒)/.test(s)) s = '正在自动重连'
  return s
}
