<script setup lang="ts">
import { computed } from 'vue'

import { deviceSet } from '@/data/device'

/**
 * 设备历史数据（2026-10 版本同步 · 第四批）
 *
 * 原版这里是一个完整月历（histCalendar 手写 31 格）＋日期按钮；2026-10 改版
 * 收成「昨天往前 7 天」的日期胶囊 + 五项指标 + 利用率仪表。
 *
 * **2026-11 第二轮**：那 7 天的读数来自 tsdb 实时数据接口
 * （`/api/data/v1/tsdb/queryRealTimeDataV2`），该路径在当前部署上 404
 * （80/443/8080–8091/9000 全试过），台账接口只给静态属性。所以这里只剩
 * 空态：不展示编造的七日曲线，也不再画利用率进度条（没有分子分母）。
 * 将来 tsdb 开放后，把 `history` 填进 DeviceUnit 即可恢复 2026-10 的渲染。
 */
const props = defineProps<{ device: 'crane' | 'lift'; id: string }>()

/** 保留命名与取值，便于将来恢复渲染时对照设备名 */
const unit = computed(() => {
  const { units } = deviceSet(props.device)
  return units.find((u) => u.id === props.id) ?? units[0]
})
</script>

<template>
  <div class="data-empty" data-empty="device-history">
    <p>暂无历史作业数据</p>
    <p v-if="unit" class="data-empty-sub">{{ unit.name }} 的历史曲线依赖实时数据接口，当前未开放。</p>
  </div>
</template>
