<script setup lang="ts">
import { computed } from 'vue'

import type { MissionProgress } from '@/utils/uavProgress'

/**
 * 「当前巡检」进度条 —— 与无人机页 `.uav-mission` 同一套实现，只是压成一行。
 *
 * ## 为什么不是新写的进度条
 *
 * 无人机页那条进度条（`views/sub/UavPage.vue` 的 `.uav-mission`）由三部分组成：
 * `.uav-bar` 的样式 + `missionProgress()` 的算法 + `uav.running / runningEstimate`
 * 的数据。这里**一条都没有重写**：
 * · 条仍然是 `.uav-bar` / `.uav-bar i`（同一个 class，同一套高度 / 圆角 / 蓝色 / 缓动）；
 * · 百分比仍然由调用方用 `missionProgress()` 算好传进来；
 * · 数据仍然是 store 里同一个 `running` / `runningEstimate`。
 *
 * 唯一的差别是**版面**：首页卡片只腾得出两行位置（数值行下方、卡片底部内边距
 * 之上），所以这里把「当前巡检 · 任务名 + 百分比」压成一行、进度条单独一行；
 * 无人机页那句「17:00 起飞 · 已飞 x 分钟 · 预计 y 分钟」放不下，改走 `title`
 * 与卡片的 aria-label（读屏仍然能看到）。
 *
 * ## 什么时候渲染
 *
 * 由调用方 `v-if` 控制：没有执行中的任务、或算不出百分比（该任务一次都没完整
 * 跑过 → 没有分母）时**整条不渲染**。这与无人机页一致 —— 不拿 0% 或排班间隔
 * 凑一个看起来在动的条。
 */
const props = defineProps<{
  /** 任务名（航线名） */
  name: string
  /** 起飞时刻 HH:mm */
  time: string
  /** `missionProgress()` 的结果；`pct` 为 null 时调用方不该渲染本组件 */
  progress: MissionProgress
}>()

const pct = computed(() => props.progress.pct ?? 0)

/** 悬停 / 长按给完整说明：卡片上只有一行，不能把四个字段全铺开 */
const tip = computed(() => {
  const parts = [`当前巡检 · ${props.name}`, `${props.time} 起飞`]
  if (props.progress.elapsedMin !== null) parts.push(`已飞 ${props.progress.elapsedMin.toFixed(1)} 分钟`)
  if (props.progress.estimateMin !== null) parts.push(`预计 ${props.progress.estimateMin} 分钟`)
  return parts.join(' · ')
})
</script>

<template>
  <!-- 根节点必须是 span：卡片是 <button>，里面只能放 phrasing content -->
  <span class="mission-bar" :title="tip">
    <!--
      「当前巡检 · 任务名」与无人机页同一句、同一个位置（条的上方）；
      任务名过长时省略号收尾 —— 卡片宽度是固定的，撑破会顶到右侧箭头。
    -->
    <span class="mission-hd">
      <strong>当前巡检 · {{ name }}</strong>
      <em class="mission-pct">{{ pct }}%</em>
    </span>
    <span
      class="uav-bar"
      role="progressbar"
      :aria-valuenow="pct"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="`当前巡检进度 ${pct}%`"
    ><i :style="{ width: `${pct}%` }"></i></span>
  </span>
</template>
