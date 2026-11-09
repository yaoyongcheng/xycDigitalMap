<script setup lang="ts">
import { computed } from 'vue'

import InspectItem from '@/components/ui/InspectItem.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendModel } from '@/utils/chart'
import { dateKey, formatCamDate, formatMD, inspCalMaxDay, sameDay, startOfDay } from '@/utils/date'

/**
 * 报警预警历史（2026-11 设计稿 gx2 版，原 app.js:2880-2965）
 *
 * 双模式一个组件：
 *   - 列表页（renderAlarmHist）：今日/历史两页签 + 月历 + 按日列表；
 *   - 按日 drill-in（renderAlarmHistDay，传入 day）：X月X日预警汇总头 + 列表。
 *
 * 历史数据不是种子那几条，而是 alarm.dayRecords(d) 按日生成
 * （已知分布 + 模板池补齐，见 store 注释），空日显示「该日暂无预警记录」。
 */
const props = defineProps<{ day?: string }>()

const alarm = useAlarmStore()
const subpage = useSubpageStore()

/** drill-in 模式：day 由 alarm-hist-day 视图下发 */
const dayDate = computed<Date | null>(() => {
  if (!props.day) return null
  const [y, m, d] = props.day.split('-').map(Number)
  return startOfDay(new Date(y, m - 1, d))
})

const onDay = computed(() => dayDate.value !== null)
const onHist = computed(() => !onDay.value && alarm.histTab === 'hist')

const dayList = computed(() => (dayDate.value ? alarm.dayRecords(dayDate.value) : []))
const histList = computed(() => alarm.dayRecords(alarm.histDate))
const todayList = computed(() => alarm.latest)

const isYesterday = computed(() => sameDay(alarm.histDate, inspCalMaxDay()))
const pickLabel = computed(() => (isYesterday.value ? '昨天' : formatMD(alarm.histDate)))

/** 近 7 日趋势与首页/巡检列表同款（fillId 错开，见 InspectList 同名注释） */
const trendModel = computed(() => alarmTrendModel(alarm.latest.length, 'alarmHistFill'))

const weekLabel = (d: Date): string => '日一二三四五六'[d.getDay()]

/** drill-in 头部：M月D日 周X · 昨天 */
const dayHead = computed(() => {
  const d = dayDate.value
  if (!d) return { main: '', sub: '' }
  const yest = sameDay(d, inspCalMaxDay())
  return {
    main: `${d.getMonth() + 1}月${d.getDate()}日`,
    sub: `周${weekLabel(d)}${yest ? ' · 昨天' : ''}`,
  }
})

/** 历史页按日行：M月D日 周X[ · 今天/ · 昨天] + 次数（原 alarmHistRow） */
const histRows = computed(() => {
  const out: { key: string; main: string; sub: string; n: number; open: boolean }[] = []
  const max = inspCalMaxDay()
  for (let off = 1; off <= 6; off++) {
    const t = new Date(max)
    t.setDate(max.getDate() - off + 1)
    const d = startOfDay(t)
    const n = alarm.dayCount(d)
    if (n === null) continue
    out.push({
      key: dateKey(d),
      main: `${d.getMonth() + 1}月${d.getDate()}日`,
      sub: `周${weekLabel(d)}${off === 1 ? ' · 昨天' : ''}`,
      n,
      open: n > 0,
    })
  }
  return out
})

function onTab(tab: 'today' | 'hist'): void {
  subpage.openAlarmHist(tab)
}

function onCalToggle(): void {
  if (alarm.histCalOpen) {
    alarm.histCalOpen = false
    return
  }
  // 原 showAlarmHistCal()（app.js:2872-2879）—— 展开时对齐月份
  alarm.histCalMonth = startOfDay(new Date(alarm.histDate.getFullYear(), alarm.histDate.getMonth(), 1))
  alarm.histCalOpen = true
}

function onCalSelect(d: Date): void {
  alarm.histDate = startOfDay(d)
  alarm.histCalOpen = false
}

