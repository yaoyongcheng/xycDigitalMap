<script setup lang="ts">
import { computed } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useShellStore } from '@/stores/shell'
import type { IconName } from '@/data/icons'
import type { ToastType } from '@/stores/shell'

/**
 * 全局 Toast
 *
 * 对应原 index.html:347 的 <div class="toast" id="toast"> 与 showToast()（app.js:863-869）。
 * 定时器与显隐逻辑在 shell store 中，此处只负责渲染。
 *
 * 2026-10 交互优化：
 *   - 按语义类型上色并配图标（成功 / 警告 / 错误 / 普通提示）。
 *     改造前全局只有一种深底白字，核心路径的成功与失败长得一模一样，
 *     用户无法从反馈判断「到底成了没有」。
 *   - 图标走 SvgIcon 直出，不引入 v-html。
 */
const shell = useShellStore()

/** 语义类型 → 图标（几何见 data/icons.ts） */
const ICON_OF: Record<ToastType, IconName> = {
  info: 't-info',
  success: 't-ok',
  warn: 't-warn',
  error: 't-err',
}

const icon = computed<IconName>(() => ICON_OF[shell.toastType])
</script>

<template>
  <div
    class="toast"
    :class="{ show: shell.toastVisible, [`is-${shell.toastType}`]: true }"
    id="toast"
    role="status"
    aria-live="polite"
  >
    <SvgIcon class="toast-ico" :name="icon" />
    <span class="toast-text">{{ shell.toast }}</span>
  </div>
</template>
