<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import HomeProgress from '@/components/ui/HomeProgress.vue'
import { useShellStore } from '@/stores/shell'
import HomeSheet from './home/HomeSheet.vue'

/**
 * 首页
 *
 * 对应原 index.html:185-233 + setSheetUp()（app.js:927-939）
 * + 全屏按钮（app.js:1715）。
 * 抽屉与其内的四个面板交由 HomeSheet 组件。
 */
const shell = useShellStore()

const pageEl = ref<HTMLElement | null>(null)

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
        <HomeProgress />
      </div>
    </div>

    <div class="home-gutter-mask" aria-hidden="true"></div>

    <button class="home-sheet-toggle" id="btnSheetToggle" type="button" @click="onSheetToggle">
      <svg class="ico-pull" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l6-6 6 6"/></svg>
      <svg class="ico-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg>
      <span class="lab-pull">拉起</span>
      <span class="lab-expand">展开</span>
    </button>

    <HomeSheet />
  </section>
</template>
