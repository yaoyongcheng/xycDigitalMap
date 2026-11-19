<script setup lang="ts">
import { computed } from 'vue'

import { useAlarmStore } from '@/stores/alarm'

/**
 * 占位图标上的缩略图下载进度环（2026-11-19）
 *
 * 抓拍图单张约 1MB、现场 2~3s 才回来，这段时间图标位上只有一颗静止的摄像机，
 * 看的人分不清是「正在取图」还是「这条没有图」。这里在图标外圈画一圈进度：
 *
 *   · 只读 store 的两个派生值（{@link useAlarmStore} 的 `thumbBusyOf` /
 *     `thumbPctOf`），自己不发起任何请求 —— 进度属于取图链路，不属于某个组件；
 *   · 绝对定位铺满图标位（`inset: 0`），尺寸由容器决定，不参与布局流，
 *     所以三处 42 / 44 / 48px 的图标位版式一格都不用改；
 *   · `pointer-events: none`，点整行进详情的交互不受影响；
 *   · 没有 `Content-Length` 时走不确定态（四分之一圈 + 旋转），不编一个假百分比 ——
 *     假进度一定会在最后突然跳到 100%，比转圈更让人困惑。
 */
const props = defineProps<{ id: string }>()

const alarm = useAlarmStore()

const busy = computed(() => alarm.thumbBusyOf(props.id))
const pct = computed(() => alarm.thumbPctOf(props.id))

/** 半径按 viewBox 36 定；周长直接算出来，不用 `pathLength`（老 Safari 上表现不稳） */
const R = 15.5
const C = 2 * Math.PI * R

/**
 * 弧长：真实百分比按比例收，不确定态留 28% 的空缺。
 * 进度封顶在 99% 由 store 侧完成（100% 留给「图已经出现」）。
 */
const dashOffset = computed(() => (pct.value > 0 ? C * (1 - pct.value / 100) : C * 0.72))
</script>

<template>
  <svg
    v-if="busy"
    class="tile-ring"
    :class="{ 'is-indeterminate': pct <= 0 }"
    viewBox="0 0 36 36"
    aria-hidden="true"
  >
    <circle class="tile-ring-track" :cx="18" :cy="18" :r="R" />
    <circle
      class="tile-ring-bar"
      :cx="18"
      :cy="18"
      :r="R"
      :stroke-dasharray="C"
      :stroke-dashoffset="dashOffset"
    />
  </svg>
</template>
