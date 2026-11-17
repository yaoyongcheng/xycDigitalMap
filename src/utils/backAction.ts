/**
 * 全局「返回动作」去抖（2026-11）
 *
 * 一次用户手势只该退一级。「返回」有三个来源：
 *   · 页面上点返回箭头      —— SubPage 自己处理
 *   · 应用内边缘右滑手势    —— utils/swipeBack.ts
 *   · 浏览器 / 系统侧滑     —— utils/historyBack.ts（popstate）
 *
 * 真机上后两者会**同时**发生：iOS 的边缘侧滑由 Safari 认领并发出 popstate，
 * 页面却也收到了 pointerup，于是两边各点了一次同一个返回按钮 ——
 * 「预警详情」右滑一次就退到了首页（跳过报警预警）。
 *
 * 现在的主要防线在 `historyBack` 里：它按历史条目记的**绝对层数**逐层关，
 * 手势层先落地也只会让层数提前对齐，于是 popstate 算出来「没有要关的」。
 * 这里的时间戳只作为手势层自己的第二道闸（同一动作里连点两下也挡住）。
 */

/**
 * 动作窗口（ms）。
 *
 * 取值要**小于滑出动画 220ms**，否则「连点两下返回」会被吞掉；又要**大于**
 * 真机上 popstate 与 pointerup 的到达间隔（实测几十毫秒，偶发到一两百）。
 * 400 是两边都留了余量的折中。
 */
const WINDOW = 400

/** 上一次放行的时刻。用 -Infinity 而不是 0：页面刚加载时 performance.now() 也接近 0 */
let lastAt = Number.NEGATIVE_INFINITY

/**
 * 「这一次返回不要再补动画」标记（2026-11）。
 *
 * 只由 `historyBack` 在**浏览器返回**（popstate）时打：那种情况下浏览器自己
 * 已经演过一遍转场（Safari 把整页推走、露出上一条历史的快照），我们再补一段
 * 0.22s 滑出，现场看到的就是「页面还停在详情，闪一下才变成报警预警」。
 *
 * 应用内手势松手**不打**这个标记 —— 那条路径要和点返回箭头完全一致。
 */
const SILENT_WINDOW = 500
let silentAt = Number.NEGATIVE_INFINITY

/** 标记「紧接着的那次返回不再播转场」 */
export function markSilentBack(): void {
  silentAt = performance.now()
}

/**
 * 消费静默标记（带窗口过期）。
 *
 * 标记之后若按钮没被点到（层已被别处关掉），500ms 后自动失效，免得下一次
 * 真正点返回箭头被误判成浏览器返回而少了动画。
 */
export function takeSilentBack(): boolean {
  const on = performance.now() - silentAt < SILENT_WINDOW
  silentAt = Number.NEGATIVE_INFINITY
  return on
}

/**
 * 申请一个返回名额：放行返回 true 并记账，窗口内重复申请返回 false。
 *
 * 调用方约定：**只有真正要执行返回时**才申请，申请失败就什么都不做（不要
 * 事后再补动画、补状态），否则又变成一次手势退两级。
 */
export function takeBackSlot(): boolean {
  const now = performance.now()
  if (now - lastAt < WINDOW) return false
  lastAt = now
  return true
}

/** 仅供测试：清空记账，避免用例之间互相影响 */
export function resetBackSlot(): void {
  lastAt = Number.NEGATIVE_INFINITY
  silentAt = Number.NEGATIVE_INFINITY
}
