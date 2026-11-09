<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import HomeProgress from '@/components/ui/HomeProgress.vue'
import MapViewer from '@/components/ui/MapViewer.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'

/**
 * 横屏地图全屏层
 *
 * 对应原 index.html:43-67 + openMapLand/closeMapLand（app.js:1701-1713）。
 *
 * 2026-10 改造：静态 <img> 换成 MapViewer（cover 铺满 + 缩放/拖拽/
 *   撒点 + 总览缩放）。
 * 2026-11 设计稿（gx2 换底图）：底图上只保留报警撒点，设施/楼栋撒点、
 *   楼栋信息卡、右侧「数据」收起开关与底部 KPI 数据坞整体下线，
 *   全屏层回归「纯地图 + 二维/三维切换」。
 */
const shell = useShellStore()
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
  map: `${import.meta.env.BASE_URL}img/site-map.webp?v=20261109`,
  flat: `${import.meta.env.BASE_URL}img/site-flat.webp?v=20261109`,
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
  </div>
</template>
