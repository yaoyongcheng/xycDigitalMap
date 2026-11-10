<script setup lang="ts">
import { computed } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { crewKpis, squadRows, tradeRows } from '@/data/config'
import { useAlarmStore } from '@/stores/alarm'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendModel } from '@/utils/chart'
import AlarmFeed from './parts/AlarmFeed.vue'
import PeopleDist from './parts/PeopleDist.vue'

/**
 * 首页 · 安全管理面板
 *
 * 对应原 js/app.js:368-411 renderSafety()。
 * 两块内容：预警（统计 + 趋势 + 轮播）与人员（概况 + 区域分布 + 出勤工种/班组）。
 *
 * 2026-11 对齐设计稿 gx2：人员块从「作业人数 / 区域分布 / 时段趋势」调整为
 * 设计稿的「人员总览 / 人员分布 / 今日出勤工种 / 今日班组出勤」四卡；
 * 原「今日时段趋势」卡（对应设计稿死代码 peopleHourSvg）下线。
 */
const alarm = useAlarmStore()
const subpage = useSubpageStore()

/** 原 alarmTrendSvg() 无参调用，fillId 走默认值 'alarmFill'（触控层用模型版） */
const trendModel = computed(() => alarmTrendModel(alarm.latest.length))

/** 数值滚动用的解析结果（crewKpis 与横屏 KPI 坞同源；小数位按原始值决定） */
const crewNums = crewKpis.map(([n]) => ({
  value: n,
  decimals: Number.isInteger(n) ? 0 : 1,
}))

/**
 * 数据时效戳（2026-10 改造新增）——面板挂载时刻。
 * 静态演示数据容易被误认为实时数据，标注时间降低误读。
 */
const updTime = (() => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
})()

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
          <div v-for="([, unit, name], i) in crewKpis" :key="i" class="crew-kpi">
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

      <div class="home-chart-card trade-card">
        <span class="home-card-lab">今日出勤工种</span>
        <div class="trade-list">
          <div v-for="[name, n] in tradeRows" :key="name" class="trade-row">
            <b>{{ name }}</b>
            <div class="trade-bar"><i :style="{ width: (n / tradeRows[0][1] * 100).toFixed(1) + '%' }"></i></div>
            <em>{{ n }}</em>
          </div>
        </div>
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
          <div v-for="[name, n, rate] in squadRows" :key="name" class="squad-row">
            <div class="squad-hd"><b>{{ name }}</b><em>{{ n }}人</em><span>{{ rate }}</span></div>
            <div class="squad-bar"><i :style="{ width: rate }"></i></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
