<script setup lang="ts">
import SmartImg from '@/components/ui/SmartImg.vue'
import type { Alarm } from '@/types'
import { alarmSrcOf } from '@/data/config'
import { alarmTone } from '@/utils/alarmTone'

/**
 * 巡检预警列表项
 *
 * 对应原 js/app.js:665-675 inspectListItem(a)。
 * 今日与历史两个列表都用同一份结构，故抽为组件（渲染 DOM 相同）。
 *
 * 2026-10 交互优化：图片换成 SmartImg（占位 + 失败兜底，见该组件注释）；
 * 同时补 tabindex / 键盘可达 / 按压态所需的语义 —— 原先是纯 div + role，
 * 键盘用户完全无法操作。
 *
 * 2026-11 设计稿 gx2 版：①标题行加采集来源徽标；②报警历史页的列表
 * 标题显示报警名（histAlarmItem 用 a.title）而不是类型名（inspectListItem
 * 用 a.type），useTitle 切换。
 */
defineProps<{ alarm: Alarm; useTitle?: boolean }>()
const emit = defineEmits<{ open: [] }>()

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('open')
  }
}
</script>

<template>
  <div
    class="insp-item"
    :data-alarm="alarm.id"
    :data-tone="alarmTone(alarm.type)"
    role="button"
    tabindex="0"
    @click="emit('open')"
    @keydown="onKey"
  >
    <SmartImg class="insp-pic" :src="alarm.img" :alt="alarm.type" />
    <div class="insp-meta">
      <div class="insp-hd">
        <strong>{{ useTitle ? alarm.title : alarm.type }}</strong>
        <span class="alarm-src" :class="`alarm-src-${alarm.src}`">{{ alarmSrcOf(alarm.src).tag }}</span>
      </div>
      <p>{{ alarm.desc }}</p>
    </div>
    <span class="insp-time">{{ alarm.rel }}</span>
  </div>
</template>
