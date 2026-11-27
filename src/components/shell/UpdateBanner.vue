<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/**
 * PWA 新版本提示条（2026-10 改造新增，2026-11-27 收窄触发条件）
 *
 * 监听 utils/pwa.ts 在新 SW 接管时广播的 'xyc:sw-updated' 事件，
 * 弹出「新版本已就绪」操作条：点「刷新」立即换版，点「稍后」本次会话
 * 不再打扰（事件只广播一次，关闭后等下次更新再出现）。
 *
 * 触发条件已收窄：只有当页面**存在进行中的操作**（开着监控/航拍/子页/弹层、
 * 停在其他 tab、正在输入）时才广播 —— 此时自动刷新会丢用户的状态。
 * 其余情况（首页、无覆盖层）由 pwa.ts 直接静默刷新，不会弹这条。
 * 改策略的动因见 utils/pwa.ts 文件头 ③。
 *
 * 与全局 Toast 的区别：Toast 是 1.6s 自动消失的纯提示；
 * 这是一个需要用户决策的操作条，必须常驻到用户选择为止。
 */
const visible = ref(false)

function onUpdated(): void {
  visible.value = true
}

function onReload(): void {
  window.location.reload()
}

function onLater(): void {
  visible.value = false
}

onMounted(() => window.addEventListener('xyc:sw-updated', onUpdated))
onUnmounted(() => window.removeEventListener('xyc:sw-updated', onUpdated))
</script>

<template>
  <div v-if="visible" class="upd-banner" role="alert">
    <span class="upd-banner-text">新版本已就绪</span>
    <button class="upd-banner-btn" type="button" @click="onReload">刷新</button>
    <button class="upd-banner-dismiss" type="button" aria-label="稍后" @click="onLater">稍后</button>
  </div>
</template>
