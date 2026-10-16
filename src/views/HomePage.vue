<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import HomeProgress from '@/components/ui/HomeProgress.vue'
import MapInfoCard from '@/components/ui/MapInfoCard.vue'
import MapViewer from '@/components/ui/MapViewer.vue'
import { mapPoints } from '@/data/config'
import { useCamStore } from '@/stores/cam'
import { useHomeStore } from '@/stores/home'
import { useShellStore } from '@/stores/shell'
import type { Building, MapPoint } from '@/types'
import HomeSheet from './home/HomeSheet.vue'

/**
 * 首页
 *
 * 对应原 index.html:185-233 + setSheetUp()（app.js:927-939）
 * + 全屏按钮（app.js:1715）。
 * 抽屉与其内的四个面板交由 HomeSheet 组件。
 *
 * 2026-10 改造新增：
 *   ① .home-map 内嵌 MapViewer —— 静态底图升级为可拖拽/缩放/撒点的
 *      交互地图层（点位点击：cam/crane 打开监控，building 弹进度摘要）
 *   ② 抽屉支持跟手拖拽 + 三档吸附（收起/半开/全开），档位状态在
 *      shell.sheetLevel；拖拽中的临时位置走 dragTop 内联样式，
 *      松手吸附后全开/收起仍交还 CSS 变量与 class 体系
 */
const shell = useShellStore()
const cam = useCamStore()
const home = useHomeStore()

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
 * 测量全开档的抽屉顶位置（原 js/app.js:927-939 setSheetUp 的取值部分）。
 * 需要真实测量 .home-progress 的位置，故直接操作 DOM（这是测量，不是状态）。
 * 测量不合法（布局未就绪/异常视口）时返回 null，由调用方决定回退。
 */
function measureExpandedTop(): number | null {
  const el = pageEl.value
  if (!el) return null
  const prog = el.querySelector('.home-progress')
  if (!prog) return null
  const pageRect = el.getBoundingClientRect()
  const progRect = prog.getBoundingClientRect()
  const top = Math.round(progRect.bottom - pageRect.top + 12)
  /*
   * 只接受落在合理区间的结果：布局未就绪时 rect 会整体为 0（元素尚未参与
   * 布局，或所在页面正处于 display:none），此时算出的值会把抽屉顶到错误位置。
   */
  if (top <= 24 || top >= SHEET_TOP_MAX) return null
  return top
}

/** 原 setSheetUp() 中写 --sheet-up-top 的那段 */
function applySheetTop(): void {
  const el = pageEl.value
  if (!el || !shell.sheetUp) return
  const top = measureExpandedTop()
  /*
   * 测量失败时保留 CSS 里 --sheet-up-top 的默认值（118px）。
   * 该变量一旦被写成坏值，top 声明本身仍合法，不会回退到默认值，
   * 抽屉就永久停在错误位置。
   */
  if (top === null) return
  el.style.setProperty('--sheet-up-top', top + 'px')
}

/* ---------------- 抽屉三档与跟手拖拽（新增） ---------------- */

/** 拖拽中的临时顶位置（px）；null 表示交还 CSS（class/变量）控制 */
const dragTop = ref<number | null>(null)

/** 拖拽进行中（用于关闭 CSS transition，避免跟手迟滞） */
const dragging = ref(false)

/** 三档吸附位置（px，相对页面顶部） */
function sheetAnchors(): { expanded: number; mid: number; collapsed: number } {
  const h = pageEl.value?.getBoundingClientRect().height ?? 0
  const expanded = measureExpandedTop() ?? 118
  const collapsed = Math.round(h * 0.42)
  return { expanded, collapsed, mid: Math.round((expanded + collapsed) / 2) }
}

/** 当前档位对应的顶位置（px） */
function currentLevelTop(): number {
  const a = sheetAnchors()
  if (shell.sheetLevel === 2) return a.expanded
  if (shell.sheetLevel === 1) return a.mid
  return a.collapsed
}

let dragStartY = 0
let dragStartTop = 0
let dragMoved = false
let suppressToggleClick = false

/** 拖拽入口：切换按钮的 pointerdown 与 HomeSheet 抓手条的 grab 事件共用 */
function onDragStart(e: PointerEvent): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  dragStartY = e.clientY
  dragStartTop = dragTop.value ?? currentLevelTop()
  dragMoved = false
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
}

