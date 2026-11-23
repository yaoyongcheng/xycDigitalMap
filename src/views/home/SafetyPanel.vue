<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import Skel from '@/components/ui/Skel.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useOverviewStore } from '@/stores/overview'
import { useSubpageStore } from '@/stores/subpage'
import { mergeAlarmEntries, mergeTrend } from '@/utils/alarmMerge'
import { alarmTrendLive, peopleHourModel } from '@/utils/chart'
import { useSlowLoading } from '@/utils/slowLoading'
import AlarmFeed from './parts/AlarmFeed.vue'
import PeopleDist from './parts/PeopleDist.vue'

/**
 * 首页 · 安全管理面板
 *
 * 对应原 js/app.js:368-411 renderSafety()。
 * 两块内容：预警（统计 + 趋势 + 轮播）与人员（概况 + 区域分布 + 出勤）。
 *
 * 2026-11 设计稿 gx2：人员块为「人员总览 / 人员分布 / 今日分时人数 / 今日出勤工种 /
 * 今日班组出勤」。工种卡 2026-11-17 重新上线 —— 数据来自花名册 `POST /person/page`
 * 的 `typeWork` + `presentStatus` 筛选（接口没有聚合能力，逐个工种问 total）。
 *
 * **2026-11 数据口径收口（本轮）**：本面板内的数字与曲线**全部来自接口**，
 * 取不到就显示空态，不再用 `data/config.ts` 的演示值顶替 —— 演示数字与现场
 * 对不上、又没有视觉标识，比空着更容易误导。为此每个数据块都有自己的
 * 空态文案与「去登录 / 重试」入口。
 */
const alarm = useAlarmStore()
const drone = useDroneAlarmStore()
const auth = useAuthStore()
const subpage = useSubpageStore()
const overview = useOverviewStore()

/**
 * 今日预警 = 监控预警 + 无人机预警，按时间倒序合并去重（2026-11-23 现场要求）。
 *
 * 合并口径见 `utils/alarmMerge.ts`：两边各带自己的 id 前缀，翻页重叠不会多一行；
 * 字段映射一个字都不改 —— 数字只数行数，行仍由各自的组件渲染。
 */
const todayEntries = computed(() => mergeAlarmEntries(alarm.latest, drone.todayItems))

/** 今日预警数（统计卡大数字）：合并后行数，与下方轮播同一份口径 */
const todayCount = computed(() => todayEntries.value.length)

/** 两路都为空时才算真「今日暂无报警」 */
const hasAny = computed(() => todayEntries.value.length > 0)

/** 监控侧是否已有结论：有数据 / 成功（可能是 0 条）/ 失败都算，只有加载中不算 */
const alarmReady = computed(
  () => alarm.hasLive || alarm.liveState === 'ok' || alarm.liveState === 'error',
)

/** 无人机侧是否已有结论：首屏扫完或已经失败；还在扫时列表为空不等于「没有」 */
const droneReady = computed(() => drone.scanned || drone.state === 'error')

/** 两路都还没结论：不能提前写「今日暂无报警」，先铺骨架 */
const syncing = computed(() => !hasAny.value && (!alarmReady.value || !droneReady.value))

/** 近 7 日预警趋势：两份按日相加（同一 7 天、同一 `M/D` 标签），fillId 不变 */
const mergedTrend = computed(() => mergeTrend(alarm.trend, drone.weekTrend))
const trendModel = computed(() => alarmTrendLive(mergedTrend.value, 'alarmFill'))

/** 趋势图是否有真实数据可看 —— 全 0 时不画一条贴底的直线，直接给空态 */
const hasTrend = computed(() => mergedTrend.value.some((p) => p.value > 0))

/** 空态文案：优先用监控侧的原话（与改之前一致），无人机单独失败时用它的原因 */
const emptyError = computed(() => {
  if (alarm.liveState === 'error') return alarm.liveError || '报警同步失败'
  if (drone.state === 'error') return drone.error || '无人机预警加载失败'
  return ''
})

/**
 * 有一路失败时列表照常显示另一路，但要写清「不完整」——
 * 否则用户会以为今天只有这几条（与报警预警历史页同一条规则）。
 */
const sourceNote = computed(() => {
  const bad: string[] = []
  if (alarm.liveState === 'error') bad.push('监控预警同步失败')
  if (drone.state === 'error') bad.push('无人机预警加载失败')
  return bad.length ? `${bad.join('；')}，统计可能不完整` : ''
})

