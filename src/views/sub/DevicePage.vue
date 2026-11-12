<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import Skel from '@/components/ui/Skel.vue'
import DeviceReport from '@/views/sub/DeviceReport.vue'
import { craneSnOf } from '@/data/craneSn'
import { deviceSet } from '@/data/device'
import { useAuthStore } from '@/stores/auth'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useCraneRealtimeStore } from '@/stores/craneRealtime'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useSubpageStore } from '@/stores/subpage'
import { loadPct } from '@/utils/craneLoad'
import { unitNo } from '@/utils/deviceLedger'
import { useSlowLoading } from '@/utils/slowLoading'
import type { CraneRealtime } from '@/api/craneRealtime'
import type { DeviceKind, DeviceUnit } from '@/types'

/**
 * 设备详情页（2026-11 设计稿 gx2 版同步，原 renderCrane 2081-2095 / renderLift 1442-1455）
 *
 * 智能塔机与智能电梯共用一份页面，机组来自设备台账接口（`:8084`），
 * 经 data/device.ts 的响应式登记表拿（`deviceSet(kind).units`）。
 * 顶部双页签：
 *   ① 设备实时状态 —— 机组卡片（名称 + 实时状态 + 设备信息按钮 + 四格 + 负荷条）
 *   ② 作业报表     —— 日报/周报/月报
 *
 * **塔机卡四格是「今日吊次 / 今日吊重 / 当前吊重 / 当前负荷」**，与 V2 客户端的
 * 塔机卡同源（`UIBottomCardCraneLv2`）：
 *   · 今日吊次、今日吊重 ← 塔机平台 `getWorkCycleInfoHis`（`api/towerCrane.ts`，
 *     逐台按 sn 汇总，见 `stores/deviceLedger.ts: craneDayBySn`）；
 *   · 当前吊重、当前负荷 ← MQTT 实时报文 `weight` / `weightRate`（`stores/craneRealtime.ts`）。
 *
 * 台账字段（高度、安检有效期…）不在卡面上，它们在「设备信息」弹层里 ——
 * 卡片是看今天干了多少活，弹层才是看设备档案。
 *
 * 电梯仍是台账四格：它的「今日累计人数/载重」在 IOT `EVENT_WORKDATA`，
 * 本项目 `status:11 权限不足`，没有源就不摆空指标。
 */
const props = defineProps<{ kind: DeviceKind }>()

const sheet = useBottomSheetStore()
const ledger = useDeviceLedgerStore()
const auth = useAuthStore()
const subpage = useSubpageStore()
const crane = useCraneRealtimeStore()

const set = computed(() => deviceSet(props.kind))

const isCrane = computed(() => props.kind === 'crane')

const pageTab = ref<'live' | 'report'>('live')

/** 慢请求才显示骨架：台账通常一两百毫秒就回来了，快请求不该闪灰条 */
const showSkel = useSlowLoading(() => !set.value.units.length && ledger.state === 'loading')

/** 切塔机 ↔ 电梯时回到实时页，避免停在电梯报表看塔机的空报表 */
watch(
  () => props.kind,
  () => {
    pageTab.value = 'live'
  },
)

/** 台账要 Bearer：直接深链进详情页时也要自己拉一次（首页可能没挂载过） */
onMounted(() => {
  if (auth.token) void ledger.load(auth.token)
})

/**
 * 实时通道：塔机卡片上的状态与「设备信息」弹层里的「当前状态」必须是同一个值。
 *
 * 弹层用的是 V2 `CraneModel.GetTowerState` 的四态（离线 / 待机 / 工作中 / 正在吊装），
 * 列表以前直接把台账 `status_text`（只会是「在线 / 离线」）贴上去 —— 于是同一台车
 * 卡片写「在线」、点开写「待机」，看起来像两个数据源在打架。现在两边都走
 * `crane.stateOf(sn)`，一个式子出结果。
 *
 * 订阅只在「塔机页 + 已登录」时开：未登录时列表本来就是空态，没必要挂一条
 * WebSocket 烧现场流量。离开页面（close() 会把 view 置 none，本组件被卸载）即断开。
 */
