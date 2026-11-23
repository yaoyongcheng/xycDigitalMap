<script setup lang="ts">
import InspectItem from '@/components/ui/InspectItem.vue'
import WorkOrderItem from '@/components/ui/WorkOrderItem.vue'
import type { AlarmEntry } from '@/utils/alarmMerge'

/**
 * 合并时间线上的一行（2026-11-23）
 *
 * 报警预警历史页现在一条列表里既有**监控预警**（`:8085` 视频报警）又有
 * **无人机预警**（keehang AI 工单）。两边的行结构差得远，所以各自的渲染
 * 仍然交给原来的组件 —— 这里只按 `kind` 分派，不做任何字段映射：
 *
 *   · 监控 → `InspectItem`（标题用报警名 `use-title`，与历史页改之前一致）；
 *   · 无人机 → `WorkOrderItem`（与无人机预警列表逐像素相同的行）。
 *
 * 为什么要单独一个组件：两个页签（今日 / 历史）都要这段分派，写在页面里
 * 就是两份 `v-if` 分支；抽出来后页面只管「哪些行、按什么顺序」。
 */
const props = defineProps<{
  entry: AlarmEntry
  /** 垫底层（右滑返回露出的只读副本）不取无人机缩略图 */
  decorative?: boolean
}>()

const emit = defineEmits<{ open: [] }>()
</script>

<template>
  <InspectItem v-if="entry.alarm" :alarm="entry.alarm" use-title @open="emit('open')" />
  <WorkOrderItem
    v-else-if="entry.work"
    :wo="entry.work"
    :decorative="props.decorative"
    @open="emit('open')"
  />
</template>
