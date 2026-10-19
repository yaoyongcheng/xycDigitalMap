<script setup lang="ts">
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAirHazardStore } from '@/stores/airHazard'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import type { IconName } from '@/data/icons'

/**
 * 工作台
 *
 * 对应原 index.html:235-294 + 快捷入口委托（app.js:997-1005）。
 * .work-short ×4 与 .tool-card ×3 均为逐字重复结构，改 v-for（渲染 DOM 相同）。
 *
 * 注：原版 3 个 .tool-card 在 JS 中无任何事件绑定（纯展示）；
 * 2026-10 改造补了「接入中」Toast 反馈作为点击出口（见 onToolClick）。
 * 图标几何见 data/icons.ts，由 SvgIcon 直出 SVG 元素（不再走 v-html）。
 */
const shell = useShellStore()
const cam = useCamStore()
const air = useAirHazardStore()

const shorts: { work: string; color: string; label: string; icon: IconName }[] = [
  { work: 'cam', color: 'blue', label: '视频监控', icon: 'work-cam' },
  { work: 'photo', color: 'green', label: '航拍照片', icon: 'drone' },
  { work: 'hazard', color: 'orange', label: '隐患上报', icon: 'work-hazard' },
  { work: 'todo2', color: 'gray', label: '待定', icon: 'work-todo' },
]

const tools: { color: string; title: string; desc: string; icon: IconName }[] = [
  {
    color: 'blue',
    title: '垂直调度系统',
    desc: '施工电梯/塔机垂直运输调度',
    icon: 'tool-vertical',
  },
  {
    color: 'green',
    title: '水平调度系统',
    desc: '车辆出入场调度管理',
    icon: 'tool-horizontal',
  },
  {
    color: 'orange',
    title: '工地地图导航',
    desc: '施工工地场内区域定位与导航',
    icon: 'tool-nav',
  },
]

function onShortClick(work: string): void {
  // 原 app.js:997-1005 —— cam 打开首个点位，photo 开航拍，hazard 开隐患，其余提示待定
  if (work === 'cam') cam.openCam(cam.cameras[0].id)
  else if (work === 'photo') air.openAir()
  else if (work === 'hazard') air.openHazard()
  else shell.showToast('功能待定', 'info')
}

/** 键盘可达（工具卡是 div + role，补 tabindex 与回车/空格触发） */
function onToolKey(e: KeyboardEvent, title: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onToolClick(title)
  }
}

/**
 * 工具卡点击反馈（2026-10 改造新增）。
 * 原版 3 个 .tool-card 无任何事件绑定（纯展示），点击静默无反馈，
 * 现补「接入中」提示作为明确出口；接入后端后替换为真实跳转。
 */
function onToolClick(title: string): void {
  shell.showToast(`「${title}」接入中，敬请期待`, 'info')
}
</script>

<template>
  <section class="page work-page" id="page-work" :class="{ active: shell.activeTab === 'work' }">
    <div class="work-shorts" id="workShorts">
      <button
        v-for="s in shorts"
        :key="s.work"
        class="work-short"
        type="button"
        :data-work="s.work"
        @click="onShortClick(s.work)"
      >
        <i :class="s.color">
          <SvgIcon :name="s.icon" />
        </i>
        <span>{{ s.label }}</span>
      </button>
    </div>

    <div class="tool-list">
      <div
        v-for="t in tools"
        :key="t.title"
        class="tool-card"
        role="button"
        tabindex="0"
        @click="onToolClick(t.title)"
        @keydown="onToolKey($event, t.title)"
      >
        <div class="tool-ico" :class="t.color">
          <SvgIcon :name="t.icon" />
        </div>
        <div class="tool-meta">
          <strong>{{ t.title }}</strong>
          <p>{{ t.desc }}</p>
        </div>
        <span class="tool-arrow">›</span>
      </div>
    </div>
  </section>
</template>
