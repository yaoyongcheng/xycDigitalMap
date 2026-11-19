import { onBeforeUnmount, onMounted, ref, type ComponentPublicInstance, type Ref } from 'vue'

/**
 * 「横屏查看」—— 大图 / 全景共用的一个开关（2026-11-18 抽出来）。
 *
 * 行为就三件事（顺序不能反）：
 *   1. `land = true` 先把样式切到「铺满视口」，调用方据此把画布 Teleport 到 body；
 *   2. `requestFullscreen` 把画布塞进系统全屏（拿不到就算了）；
 *   3. `screen.orientation.lock('landscape')` 尽量锁横屏。
 *
 * 后两步在 iOS Safari 上基本都拿不到（不支持 `Element.requestFullscreen`，
 * `orientation.lock` 还要求先处于全屏），所以两段都 try/catch —— 拿不到就只剩
 * 「铺满视口」这一层，用户自己把手机横过来照样能看。**不能因为拿不到就报错**。
 *
 * 为什么做成 composable：一个弹层里有两块画布（VR 360 环视的球面 / 单张照片），
 * 两套开关必须是**各自独立**的状态；复制一遍代码只会让两边慢慢长歪。
 */
export interface Landscape {
  /** 当前是否处于横屏查看（同时也是「画布要不要 Teleport 到 body」的开关） */
  land: Ref<boolean>
  /**
   * 绑到要铺满视口的那块画布上：模板里写 `:ref="setStage"`。
   *
   * 用函数 ref 而不是 `ref="名字"`：字符串 ref 在 `<script setup>` 里靠作用域
   * 变量名匹配，`vue-tsc` 那边不算「被使用」，会把 ref 报成 TS6133。
   */
  setStage: (el: Element | ComponentPublicInstance | null) => void
  /** 进横屏 */
  enter: () => Promise<void>
  /** 退横屏 */
  exit: () => Promise<void>
  /** 按当前状态切换（按钮就调这个） */
  toggle: () => Promise<void>
}

export function useLandscape(): Landscape {
  const land = ref(false)
  const stageEl = ref<HTMLElement | null>(null)

  function setStage(el: Element | ComponentPublicInstance | null): void {
    stageEl.value = el instanceof HTMLElement ? el : null
  }

  async function enter(): Promise<void> {
    if (land.value) return
    // 先切样式：Teleport 的 :disabled 靠它，元素得先在 body 上，再谈全屏
    land.value = true
    try {
      await stageEl.value?.requestFullscreen?.({ navigationUI: 'hide' })
    } catch {
      /* 不支持 / 被拒绝：留在铺满视口的形态 */
    }
    try {
      await (
        screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      )?.lock?.('landscape')
    } catch {
      /* iOS / 未全屏：改不了方向就算了 */
    }
  }

  async function exit(): Promise<void> {
    land.value = false
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
    } catch {
      /* 忽略 */
    }
    try {
      await (screen.orientation as ScreenOrientation & { unlock?: () => void })?.unlock?.()
    } catch {
      /* 忽略 */
    }
  }

  async function toggle(): Promise<void> {
    if (land.value) await exit()
    else await enter()
  }

  /** 用系统手势退出全屏（安卓返回 / 桌面 Esc）时，把布局状态同步回来 */
  function onFullscreenChange(): void {
    if (!document.fullscreenElement && land.value) land.value = false
  }

  onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange))

  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    // 全屏状态下弹层被关掉：不退出全屏的话，页面会冻在一块空黑屏里
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  })

  return { land, setStage, enter, exit, toggle }
}
