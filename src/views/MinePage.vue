<script setup lang="ts">
import { mineMenus } from '@/data/config'
import { icon, menuSvg } from '@/data/icons'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'

/**
 * 我的页
 *
 * 对应原 index.html:300-310 + renderMine()（app.js:656-663）
 * + 菜单点击委托（app.js:858-861）+ 退出按钮（app.js:871-873）。
 */
const shell = useShellStore()
const subpage = useSubpageStore()

function onMenuClick(name: string): void {
  // 原版 openSub(name, pageHtml(name))，pageHtml 是纯占位文案
  subpage.openSub(name)
}

function onLogout(): void {
  shell.showToast('已退出登录')
}
</script>

<template>
  <section class="page" id="page-mine" :class="{ active: shell.activeTab === 'mine' }">
    <div class="profile-banner">
      <div class="avatar">张</div>
      <div>
        <h3>张工 <span class="role-tag">安全员</span></h3>
        <p>向阳村项目智能建造管理平台</p>
      </div>
    </div>

    <div class="card" id="mineMenu">
      <button
        v-for="m in mineMenus"
        :key="m.id"
        class="menu-item"
        type="button"
        :data-mine="m.id"
        :data-name="m.name"
        @click="onMenuClick(m.name)"
      >
        <span class="menu-ico" v-html="icon(menuSvg[m.id])" />
        <strong>{{ m.name }}</strong>
        <span class="arrow">›</span>
      </button>
    </div>

    <button class="logout-btn" id="btnLogout" type="button" @click="onLogout">退出登录</button>
  </section>
</template>
