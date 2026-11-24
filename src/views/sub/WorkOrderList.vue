<script setup lang="ts">
import { computed, onMounted } from 'vue'

import DayPickChips from '@/components/ui/DayPickChips.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import Skel from '@/components/ui/Skel.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import WorkOrderItem from '@/components/ui/WorkOrderItem.vue'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendLive } from '@/utils/chart'
import { dateKey, formatCamDate, inspCalMaxDay, startOfDay } from '@/utils/date'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 无人机预警列表（子页内容）
 *
 * 数据源是 keehang 审核中心的 AI 工单（= V2 大屏「工单列表」），字段与口径见
 * `api/drone.ts::fetchAuditWorkOrders` 与 `stores/droneAlarm.ts`。
 *
 * ## 版式与「监控预警」子页逐项对齐（2026-11-20 二次对齐）
 *
 * 两个子页是同一层级的入口，观感必须一致，所以这里**不另起一套版式**：
 *   · 页签 —— `.insp-tabs` / `.insp-tab`：**今日预警 / 历史预警**（与监控同名同位）；
 *   · 统计行 —— `.home-stats.alarm-row`：左「今日预警数」（`.home-stat.alert` 红字，
 *     下一行小字写「待处理 N」）、右「近7日预警趋势」（`TouchChart`，与监控同一套
 *     折线 + 触控气泡）；分子与分母的口径和监控预警列表完全一致；
 *   · 列表 —— `.insp-list` / `.insp-item`：48px 无人机占位图标、标题 + 来源徽标、
 *     副标题一行任务名、右侧相对时间 + 状态徽标；
 *   · 未处理红点 —— **没有**（2026-11-24 起；监控预警列表同日起也下线，
 *     两页统一改为右侧「待处理 / 已完成」徽标）；
 *   · 空态 `.insp-empty`、骨架 `.insp-item.is-skel`、底部 `.msg-more` 全部复用。
 *
 * ## 今日 / 历史的分法
 *
 * 审核中心接口没有时间筛选（见 `stores/droneAlarm.ts` 的文件头），但返回按
 * `businessTime` 倒序，所以「今日」就是数据前缀 —— 首屏扫到 7 日窗口之外，
 * 今日条数就是精确值。
 *
 * 2026-11-24 起**历史页带日期控件**（今天 / 昨天 / 选日期 + 月历），与监控预警
 * 历史页（`views/sub/InspectList.vue`）逐项一致：同一个 `ui/DayPickChips`、
 * 同一个月历组件、同一个默认值（昨天）、同一套按日筛选。审核中心没有服务端
 * 时间筛选，所以筛选在本地做，早于已加载范围时按需回补（`drone.ensureDay`），
 * 回补不够就在列表下面写明「仅加载到 X 日」并给「继续加载」—— 不假装那天没有。
 *
 * ## 红点：没有（2026-11-24 现场口径）
 *
 * 工单行里没有未读/已读字段（`auditStatusType` 只有 `UNAUDITED` / `AUDITED`），
 * 本 App 也没有「把审核平台的工单标成已读」这个动作 —— 早先按「今日 + 待处理」
 * 点在图标右上角的红点，点进去也不会消失，只会被当成没修好的 bug。
 * 现在这一页**不点红点**（监控预警列表同日起也下线了红点）。
 * 状态照实显示在右侧徽标上（待处理 / 已完成），那是审核平台里的事实，
 * 与本机「看没看过」无关；「今日待处理」照常统计，进入消息页那张卡的数字，
 * 并与监控那份相加成为底栏角标（`stores/msg.ts`）。
 *
 * ## 从详情返回：页签与滚动位置都要回到原处
 *
 * 页签存在 `drone.listTab`（见下），滚动位置由 `SubPage` 的记忆表按
 * 「视图 + 页签」分开记 —— 从历史里点进去再返回，落点与进入前完全一致。
 * 行为与监控预警列表相同，用户不需要重新找位置。
 *
 * ## 图标位：与「监控预警」同一套取图逻辑（2026-11-20 对齐）
 *
 * 现场要求两个子页的图标「显示条件 / 状态映射 / 样式 / 交互」完全一致，
 * 所以这里照 `components/ui/InspectItem.vue` 的做法逐条搬过来：
 *
 *   ① 滚到视口附近（240px 提前量）才取图，用全站同一个 `revealThumb` 观察器；
 *   ② 拿到了铺 `.insp-pic` 缩略图（48px 圆角 + `object-fit: cover`）；
 *   ③ 没有 / 还没到 → **原样铺那颗灰底无人机占位图标**（`.alarm-tile`），
 *      灰底、内描边、图标 50% 尺寸与改之前一个像素都不差；
 *   ④ 取图过程中在占位图标外圈叠一圈 `ThumbRing`（真实字节进度）；
 *   ⑤ 红点已下线（见「红点：没有」），与有没有图无关。
 *
 * 工单图是 OSS **预签名**直链：CORS 通、但 `x-oss-process` 会被签名校验打回 403，
 * 所以缩图只能在前端做（`utils/imageThumb.ts`）并落盘（`utils/thumbCache.ts`）。
 * 为什么不直接铺原图：单张 200~300KB、没有 `Cache-Control`，一屏十来条就是几 MB，
 * 而且每次进页面都要重下一遍。
 */
