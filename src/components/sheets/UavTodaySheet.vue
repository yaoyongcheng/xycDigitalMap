<script setup lang="ts">
import { uavTodayTasks } from '@/data/device'

/**
 * 今日任务（2026-10 版本同步 · 第四批，原 openUavToday）
 *
 * 只读清单：时间 / 航线 / 状态。状态用颜色区分执行中与已完成 ——
 * 三行文字完全相同、只有两个字不一样时，扫读靠的就是这点颜色。
 */
</script>

<template>
  <div class="uav-log">
    <div v-for="t in uavTodayTasks" :key="t.time + t.name">
      <b>{{ t.time }}</b>
      <span>{{ t.name }}</span>
      <em :class="t.state === '执行中' ? 'is-ok' : t.state === '已完成' ? 'is-done' : ''">{{ t.state }}</em>
    </div>
  </div>
</template>
