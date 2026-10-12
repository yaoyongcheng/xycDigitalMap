<script setup lang="ts">
import { computed } from 'vue'

import { qaSteps } from '@/data/config'
import { useHomeStore } from '@/stores/home'

/**
 * 首页 · 质量管理面板
 *
 * 对应原 js/app.js:442-487 renderQuality()。
 * 两块内容：合格率对比柱状图 + 验收工序环形图。
 */
const home = useHomeStore()

/** 原 stepTotal */
const stepTotal = computed(() => qaSteps.reduce((s, d) => s + d.n, 0))

/**
 * 原 pie —— conic-gradient 字符串。
 * 注意展开顺序依赖累加器 acc，必须用与原型一致的循环。
 */
const pie = computed(() => {
  let acc = 0
  return (
    'conic-gradient(' +
    qaSteps
      .map((d) => {
        const a = acc
        acc += (d.n / stepTotal.value) * 100
        return `${d.color} ${a}% ${acc}%`
      })
      .join(', ') +
    ')'
  )
})
</script>

<template>
  <div class="safe-block">
    <h4>合格率</h4>
    <div class="home-chart-card qa-pass">
      <div class="qa-pass-hd">
        <span>合格率%</span>
        <div class="qa-pass-leg">
          <span><i class="last"></i>上月合格率</span>
          <span><i class="now"></i>本月合格率</span>
        </div>
      </div>
      <div class="qa-pass-plot">
        <div class="qa-pass-y"><em>100</em><em>80</em><em>60</em><em>40</em><em>20</em><em>0</em></div>
        <div class="qa-pass-cols">
          <div v-for="d in home.qaCats" :key="d.name" class="qa-pass-col">
            <div class="qa-pass-pair">
              <b class="last" :style="{ height: d.last + '%' }"><em>{{ d.last }}</em></b>
              <b class="now" :style="{ height: d.now + '%' }"><em>{{ d.now }}</em></b>
            </div>
            <span>{{ d.name }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="safe-block">
    <h4>验收工序</h4>
    <div class="home-chart-card">
      <div class="home-chart-row qa-chart">
        <div class="donut qa-step-donut" :style="{ background: pie }">
          <div class="donut-label"><b>100</b><span>验收工序</span></div>
        </div>
        <div class="qa-legend">
          <div v-for="d in qaSteps" :key="d.name" class="qa-legend-item">
            <i :style="{ background: d.color }"></i><span>{{ d.name }}</span><em>{{ d.n }}</em>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