const props = defineProps<{ decorative?: boolean }>()

const drone = useDroneAlarmStore()
const subpage = useSubpageStore()

/**
 * 当前页签 —— 存在 store 里（`drone.listTab`），不是本组件的 `ref`。
 *
 * 子页栈是同一个 `.subpage-body` 换内容：进详情时本组件被整棵卸载，返回时
 * 重新挂载。页签若是局部状态就会掉回「今日预警」—— 用户从历史里点进去、
 * 回来却站在今日，滚动位置也对不上（`SubPage` 的滚动记忆会按页签分开记）。
 * 监控列表用的是同一条规则（`alarm.inspTab`），两页因此行为一致。
 */
const tab = computed({
  get: () => drone.listTab,
  set: (v: 'today' | 'hist') => {
    drone.listTab = v
  },
})
const onHist = computed(() => tab.value === 'hist')

/** 首屏还没拿到今日数（没有结论就不铺 0） */
const syncing = computed(() => !drone.todayKnown && (drone.state === 'loading' || drone.state === 'idle'))

/** 慢请求才显示骨架：快请求直接出内容，不闪灰条 */
const showSkel = useSlowLoading(() => syncing.value)

/**
 * 近 7 日趋势：与首页 / 监控子页同款触控层。
 * fillId 必须错开 —— 三个图可能同时挂在 DOM 里，渐变 id 撞了会互相引用。
 */
const trendModel = computed(() => alarmTrendLive(drone.weekTrend, 'woAlarmFill'))
const hasTrend = computed(() => drone.weekTrend.some((p) => p.value > 0))

function onTab(next: 'today' | 'hist'): void {
  if (tab.value === next) return
  tab.value = next
  // 落到历史页签时，所选日期若超出已加载范围就顺手回补几页
  // （与报警预警历史页 `AlarmHist.onTab` 同一条规则）
  if (next === 'hist') void drone.ensureDay(drone.histDate)
}

/* ---------------- 历史页的日期控件（2026-11-24） ---------------- */

/*
 * 日期只有一颗芯片（带日历图标）+ 月历，点开选哪天就看哪天。
 * 日期本身存在 `drone.histDate`（默认昨天，与另两个预警历史页一致），
 * 属于「用户选择」而不是「数据」，重扫不会把它改掉。
 */
function setHistDate(d: Date): void {
  drone.histDate = startOfDay(d)
  drone.histCalOpen = false
  // 早于已加载范围时按需回补真实历史（每次最多 3 页 ≈ 60 条）
  void drone.ensureDay(drone.histDate)
}

/** 月历展开 / 收起：展开时把月份对齐到所选日期（与两个预警历史页一致） */
function onCalToggle(): void {
  if (drone.histCalOpen) {
    drone.histCalOpen = false
    return
  }
  drone.histCalMonth = startOfDay(
    new Date(drone.histDate.getFullYear(), drone.histDate.getMonth(), 1),
  )
  drone.histCalOpen = true
}

