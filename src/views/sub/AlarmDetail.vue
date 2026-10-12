<script setup lang="ts">
import type { Alarm } from '@/types'

/**
 * 预警详情（子页内容）
 *
 * 对应原 js/app.js:780-799 renderAlarmDetail(a)。
 * 注意「项目名称 / 任务名称 / 地址」三项在原版是硬编码常量，
 * 不来自预警数据 —— 1:1 复刻下如实保留。
 */
defineProps<{ alarm: Alarm }>()
</script>

<template>
  <div class="alarm-hero">
    <img :src="alarm.img" :alt="alarm.type" />
    <div class="alarm-hero-tag">
      <strong>自动巡航无人机</strong>
      <span>UAV-25638583</span>
    </div>
  </div>
  <div class="alarm-info">
    <h4>基础信息</h4>
    <div class="alarm-kv"><span>项目名称</span><em>中建三局-向阳村项目</em></div>
    <div class="alarm-kv"><span>任务名称</span><em>向阳村-三维(加密)</em></div>
    <div class="alarm-kv"><span>检测时间</span><em>{{ alarm.at }}</em></div>
    <h4>识别结果</h4>
    <div class="alarm-kv"><span>识别类型</span><em>{{ alarm.type }}</em><b>自动</b><i>0级</i></div>
    <div class="alarm-kv"><span>地址</span><em>湖北省武汉市汉阳区江堤街道江永堤路铉龙城</em></div>
    <div class="alarm-kv"><span>经纬度</span><em class="alarm-geo">{{ alarm.geo }}</em></div>
  </div>
</template>
