import { nextTick, onMounted, onUnmounted } from 'vue'

import { useAirHazardStore } from '@/stores/airHazard'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { takeBackSlot } from '@/utils/backAction'

/**
 * 右滑返回（2026-10 新增，微信式）
 *
 * 手指从左边缘起手向右滑，当前覆盖层跟手右移；松手时超过阈值就滑出并返回
 * 上一级，未超过则回弹。返回动作本身不重写各层的三级优先逻辑，而是去点
 * 该层顶部的 `[data-back]` 按钮 —— 这样「子页先回列表再关」「监控先关大图
 * 再收日历」这些既有回路一条都不用复制，手势与点按钮永远同一套行为。
 *
 * 几个刻意为之的约束：
 *   · 只在左边缘 24px 内起手（与微信一致）。页面里的普通横向拖动、图表
 *     触控、卡片滑动都不受影响。
 *   · 进入手势前先判方向：纵向为主就立刻撒手，不干扰列表滚动；**向左滑一律
 *     不接管**（它不是返回，浏览器会把它当「前进」），起手记录同时清干净。
 *   · 全屏地图不接管 —— 它的拖拽本身就是平移地图，边缘手势会跟它抢。
 *   · **不再按平台让位**（2026-11 改）：以前 iOS Safari 上整个手势直接 return，
 *     理由是 Safari 自己也在这条边缘起手。代价是右滑时页面纹丝不动 —— 用户
 *     看到的永远是当前页，等浏览器把返回交回来才「闪」一下换成上一页。
 *     现在所有平台都跟手：Safari 一旦接管，它会把页面冻成快照、我们的位移
 *     也随之不可见，再由 onCancel 冻结 + popstate 落状态收尾；没被接管时
 *     就是一次正常的跟手返回。
 *   · 底部弹层开着时不接管 —— 模态层在上，右滑只能是针对弹层的操作。
 *   · 横屏（监控）不接管 —— 坐标系变了，手势方向与视觉不符。
 *   · 图片已放大时不接管 —— 那会儿单指拖动是平移图片。
 *
 * 与浏览器级侧滑（historyBack.ts）的冲突（2026-11 修）：
 *
 * 手机上真机右滑时，**两个手势会同时开始** —— 浏览器认领它的侧滑返回，本文件
 * 也已经从边缘起手把层位移了。浏览器接管后往往只发 popstate，不再补
 * pointerup / pointercancel，于是：
 *   · 内联 `transform: translate3d(66px…)` 永远留在 .subpage 上；
 *   · `layer / active / tracking` 也一直悬着。
 * 后果不是当次能看出来的：下一次进详情时进入动画播完（animation 盖住内联样式），
 * 元素「啪」地跳回 66px 偏移位置 —— 页面看起来卡住不动；再摸屏还会被这份陈旧
 * 手势继续拖动，甚至一滑就整页滑出。点返回键不走手势层，所以不会复现。
 *
 * 处理：popstate 一到就 `abortGesture()`（立即归位，不播动画，返回动作交给
 * historyBack 去点按钮），并且每次 pointerdown 也先清一次陈旧手势兜底。
 */

/** 左边缘起手区宽度 */
const EDGE = 24
/** 判定为水平手势前允许的抖动 */
const SLOP = 8
/** 松手触发返回的位移阈值 */
const TRIGGER = 76
/** 快速轻扫的速度阈值（px/ms），达到即不必滑满 TRIGGER */
const FLING = 0.45
/** 跟手阻尼：手指走 100px，页面走 55px */
const DAMPING = 0.55
/** 回弹时长 */
const SLIDE_MS = 200
/** 指针被抢走后等 popstate 的窗口（见 onCancel）。略长于 Safari 侧滑转场 */
const HOLD_MS = 400
/**
 * 松手返回后撤揭示态的兜底时长。
 *
 * 正常由 SubPage 在 0.22s 滑出结束、视图换完之后撤；这里只是动画被打断时的
 * 兜底（撤早了状态栏会退回白底，顶部再闪一条白条）。
 */
const LEAVE_FALLBACK_MS = 400

