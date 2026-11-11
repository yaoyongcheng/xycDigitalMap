<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useOverviewStore } from '@/stores/overview'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendLive, peopleHourModel } from '@/utils/chart'
import AlarmFeed from './parts/AlarmFeed.vue'
import PeopleDist from './parts/PeopleDist.vue'

/**
 * 首页 · 安全管理面板
 *
 * 对应原 js/app.js:368-411 renderSafety()。
 * 两块内容：预警（统计 + 趋势 + 轮播）与人员（概况 + 区域分布 + 出勤）。
 *
 * 2026-11 设计稿 gx2：人员块为「人员总览 / 人员分布 / 今日分时人数 / 今日班组出勤」。
 *
 * **2026-11 数据口径收口（本轮）**：本面板内的数字与曲线**全部来自接口**，
 * 取不到就显示空态，不再用 `data/config.ts` 的演示值顶替 —— 演示数字与现场
 * 对不上、又没有视觉标识，比空着更容易误导。为此每个数据块都有自己的
 * 空态文案与「去登录 / 重试」入口。
 */
const alarm = useAlarmStore()
const auth = useAuthStore()
const subpage = useSubpageStore()
const overview = useOverviewStore()

/** 近 7 日预警趋势（真实按日聚合，无数据时是 7 个 0，不画演示曲线） */
const trendModel = computed(() => alarmTrendLive(alarm.trend, 'alarmFill'))

/** 趋势图是否有真实数据可看 —— 全 0 时不画一条贴底的直线，直接给空态 */
const hasTrend = computed(() => alarm.trend.some((p) => p.value > 0))

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

/** 面板挂载即取一次；store 内部有并发去重与失败冷却 */
onMounted(() => {
  void overview.load()
  // 视频报警接口要 Bearer，未登录必定 401 —— 未登录时不打这趟请求
  if (auth.token) void alarm.syncFromVideo(auth.token)
})

/**
 * 登录态变化时补拉一次报警。
 *
 * 首页面板是常驻组件（切 tab 只切 class，不重新挂载），`onMounted` 全程只跑一次。
 * 用户「先进首页 → 再去我的登录 → 回首页」时 token 才出现，光靠 onMounted
 * 永远等不到。退出登录的清理由 auth store 的 clear() 负责（调用 alarm.clearLive）。
 */
watch(
  () => auth.token,
  (t) => {
    if (!t) return
    void alarm.syncFromVideo(t)
    // 登录前 open 接口可能因网络抖动失败过，登录成功后强制补一次
    void overview.load(true)
  },
)

/** 重试：报警与人员总览一起重来（两个源互相独立，谁失败重谁没必要细分） */
function retry(): void {
  void overview.load(true)
  if (auth.token) void alarm.syncFromVideo(auth.token, true)
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
 * 从轮播点进详情时直接按 id 打开（不再多走一层列表），返回目标是首页；
 * id 失效（数据已被清空 / 换会话）时退回列表，不让用户卡在空详情页。
 */
function onAlarmOpen(id: string): void {
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
    <template v-else-if="!alarm.hasLive">
      <div v-if="alarm.liveState === 'loading'" class="data-empty" data-empty="alarm">
        <p>正在同步现场报警…</p>
      </div>
      <div v-else-if="alarm.liveState === 'error'" class="data-empty" data-empty="alarm">
        <p>{{ alarm.liveError || '报警同步失败' }}</p>
        <button class="data-empty-btn" type="button" @click="retry">重试</button>
      </div>
      <div v-else class="data-empty" data-empty="alarm">
        <p>今日暂无报警</p>
      </div>
    </template>

    <template v-else>
      <div class="home-stats alarm-row">
        <div class="home-stat alert"><b><CountUp :value="alarm.latest.length" sticky /></b><span>今日预警数</span></div>
        <div class="home-chart-card alarm-mini">
          <span class="home-card-lab">近7日预警趋势</span>
          <TouchChart v-if="hasTrend" :model="trendModel" />
          <div v-else class="chart-empty">近 7 日暂无报警</div>
        </div>
      </div>
      <AlarmFeed @open="onAlarmOpen" />
    </template>
  </div>

  <div class="safe-block">
    <h4>人员管理</h4>
    <div class="safe-stack">
      <div class="home-chart-card crew-card">
        <span class="home-card-lab">人员总览</span>
        <div class="crew-overview">
          <div v-for="([, unit, name], i) in overview.kpis" :key="i" class="crew-kpi">
            <b v-if="crewNums[i].value !== null">
              <CountUp :value="crewNums[i].value as number" :decimals="crewNums[i].decimals" sticky /><em>{{ unit }}</em>
            </b>
            <b v-else class="kpi-none">—<em>{{ unit }}</em></b>
            <span>{{ name }}</span>
          </div>
        </div>
        <div v-if="!overview.hasLive" class="data-note">
          <template v-if="overview.loading">正在获取人员数据…</template>
          <template v-else>
            暂无人员数据
            <button class="data-empty-btn is-inline" type="button" @click="retry">重试</button>
          </template>
        </div>
      </div>

      <div class="home-chart-card people-dist">
        <span class="home-card-lab">人员分布</span>
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
        <div v-else class="chart-empty">暂无分时人数数据</div>
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
        <div v-else class="chart-empty">暂无班组出勤数据</div>
      </div>
    </div>
  </div>
</template>