const wantRealtime = computed(() => isCrane.value && auth.isLoggedIn)

let subscribed = false
watch(
  wantRealtime,
  (want) => {
    if (want === subscribed) return
    subscribed = want
    if (want) crane.open()
    else crane.close()
  },
  { immediate: true },
)
onUnmounted(() => {
  if (!subscribed) return
  subscribed = false
  crane.close()
})

/**
 * 卡片状态文案。
 *
 * 塔机取实时四态；`stateOf` 返回 null 表示**通道整个没通**（线上 HTTPS 没有 WS 反代），
 * 这时才回落台账 `status_text` —— 与弹层同一口径，不把「我们看不到」写成「设备离线」。
 * 传统塔机5 没有平台编号，`stateOf(null)` 恒为「离线」，与弹层一致。
 */
function statusOf(u: DeviceUnit, sn: string | null): string {
  if (!isCrane.value) return u.status
  return crane.stateOf(sn) ?? u.status
}

/** 空值统一成「—」（不写 0、不写「暂无」） */
const DASH = '—'

/**
 * 塔机卡四格 —— 照 V2 卡片（`UIBottomCardCraneLv2`）的顺序与口径：
 *
 * | 格 | 来源 |
 * |---|---|
 * | 今日吊次 | 工作循环条数（`getWorkCycleInfoHis`，按这台车的 sn） |
 * | 今日吊重 | 当天循环 `weight` 累加（t） |
 * | 当前吊重 | 实时报文 `weight` |
 * | 当前负荷 | 实时报文 `weightRate`（归一见 `utils/craneLoad.ts`） |
 *
 * 后两格是**实时**的，25s 没有帧就过期成「—」—— 不留着最后一帧假装还在动。
 * 传统塔机5 没有 sn，四格全是「—」。
 */
function craneCells(sn: string | null, frame: CraneRealtime | null, pct: number | null): [string, string][] {
  const day = sn ? ledger.craneDayBySn[sn] : undefined
  return [
    ['今日吊次', day ? `${day.trips}次` : DASH],
    ['今日吊重', day && day.weight !== null ? `${day.weight.toFixed(2)}t` : DASH],
    ['当前吊重', frame ? `${frame.weight.toFixed(2)}t` : DASH],
    ['当前负荷', pct !== null ? `${pct}%` : DASH],
  ]
}

/**
 * 实时卡的四格。
 *
 * 台账字段已经是「标签 + 已格式化文本」，这里直接用；一个字段都没有时
 * 给一格「台账信息」空提示，避免卡片中间塌成一条。电梯仍走这套。
 */
function liveCells(u: DeviceUnit): [string, string][] {
  return u.cells.length ? u.cells : [['设备信息', '暂无台账字段']]
}

/**
 * 卡片模型：状态、四格、负荷条一次算完。
 *
 * 都放在一个 computed 里，是因为它们依赖同一份「有没有实时帧」的判断 ——
 * 分散成多个函数会让模板对每张卡各调用几遍 `crane.of()`。
 */
interface Card {
  u: DeviceUnit
  status: string
  cells: [string, string][]
  /** 负荷条百分比；null = 没有实时帧，不画条（「没有数据」不该画成「负荷为零」） */
  load: number | null
}

const cards = computed<Card[]>(() =>
  set.value.units.map((u) => {
    const sn = isCrane.value ? craneSnOf(unitNo(u.name)) : null
    const status = statusOf(u, sn)
    if (!isCrane.value) return { u, status, cells: liveCells(u), load: null }

    const frame = crane.of(sn)
    const pct = frame ? loadPct(frame.weightRate) : null
    return { u, status, cells: craneCells(sn, frame, pct), load: pct }
  }),
)

/** 状态色调：工作中/正在吊装/在线 → ok，待机/停止 → wait，离线/其他 → off */
function tone(status: string): string {
  if (status === '工作中' || status === '正在吊装' || status === '在线') return 'is-ok'
  if (status === '待机' || status === '停止') return 'is-wait'
  return 'is-off'
}

