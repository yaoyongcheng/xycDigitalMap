<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import MapViewer from '@/components/ui/MapViewer.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useSceneStore } from '@/stores/scene'
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
 * 两张底图不是同一张图的比例变换：三维图是斜视影像，二维图是正射影像，
 * 取景范围也不同。因此：
 *   · 报警点有各自一套坐标（Alarm.flat / Alarm.pin）。
 * 关闭地图时自动复位成三维，下次进来不会停在二维（与原版 closeMapLand 一致）。
 *
 * 2026-11-18 起两张底图都由场景截图接口动态给（`stores/scene`）：
 * 三维 = `type=3d`，二维 = `type=2d`。首页背景用的也是同一份三维图，
 * 所以 `load('3d')` 基本是命中缓存；二维只有在真的点了「二维地图」时才拉
 * （3.8MB 一张，没必要进全屏就先下）。
 *
 * 2026-11-24 补一条折中：进全屏后**延迟 1.5s 静默预热二维**，但只在本机
 * 已经有二维图时动手（`scene.warmUp`）—— 那种情况大概率只是一次 304，
 * 用户点「二维」就能一步到位。没看过二维的人不会被多下 3.8MB。
 */
const flat = ref(false)

const scene = useSceneStore()

/** 当前底图：接口图优先，取不到自动回落到内置的 site-map / site-flat */
const mapSrc = computed(() => scene.src(flat.value ? '2d' : '3d'))

const alarmPins = computed(() => alarm.mapAlarms(flat.value ? 'flat' : 'pin'))

/**
 * 切换中的目标态（`null` = 空闲）。
 *
 * 只有目标底图还没到手时才非空 —— 按钮据此进加载态并挡住重复点击。
 */
const switching = ref<null | boolean>(null)

/**
 * 二维 / 三维切换。
 *
 * ⚠️ 不能「先翻 flat 再去取图」：2D 有 3.8MB，翻得早的话 `scene.src('2d')`
 * 此刻还没有接口图，会先回落到打包的内置 `site-flat.webp`（那张是迁移前的
 * 旧正射图），等接口图下完再换一次 —— 用户看到的就是「旧地图闪一下、
 * 然后又跳一张」。所以这里等到目标图**有结论**（成功、未上传或失败）才翻：
 *   · 成功 → 一次切到接口图；
 *   · 未上传 / 失败 → 一次切到内置兜底图（虽然也是老图，但只出现一次，
 *     不会二次跳变）；
 *   · 等待期间旧图继续显示（清空只会让屏幕变黑），按钮写「加载中」。
 *
 * 报警点坐标与 `.is-flat` 样式跟着 flat 一起翻，保证撒点与画面永远同一张图。
 *
 * 2026-11-18 晚补一条：本机已落盘兜底图时，「有结论」不等于「一定去等接口」——
 * 兜底图就是上次接口那张，先切过去显示，同时后台再确认一次最新（`void load`）。
 * 接口回同一张，指纹相同、画面不动；回了新图，MapViewer 双缓冲平滑换掉。
 */
async function toggleFlat(): Promise<void> {
  if (switching.value !== null) return
  const next = !flat.value
  const type = next ? '2d' : '3d'

  // 图已经在手（接口图，或上次落盘的本地兜底图）→ 直接翻，一步到位。
  // 兜底图那条要顺手再问一次接口：取到同一张则画面一帧不动，取到新图才换，
  // 不能让「有缓存」把「看最新一张」这件事挡掉。
  if (scene.settled(type)) {
    flat.value = next
    void scene.load(type)
    return
  }

  switching.value = next
  try {
    await scene.load(type)
  } finally {
    switching.value = null
  }
  // 等待期间退出了全屏：closeMapLand 已把 flat 复位成三维，别再翻过去
  if (shell.mapLandOpen) flat.value = next
}

/**
 * 二维图的静默预热句柄（见上方 2026-11-24 那条说明）。
 *
 * 延迟 1.5s 是为了不和三维图 / 撒点抢带宽：用户刚打开全屏时最需要的是「立刻
 * 看到地图」，二维晚一点确认完全不影响观感。
 */
let warmTimer = 0

watch(
  () => shell.mapLandOpen,
  (open) => {
    window.clearTimeout(warmTimer)
    if (!open) {
      flat.value = false
      return
    }
    // 进全屏先确保三维图在手（首页已经取过时 store 直接返回，不重复请求）
    void scene.load('3d')
    warmTimer = window.setTimeout(() => {
      void scene.warmUp('2d')
    }, 1500)
  },
  // 本层是常驻 DOM、开局就挂载；若用户是在「地图已打开」的状态下才挂上这个
  // 组件（深链 / 单测直接 openMapLand 后再 mount），没有 immediate 就永远不取图
  { immediate: true },
)

onBeforeUnmount(() => {
  window.clearTimeout(warmTimer)
})

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
          :class="{ on: flat, 'is-busy': switching !== null }"
          :aria-pressed="flat"
          :aria-busy="switching !== null"
          :disabled="switching !== null"
          @click="toggleFlat"
        >
          <SvgIcon name="map-flat" />
          <!-- 等待期文案要变：否则用户以为没点上，会连点几下 -->
          <template v-if="switching !== null">{{ switching ? '二维加载中' : '三维加载中' }}</template>
          <template v-else>{{ flat ? '三维地图' : '二维地图' }}</template>
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
