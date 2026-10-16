<script setup lang="ts">
import CountUp from '@/components/ui/CountUp.vue'

/**
 * 项目总进度条
 *
 * 对应原 index.html 中两处逐字相同的块：
 *   - 52-58   横屏地图 .land-brand 内
 *   - 196-202 首页 .home-top 内
 * 含时钟 SVG 也完全一致，故抽为共享组件（渲染 DOM 相同，属 1:1 范围）。
 *
 * 2026-10 改造：百分比数字改为滚动动画（CountUp），进度条填充的生长
 * 动画在 app.css 末尾（barGrow，transform-origin: left）。
 */
</script>

<template>
  <div class="home-progress">
    <div class="home-progress-hd">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.2l3 1.6"/></svg>
      项目总进度 <b><CountUp :value="53" />%</b>
    </div>
    <span class="home-progress-bar"><i></i></span>
  </div>
</template>
