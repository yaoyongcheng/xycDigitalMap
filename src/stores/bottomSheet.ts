import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { useShellStore } from './shell'
import type { DeviceKind } from '@/types'
import { useSubpageStore } from './subpage'

/**
 * 底部弹层（2026-10 版本同步 · 第一批）
 *
 * 原版用一个 `#peoplePop` 容器承载了六种内容：人员分布下钻、设备明细、
 * 巡检大图、无人机航线、塔机/电梯的历史日历、今日任务。它只有一层
 * （openSheet 直接覆写 innerHTML），**不支持嵌套** —— 打开新的就把旧的顶掉。
 * 这里保持同样的约束：状态是一个「当前弹层」而不是栈。
 *
 * 为什么不按原版直接塞 HTML：
 *   项目已全面去 innerHTML（见 data/icons.ts 的重构说明），内容必须是组件；
 *   而内容是六种互不相干的结构，用 v-if 链会越写越长。改为
 *   「kind + id → SheetHost 里的一张映射表」，新增一种内容只加一行。
 *
 * 与其它覆盖层的互斥写在 store 里（本项目约定，组件不重复实现）：
 *   · 切 tab          —— 弹层属于当前页面上下文
 *   · 子页关闭        —— 同上（设备明细是在子页里打开的）
 *   · 进全屏地图      —— 地图是独占的横屏层
 * 监控 / 航拍 / 隐患三个全屏层目前不会从弹层里打开，故暂不接入；
 * 等第四批的设备页接上「从弹层跳监控」时再补，避免现在写一条走不到的守卫。
 */

/**
 * 弹层内容类型
 *
 *   patrol          巡检大图（首页智巡）
 *   device-info     设备信息（塔机/电梯详情页）
 *   device-history  历史数据（同上）
 *   uav-today       今日任务（无人机页）
 *   uav-route       选择航线（无人机页）
 */
export type SheetKind = 'patrol' | 'device-info' | 'device-history' | 'uav-today' | 'uav-route'

export interface SheetView {
  kind: SheetKind
  /** 内容主键，语义由 kind 决定（patrol 是照片 id，device-* 是机组 id） */
  id: string
  /** device-info / device-history 用：塔机还是电梯 */
  device?: DeviceKind
}

export const useBottomSheetStore = defineStore('bottomSheet', () => {
  const view = ref<SheetView | null>(null)

  const isOpen = computed(() => view.value !== null)
  const kind = computed<SheetKind | null>(() => view.value?.kind ?? null)
  const id = computed(() => view.value?.id ?? '')

  /** 打开「巡检大图」（原 openPatrolPhoto，app.js:623-641） */
  function openPatrol(photoId: string): void {
    view.value = { kind: 'patrol', id: photoId }
  }

  /** 打开「设备信息」（原 openCraneInfo / openLiftInfo） */
  function openDeviceInfo(device: DeviceKind, unitId: string): void {
    view.value = { kind: 'device-info', id: unitId, device }
  }

  /** 打开「历史数据」（原 openCraneHistory / openLiftHistory） */
  function openDeviceHistory(device: DeviceKind, unitId: string): void {
    view.value = { kind: 'device-history', id: unitId, device }
  }

  /** 打开「今日任务」（原 openUavToday） */
  function openUavToday(): void {
    view.value = { kind: 'uav-today', id: '' }
  }

  /** 打开「选择航线」（原 openUavDispatch） */
  function openUavRoute(): void {
    view.value = { kind: 'uav-route', id: '' }
  }

  function close(): void {
    view.value = null
  }

  const shell = useShellStore()
  const sub = useSubpageStore()

  watch(
    () => sub.isOpen,
    (open) => {
      if (!open) close()
    },
  )

  watch(
    () => shell.activeTab,
    () => close(),
  )

  watch(
    () => shell.mapLandOpen,
    (open) => {
      if (open) close()
    },
  )

  return {
    view,
    isOpen,
    kind,
    id,
    openPatrol,
    openDeviceInfo,
    openDeviceHistory,
    openUavToday,
    openUavRoute,
    close,
  }
})
