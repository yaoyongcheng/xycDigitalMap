<script setup lang="ts">
import { computed } from 'vue'

import { calIco } from '@/data/icons'
import { addDays, dayOffsetOf, formatMD, sameDay, startOfDay } from '@/utils/date'

/**
 * 「今天 / 昨天 / 选日期」三个日期芯片
 *
 * 对应原 js/app.js:1092-1103 dayPickChips(selected, openAttr)。
 * 三处复用：监控抓拍、航拍、巡检历史，差异仅在第三个芯片上的展开属性名：
 *   cam  -> data-cal-open="1"
 *   air  -> data-air-cal-open="1"
 *   insp -> data-insp-cal-open="1"
 */
const props = defineProps<{
  selected: Date
  /** 第三个芯片上的展开属性名，如 'data-cal-open' */
  openAttrName: string
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
 * 第三个芯片的内部内容。原版是模板字符串直接拼进去的
 * （app.js:1099-1102），这里用 v-html 复刻，避免多包一层 span 破坏 DOM 结构。
 */
const pickInner = computed(
  () => `\n        ${picked.value ? formatMD(props.selected) : '选日期'}\n        ${calIco}\n      `,
)

/** 动态属性名绑定，复刻原版拼在字符串里的 openAttr */
const openAttrs = computed(() => ({ [props.openAttrName]: '1' }))
</script>

<template>
  <button class="cam-day" :class="{ on: isToday }" type="button" data-day="0" @click="emit('pick', 0)">今天</button>
  <button class="cam-day" :class="{ on: isYesterday }" type="button" data-day="1" @click="emit('pick', 1)">昨天</button>
  <button
    class="cam-day cam-day-pick"
    :class="{ on: picked }"
    type="button"
    v-bind="openAttrs"
    v-html="pickInner"
    @click="emit('open')"
  ></button>
</template>
