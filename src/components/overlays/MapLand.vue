<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import HomeProgress from '@/components/ui/HomeProgress.vue'
import MapViewer from '@/components/ui/MapViewer.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { crewKpis } from '@/data/config'
import { useAlarmStore } from '@/stores/alarm'
import { useHomeStore } from '@/stores/home'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'

/**
 * 横屏地图全屏层
 *
 * 对应原 index.html:43-67 + openMapLand/closeMapLand（app.js:1701-1713）。
 *
 * 2026-10 改造：
 *   - 静态 <img> 换成 MapViewer（cover 铺满 + 缩放/拖拽/撒点 + 总览缩放）。
 *   - 落地原版规划但从未实现的底部 KPI 数据坞：
 *     DOM 结构按原版预留的 .land-dock/.land-kpis/.land-crew/.land-pair
 *     样式搭建（app.css:802-870），数据全部来自现有 store ——
 *     人员概况与安全面板同源（config.crewKpis）。
 * 2026-11 设计稿（gx2 换底图）：底图上只保留报警撒点，设施/楼栋撒点、
 *   楼栋信息卡与右侧「数据」收起开关整体下线（首页同步）。
 */
const shell = useShellStore()
const home = useHomeStore()
const alarm = useAlarmStore()
const subpage = useSubpageStore()

/**
 * 二维 / 三维视图切换（2026-10 版本同步 · 第二批）
 *
 * 两张底图不是同一张图的比例变换：三维图是透视渲染（1024×709），
 * 二维图是正射影像（1024×747），取景范围也不同。因此：
 *   · 报警点有各自一套坐标（Alarm.flat / Alarm.pin）。
 * 关闭地图时自动复位成三维，下次进来不会停在二维（与原版 closeMapLand 一致）。
 */
const flat = ref(false)

const MAP_SRC = {
  map: `${import.meta.env.BASE_URL}img/site-map.webp`,
  flat: `${import.meta.env.BASE_URL}img/site-flat.webp`,
} as const

const mapSrc = computed(() => (flat.value ? MAP_SRC.flat : MAP_SRC.map))

const alarmPins = computed(() => alarm.mapAlarms(flat.value ? 'flat' : 'pin'))

watch(
  () => shell.mapLandOpen,
  (open) => {
    if (!open) flat.value = false
  },
)

/** 报警撒点 → 先退出横屏地图，再进预警详情（原版 onAlarmPin 的顺序） */
function onAlarmPin(id: string): void {
  shell.closeMapLand()
  subpage.openAlarmDetail(id, false)
}

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

/** 无人机今日已完成作业数（2026-11 设计稿：卡片指标改成「作业任务 x/y」） */
const droneRuns = computed(() => home.siteEquip.find((d) => d.id === 'drone')?.jobs?.done ?? 0)
</script>

<template>
  <div
    class="map-land"
    id="mapLand"
    :class="{ open: shell.mapLandOpen, 'is-flat': flat }"
    :hidden="!shell.mapLandOpen"
    :aria-hidden="!shell.mapLandOpen"
  >
    <div class="map-land-stage">
      <!--
        fit=cover：底图铺满整屏（沉浸式，不再 contain 留黑边）。
        裁掉的边缘在 scale=1 时即可拖拽查看（clampPan 按「画布≥容器」放行平移）。
        allowZoomOut：缩放下限放开到整图完整可见（总览），先看全场再放大看局部。
      -->
      <!--
        未打开时挂起，与首页那份实例互斥（见 MapViewer 的 suspended）。
        该层是常驻 DOM（靠 .open 显隐），不挂起就等于第二个实例一直在跑。
      -->
      <MapViewer
        :alarms="alarmPins"
        :src="mapSrc"
        fit="cover"
        allow-zoom-out
        :suspended="!shell.mapLandOpen"
        @alarm="onAlarmPin"
      />
    </div>
    <div class="land-top">
      <div class="land-brand">
        <div class="land-project">向阳村项目智能建造管理平台</div>
        <HomeProgress />
      </div>
      <div class="land-actions">
        <!--
          二维 / 三维切换。原版是固定文案「二维地图」+ 高亮表示当前态，
          用户切过去以后看不出再点一次会回到三维；这里让文案跟着当前态走，
          按钮上写的永远是「点了会得到什么」。
        -->
        <button
          class="map-land-flat"
          id="btnMapFlat"
          type="button"
          :class="{ on: flat }"
          :aria-pressed="flat"
          @click="flat = !flat"
        >
          <SvgIcon name="map-flat" />
          {{ flat ? '三维地图' : '二维地图' }}
        </button>

        <button
          class="map-land-back"
          id="btnMapBack"
          type="button"
          aria-label="返回"
          @click="shell.closeMapLand()"
        >
          <SvgIcon name="back" />
        </button>
      </div>
    </div>

    <!-- 底部 KPI 数据坞（原版规划的 landKpis，样式 app.css:802-870 已预留）；
         数据坞常显 —— 2026-11 设计稿起移除右侧「数据」收起开关 -->
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
