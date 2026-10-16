<script setup lang="ts">
import HomeProgress from '@/components/ui/HomeProgress.vue'
import MapViewer from '@/components/ui/MapViewer.vue'
import { mapPoints } from '@/data/config'
import { useCamStore } from '@/stores/cam'
import { useHomeStore } from '@/stores/home'
import { useShellStore } from '@/stores/shell'
import type { MapPoint } from '@/types'

/**
 * 横屏地图全屏层
 *
 * 对应原 index.html:43-67 + openMapLand/closeMapLand（app.js:1701-1713）。
 *
 * 2026-10 改造：静态 <img> 换成 MapViewer（contain 适配 + 缩放/拖拽/撒点），
 * 点位点击行为与首页一致（cam/crane 开监控，building 弹进度摘要）。
 *
 * 注：原版此层还规划了侧栏/KPI/分页/撒点，但从未实现
 * （startLandKpis 零调用，级联导致 12 个函数不可达；DOM 目标
 * #landEqCard/#landQaCard/#landPgList/#landPgDots 在 HTML 中不存在）。
 * 依据迁移方案的死代码清单，这些不迁移 —— 撒点能力由 MapViewer 以新形态补齐。
 */
const shell = useShellStore()
const cam = useCamStore()
const home = useHomeStore()

function onMapPoint(p: MapPoint): void {
  if ((p.kind === 'cam' || p.kind === 'crane') && p.camId) {
    // 先退出横屏地图再开监控：cam.openCam 的 setCamLand(false) 会无条件
    // 清掉 .phone 的横屏态（原版既存行为），若留着 mapLand 打开，
    // 关闭监控后会看到一个失了横屏布局的地图层。
    shell.closeMapLand()
    // 登记返回约定：监控返回键关闭播放器后重新回到全屏地图。
    // 必须在 closeMapLand 之后写（它会清标记）。
    shell.mapLandReturn = true
    cam.openCam(p.camId)
    return
  }
  if (p.kind === 'building') {
    const b = home.siteBuildings.find((x) => x.name === p.name)
    shell.showToast(b ? `${b.name}：已建 ${b.done}/${b.total}F · 进度达标率 ${b.rate}%` : p.name)
  }
}
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
      <!--
        fit=cover：底图铺满整屏（沉浸式，不再 contain 留黑边）。
        裁掉的边缘在 scale=1 时即可拖拽查看（clampPan 按「画布≥容器」放行平移）。
        allowZoomOut：缩放下限放开到整图完整可见（总览），先看全场再放大看局部。
      -->
      <MapViewer :points="mapPoints" fit="cover" allow-zoom-out @select="onMapPoint" />
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