/** 数值滚动用的解析结果：null 显示「—」，不再回落演示值 */
const crewNums = computed(() =>
  overview.kpis.map(([n]) => ({
    value: n,
    decimals: n !== null && !Number.isInteger(n) ? 1 : 0,
  })),
)

/**
 * 今日分时人数曲线：接口没数据（或不足两个整点）时给 undefined，
 * 模板据此显示空态，而不是退回演示曲线。
 */
const hourModel = computed(() => peopleHourModel(new Date().getHours(), overview.hourLive))

const updTime = computed(() => overview.updatedAt)

/**
 * 四个数据块各有一条「慢请求」判据。
 *
 * 骨架不是「一请求就上屏」，而是等过了 SKEL_DELAY 才淡入（utils/slowLoading.ts）：
 * 现场的读接口通常一两百毫秒就回来了，那种情况骨架连一帧都不该出现。分开判
 * 是因为四块各自独立成败 —— 人员总览回来了不代表班组出勤也回来了。
 */
const showAlarmSkel = useSlowLoading(() => syncing.value)
const showCrewSkel = useSlowLoading(() => !overview.hasLive && overview.loading)
const showHourSkel = useSlowLoading(() => !overview.hourLive && overview.loading)
const showTeamSkel = useSlowLoading(() => !overview.teamRows.length && overview.loading)
const showTradeSkel = useSlowLoading(() => !overview.tradeRows.length && overview.loading)

/**
 * 工种卡只放前 10 行（与设计稿一致：设计稿就是 10 行条形）。
 *
 * 现场目前有 20 多个工种，全铺开会让这张卡长到两三屏；条形宽度是相对最大值
 * 折算的，后面的小工种本来也只剩一两个像素。
 */
const tradeTop = computed(() => overview.tradeRows.slice(0, 10))

/** 条宽 = 人数 / 第一名，最短 6%（0 人不会出现，接口已过滤） */
function tradePct(n: number): string {
  const max = tradeTop.value[0]?.[1] ?? 1
  return `${Math.max((n / max) * 100, 6).toFixed(1)}%`
}

/**
 * 面板挂载即取一次。
 *
 * 首页三个模块标签切换时，`HomeSheet` 的 `.home-panels` 带 `:key="home.homeMod"`，
 * 面板是**真的卸载再挂载**的 —— 所以这里就是「切回智巡」的入口，必须走
 * `refresh()`（已有数据也重拉）而不是 `load()`（有缓存就跳过），否则切回来
 * 看到的还是上次进首页那一刻的报警与人员数。
 *
 * `refresh` 内部保留失败冷却：连点标签不会把注定失败的请求反复打出去。
 */
onMounted(() => {
  void overview.refresh()
  // 视频报警接口要 Bearer，未登录必定 401 —— 未登录时不打这趟请求；
  // 无人机预警与这段统计同口径，也就等登录后再拉（store 自带 2 分钟保鲜）
  if (auth.token) {
    void alarm.refresh(auth.token)
    void drone.load()
  }
})

/**
 * 登录态变化时补拉一次。
 *
 * 登录页是盖在首页上的子页，首页面板本身**不卸载**，`onMounted` 不会因为登录
 * 成功而重跑：「先进首页 → 去我的登录 → 回首页」时 token 才出现，光靠 onMounted
 * 永远等不到。退出登录的清理由 auth store 的 clear() 负责（调用 alarm.clearLive）。
 */
watch(
  () => auth.token,
  (t) => {
    if (!t) return
    void alarm.syncFromVideo(t)
    // 无人机侧是另一套后端：登录时补一次首屏扫描，否则数字里永远少这一类
    void drone.load()
    // 登录前 open 接口可能因网络抖动失败过，登录成功后强制补一次
    void overview.load(true)
  },
)

/** 重试：报警（两路）与人员总览一起重来（数据源互相独立，谁失败重谁没必要细分） */
function retry(): void {
  void overview.load(true)
  if (auth.token) {
    void alarm.syncFromVideo(auth.token, true)
    void drone.load(true)
  }
}

/**
 * 去登录。
 *
 * 带上 `next`：用户点「去登录 / 历史」是想看报警，登录完直接落到巡检列表，
 * 不用再点一遍（支付宝式的「登录后继续原操作」）。
 */
function goLogin(next?: 'inspect-list'): void {
  subpage.openLogin(
    '登录后查看现场实时报警与人员数据',
    next === 'inspect-list' ? { kind: 'inspect-list' } : null,
  )
}

