<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'

/**
 * 数字滚动（2026-10 改造新增）
 *
 * 值变化或挂载时从当前显示值平滑滚动到目标值（easeOutCubic）。
 * 尊重 prefers-reduced-motion：用户开了减弱动效则直接跳到终值。
 * 渲染为无样式的 <span>，字号/颜色全部继承父级，可直接替换 {{ n }}。
 */
const props = withDefaults(
  defineProps<{
    value: number
    /** 小数位数 */
    decimals?: number
    /** 滚动时长 ms */
    duration?: number
  }>(),
  { decimals: 0, duration: 900 },
)

const shown = ref('0')

let raf = 0
let displayed = 0

const reduceMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function render(v: number): void {
  shown.value = v.toFixed(props.decimals)
}

function animateTo(target: number): void {
  window.cancelAnimationFrame(raf)
  if (reduceMotion || props.duration <= 0) {
    displayed = target
    render(target)
    return
  }
  const from = displayed
  const t0 = performance.now()
  const tick = (t: number): void => {
    const p = Math.min(1, (t - t0) / props.duration)
    const eased = 1 - Math.pow(1 - p, 3)
    displayed = from + (target - from) * eased
    render(displayed)
    if (p < 1) raf = window.requestAnimationFrame(tick)
    else {
      displayed = target
      render(target)
    }
  }
  raf = window.requestAnimationFrame(tick)
}

onMounted(() => animateTo(props.value))

watch(
  () => props.value,
  (v) => animateTo(v),
)

onUnmounted(() => window.cancelAnimationFrame(raf))
</script>

<template>
  <span class="count-up">{{ shown }}</span>
</template>
