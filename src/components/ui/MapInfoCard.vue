<script setup lang="ts">
import { onUnmounted, watch } from 'vue'

import type { Building } from '@/types'

/**
 * 地图撒点信息卡（2026-10 改造新增，非原版内容）
 *
 * 楼栋撒点的详情展示：此前是一行 Toast，升级为地图内底部信息卡
 * （名称/状态徽标/层数/达标率/迷你进度条）。
 * 自动 6s 消失，也可手动关闭；点击另一楼栋即时换卡（key 重挂载）。
 *
 * 2026-10 交互优化：
 *   ① 补上倒计时条 —— 原先卡片会毫无征兆地在 6s 后消失，用户常常没看完
 *      就被抽走，也不知道它本来就会自动关。现在底部有一条同步收缩的进度条。
 *   ② onUnmounted 里清理定时器（此前遗留：组件卸载后定时器仍在跑，
 *      触发 emit('close') 时父组件已不在，等于白跑一次并留下悬挂句柄）。
 */
const props = defineProps<{ building: Building | null }>()
const emit = defineEmits<{ close: [] }>()

/** 自动关闭时长（ms），与 .mic-life 的动画时长同源 */
const LIFE_MS = 6000

let timer = 0

watch(
  () => props.building,
  (b) => {
    window.clearTimeout(timer)
    if (b) {
      timer = window.setTimeout(() => emit('close'), LIFE_MS)
    }
  },
)

onUnmounted(() => window.clearTimeout(timer))
</script>

<template>
  <Transition name="mic">
    <div v-if="building" :key="building.name" class="map-info-card" role="status">
      <div class="mic-head">
        <strong>{{ building.name }}</strong>
        <span class="mic-badge" :class="building.plan === '正常' ? 'ok' : 'warn'">{{ building.plan }}</span>
        <button class="mic-close" type="button" aria-label="关闭" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="mic-body">
        <div class="mic-metric">
          <b>{{ building.done }}<em>/{{ building.total }}F</em></b>
          <span>已建层数</span>
        </div>
        <div class="mic-metric">
          <b>{{ building.rate }}<em>%</em></b>
          <span>进度达标率</span>
        </div>
        <div class="mic-bar">
          <i :style="{ width: Math.round((building.done / building.total) * 100) + '%' }"></i>
        </div>
      </div>
      <!-- 自动关闭倒计时：让用户知道这张卡会自己走，也知道还剩多久 -->
      <span class="mic-life" aria-hidden="true"></span>
    </div>
  </Transition>
</template>
