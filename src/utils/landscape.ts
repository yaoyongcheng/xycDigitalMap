import { onBeforeUnmount, onMounted, ref, type ComponentPublicInstance, type Ref } from 'vue'

import {
  enterNativeLandscape,
  exitNativeLandscape,
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
  /** 进全屏后仍是竖屏 → 摆出「把手机横过来看」的提示（与首页全屏同一份实现）。 */
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

export function useLandscape(options: LandscapeOptions = {}): Landscape {
  const land = ref(false)
  const stageEl = ref<HTMLElement | null>(null)

  function setStage(el: Element | ComponentPublicInstance | null): void {
    stageEl.value = el instanceof HTMLElement ? el : null
  }

  async function enter(): Promise<void> {
    if (land.value) return
    // 先切样式：Teleport 的 :disabled 靠它，元素得先在 body 上，再谈全屏
    land.value = true

    if (options.page) {
      /*
       * 整页全屏：`enterNativeLandscape` 内部会 `requestFullscreen` →
       * `orientation.lock('landscape')` → 等 320ms 转屏动画 → 用「视口宽 > 高」
       * 判成败。这里必须在 click 的同步栈里调到它，隔一个 await 就丢手势。
       */
      const ok = await enterNativeLandscape()
      // 桌面没有横屏概念（窗口高窄时 innerWidth 会小于 innerHeight），不提示；
      // 320ms 等待期间用户可能已经点「退出」，别对着弹层再弹一条
      if (!ok && options.hint && isTouchDevice() && land.value) openLandscapeHint()
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

  async function exit(): Promise<void> {
    land.value = false

    if (options.page) {
      // 先解锁再退全屏，顺序见 `exitNativeLandscape` 注释
      await exitNativeLandscape()
      /*
       * 退全屏同样要落定视口（2026-11-23）：全屏进出会改写 `scrollY`、让
       * `dvh` / 安全区停在横屏值，不收拾就出现「退回竖屏后整页上移」。
       * `enterNativeLandscape` 已在进入侧调过一次，这里是配对的那一半。
       */
      settleViewport()
      /*
       * iOS 上偶发「第一次 exitFullscreen 被吞」（转场进行中 / 读不到状态）。
       * 300ms 后再确认一次：还在全屏就再退一次 —— 这条是「怎么都关不掉」的兜底。
       * 必须带 `!land.value`：用户在 300ms 内又点开了全屏，这里再去退等于把他刚打开的关掉。
       */
      window.setTimeout(() => {
        if (!land.value && systemFullscreen()) void exitNativeLandscape()
      }, 300)
      return
    }

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
  }

  async function toggle(): Promise<void> {
    if (land.value) await exit()
    else await enter()
  }

  /** 是否还在系统全屏里（标准属性 + WebKit 前缀，iOS 上两者都可能是 null） */
  function systemFullscreen(): boolean {
    const doc = document as Document & { webkitFullscreenElement?: Element | null }
    return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement)
  }

  /** 用系统手势退出全屏（安卓返回 / 桌面 Esc）时，把布局状态同步回来 */
  function onFullscreenChange(): void {
    if (systemFullscreen() || !land.value) return
    land.value = false
    // 系统方式退出不经过 `exit()`，滚动位与 dvh 同样要落定，否则整页上移
    if (options.page) settleViewport()
  }

  onMounted(() => {
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // iOS / 微信内置浏览器只发前缀事件
    document.addEventListener('webkitfullscreenchange', onFullscreenChange)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
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
