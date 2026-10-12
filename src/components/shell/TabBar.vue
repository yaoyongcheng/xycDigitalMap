<script setup lang="ts">
import { useMsgStore } from '@/stores/msg'
import { useShellStore } from '@/stores/shell'
import type { TabId } from '@/types'

/**
 * 底部标签栏
 *
 * 对应原 index.html:327-345。
 * 原版 4 个 tab 是逐字重复的「svg + span」结构（仅图标 path 与文案不同），
 * 改 v-for 后渲染出的 DOM 完全相同 —— 属 1:1 范围内（依据迁移方案分层原则）。
 *
 * 角标：原版为硬编码 <b class="badge">2</b>，这里改读 msgStore.unreadTotal
 * （当前 2 条未读消息，和为 2，渲染结果一致），以便接入接口后自动更新。
 */

const shell = useShellStore()
const msg = useMsgStore()

interface TabDef {
  id: TabId
  label: string
  /** 原样保留的 SVG 源码，保证输出 DOM 逐字节一致 */
  svg: string
}

const tabs: TabDef[] = [
  {
    id: 'home',
    label: '首页',
    svg: '<path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/>',
  },
  {
    id: 'work',
    label: '工作台',
    svg: '<rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><rect x="4" y="13" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/>',
  },
  {
    id: 'msg',
    label: '消息',
    svg: '<path d="M5 5.5h14v10.5H8.5L5 19.5V5.5z"/>',
  },
  {
    id: 'mine',
    label: '我的',
    svg: '<circle cx="12" cy="8" r="3"/><path d="M5.5 19.5c1.2-3.2 3.6-4.7 6.5-4.7s5.3 1.5 6.5 4.7"/>',
  },
]

function onTabClick(id: TabId): void {
  shell.activeTab = id
}
</script>

<template>
  <nav class="tabbar" id="tabbar">
    <button
      v-for="t in tabs"
      :key="t.id"
      class="tab"
      :class="{ active: shell.activeTab === t.id }"
      :data-tab="t.id"
      type="button"
      @click="onTabClick(t.id)"
    >
      <svg viewBox="0 0 24 24" v-html="t.svg" />
      <span>{{ t.label }}</span>
      <b v-if="t.id === 'msg' && msg.unreadTotal" class="badge">{{ msg.unreadTotal }}</b>
    </button>
  </nav>
</template>
