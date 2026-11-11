<script setup lang="ts">
import { computed, onMounted } from 'vue'

import InspectItem from '@/components/ui/InspectItem.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendLive } from '@/utils/chart'
import { formatCamDate, formatMD, inspCalMaxDay, sameDay, startOfDay } from '@/utils/date'

/**
 * 报警预警历史（2026-11 设计稿 gx2 版，原 app.js:2913-2965 renderAlarmHist）
 *
 * 今日 / 历史两页签：
 *   - 今日预警：今日预警数 + 近 7 日趋势 + 今日列表；
 *   - 历史预警：日期选择器（默认「昨天」）+ 可展开月历 + 所选日期的列表。
 *
 * 2026-11 数据收口：历史记录只来自接口（`/api/video/alarms` 分页），
 * 不再按「已知分布 + 模板池轮转」编造每天的数据。已加载约一个月，翻到更早
 * 的日期时 `ensureDate` 会按需回补；确实没有记录的日子显示「该日暂无预警记录」。
 */
const alarm = useAlarmStore()
const auth = useAuthStore()
const subpage = useSubpageStore()

/**
 * 登录守卫（2026-11，支付宝式）：报警历史同样要求 Bearer。
 * 未登录进页面 → 直接去登录，登录成功后回到历史页。
 */
onMounted(() => {
  if (!auth.isLoggedIn) subpage.openLogin('登录后可查看报警预警历史', { kind: 'alarm-hist' })
})

const onHist = computed(() => alarm.histTab === 'hist')

const histList = computed(() => alarm.dayRecords(alarm.histDate))
const todayList = computed(() => alarm.latest)

const isYesterday = computed(() => sameDay(alarm.histDate, inspCalMaxDay()))
const pickLabel = computed(() => (isYesterday.value ? '昨天' : formatMD(alarm.histDate)))

/** 近 7 日趋势与首页/巡检列表同款（fillId 错开，见 InspectList 同名注释） */
const trendModel = computed(() => alarmTrendLive(alarm.trend, 'alarmHistFill'))
const hasTrend = computed(() => alarm.trend.some((p) => p.value > 0))

/** 今日空态文案：未登录 / 同步中 / 失败 / 今日无报警 */
const emptyText = computed(() => {
  if (!auth.isLoggedIn) return '登录后查看现场实时报警'
  if (alarm.liveState === 'loading') return '正在同步现场报警…'
  if (alarm.liveState === 'error') return alarm.liveError || '报警同步失败'
  return '今日暂无预警记录'
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
  // 早于已加载范围时按需回补真实历史
  void alarm.ensureDate(auth.token, d)
}

function onItemOpen(id: string): void {
  subpage.openAlarmDetail(id, { kind: 'alarm-hist' })
}

function goLogin(): void {
  subpage.openLogin('登录后查看现场实时报警', { kind: 'alarm-hist' })
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
          <TouchChart v-if="hasTrend" :model="trendModel" />
          <div v-else class="chart-empty">近 7 日暂无报警</div>
        </div>
      </div>
      <div v-if="todayList.length" class="insp-list">
        <InspectItem v-for="a in todayList" :key="a.id" :alarm="a" use-title @open="onItemOpen(a.id)" />
      </div>
      <div v-else class="insp-empty">
        <span>{{ emptyText }}</span>
        <button v-if="!auth.isLoggedIn" class="data-empty-btn" type="button" @click="goLogin">去登录</button>
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
