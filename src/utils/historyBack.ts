import { computed, onMounted, onUnmounted, watch } from 'vue'

import { useAirHazardStore } from '@/stores/airHazard'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useCamStore } from '@/stores/cam'
import { useSubpageStore } from '@/stores/subpage'
import { markSilentBack } from '@/utils/backAction'

/**
 * 浏览器「返回」接管（2026-11，与 utils/swipeBack.ts 配套）
 *
 * 为什么需要它：
 *
 * 手机浏览器 / 系统导航的「侧滑返回」是**浏览器级手势**，网页拿不到、也拦不住
 * （`preventDefault` 对 iOS Safari 的边缘手势与 Android 的手势导航都无效）。
 * 于是右滑时用户看到的不是「返回上一页」，而是浏览器真的退出了当前地址 ——
 * 应用内的子页还开着，页面却已经离开站点。
 *
 * 做法：把「覆盖层层数」镜像进浏览器历史 —— **每打开一层就压一个条目**，
 * 条目里记着当时的层数（`wbLayer`）。浏览器返回时，落到哪一条就回到几层。
 *
 * 为什么不能只压一条「守卫」反复用（2026-11 改）：
 *
 *   iOS Safari 的侧滑转场里，目标条目显示的是**那条条目自己的快照**。
 *   共用一条守卫时，它是在「刚打开第一层、页面还没画出来」那一刻压的 ——
 *   快照记的是更早的页面。于是：
 *     · 详情 → 报警预警（退一级，目标条目 = 守卫）：闪一次首页；
 *     · 报警预警 → 首页（退到站点根条目）：又是那张首页快照，然后再靠我们
 *       改状态把内容换过来，中间隔着一个历史遍历 —— 现场就是「卡几秒」。
 *   一一对应之后，每一条的快照都拍在它自己那一页上，退到哪一条都正好是
 *   用户该看到的那一页。
 *
 * 三条硬约束（都是现场事故换来的）：
 *
 *   ① **绝不在 popstate 里写历史。**
 *      popstate 到达时浏览器的历史遍历还没结束（Safari 还要播完它自己的转场）。
 *      此刻 pushState 会被排队甚至丢弃，落地之前页面停在遍历前的旧一帧上 ——
 *      用户看到的就是「卡住不动」，等它生效才「跳」到目标页。所以任何
 *      pushState / go 都推迟到遍历落定之后（SYNC_DELAY_MS）。
 *
 *   ② **压条目必须在「新页面画出来之前」。**
 *      iOS Safari 的侧滑转场是：当前页实时滑走，露出**目标历史条目的快照**；
 *      而这条快照是 WebKit 在 pushState 那一刻拍的「当时屏幕上是什么」。
 *
 *      所以以前「等进入动画播完 320ms 再压」的写法，等于是把上一层的快照
 *      覆盖成了新页 —— 从详情页右滑时，滑走的是详情页、露出的快照还是详情页，
 *      画面看着**纹丝不动**，等 popstate 到了才凭空跳成列表页（现场反馈：
 *      「右滑到一半还是显示当前页面，闪一下才变成报警预警」）。
 *
 *      现在改成**同步压、在 Vue 渲染之前**（watch 用 flush: 'sync'）：此刻 DOM
 *      还是上一页，快照记的就是用户右滑时该看到的那一页。进入动画又是从
 *      translateX(100%) 起步（首帧整页都在屏外），即便 WebKit 把抓取延后一帧，
 *      拍到的也仍然是完整的上一页。
 *
 *   ③ **返回动作只走一条路 —— 该层自己的返回按钮。**
 *      右滑返回的效果必须和点返回箭头**完全一致**（0.22s 滑出、露出真实的
 *      上一页、theme-color 按目标页切）。所以这里不自己改状态、也不抄三级优先
 *      逻辑，只点 `[data-back]`；要不要继续退下一层由 `drive()` 按层数决定。
 *
 * 幂等性：`drive()` 的目标来自历史条目里的层数，不是「再退一级」这种相对量。
 * 因此手势层、浏览器返回、页面按钮三方同时发生也不会退两级 —— 谁先落地，
 * 层数就已经对齐，后来者算出来「没有要关的」，自然什么都不做。
 *
 * ## ④ 前进方向必须「什么都不做」（2026-11-24，左滑闪首页）
 *
 * 现象：在任意页面左滑一下，页面先闪出**首页**，一两秒后又自己回到左滑前的
 * 那一页。
 *
 * 成因有两层，缺一不可：
 *
 *   1. **图里那条「多出来的条目」是前面裁出来的。** 页面内点返回 / 点底栏切
 *      tab 时，层被应用自己关掉了，历史里那条条目就没用了 —— `sync()` 用
 *      `history.go(-1)` 把它退掉。但 `go` 只能移光标，**条目本身还在**，于是
 *      它跑到了光标**前面**（前向栈）。这条条目的快照拍在它被压的那一刻 ——
 *      「那一层打开之前的屏幕」，绝大多数情况下就是**首页**（登录页、子页、
 *      全屏层几乎都是从首页进的）。用户随后切到别的 tab，快照与当前页就不
 *      再是同一张图。
 *   2. **左滑正是「前进」。** iOS Safari 右边缘左滑、桌面触控板左滑、以及部分
 *      安卓浏览器的边缘手势都会走前向遍历 —— 浏览器把光标移到那条旧条目上，
 *      并按它自己的快照演一遍转场，屏幕上就是「闪一下首页」。紧接着 `onPop`
 *      只按层数判断（`depth <= target`）走了 `settle()`，80ms 后 `sync()` 发现
 *      「条目比层数多」，再补一次 `history.go(-1)` —— 用户看到的就是「过一会儿
 *      又自己跳回原来那页」。
 *
 * 所以这个文件对前进的处置只有一条铁律：**前进不关任何层，也不发起任何遍历。**
 * 落到的条目就地把层数改写成真实层数（`replaceState` 不产生遍历、不画新帧），
 * 这样既不会「自动跳回」，也不会连演两段转场；条目和层数再次对齐，下一次
 * 返回仍按真实栈算。裁剪改成**一次 `go(-delta)` 退到位**（以前是逐条 go，
 * 每退一条都是一次遍历、一次转场），并加了验证定时器：遍历被浏览器节流吞掉时
 * 重试一次，最后退化为就地改写。
 *
 * 已知的平台边界：只要历史里存在前向条目，iOS Safari 在**手指还按着**的时候
 * 就会把那张旧快照画出来（这是系统级手势预览，网页拿不到事件也拦不住）。
 * 我们能保证的是「松手之后不跳、不弹回、不重播动画」，以及这条旧条目被用掉
 * 一次后就地归位、不会反复咬人。
 */