function onCalSelect(d: Date): void {
  setHistDate(d)
}

/**
 * 所选日期比已加载范围更早 —— 说明这天「还没取」，不是「没有」。
 *
 * 审核中心只能从新往旧翻页（`stores/droneAlarm.ts::ensureDay`），所以这里要说清
 * 覆盖范围并给一个继续加载的入口，版式与报警预警历史页那条提示相同。
 */
const histGap = computed(() => {
  const earliest = drone.earliestDay
  if (!earliest || !drone.hasMore) return false
  return dateKey(drone.histDate) < earliest
})

/** '2026-11-17' → '11/17' */
function dayLabel(key: string): string {
  const [, m, d] = key.split('-')
  return `${Number(m)}/${Number(d)}`
}

function onOpen(id: string): void {
  if (props.decorative) return
  subpage.openWorkOrderDetail(id)
}

/**
 * 行（图标位 / 徽标 / 键盘可达）的渲染都在 `components/ui/WorkOrderItem.vue`
 * （2026-11-23 抽出：报警预警历史页要把两类预警合成一条时间线，同一行要在两处出现）。
 * 这里只负责导航 —— 取图时机、占位图标、进度环、状态徽标都不变。
 */

onMounted(() => {
  if (props.decorative) return
  /*
   * **只在从没扫过时拉一次**（与监控列表同口径：数据在 store 里，返回不是一次
   * 「重新加载」）。
   *
   * 早先是无条件 `load()`：2 分钟保鲜期一过，从详情返回就会重扫首屏 ——
   * `load()` 是**整批替换** `items`，用户翻到历史第 200 条再点进去、返回时
   * 列表被截回首屏那 100 条，滚动位置也就没有落脚点了。监控那边不会这样
   * （`syncFromVideo` 是合并），这就是「两个详情返回后表现不一样」的来源。
   *
   * 保鲜由入口负责：App 启动 / 登录后拉一次，消息页每次切到消息 tab 再拉一次
   * （`views/MsgPage.vue` 的 `watch(shell.activeTab)`），点进本页时数据基本是新的。
   * 真的失败了有列表中间那颗「重试」，不靠「每次进页面偷偷重试」。
   */
  if (drone.state === 'idle') void drone.load()
})

/** 空态文案：接口失败写原因，其余按页签给各自的「暂无」 */
const emptyText = computed(() => {
  if (drone.error) return drone.error
  return onHist.value ? '该日暂无无人机预警' : '今日暂无无人机预警'
})
</script>