export function useSwipeBack() {
  const sub = useSubpageStore()
  const cam = useCamStore()
  const air = useAirHazardStore()
  const shell = useShellStore()
  const sheet = useBottomSheetStore()

  let tracking = false
  let active = false
  let busy = false
  let layer: HTMLElement | null = null
  /**
   * 指针被浏览器抢走后「冻住」的节点（见 onCancel）。
   *
   * 它不在 layer 里（layer 只表示正在跟手），但位移还在它身上，abortGesture
   * 与新的 pointerdown 都必须能收拾它。
   */
  let held: HTMLElement | null = null
  /** 本次手势的指针 id：多指 / 中途换指时不让别的指头接着拖 */
  let pid = -1
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastT = 0
  let velocity = 0
  let timers: number[] = []
  /** 手势起手时「哪一层开着」的指纹，用来判断这次返回是否已被别人做掉 */
  let tokenAtStart = ''

  /** 当前最上层、可被「返回」关闭的覆盖层（互斥打开，最多一个） */
  function topLayer(): HTMLElement | null {
    if (cam.isOpen) return document.querySelector<HTMLElement>('.cam-player.open')
    if (air.isOpen) return document.querySelector<HTMLElement>('.air-player.open')
    if (air.hazardOpen) return document.querySelector<HTMLElement>('.hazard-page.open')
    // 排除 subpage-under：那一层是垫在下面供右滑露出的只读上一页，不该被位移
    if (sub.isOpen) return document.querySelector<HTMLElement>('.subpage.open:not(.subpage-under)')
    return null
  }

  /** 复用各层自己的返回按钮，避免复制三级优先逻辑 */
  function fireBack(): void {
    // 浏览器侧滑（historyBack）可能在同一动作的几十毫秒内也点一次，去抖挡住
    if (!takeBackSlot()) return
    document
      .querySelector<HTMLElement>(
        '.cam-player.open [data-back], .air-player.open [data-back], .hazard-page.open [data-back], .subpage.open:not(.subpage-under) [data-back]',
      )
      ?.click()
  }

  function clearInline(el: HTMLElement): void {
    el.style.transition = ''
    el.style.transform = ''
  }

  /**
   * 放弃这次起手：`tracking` 归位，并把 `layer` / `pid` 一并清掉。
   *
   * 只写 `tracking = false`（以前的写法）会把 `layer`（「正在跟手的层」）和
   * `pid` 悬在那里：下一次 pointerdown 进来先撞上 `if (tracking || layer || held)
   * abortGesture()`，白做一遍清理。向左滑尤其明显 —— 它一像素都没位移过，
   * 却像刚被硬中断过一次手势；而左滑本身在浏览器里还可能被当成「前进」，
   * 两层叠加起来就是现场那句「左滑之后页面闪一下首页又自己回来」。
   * 清干净之后，「左滑 = 什么都没发生」才是字面意义上的什么都没发生。
   */
  function giveUp(): void {
    tracking = false
    layer = null
    pid = -1
  }

  function appEl(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.app')
  }

  /** 收起跟手期间揭示的底栏（子页归位或被关闭后调用） */
  function releaseSwipeState(): void {
    sub.leaving = false
    appEl()?.classList.remove('is-swipe-back')
  }

  /**
   * 当前「哪一层开着」的指纹。
   *
   * 松手落定时比一次：浏览器级返回（popstate → historyBack）有可能在
   * pointerup 之前就把这一级关掉了。此时再点一次返回按钮就是「一次右滑退两级」
   * （详情直接退到首页）。只判 `.open` 不够 —— 子页从详情退回列表时层还开着，
   * 只是内容换了。
   */
  function layerToken(): string {
    return JSON.stringify([cam.isOpen, air.isOpen, air.hazardOpen, sheet.isOpen, sub.view, sub.back])
  }

  function stopTimers(): void {
    timers.forEach((t) => window.clearTimeout(t))
    timers = []
  }

  /**
   * 立即放弃当前手势：清掉位移与跟手态，**不**触发返回、也不播收尾动画。
   *
   * 两个场景都靠它：
   *   · 浏览器接管了这次侧滑（popstate 到达）—— 返回已经由 historyBack 负责，
   *     这里只把自己捅的位移收拾干净，否则会残留一份内联 transform；
   *   · 新的 pointerdown 到来时发现上一次手势没收尾（没收到 pointerup /
   *     pointercancel），先清再重新判断，避免陈旧手势继续拖动新页面。
   */
  function abortGesture(): void {
    const node = layer ?? held
    tracking = false
    active = false
    busy = false
    layer = null
    held = null
    pid = -1
    document.body.style.userSelect = ''
    stopTimers()
    if (node) clearInline(node)
    releaseSwipeState()
  }

  function onDown(e: PointerEvent): void {
    // 上一次手势没收到收尾事件（浏览器接管了侧滑）就先清掉，见文件头注释
    if (tracking || layer || held) abortGesture()
    if (busy || shell.isLand) return
    /*
     * 弹层是模态：它开着时，底下的子页不该被推走。
     * 弹层自身的左边缘也落在起手区里（遮罩从 x=0 起铺），不挡住的话
     * 用户想在弹层上右滑关闭，页面反而先滑出去了。
     */
    if (sheet.isOpen) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.clientX > EDGE) return
    // 图片放大态下，单指拖动是在平移图片，别抢
    if ((e.target as Element | null)?.closest?.('img.zoomable.is-zoomed')) return

    const el = topLayer()
    if (!el) return

    tracking = true
    active = false
    layer = el
    pid = e.pointerId
    startX = e.clientX
    startY = e.clientY
    lastX = e.clientX
    lastT = performance.now()
    velocity = 0
    tokenAtStart = layerToken()
  }

  function onMove(e: PointerEvent): void {
    if (!tracking || e.pointerId !== pid) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY

    if (!active) {
      /*
       * 纵向为主 → 用户要滚页面；向左 → 不是返回手势。
       * 两条都立刻撒手、不做任何接管，并且**把起手记录整条清掉**（见 giveUp）。
       *
       * 向左滑为什么必须彻底撒手：它不是「返回」，而是浏览器 / 系统层面的
       * 「前进」（iOS 右边缘左滑、桌面触控板左滑）。应用内一像素都不该动，
       * 剩下的交给 utils/historyBack.ts 的方向判定 —— 那边保证前进不关层、
       * 不发任何 history.go。
       */
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) {
        giveUp()
        return
      }
      if (dx < -SLOP) {
        giveUp()
        return
      }
      if (dx < SLOP) return
      active = true
      document.body.style.userSelect = 'none'
      // 入场动画进行中就被右滑：动画（animation 优先级高于内联 style）会吃掉
      // 跟手位移，必须先摘掉它
      layer?.classList.remove('is-entering', 'is-leaving')
      // 子页打开时底栏是「不可见但仍占位」（见 app.css 的 :has 规则）。
      // 跟手一开始就把它显出来：右滑揭示的是一级页面 + 底栏的完整形态，
      // 与松手后落点的布局完全一致，不会出现「页面往上跳一下」。
      //
      // 只有「上一层是一级页面」（sub.back 为 null）才切：从详情滑回列表/历史时，
      // 揭示目标仍是子页（白顶浅底），切到首页形态会让顶部主题色与底部底栏
      // 在手机上闪出一黑一灰两块。
      if (sub.isOpen && !sub.back) {
        // theme-color 也要提前切（iPhone 系统状态栏只认它）
        sub.leaving = true
        appEl()?.classList.add('is-swipe-back')
      }
      // 刻意不重置 lastX/lastT：一次「快速轻扫」往往只产生一两个 move 事件，
      // 若在这里把基准挪到当前点，这一帧永远算不出速度，轻扫就会失灵。
      // 基准保持 pointerdown 时的位置与时刻（见 onDown）。
    }

    const now = performance.now()
    if (now > lastT) velocity = (e.clientX - lastX) / (now - lastT)
    lastX = e.clientX
    lastT = now

    if (layer) {
      layer.style.transition = 'none'
      layer.style.transform = `translate3d(${Math.max(0, dx * DAMPING)}px, 0, 0)`
    }
  }

  /** commit=true 走「返回」；否则回弹归位 */
  function finish(commit: boolean): void {
    tracking = false
    const node = layer
    layer = null
    document.body.style.userSelect = ''
    active = false

    if (commit) {
      /*
       * 松手就立刻去点返回按钮 —— **和手指点返回箭头走的是同一条路**：
       * SubPage.onBack 加 `is-leaving`、播同一段 0.22s 滑出、到点再落状态。
       *
       * 这里只做一件事：把手势留下的内联位移清掉。不清的话 animation 的
       * from 会被内联 style 抢先（起点不是 0），动画看起来像从半路开始；
       * 清掉之后起点就是 0，与点返回逐帧一致。
       *
       * 旧写法是「自己推 translate3d(100%) + 等 200ms 再点按钮」，结果是手势
       * 先播一段、浏览器侧滑再播一段、返回按钮又补一段 —— 现场观感就是
       * 「松开手了画面还在动，过一会儿才换页」。
       */
      if (node) clearInline(node)
      // 浏览器级返回可能抢先把这一级关掉了，别再点一次（会退两级）
      const fired = layerToken() === tokenAtStart
      if (fired) fireBack()
      /*
       * 揭示态（`sub.leaving` / `.is-swipe-back`）**不能在这里撤**。
       *
       * 被点的返回按钮刚把 0.22s 滑出挂上，子页还盖着大半个屏幕。这时一撤，
       * 状态栏的「揭示态透明」规则就失效、退回白底 —— 右滑松手后顶部会再闪
       * 一条白条，而点返回箭头没有这一段（不一致）。交给 SubPage 在滑出结束、
       * 视图换完之后撤。
       *
       * 定时器只兜底：滑出被打断（层被别处关掉、组件卸载）时也要收尾。
       */
      if (fired) timers.push(window.setTimeout(releaseSwipeState, LEAVE_FALLBACK_MS))
      else void nextTick(releaseSwipeState)
      return
    }

    if (!node) {
      releaseSwipeState()
      return
    }

    // 回弹：手指没滑够，退回原位
    node.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1)`
    busy = true
    timers.push(
      window.setTimeout(() => {
        clearInline(node)
        releaseSwipeState()
        busy = false
      }, SLIDE_MS + 60),
    )
  }

  function onUp(e: PointerEvent): void {
    if (!tracking || e.pointerId !== pid) return
    if (!active) {
      // 只是点了一下左边缘，什么也不做（起手记录一并清掉）
      giveUp()
      return
    }
    const dx = e.clientX - startX
    finish(dx >= TRIGGER || (dx >= 40 && velocity >= FLING))
  }

  /**
   * 指针被浏览器 / 系统抢走（侧滑导航最常见的收尾方式）。
   *
   * 这里**不能**立刻回弹：真机上浏览器是在自己开始播侧滑转场时才 cancel 掉
   * 我们的指针，紧接着（百来毫秒后）才派发 popstate。若在这里弹回去，现场
   * 看到的就是「滑出去 → 又弹回来 → 再滑出去」三段画面。
   *
   * 所以先原地冻住位移，给 popstate 一个窗口：它一来 abortGesture 清位移、
   * 由返回按钮播正常的滑出；窗口内没来（就是一次普通的中断）再回弹。
   */
  function onCancel(): void {
    if (!tracking) return
    if (!active || !layer) {
      giveUp()
      return
    }
    const node = layer
    tracking = false
    active = false
    layer = null
    pid = -1
    document.body.style.userSelect = ''
    node.style.transition = 'none'
    held = node
    busy = true
    timers.push(
      window.setTimeout(() => {
        if (held !== node) return
        held = null
        busy = false
        node.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1)`
        node.style.transform = ''
        timers.push(
          window.setTimeout(() => {
            clearInline(node)
            releaseSwipeState()
          }, SLIDE_MS + 60),
        )
      }, HOLD_MS),
    )
  }

  /**
   * 浏览器消费掉了这次返回（手机边缘侧滑由浏览器认领）。
   *
   * 此时返回动作已经由 historyBack 去点按钮完成，应用内手势必须立刻撒手：
   * 既不能留位移，也不能等到迟迟不来的 pointerup 再补一次 fireBack（那会
   * 一次右滑退两级）。没有手势在跑时它是空操作。
   */
  function onPopState(): void {
    abortGesture()
  }

  onMounted(() => {
    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onUp, { passive: true })
    window.addEventListener('pointercancel', onCancel, { passive: true })
    window.addEventListener('popstate', onPopState)
  })

  onUnmounted(() => {
    window.removeEventListener('pointerdown', onDown)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('popstate', onPopState)
    stopTimers()
    document.body.style.userSelect = ''
    releaseSwipeState()
    if (layer) clearInline(layer)
    if (held) clearInline(held)
  })
}