/**
 * popstate / 页面内关闭之后，等历史遍历落定再对齐条目（见文件头 ①）。
 * 只留一帧多一点：太小会撞上遍历，太大则这段时间里没有可返回的条目。
 */
const SYNC_DELAY_MS = 80

/** 一次返回动作的兜底窗口：比子页 0.22s 滑出略长，动画被打断时靠它继续 */
const CLOSE_TIMEOUT_MS = 360

/** 裁剪时一次最多退几条（层数上限 = cam/air/hazard/sheet + 子页两级） */
const MAX_TRIM_DELTA = 6

/** 裁剪重试次数上限：遍历被节流 / 条目不够时最多再试一次，之后就地改写 */
const MAX_TRIM_TRIES = 2

/** 裁剪后验证遍历是否真的发生（Safari 会节流/丢弃 go） */
const TRIM_VERIFY_MS = 400

/** 读出历史条目里记录的层数（没有 / 非法都当 0） */
function layerOf(state: unknown): number {
  if (!state || typeof state !== 'object') return 0
  const n = (state as { wbLayer?: unknown }).wbLayer
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 在已有 state 上改写 wbLayer（保留其他字段，别把别人压的 state 冲掉） */
function withLayer(state: unknown, layer: number): Record<string, unknown> {
  const next: Record<string, unknown> =
    state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {}
  if (layer > 0) next.wbLayer = layer
  else delete next.wbLayer
  return next
}

export function useHistoryBack(): void {
  const cam = useCamStore()
  const air = useAirHazardStore()
  const sheet = useBottomSheetStore()
  const sub = useSubpageStore()

  /**
   * 覆盖层层数 —— 与历史条目**一一对应**。
   *
   * 子页另算：`back` 非空说明是从下一级页面点进来的（列表 → 详情），
   * 这时有两个「层」可退，浏览器也该有两条条目。
   */
  const depth = computed(() => {
    let d = 0
    if (cam.isOpen) d += 1
    if (air.hazardOpen) d += 1
    if (air.isOpen) d += 1
    if (sheet.isOpen) d += 1
    if (sub.isOpen) d += sub.back ? 2 : 1
    return d
  })

  let syncTimer = 0
  let settleTimer = 0
  /** 裁剪后的验证定时器（见 TRIM_VERIFY_MS） */
  let trimTimer = 0
  /** 前进落地后就地改写层数的复核定时器 */
  let forwardTimer = 0
  /** 本轮连续裁剪已经试了几次（超过 MAX_TRIM_TRIES 就地改写，防死循环） */
  let trimTries = 0

  /** 浏览器返回的目标层数；-1 表示当前没有在处理的浏览器返回 */
  let wantDepth = -1
  /** 已经发出一次返回、正在等它落定（层数还没降） */
  let inflight = false

  /** 当前历史条目记录的层数 */
  function currentLayer(): number {
    return layerOf(history.state)
  }

  /** 只改当前条目的层数，不新增条目 */
  function setLayer(layer: number): void {
    history.replaceState(withLayer(history.state, layer), '')
  }

  /** 压一条新条目（URL 不变，只是多一个可被浏览器返回消费的历史步） */
  function pushLayer(layer: number): void {
    history.pushState(withLayer(history.state, layer), '')
  }

  /**
   * 让历史条目与真实层数对齐。
   *
   * 延迟执行：popstate 之后浏览器的历史遍历可能还没结束，此刻写历史会被排队
   * 甚至丢弃（文件头 ①）。这段时间里条目数可能偏少（刚打开一层）或偏多
   * （页面内把层关掉了），两种情况都在这里收口。
   */
  function scheduleSync(delay = SYNC_DELAY_MS): void {
    window.clearTimeout(syncTimer)
    syncTimer = window.setTimeout(() => {
      syncTimer = 0
      sync()
    }, delay)
  }

  function sync(): void {
    const cur = currentLayer()
    const want = depth.value
    if (cur === want) {
      trimTries = 0
      window.clearTimeout(trimTimer)
      trimTimer = 0
      return
    }
    if (cur < want) {
      // 补漏（打开层时的同步压栈被后台挂起吞掉了）：缺几条补几条
      trimTries = 0
      pushNow(want)
      return
    }
    /*
     * 条目比真实层数多：层是被页面自己的按钮 / 底栏切 tab 关掉的，历史里那几条
     * 已经没用了。留着它们，用户下次按返回会「什么都没发生」。
     *
     * 退法（2026-11-24 改）：**一次 go(-delta) 退到位**。以前是每次 go(-1) 等
     * 一个 settle 循环再退下一条，每条都是一次独立的历史遍历，浏览器会为每次
     * 遍历各演一遍转场 —— 「闪一下、过一会儿又闪一下」的节奏就是它给的。
     */
    const delta = cur - want
    if (trimTries >= MAX_TRIM_TRIES) {
      /*
       * 兜底：go 被浏览器节流 / 丢弃（Safari 在转场与后台期间确实会），或者
       * 条目根本不够退。再退下去就是死循环，就地改写当前条目 —— 条目数虽然
       * 还多着，但「层数」这一栏与真实状态是自洽的，后续返回仍按它算。
       */
      trimTries = 0
      setLayer(want)
      return
    }
    trimTries += 1
    history.go(-Math.min(delta, MAX_TRIM_DELTA))
    // 验证遍历真的发生了：没有 popstate 就再试一次，最终退化为上面的就地改写
    window.clearTimeout(trimTimer)
    trimTimer = window.setTimeout(() => {
      trimTimer = 0
      if (currentLayer() > depth.value) sync()
    }, TRIM_VERIFY_MS)
  }

  /**
   * 立刻把条目压到 target 层（见文件头 ②）。
   *
   * 只在「打开一层」时调用，而且必须发生在 Vue 渲染之前：WebKit 拍条目快照
   * 用的是此刻屏幕上的画面。晚一帧就是新页，上一层的快照就被污染成新页了。
   *
   * 用 while 补齐：一次动作可能连开两层（列表 + 详情），两条都要有。
   */
  function pushNow(target: number): void {
    let cur = currentLayer()
    while (cur < target) {
      cur += 1
      pushLayer(cur)
    }
  }

  /** 点该层的返回按钮；返回 false 表示这一层根本没渲染出来 */
  function clickBack(selector: string): boolean {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) return false
    el.click()
    return true
  }

  /**
   * 执行最上层的「返回」。
   *
   * 优先级按层级：监控(90) > 隐患填报(90，DOM 在航拍之后) > 航拍(90) >
   * 弹层(45) > 子页(40)。前四者点各自的 `[data-back]`，弹层走 store 的 close ——
   * 都没有复制各层自己的三级优先逻辑（收日历 / 回上一级 / 关闭）。
   */
  function fireBack(): boolean {
    if (cam.isOpen) return clickBack('.cam-player.open [data-back]')
    if (air.hazardOpen) return clickBack('.hazard-page.open [data-back]')
    if (air.isOpen) return clickBack('.air-player.open [data-back]')
    if (sheet.isOpen) {
      sheet.close()
      return true
    }
    /*
     * 浏览器返回（popstate）引起的关闭：不补 0.22s 滑出。
     *
     * 浏览器（Safari / 微信内置）通常已经自己演过一遍转场，我们再滑一次就是
     * 「页面还停在详情，闪一下才变成报警预警」。标记放在这里而不是 onPop：
     * 一次浏览器返回可能连关两层（详情 → 列表 → 首页），每层都不能补。
     */
    markSilentBack()
    return clickBack('.subpage.open:not(.subpage-under) [data-back]')
  }

  /**
   * 逐层关到 wantDepth。
   *
   * 每层都走它自己的返回按钮，所以关一层可能立刻生效（弹层 / 监控这类同步关），
   * 也可能要等 0.22s 滑出动画结束才降层数（子页）。用 `inflight` 串行：一次只
   * 发一个返回动作，等它落定再看要不要继续 —— 否则「连滑两下」时第二次会被
   * SubPage 的 leaving 窗口挡掉，历史却已经退了两级，两边就错位了。
   */
  function drive(): void {
    if (wantDepth < 0) return
    if (depth.value <= wantDepth) {
      wantDepth = -1
      inflight = false
      settle()
      return
    }
    if (inflight) return

    inflight = true
    if (!fireBack()) {
      // 该层没有可点的返回按钮（理论上不会发生）：放弃，别让它一直重试
      inflight = false
      wantDepth = -1
      setLayer(depth.value)
      return
    }
    if (depth.value <= wantDepth) {
      inflight = false
      wantDepth = -1
      settle()
      return
    }
    // 等层数变化（watch 接力）；这里的定时器只兜底动画被打断的情况
    window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      settleTimer = 0
      if (!inflight) return
      inflight = false
      drive()
    }, CLOSE_TIMEOUT_MS)
  }

  /** 一次返回落定后把条目对齐 */
  function settle(): void {
    window.clearTimeout(settleTimer)
    settleTimer = 0
    scheduleSync()
  }

  function onPop(e: PopStateEvent): void {
    const target = layerOf(e.state)

    /*
     * ① 目标条目的层数**不小于**真实层数：这一趟不该关任何层。
     *
     * 两种情况都落在这里，而它们的共同点正是「没有层要关」：
     *   · 前进 —— 用户左滑 / 点了浏览器前进，落到的往往是一条被裁掉的旧条目
     *     （`sync()` 用 go 退掉、但条目本身留在前向栈里，快照是首页）；
     *   · 条目比真实层数还多 —— 层已经被页面自己的按钮关掉了。
     *
     * 这里的处置是 2026-11-24 修「左滑闪首页」的核心：**不 drive、不 settle，
     * 更不允许任何 history.go**。
     *
     * 旧写法无论哪种情况都走 `settle()` → 80ms 后 `sync()` 发现「条目比层数多」
     * 再补一次 `history.go(-1)`：浏览器先按旧条目自己的快照演一遍（首页），
     * 过一会儿又被我们退回来 —— 现场就是「闪一下首页，几秒后自动恢复」。
     *
     * 现在改成**就地改写**：`replaceState` 既不产生遍历也不画新帧，画面与状态
     * 一动不动，条目与层数立刻重新自洽（下一次返回仍按真实栈算）。
     */
    if (target >= depth.value) {
      wantDepth = -1
      inflight = false
      window.clearTimeout(settleTimer)
      settleTimer = 0
      if (target > depth.value) {
        // 任何在排队的对齐都不许再发 go（那正是「自动跳回」的来源）
        window.clearTimeout(syncTimer)
        syncTimer = 0
        window.clearTimeout(trimTimer)
        trimTimer = 0
        trimTries = 0
        setLayer(depth.value)
        /*
         * popstate 里写历史有被排队 / 丢弃的先例（文件头 ①），所以落定之后再
         * 确认一次。**只改写、不 go**：这一步必须无条件保持「不产生遍历」，
         * 否则又变回「闪一下再跳回来」。
         */
        window.clearTimeout(forwardTimer)
        forwardTimer = window.setTimeout(() => {
          forwardTimer = 0
          if (wantDepth >= 0) return
          if (currentLayer() !== depth.value) setLayer(depth.value)
        }, SYNC_DELAY_MS)
        return
      }
      // 目标层数正好等于真实层数：本来就没有要关的，对齐一下即可（对齐时空转）
      settle()
      return
    }

    // ② 真正的浏览器返回：关到这条历史条目对应的层数
    wantDepth = target
    drive()
  }

  /**
   * 页面重新可见（后台切回 / 从 bfcache 恢复）时把条目对齐。
   *
   * 手机在浏览器转场或切后台期间可能挂起 web 进程，期间的定时器与事件都会被
   * 延后/吞掉 —— 打开层时那次压栈可能没来得及执行。不补的话，用户下一次右滑
   * 就真的退出站点了。
   */
  function onResume(): void {
    if (document.visibilityState === 'hidden') return
    if (wantDepth >= 0) return
    scheduleSync()
  }

  watch(
    depth,
    (next, prev) => {
      if (prev === undefined) {
        // 挂载时可能已经有一层开着（未登录会直接弹登录页）。这一刻 onMounted
        // 还没把上一轮残留的层数改写掉，不能同步压，等对齐完再说（文件头 ①）。
        scheduleSync()
        return
      }
      if (next === prev) return

      if (next > prev) {
        /*
         * 打开一层：**同步**压条目（文件头 ②）。
         *
         * flush: 'sync' 保证这里还跑在 store 改动的同一个调用栈里，DOM 一点
         * 没动 —— WebKit 拍到的快照才是「上一页」，右滑跟手时露出的就是它。
         */
        pushNow(next)
        return
      }

      // 层数变少
      window.clearTimeout(settleTimer)
      settleTimer = 0
      inflight = false
      if (wantDepth >= 0) {
        // 是刚才那次浏览器返回落定了，继续关到目标层数
        drive()
        return
      }
      // 页面内自己关掉的：把多余的条目退掉
      scheduleSync()
    },
    /*
     * flush: 'sync' 是这里的关键（文件头 ②）：只有同步触发，pushState 才赶在
     * Vue 把新页面画出来之前落地，WebKit 给条目拍的快照才是上一页。
     */
    { immediate: true, flush: 'sync' },
  )

  onMounted(() => {
    /*
     * 关掉浏览器的滚动恢复：子页是「同一个文档换内容」，浏览器按历史条目恢复
     * 滚动位置只会把目标页滚到上一页残留的偏移上。滚动位置由各页面自己管。
     */
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

    /*
     * 刷新时当前条目可能还带着上一轮会话的层数（刷新后覆盖层都没了）。
     * 直接把它改写成 0，**不能用 history.go 退** —— 那会退到上一轮的条目上去，
     * 手机上表现为「一刷新就跳走甚至重新加载」。改写只影响当前条目，安全。
     */
    if (currentLayer() > 0) setLayer(0)

    // 不用 passive / preventDefault：popstate 不可取消，只做接管
    window.addEventListener('popstate', onPop)
    window.addEventListener('pageshow', onResume)
    document.addEventListener('visibilitychange', onResume)
  })

  onUnmounted(() => {
    window.removeEventListener('popstate', onPop)
    window.removeEventListener('pageshow', onResume)
    document.removeEventListener('visibilitychange', onResume)
    window.clearTimeout(syncTimer)
    window.clearTimeout(settleTimer)
    window.clearTimeout(trimTimer)
    window.clearTimeout(forwardTimer)
  })
}
