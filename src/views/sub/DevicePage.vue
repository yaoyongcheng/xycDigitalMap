<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import Skel from '@/components/ui/Skel.vue'
import DeviceReport from '@/views/sub/DeviceReport.vue'
import { deviceSet } from '@/data/device'
import { useAuthStore } from '@/stores/auth'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useSubpageStore } from '@/stores/subpage'
import { useSlowLoading } from '@/utils/slowLoading'
import type { DeviceKind, DeviceUnit } from '@/types'

/**
 * 设备详情页（2026-11 设计稿 gx2 版同步，原 renderCrane 2081-2095 / renderLift 1442-1455）
 *
 * 智能塔机与智能电梯共用一份页面，机组来自设备台账接口（`:8084`），
 * 经 data/device.ts 的响应式登记表拿（`deviceSet(kind).units`）。
 * 顶部双页签：
 *   ① 设备实时状态 —— 机组卡片（名称 + 状态 + 设备信息按钮 + 台账四格）
 *   ② 作业报表     —— 日报/周报/月报（数据源 tsdb 未开放，当前是空态）
 *
 * **2026-11 第二轮**：卡片上的「今日吊次 / 今日吊重 / 当前吊重负荷条」全部删除。
 * 它们来自 tsdb 实时数据接口，该接口在当前部署上 404；台账只有静态属性
 * （高度、安检有效期、塔吊司机、质检报告状态），所以四格改为台账字段，
 * 没有的就不渲染 —— 不再用编造的 10 次 / 1.87t 充数。
 */
const props = defineProps<{ kind: DeviceKind }>()

const sheet = useBottomSheetStore()
const ledger = useDeviceLedgerStore()
const auth = useAuthStore()
const subpage = useSubpageStore()

const set = computed(() => deviceSet(props.kind))

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

/** 状态色调：工作中/在线 → ok，待机/停止 → wait，离线/其他 → off */
function tone(status: string): string {
  if (status === '工作中' || status === '在线') return 'is-ok'
  if (status === '待机' || status === '停止') return 'is-wait'
  return 'is-off'
}

/**
 * 实时卡的四格。
 *
 * 台账字段已经是「标签 + 已格式化文本」，这里直接用；一个字段都没有时
 * 给一格「台账信息」空提示，避免卡片中间塌成一条。塔机与电梯不再各写一套。
 */
function liveCells(u: DeviceUnit): [string, string][] {
  return u.cells.length ? u.cells : [['设备信息', '暂无台账字段']]
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
          </article>
        </div>
      </section>
    </template>

    <!-- ② 作业报表 -->
    <DeviceReport v-else :kind="kind" />
  </div>
</template>
