<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import DeviceReport from '@/views/sub/DeviceReport.vue'
import { deviceSet } from '@/data/device'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import type { DeviceKind, DeviceUnit } from '@/types'

/**
 * 设备详情页（2026-11 设计稿 gx2 版同步，原 renderCrane 2081-2095 / renderLift 1442-1455）
 *
 * 智能塔机与智能电梯共用一份页面，数据由 data/device.ts 的 deviceSet(kind) 提供。
 * 顶部双页签：
 *   ① 设备实时状态 —— 机组卡片（名称 + 状态 + 设备信息按钮 + 今日格 + 作业中的负荷条）
 *   ② 作业报表     —— 日报/周报/月报 + 结论 + 机队分台表 + 导出分享（DeviceReport.vue）
 *
 * 旧版的「当日作业统计」「历史作业分析」两块随设计稿改版移除（新版里它们的
 * 渲染函数只剩再刷 handler，没有初始渲染点，属于休眠代码）；历史明细改由
 * 设备信息弹层与报表承接。
 */
const props = defineProps<{ kind: DeviceKind }>()

const sheet = useBottomSheetStore()

const set = computed(() => deviceSet(props.kind))

const pageTab = ref<'live' | 'report'>('live')

/** 切塔机 ↔ 电梯时回到实时页，避免停在电梯报表看塔机的空报表 */
watch(
  () => props.kind,
  () => {
    pageTab.value = 'live'
  },
)

/** 状态色调：工作中/在线 → ok，待机/停止 → wait，离线 → off */
function tone(status: string): string {
  if (status === '工作中' || status === '在线') return 'is-ok'
  if (status === '待机' || status === '停止') return 'is-wait'
  return 'is-off'
}

/** 实时卡的两个今日格：塔机是吊次/吊重，电梯沿用当前状态四格 */
function liveCells(u: DeviceUnit): [string, string][] {
  if (props.kind === 'crane') {
    return [
      ['今日吊次', `${u.today.trips}次`],
      ['今日吊重', `${u.today.weight.toFixed(2)}t`],
    ]
  }
  return u.cells
}
</script>

<template>
  <div class="dev-page">
    <div class="uav-tabs dev-view-tabs">
      <button type="button" :class="{ on: pageTab === 'live' }" :aria-pressed="pageTab === 'live'" @click="pageTab = 'live'">设备实时状态</button>
      <button type="button" :class="{ on: pageTab === 'report' }" :aria-pressed="pageTab === 'report'" @click="pageTab = 'report'">作业报表</button>
    </div>

    <!-- ① 设备实时状态 -->
    <section v-if="pageTab === 'live'" class="dev-block">
      <div class="dev-board">
        <article v-for="u in set.units" :key="u.id" class="dev-card">
          <div class="dev-card-hd">
            <strong>
              <SvgIcon :name="kind === 'crane' ? 'dev-crane' : 'dev-lift'" class="dev-mark" />
              <span>{{ u.name }}</span>
              <b class="dev-status" :class="tone(u.status)">{{ u.status }}</b>
            </strong>
            <button class="dev-link" type="button" @click="sheet.openDeviceInfo(kind, u.id)">
              设备信息
            </button>
          </div>

          <div class="dev-card-grid">
            <div v-for="[label, value] in liveCells(u)" :key="label">
              <span>{{ label }}</span>
              <b>{{ value }}</b>
            </div>
          </div>

          <div v-if="u.live" class="dev-load">
            <div class="dev-load-hd">
              <span>当前吊重</span><b>{{ u.live.value }}</b>
              <span class="dev-load-rate">当前负荷</span><em>{{ u.live.pct }}%</em>
            </div>
            <div class="dev-bar"><i :style="{ width: u.live.pct + '%' }"></i></div>
          </div>
        </article>
      </div>
    </section>

    <!-- ② 作业报表 -->
    <DeviceReport v-else :kind="kind" />
  </div>
</template>
