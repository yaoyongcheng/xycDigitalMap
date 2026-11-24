<script setup lang="ts">
import { useShellStore } from '@/stores/shell'

/**
 * 顶部导航栏
 *
 * 对应原 index.html:178-182。
 * 原版通过 `navTitle.textContent = titles[tab]`（app.js:65）更新标题，
 * 这里改为响应式绑定，渲染结果一致。
 *
 * 左右两个 `.nav-side` 是标题居中的配重（原版 #navLeft / #navRight 无任何 JS
 * 引用），CSS 依赖它们做居中，故必须保留。
 *
 * 右侧**不放任何操作**（2026-11-24）：原来的「一键已读」已下线 —— 移动端不再
 * 提供状态变更入口，预警状态只读（见 `stores/msg.ts` 文件头）。
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
