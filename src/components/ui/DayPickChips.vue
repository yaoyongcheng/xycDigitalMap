<script setup lang="ts">
import { computed } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import { addDays, dayOffsetOf, formatCamDate, formatMD, sameDay, startOfDay } from '@/utils/date'

/**
 * 「今天 / 昨天 / 选日期」三个日期芯片
 *
 * 对应原 js/app.js:1092-1103 dayPickChips(selected, openAttr)。
 * 三处复用：监控抓拍、航拍照片、巡检历史，差异仅在第三个芯片上的展开属性名：
 *   cam  -> data-cal-open="1"
 *   air  -> data-air-cal-open="1"
 *   insp -> data-insp-cal-open="1"
 *
 * 2026-11-19：航拍照片一度改「站点 + 最新一次采集」把这组芯片取下，
 * 当天又按要求恢复 —— 组件本身没动过，仍是原来那三颗。
 *
 * 2026-11-24：加 `single` 模式，只渲染带日历图标的那一颗（默认值仍是「昨天」）。
 * 无人机预警历史页按现场要求**只留一个日期控件**，不再摆「今天 / 昨天」——
 * 那两天的入口对它没有意义（今日预警本身就是另一个页签）。样式与三芯片
 * 里的第三颗完全同一套（`.cam-day.cam-day-pick.on`），只是永远带选中态、
 * 文案固定是「今天 / 昨天 / MM/DD」，这样单颗按钮也能看出选的是哪天。
 */
const props = defineProps<{
  selected: Date
  /** 第三个芯片上的展开属性名，如 'data-cal-open' */
  openAttrName: string
  /** 只留「选日期」那一颗（无人机预警历史页） */
  single?: boolean
}>()

const emit = defineEmits<{
  /** day: 0=今天, 1=昨天 */
  pick: [day: number]
  open: []
}>()

const today = computed(() => startOfDay(new Date()))
const yesterday = computed(() => addDays(today.value, -1))

/** 原 dayOffsetOf(selected) > 1 */
const picked = computed(() => dayOffsetOf(props.selected) > 1)

const isToday = computed(() => sameDay(props.selected, today.value))
const isYesterday = computed(() => sameDay(props.selected, yesterday.value))

/**
 * 第三个芯片的内容：文案 + 日历图标。
 * 改造前是模板字符串拼 HTML 再 v-html 注入，现在文案直出、图标由
 * SvgIcon 渲染（原版就是「文本节点 + svg」两个子节点，结构不变）。
 */
/** 动态属性名绑定，复刻原版拼在字符串里的 openAttr */
const openAttrs = computed(() => ({ [props.openAttrName]: '1' }))

/** 单芯片模式的文案：永远显示当前选中的是哪一天（今天 / 昨天 / MM/DD） */
const singleLabel = computed(() => formatCamDate(props.selected))
</script>

<template>
  <template v-if="!single">
    <button class="cam-day" :class="{ on: isToday }" type="button" data-day="0" @click="emit('pick', 0)">今天</button>
    <button class="cam-day" :class="{ on: isYesterday }" type="button" data-day="1" @click="emit('pick', 1)">昨天</button>
  </template>
  <button
    class="cam-day cam-day-pick"
    :class="{ on: single ? true : picked }"
    type="button"
    v-bind="openAttrs"
    @click="emit('open')"
  >
    {{ single ? singleLabel : picked ? formatMD(props.selected) : '选日期' }}
    <SvgIcon name="cal" />
  </button>
</template>
