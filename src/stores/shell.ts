import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { titles } from '@/data/config'
import type { TabId } from '@/types'

/** 首页抽屉展开状态的持久化键（旧版布尔键，仅用于迁移读取） */
const SHEET_UP_KEY = 'xyc.sheetUp'

/** 首页抽屉档位（2026-10 改造新增）：0 收起 / 1 半开 / 2 全开 */
const SHEET_LEVEL_KEY = 'xyc.sheetLevel'

export type SheetLevel = 0 | 1 | 2

/**
 * Toast 语义类型。
 *
 * 改造前全局只有一种「深底白字」提示，成功、失败、警告长得完全一样 ——
 * 核心路径（隐患提交、功能待定、退出登录）全靠它，等于所有反馈一个表情。
 * 这里补上四档语义，视觉差异收在 app.css 的 .toast.is-* 里。
 */
export type ToastType = 'info' | 'success' | 'warn' | 'error'

/** Toast 默认停留时长（ms），保持原版 1.6s 不变 */
const TOAST_MS = 1600

/**
 * 读取上次的抽屉档位。
 * 优先读新的档位键；不存在时迁移旧布尔键（'1'→2 全开，'0'→0 收起）；
 * 都没有则回退全开（原版 app.js:925 的初值 true）。
 * localStorage 不可用（隐私模式、配额满）时同样回退，不让读取失败影响启动。
 */
function readSheetLevel(): SheetLevel {
  try {
    const v = localStorage.getItem(SHEET_LEVEL_KEY)
    if (v === '0' || v === '1' || v === '2') return Number(v) as SheetLevel
    const old = localStorage.getItem(SHEET_UP_KEY)
    return old === '0' ? 0 : 2
  } catch {
    return 2
  }
}

/**
 * 应用外壳状态
 *
 * 覆盖原 js/app.js 中这些跨域共享的顶层变量：
 *   - homeMod 之外的 tab/导航/抽屉/横屏状态
 *   - sheetUp(925)   被抽屉与 window.resize(L950) 共用
 *   - isLandscape    被 cam 与 mapLand 共用（原版有互相清除的缺陷，见迁移方案）
 *
 * 注意：原版有两个横屏 class，作用在不同元素上，不能合并：
 *   isLandscape -> 加在 .phone 上（CSS app.css:89 / 3124-3210 / 3562-3574 共 22 处消费）
 *   isLand      -> 加在 #camPlayer 上（CSS app.css:3036-3037 控制全屏/退出图标）
 */
