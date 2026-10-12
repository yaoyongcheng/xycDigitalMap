<script setup lang="ts">
import { computed } from 'vue'

import { useAlarmStore } from '@/stores/alarm'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendSvg, peopleHourSvg } from '@/utils/chart'
import AlarmFeed from './parts/AlarmFeed.vue'
import PeopleDist from './parts/PeopleDist.vue'

/**
 * 首页 · 安全管理面板
 *
 * 对应原 js/app.js:368-411 renderSafety()。
 * 两块内容：预警（统计 + 趋势 + 轮播）与人员（概况 + 区域分布 + 时段趋势）。
 */
const alarm = useAlarmStore()
const subpage = useSubpageStore()

/** 原 alarmTrendSvg() 无参调用，fillId 走默认值 'alarmFill' */
const trendSvg = computed(() => alarmTrendSvg('alarmFill', alarm.latest.length))

/**
 * 原 js/app.js:197 —— 内部取 new Date().getHours()，此处显式传入。
 * 用 computed 而非常量：跨小时停留时原版每次重渲染都会重算，
 * 这里面板重新挂载时也会重算，行为一致。
 */
const hourSvg = computed(() => peopleHourSvg(new Date().getHours()))

/** 原 renderSafety 内联的四个指标（硬编码常量，非接口数据） */
const crewKpis: [string, string, string][] = [
  ['160', '人', '项目人数'],
  ['40', '人', '正在上班'],
  ['76', '人', '今日出勤'],
  ['47.5', '%', '出勤率'],
]

/** 原 homePanels 委托的 [data-alarm] 分支：跳到今日巡检列表 */
function onAlarmOpen(): void {
  subpage.openInspectList('today')
}
</script>

<template>
  <div class="safe-block">
    <h4>预警</h4>
    <div class="home-stats alarm-row">
      <div class="home-stat alert"><b>{{ alarm.latest.length }}</b><span>今日预警数</span></div>
      <div class="home-chart-card alarm-mini">
        <span class="home-card-lab">近7日预警趋势</span>
        <span v-html="trendSvg"></span>
      </div>
    </div>
    <AlarmFeed @open="onAlarmOpen" />
  </div>

  <div class="safe-block">
    <h4>人员</h4>
    <div class="safe-stack">
      <div class="home-chart-card crew-card">
        <span class="home-card-lab">作业人数</span>
        <div class="crew-overview">
          <div v-for="([n, unit, name], i) in crewKpis" :key="i" class="crew-kpi">
            <b>{{ n }}<em>{{ unit }}</em></b><span>{{ name }}</span>
          </div>
        </div>
      </div>

      <div class="home-chart-card people-dist">
        <span class="home-card-lab">人员区域分布</span>
        <div id="peopleDist">
          <PeopleDist />
        </div>
      </div>

      <div class="home-chart-card people-hour">
        <div class="people-hour-hd">
          <span class="home-card-lab">今日时段趋势</span>
          <div class="people-hour-leg">
            <span><i class="g"></i>工人</span>
            <span><i class="b"></i>管理人员</span>
          </div>
        </div>
        <div class="people-hour-y">人数</div>
        <span v-html="hourSvg"></span>
      </div>
    </div>
  </div>
</template>
