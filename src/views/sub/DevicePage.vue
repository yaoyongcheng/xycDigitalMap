<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import Skel from '@/components/ui/Skel.vue'
import DeviceReport from '@/views/sub/DeviceReport.vue'
import { craneSnOf } from '@/data/craneSn'
import { LIFT_CAGES } from '@/data/liftSn'
import { deviceSet } from '@/data/device'
import { useAuthStore } from '@/stores/auth'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useCraneRealtimeStore } from '@/stores/craneRealtime'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useLiftStore } from '@/stores/lift'
import { useSubpageStore } from '@/stores/subpage'
import { loadPct } from '@/utils/craneLoad'
import { unitNo } from '@/utils/deviceLedger'
import { formatFloor, formatHeight, formatLoad, formatPeople } from '@/utils/lift'
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
 * **电梯卡四格是「当前楼层 / 当前高度 / 当前人数 / 当前载重」**，与设计稿
 * `renderLiftCard` 一致，数据来自 IOT 网关的 `EVENT_POST_ATTR` 工况帧
 * （`api/lift.ts`）。电梯按**轿厢**出卡（4 笼），台账按楼登记（2 行）——
 * 档案字段仍从所属那栋楼的行取，见 `data/liftSn.ts` 的 `building`。
 */
const props = defineProps<{ kind: DeviceKind }>()

const sheet = useBottomSheetStore()
const ledger = useDeviceLedgerStore()
const auth = useAuthStore()
const subpage = useSubpageStore()
const crane = useCraneRealtimeStore()
const lift = useLiftStore()

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
 * 电梯工况与今日作业走 IOT（项目级 ak/sk，免登录），进页面就取一次并**开始轮询**。
 *
 * 初版这里只取一次，理由是「工况帧几十秒才一条，轮询不划算」—— 那是帧的节奏，
 * 不是页面的期待：用户盯着「当前楼层 / 当前载重」，一帧卡十分钟不动就像坏了。
 * 现在按 10 秒一轮刷新（`stores/lift.ts` 的 `pollOnce`，在线/今日各自再节流），
 * 只在电梯页 + 标签页可见时跑；切到塔机页立刻停表，别让它在背后空转。
 */
watch(
  () => props.kind,
  (k) => {
    if (k !== 'lift') {
      lift.stopLive('device')
      return
    }
    void lift.refresh()
    lift.startLive('device')
  },
  { immediate: true },
)

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
  // 放最前：下面那条会提前 return，停表不能被它带走
  lift.stopLive('device')
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
    // 今日吊重：查询成功但当天一条带重量的循环都没有时写 0.00t（用户 2026-11-13
    // 要求）—— 「今天没吊」是个结论，横杠只该留给「没查到 / 没这台的编号」。
    ['今日吊重', !sn || !day ? DASH : `${(day.weight ?? 0).toFixed(2)}t`],
    ['当前吊重', frame ? `${frame.weight.toFixed(2)}t` : DASH],
    ['当前负荷', pct !== null ? `${pct}%` : DASH],
  ]
}

/**
 * 电梯卡四格 —— 照设计稿 gx2 的 `renderLiftCard`（`当前楼层 / 当前高度 /
 * 当前人数 / 当前载重`），数据来自 IOT 最新一帧工况（`EVENT_POST_ATTR`）。
 *
 * 台账字段（高度、安检有效期）**不在卡面上**：它们说的是设备档案，而这一屏
 * 回答的是「这台电梯现在在哪、载了多少」，与塔机卡同一套思路。
 *
 * 单位与小数位照 V2 `UIPanelElevator.UpdateRealtimeInfo`（楼层 `8F`、
 * 高度 `F1`、载重 `kg`、人数整数），格式化函数在 `utils/lift.ts`，
 * 弹层里那两段用的是同一套 —— 卡片和弹层对同一帧读数不该有两种写法。
 * （载重的 kg 是 V2 硬编码的单位，网关没有给换算说明；`status:11` 收回权限后
 * 也拿不到新样本复核，此处按 V2 的契约走。）
 *
 * 这一帧的时间会被带到卡片下方的小字里 —— 电梯静止时不发包，帧可能是几小时
 * 前的，不给时间就等于让人以为这是此刻的读数。
 */
