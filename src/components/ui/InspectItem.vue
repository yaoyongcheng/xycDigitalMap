<script setup lang="ts">
import type { Alarm } from '@/types'

/**
 * 巡检预警列表项
 *
 * 对应原 js/app.js:665-675 inspectListItem(a)。
 * 今日与历史两个列表都用同一份结构，故抽为组件（渲染 DOM 相同）。
 */
defineProps<{ alarm: Alarm }>()
const emit = defineEmits<{ open: [] }>()
</script>

<template>
  <div class="insp-item" :data-alarm="alarm.id" role="button" @click="emit('open')">
    <img class="insp-pic" :src="alarm.img" :alt="alarm.type" />
    <div class="insp-meta">
      <strong>{{ alarm.type }}</strong>
      <p>{{ alarm.desc }}</p>
    </div>
    <span class="insp-time">{{ alarm.rel }}</span>
  </div>
</template>