function onDragMove(e: PointerEvent): void {
  const dy = e.clientY - dragStartY
  if (!dragMoved && Math.abs(dy) > 4) {
    dragMoved = true
    dragging.value = true
  }
  if (!dragMoved) return
  const a = sheetAnchors()
  // 允许轻微越界（±20px）提供拖拽弹性，松手后吸附回档位
  dragTop.value = Math.min(a.collapsed + 20, Math.max(a.expanded - 20, dragStartTop + dy))
}

function onDragEnd(): void {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  if (!dragMoved) return
  // 抑制拖拽后合成 click 误触切换按钮的收放
  suppressToggleClick = true
  window.setTimeout(() => {
    suppressToggleClick = false
  }, 50)

  const a = sheetAnchors()
  const t = dragTop.value ?? dragStartTop
  // 吸附到最近档位
  const candidates: { level: 0 | 1 | 2; top: number }[] = [
    { level: 2, top: a.expanded },
    { level: 1, top: a.mid },
    { level: 0, top: a.collapsed },
  ]
  candidates.sort((x, y) => Math.abs(x.top - t) - Math.abs(y.top - t))
  const target = candidates[0]

  dragging.value = false
  shell.sheetLevel = target.level
  if (target.level === 1) {
    // 半开档无对应 CSS 规则，常驻内联位置
    dragTop.value = target.top
  } else {
    // 全开/收起交还 CSS（is-sheet-up + --sheet-up-top / 42%），
    // 摘掉内联值后由 transition 完成吸附动画
    dragTop.value = null
    if (target.level === 2) nextTick(applySheetTop)
  }
}

function onResize(): void {
  // 原 js/app.js:950 —— 仅在抽屉抬起时重测全开档位置
  if (shell.sheetUp) nextTick(applySheetTop)
  // 半开档位置依赖页面高度，窗口变化时重算内联值
  if (shell.sheetLevel === 1) dragTop.value = sheetAnchors().mid
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
  onDragEnd()
})

watch(
  () => shell.sheetUp,
  () => nextTick(applySheetTop),
)

function onSheetToggle(): void {
  if (suppressToggleClick) return
  // 点按在收起 ↔ 全开间切换（半开档仅通过拖拽到达）
  shell.sheetLevel = shell.sheetLevel === 0 ? 2 : 0
  dragTop.value = null
}

function onMapFull(): void {
  shell.openMapLand()
}

/** 楼栋撒点的信息卡（2026-10 第二轮改造：Toast 升级为地图内底部信息卡） */
const infoBuilding = ref<Building | null>(null)

/** 地图点位点击：监控/塔吊直接打开对应点位画面，楼栋弹信息卡 */
function onMapPoint(p: MapPoint): void {
  if ((p.kind === 'cam' || p.kind === 'crane') && p.camId) {
    infoBuilding.value = null
    cam.openCam(p.camId)
    return
  }
  if (p.kind === 'building') {
    infoBuilding.value = home.siteBuildings.find((x) => x.name === p.name) ?? null
  }
}
</script>

<template>
  <section
    class="page home-page"
    id="page-home"
    ref="pageEl"
    :class="{ active: shell.activeTab === 'home', 'is-sheet-up': shell.sheetUp, 'is-dragging': dragging }"
  >
    <div class="home-scene">
      <div class="home-map">
        <MapViewer :points="mapPoints" fit="cover" compact @select="onMapPoint" />
        <MapInfoCard :building="infoBuilding" @close="infoBuilding = null" />
      </div>
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

    <button
      class="home-sheet-toggle"
      id="btnSheetToggle"
      type="button"
      :style="dragTop !== null ? { top: dragTop + 'px' } : undefined"
      @pointerdown="onDragStart"
      @click="onSheetToggle"
    >
      <svg class="ico-pull" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l6-6 6 6"/></svg>
      <svg class="ico-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg>
      <!--
        文案随状态切换（显隐规则见 app.css 的 #page-home.is-sheet-up 那组）：
          收起态 -> 上箭头 +「拉起」；抬起态（半开/全开）-> 下箭头 +「收回」。
      -->
      <span class="lab-pull">拉起</span>
      <span class="lab-expand">收回</span>
    </button>

    <HomeSheet :drag-top="dragTop" @grab="onDragStart" />
  </section>
</template>
