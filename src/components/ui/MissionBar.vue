<script setup lang="ts">
import { computed } from 'vue'

import { missionLine, type MissionProgress } from '@/utils/uavProgress'

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
 * ## 「起飞 · 已飞 · 预计」这一行（2026-11-24 现场要求）
 *
 * 原先首页只把它塞进 `title`（手机上没有悬停，等于看不到），现场要求与无人机页
 * **显示同一行、且两边永远一致**。所以：
 * · 文案由 `missionLine()` 统一出字（与无人机页调的是同一个函数，不是抄一份）；
 * · 这里可见地排在进度条下方一行 —— 卡片本来就留着这段空白（进度条与下内边距之间）；
 * · `title` 仍然留着，补上任务名，长按 / 悬停能看到完整一句。
 *
 * 于是首页与无人机页的三处信息同源：条的长度（`pct`）、这一行文字（`missionLine`）、
 * 时间推进（`utils/missionClock.ts` 的共享时钟）—— 没有任何一处各算各的。
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

/** 与无人机页逐字一致的那一行（同一个函数出字，见上） */
const note = computed(() => missionLine(props.time, props.progress))

/** 悬停 / 长按补上任务名（任务名在卡片上可能已被省略号截断） */
const tip = computed(() => `当前巡检 · ${props.name} · ${note.value}`)
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
    <!--
      起飞时刻 / 已飞 / 预计 —— 与无人机页 `.uav-mission p` 同一句（`missionLine()`）。
      放在条下面单独一行：卡片这一段本来就是空的，不需要再往上挤空间。
    -->
    <span class="mission-note">{{ note }}</span>
  </span>
</template>
