<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { useUavStore } from '@/stores/uav'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 选择航线（2026-11 阶段 8：改真实航线）
 *
 * 原先是 `data/device.ts: uavRoutes` 里四条写死的航线（向阳村日常巡航 /
 * 塔吊巡查航线 / 作业面定点航线 / 场区环绕航线），点「下发执行」只弹一个
 * toast「已下发航线：xxx」—— **什么都没发**，是纯粹的假反馈。
 *
 * 现在航线来自 keehang 平台 `GET /task/list?recycle=0&deviceId={机库}&pid={项目}`
 * （实测本项目 15 条真实航线：向阳村-全景 / 安全巡检 / 塔吊定点 …）。
 *
 * ## 关于「下发执行」
 *
 * keehang **没有 REST 形式的航线下发端点**（实测 `/task/start`、`/task/exec/start`
 * 等均 404）。原厂 Unity 端是打开一个网页控制台
 * `https://iot.keehang.com/dashboard/#/control?st={token}`（见
 * `DroneAPIHelper.GetDashboardUrlAsync`），由那个页面去做下发。
 *
 * 所以这里**不假装能下发**：列出真实航线、显示选中那条的详情，
 * 并明确告诉用户「航线下发需在无人机平台操作」，并给出平台地址。
 * 保留一个假的「已下发」toast 是在骗现场调度 —— 那条航线真的不会飞。
 */
const uav = useUavStore()

onMounted(() => {
  if (!uav.routes.length) void uav.load()
})

const route = ref<number | null>(null)

const cur = computed(() => uav.routes.find((r) => r.id === route.value) ?? null)

/** 慢请求才显示骨架 */
const syncing = computed(() => uav.state === 'loading' && !uav.routes.length)
const showSkel = useSlowLoading(() => syncing.value)

/** 航线平台控制台地址（与 Unity 端 GetDashboardUrlAsync 一致） */
const DASHBOARD_URL = 'https://iot.keehang.com/dashboard/'
</script>

<template>
  <div>
    <p class="uav-lab">本项目的真实航线任务（keehang 平台）</p>

    <!-- 同步中：按 .uav-routes 行的结构铺灰条 -->
    <div v-if="syncing" class="uav-routes skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
      <div v-for="i in 4" :key="i" class="uav-route is-skel">
        <Skel w="70%" h="15px" />
        <Skel class="skel-mt" w="45%" h="12px" />
      </div>
    </div>

    <div v-else-if="uav.routes.length" class="uav-routes">
      <button
        v-for="r in uav.routes"
        :key="r.id"
        type="button"
        :class="{ on: route === r.id }"
        :aria-pressed="route === r.id"
        @click="route = r.id"
      >
        <strong>{{ r.name }}</strong>
        <span>{{ r.height !== null ? `飞行高度 ${r.height}m` : '高度未知' }}</span>
      </button>
    </div>

    <div v-else class="data-empty">
      <p>{{ uav.state === 'error' ? uav.error || '航线加载失败' : '暂无可用航线' }}</p>
    </div>

    <!--
      下发说明：不是「已下发」的假 toast，而是如实告知下发通道在哪。
      这条航线真要飞起来，得在 keehang 的控制台里操作 ——
      本页没有该能力，说清楚比糊弄过去强。
    -->
    <p class="uav-allow">
      {{
        cur
          ? `已选航线「${cur.name}」。航线下发需在无人机平台操作，本页不代为下发。`
          : '航线下发需在无人机平台操作，本页不代为下发。'
      }}
    </p>

    <a class="uav-send" :href="DASHBOARD_URL" target="_blank" rel="noopener">
      打开无人机平台
    </a>
  </div>
</template>
