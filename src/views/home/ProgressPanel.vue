<script setup lang="ts">
import { computed } from 'vue'

import { milestones } from '@/data/config'
import { msFlag } from '@/data/icons'
import { useHomeStore } from '@/stores/home'
import type { Building } from '@/types'

/**
 * 首页 · 进度管理面板
 *
 * 对应原 js/app.js:491-532 renderProgress()。
 * 两块内容：项目总里程碑时间轴 + 楼栋进度条。
 *
 * 注：原版 milestones 数组写在函数体内（每次渲染重建），
 * 已提到 src/data/config.ts —— 内容逐字不变，且为常量，行为等同。
 */
const home = useHomeStore()

/** 原版楼栋进度百分比按 done/total 取整，且 plan === '滞后' 时加 .late */
function pctOf(b: Building): number {
  return Math.round((b.done / b.total) * 100)
}

const buildings = computed(() => home.siteBuildings)
</script>

<template>
  <div class="safe-block">
    <h4>项目总里程碑</h4>
    <div class="home-chart-card ms-card">
      <div class="ms-list">
        <div v-for="m in milestones" :key="m.name" class="ms-item" :class="m.state">
          <i class="ms-ico" v-html="msFlag"></i>
          <div class="ms-body">
            <strong>{{ m.name }}</strong>
            <p>计划完成 <b>{{ m.plan }}</b></p>
            <p>实际完成 <b>{{ m.actual }}</b><em v-if="m.delta != null" class="ok">({{ m.delta }})</em></p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="safe-block">
    <h4>楼栋进度</h4>
    <div class="pg-list">
      <div v-for="b in buildings" :key="b.name" class="pg-card" :class="{ late: b.plan === '滞后' }">
        <div class="pg-hd">
          <strong>{{ b.name }}</strong>
          <span class="pg-bar"><i :style="{ width: pctOf(b) + '%' }"></i></span>
          <b>{{ b.done }}/{{ b.total }}F</b>
        </div>
      </div>
    </div>
  </div>
</template>