export const useShellStore = defineStore('shell', () => {
  /** 当前 tab，对应原 switchTab(tab) 的参数 */
  const activeTab = ref<TabId>('home')

  /** 导航栏标题，原 navTitle.textContent = titles[tab] */
  const navTitle = computed(() => titles[activeTab.value])

  /**
   * 页面转场方向：'fwd' 向右推进 / 'back' 向左退回。
   *
   * 改造前四个 tab 共用一条「上滑淡入」动画 —— 从「我的」退回「首页」和从
   * 「首页」进到「工作台」长得一模一样，用户失去了「我是从哪来的」这条信息。
   * 按标签栏的左右次序给转场加上方向，横向滑入方向与手指的移动一致。
   */
  const TAB_ORDER: TabId[] = ['home', 'work', 'msg', 'mine']
  const navDir = ref<'fwd' | 'back'>('fwd')

  watch(activeTab, (to, from) => {
    navDir.value = TAB_ORDER.indexOf(to) >= TAB_ORDER.indexOf(from) ? 'fwd' : 'back'
  })

  /** Toast 文案，对应原 showToast() 写入的 el.textContent */
  const toast = ref('')

  /** Toast 是否可见，对应原 #toast 的 .show 类 */
  const toastVisible = ref(false)

  /** Toast 语义类型（默认 info，与改造前的唯一外观等价） */
  const toastType = ref<ToastType>('info')

  let toastTimer = 0

  /**
   * 原 js/app.js:863-869 showToast(text)
   * 原版把句柄挂在函数属性 showToast._t 上（非标准做法），这里用闭包变量，
   * 行为一致：连续调用会取消上一个定时器，1.6s 后隐藏。
   * 注意原版只移除 .show，不清空文本，这里保持一致。
   *
   * 2026-10 交互优化新增 type 与 duration 两个可选参数：
   *   - type：让「提交成功 / 校验失败 / 功能待定」在视觉上可区分；
   *     不传时是 info，现有调用点外观不变。
   *   - duration：需要用户读完的长提示（如二次确认文案）可延长到 3~4s，
   *     默认仍是原版的 1600ms。
   */
  function showToast(text: string, type: ToastType = 'info', duration = TOAST_MS): void {
    toast.value = text
    toastType.value = type
    toastVisible.value = true
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toastVisible.value = false
    }, duration)
  }

  /** .phone.is-landscape —— 真横屏伪适配开关 */
  const isLandscape = ref(false)

  /** #camPlayer.is-land —— 监控播放器的全屏态 */
  const isLand = ref(false)

  /**
   * 首页半屏抽屉档位（0 收起 / 1 半开 / 2 全开），持久化到 localStorage。
   *
   * 原 sheetUp 布尔值的演进：拖拽改造（2026-10）引入中间档后，
   * 布尔量不足以表达三档，故底层改为档位 ref；sheetUp 保留为
   * 计算属性访问器（get: level > 0；set: true→2 / false→0），
   * `shell.sheetUp = x` 的既有写法与 #page-home.is-sheet-up 的
   * CSS 语义（抬起即 true）均不变。
   */
  const sheetLevel = ref<SheetLevel>(readSheetLevel())

  const sheetUp = computed<boolean>({
    get: () => sheetLevel.value > 0,
    set: (v: boolean) => {
      sheetLevel.value = v ? 2 : 0
    },
  })

  watch(sheetLevel, (v) => {
    try {
      localStorage.setItem(SHEET_LEVEL_KEY, String(v))
      // 同步写旧键，回退旧版本时状态不丢失
      localStorage.setItem(SHEET_UP_KEY, v > 0 ? '1' : '0')
    } catch {
      // 存储不可用（隐私模式/配额满）时静默降级：本次会话内切换仍正常
    }
  })

  /** 原为 #mapLand 的 .open / hidden */
  const mapLandOpen = ref(false)

  /**
   * 「返回全屏地图」约定（2026-10 新增体验逻辑，非原版行为）。
   *
   * 从全屏地图的撒点跳进监控时，地图层必须先关闭（openCam 的
   * setCamLand(false) 会无条件清掉横屏态，留着会看到布局错乱的地图层，
   * 见 openMapLand 注释）。此标记让监控的返回键在关闭播放器后
   * 重新拉起全屏地图，形成「地图 → 监控 → 返回 → 地图」的自然回路。
   * 不持久化：刷新后回到首页属预期。
   */
  const mapLandReturn = ref(false)

  /**
   * 原 js/app.js:1701-1706 openMapLand()
   * 同时给 .phone 加 is-landscape —— 注意 cam 的 setCamLand(false) 会把它清掉，
   * 这是原版的既存缺陷（打开/关闭任意 cam 播放器会无条件清除地图横屏态），
   * 1:1 复刻下保留。
   */
  function openMapLand(): void {
    isLandscape.value = true
    mapLandOpen.value = true
    mapLandReturn.value = false
  }

  /** 原 js/app.js:1708-1713 closeMapLand() */
  function closeMapLand(): void {
    isLandscape.value = false
    mapLandOpen.value = false
    mapLandReturn.value = false
  }

  /**
   * 覆盖层返回键的收尾钩子：若本次覆盖层是从全屏地图跳进来的，
   * 关闭后重新打开全屏地图。无约定时是空操作。
   */
  function backToMapLand(): void {
    if (!mapLandReturn.value) return
    mapLandReturn.value = false
    openMapLand()
  }

  return {
    activeTab,
    navTitle,
    navDir,
    toast,
    toastType,
    toastVisible,
    showToast,
    isLandscape,
    isLand,
    sheetUp,
    sheetLevel,
    mapLandOpen,
    mapLandReturn,
    openMapLand,
    closeMapLand,
    backToMapLand,
  }
})
