<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'

/**
 * 环形图扇区点击（2026-10 改造新增）
 *
 * conic-gradient 只是背景色，DOM 里没有「扇区」概念 —— 本组件在
 * 原有 .donut 之上叠一层同尺寸的透明命中环（按角度切分的扇形 path）：
 *   - 点击扇形 → 该段着色高亮 + 底部气泡显示「标签 数值 · 占比」
 *   - 点击已选中段 / 图例联动（父组件持有 selected）→ 取消选中
 *   - 选中约 3s 后自动消失
 *
 * 选中状态由父组件持有（selected prop + select 事件），
 * 便于图例反向联动：点图例同样能高亮扇区。
 */
const props = withDefaults(
  defineProps<{
    segments: { label: string; value: number; color: string }[]
    /** 附加到内部 .donut 上的修饰类（eq-status-donut / qa-step-donut） */
    donutClass?: string
    selected?: number | null
  }>(),
  { donutClass: '', selected: null },
)

const emit = defineEmits<{ (e: 'select', i: number | null): void }>()

const total = computed(() => props.segments.reduce((s, d) => s + d.value, 0))

/** conic-gradient 字符串（展开顺序与原实现一致：累加器循环） */
const pie = computed(() => {
  let acc = 0
  return (
    'conic-gradient(' +
    props.segments
      .map((d) => {
        const a = acc
        acc += (d.value / (total.value || 1)) * 100
        return `${d.color} ${a}% ${acc}%`
      })
      .join(', ') +
    ')'
  )
})

/** 每段起止角（deg；0 = 顶部，顺时针 —— 与 conic-gradient 语义一致） */
const spans = computed(() => {
  let acc = 0
  return props.segments.map((d) => {
    const a0 = acc
    acc += (d.value / (total.value || 1)) * 360
    return { a0, a1: acc }
  })
})

/** 圆上取点：viewBox 100×100，圆心 50,50，角度自顶部顺时针 */
function pt(r: number, deg: number): [number, number] {
  const rad = ((deg % 360) * Math.PI) / 180
  return [+(50 + r * Math.sin(rad)).toFixed(2), +(50 - r * Math.cos(rad)).toFixed(2)]
}

/** 命中环扇形（外 r50 / 内 r28，覆盖各尺寸环形图的色带；整圈特判） */
function ringPath(a0: number, a1: number): string {
  if (a1 - a0 >= 359.9) {
    const [ox, oy] = pt(50, 0)
    const [hx, hy] = pt(50, 180)
    const [ix, iy] = pt(28, 0)
    const [jx, jy] = pt(28, 180)
    return `M${ox},${oy} A50,50 0 1 1 ${hx},${hy} A50,50 0 1 1 ${ox},${oy} L${ix},${iy} A28,28 0 1 0 ${jx},${jy} A28,28 0 1 0 ${ix},${iy} Z`
  }
  const large = a1 - a0 > 180 ? 1 : 0
  const [x0, y0] = pt(50, a0)
  const [x1, y1] = pt(50, a1)
  const [x2, y2] = pt(28, a1)
  const [x3, y3] = pt(28, a0)
  return `M${x0},${y0} A50,50 0 ${large} 1 ${x1},${y1} L${x2},${y2} A28,28 0 ${large} 0 ${x3},${y3} Z`
}

function onSeg(i: number): void {
  emit('select', props.selected === i ? null : i)
}

/** 选中段（高亮弧 + 气泡数据），越界安全返回 null */
const selSeg = computed(() => {
  const i = props.selected
  if (i == null || i < 0 || i >= spans.value.length) return null
  const s = props.segments[i]
  const pct = total.value ? Math.round((s.value / total.value) * 100) : 0
  return { i, a0: spans.value[i].a0, a1: spans.value[i].a1, color: s.color, tip: `${s.label} ${s.value} · 占 ${pct}%` }
})

let timer = 0
watch(
  () => props.selected,
  (v) => {
    window.clearTimeout(timer)
    if (v != null) timer = window.setTimeout(() => emit('select', null), 3000)
  },
)
onBeforeUnmount(() => window.clearTimeout(timer))
</script>

<template>
  <span class="donut-touch">
    <i class="donut" :class="donutClass" :style="{ background: pie }"><slot /></i>
    <svg class="dt-hit" viewBox="0 0 100 100" aria-hidden="true">
      <path
        v-for="(s, i) in spans"
        :key="i"
        class="dt-seg"
        :d="ringPath(s.a0, s.a1)"
        @pointerdown.prevent="onSeg(i)"
      />
      <path v-if="selSeg" class="dt-sel" :d="ringPath(selSeg.a0, selSeg.a1)" :fill="selSeg.color" />
    </svg>
    <Transition name="dt">
      <span v-if="selSeg" class="dt-tip">{{ selSeg.tip }}</span>
    </Transition>
  </span>
</template>