<template>
  <div class="insp-page">
    <!-- 页签：与监控预警同名同位（今日在前、历史在后） -->
    <div class="insp-tabs">
      <button
        class="insp-tab"
        :class="{ on: !onHist }"
        type="button"
        data-wo-tab="today"
        @click="onTab('today')"
      >
        今日预警
      </button>
      <button
        class="insp-tab"
        :class="{ on: onHist }"
        type="button"
        data-wo-tab="hist"
        @click="onTab('hist')"
      >
        历史预警
      </button>
    </div>

    <!-- 今日：今日预警数 + 近 7 日趋势 + 今日列表（不点红点，状态看右侧徽标） -->
    <div class="insp-pane" :class="{ hide: onHist }">
      <div class="home-stats alarm-row">
        <div class="home-stat alert">
          <b v-if="drone.todayKnown">{{ drone.todayCount }}</b>
          <!-- 扫描没完成：数字位换成灰条，不回填 0（0 是个结论，这里还不知道） -->
          <Skel v-else w="54px" h="31px" r="var(--r-6)" />
          <span>今日预警数</span>
          <!-- 待处理是今日预警的一部分，放第二行 —— 与监控预警列表同一版式 -->
          <em v-if="drone.todayKnown" class="stat-sub">待处理 {{ drone.todayPending }}</em>
        </div>
        <div class="home-chart-card alarm-mini">
          <span class="alarm-mini-lab">近7日预警趋势</span>
          <TouchChart v-if="hasTrend" :model="trendModel" />
          <Skel v-else-if="syncing" class="skel-mt" w="100%" h="48px" r="var(--r-6)" />
          <div v-else class="chart-empty">近 7 日暂无预警</div>
        </div>
      </div>

      <div v-if="drone.todayItems.length" class="insp-list">
        <!-- 不传 `dot`：无人机预警没有「已读」这个动作，点开也清不掉的红点
             只会被当成 bug（2026-11-24 现场口径，见 stores/droneAlarm.ts 文件头） -->
        <WorkOrderItem
          v-for="w in drone.todayItems"
          :key="w.id"
          :wo="w"
          :decorative="decorative"
          @open="onOpen(w.id)"
        />
      </div>

      <!-- 首屏加载：与 .insp-item 同构的灰条 -->
      <div v-else-if="syncing" class="insp-list skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="insp-item is-skel">
          <Skel w="48px" h="48px" r="var(--r-8)" />
          <div class="insp-meta">
            <Skel w="52%" h="14px" />
            <Skel class="skel-mt" w="78%" h="11px" />
          </div>
        </div>
      </div>

      <div v-else class="insp-empty" data-wo-empty>
        <span>{{ emptyText }}</span>
        <button v-if="drone.error" class="data-empty-btn" type="button" @click="drone.load(true)">
          重试
        </button>
      </div>
    </div>

    <!--
      历史：按所选日期看那一天的预警（2026-11-24 起带日期控件）。
      与监控预警历史页同一套：今天 / 昨天 / 选日期 + 月历，默认昨天，
      筛选在本地做，早于已加载范围时按需回补。不带红点、不参与待处理计数。
    -->
    <div class="insp-pane insp-hist" :class="{ hide: !onHist }">
      <div class="insp-hist-hd">
        <div>
          <strong>{{ formatCamDate(drone.histDate) }}</strong>
          <!-- 还在回补：条数没结论，写「…」而不是 0 -->
          <span>{{ drone.scanned && !drone.loadingMore ? `${drone.histCount}条` : '…' }}</span>
        </div>
        <!--
          只留一颗日期芯片（现场 2026-11-24 要求）：这页不摆「今天 / 昨天」——
          今日预警本身就是另一个页签。组件与监控预警、报警预警两个历史页同一个
          （`ui/DayPickChips` 的 `single` 模式），样式只有一份。
        -->
        <DayPickChips
          single
          :selected="drone.histDate"
          open-attr-name="data-wo-cal-open"
          @open="onCalToggle"
        />
      </div>

      <MonthCalendar
        v-model:month="drone.histCalMonth"
        :selected="drone.histDate"
        :max-day="inspCalMaxDay()"
        :hidden="!drone.histCalOpen"
        @select="onCalSelect"
      />

      <div v-if="drone.histItems.length" class="insp-list">
        <WorkOrderItem
          v-for="w in drone.histItems"
          :key="w.id"
          :wo="w"
          :decorative="decorative"
          @open="onOpen(w.id)"
        />
      </div>

      <div v-else-if="syncing" class="insp-list skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="insp-item is-skel">
          <Skel w="48px" h="48px" r="var(--r-8)" />
          <div class="insp-meta">
            <Skel w="52%" h="14px" />
            <Skel class="skel-mt" w="78%" h="11px" />
          </div>
        </div>
      </div>

      <div v-else class="insp-empty">{{ emptyText }}</div>

      <!-- 审核中心只能从新往旧翻页：所选日期更早时必须说清「还没取」，不能假装没有 -->
      <p v-if="histGap" class="insp-note">
        无人机预警仅加载到 {{ dayLabel(drone.earliestDay) }}，更早的还没取
        <button
          class="insp-note-btn"
          type="button"
          :disabled="drone.loadingMore"
          @click="drone.ensureDay(drone.histDate)"
        >
          {{ drone.loadingMore ? '加载中…' : '继续加载' }}
        </button>
      </p>
    </div>
  </div>
</template>
