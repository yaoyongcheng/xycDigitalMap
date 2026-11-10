<script setup lang="ts">
import { computed } from 'vue'

import InspectItem from '@/components/ui/InspectItem.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendModel } from '@/utils/chart'
import { formatCamDate, formatMD, inspCalMaxDay, sameDay, startOfDay } from '@/utils/date'

/**
 * 报警预警历史（2026-11 设计稿 gx2 版，原 app.js:2913-2965 renderAlarmHist）
 *
 * 今日 / 历史两页签：
 *   - 今日预警：今日预警数 + 近 7 日趋势 + 今日列表；
 *   - 历史预警：日期选择器（默认「昨天」）+ 可展开月历 + 所选日期的列表。
 *
 * 历史数据不是种子那几条，而是 alarm.dayRecords(d) 按日生成
 * （已知分布 + 模板池补齐，见 store 注释），空日显示「该日暂无预警记录」。
 *
 * 注意：设计稿里另有一个 renderAlarmHistDay（「X月X日预警」按日 drill-in 页）
 * 与 alarmHistRow（按日行），但它们的入口（data-hist-day 委托）依赖从未渲染的
 * 死代码，整条链不可达 —— 这里不实现，历史页就是「选日期 → 看当天列表」。
 */
const alarm = useAlarmStore()
const subpage = useSubpageStore()

const onHist = computed(() => alarm.histTab === 'hist')

const histList = computed(() => alarm.dayRecords(alarm.histDate))
const todayList = computed(() => alarm.latest)

const isYesterday = computed(() => sameDay(alarm.histDate, inspCalMaxDay()))
const pickLabel = computed(() => (isYesterday.value ? '昨天' : formatMD(alarm.histDate)))

/** 近 7 日趋势与首页/巡检列表同款（fillId 错开，见 InspectList 同名注释） */
const trendModel = computed(() => alarmTrendModel(alarm.latest.length, 'alarmHistFill'))

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

function onItemOpen(id: string): void {
  subpage.openAlarmDetail(id, { kind: 'alarm-hist' })
}
</script>

<template>
  <div class="insp-page alarm-hist-page">
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
        <InspectItem v-for="a in todayList" :key="a.id" :alarm="a" use-title @open="onItemOpen(a.id)" />
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

      <div v-if="histList.length" class="insp-list">
        <InspectItem v-for="a in histList" :key="a.id" :alarm="a" use-title @open="onItemOpen(a.id)" />
      </div>
      <div v-else class="insp-empty">该日暂无预警记录</div>
    </div>
  </div>
</template>
