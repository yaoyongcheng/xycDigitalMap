<script setup lang="ts">
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useMsgStore } from '@/stores/msg'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import type { IconName } from '@/data/icons'
import type { TabId } from '@/types'

/**
 * 底部标签栏
 *
 * 对应原 index.html:327-345。
 * 原版 4 个 tab 是逐字重复的「svg + span」结构（仅图标 path 与文案不同），
 * 改 v-for 后渲染出的 DOM 完全相同 —— 属 1:1 范围内（依据迁移方案分层原则）。
 *
 * 角标：原版为硬编码 <b class="badge">2</b>，这里改读 msgStore.pendingTotal
 * —— 那是**监控预警 + 无人机预警的今日待处理之和**（2026-11-24 现场口径）。
 * 两个列表页各显示一份「今日待处理」，数字与底栏角标严格同源：切换 tab 刷新后
 * 列表与角标一起变。移动端没有状态变更入口，所以这个数字只会随服务端的处置
 * 结果下降，不会因为「点开看过」而减少。
 *
 * 2026-10：图标由「HTML 字符串 + v-html」改为 SvgIcon 直出（几何不变，
 * 配色仍由 app.css 的 .tab svg 规则提供），消除 innerHTML 解析。
 */

const shell = useShellStore()
const msg = useMsgStore()
const sub = useSubpageStore()

interface TabDef {
  id: TabId
  label: string
  /** 图标名（几何见 data/icons.ts），由 SvgIcon 直出 SVG 元素 */
  icon: IconName
}

const tabs: TabDef[] = [
  { id: 'home', label: '首页', icon: 'tab-home' },
  { id: 'work', label: '工作台', icon: 'tab-work' },
  { id: 'msg', label: '消息', icon: 'tab-msg' },
  { id: 'mine', label: '我的', icon: 'tab-mine' },
]

function onTabClick(id: TabId): void {
  /*
   * 底栏是根级导航，切 tab 前必须先把子页收掉。
   * .subpage 是盖在 .pages 之上的绝对定位层，不关它的话 activeTab 虽然变了，
   * 用户看到的还是原来的详情页 —— 表现就是「点底栏没反应」。
   * 用 dismiss 而不是 close：这里是「换根」不是「后退一级」，
   * 不该先收日历、再回列表地倒退三步。
   */
  sub.dismiss()
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
      <SvgIcon :name="t.icon" />
      <span>{{ t.label }}</span>
      <!--
        角标数字 = 两类预警今日待处理之和，随切 tab 刷新一起更新（见 stores/msg.ts）。
        :key 让数字变化时元素重挂载，触发 app.css 的 badgePop 弹跳动画；
        超过 99 封顶显示 99+。
      -->
      <b v-if="t.id === 'msg' && msg.pendingTotal" :key="msg.pendingTotal" class="badge">
        {{ msg.pendingTotal > 99 ? '99+' : msg.pendingTotal }}
      </b>
    </button>
  </nav>
</template>
