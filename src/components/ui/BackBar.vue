<script setup lang="ts">
import SvgIcon from '@/components/ui/SvgIcon.vue'

/**
 * 全屏覆盖层顶部返回栏
 *
 * 对应原 index.html 中 3 处逐字重复的 .cam-player-bar：
 *   - 68-76   监控播放器（右侧多一个 #camLive）
 *   - 124-130 航拍
 *   - 152-158 隐患上报
 * 三者结构同构，仅标题文本、按钮 id、以及是否带右侧状态位不同。
 *
 * 返回键 2026-10 统一为纯左箭头（微信式），几何取自 data/icons.ts 的 back；
 * data-back 供右滑返回手势定位（手势只做「点这个按钮」）。
 */
defineProps<{
  title: string
  /** 原版各处的按钮 id 不同，保留用于 DOM 一致性 */
  backId: string
  /** 仅监控播放器的 <strong> 带 id */
  titleId?: string
}>()

const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <div class="cam-player-bar">
    <button
      class="cam-player-back"
      :id="backId"
      type="button"
      aria-label="返回"
      data-back
      @click="emit('back')"
    >
      <SvgIcon name="back" />
    </button>
    <strong :id="titleId">{{ title }}</strong>
    <slot name="right" />
  </div>
</template>