function onItemOpen(id: string, from: 'list' | 'day'): void {
  if (from === 'day' && dayDate.value) {
    subpage.openAlarmDetail(id, { kind: 'alarm-hist-day', date: props.day! })
  } else {
    subpage.openAlarmDetail(id, { kind: 'alarm-hist' })
  }
}

function onDayRow(key: string): void {
  const [y, m, d] = key.split('-').map(Number)
  subpage.openAlarmHistDay(startOfDay(new Date(y, m - 1, d)))
}
</script>

<template>
  <!-- 按日 drill-in（原 renderAlarmHistDay） -->
  <div v-if="onDay" class="alarm-hist-page">
    <div class="alarm-hist-sum">
      <span>{{ dayHead.main }}<em>{{ dayHead.sub }}</em></span>
      <b>{{ dayList.length }}<i>条</i></b>
    </div>
    <div v-if="dayList.length" class="insp-list">
      <InspectItem
        v-for="a in dayList"
        :key="a.id"
        :alarm="a"
        use-title
        @open="onItemOpen(a.id, 'day')"
      />
    </div>
    <div v-else class="insp-empty">该日暂无预警记录</div>
  </div>

  <!-- 列表页（原 renderAlarmHist） -->
  <div v-else class="insp-page alarm-hist-page">
    <div class="insp-tabs">
      <button class="insp-tab" :class="{ on: !onHist }" type="button" @click="onTab('today')">今日预警</button>
      <button class="insp-tab" :class="{ on: onHist }" type="button" @click="onTab('hist')">历史预警</button>
    </div>

    <div class="insp-pane" :class="{ hide: onHist }">
      <div class="home-stats alarm-row">
        <div class="home-stat alert"><b>{{ todayList.length }}</b><span>今日预警数</span></div>
        <div class="home-chart-card alarm-mini">
          <span class="alarm-mini-lab">近7日预警趋势</span>
          <TouchChart :model="trendModel" />
        </div>
      </div>
      <div class="insp-list">
        <InspectItem v-for="a in todayList" :key="a.id" :alarm="a" use-title @open="onItemOpen(a.id, 'list')" />
      </div>
    </div>

    <div class="insp-pane insp-hist" :class="{ hide: !onHist }">
      <div class="insp-hist-hd">
        <div>
          <strong>{{ isYesterday ? '昨天' : formatCamDate(alarm.histDate) }}</strong>
          <span>{{ histList.length }}条</span>
        </div>
        <button class="cam-day cam-day-pick on" type="button" @click="onCalToggle">
          {{ pickLabel }}
          <span><SvgIcon name="cal" /></span>
        </button>
      </div>

      <MonthCalendar
        v-model:month="alarm.histCalMonth"
        :selected="alarm.histDate"
        :max-day="inspCalMaxDay()"
        :hidden="!alarm.histCalOpen"
        @select="onCalSelect"
      />

      <!-- 近 6 日按日行（原 alarmHistRow）：0 次不可点 -->
      <div class="alarm-hist-rows">
        <template v-for="row in histRows" :key="row.key">
          <button
            v-if="row.open"
            class="alarm-hist-row"
            type="button"
            :data-hist-day="row.key"
            @click="onDayRow(row.key)"
          >
            <span>{{ row.main }}<em>{{ row.sub }}</em></span>
            <b>{{ row.n }}<i>次</i></b>
            <svg class="alarm-hist-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button>
          <div v-else class="alarm-hist-row">
            <span>{{ row.main }}<em>{{ row.sub }}</em></span>
            <b class="is-zero">{{ row.n }}<i>次</i></b>
          </div>
        </template>
      </div>

      <div v-if="histList.length" class="insp-list">
        <InspectItem v-for="a in histList" :key="a.id" :alarm="a" use-title @open="onItemOpen(a.id, 'list')" />
      </div>
      <div v-else class="insp-empty">该日暂无预警记录</div>
    </div>
  </div>
</template>
