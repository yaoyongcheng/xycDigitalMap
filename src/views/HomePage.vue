<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { useHomeStore } from '@/stores/home'
import { useShellStore } from '@/stores/shell'
import type { HomeMod } from '@/types'

/**
 * 首页
 *
 * 对应原 index.html:185-233 + setSheetUp()（app.js:927-939）
 * + 模块切换委托（app.js:941-947）+ 全屏按钮（app.js:1715）。
 *
 * 四个面板的内容（#homePanels）在后续提交迁入 HomeSheet 与各 Panel 组件，
 * 本步骤先落地页面骨架与交互。
 */
const shell = useShellStore()
const home = useHomeStore()

const pageEl = ref<HTMLElement | null>(null)

/** 原 index.html:213-229 的四个 .home-mod，逐字重复结构改 v-for（DOM 相同） */
const mods: { id: HomeMod; label: string; svg: string }[] = [
  {
    id: 'safety',
    label: '安全管理',
    svg: '<path d="M12 3.5 19 6.2v5.4c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V6.2z"/><path d="M8.8 12.2 11 14.4l4.4-4.6"/>',
  },
  {
    id: 'quality',
    label: '质量管理',
    svg: '<rect x="6.2" y="3.8" width="11.6" height="16.4" rx="2"/><path d="M9 3.8h6v2.6H9z"/><path d="M8.7 12.4 10.8 14.5l4.6-4.8"/>',
  },
  {
    id: 'progress',
    label: '进度管理',
    svg: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.2l3 1.6"/>',
  },
  {
    id: 'equip',
    label: '装备管控',
    svg: '<path d="M4.5 20h15"/><path d="M7 20V7.5h3.2V20"/><path d="M8.6 7.5H20l-3.2 6.2"/><path d="M16.8 13.7V20"/><circle cx="16.8" cy="11.2" r="1.1"/>',
  },
]

/**
 * 原 js/app.js:927-939 setSheetUp() 中写 --sheet-up-top 的那段。
 * 需要真实测量 .home-progress 的位置，故直接操作 DOM（这是测量，不是状态）。
 */
function applySheetTop(): void {
  const el = pageEl.value
  if (!el || !shell.sheetUp) return
  const prog = el.querySelector('.home-progress')
  if (!prog) return
  const pageRect = el.getBoundingClientRect()
  const progRect = prog.getBoundingClientRect()
  el.style.setProperty('--sheet-up-top', Math.round(progRect.bottom - pageRect.top + 12) + 'px')
}

function onResize(): void {
  // 原 js/app.js:950 —— 仅在抽屉展开时重算
  if (shell.sheetUp) nextTick(applySheetTop)
}

onMounted(() => {
  nextTick(applySheetTop)
  window.addEventListener('resize', onResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
})

watch(
  () => shell.sheetUp,
  () => nextTick(applySheetTop),
)

function onModClick(id: HomeMod): void {
  // 原 app.js:944-946 —— 改状态 + 切 .on + 重渲染面板
  home.homeMod = id
}

function onSheetToggle(): void {
  shell.sheetUp = !shell.sheetUp
}

function onMapFull(): void {
  shell.openMapLand()
}
</script>

<template>
  <section class="page home-page" id="page-home" ref="pageEl" :class="{ active: shell.activeTab === 'home', 'is-sheet-up': shell.sheetUp }">
    <div class="home-scene">
      <div class="home-map" role="img" aria-label="工地数字地图"></div>
      <div class="home-top">
        <div class="home-project-row">
          <div class="home-project">向阳村项目智能建造管理平台</div>
          <button class="home-full" id="btnMapFull" type="button" @click="onMapFull">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 5H5v3M16 5h3v3M8 19H5v-3M16 19h3v-3"/></svg>
            全屏
          </button>
        </div>
        <div class="home-progress">
          <div class="home-progress-hd">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.2l3 1.6"/></svg>
            项目总进度 <b>53%</b>
          </div>
          <span class="home-progress-bar"><i></i></span>
        </div>
      </div>
    </div>

    <div class="home-gutter-mask" aria-hidden="true"></div>

    <button class="home-sheet-toggle" id="btnSheetToggle" type="button" @click="onSheetToggle">
      <svg class="ico-pull" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l6-6 6 6"/></svg>
      <svg class="ico-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg>
      <span class="lab-pull">拉起</span>
      <span class="lab-expand">展开</span>
    </button>

    <div class="home-sheet">
      <div class="home-mods" id="homeMods">
        <button
          v-for="m in mods"
          :key="m.id"
          class="home-mod"
          :class="{ on: home.homeMod === m.id }"
          :data-mod="m.id"
          type="button"
          @click="onModClick(m.id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" v-html="m.svg" />
          <span>{{ m.label }}</span>
        </button>
      </div>
      <div class="home-panels" id="homePanels"></div>
    </div>
  </section>
</template>
