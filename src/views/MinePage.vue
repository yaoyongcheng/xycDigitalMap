<script setup lang="ts">
import { ref } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import { mineMenus } from '@/data/config'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import type { IconName } from '@/data/icons'

/**
 * 我的页
 *
 * 对应原 index.html:300-310 + renderMine()（app.js:656-663）
 * + 菜单点击委托（app.js:858-861）+ 退出按钮（app.js:871-873）。
 *
 * 2026-10 交互优化：
 *   ① 退出登录改为二次确认 —— 原先点一下就弹「已退出登录」Toast，但页面
 *      上头像、姓名、菜单纹丝不动，用户无法判断到底退没退（状态与反馈矛盾），
 *      而且误触没有任何挽回余地。现在首点进入待确认态（按钮变「确认退出」），
 *      3s 无操作自动解除；确认后才切到未登录态。
 *   ② 未登录态是本地演示状态（本项目尚无账号体系）：头像与姓名换成占位，
 *      菜单收起，按钮变「重新登录」。接入真实鉴权后应改由会话 store 驱动。
 */
const shell = useShellStore()
const subpage = useSubpageStore()

/** 菜单 id → 图标名（原 menuSvg 的三个 path，几何见 data/icons.ts） */
const menuIcon: Record<string, IconName> = {
  sites: 'menu-sites',
  setting: 'menu-setting',
  about: 'menu-about',
}

/** 是否已退出（本地演示态） */
const loggedOut = ref(false)

/** 退出待确认窗口 */
const logoutArmed = ref(false)
let logoutTimer = 0

function disarmLogout(): void {
  window.clearTimeout(logoutTimer)
  logoutArmed.value = false
}

function onLogout(): void {
  if (!logoutArmed.value) {
    logoutArmed.value = true
    window.clearTimeout(logoutTimer)
    logoutTimer = window.setTimeout(disarmLogout, 3000)
    return
  }
  disarmLogout()
  loggedOut.value = true
  shell.showToast('已退出登录', 'success')
}

function onRelogin(): void {
  loggedOut.value = false
  shell.showToast('已重新登录（演示）', 'info')
}

function onMenuClick(name: string): void {
  // 原版 openSub(name, pageHtml(name))，pageHtml 是纯占位文案
  subpage.openSub(name)
}
</script>

<template>
  <section class="page" id="page-mine" :class="{ active: shell.activeTab === 'mine' }">
    <div class="profile-banner" :class="{ 'is-out': loggedOut }">
      <div class="avatar">{{ loggedOut ? '?' : '张' }}</div>
      <div>
        <h3 v-if="!loggedOut">张工 <span class="role-tag">安全员</span></h3>
        <h3 v-else>未登录</h3>
        <p>向阳村项目智能建造管理平台</p>
      </div>
    </div>

    <div v-if="!loggedOut" class="card" id="mineMenu">
      <button
        v-for="m in mineMenus"
        :key="m.id"
        class="menu-item"
        type="button"
        :data-mine="m.id"
        :data-name="m.name"
        @click="onMenuClick(m.name)"
      >
        <span class="menu-ico"><SvgIcon :name="menuIcon[m.id]" /></span>
        <strong>{{ m.name }}</strong>
        <span class="arrow">›</span>
      </button>
    </div>
    <div v-else class="card mine-out">
      <p class="empty-note">已退出登录，重新登录后可使用工地、设置等入口。</p>
    </div>

    <button
      v-if="!loggedOut"
      class="logout-btn"
      id="btnLogout"
      type="button"
      :class="{ 'is-armed': logoutArmed }"
      @click="onLogout"
    >
      {{ logoutArmed ? '确认退出' : '退出登录' }}
    </button>
    <button v-else class="logout-btn" id="btnRelogin" type="button" @click="onRelogin">重新登录</button>
  </section>
</template>
