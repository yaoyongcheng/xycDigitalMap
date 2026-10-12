<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/**
 * 状态栏
 *
 * 对应原 index.html:15-42 + tick() 中更新 #statusTime 的那一段（app.js:1718-1723）。
 *
 * 原 tick() 同时更新三处：状态栏时间、监控播放器时间戳、监控卡片时间戳。
 * 这里只承接状态栏部分，另两处分别由 CamPlayer 与 CamCard 自行负责。
 *
 * 深浅色联动（.phone-screen:has(.xxx.open) .status-bar）由全局 CSS 承担，
 * 本组件只输出 DOM，不做任何判断 —— 这是 1:1 复刻的必要条件：
 * 若改用 v-if 卸载覆盖层，会同时打破 app.css:132-163 的 :has() 规则。
 */

const time = ref(new Date().toTimeString().slice(0, 5))

let timer = 0

onMounted(() => {
  timer = window.setInterval(() => {
    time.value = new Date().toTimeString().slice(0, 5)
  }, 1000)
})

// 原版此定时器无清理路径（app.js:1729 句柄未保存）。状态栏全程挂载，
// 加上卸载清理不改变任何可观察行为，但符合组件生命周期语义。
onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <header class="status-bar">
    <div class="status-left">
      <span id="statusTime">{{ time }}</span>
      <span class="status-carrier">中国电信</span>
    </div>
    <div class="status-right">
      <span class="status-net">4G</span>
      <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
        <rect x="0" y="8" width="2.6" height="4" rx="0.4" fill="currentColor" />
        <rect x="4.4" y="5.5" width="2.6" height="6.5" rx="0.4" fill="currentColor" />
        <rect x="8.8" y="3" width="2.6" height="9" rx="0.4" fill="currentColor" />
        <rect x="13.2" y="0.5" width="2.6" height="11.5" rx="0.4" fill="currentColor" />
      </svg>
      <svg width="15" height="12" viewBox="0 0 15 12" aria-hidden="true">
        <path d="M1 8.4c3.4-4.2 9.6-4.2 13 0" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" />
        <path d="M3.8 9.6c2-2.3 5.4-2.3 7.4 0" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" />
        <circle cx="7.5" cy="11" r="1" fill="currentColor" />
      </svg>
      <span class="status-battery">
        <b>86%</b>
        <svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true">
          <rect x="0.6" y="1.4" width="19.6" height="9.2" rx="2" stroke="currentColor" fill="none" stroke-width="1.2" />
          <rect x="21.2" y="3.8" width="1.8" height="4.4" rx="0.5" fill="currentColor" />
          <rect x="2.2" y="2.9" width="14.8" height="6.2" rx="1" fill="currentColor" />
        </svg>
      </span>
    </div>
  </header>
</template>