function retry(): void {
  if (auth.token) void ledger.load(auth.token, true)
}

function goLogin(): void {
  subpage.openLogin(`登录后可查看${set.value.title}运行状态`, { kind: 'device', device: props.kind })
}
</script>

<template>
  <div class="dev-page">
    <div class="uav-tabs dev-view-tabs">
      <button type="button" :class="{ on: pageTab === 'live' }" :aria-pressed="pageTab === 'live'" @click="pageTab = 'live'">设备实时状态</button>
      <button type="button" :class="{ on: pageTab === 'report' }" :aria-pressed="pageTab === 'report'" @click="pageTab = 'report'">作业报表</button>
    </div>

    <!-- 未登录：台账接口要 Bearer -->
    <div v-if="!auth.isLoggedIn" class="data-empty" data-empty="device">
      <p>登录后可查看{{ set.title }}运行状态</p>
      <button class="data-empty-btn" type="button" @click="goLogin">去登录</button>
    </div>

    <template v-else-if="pageTab === 'live'">
      <!-- 同步中：灰条铺在机组卡片的位置（卡头 + 台账四格），台账到手后原位回填 -->
      <section
        v-if="!set.units.length && ledger.state === 'loading'"
        class="dev-block skel-fade"
        :class="{ 'is-on': showSkel }"
        aria-busy="true"
      >
        <span class="sr-only" role="status">正在加载{{ set.title }}台账</span>
        <div class="dev-board" aria-hidden="true">
          <article v-for="i in 2" :key="i" class="dev-card">
            <div class="dev-card-hd">
              <strong>
                <Skel w="22px" h="22px" r="var(--r-6)" />
                <Skel w="66px" h="13px" />
                <Skel w="40px" h="18px" r="var(--r-pill)" />
              </strong>
              <Skel w="48px" h="12px" />
            </div>
            <div class="dev-card-grid">
              <div v-for="j in 4" :key="j">
                <Skel w="42px" h="10px" />
                <Skel class="skel-mt-sm" w="58px" h="13px" />
              </div>
            </div>
          </article>
        </div>
      </section>

      <!-- 失败 / 该类设备确实为 0 -->
      <div v-else-if="!set.units.length" class="data-empty" data-empty="device">
        <template v-if="ledger.state === 'error'">
          <p>{{ ledger.error || '设备台账加载失败' }}</p>
          <button class="data-empty-btn" type="button" @click="retry">重试</button>
        </template>
        <template v-else><p>台账中暂无{{ set.noun }}</p></template>
      </div>

      <section v-else class="dev-block fill-in">
        <div class="dev-board">
          <article v-for="c in cards" :key="c.u.id" class="dev-card">
            <div class="dev-card-hd">
              <strong>
                <SvgIcon :name="kind === 'crane' ? 'dev-crane' : 'dev-lift'" class="dev-mark" />
                <span>{{ c.u.name }}</span>
                <b class="dev-status" :class="tone(c.status)">{{ c.status }}</b>
              </strong>
              <button class="dev-link" type="button" @click="sheet.openDeviceInfo(kind, c.u.id)">
                设备信息
              </button>
            </div>

            <div class="dev-card-grid">
              <div v-for="[label, value] in c.cells" :key="label">
                <span>{{ label }}</span>
                <b :class="{ 'is-dash': value === DASH }">{{ value }}</b>
              </div>
            </div>

            <!-- 负荷条：有实时帧才画。没有数据时留空比画一条 0% 好 —— 后者读起来像「负荷为零」 -->
            <div v-if="c.load !== null" class="dev-load">
              <div class="dev-bar">
                <i :style="{ width: `${c.load}%` }"></i>
              </div>
            </div>
          </article>
        </div>
      </section>
    </template>

    <!-- ② 作业报表 -->
    <DeviceReport v-else :kind="kind" />
  </div>
</template>
