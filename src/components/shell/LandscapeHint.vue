<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

import { closeLandscapeHint, landscapeHintOpen } from '@/utils/landscapeHint'

/**
 * 横屏提示（2026-11-23；2026-11-24 收窄适用范围）
 *
 * 对应 `utils/orientation.ts` 的失败分支：点了「全屏」却没转成横屏
 * （iOS 全系 / 微信内置浏览器 / 系统开着旋转锁定）。
 *
 * **只在智眸 VR 360 环视的项目全景全屏出现**（`PatrolSheet.vue` 的
 * `panoLand`）。首页全屏地图、监控播放器、抓拍大图、航拍全景、平面照片
 * 都不再打开它 —— 那句引导是给球面全景量身定的，别的场景不转屏也能看。
 *
 * 两行字说清「怎么做」和「转不动时怎么办」，无遮罩、无按钮、4.2s 自动消失，
 * 点一下也能关 —— 不打断看画面。用户自己转过来（`resize` 里宽 > 高）也立刻收掉。
 */
function onResize(): void {
  if (!landscapeHintOpen.value) return
  if (window.innerWidth > window.innerHeight) closeLandscapeHint()
}

onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
</script>

<template>
  <div class="land-hint" :class="{ show: landscapeHintOpen }" :aria-hidden="!landscapeHintOpen">
    <div class="land-hint-card" @click="closeLandscapeHint">
      <p class="land-hint-title">把手机横过来看</p>
      <p class="land-hint-sub">转不动就关掉系统的「竖屏锁定」</p>
    </div>
  </div>
</template>
