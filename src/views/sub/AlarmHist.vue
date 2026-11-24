<script setup lang="ts">
import { computed, onMounted } from 'vue'

import AlarmRow from '@/components/ui/AlarmRow.vue'
import DayPickChips from '@/components/ui/DayPickChips.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import Skel from '@/components/ui/Skel.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useSubpageStore } from '@/stores/subpage'
import { mergeAlarmEntries, mergeTrend, worksOn, type AlarmEntry } from '@/utils/alarmMerge'
import { alarmTrendLive } from '@/utils/chart'
import { dateKey, formatCamDate, inspCalMaxDay, startOfDay } from '@/utils/date'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 报警预警历史（2026-11 设计稿 gx2 版，原 app.js:2913-2965 renderAlarmHist）
 *
 * 今日 / 历史两页签：
 *   - 今日预警：今日预警数 + 近 7 日趋势 + 今日列表；
 *   - 历史预警：日期选择器（默认「昨天」）+ 可展开月历 + 所选日期的列表。
 *
 * ## 数据来源（2026-11-23 现场要求：两类预警合并）
 *
 * 这一页原来只查 `:8085` 的**监控预警**；现在与消息页的两个入口对齐，
 * 同一份列表里既有监控预警（`stores/alarm.ts`）也有无人机预警
 * （`stores/droneAlarm.ts`，keehang 审核中心的 AI 工单），**按时间倒序合并**，
 * 一条预警只出现一次（去重口径见 `utils/alarmMerge.ts`）。
 *
 * 页签、日期选择、月历、滚动位置全部保持原样 —— 变的只是「每行从哪来」：
 * 每行由 `components/ui/AlarmRow.vue` 按来源分派到原有的行组件，
 * 两边的字段映射一个字都没改（监控看报警名 + 点位，无人机看识别类别 + 任务名）。
 *
 * 计数与趋势同样按合并口径算：卡片上的「今日预警数」= 今日列表行数，
 * 折线 = 两份按日相加，所以不会出现「写 35 条、列表却有 41 行」。
 *
 * ## 两路各自的「还没有结论」
 *
 * 两套接口互不相关，任何一路还在首屏同步时都**不能**先说「暂无」：
 * `alarmReady` / `droneReady` 都为真（或已失败）才下结论，否则铺骨架。
 *
 * ## 无人机历史的覆盖范围
 *
 * 审核中心没有时间筛选（见 `stores/droneAlarm.ts`），只能从新往旧翻页。
 * 选到比已加载范围更早的日期时，`ensureDay` 会按需回补几页；仍然不够就在
 * 列表下面写清「只加载到 X 日」并给一个「继续加载」，不假装那天没有预警。
 */
const alarm = useAlarmStore()
const drone = useDroneAlarmStore()
const auth = useAuthStore()
const subpage = useSubpageStore()

const props = defineProps<{
  /**
   * 垫底层（右滑返回时露出的只读副本）。
   *
   * 不带这个开关会有两个后果：① 未登录时的登录守卫会在这里再弹一次登录页
   * （垫底层是被动渲染的，不该有自己的导航行为）；② 双份实例各自跑挂载副作用。
   */
  decorative?: boolean
}>()

/**
 * 登录守卫（2026-11，支付宝式）：报警历史同样要求 Bearer。
 * 未登录进页面 → 直接去登录，登录成功后回到历史页。
 */
onMounted(() => {
  if (props.decorative) return
  if (!auth.isLoggedIn) {
    subpage.openLogin('登录后可查看报警预警历史', { kind: 'alarm-hist' })
    return
  }
  // 监控侧一般已由首页同步过；万一没有（登录后直接回到本页）补一次
  if (!alarm.hasLive && alarm.liveState !== 'loading') void alarm.syncFromVideo(auth.token)
  // 无人机侧是另一套后端，本页现在要展示它，必须自己拉一次（store 自带 2 分钟去重）
  void drone.load()
})

const onHist = computed(() => alarm.histTab === 'hist')

