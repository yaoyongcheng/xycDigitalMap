<script setup lang="ts">
import { computed, ref } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import { mineMenus } from '@/data/config'
import { useAuthStore } from '@/stores/auth'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import type { IconName } from '@/data/icons'

/**
 * 我的页
 *
 * 对应原 index.html:300-310 + renderMine()（app.js:656-663）
 * + 菜单点击委托（app.js:858-861）+ 退出按钮（app.js:871-873）。
 *
 * 2026-10 交互优化：退出登录改为二次确认 —— 原先点一下就弹「已退出登录」Toast，
 * 但页面上头像、姓名、菜单纹丝不动，用户无法判断到底退没退（状态与反馈矛盾），
 * 而且误触没有挽回余地。现在首点进入待确认态（按钮变「确认退出」），3s 无操作
 * 自动解除。
 *
 * 2026-11：登录态接真实接口（stores/auth.ts）。此前的「本地演示态」已删除 ——
 * 未登录时不再假装有会话，而是给出「账号登录」入口，登录成功后头像/姓名/角色
 * 都来自会话（姓名与角色由 /api/user/auth/me 补全，取不到就回落账号）。
 */
const shell = useShellStore()
const subpage = useSubpageStore()
const auth = useAuthStore()

/** 菜单 id → 图标名（原 menuSvg 的三个 path，几何见 data/icons.ts） */
const menuIcon: Record<string, IconName> = {
  sites: 'menu-sites',
  setting: 'menu-setting',
  about: 'menu-about',
}

/** 头像占位字：取展示名首字，未登录显示问号 */
const avatarChar = computed(() => (auth.isLoggedIn ? (auth.displayName || auth.username).slice(0, 1) : '?'))

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
  auth.logout()
  shell.showToast('已退出登录', 'success')
}

/** 未登录时进登录页（登录成功后由登录页 close 回来） */
function onLogin(): void {
  subpage.openLogin()
}

function onMenuClick(name: string): void {
  // 原版 openSub(name, pageHtml(name))，pageHtml 是纯占位文案
  subpage.openSub(name)
}
</script>

<template>
  <section class="page" id="page-mine" :class="{ active: shell.activeTab === 'mine' }">
    <div class="profile-banner" :class="{ 'is-out': !auth.isLoggedIn }">
      <div class="avatar">{{ avatarChar }}</div>
      <div>
        <h3 v-if="auth.isLoggedIn">
          {{ auth.displayName }}
          <span v-if="auth.role" class="role-tag">{{ auth.role }}</span>
        </h3>
        <h3 v-else>未登录</h3>
        <p>{{ auth.isLoggedIn ? `账号 ${auth.username}` : '向阳村项目智能建造管理平台' }}</p>
      </div>
    </div>

    <div v-if="auth.isLoggedIn" class="card" id="mineMenu">
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
      <p class="empty-note">登录后可查看工地、设置等入口，并使用全部业务功能。</p>
    </div>

    <button
      v-if="auth.isLoggedIn"
      class="logout-btn"
      id="btnLogout"
      type="button"
      :class="{ 'is-armed': logoutArmed }"
      @click="onLogout"
    >
      {{ logoutArmed ? '确认退出' : '退出登录' }}
    </button>
    <button v-else class="logout-btn is-login" id="btnLogin" type="button" @click="onLogin">
      账号登录
    </button>
  </section>
</template>
