<script setup lang="ts">
import { computed, onMounted } from 'vue'

import InspectItem from '@/components/ui/InspectItem.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import Skel from '@/components/ui/Skel.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendLive } from '@/utils/chart'
import { formatCamDate, formatMD, inspCalMaxDay, sameDay, startOfDay } from '@/utils/date'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 巡检预警列表（子页内容）
 *
 * 对应原 js/app.js:730-778 renderInspectList() + subBody 上的事件委托（883-922）。
 *
 * 两个页签：
 *   今日预警  当日预警统计 + 近 7 日趋势图 + 列表
 *   历史预警  日期选择芯片 + 日历 + 当日列表（空态提示）
 *
 * 2026-11 数据收口：今日列表直接用 `alarm.latest`（真实今日报警），
 * 趋势图用 `alarm.trend` 的按日聚合值；两者都没有演示兜底。
 * 早先这里读的是 store 里的演示种子 `alarm.alarms`，接口接通后一直没改回来 ——
 * 表现是「首页已经是真数据，点进巡检列表还是那 4 条假报警」。
 */
const props = defineProps<{
  /** 垫底层（右滑返回时露出的只读副本）不参与登录守卫 */
  decorative?: boolean
}>()

const alarm = useAlarmStore()
const auth = useAuthStore()
const subpage = useSubpageStore()

/**
 * 登录守卫（2026-11，支付宝式）。
 *
 * 报警数据要求 Bearer：未登录进来只会看到「暂无」的空壳，用户会以为现场
 * 真没报警。所以一进这页就把他带到登录页，并在登录后回到本页。
 */
onMounted(() => {
  if (props.decorative) return
  if (!auth.isLoggedIn) subpage.openLogin('登录后查看巡检预警', { kind: 'inspect-list' })
})

const todayList = computed(() => alarm.latest)
const histList = computed(() => alarm.alarmsOnDate(alarm.inspHistDate))

const onHist = computed(() => alarm.inspTab === 'hist')

/** 原最新一日为 protoToday()-1 时显示「昨天」，否则显示 MM/DD */
const isLatestHist = computed(() => sameDay(alarm.inspHistDate, inspCalMaxDay()))
const histLab = computed(() => formatCamDate(alarm.inspHistDate))
const headLabel = computed(() => (isLatestHist.value ? '昨天' : histLab.value))
const pickLabel = computed(() => (isLatestHist.value ? '昨天' : formatMD(alarm.inspHistDate)))

/**
 * 近 7 日趋势：与首页安全面板同款触控层（参考线 / 放大点 / 数值气泡）。
 * fillId 沿用 'inspAlarmFill' —— 子页与首页可能同时在 DOM 里，
 * 渐变 id 必须错开，否则后挂载的会引用到先挂载的渐变定义。
 */
const trendModel = computed(() => alarmTrendLive(alarm.trend, 'inspAlarmFill'))
const hasTrend = computed(() => alarm.trend.some((p) => p.value > 0))

/** 空态文案：未登录 / 接口异常 / 确实没有（同步中走骨架，不在这里出文案） */
const emptyText = computed(() => {
  if (!auth.isLoggedIn) return '登录后查看现场实时报警'
  if (alarm.liveState === 'error') return alarm.liveError || '报警同步失败'
  return '今日暂无巡检预警'
})

/** 首屏还没有任何报警时的同步态（已有一批旧数据时不再显示骨架） */
const syncing = computed(() => !alarm.hasLive && alarm.liveState === 'loading')

/** 慢请求才显示骨架：快请求直接出内容，不闪灰条 */
const showSkel = useSlowLoading(() => syncing.value)

/**
 * 历史窗格的同步态：翻到还没拉过的日期时 `ensureDate` 也走 liveState=loading
 * （按需回补），此时「该日暂无巡检预警 / 0条」是提前下的结论，换成骨架。
 */
const histSyncing = computed(() => alarm.liveState === 'loading')
const showHistSkel = useSlowLoading(() => histSyncing.value)

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
  // 选中的日期早于已加载范围时按需回补（真实历史，最多到 8 页）
  void alarm.ensureDate(auth.token, d)
}

function onItemOpen(id: string): void {
  subpage.openAlarmDetail(id, true)
}

function goLogin(): void {
  subpage.openLogin('登录后查看现场实时报警', { kind: 'inspect-list' })
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
        <div class="home-stat alert">
          <b v-if="!syncing">{{ todayList.length }}</b>
          <!-- 同步中：数字位换成灰条，不回填 0（0 是个结论，这里还不知道） -->
          <Skel v-else w="54px" h="31px" r="var(--r-6)" />
          <span>今日预警数</span>
        </div>
        <div class="home-chart-card alarm-mini">
          <span class="alarm-mini-lab">近7日预警趋势</span>
          <TouchChart v-if="hasTrend" :model="trendModel" />
          <Skel v-else-if="syncing" class="skel-mt" w="100%" h="48px" r="var(--r-6)" />
          <div v-else class="chart-empty">近 7 日暂无报警</div>
        </div>
      </div>
      <div v-if="todayList.length" class="insp-list">
        <InspectItem v-for="a in todayList" :key="a.id" :alarm="a" @open="onItemOpen(a.id)" />
      </div>
      <!-- 同步中：按 .insp-item 的真实结构（48px 图 + 两行文字）铺 4 条灰条 -->
      <div v-else-if="syncing" class="insp-list skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="insp-item is-skel">
          <Skel w="48px" h="48px" r="var(--r-8)" />
          <div class="insp-meta">
            <Skel w="52%" h="14px" />
            <Skel class="skel-mt" w="78%" h="11px" />
          </div>
        </div>
      </div>
      <div v-else class="insp-empty">
        <span>{{ emptyText }}</span>
        <button v-if="!auth.isLoggedIn" class="data-empty-btn" type="button" @click="goLogin">去登录</button>
      </div>
    </div>

    <div class="insp-pane insp-hist" :class="{ hide: !onHist }">
      <div class="insp-hist-hd">
        <div>
          <strong>{{ headLabel }}</strong>
          <span>{{ histSyncing ? '…' : `${histList.length}条` }}</span>
        </div>
        <button class="cam-day cam-day-pick on" type="button" data-insp-cal-open="1" @click="onCalToggle">
          {{ pickLabel }}
          <span><SvgIcon name="cal" /></span>
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
      <!-- 按需回补中：结构同列表项，数据到了原位回填，不提前下「暂无」的结论 -->
      <div v-else-if="histSyncing" class="insp-list skel-fade" :class="{ 'is-on': showHistSkel }" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="insp-item is-skel">
          <Skel w="48px" h="48px" r="var(--r-8)" />
          <div class="insp-meta">
            <Skel w="52%" h="14px" />
            <Skel class="skel-mt" w="78%" h="11px" />
          </div>
        </div>
      </div>
      <div v-else class="insp-empty">该日暂无巡检预警</div>
    </div>
  </div>
</template>
