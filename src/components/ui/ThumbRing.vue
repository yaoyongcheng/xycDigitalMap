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
 *
 * ## 2026-11-20：也可以由调用方喂状态
 *
 * 无人机预警（`stores/droneAlarm.ts`）的图标位要用**同一个环**，但它的数据来自
 * 另一套后端、另一份 store。于是这里加了两个可选的 `busy` / `pct`：
 *
 *   · 不传（报警侧一贯如此）→ 仍旧从 `useAlarmStore()` 取，行为与改之前逐字节相同；
 *   · 传了 → 用调用方的值，本组件不碰报警 store。
 *
 * 只加两个可选入参、不动任何取值顺序，是为了让「公共逻辑的既有行为」不变 ——
 * 报警列表 / 消息页 / 首页轮播三处一个字节都不用改。
 */
const props = withDefaults(
  defineProps<{
    id: string
    /** 外部已算好的「正在下载」；不传就回落 `useAlarmStore()` */
    busy?: boolean
    /** 外部已算好的下载进度 0~100；不传就回落 `useAlarmStore()` */
    pct?: number
  }>(),
  /*
   * `busy: undefined` 不是多余的 —— 它是「没传」与「传了 false」的分界线。
   *
   * Vue 对 Boolean prop 有一条缺省转换（runtime-core `resolvePropValue`）：
   * `if (isAbsent && !hasDefault) value = false`。也就是说**不传 `:busy`** 时，
   * 读到的 `props.busy` 是 `false` 而不是 `undefined`，下面的 `??` 永远走不到
   * 报警 store 那一支 —— 消息页「监控预警」、首页轮播两处不传 props，
   * 环就整颗不渲染（2026-11-20 回归：无人机页显式传了两颗，所以只有它还在）。
   *
   * 显式声明 `default: undefined` 之后 `hasDefault` 为真，上面那条转换被跳过，
   * 「没传」保持 `undefined`（`pct` 是 Number，本来就不受这条规则影响）。
   * 别把它删掉，除非同时改掉 `??` 的判据。
   */
  { busy: undefined },
)

const alarm = useAlarmStore()

const busy = computed(() => props.busy ?? alarm.thumbBusyOf(props.id))
const pct = computed(() => props.pct ?? alarm.thumbPctOf(props.id))

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
