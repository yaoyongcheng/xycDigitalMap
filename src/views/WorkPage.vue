<script setup lang="ts">
import { useAirHazardStore } from '@/stores/airHazard'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'

/**
 * 工作台
 *
 * 对应原 index.html:235-294 + 快捷入口委托（app.js:997-1005）。
 * .work-short ×4 与 .tool-card ×3 均为逐字重复结构，改 v-for（渲染 DOM 相同）。
 *
 * 注：原版 3 个 .tool-card 在 JS 中无任何事件绑定（纯展示）；
 * 2026-10 改造补了「接入中」Toast 反馈作为点击出口（见 onToolClick）。
 */
const shell = useShellStore()
const cam = useCamStore()
const air = useAirHazardStore()

const shorts: { work: string; color: string; label: string; svg: string }[] = [
  {
    work: 'cam',
    color: 'blue',
    label: '视频监控',
    svg: '<path d="M4.5 8.2h10.2v9.2H4.5z"/><path d="M14.7 11.2 19.5 8.8v8.2l-4.8-2.4z"/>',
  },
  {
    work: 'photo',
    color: 'green',
    label: '航拍照片',
    svg: '<circle cx="6.2" cy="6.2" r="2"/><circle cx="17.8" cy="6.2" r="2"/><circle cx="6.2" cy="17.8" r="2"/><circle cx="17.8" cy="17.8" r="2"/><path d="M8.2 6.2h7.6M8.2 17.8h7.6M6.2 8.2v7.6M17.8 8.2v7.6"/><rect x="10" y="10" width="4" height="4" rx="0.8"/>',
  },
  {
    work: 'hazard',
    color: 'orange',
    label: '隐患上报',
    svg: '<path d="M4.4 9.2h3.1l1.3-2.2h6.4l1.3 2.2h3.1v9.2H4.4z"/><circle cx="12" cy="13.9" r="3.1"/>',
  },
  {
    work: 'todo2',
    color: 'gray',
    label: '待定',
    svg: '<rect x="4.5" y="4.5" width="15" height="15" rx="3" stroke-dasharray="3 3"/><path d="M12 9v6M9 12h6"/>',
  },
]

const tools: { color: string; title: string; desc: string; svg: string }[] = [
  {
    color: 'blue',
    title: '垂直调度系统',
    desc: '施工电梯/塔机垂直运输调度',
    svg: '<rect x="4.5" y="3.5" width="6.2" height="17" rx="1.2"/><rect x="13.3" y="3.5" width="6.2" height="17" rx="1.2"/><path d="M7.6 9.2v-2.4M7.6 9.2l-1.2-1.2M7.6 9.2l1.2-1.2M16.4 14.8v2.4M16.4 14.8l-1.2 1.2M16.4 14.8l1.2 1.2"/>',
  },
  {
    color: 'green',
    title: '水平调度系统',
    desc: '车辆出入场调度管理',
    svg: '<path d="M4 14.5h2.2l1.6-4.2h8.2L18 14.5h2"/><path d="M5 14.5v3.2h14V14.5"/><circle cx="8" cy="18.2" r="1.4"/><circle cx="16" cy="18.2" r="1.4"/><path d="M7.8 10.3 9 7.8h6.2"/>',
  },
  {
    color: 'orange',
    title: '工地地图导航',
    desc: '施工工地场内区域定位与导航',
    svg: '<path d="M21 4 3.8 11.2l7.4 1.6L12.8 20z"/><path d="M11.2 12.8 21 4"/>',
  },
]

function onShortClick(work: string): void {
  // 原 app.js:997-1005 —— cam 打开首个点位，photo 开航拍，hazard 开隐患，其余提示待定
  if (work === 'cam') cam.openCam(cam.cameras[0].id)
  else if (work === 'photo') air.openAir()
  else if (work === 'hazard') air.openHazard()
  else shell.showToast('功能待定')
}

/**
 * 工具卡点击反馈（2026-10 改造新增）。
 * 原版 3 个 .tool-card 无任何事件绑定（纯展示），点击静默无反馈，
 * 现补「接入中」提示作为明确出口；接入后端后替换为真实跳转。
 */
function onToolClick(title: string): void {
  shell.showToast(`「${title}」接入中，敬请期待`)
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
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" v-html="s.svg" />
        </i>
        <span>{{ s.label }}</span>
      </button>
    </div>

    <div class="tool-list">
      <div v-for="t in tools" :key="t.title" class="tool-card" role="button" @click="onToolClick(t.title)">
        <div class="tool-ico" :class="t.color">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" v-html="t.svg" />
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
