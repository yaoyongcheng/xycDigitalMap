<script setup lang="ts">
import { computed } from 'vue'

import InspectItem from '@/components/ui/InspectItem.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import { calIco } from '@/data/icons'
import { useAlarmStore } from '@/stores/alarm'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendSvg } from '@/utils/chart'
import { formatCamDate, formatMD, inspCalMaxDay, sameDay, startOfDay } from '@/utils/date'

/**
 * 巡检预警列表（子页内容）
 *
 * 对应原 js/app.js:730-778 renderInspectList() + subBody 上的事件委托（883-922）。
 *
 * 两个页签：
 *   今日预警  当日预警统计 + 近 7 日趋势图 + 列表
 *   历史预警  日期选择芯片 + 日历 + 当日列表（空态提示）
 */
const alarm = useAlarmStore()
const subpage = useSubpageStore()

const todayList = computed(() => alarm.alarms.filter((a) => a.day === 'today'))
const histList = computed(() => alarm.alarmsOnDate(alarm.inspHistDate))

const onHist = computed(() => alarm.inspTab === 'hist')

/** 原最新一日为 protoToday()-1 时显示「昨天」，否则显示 MM/DD */
const isLatestHist = computed(() => sameDay(alarm.inspHistDate, inspCalMaxDay()))
const histLab = computed(() => formatCamDate(alarm.inspHistDate))
const headLabel = computed(() => (isLatestHist.value ? '昨天' : histLab.value))
const pickLabel = computed(() => (isLatestHist.value ? '昨天' : formatMD(alarm.inspHistDate)))

const trendSvg = computed(() => alarmTrendSvg('inspAlarmFill', alarm.latest.length))

function onTab(tab: 'today' | 'hist'): void {
  alarm.inspCalOpen = false
  subpage.openInspectList(tab)
}

function onCalToggle(): void {
  if (alarm.inspCalOpen) {
    alarm.inspCalOpen = false
    return
  }
  // 原 showInspCal()（app.js:721-729）—— 展开时对齐月份
  alarm.inspCalMonth = startOfDay(new Date(alarm.inspHistDate.getFullYear(), alarm.inspHistDate.getMonth(), 1))
  alarm.inspCalOpen = true
}

function onCalSelect(d: Date): void {
  alarm.inspHistDate = startOfDay(d)
  subpage.openInspectList('hist')
}

function onItemOpen(id: string): void {
  subpage.openAlarmDetail(id, true)
}
</script>

<template>
  <div class="insp-page">
    <div class="insp-tabs">
      <button
        class="insp-tab"
        :class="{ on: !onHist }"
        type="button"
        data-insp-tab="today"
        @click="onTab('today')"
      >
        今日预警
      </button>
      <button
        class="insp-tab"
        :class="{ on: onHist }"
        type="button"
        data-insp-tab="hist"
        @click="onTab('hist')"
      >
        历史预警
      </button>
    </div>

    <div class="insp-pane" :class="{ hide: onHist }">
      <div class="home-stats alarm-row">
        <div class="home-stat alert"><b>{{ todayList.length }}</b><span>今日预警数</span></div>
        <div class="home-chart-card alarm-mini">
          <span class="alarm-mini-lab">近7日预警趋势</span>
          <span v-html="trendSvg"></span>
        </div>
      </div>
      <div class="insp-list">
        <InspectItem v-for="a in todayList" :key="a.id" :alarm="a" @open="onItemOpen(a.id)" />
      </div>
    </div>

    <div class="insp-pane insp-hist" :class="{ hide: !onHist }">
      <div class="insp-hist-hd">
        <div>
          <strong>{{ headLabel }}</strong>
          <span>{{ histList.length }}条</span>
        </div>
        <button class="cam-day cam-day-pick on" type="button" data-insp-cal-open="1" @click="onCalToggle">
          {{ pickLabel }}
          <span v-html="calIco"></span>
        </button>
      </div>

      <MonthCalendar
        v-model:month="alarm.inspCalMonth"
        :selected="alarm.inspHistDate"
        :max-day="inspCalMaxDay()"
        :hidden="!alarm.inspCalOpen"
        @select="onCalSelect"
      />

      <div v-if="histList.length" class="insp-list">
        <InspectItem v-for="a in histList" :key="a.id" :alarm="a" @open="onItemOpen(a.id)" />
      </div>
      <div v-else class="insp-empty">该日暂无巡检预警</div>
    </div>
  </div>
</template>
