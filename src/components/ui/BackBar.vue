<script setup lang="ts">
/**
 * 全屏覆盖层顶部返回栏
 *
 * 对应原 index.html 中 3 处逐字重复的 .cam-player-bar：
 *   - 68-76   监控播放器（右侧多一个 #camLive）
 *   - 124-130 航拍
 *   - 152-158 隐患上报
 * 三者结构同构，仅标题文本、按钮 id、以及是否带右侧状态位不同。
 *
 * 原版共 4~5 处重复的「返回按钮」（含 .map-land-back 与 .subpage 的 .nav-btn），
 * 其中 .cam-player-back 的这一种由本组件承担；另外两种 class 不同，各自保留。
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
    <button class="cam-player-back" :id="backId" type="button" @click="emit('back')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 8 12l7 7"/></svg>
      返回
    </button>
    <strong :id="titleId">{{ title }}</strong>
    <slot name="right" />
  </div>
</template>
