<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import {
  isCurrentPeriod,
  monthOptions,
  periodText,
  presetLabel,
  weekOptions,
  type ReportSpan,
} from '@/utils/craneReport'
import { calMinMonth, monthStart, sameDay, startOfDay } from '@/utils/date'

/**
 * 作业报表的「周期选择」—— 对齐标准版报表页的那两颗芯片：
 *
 *   [本周]  [11/10–11/16 ▾]
 *     ↑ 回到今天/本周/本月        ↑ 展开日历，选别的周（或月 / 日）
 *
 * ## 为什么自绘日历，不复用 `MonthCalendar`
 *
 * `MonthCalendar` 是浅色弹层（`.cam-cal` 白底 + 阴影），挂在深色子页里
 * 要覆盖十几条规则；而报表需要的又不是「选一天」—— 周报要按周铺格子、
 * 月报要按年铺 12 格、日报才按月铺天。三套逻辑分三处写、样式再各覆盖一遍，
 * 不如一套深色外壳（`.report-cal`）+ 三种内容，视觉与间距天然一致。
 *
 * ## 口径
 *
 * 选中的永远是**周期的锚点日**（不是区间）：周报锚点是那周的周一、月报
 * 锚点是 1 号、日报锚点就是当天。区间一律由 `reportRange(span, anchor)`
 * 现算，切粒度不用重算边界。
 */
const props = defineProps<{
  span: ReportSpan
  anchor: Date
}>()

const emit = defineEmits<{ pick: [d: Date] }>()

/** 日历是否展开 */
const open = ref(false)

/** 日历当前翻到的月（日报/周报按月翻，月报翻年） */
const shown = ref<Date>(monthStart(props.anchor))

/** 换周期（含外部切粒度）时把日历翻到新区间，收起时也同步，下次展开就在当前周期 */
watch(
  () => props.anchor,
  (d) => {
    shown.value = monthStart(d)
  },
)

const preset = computed(() => presetLabel(props.span))
/** 预设态看的是「锚点落在今天所在周期」，不是锚点等于今天：选本周的任一周一都算本周 */
const isPreset = computed(() => isCurrentPeriod(props.span, props.anchor))
const chipText = computed(() => periodText(props.span, props.anchor))

/** 日历头部：日报/周报是「2026年11月」，月报是「2026年」 */
const headText = computed(() => {
  const y = shown.value.getFullYear()
  return props.span === 'month' ? `${y}年` : `${y}年${shown.value.getMonth() + 1}月`
})

const tipText = computed(() => {
  if (props.span === 'day') return '选择日期'
  return props.span === 'week' ? '选择周' : '选择月份'
})

interface DayCell {
  day: number | null
  date: Date | null
  on: boolean
  today: boolean
  disabled: boolean
}

/** 日报：按月的 7 列网格（月首补位，未来与 11 个月前不可选） */
const days = computed<DayCell[]>(() => {
  const y = shown.value.getFullYear()
  const m = shown.value.getMonth()
  const firstDow = new Date(y, m, 1).getDay()
  const total = new Date(y, m + 1, 0).getDate()
  const min = monthStart(calMinMonth()).getTime()
  const max = startOfDay(new Date()).getTime()
  const out: DayCell[] = []
  for (let i = 0; i < firstDow; i++) out.push({ day: null, date: null, on: false, today: false, disabled: true })
  for (let d = 1; d <= total; d++) {
    const date = startOfDay(new Date(y, m, d))
    const t = date.getTime()
    out.push({
      day: d,
      date,
      on: sameDay(date, props.anchor),
      today: t === max,
      disabled: t > max || t < min,
    })
  }
  return out
})

const weeks = computed(() => weekOptions(shown.value, props.anchor))
const months = computed(() => monthOptions(shown.value.getFullYear(), props.anchor))

const weekHead = ['日', '一', '二', '三', '四', '五', '六']

/** 翻页：日报/周报按月，月报按年。上界是今天所在月/年，下界是 11 个月前 */
const canPrev = computed(() => shown.value.getTime() > monthStart(calMinMonth()).getTime())
const canNext = computed(() => {
  const now = monthStart(new Date())
  if (props.span === 'month') return shown.value.getFullYear() < now.getFullYear()
  return shown.value.getTime() < now.getTime()
})

function shift(n: number): void {
  if (n < 0 && !canPrev.value) return
  if (n > 0 && !canNext.value) return
  const d = monthStart(shown.value)
  if (props.span === 'month') d.setFullYear(d.getFullYear() + n)
  else d.setMonth(d.getMonth() + n)
  shown.value = d
}

function toggle(): void {
  open.value = !open.value
  if (open.value) shown.value = monthStart(props.anchor)
}

function pickPreset(): void {
  open.value = false
  emit('pick', startOfDay(new Date()))
}

function pickDay(c: DayCell): void {
  if (!c.date || c.disabled) return
  open.value = false
  emit('pick', c.date)
}

function pickWeek(d: Date): void {
  open.value = false
  emit('pick', d)
}

function pickMonth(d: Date): void {
  open.value = false
  emit('pick', d)
}
</script>

<template>
  <div class="report-pick">
    <button class="report-chip" :class="{ on: isPreset }" type="button" @click="pickPreset">{{ preset }}</button>
    <button
      class="report-chip report-chip-pick"
      :class="{ on: !isPreset || open }"
      type="button"
      :aria-expanded="open"
      @click="toggle"
    >
      {{ chipText }}
      <SvgIcon name="cal" />
    </button>

    <div v-if="open" class="report-cal" @click.stop>
      <div class="report-cal-hd">
        <button class="report-cal-nav" type="button" aria-label="上一页" :disabled="!canPrev" @click="shift(-1)">‹</button>
        <strong>{{ headText }}</strong>
        <button class="report-cal-nav" type="button" aria-label="下一页" :disabled="!canNext" @click="shift(1)">›</button>
      </div>
      <p class="report-cal-tip">{{ tipText }}</p>

      <!-- 日报：7 列日期 -->
      <template v-if="span === 'day'">
        <div class="report-cal-week">
          <span v-for="w in weekHead" :key="w">{{ w }}</span>
        </div>
        <div class="report-cal-days">
          <template v-for="(c, i) in days" :key="i">
            <span v-if="c.day === null" class="report-cal-day is-off"></span>
            <button
              v-else
              class="report-cal-day"
              :class="{ on: c.on, today: c.today, 'is-off': c.disabled }"
              type="button"
              :aria-disabled="c.disabled ? 'true' : undefined"
              @click="pickDay(c)"
            >
              {{ c.day }}
            </button>
          </template>
        </div>
      </template>

      <!-- 周报：该月所有自然周 -->
      <div v-else-if="span === 'week'" class="report-weeks">
        <button
          v-for="w in weeks"
          :key="w.text"
          class="report-week"
          :class="{ on: w.on }"
          type="button"
          :disabled="w.disabled"
          @click="pickWeek(w.anchor)"
        >
          {{ w.text }}
        </button>
      </div>

      <!-- 月报：12 个月 -->
      <div v-else class="report-months">
        <button
          v-for="m in months"
          :key="m.text"
          class="report-month"
          :class="{ on: m.on }"
          type="button"
          :disabled="m.disabled"
          @click="pickMonth(m.anchor)"
        >
          {{ m.text }}
        </button>
      </div>
    </div>
  </div>
</template>
