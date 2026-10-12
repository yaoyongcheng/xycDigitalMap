<script setup lang="ts">
import { useShellStore } from '@/stores/shell'

/**
 * 顶部导航栏
 *
 * 对应原 index.html:178-182。
 * 原版通过 `navTitle.textContent = titles[tab]`（app.js:65）更新标题，
 * 这里改为响应式绑定，渲染结果一致。
 *
 * 左右两个 .nav-side 是空占位（原版 #navLeft / #navRight 无任何 JS 引用），
 * 但 CSS 依赖它们做标题居中，故必须保留。
 */
const shell = useShellStore()
</script>

<template>
  <nav class="navbar">
    <div class="nav-side" id="navLeft"></div>
    <h1 class="nav-title" id="navTitle">{{ shell.navTitle }}</h1>
    <div class="nav-side right" id="navRight"></div>
  </nav>
</template>