function liftCells(sns: readonly string[]): { cells: [string, string][]; at: number | null } {
  const a = lift.attrOf(sns)
  return {
    cells: [
      ['当前楼层', formatFloor(a?.floor ?? null)],
      ['当前高度', formatHeight(a?.height ?? null)],
      ['当前人数', formatPeople(a?.people ?? null)],
      ['当前载重', formatLoad(a?.load ?? null)],
    ],
    at: a?.at ?? null,
  }
}

/** 工况帧时间 → `HH:mm`；拿不到就空串（不写「刚刚」这种假时间） */
function frameTime(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 卡片模型：状态、四格、负荷条一次算完。
 *
 * 都放在一个 computed 里，是因为它们依赖同一份「有没有实时帧」的判断 ——
 * 分散成多个函数会让模板对每张卡各调用几遍 `crane.of()`。
 */
interface Card {
  /** v-for 的 key（塔机用台账主键，电梯用轿厢 sn） */
  key: string
  /** 卡片标题 */
  name: string
  status: string
  cells: [string, string][]
  /** 负荷条百分比；null = 没有实时帧，不画条（「没有数据」不该画成「负荷为零」） */
  load: number | null
  /** 卡片底部一行小字（电梯用它标出工况帧的时间） */
  note?: string
  /** 「设备信息」弹层要的台账主键；null = 台账里没有对应档案，不渲染按钮 */
  infoId: string | null
  /** 「设备信息」弹层要的轿厢 sn（只有电梯有：档案按楼、读数按笼） */
  sn?: string
}

/**
 * 电梯：**按轿厢出 4 张卡**（V2 `UIViewElevatorLevel1.InitCards` 遍历的正是
 * `GetSceneDeviceSnList()` 那 4 个 sn，首页底部卡也是逐笼一张）。
 *
 * 台账只有 2 行（按楼登记），所以档案类字段（安检有效期、责任人）仍从
 * 所属那栋楼的台账行取 —— `data/liftSn.ts` 的 `building` 就是这条线。
 * 卡片标题用轿厢名（`智能电梯1-1`），「设备信息」弹层同时带台账主键（取档案）
 * 和轿厢 sn（取这一笼的读数）。
 */
const liftCards = computed<Card[]>(() =>
  LIFT_CAGES.map((c) => {
    const row = set.value.units.find((u) => unitNo(u.name) === c.building)
    // 逐笼按网关的在线事件判；连不上（没有在线数据）也按**离线** ——
    // 不回落台账 `status_text`：那是平台登记态，不随实时通断变化，拿它顶替
    // 就是「卡片说在线、每一格却是—」。用户 2026-11-13 明确要求连不上即离线。
    const status = lift.isOnline(c.sn) ? '在线' : '离线'
    const { cells, at } = liftCells([c.sn])
    return {
      key: c.sn,
      name: c.name,
      status,
      cells,
      load: null,
      note: at ? `${frameTime(at)} 工况帧` : '',
      infoId: row?.id ?? null,
      sn: c.sn,
    }
  }),
)

const cards = computed<Card[]>(() => {
  if (!isCrane.value) return liftCards.value
  return set.value.units.map((u) => {
    const sn = craneSnOf(unitNo(u.name))
    const status = statusOf(u, sn)
    const frame = crane.of(sn)
    const pct = frame ? loadPct(frame.weightRate) : null
    return {
      key: u.id,
      name: u.name,
      status,
      cells: craneCells(sn, frame, pct),
      load: pct,
      infoId: u.id,
    }
  })
})

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

/**
 * 网关凭证失效 —— 卡片还在（台账走 `:8084`，是好的），但每一格都是「—」。
 *
 * 只对电梯成立：其余设备的鉴权都用业务 Bearer，401 会由 `http.ts` 直接把用户
 * 带去登录页，不需要这里再提示一次。
 */
const needsRetry = computed(() => props.kind === 'lift' && lift.authLost)

/**
 * 换令牌那一跳根本没打通 —— 部署问题，不是凭证问题。
 *
 * 与 `needsRetry` 互斥（`liftGatewayUnreachable()` 里已经排掉 401）。要单独提示，
 * 是因为它的处置完全不同：点「重试」不会好，得去查 nginx 有没有 `/iot-api`
 * 那段 `proxy_pass`、或服务器能否访问 `iot.cscec3b-iti.com`。
 *
 * 以前这种情况页面只显示一排「—」，跟「电梯今天没数据」长得一模一样 ——
 * 现场部署一次就要排查半天，所以这条提示值一个位置。
 */
const gatewayLost = computed(() => props.kind === 'lift' && lift.gatewayUnreachable)

/**
 * 「重试」—— **不是**「重新登录」。
 *
 * 这一点踩过坑：之前这里写的是「重新登录」，但登录页换到的是 `:8081` 的
 * 业务 Bearer（账号 `xiangyangcun` 那套），而电梯用的是 IOT 云网关的项目级
 * ak/sk 换出来的 `X-APP-USER` 令牌 —— **两套凭证不同源，登录根本换不到它**。
 * 结果就是用户登录成功了、回来提示还在，看起来像登录没生效。
 *
 * 真正要做的只有一件事：把 IOT 缓存的旧令牌丢掉重换一张
 * （`stores/lift.ts` 的 `relogin()`，名字沿用但语义是「重取数据」）。
 */
function goRetry(): void {
  void lift.relogin()
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
      <!-- 换令牌那一跳没出去：多半是部署漏了 /iot-api 反代，点「重试」不管用也得给 -->
      <section v-if="gatewayLost" class="dev-auth is-warn" role="alert">
        <p>电梯网关没连上 —— 部署环境缺「/iot-api」反代，或服务器无法出网</p>
        <button class="dev-auth-btn" type="button" @click="goRetry">重试</button>
      </section>

      <!-- 凭证失效：台账是好的，所以卡片还在，只是每一格「—」。不说明白用户只能反复下拉 -->
      <section v-if="needsRetry" class="dev-auth" role="alert">
        <!--
          不写「重试可重新获取」：换令牌接口是幂等的，服务端没轮换之前重试确实
          拿不到，那是过度承诺。`gatewayStale` 为真时说明刚点过、网关还是老样子，
          换成一句更诚实的「还没恢复」。
        -->
        <p>{{ lift.gatewayStale ? '电梯物联网网关未恢复，请稍后再试' : '电梯物联网网关凭证失效，请稍后重试' }}</p>
        <button class="dev-auth-btn" type="button" @click="goRetry">重试</button>
      </section>

      <!-- 同步中：灰条铺在机组卡片的位置（卡头 + 台账四格），台账到手后原位回填 -->
      <section
        v-if="!set.units.length && ledger.state === 'loading'"
        class="dev-block skel-fade"
        :class="{ 'is-on': showSkel }"
        aria-busy="true"
      >
        <span class="sr-only" role="status">正在加载{{ set.title }}台账</span>
        <div class="dev-board" aria-hidden="true">
          <article v-for="i in 4" :key="i" class="dev-card">
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
          <article v-for="c in cards" :key="c.key" class="dev-card">
            <div class="dev-card-hd">
              <strong>
                <SvgIcon :name="kind === 'crane' ? 'dev-crane' : 'dev-lift'" class="dev-mark" />
                <span>{{ c.name }}</span>
                <b class="dev-status" :class="tone(c.status)">{{ c.status }}</b>
              </strong>
              <button
                v-if="c.infoId"
                class="dev-link"
                type="button"
                @click="sheet.openDeviceInfo(kind, c.infoId, c.sn)"
              >
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

            <!-- 电梯：标出四格取自哪一刻的工况帧（静止时不发包，帧可能已经几小时前） -->
            <p v-if="c.note" class="dev-note">{{ c.note }}</p>
          </article>
        </div>
      </section>
    </template>

    <!-- ② 作业报表 -->
    <DeviceReport v-else :kind="kind" />
  </div>
</template>
