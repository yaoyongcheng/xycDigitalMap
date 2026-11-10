<script setup lang="ts">
import { computed, onMounted } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useOverviewStore } from '@/stores/overview'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendModel, peopleHourModel } from '@/utils/chart'
import AlarmFeed from './parts/AlarmFeed.vue'
import PeopleDist from './parts/PeopleDist.vue'

/**
 * 首页 · 安全管理面板
 *
 * 对应原 js/app.js:368-411 renderSafety()。
 * 两块内容：预警（统计 + 趋势 + 轮播）与人员（概况 + 区域分布 + 出勤）。
 *
 * 2026-11 对齐设计稿 gx2：人员块从「作业人数 / 区域分布 / 时段趋势」调整为
 * 设计稿的「人员总览 / 人员分布 / 今日出勤工种 / 今日班组出勤」四卡。
 *
 * 2026-11 接入真实接口：设计稿的「今日出勤工种」在全项目四套后端里都**没有**
 * 对应接口（工种维度只有客户端枚举 `WorkTypeToEnum`，没有取数端点），而
 * 「今日班组出勤」有 `todayTeamsAtteStat`、分时人数有 `todayPersonHourStat`。
 * 于是这张卡换成有真数据的「今日分时人数」—— 免得三张真数据卡里夹一张假数据，
 * 反而更难判断哪个能信。视觉沿用设计稿里已下线但样式仍在的 `.people-hour`。
 */
const alarm = useAlarmStore()
const subpage = useSubpageStore()
const overview = useOverviewStore()

/** 原 alarmTrendSvg() 无参调用，fillId 走默认值 'alarmFill'（触控层用模型版） */
const trendModel = computed(() => alarmTrendModel(alarm.latest.length))

/**
 * 数值滚动用的解析结果。
 *
 * 2026-11 接入真实接口：数据源改为 overview store（`/bigScreen/BigsHome/personOverall`），
 * 取不到时 store 内部回落到 data/config.ts 的 crewKpis，所以这里无需判空。
 * 小数位仍按最终值决定 —— 出勤率可能是 30 或 30.0，随接口返回。
 */
const crewNums = computed(() =>
  overview.kpis.map(([n]) => ({
    value: n,
    decimals: Number.isInteger(n) ? 0 : 1,
  })),
)

/**
 * 今日分时人数曲线。
 *
 * `overview.hourLive` 为空（接口没通 / 数据不足）时传 undefined，
 * `peopleHourModel` 会自动回落到原版演示曲线 —— 图表不会画成一条空线。
 */
const hourModel = computed(() => peopleHourModel(new Date().getHours(), overview.hourLive))

/**
 * 数据时效戳 —— 有接口数据时用它自己的取数时刻，否则退回面板挂载时刻。
 * 静态演示数据容易被误认为实时数据，标注时间降低误读。
 */
const mountTime = (() => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
})()

const updTime = computed(() => overview.updatedAt || mountTime)

// 面板挂载即取一次；store 内部有并发去重与失败冷却
onMounted(() => {
  void overview.load()
})

/**
 * 原 homePanels 委托的 [data-alarm] 分支。
 *
 * 2026-10 交互优化（修正路径冗余）：
 *   改造前这里丢弃了 AlarmFeed emit 出来的预警 id，一律跳「今日预警列表」，
 *   用户在轮播里点中某一条后，还得在列表里再找一遍、再点一次才看得到详情。
 *   现在直接用 id 打开对应详情。
 *
 * 返回目标必须是**首页**（fromList=false）而不是巡检列表：
 * 上一页就是首页安全面板，用户没经过列表，凭空多插一层会让人觉得迷路。
 * 从巡检列表点进详情的那条路径仍走 InspectList 的 fromList=true。
 * 数据异常（id 已失效）时退回列表，不让用户卡在空详情页。
 */
function onAlarmOpen(id: string): void {
  if (alarm.byId(id)) subpage.openAlarmDetail(id, false)
  else subpage.openInspectList('today')
}
</script>

<template>
  <div class="safe-block">
    <!-- 2026-11 设计稿 gx2 版：标题改「报警预警」+ 历史入口（原 app.js:552-557 safe-hd） -->
    <div class="safe-hd">
      <h4>报警预警<span class="upd-time">更新于 {{ updTime }}</span></h4>
      <button class="alarm-hist-btn" type="button" data-alarm-hist @click="subpage.openAlarmHist()">
        历史
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>
    </div>
    <div class="home-stats alarm-row">
      <div class="home-stat alert"><b><CountUp :value="alarm.latest.length" sticky /></b><span>今日预警数</span></div>
      <div class="home-chart-card alarm-mini">
        <span class="home-card-lab">近7日预警趋势</span>
        <TouchChart :model="trendModel" />
      </div>
    </div>
    <AlarmFeed @open="onAlarmOpen" />
  </div>

  <div class="safe-block">
    <h4>人员管理</h4>
    <div class="safe-stack">
      <div class="home-chart-card crew-card">
        <span class="home-card-lab">人员总览</span>
        <div class="crew-overview">
          <div v-for="([, unit, name], i) in overview.kpis" :key="i" class="crew-kpi">
            <b><CountUp :value="crewNums[i].value" :decimals="crewNums[i].decimals" sticky /><em>{{ unit }}</em></b><span>{{ name }}</span>
          </div>
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
        <TouchChart :model="hourModel" />
      </div>

      <div class="home-chart-card squad-card">
        <div class="people-hour-hd">
          <span class="home-card-lab">今日班组出勤</span>
          <div class="people-hour-leg">
            <span><i class="g"></i>出勤率</span>
            <span><i class="b"></i>出勤人数</span>
          </div>
        </div>
        <div class="squad-list">
          <div v-for="[name, n, rate] in overview.teamRows" :key="name" class="squad-row">
            <div class="squad-hd"><b>{{ name }}</b><em>{{ n }}人</em><span>{{ rate }}</span></div>
            <div class="squad-bar"><i :style="{ width: rate }"></i></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
