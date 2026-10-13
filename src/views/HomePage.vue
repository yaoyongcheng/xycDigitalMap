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
 * --sheet-up-top 的合理上限（px）。
 *
 * .home-progress 恒定在首页顶部区域，正常结果约 110~150px，300px 已相当宽松。
 * 这里刻意用绝对值而不是「页面高度的百分比」：真机诊断显示，出问题的那一刻
 * 页面高度本身也会异常（Safari 恢复标签页时先以错误的视口高度渲染一瞬），
 * 百分比阈值会跟着一起放大而失效 —— 实测放行过一个 505px 的坏值。
 */
const SHEET_TOP_MAX = 300

/** 布局稳定后的补测句柄 */
let recalibrateTimer = 0

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
  const top = Math.round(progRect.bottom - pageRect.top + 12)
  /*
   * 只接受落在合理区间的结果，否则保留 CSS 里 --sheet-up-top 的默认值（118px）。
   *
   * 布局未就绪时 rect 会整体为 0（元素尚未参与布局，或所在页面正处于
   * display:none），此时算出的值会把抽屉顶到错误位置：偏小会贴到顶栏，
   * 偏大会沉到接近收起态的位置 —— 后者在真机上表现为「展开态却停在低位」。
   * 而 --sheet-up-top 一旦被写成坏值，top 声明本身仍合法，不会回退到默认值，
   * 抽屉就永久停在错误位置。
   */
  if (top <= 24 || top >= SHEET_TOP_MAX) return
  el.style.setProperty('--sheet-up-top', top + 'px')
}

function onResize(): void {
  // 原 js/app.js:950 —— 仅在抽屉展开时重算
  if (shell.sheetUp) nextTick(applySheetTop)
}

onMounted(() => {
  nextTick(applySheetTop)
  /*
   * 首次测量可能早于布局稳定 —— Safari 恢复标签页时，地址栏的收放会改变
   * 100dvh，页面高度在最初几帧是错的，此时测出的值会被上面的校验拦下，
   * 抽屉停在 CSS 默认位置（视觉正确但不精确）。
   * 下面两处补测让它在布局稳定后自动校准回来。
   */
  recalibrateTimer = window.setTimeout(applySheetTop, 600)

  window.addEventListener('resize', onResize)
  // Safari 的地址栏收放只改 visualViewport，未必触发 window 的 resize
  window.visualViewport?.addEventListener('resize', onResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.visualViewport?.removeEventListener('resize', onResize)
  window.clearTimeout(recalibrateTimer)
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
      <!--
        文案随状态切换（显隐规则见 app.css 的 #page-home.is-sheet-up 那组）：
          收起态 -> 上箭头 +「拉起」；展开态 -> 下箭头 +「收回」。
        原版展开态写的是「展开」，与本按钮此刻的含义正好相反 —— 抽屉已经展开了，
        按钮该表达的是「点它可收回」，否则用户会误以为当前是收起状态。
        类名沿用了旧的 expand 命名，读代码时以文案为准。
      -->
      <span class="lab-pull">拉起</span>
      <span class="lab-expand">收回</span>
    </button>

    <HomeSheet />
  </section>
</template>
