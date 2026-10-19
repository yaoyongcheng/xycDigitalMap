<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import DonutTouch from '@/components/ui/DonutTouch.vue'
import { qaSteps } from '@/data/config'
import { useHomeStore } from '@/stores/home'

/**
 * 首页 · 质量管理面板
 *
 * 对应原 js/app.js:442-487 renderQuality()。
 * 两块内容：合格率对比柱状图 + 验收工序环形图。
 *
 * 2026-10 触控改造：
 *   - 柱状图支持点击 / 横滑选中某列：其余列淡化，气泡显示
 *     「本月 vs 上月 + 差值」；松手约 2.6s 后自动取消
 *   - 验收工序环形图换 DonutTouch：点击扇区高亮 + 气泡显示占比，
 *     图例与扇区双向联动
 */
const home = useHomeStore()

/** 触控版环形图分段（name/n/color → label/value/color） */
const qaSegs = computed(() => qaSteps.map((d) => ({ label: d.name, value: d.n, color: d.color })))

/** 验收工序选中段（扇区与图例双向联动） */
const qaSel = ref<number | null>(null)

/** 图例点选：同一段再点一次取消选中 */
function toggleStep(i: number): void {
  qaSel.value = qaSel.value === i ? null : i
}

/** 键盘等价操作（Enter / Space） */
function onKey(e: KeyboardEvent, i: number): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    toggleStep(i)
  }
}

/* —— 合格率柱状图触控 —— */

const colsEl = ref<HTMLElement>()
const barSel = ref<number | null>(null)
let barDrag = false
let barTimer = 0

const colN = computed(() => home.qaCats.length)

/** clientX → 最近列下标（列宽均分，天然容错，不要求精确点中柱子） */
function barIndexFromX(clientX: number): number {
  const el = colsEl.value
  if (!el) return 0
  const r = el.getBoundingClientRect()
  const i = Math.floor(((clientX - r.left) / r.width) * colN.value)
  return Math.min(Math.max(i, 0), colN.value - 1)
}

function setBar(i: number): void {
  window.clearTimeout(barTimer)
  barSel.value = i
}

function onBarDown(e: PointerEvent): void {
  barDrag = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  setBar(barIndexFromX(e.clientX))
}

function onBarMove(e: PointerEvent): void {
  if (barDrag) setBar(barIndexFromX(e.clientX))
}

function onBarUp(): void {
  barDrag = false
  window.clearTimeout(barTimer)
  barTimer = window.setTimeout(() => (barSel.value = null), 2600)
}

onBeforeUnmount(() => window.clearTimeout(barTimer))

/** 气泡内容：本月 / 上月 / 差值（带符号） */
const barTip = computed(() => {
  const i = barSel.value
  if (i == null || i >= home.qaCats.length) return null
  const d = home.qaCats[i]
  const delta = d.now - d.last
  const sign = delta >= 0 ? '+' : ''
  return `${d.name} 本月 ${d.now}% · 上月 ${d.last}%（${sign}${delta}）`
})

/** 气泡水平位置：选中列中心百分比，两端钳制防溢出 */
const barLeft = computed(() => {
  const i = barSel.value
  if (i == null) return '50%'
  const pct = ((i + 0.5) / colN.value) * 100
  return `${Math.min(Math.max(pct, 16), 84)}%`
})
</script>

<template>
  <div class="safe-block">
    <h4>合格率</h4>
    <div class="home-chart-card qa-pass">
      <div class="qa-pass-hd">
        <span>合格率%</span>
        <div class="qa-pass-leg">
          <span><i class="last"></i>上月合格率</span>
          <span><i class="now"></i>本月合格率</span>
        </div>
      </div>
      <div class="qa-pass-plot">
        <div class="qa-pass-y"><em>100</em><em>80</em><em>60</em><em>40</em><em>20</em><em>0</em></div>
        <div
          ref="colsEl"
          class="qa-pass-cols"
          :class="{ pick: barSel != null }"
          @pointerdown.prevent="onBarDown"
          @pointermove="onBarMove"
          @pointerup="onBarUp"
          @pointercancel="onBarUp"
        >
          <div v-for="(d, i) in home.qaCats" :key="d.name" class="qa-pass-col" :class="{ on: barSel === i }">
            <div class="qa-pass-pair">
              <b class="last" :style="{ height: d.last + '%' }"><em>{{ d.last }}</em></b>
              <b class="now" :style="{ height: d.now + '%' }"><em>{{ d.now }}</em></b>
            </div>
            <span>{{ d.name }}</span>
          </div>
          <Transition name="bt">
            <span v-if="barTip" class="bar-tip" :style="{ left: barLeft }">{{ barTip }}</span>
          </Transition>
        </div>
      </div>
    </div>
  </div>

  <div class="safe-block">
    <h4>验收工序</h4>
    <div class="home-chart-card">
      <div class="home-chart-row qa-chart">
        <DonutTouch
          :segments="qaSegs"
          donut-class="qa-step-donut"
          :selected="qaSel"
          @select="qaSel = $event"
        >
          <div class="donut-label"><b>100</b><span>验收工序</span></div>
        </DonutTouch>
        <div class="qa-legend">
          <!-- 图例是筛选开关：补 role/tabindex/aria-pressed，键盘与读屏可达 -->
          <div
            v-for="(d, i) in qaSteps"
            :key="d.name"
            class="qa-legend-item"
            :class="{ 'leg-on': qaSel === i }"
            role="button"
            tabindex="0"
            :aria-pressed="qaSel === i"
            @click="toggleStep(i)"
            @keydown="onKey($event, i)"
          >
            <i :style="{ background: d.color }"></i><span>{{ d.name }}</span><em>{{ d.n }}</em>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
