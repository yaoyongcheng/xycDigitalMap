<script lang="ts">
/**
 * 已展示过的终值：value+decimals → 终值（仅 sticky 模式使用）。
 *
 * 必须放在普通 <script> 块里 —— <script setup> 的内容会被编译进 setup()
 * 函数体，每次实例化都重新执行，写在那里等于每次都是空 Map，sticky 完全
 * 失效。只有模块作用域才能跨实例记住「这个值已经滚过了」。
 */
const seen = new Map<string, number>()
</script>

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
    /**
     * 同一个值不再重播滚动。
     *
     * 这些数字大量出现在首页抽屉的面板里，而面板是 v-if 切换的 —— 切走再
     * 切回会让组件重新挂载，于是同一个「37 台」每次都从 0 滚一遍。首次该
     * 看到动画，反复进出则是纯噪音。开启后：值未变直接显示终值，值真变了
     * 才滚。模块级记忆见下方 seen。
     */
    sticky?: boolean
  }>(),
  { decimals: 0, duration: 900, sticky: false },
)

const shown = ref('0')

let raf = 0
let displayed = 0

const reduceMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function render(v: number): void {
  shown.value = v.toFixed(props.decimals)
}

function remember(target: number): void {
  if (props.sticky) seen.set(`${target}|${props.decimals}`, target)
}

/** sticky 模式下该值是否已经完整展示过一次 */
function alreadyShown(target: number): boolean {
  return props.sticky && seen.get(`${target}|${props.decimals}`) === target
}

function animateTo(target: number): void {
  window.cancelAnimationFrame(raf)
  if (reduceMotion || props.duration <= 0 || alreadyShown(target)) {
    displayed = target
    render(target)
    remember(target)
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
      remember(target)
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