/**
 * 「历史」按钮的登录守卫。
 *
 * 报警接口要求 Bearer：未登录进去只会看到「该日暂无预警记录」，用户会以为
 * 真没数据。所以在入口就拦下来，登录成功后再打开历史页。
 */
function onHistOpen(): void {
  if (!auth.isLoggedIn) {
    subpage.openLogin('登录后可查看报警预警历史', { kind: 'alarm-hist' })
    return
  }
  subpage.openAlarmHist()
}

/**
 * 原 homePanels 委托的 [data-alarm] 分支。
 *
 * 从轮播点进去：监控预警直接按 id 打开报警详情、返回首页；无人机预警
 * 打开工单详情（`from = null` 同样表示返回首页，见 `stores/subpage.ts`）。
 * id 失效（数据已被清空 / 换会话）时退回各自的列表，不让用户卡在空详情页。
 */
function onAlarmOpen(kind: 'monitor' | 'drone', id: string): void {
  if (kind === 'drone') {
    if (drone.byId(id)) subpage.openWorkOrderDetail(id, null)
    else subpage.openWorkOrders()
    return
  }
  if (alarm.byId(id)) subpage.openAlarmDetail(id, false)
  else subpage.openInspectList('today')
}
</script>

<template>
  <div class="safe-block">
    <div class="safe-hd">
      <h4>报警预警<span v-if="updTime" class="upd-time">更新于 {{ updTime }}</span></h4>
      <button class="alarm-hist-btn" type="button" data-alarm-hist @click="onHistOpen">
        历史
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>
    </div>

    <!-- 未登录：不显示任何报警数字，直接引导登录 -->
    <div v-if="!auth.isLoggedIn" class="data-empty" data-empty="alarm">
      <p>登录后可查看现场实时报警</p>
      <button class="data-empty-btn" type="button" @click="goLogin('inspect-list')">去登录</button>
    </div>

    <!-- 已登录但一条都没拉到：区分「同步中 / 失败 / 今日无报警」 -->
    <template v-else-if="!hasAny">
      <!--
        同步中（监控或无人机任一路还没结论）：灰条铺在计数卡、趋势图、轮播条将要
        出现的位置，数据到手后原位回填。慢请求才可见（showAlarmSkel 之外整层
        opacity: 0，但仍占位，版式不跳）。
      -->
      <template v-if="syncing">
        <span class="sr-only" role="status">正在同步现场报警</span>
        <div class="home-stats alarm-row skel-fade" :class="{ 'is-on': showAlarmSkel }" aria-hidden="true">
          <div class="home-stat alert">
            <Skel w="54px" h="31px" r="var(--r-6)" />
            <Skel class="skel-mt" w="62px" h="14px" />
          </div>
          <div class="home-chart-card alarm-mini">
            <Skel w="72px" h="12px" />
            <Skel class="skel-mt" w="100%" h="48px" r="var(--r-6)" />
          </div>
        </div>
        <div class="home-chart-card alarm-feed skel-fade" :class="{ 'is-on': showAlarmSkel }" aria-hidden="true">
          <div class="skel-feed-row">
            <div v-for="i in 3" :key="i" class="skel-feed-item">
              <Skel w="100%" h="54px" r="var(--r-8)" />
            </div>
          </div>
        </div>
      </template>
      <div v-else-if="emptyError" class="data-empty" data-empty="alarm">
        <p>{{ emptyError }}</p>
        <button class="data-empty-btn" type="button" @click="retry">重试</button>
      </div>
      <div v-else class="data-empty" data-empty="alarm">
        <p>今日暂无报警</p>
      </div>
    </template>

    <template v-else>
      <div class="home-stats alarm-row">
        <div class="home-stat alert"><b><CountUp :value="todayCount" sticky /></b><span>今日预警数</span></div>
        <div class="home-chart-card alarm-mini">
          <span class="home-card-lab">近7日预警趋势</span>
          <TouchChart v-if="hasTrend" :model="trendModel" />
          <div v-else class="chart-empty">近 7 日暂无报警</div>
        </div>
      </div>
      <AlarmFeed @open="onAlarmOpen" />
      <!-- 有一路没取到：另一路照常展示，但要说清数字不完整 -->
      <div v-if="sourceNote" class="data-note">{{ sourceNote }}</div>
    </template>
  </div>

  <div class="safe-block">
    <h4>人员管理<span v-if="updTime" class="upd-time">更新于 {{ updTime }}</span></h4>
    <div class="safe-stack">
      <div class="home-chart-card crew-card">
        <span class="home-card-lab">人员总览</span>
        <div class="crew-overview">
          <div v-for="([, unit, name], i) in overview.kpis" :key="i" class="crew-kpi">
            <b v-if="crewNums[i].value !== null">
              <CountUp :value="crewNums[i].value as number" :decimals="crewNums[i].decimals" sticky /><em>{{ unit }}</em>
            </b>
            <!-- 慢请求：数字位换成灰条（高度与 .crew-kpi b 的 21px 行盒一致），不回填「—」 -->
            <Skel v-else-if="showCrewSkel" w="44px" h="21px" r="var(--r-6)" />
            <b v-else class="kpi-none">—<em>{{ unit }}</em></b>
            <span>{{ name }}</span>
          </div>
        </div>
        <!-- 同步中不写字（灰条已经在说了），只在真拿不到时给原因与重试 -->
        <div v-if="!overview.hasLive && !overview.loading" class="data-note">
          暂无人员数据
          <button class="data-empty-btn is-inline" type="button" @click="retry">重试</button>
        </div>
      </div>

      <div class="home-chart-card people-dist">
        <div class="people-hour-hd">
          <span class="home-card-lab">人员分布</span>
          <span v-if="overview.sceneTotal !== null" class="trade-cap">在场 {{ overview.sceneTotal }} 人</span>
        </div>
        <div id="peopleDist">
          <PeopleDist />
        </div>
      </div>

      <div class="home-chart-card people-hour">
        <div class="people-hour-hd">
          <span class="home-card-lab">今日分时人数</span>
          <div class="people-hour-leg">
            <span><i class="g"></i>工人</span>
            <span><i class="b"></i>管理</span>
          </div>
        </div>
        <TouchChart v-if="overview.hourLive" :model="hourModel" />
        <!-- 慢请求：整块图表位（148px，与 .people-hour .chart-empty 同高）铺一条灰块 -->
        <div v-else-if="showHourSkel" aria-hidden="true">
          <Skel w="100%" h="148px" r="var(--r-8)" />
        </div>
        <div v-else class="chart-empty">暂无分时人数数据</div>
      </div>

      <div class="home-chart-card trade-card">
        <div class="people-hour-hd">
          <span class="home-card-lab">今日出勤工种</span>
          <span class="trade-cap">在场人数</span>
        </div>
        <div v-if="tradeTop.length" class="trade-list">
          <div v-for="[name, n] in tradeTop" :key="name" class="trade-row">
            <b>{{ name }}</b>
            <div class="trade-bar"><i :style="{ width: tradePct(n) }"></i></div>
            <em>{{ n }}</em>
          </div>
        </div>
        <!-- 慢请求：10 行灰条（行结构 = 名称 + 8px 条 + 数字），与真表同高 -->
        <div v-else-if="showTradeSkel" class="trade-list" aria-hidden="true">
          <div v-for="i in 10" :key="i" class="trade-row">
            <Skel class="skel-flex" w="3.6em" h="12px" />
            <Skel class="skel-flex" w="100%" h="8px" r="var(--r-pill)" />
            <Skel w="16px" h="12px" />
          </div>
        </div>
        <div v-else class="chart-empty">暂无工种出勤数据</div>
      </div>

      <div class="home-chart-card squad-card">
        <div class="people-hour-hd">
          <span class="home-card-lab">今日班组出勤</span>
          <div class="people-hour-leg">
            <span><i class="g"></i>出勤率</span>
            <span><i class="b"></i>出勤人数</span>
          </div>
        </div>
        <div v-if="overview.teamRows.length" class="squad-list">
          <div v-for="[name, n, rate] in overview.teamRows" :key="name" class="squad-row">
            <div class="squad-hd"><b>{{ name }}</b><em>{{ n }}人</em><span>{{ rate }}</span></div>
            <div class="squad-bar"><i :style="{ width: rate }"></i></div>
          </div>
        </div>
        <!-- 慢请求：3 行班组灰条（行结构 = 名字行 + 4px 进度条） -->
        <div v-else-if="showTeamSkel" class="squad-list" aria-hidden="true">
          <div v-for="i in 3" :key="i">
            <div class="squad-hd">
              <Skel class="skel-flex" w="60px" h="12px" /><Skel w="24px" h="12px" /><Skel w="36px" h="12px" />
            </div>
            <Skel class="skel-mt-sm" w="100%" h="4px" r="var(--r-pill)" />
          </div>
        </div>
        <div v-else class="chart-empty">暂无班组出勤数据</div>
      </div>
    </div>
  </div>
</template>
