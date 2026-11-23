<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

import { closeLandscapeHint, landscapeHintOpen } from '@/utils/landscapeHint'

/**
 * 横屏提示（2026-11-23）
 *
 * 对应 `utils/orientation.ts` 的失败分支：点了「全屏」却没转成横屏
 * （iOS 全系 / 微信内置浏览器 / 系统开着旋转锁定）。
 *
 * 两行字说清「怎么做」和「转不动时怎么办」，无遮罩、无按钮、4.2s 自动消失，
 * 点一下也能关 —— 不打断看地图。用户自己转过来（`resize` 里宽 > 高）也立刻收掉。
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
