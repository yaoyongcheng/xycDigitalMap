<script setup lang="ts">
import { computed } from 'vue'

import { useShellStore } from '@/stores/shell'
import { calMinMonth, formatMD, monthStart, sameDay, startOfDay } from '@/utils/date'

/**
 * 月份日历
 *
 * 对应原 js/app.js:1105-1128 fillMonthCal()。
 *
 * 该组件是全项目唯一「一份 CSS、三处挂载」的结构（CSS app.css:3373-3464：
 * .cam-cal 只有一份实现，不存在 .air-cal-* / .insp-cal-*）：
 *   - 监控抓拍（#camCal）
 *   - 航拍（#airCal）
 *   - 巡检历史（#inspCal，由 renderInspectList 动态生成）
 * 差异仅靠容器作用域覆盖（app.css:3558、3562-3577）。
 * 因此抽成共享组件属 1:1 范围（渲染 DOM 相同）。
 *
 * 原版三处包装器（renderCamCal 1134 / renderAirCal 1351 / paintInspCal 708）
 * 的行为差异在调用方，本组件只负责渲染与交互。
 */
const props = withDefaults(
  defineProps<{
    /** 当前显示月份 */
    month: Date
    /** 当前选中日 */
    selected: Date
    /** 可选上界，默认今天。巡检历史传 protoToday()-1（原 opts.maxDay） */
    maxDay?: Date
    /**
     * 可选下界，默认不设（只用 calMinMonth 限住月份）。
     * 监控历史抓拍传「今天往前 29 天」—— 本机档案只留 30 天，
     * 更早的日期放开了也必然是空的。
     */
    minDay?: Date
    /** 是否收起（原 .hide 类，注意与 .open 语义相反） */
    hidden?: boolean
  }>(),
  { maxDay: undefined, minDay: undefined, hidden: false },
)

const emit = defineEmits<{
  'update:month': [d: Date]
  select: [d: Date]
}>()

const shell = useShellStore()

const y = computed(() => props.month.getFullYear())
const m = computed(() => props.month.getMonth())

const title = computed(() => `${y.value}年${m.value + 1}月`)

/** 可选下界（毫秒）；没传 minDay 时返回 -Infinity，等同于「只限月份」 */
const minTime = computed(() => (props.minDay ? startOfDay(props.minDay).getTime() : -Infinity))

/** 原 prevBtn.disabled = month <= calMinMonth()；传了 minDay 就以它为界 */
const prevDisabled = computed(() => {
  const floor = props.minDay ? monthStart(props.minDay).getTime() : calMinMonth().getTime()
  return props.month.getTime() <= floor
})

/** 原 nextBtn.disabled = month >= maxMonth（maxMonth 取 maxDay 所在月首日） */
const nextDisabled = computed(() => {
  const maxDay = startOfDay(props.maxDay ?? new Date())
  return props.month.getTime() >= monthStart(maxDay).getTime()
})

interface Cell {
  /** 日号；null 表示月初补位空格 */
  day: number | null
  on: boolean
  today: boolean
  disabled: boolean
  date: Date | null
}

const cells = computed<Cell[]>(() => {
  const yy = y.value
  const mm = m.value
  const maxDay = startOfDay(props.maxDay ?? new Date())
  const firstDow = new Date(yy, mm, 1).getDay()
  const daysInMonth = new Date(yy, mm + 1, 0).getDate()
  const today = startOfDay(new Date())

  const out: Cell[] = []
  // 原版用 <span class="cam-cal-day off"> 补位，此处 day=null 表示补位
  for (let i = 0; i < firstDow; i++) {
    out.push({ day: null, on: false, today: false, disabled: true, date: null })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(yy, mm, d)
    const t = startOfDay(date).getTime()
    out.push({
      day: d,
      on: sameDay(date, props.selected),
      today: sameDay(date, today),
      disabled: t > maxDay.getTime() || t < minTime.value,
      date,
    })
  }
  return out
})

/** 原 data-cal="${y}-${m + 1}-${d}" */
function calKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 选中某日。
 *
 * 2026-10 交互优化：不可选的日期原先是 `:disabled` 的 <button> —— 浏览器
 * 会连点击事件一起吞掉，用户点了完全没反应，也不知道为什么。改为
 * aria-disabled + 样式类，让点击仍然可达，并明确说明原因。
 *
 * 2026-11 补充：越过上/下界时把「哪边越界」说清楚 —— 都笼统说「暂无数据」，
 * 用户不知道边界在哪，只能一个个日期试。
 */
function onSelect(c: Cell): void {
  if (!c.date) return
  if (c.disabled) {
    const t = startOfDay(c.date).getTime()
    const maxDay = startOfDay(props.maxDay ?? new Date()).getTime()
    if (t > maxDay) shell.showToast('这一天的记录还没生成，请选更早的日期', 'info')
    else if (t < minTime.value && props.minDay) {
      shell.showToast(`只能查看 ${formatMD(props.minDay)} 起的记录`, 'info')
    } else shell.showToast('该日期暂无数据，请选更早的日期', 'info')
    return
  }
  emit('select', c.date)
}

function onPrev(): void {
  const d = startOfDay(props.month)
  d.setMonth(d.getMonth() - 1)
  emit('update:month', d)
}

function onNext(): void {
  const d = startOfDay(props.month)
  d.setMonth(d.getMonth() + 1)
  emit('update:month', d)
}
</script>

<template>
  <div class="cam-cal" :class="{ hide: hidden }">
    <div class="cam-cal-hd">
      <button class="cam-cal-nav" type="button" aria-label="上一月" :disabled="prevDisabled" @click="onPrev">‹</button>
      <strong>{{ title }}</strong>
      <button class="cam-cal-nav" type="button" aria-label="下一月" :disabled="nextDisabled" @click="onNext">›</button>
    </div>
    <div class="cam-cal-week">
      <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
    </div>
    <div class="cam-cal-grid">
      <template v-for="(c, i) in cells" :key="i">
        <span v-if="c.day === null" class="cam-cal-day off"></span>
        <button
          v-else
          class="cam-cal-day"
          :class="{ on: c.on, today: c.today, 'is-disabled': c.disabled }"
          type="button"
          :aria-disabled="c.disabled ? 'true' : undefined"
          :data-cal="c.date ? calKey(c.date) : undefined"
          @click="onSelect(c)"
        >
          {{ c.day }}
        </button>
      </template>
    </div>
  </div>
</template>
