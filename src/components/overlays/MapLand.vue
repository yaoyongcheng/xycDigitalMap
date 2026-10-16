<script setup lang="ts">
import { computed, ref } from 'vue'

import HomeProgress from '@/components/ui/HomeProgress.vue'
import MapInfoCard from '@/components/ui/MapInfoCard.vue'
import MapViewer from '@/components/ui/MapViewer.vue'
import { crewKpis, mapPoints } from '@/data/config'
import { useAlarmStore } from '@/stores/alarm'
import { useCamStore } from '@/stores/cam'
import { useHomeStore } from '@/stores/home'
import { useShellStore } from '@/stores/shell'
import type { Building, MapPoint } from '@/types'

/**
 * 横屏地图全屏层
 *
 * 对应原 index.html:43-67 + openMapLand/closeMapLand（app.js:1701-1713）。
 *
 * 2026-10 改造：
 *   - 静态 <img> 换成 MapViewer（cover 铺满 + 缩放/拖拽/撒点 + 总览缩放），
 *     点位点击行为与首页一致（cam/crane 开监控，building 弹信息卡）。
 *   - 落地原版规划但从未实现的底部 KPI 数据坞与右侧开关列：
 *     DOM 结构按原版预留的 .land-dock/.land-kpis/.land-crew/.land-pair/
 *     .land-side/.land-side-btn 样式搭建（app.css:735-870），数据全部
 *     来自现有 store —— 人员概况与安全面板同源（config.crewKpis）。
 */
const shell = useShellStore()
const cam = useCamStore()
const home = useHomeStore()
const alarm = useAlarmStore()

/**
 * KPI 数据坞开关（原版规划的 #btnLandKpi / .kpis-off 状态）。
 * 竖屏下卡片改为横向滑动（CSS portrait 媒体查询），高度只有约
 * 一半屏盒，不再默认收起；任何朝向都可点「数据」手动收起。
 */
const kpisOff = ref(false)

/** 楼栋信息卡（撒点点击弹出） */
const infoBuilding = ref<Building | null>(null)

/** 设备在线统计：siteEquip 全部机组 的 on 汇总 */
const equipStat = computed(() => {
  let on = 0
  let total = 0
  for (const d of home.siteEquip) {
    total += d.units.length
    on += d.units.filter((u) => u.on).length
  }
  return { on, off: total - on, total }
})

/** 楼栋平均达标率（siteBuildings.rate 的均值） */
const avgRate = computed(() =>
  Math.round(home.siteBuildings.reduce((s, b) => s + b.rate, 0) / home.siteBuildings.length),
)

/** 无人机今日作业次数（siteEquip 中 drone 机组的演示值） */
const droneRuns = computed(() => Number.parseInt(home.siteEquip.find((d) => d.id === 'drone')?.value ?? '0', 10))

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
    infoBuilding.value = home.siteBuildings.find((x) => x.name === p.name) ?? null
  }
}
</script>

<template>
  <div
    class="map-land"
    id="mapLand"
    :class="{ open: shell.mapLandOpen, 'kpis-off': kpisOff }"
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
      <MapInfoCard :building="infoBuilding" @close="infoBuilding = null" />
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

    <!-- 右侧开关列（原版规划，.land-side 样式已预留） -->
    <div class="land-side">
      <button
        class="land-side-btn"
        id="btnLandKpi"
        type="button"
        :aria-pressed="kpisOff"
        @click="kpisOff = !kpisOff"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V9M10 19V4M16 19v-7M21 19H3"/></svg>
        <span>数据</span>
      </button>
    </div>

    <!-- 底部 KPI 数据坞（原版规划的 landKpis，样式 app.css:802-870 已预留） -->
    <div class="land-dock">
      <!-- 横屏：4 张分组卡片 -->
      <div class="land-kpis">
        <div class="land-kpi">
          <h5>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M5.5 19.5c1.2-3.2 3.6-4.7 6.5-4.7s5.3 1.5 6.5 4.7"/></svg>
            人员概况
          </h5>
          <div class="land-crew">
            <div v-for="[v, unit, name] in crewKpis" :key="name">
              <b>{{ v }}<em>{{ unit }}</em></b>
              <span>{{ name }}</span>
            </div>
          </div>
        </div>

        <div class="land-kpi">
          <h5>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 21 19H3z"/><path d="M12 10v4M12 16.6v.4"/></svg>
            预警监控
          </h5>
          <div class="land-pair">
            <div><b class="danger">{{ alarm.latest.length }}</b><span>今日预警</span></div>
            <div><b class="ok">{{ droneRuns }}次</b><span>无人机巡检</span></div>
          </div>
        </div>

        <div class="land-kpi">
          <h5>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><path d="M7 13v7M17 13v7M4 16.5h7M13 16.5h7"/></svg>
            设备管控
          </h5>
          <div class="land-pair three">
            <div><b class="ok">{{ equipStat.on }}</b><span>在线</span></div>
            <div><b class="off">{{ equipStat.off }}</b><span>离线</span></div>
            <div><b>{{ equipStat.total }}</b><span>机组</span></div>
          </div>
        </div>

        <div class="land-kpi">
          <h5>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.2l3 1.6"/></svg>
            楼栋进度
          </h5>
          <div class="land-pair">
            <div><b>{{ home.siteBuildings.length }}<em>栋</em></b><span>在建楼栋</span></div>
            <div><b class="warn">{{ avgRate }}<em>%</em></b><span>平均达标</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