/** 监控侧是否已有结论：有数据 / 成功（可能是 0 条）/ 失败都算，只有同步中不算 */
const alarmReady = computed(
  () => alarm.hasLive || alarm.liveState === 'ok' || alarm.liveState === 'error',
)

/** 无人机侧是否已有结论：首屏扫完或已经失败；还在扫时列表为空不等于「没有」 */
const droneReady = computed(() => drone.scanned || drone.state === 'error')

/** 今日列表：监控今日预警 + 无人机今日工单，按时间倒序合并去重 */
const todayList = computed(() => mergeAlarmEntries(alarm.latest, drone.todayItems))

/** 历史列表：所选日期的监控预警 + 同一天的无人机工单 */
const histList = computed(() =>
  mergeAlarmEntries(alarm.dayRecords(alarm.histDate), worksOn(drone.items, alarm.histDate)),
)

/**
 * 历史页的日期控件（2026-11-24 改造）。
 *
 * 与监控预警、无人机预警两个历史页统一成 `ui/DayPickChips` 的**单芯片模式**：
 * 一颗「当天 + 日历图标」按钮（选中态蓝底白字）+ `MonthCalendar`，不再摆
 * 「今天 / 昨天」—— 这一页的语义就是「按某一天看两类预警」，那两个入口多余。
 *
 * 默认值仍是**昨天**（`alarm.histDate` 的初值，见 stores/alarm.ts），
 * 选日期后的回补与筛选口径与改造前完全一致，改的只是控件外观与结构。
 */
const headLabel = computed(() => formatCamDate(alarm.histDate))

/** 近 7 日趋势：两份按日相加（同一 7 天、同一标签），fillId 错开同 InspectList */
const trend = computed(() => mergeTrend(alarm.trend, drone.weekTrend))
const trendModel = computed(() => alarmTrendLive(trend.value, 'alarmHistFill'))
const hasTrend = computed(() => trend.value.some((p) => p.value > 0))

/** 今日空态文案：未登录 / 某一路失败 / 今日确实没有（同步中走骨架） */
const todayEmptyText = computed(() => {
  if (!auth.isLoggedIn) return '登录后查看现场实时报警'
  if (alarm.liveState === 'error' && drone.state === 'error') return '预警同步失败，请稍后重试'
  if (alarm.liveState === 'error') return alarm.liveError || '监控预警同步失败'
  if (drone.state === 'error') return drone.error || '无人机预警加载失败'
  return '今日暂无预警记录'
})

/**
 * 两路里有一路没拿到数据时，列表照样展示另一路，但要在下面写清「不完整」。
 *
 * 不写的话，用户会以为「今天只有这几条」—— 这比空着更误导。
 */
const sourceNote = computed(() => {
  const bad: string[] = []
  if (alarm.liveState === 'error') bad.push('监控预警同步失败')
  if (drone.state === 'error') bad.push('无人机预警加载失败')
  return bad.length ? `${bad.join('；')}，列表可能不完整` : ''
})

/**
 * 首屏同步中（两路都还没结论、且一行都没有）。
 *
 * 未登录时两路都是 `idle`：那是「没资格看」而不是「正在加载」，
 * 必须走空态文案 + 去登录，不能一直铺灰条。
 */
const syncing = computed(() => {
  if (!auth.isLoggedIn) return false
  return !todayList.value.length && (!alarmReady.value || !droneReady.value)
})

/** 慢请求才显示骨架 */
const showSkel = useSlowLoading(() => syncing.value)

/**
 * 历史窗格的同步态。
 *
 * 与今日窗格不同：翻到还没拉过的日期时 `ensureDate` 也会把 liveState 置成
 * loading（按需回补）——此时「该日暂无预警记录 / 0条」就是提前下的结论，
 * 也要换成骨架。无人机那一侧同理：首屏还没扫完时，那天有多少条还不知道。
 */
const histSyncing = computed(() => {
  if (!auth.isLoggedIn) return false
  return alarm.liveState === 'loading' || !droneReady.value
})
const showHistSkel = useSlowLoading(() => histSyncing.value)

