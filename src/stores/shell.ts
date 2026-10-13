import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { titles } from '@/data/config'
import type { TabId } from '@/types'

/** 首页抽屉展开状态的持久化键 */
const SHEET_UP_KEY = 'xyc.sheetUp'

/**
 * 读取上次的抽屉状态。
 * 无记录时回退为展开（原版 app.js:925 的初值 true）；
 * localStorage 不可用（隐私模式、配额满）时同样回退，不让读取失败影响启动。
 */
function readSheetUp(): boolean {
  try {
    const v = localStorage.getItem(SHEET_UP_KEY)
    return v === null ? true : v === '1'
  } catch {
    return true
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

  /** Toast 文案，对应原 showToast() 写入的 el.textContent */
  const toast = ref('')

  /** Toast 是否可见，对应原 #toast 的 .show 类 */
  const toastVisible = ref(false)

  let toastTimer = 0

  /**
   * 原 js/app.js:863-869 showToast(text)
   * 原版把句柄挂在函数属性 showToast._t 上（非标准做法），这里用闭包变量，
   * 行为一致：连续调用会取消上一个定时器，1.6s 后隐藏。
   * 注意原版只移除 .show，不清空文本，这里保持一致。
   */
  function showToast(text: string): void {
    toast.value = text
    toastVisible.value = true
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toastVisible.value = false
    }, 1600)
  }

  /** .phone.is-landscape —— 真横屏伪适配开关 */
  const isLandscape = ref(false)

  /** #camPlayer.is-land —— 监控播放器的全屏态 */
  const isLand = ref(false)

  /**
   * #page-home.is-sheet-up —— 首页半屏抽屉。
   *
   * 原版初值为 true（L925）。此处改为沿用上次的展开状态并写回存储：
   * 现场用户习惯固定用一种高度，每次重开都弹回默认值很别扭。
   * 用 watch 而非在调用方写存储 —— 保持 `shell.sheetUp = x` 的既有写法不变。
   */
  const sheetUp = ref(readSheetUp())

  watch(sheetUp, (v) => {
    try {
      localStorage.setItem(SHEET_UP_KEY, v ? '1' : '0')
    } catch {
      // 存储不可用（隐私模式/配额满）时静默降级：本次会话内切换仍正常
    }
  })

  /** 原为 #mapLand 的 .open / hidden */
  const mapLandOpen = ref(false)

  /**
   * 原 js/app.js:1701-1706 openMapLand()
   * 同时给 .phone 加 is-landscape —— 注意 cam 的 setCamLand(false) 会把它清掉，
   * 这是原版的既存缺陷（打开/关闭任意 cam 播放器会无条件清除地图横屏态），
   * 1:1 复刻下保留。
   */
  function openMapLand(): void {
    isLandscape.value = true
    mapLandOpen.value = true
  }

  /** 原 js/app.js:1708-1713 closeMapLand() */
  function closeMapLand(): void {
    isLandscape.value = false
    mapLandOpen.value = false
  }

  return {
    activeTab,
    navTitle,
    toast,
    toastVisible,
    showToast,
    isLandscape,
    isLand,
    sheetUp,
    mapLandOpen,
    openMapLand,
    closeMapLand,
  }
})
