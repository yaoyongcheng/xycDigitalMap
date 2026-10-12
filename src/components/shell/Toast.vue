<script setup lang="ts">
import { useShellStore } from '@/stores/shell'

/**
 * 全局 Toast
 *
 * 对应原 index.html:347 的 <div class="toast" id="toast"> 与 showToast()（app.js:863-869）。
 * 定时器与显隐逻辑在 shell store 中，此处只负责渲染。
 */
const shell = useShellStore()
</script>

<template>
  <div class="toast" :class="{ show: shell.toastVisible }" id="toast">{{ shell.toast }}</div>
</template>