/** 无人机历史只加载到某天、而选的日期更早 —— 说清楚并给个继续加载的入口 */
const histGap = computed(() => {
  const earliest = drone.earliestDay
  if (!earliest || !drone.hasMore) return false
  return dateKey(alarm.histDate) < earliest
})

/** '2026-11-17' → '11/17' */
function dayLabel(key: string): string {
  const [, m, d] = key.split('-')
  return `${Number(m)}/${Number(d)}`
}

function onTab(tab: 'today' | 'hist'): void {
  subpage.openAlarmHist(tab)
  // 落到历史页签时，若所选日期超出无人机已加载范围就顺手回补几页
  if (tab === 'hist') void drone.ensureDay(alarm.histDate)
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
  // 早于已加载范围时按需回补真实历史（监控最多 8 页 × 200，无人机每次 3 页 × 20）
  void alarm.ensureDate(auth.token, d)
  void drone.ensureDay(d)
}

/**
 * 点开一行：按来源进各自的详情页，**返回目标都是本页**。
 *
 * 无人机详情默认返回「无人机预警」列表（`openWorkOrderDetail` 的缺省），
 * 从这条合并时间线点进去时必须显式指回 `alarm-hist`。
 */
function onRowOpen(e: AlarmEntry): void {
  if (e.alarm) {
    subpage.openAlarmDetail(e.alarm.id, { kind: 'alarm-hist' })
    return
  }
  if (e.work) subpage.openWorkOrderDetail(e.work.id, { kind: 'alarm-hist' })
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
        <div class="home-stat alert">
          <b v-if="!syncing">{{ todayList.length }}</b>
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
        <AlarmRow
          v-for="e in todayList"
          :key="e.key"
          :entry="e"
          :decorative="decorative"
          @open="onRowOpen(e)"
        />
      </div>
      <!-- 同步中：结构同 .insp-item（48px 图 + 两行文字），报警到手后原位回填 -->
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
        <span>{{ todayEmptyText }}</span>
        <button v-if="!auth.isLoggedIn" class="data-empty-btn" type="button" @click="goLogin">去登录</button>
      </div>
      <!-- 有一路没取到：列表照常显示另一路，但要说清不完整 -->
      <p v-if="sourceNote && todayList.length" class="insp-note">{{ sourceNote }}</p>
    </div>

    <div class="insp-pane insp-hist" :class="{ hide: !onHist }">
      <div class="insp-hist-hd">
        <div>
          <strong>{{ headLabel }}</strong>
          <span>{{ histSyncing ? '…' : `${histList.length}条` }}</span>
        </div>
        <!-- 日期控件：与监控预警、无人机预警两个历史页同一个组件（单芯片） -->
        <DayPickChips
          single
          :selected="alarm.histDate"
          open-attr-name="data-alarm-cal-open"
          @open="onCalToggle"
        />
      </div>

      <MonthCalendar
        v-model:month="alarm.histCalMonth"
        :selected="alarm.histDate"
        :max-day="inspCalMaxDay()"
        :hidden="!alarm.histCalOpen"
        @select="onCalSelect"
      />

      <div v-if="histList.length" class="insp-list">
        <AlarmRow
          v-for="e in histList"
          :key="e.key"
          :entry="e"
          :decorative="decorative"
          @open="onRowOpen(e)"
        />
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
      <div v-else class="insp-empty">该日暂无预警记录</div>

      <p v-if="sourceNote && histList.length" class="insp-note">{{ sourceNote }}</p>

      <!-- 无人机这一侧的覆盖范围：审核中心没有时间筛选，只能从新往旧翻页 -->
      <p v-if="histGap" class="insp-note">
        无人机预警仅加载到 {{ dayLabel(drone.earliestDay) }}，更早的还没取
        <button
          class="insp-note-btn"
          type="button"
          :disabled="drone.loadingMore"
          @click="drone.ensureDay(alarm.histDate)"
        >
          {{ drone.loadingMore ? '加载中…' : '继续加载' }}
        </button>
      </p>
    </div>
  </div>
</template>
