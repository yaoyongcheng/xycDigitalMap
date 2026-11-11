<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useUavStore } from '@/stores/uav'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 无人机页（2026-11 阶段 8：改真实数据）
 *
 * 结构沿用 2026-10 版本同步的原版设计稿（实时监控 / 任务管理 / 设备参数 / 任务下发），
 * 但**数据全部换成 keehang 平台的真实接口**（见 `stores/uav.ts`）：
 *
 *   · 任务管理 → `GET /task/exec/list/record`
 *     实测本项目今天有「向阳村-安全巡检」等真实执行记录。
 *   · 设备参数 → `GET /dashboard/device/cache/telemetry/{id}/1`
 *     实测电量 88%、电池温度 29.3℃。
 *
 * 三个必须说清楚的地方：
 *
 *  ① **实时画面仍是占位**。萤石云 appKey 已失效（实测 `code:-1`），
 *     keehang 的直播流需要另一套鉴权且尚未验证，所以画面区明说
 *     「实时视频流未接入」，不再挂一张静态示意图当直播画面。
 *  ② **起飞条件缺数据就不放行**。风速 / 雨量 / 网络速率三个指标
 *     遥测接口没有提供，按「未知」处理，任务下发按钮保持禁用并写明原因 ——
 *     把「没数据」当成「条件满足」是放松安全门的方向。
 *  ③ **取不到就空态**。接口失败给原因与重试，不回落到演示数字。
 */
const sheet = useBottomSheetStore()
const uav = useUavStore()

/** 画面来源：无人机实拍 / 机库 */
const tab = ref<'fly' | 'dock'>('fly')

onMounted(() => {
  void uav.load()
})

/** 慢请求才显示骨架：快请求直接出内容，不闪灰条 */
const syncing = computed(() => uav.state === 'loading' && !uav.records.length)
const showSkel = useSlowLoading(() => syncing.value)

/** 设备参数八格（网络质量单独渲染成信号格；取不到的项显示「—」） */
const stats = computed(() => {
  const l = uav.live
  return [
    { v: uav.running ? '作业中' : '空闲', k: '状态' },
    { v: l.battery !== null ? `${l.battery}%` : '—', k: '电量' },
    { v: l.altitude !== null ? `${l.altitude}m` : '—', k: '相对高度' },
    { v: l.speed !== null ? `${l.speed}m/s` : '—', k: '水平速度' },
    { v: l.verticalSpeed !== null ? `${l.verticalSpeed}m/s` : '—', k: '垂直速度' },
    { v: l.heading !== null ? `${l.heading}°` : '—', k: '航向角' },
    { v: l.temp !== null ? `${l.temp}℃` : '—', k: '电池温度' },
    { v: '', k: '网络质量' },
  ]
})

/** 阈值告警着色（告警值本身要看得出来） */
function toneOf(v: string, k: string): string {
  const n = Number.parseFloat(v)
  if (Number.isNaN(n)) return ''
  if (k === '电量' && n < 30) return 'is-low'
  if (k === '水平速度' && n > 12) return 'is-low'
  if (k === '电池温度' && (n > 45 || n < 0)) return 'is-low'
  return ''
}

function retry(): void {
  void uav.load(true)
}
</script>

<template>
  <div class="dev-page">
    <!-- 实时监控 -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>实时监控</h4>
        <div class="dev-tabs is-compact">
          <button type="button" :class="{ on: tab === 'fly' }" :aria-pressed="tab === 'fly'" @click="tab = 'fly'">无人机</button>
          <button type="button" :class="{ on: tab === 'dock' }" :aria-pressed="tab === 'dock'" @click="tab = 'dock'">机库</button>
        </div>
      </div>

      <!--
        实时视频流未接入（萤石云凭据失效、keehang 直播流未验证）。
        这里明说原因，不挂静态示意图当直播画面 —— 示意图长得像现场画面，
        会被当成实时情况看。
      -->
      <div class="uav-stage is-wait">
        <span class="uav-spin" aria-hidden="true"></span>
        <p>实时视频流未接入</p>
        <p class="uav-stage-sub">萤石云凭据已失效，直播地址暂不可用</p>
      </div>

      <div class="uav-fly">
        <div><span>经度</span><b>{{ uav.live.lng ?? '—' }}</b></div>
        <div><span>纬度</span><b>{{ uav.live.lat ?? '—' }}</b></div>
        <div><span>相对高度</span><b>{{ uav.live.altitude !== null ? `${uav.live.altitude}m` : '—' }}</b></div>
        <div><span>水平速度</span><b>{{ uav.live.speed !== null ? `${uav.live.speed} m/s` : '—' }}</b></div>
        <div><span>垂直速度</span><b>{{ uav.live.verticalSpeed !== null ? `${uav.live.verticalSpeed} m/s` : '—' }}</b></div>
      </div>
    </section>

    <!-- 任务管理 -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>任务管理</h4>
        <button class="dev-link" type="button" @click="sheet.openUavToday()">查看今日任务</button>
      </div>

      <!-- 同步中：灰条与统计卡同构，先占位不闪 -->
      <div v-if="syncing" class="uav-stats skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <div v-for="i in 3" :key="i">
          <Skel w="40px" h="24px" r="var(--r-6)" />
          <Skel class="skel-mt" w="56px" h="12px" />
        </div>
      </div>
      <div v-else class="uav-stats">
        <div><b>{{ uav.totalCount }}</b><span>今日任务</span></div>
        <div><b>{{ uav.doneCount }}</b><span>已完成任务</span></div>
        <div><b>{{ uav.risks.length }}</b><span>未达标项</span></div>
      </div>

      <div v-if="uav.running" class="uav-mission">
        <div class="uav-mission-hd"><strong>当前巡检 · {{ uav.running.name }}</strong></div>
        <p>{{ uav.running.time }} 起飞 · 任务执行中</p>
      </div>
      <div v-else-if="uav.state === 'error'" class="data-empty">
        <p>{{ uav.error || '无人机任务加载失败' }}</p>
        <button class="data-empty-btn" type="button" @click="retry">重试</button>
      </div>
      <div v-else-if="!syncing && !uav.totalCount" class="data-empty">
        <p>今日暂无无人机任务</p>
      </div>
    </section>

    <!-- 设备参数 -->
    <section class="dev-block">
      <h4>设备参数</h4>
      <div class="uav-stats">
        <div v-for="s in stats" :key="s.k">
          <b v-if="s.k === '网络质量'" class="uav-sig" aria-label="网络质量数据未接入"><i></i><i></i><i></i><i></i></b>
          <b v-else :class="toneOf(s.v, s.k)">{{ s.v }}</b>
          <span>{{ s.k }}</span>
        </div>
      </div>
    </section>

    <!-- 任务下发 -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>任务下发</h4>
        <em class="uav-gate" :class="{ 'is-bad': !uav.canDispatch }">{{ uav.canDispatch ? '可下发' : '不可下发' }}</em>
      </div>

      <p class="uav-allow">{{ uav.dispatchNote }}</p>

      <ul v-if="uav.risks.length" class="uav-risks">
        <li v-for="r in uav.risks" :key="r.name">{{ r.name }}{{ r.risk }}</li>
      </ul>
      <ul v-if="uav.unknowns.length" class="uav-risks">
        <li v-for="r in uav.unknowns" :key="r.name">{{ r.name }}：{{ r.risk }}</li>
      </ul>

      <button class="uav-send" type="button" :disabled="!uav.canDispatch" @click="sheet.openUavRoute()">
        选择航线
      </button>
    </section>
  </div>
</template>
