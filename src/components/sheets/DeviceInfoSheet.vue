<script setup lang="ts">
import { computed } from 'vue'

import { deviceSet } from '@/data/device'

/**
 * 设备信息（2026-10 版本同步 · 第四批）
 *
 * 一台机器的台账：产权备案号、人脸识别设备、型号、出厂时间、使用年限。
 * 逐字段从 data/device.ts 的 info 读出，接后端后换成接口返回即可，
 * 结构不用动 —— 这里刻意不写死行数。
 */
const props = defineProps<{ device: 'crane' | 'lift'; id: string }>()

const unit = computed(() => deviceSet(props.device).units.find((u) => u.id === props.id))
</script>

<template>
  <div v-if="unit">
    <!-- 设备名已经在弹层副标题里，这里不再重复一遍 -->
    <div class="dev-info">
      <div v-for="[label, value] in unit.info" :key="label" class="dev-info-row">
        <span>{{ label }}</span><b>{{ value }}</b>
      </div>
    </div>
  </div>
</template>
