<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import type { LineModel } from '@/utils/chart'

/**
 * 折线图触控层（2026-10 改造新增）
 *
 * chart.ts 输出的 SVG 字符串作为底图（v-html 原样渲染，几何与配色
 * 与原版逐字节一致），本组件在其上叠一层同 viewBox 的透明交互层：
 *   - 按下 / 横向拖动 → 吸附最近数据点（不要求精确点中小圆点，
 *     触控热区是整列高度，手指容错好）
 *   - 选中点画竖向参考线 + 放大圆点，气泡显示各系列数值
 *   - 松手约 2.6s 后自动消失；再点可立即切换
 *
 * 手势边界：交互层 touch-action: pan-y —— 横滑归图表选点，
 * 纵滑仍交还页面滚动；抽屉拖拽只绑在抓手条上，与本层不冲突。
 */
const props = defineProps<{ model: LineModel }>()

const boxEl = ref<HTMLElement>()
const layerEl = ref<SVGSVGElement>()
const active = ref<number | null>(null)
let hideTimer = 0
let dragging = false

/** 模板里可安全索引的下标（-1 = 未选中） */
const cur = computed(() => (active.value == null ? -1 : active.value))

function scheduleHide(): void {
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => (active.value = null), 2600)
}

/**
 * clientX → 最近数据点下标。
 * 底图 SVG 与交互层同 viewBox、同 preserveAspectRatio（默认 meet，
 * 容器与 viewBox 比例不一致时会等比留白居中），因此坐标换算必须走
 * getScreenCTM 而不是简单的容器宽度百分比，否则热区会整体偏移。
 */
function indexFromClientX(clientX: number): number {
  const svg = layerEl.value
  if (!svg) return 0
  const ctm = svg.getScreenCTM()
  if (!ctm) return 0
  const x = new DOMPoint(clientX, 0).matrixTransform(ctm.inverse()).x
  let best = 0
  let bd = Infinity
  for (let i = 0; i < props.model.xs.length; i++) {
    const d = Math.abs(props.model.xs[i] - x)
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

function onDown(e: PointerEvent): void {
  dragging = true
  ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
  window.clearTimeout(hideTimer)
  active.value = indexFromClientX(e.clientX)
}

function onMove(e: PointerEvent): void {
  if (!dragging) return
  const i = indexFromClientX(e.clientX)
  if (i !== active.value) active.value = i
}

function onUp(): void {
  dragging = false
  scheduleHide()
}

watch(active, (v) => {
  if (v == null) window.clearTimeout(hideTimer)
})
onBeforeUnmount(() => window.clearTimeout(hideTimer))

/** 气泡内容：刻度标签 + 各系列值（null 显示 —） */
const tip = computed(() => {
  const i = cur.value
  if (i < 0) return null
  return {
    label: props.model.ticks[i],
    parts: props.model.series.map((s) => ({ name: s.name, color: s.color, v: s.values[i] })),
  }
})

/** 气泡水平位置：选中点换算到容器坐标，两端钳制防溢出 */
const tipLeft = computed(() => {
  const i = cur.value
  const svg = layerEl.value
  const box = boxEl.value
  if (i < 0 || !svg || !box) return 0
  const ctm = svg.getScreenCTM()
  if (!ctm) return 0
  const p = new DOMPoint(props.model.xs[i], 0).matrixTransform(ctm)
  const left = p.x - box.getBoundingClientRect().left
  const w = box.clientWidth || 1
  return Math.min(Math.max(left, 52), w - 52)
})
</script>

<template>
  <div ref="boxEl" class="touch-chart">
    <div class="tc-base" v-html="model.svg"></div>
    <svg
      ref="layerEl"
      class="tc-layer"
      :viewBox="`0 0 ${model.w} ${model.h}`"
      preserveAspectRatio="xMidYMid meet"
      @pointerdown.prevent="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <g v-if="cur >= 0">
        <line
          class="tc-guide"
          :x1="model.xs[cur]"
          :y1="2"
          :x2="model.xs[cur]"
          :y2="model.h - 18"
        />
        <circle
          v-for="(s, si) in model.series"
          v-show="model.ys[si][cur] != null"
          :key="s.name"
          class="tc-dot"
          r="4"
          :fill="s.color"
          :cx="model.xs[cur]"
          :cy="model.ys[si][cur] ?? 0"
        />
      </g>
    </svg>
    <Transition name="tc">
      <div v-if="tip" class="tc-tip" :style="{ left: tipLeft + 'px' }">
        <span class="tc-lab">{{ tip.label }}</span>
        <span v-for="p in tip.parts" :key="p.name" class="tc-val">
          <i :style="{ background: p.color }"></i>{{ p.name }} {{ p.v ?? '—' }}
        </span>
      </div>
    </Transition>
  </div>
</template>
