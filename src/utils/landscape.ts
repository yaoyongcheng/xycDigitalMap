import { onBeforeUnmount, onMounted, ref, type ComponentPublicInstance, type Ref } from 'vue'

import {
  enterNativeLandscape,
  exitNativeLandscape,
  isSystemFullscreen,
  isTouchDevice,
  settleViewport,
} from '@/utils/orientation'
import { openLandscapeHint } from '@/utils/landscapeHint'

/**
 * 「全屏查看」—— 大图 / 全景共用的一个开关（2026-11-18 抽出，2026-11-23 升级）。
 *
 * 两种模式，差别只在「谁进系统全屏」：
 *
 *   · **默认（画布全屏）**：`land = true` 铺满视口，再把画布元素本身塞进系统
 *     全屏。画面独占屏幕、页面上其他东西（含提示条）也被一起藏掉，所以这条
 *     路径**不能**给用户弹提示 —— 弹了也看不见。CamPlayer 的抓拍大图、
 *     AirPlayer 的全景用它。
 *
 *   · **`page`（整页全屏）**：`land = true` 之后对 `documentElement` 申请全屏
 *     —— 与首页背景图那个「全屏」按钮同一套 `utils/orientation.ts`。整页都进
 *     全屏，所以 `.phone-screen` 里的横屏提示卡也能一起显示。智眸的照片 /
 *     全景查看走这条。
 *
 * 两个模式共同的第二件事：`screen.orientation.lock('landscape')` 尽量锁横屏，
 * 失败不抛错。iOS 上全屏与锁方向都拿不到（Safari 没有
 * `Element.requestFullscreen`），只能靠 `.is-land` 铺满视口 + 提示用户自己
 * 横转手机 —— 但这**不能**当成错误，用户照样能看。
 *
 * 为什么做成 composable：一个弹层里有两块画布（VR 360 环视的球面 / 单张照片），
 * 两套开关必须是**各自独立**的状态；复制一遍代码只会让两边慢慢长歪。
 */
export interface LandscapeOptions {
  /**
   * 对 `documentElement` 申请系统全屏（整页全屏），而不是对画布元素全屏。
   * 需要「全屏失败时弹提示」就必须开它 —— 提示卡挂在 `.phone-screen` 里，
   * 画布全屏时它在全屏元素外面，看不见。
   */
  page?: boolean
  /**
   * 进全屏后仍是竖屏 → 摆出「把手机横过来看」的提示。
   *
   * **只有智眸 VR 360 环视的项目全景全屏用它**（2026-11-24 现场口径）。
   * 首页全屏地图、监控播放器、抓拍大图、航拍全景都不带 —— 那句引导是给
   * 「球面全景在竖屏里只剩一条窄缝、不转屏没得看」这个场景写的，
   * 其它全屏画面不转过去也照样能看清，不该拦住视线。
   */
  hint?: boolean
}

export interface Landscape {
  /** 当前是否处于全屏查看（同时也是「画布要不要 Teleport 到 body」的开关） */
  land: Ref<boolean>
  /**
   * 绑到要铺满视口的那块画布上：模板里写 `:ref="setStage"`。
   *
   * 用函数 ref 而不是 `ref="名字"`：字符串 ref 在 `<script setup>` 里靠作用域
   * 变量名匹配，`vue-tsc` 那边不算「被使用」，会把 ref 报成 TS6133。
   *
   * `page` 模式下不对它申请全屏，但保留绑定：调用方模板不用为模式差异分叉。
   */
  setStage: (el: Element | ComponentPublicInstance | null) => void
  /** 进全屏 */
  enter: () => Promise<void>
  /** 退全屏 */
  exit: () => Promise<void>
  /** 按当前状态切换（按钮就调这个） */
  toggle: () => Promise<void>
}

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'any' | 'landscape' | 'portrait') => Promise<void>
  unlock?: () => void
}

/**
 * 全屏状态怎么和系统对齐（2026-11-24）
 *
 * `land` 和「系统是否真的在全屏」是两套状态，任何时候都得能对上：
 *
 *   · `land === true`  → 画布铺满视口（`.is-land` + Teleport），按钮写「退出」
 *   · `land === false` → 回到弹层里的原位，按钮写「全屏」
 *
 * 现场故障：iOS 上「进全屏 → 横屏 → 再竖屏 → 点退出」，退不出来。
 * 根因是三个关键决定**全都**押在 `document.fullscreenElement` 上，而 iOS 上它
 * （连同 `webkitFullscreenElement`）在旋转的那一瞬间会先报 null 再恢复：
 *
 *   1. `fullscreenchange` 一到就 `land=false` —— 旋转会连发事件，一次误读就把
 *      铺满的画面收掉；而系统还停在全屏里，「退出」按钮于是变回「全屏」，
 *      **从此没有任何代码再去发 `exitFullscreen`** —— 人就出不来了；
 *   2. `exit()` 先 `land=false` 再退全屏 —— 出口比系统状态先消失，同上；
 *   3. 退失败后的复查也以这个属性为前提 —— 属性读 null 就永远不复查。
 *
 * 所以现在三条规则：
 *   · 消失事件**不立刻**收 UI，等 600ms 二次确认（`scheduleDropCheck`）；
 *   · 退出**先退系统全屏**，确认退掉再收 UI；退不掉就留着「退出」让用户再点；
 *   · 转屏（`orientationchange` / `resize`）后对账一次：系统还在全屏、UI 却已收
 *     → 主动补一次退出，把人放出来（`reconcile`）。
 */
