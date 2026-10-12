import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { titles } from '@/data/config'
import type { TabId } from '@/types'

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

  /** Toast 文案，对应原 showToast()。空串表示不显示 */
  const toast = ref('')

  /** .phone.is-landscape —— 真横屏伪适配开关 */
  const isLandscape = ref(false)

  /** #camPlayer.is-land —— 监控播放器的全屏态 */
  const isLand = ref(false)

  /** #page-home.is-sheet-up —— 首页半屏抽屉。原版初值为 true（L925） */
  const sheetUp = ref(true)

  return { activeTab, navTitle, toast, isLandscape, isLand, sheetUp }
})
