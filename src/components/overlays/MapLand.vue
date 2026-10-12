<script setup lang="ts">
import HomeProgress from '@/components/ui/HomeProgress.vue'
import { useShellStore } from '@/stores/shell'

/**
 * 横屏地图全屏层
 *
 * 对应原 index.html:43-67 + openMapLand/closeMapLand（app.js:1701-1713）。
 *
 * 注：原版此层还规划了侧栏/KPI/分页/撒点，但从未实现
 * （startLandKpis 零调用，级联导致 12 个函数不可达；DOM 目标
 * #landEqCard/#landQaCard/#landPgList/#landPgDots 在 HTML 中不存在）。
 * 依据迁移方案的死代码清单，这些不迁移。
 */
const shell = useShellStore()
</script>

<template>
  <div
    class="map-land"
    id="mapLand"
    :class="{ open: shell.mapLandOpen }"
    :hidden="!shell.mapLandOpen"
    :aria-hidden="!shell.mapLandOpen"
  >
    <div class="map-land-stage">
      <div class="map-land-fit">
        <img src="/img/site-map.jpg" alt="工地数字地图" />
      </div>
    </div>
    <div class="land-top">
      <div class="land-brand">
        <div class="land-project">向阳村项目智能建造管理平台</div>
        <HomeProgress />
      </div>
      <div class="land-actions">
        <button class="map-land-back" id="btnMapBack" type="button" @click="shell.closeMapLand()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 8 12l7 7"/></svg>
          返回
        </button>
      </div>
    </div>
  </div>
</template>
