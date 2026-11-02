<script setup lang="ts">
import { computed } from 'vue'

import BottomSheet from '@/components/ui/BottomSheet.vue'
import DeviceHistorySheet from '@/components/sheets/DeviceHistorySheet.vue'
import DeviceInfoSheet from '@/components/sheets/DeviceInfoSheet.vue'
import PatrolSheet from '@/components/sheets/PatrolSheet.vue'
import UavRouteSheet from '@/components/sheets/UavRouteSheet.vue'
import UavTodaySheet from '@/components/sheets/UavTodaySheet.vue'
import { patrolPhotos } from '@/data/config'
import { deviceSet } from '@/data/device'
import { useBottomSheetStore } from '@/stores/bottomSheet'

/**
 * 弹层宿主（2026-10 版本同步 · 第一批建立，第四批补齐内容）
 *
 * 全站只有一个弹层实例，挂在外壳里；内容按 store 的 kind 分发。
 * 新增一种内容 = 加一条 import + 一个分支，不牵动调用方。
 *
 * 为什么标题放在宿主而不是内容组件里：原版的标题行对所有内容都是同一套
 * （标题 + 右侧计数 + 关闭），放在外壳里才能保证几种内容的标题排版一致；
 * 各内容只负责标题下面那块。
 */
const sheet = useBottomSheetStore()

/** 当前巡检照片（kind 为 patrol 时有效） */
const photo = computed(() => {
  if (sheet.kind !== 'patrol') return undefined
  return patrolPhotos.find((p) => p.id === sheet.id)
})

/** 当前设备详情机组（device-info / device-history 时有效） */
const deviceUnit = computed(() => {
  const kind = sheet.view?.device
  if (!kind) return undefined
  const { units } = deviceSet(kind)
  return units.find((u) => u.id === sheet.id) ?? units[0]
})

const TITLES: Record<string, string> = {
  'device-info': '设备信息',
  'device-history': '历史数据',
  'uav-today': '今日任务',
  'uav-route': '选择航线',
}

const title = computed(() => {
  if (sheet.kind === 'patrol') return photo.value?.name ?? '照片'
  return (sheet.kind && TITLES[sheet.kind]) || '明细'
})

const subtitle = computed(() => {
  // 巡检大图不设副标题：分类 / 来源 / 时间都在下面的 meta 三行里，
  // 标题行再来一遍就是同一句话写两次
  if (sheet.kind === 'patrol') return ''
  if (sheet.kind === 'device-history') return deviceUnit.value?.name ?? ''
  return ''
})
</script>

<template>
  <BottomSheet v-if="sheet.isOpen" :title="title" :subtitle="subtitle" @close="sheet.close()">
    <PatrolSheet v-if="sheet.kind === 'patrol'" :id="sheet.id" />

    <DeviceInfoSheet
      v-else-if="sheet.kind === 'device-info' && sheet.view?.device"
      :device="sheet.view.device"
      :id="sheet.id"
    />

    <DeviceHistorySheet
      v-else-if="sheet.kind === 'device-history' && sheet.view?.device"
      :device="sheet.view.device"
      :id="sheet.id"
    />

    <UavTodaySheet v-else-if="sheet.kind === 'uav-today'" />

    <UavRouteSheet v-else-if="sheet.kind === 'uav-route'" />
  </BottomSheet>
</template>