export function useLandscape(options: LandscapeOptions = {}): Landscape {
  const land = ref(false)
  const stageEl = ref<HTMLElement | null>(null)

  /** 退全屏进行中：挡掉连点，别让第二次 toggle 又把刚关掉的打开 */
  let exiting = false
  /**
   * 这一次**真的**进过系统全屏（`requestFullscreen` 生效过，或读到过全屏元素）。
   *
   * 只用来决定「退出时要不要等系统确认」：iOS 传统路径压根进不了系统全屏，
   * 那边不该为了一个不存在的全屏去等 1.3 秒；真进过的那条路才值得等，
   * 也才需要「退不掉就别收 UI」这个保护。
   */
  let enteredSystem = false
  /** 「系统全屏没了」的二次确认定时器（旋转期间会误报） */
  let dropTimer = 0
  /** 转屏对账的防抖定时器 */
  let reconcileTimer = 0
  /**
   * 最近一次「UI 已收」的时刻。
   *
   * 对账里那条「系统还在全屏、UI 已收 → 补一次退出」只在这个窗口内生效（6s）：
   * 同一页面里另一块画布（照片 / 航拍全景）也可能正开着自己的系统全屏，
   * 不能因为这里 `land` 是 false 就把别人刚打开的全屏退掉。
   */
  let droppedAt = 0
  /**
   * 转屏进行中的截止时刻。
   *
   * 转屏期间 WebKit 会连发 `fullscreenchange`，而且属性可能连续几百毫秒读成 null。
   * 这段窗口里「全屏没了」的二次确认要等更久（900ms），窗口之外只需要 280ms ——
   * 系统方式退出（安卓返回 / Esc）时不该让用户对着黑屏等半秒。
   */
  let rotatingUntil = 0

  function setStage(el: Element | ComponentPublicInstance | null): void {
    stageEl.value = el instanceof HTMLElement ? el : null
  }

  async function enter(): Promise<void> {
    if (land.value || exiting) return
    // 先切样式：Teleport 的 :disabled 靠它，元素得先在 body 上，再谈全屏
    land.value = true

    if (options.page) {
      /*
       * 整页全屏：`enterNativeLandscape` 内部会 `requestFullscreen` →
       * `orientation.lock('landscape')` → 等 320ms 转屏动画 → 用「视口宽 > 高」
       * 判成败。这里必须在 click 的同步栈里调到它，隔一个 await 就丢手势。
       */
      const ok = await enterNativeLandscape()
      enteredSystem = enteredSystem || isSystemFullscreen()
      /*
       * 320ms 的等待里用户可能已经点了「退出」：那时 `land` 已经收回，
       * 若系统其实进了全屏，这里得替他把系统层也退掉 —— 否则画面留在全屏、
       * UI 却已经回到弹层，又是一次「关不掉」。
       */
      if (!land.value) {
        if (isSystemFullscreen()) void exitNativeLandscape()
        return
      }
      // 桌面没有横屏概念（窗口高窄时 innerWidth 会小于 innerHeight），不提示
      if (!ok && options.hint && isTouchDevice()) openLandscapeHint()
      return
    }

    try {
      await stageEl.value?.requestFullscreen?.({ navigationUI: 'hide' })
    } catch {
      /* 不支持 / 被拒绝：留在铺满视口的形态 */
    }
    try {
      await (screen.orientation as LockableOrientation | undefined)?.lock?.('landscape')
    } catch {
      /* iOS / 未全屏：改不了方向就算了 */
    }
  }

  /** 收尾：UI 退回弹层原位 + 视口落定（进 / 退一条路，别两处各写一遍） */
  function finishExit(): void {
    enteredSystem = false
    land.value = false
    droppedAt = Date.now()
    if (options.page) settleViewport()
  }

  async function exit(): Promise<void> {
    if (exiting || !land.value) return
    exiting = true
    try {
      if (options.page) {
        /*
         * 顺序：**先退系统全屏，再收 UI**（2026-11-24 修）。
         *
         * 反过来的写法（先 `land=false` 再 `exitFullscreen`）在 iOS 上有致命副作用：
         * `land` 一变，`.is-land` 被摘掉、Teleport 复位、「退出」立刻变回「全屏」，
         * 而系统全屏还在 —— 出口消失，`exitFullscreen()` 又可能被转场吞掉，
         * 于是「怎么都退不出来」。这正是旋转后那一次的现场形态。
         */
        if (enteredSystem || isSystemFullscreen()) {
          const done = await exitNativeLandscape()
          if (!done) {
            /*
             * 三次都没退掉：**保留 `land` 与那颗「退出」**，让用户能再点一次；
             * 再补一次 900ms 后的延迟重试（转场比 1.3s 还慢的情况），成功才收 UI。
             */
            window.setTimeout(() => {
              if (exiting || !land.value) return
              void exitNativeLandscape().then((ok) => {
                if (ok) finishExit()
              })
            }, 900)
            return
          }
        } else {
          // 这次本来就没进系统全屏（iOS 传统路径）：空跑一次解锁，不阻塞 UI
          void exitNativeLandscape()
        }
        finishExit()
        return
      }

      // 默认（画布全屏）模式：没有方向锁以外的系统状态要对账，保持原顺序
      land.value = false
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
      } catch {
        /* 忽略 */
      }
      try {
        await (screen.orientation as LockableOrientation | undefined)?.unlock?.()
      } catch {
        /* 忽略 */
      }
    } finally {
      exiting = false
    }
  }

  async function toggle(): Promise<void> {
    if (exiting) return
    if (land.value) await exit()
    else await enter()
  }

  /**
   * 「系统全屏没了」的二次确认。
   *
   * 旋转 / 转场时 `fullscreenchange` 会连发，而 `fullscreenElement` 在这个瞬间
   * 常常读成 null —— 一次读空就收 UI，就会出现「App 认为已退出、系统还全屏」
   * 的错位，那时按钮已经变回「全屏」，再没有代码去发 `exitFullscreen`。
   * 所以再看一眼：平常用 280ms（系统方式退出时用户几乎无感），
   * 转屏窗口内用 900ms 且可再等一轮 —— 那段时间这个属性本来就不可信。
   */
  function scheduleDropCheck(): void {
    // 转屏窗口内等更久：那段时间属性本来就不可信
    const wait = Date.now() < rotatingUntil ? 900 : 280
    window.clearTimeout(dropTimer)
    dropTimer = window.setTimeout(() => {
      dropTimer = 0
      if (!land.value || isSystemFullscreen()) return
      // 还在转屏窗口里 → 这不是「用户退出了」，是误报，再等一轮
      if (Date.now() < rotatingUntil) {
        scheduleDropCheck()
        return
      }
      finishExit()
    }, wait)
  }

  /** 用系统手势退出全屏（安卓返回 / 桌面 Esc / iOS 系统方式）时同步布局状态 */
  function onFullscreenChange(): void {
    if (isSystemFullscreen()) {
      // 又读到了全屏：撤销待定的收尾。旋转时 WebKit 正是先报 null 再恢复
      window.clearTimeout(dropTimer)
      dropTimer = 0
      enteredSystem = true
      return
    }
    // UI 已收时不据此把画面重新铺满（用户已经看过退出结果），交给对账收尾
    if (!land.value || exiting) return
    scheduleDropCheck()
  }

  /**
   * 转屏事件入口：先记「转屏窗口」，再防抖对账。
   *
   * `orientationchange` 与 `resize` 在转屏过程中都会连发；这里只做两件事：
   * 把接下来的 1.2s 标记成「方向未落定」（让二次确认等更久），
   * 然后在 300ms 后统一对账一次。
   */
  function onRotateEvent(): void {
    rotatingUntil = Date.now() + 1200
    window.clearTimeout(reconcileTimer)
    reconcileTimer = window.setTimeout(reconcile, 300)
  }

  /**
   * 转屏后的对账（2026-11-24）。
   *
   * 只看两种错位：
   *   ① 系统还在全屏、UI 却已收 → 主动补一次退出（把人放出来，别关在里面）；
   *   ② UI 还在全屏、系统层却没了 → 走与 `fullscreenchange` 同一套二次确认。
   */
  function reconcile(): void {
    reconcileTimer = 0
    if (!options.page) return
    if (!land.value && isSystemFullscreen() && Date.now() - droppedAt < 6000) {
      void exitNativeLandscape()
      return
    }
    if (land.value && enteredSystem && !isSystemFullscreen()) scheduleDropCheck()
  }

  onMounted(() => {
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // iOS / 微信内置浏览器只发前缀事件
    document.addEventListener('webkitfullscreenchange', onFullscreenChange)
    window.addEventListener('orientationchange', onRotateEvent)
    window.addEventListener('resize', onRotateEvent)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
    window.removeEventListener('orientationchange', onRotateEvent)
    window.removeEventListener('resize', onRotateEvent)
    window.clearTimeout(dropTimer)
    window.clearTimeout(reconcileTimer)
    if (options.page) {
      // 弹层关掉时如果还在全屏：不退出会冻在一块空黑屏里；
      // 而且方向锁必须解，否则用户整台手机被钉在横屏
      void exitNativeLandscape().then(settleViewport)
      return
    }
    // 全屏状态下弹层被关掉：不退出全屏的话，页面会冻在一块空黑屏里
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  })

  return { land, setStage, enter, exit, toggle }
}
