<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import LivePlayer from '@/components/ui/LivePlayer.vue'
import Skel from '@/components/ui/Skel.vue'
import { useAuthStore } from '@/stores/auth'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useUavStore } from '@/stores/uav'
import { DASH } from '@/utils/lift'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 无人机页（2026-11-13 按设计稿 gx2 重排）
 *
 * ## 四块照设计稿
 *
 * ① 实时监控：页签（无人机 / 机库）+ 画面区 + 五格实时读数
 * ② 任务管理：三格（今日任务 / 已完成 / 失败次数）+ 执行中任务的进度
 * ③ 设备参数：八格（状态 / 电量 / 距机库 / 续航 / 风速 / 网络质量 / 网络速率 / 电池温度）
 * ④ 任务下发：**二期**，当前只给「接入中，敬请期待」占位（用户 2026-11-13 定）
 *
 * ## 数据全部来自 keehang（与 V2 同一批接口）
 *
 * | 区块 | 接口 |
 * |---|---|
 * | 任务管理三格 | `/dashboard/task/list/record`（`taskCount/finishedCount/failedCount`） |
 * | 今日任务明细 | `/task/exec/list/record?start=今天&end=明天` |
 * | 飞行/机库读数 | `/dashboard/device/cache/telemetry/{无人机id}/1`、`{机库id}/2` |
 *
 * 2026-11-13 复盘发现：先前「风速 / 雨量 / 网络 / 距机库 / 剩余续航没有数据源」
 * 的结论是错的 —— 这些字段接口一直都有，是我们的解析只取了 9 个字段。
 * 现在设计稿那八格**全部有真数**，起飞校验也从「三项未知」变成真实判定。
 *
 * ## 三处必须说清楚的地方
 *
 * ① **实时画面已接通**（2026-11-13）。走的是 keehang 自建流媒体
 *    `live.keehang.com` 的 HTTP-FLV（`/live/stream/list` 直接给地址，
 *    与 V2 桌面端同一路流），不是萤石云 —— 之前那句「萤石云凭据失效」
 *    是错的：无人机画面从来不走萤石云。详见 `api/drone.ts` 的 `DroneLiveStream`。
 * ② **两个页签切的是两路流 + 两套读数**：无人机页签给机载遥测与机载画面，
 *    机库页签给机库遥测与机库摄像头。**有地址就先连**（`online` 只是 30s 快照，
 *    拿它当门禁会在起飞推流那半分钟里空窗）；连不上由播放器说「画面未开播」并
 *    每 20s 自动重连，不拿无人机画面顶替机库。
 * ③ **雨量口径未确认**。`rainfall` 实测为 1，同日机库湿度 99%，无法确认
 *    1 是「有雨」还是「无雨」，所以起飞条件按未知处理（不放行），
 *    并把原值写在原因里，等厂家确认口径再改判定。
 * ④ **任务下发是二期**。平台没有下发端点（keehang `/task/start` 404，原厂是网页
 *    控制台），这块只留「接入中，敬请期待」。条件校验仍在 store 里（有测试守着），
 *    二期接上直接用，但现在**不摆 UI** —— disabled 按钮点了没反应会被当 bug。
 */
const sheet = useBottomSheetStore()
const uav = useUavStore()
const auth = useAuthStore()

/** 画面来源：无人机实拍 / 机库 */
const tab = ref<'fly' | 'dock'>('fly')

/** 进度条要「随时间走」，30s 刷一次（同时遥测也在刷） */
const now = ref(Date.now())
let ticker: number | null = null

onMounted(() => {
  void uav.load()
  uav.startLive('uav-page')
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})

onBeforeUnmount(() => {
  uav.stopLive('uav-page')
  if (ticker !== null) window.clearInterval(ticker)
})

/** 登录态后到再补一次（keehang 是项目级凭据，但遥测没取到时也要补拉） */
watch(
  () => auth.token,
  (t) => {
    if (t && uav.state === 'idle') void uav.load()
  },
)

/** 慢请求才显示骨架：快请求直接出内容，不闪灰条 */
const syncing = computed(() => uav.state === 'loading' && !uav.records.length && !uav.stat)
const showSkel = useSlowLoading(() => syncing.value)

function pct(v: number | null): string {
  return v === null ? DASH : `${v}%`
}

/**
 * 米 → 整数米 / 一位小数公里。
 *
 * 两处用它，语义不同但都指「一段距离」：飞行参数的**累计里程**
 * （`totalFlightDistance`，实测 10809054.8 ≈ 10809.1km）与设备参数的
 * **当前距机库**（`homeDistance`，在库里是 0.01m 这种）。V2 面板把里程原样
 * 打成 `10808461.45m`，这里统一折成 km —— 同一个数，只是别让人读八位数。
 */
function dist(m: number | null): string {
  if (m === null) return DASH
  if (m < 1000) return `${Math.round(m)}m`
  return `${(m / 1000).toFixed(1)}km`
}

/** 秒 → 分钟（剩余续航；0 与 null 都写「—」，见下） */
function remain(sec: number | null): string {
  // 在地面时 `remainFlightTime` 恒为 0，与「电池真的只剩 0 分钟」区分不开。
  // 写「0分」会让人以为电量告急（电量格另有真数），所以按「—」处理。
  if (sec === null || sec <= 0) return DASH
  if (sec < 3600) return `${Math.round(sec / 60)}分`
  return `${(sec / 3600).toFixed(1)}h`
}

function speed(v: number | null): string {
  return v === null ? DASH : `${v.toFixed(1)}m/s`
}

/**
 * 「续航」为什么常看到「—」—— 给一句解释，别让人以为数据没接上。
 *
 * 飞控的 `remainFlightTime` 在**地面恒为 0**（实测：库里关机时电量 80%、
 * 该字段 0；起飞后同一字段给 1753s）。0 既可能是「没电了」也可能是
 * 「还没飞」，两种意思混在一个数里，所以一律显示「—」并在这里说明。
 * 只在「地面 + 读数为 0」时出现，飞行中不占版面。
 */
const remainNote = computed(() =>
  uav.live.remainFlight !== null && uav.live.remainFlight <= 0 && uav.live.onGround
    ? '续航取飞控的剩余飞行时间，飞机在地面时为 0，起飞后自动有值'
    : '',
)

const netRate = computed(() => {
  const r = uav.dockLive.networkRate
  return r === null ? DASH : `${r}kbps`
})

/**
 * 网络质量画成**五格递增信号**，亮几格由**网络速率**分档决定。
 *
 * 为什么不用厂家的 `networkQuality`：机库遥测里这个字段实测长期恒为 1
 * （连采 5 次，速率从 9kbps 变到 897kbps，它一步没动），画出来是死的 ——
 * 而 V2 底部栏那排格子是跟着速率一起变的。所以按速率分五档，颜色只留
 * 「够用（绿）/ 不够（红）」两级，与 V2 的 `signalSprites` 三档图标同义。
 *
 * 档位是本项目的展示分档（不冒充厂家等级）：≥800 满格、≥500 四格、
 * ≥300 三格、≥100 两格，其余一格；取不到 / 0 → null（页面写「—」，
 * 不画五条暗格冒充「有信号但很弱」）。
 */
const netBars = computed(() => {
  const r = uav.dockLive.networkRate
  if (r === null || r <= 0) return null
  if (r >= 800) return 5
  if (r >= 500) return 4
  if (r >= 300) return 3
  if (r >= 100) return 2
  return 1
})

/** 当前页签对应的那一路流 */
const streamNow = computed(() => (tab.value === 'fly' ? uav.droneStream : uav.dockStream))

/**
 * **只要有地址就挂播放器**，不等 `online` 变 true。
 *
 * `online` 是 30s 一次的快照：无人机起飞推流那一刻它还是 false，
 * 早先拿它当门禁，起飞后要等下一轮刷新才出画面 —— 那半分钟的空窗就是这么来的。
 * ZLM 对未推流的流是「挂着等」的，先连上去，推流一开始就在同一根连接上出数据。
 *
 * 连不上由 `LivePlayer` 自己收口（超时 → 未开播 → 自动重连），页面不重复判断。
 */
const hasStream = computed(() => !!streamNow.value?.flv)

/**
 * 播放器回报的真实状态：LIVE 角标只认 `playing`，别拿「有地址」冒充在播。
 * （状态枚举的权威定义在 `LivePlayer.vue`，这里按字符串比，不复制一份类型守卫。）
 */
const liveState = ref<string>('idle')

// 切页签 = 换一路流：旧状态立刻作废，否则会带着上一路的 LIVE 角标闪一下
watch(tab, () => {
  liveState.value = 'idle'
})

/** 完全没有地址时才走整块占位（地址在但没推流由播放器说「未开播」） */
const noStreamNote = computed(() =>
  tab.value === 'dock' ? '机库没有配置摄像头直播流' : '平台没有这台无人机的直播流',
)

/** 未开播时补的那句原因，各设备不同 */
const offAirHint = computed(() =>
  tab.value === 'dock'
    ? '机库摄像头在库待机时不推流，无人机出库作业时会自动出画面'
    : '无人机起飞推流后会自动出画面，不用手动刷新',
)

/**
 * 状态 = 厂家状态码的文案（`utils/uavState.ts`），与 V2 同一张表。
 *
 * 早先是「有执行中的任务就说作业中，否则停泊」—— 那是拿任务状态冒充飞机状态，
 * 在库里飞控断电时 V2 写「关机」、我们写「停泊」，对不上。
 */
const flyState = computed(() => uav.live.state)

/** 无人机是否在库（机库遥测的 droneOnlineStatus） */
const dockIn = computed(() => {
  const v = uav.dockLive.droneIn
  return v === null ? DASH : v ? '在库' : '出库'
})

/** 充电状态：厂家枚举只确认了 0 = 未充电，其它值原样说「充电中」 */
const chargeText = computed(() => {
  const v = uav.dockLive.chargeState
  if (v === null) return DASH
  return v === 0 ? '未充电' : '充电中'
})

/**
 * 执行中任务的进度：`(now − start) / (end − start)`。
 *
 * 设计稿那根进度条是写死的 62%。我们不编：用接口给的计划起止时间算，
 * 超出计划就停在 100%（不写 137% 这种吓人的数）。
 */
const runningPct = computed(() => {
  const r = uav.running
  if (!r || r.startAt === null || r.endAt === null || r.endAt <= r.startAt) return null
  const p = ((now.value - r.startAt) / (r.endAt - r.startAt)) * 100
  return Math.max(0, Math.min(100, Math.round(p)))
})

/** 阈值告警着色（告警值本身要看得出来） */
function toneOf(v: string, k: string): string {
  const n = Number.parseFloat(v)
  if (Number.isNaN(n)) return ''
  if (k === '电量' && n < 30) return 'is-low'
  if (k === '风速' && n > 8) return 'is-low'
  if (k === '电池温度' && (n > 45 || n < 0)) return 'is-low'
  if (k === '网络速率' && n < 500) return 'is-low'
  return ''
}

function retry(): void {
  void uav.load(true)
}
</script>

<template>
  <div class="dev-page">
    <!-- ① 实时监控 -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>实时监控</h4>
        <div class="dev-tabs is-compact">
          <button type="button" :class="{ on: tab === 'fly' }" :aria-pressed="tab === 'fly'" @click="tab = 'fly'">无人机</button>
          <button type="button" :class="{ on: tab === 'dock' }" :aria-pressed="tab === 'dock'" @click="tab = 'dock'">机库</button>
        </div>
      </div>

      <!--
        实时画面 = keehang 的 HTTP-FLV 直播（与 V2 同一路流，见 api/drone.ts）。
        有地址就先连（ZLM 会挂着等推流），连不上由播放器自己说原因；
        完全没有地址时才整块说明，不挂静态示意图 —— 示意图长得像现场画面，
        会被当成实时情况看。
      -->
      <div class="uav-stage" :class="{ 'is-wait': !hasStream }">
        <LivePlayer
          v-if="hasStream"
          :key="`${tab}-${streamNow?.id}`"
          :src="streamNow?.flv ?? null"
          :off-air-hint="offAirHint"
          @state="liveState = $event"
        />
        <span v-if="liveState === 'playing'" class="uav-live"><i></i>LIVE</span>

        <template v-if="!hasStream">
          <p>{{ tab === 'dock' ? '机库画面未开播' : '实时画面未开播' }}</p>
          <p class="uav-stage-sub">{{ noStreamNote }}</p>
        </template>
      </div>

      <!-- 无人机页签：飞行参数（设计稿五格） -->
      <div v-if="tab === 'fly'" class="uav-fly">
        <div><span>状态</span><b :class="{ 'is-down': uav.live.stateDown }">{{ flyState }}</b></div>
        <div><span>海拔</span><b>{{ uav.live.height !== null ? `${uav.live.height.toFixed(1)}m` : DASH }}</b></div>
        <div><span>飞行距离</span><b>{{ dist(uav.live.flightDistance) }}</b></div>
        <div><span>水平速度</span><b>{{ speed(uav.live.speed) }}</b></div>
        <div><span>垂直速度</span><b>{{ speed(uav.live.verticalSpeed) }}</b></div>
      </div>

      <!--
        机库页签：机库自己的读数。
        不由「无人机」代答 —— 两个设备各自上报告，混在一起分不清是谁的数据。
      -->
      <div v-else class="uav-fly">
        <div><span>无人机</span><b :class="{ 'is-ok': dockIn === '在库' }">{{ dockIn }}</b></div>
        <div><span>充电</span><b :class="{ 'is-ok': chargeText === '充电中' }">{{ chargeText }}</b></div>
        <div><span>舱内温度</span><b>{{ uav.dockLive.cabinTemp !== null ? `${uav.dockLive.cabinTemp}℃` : DASH }}</b></div>
        <div><span>环境湿度</span><b>{{ uav.dockLive.humidity !== null ? `${uav.dockLive.humidity}%` : DASH }}</b></div>
        <div><span>网络速率</span><b>{{ netRate }}</b></div>
      </div>
    </section>

    <!-- ② 任务管理 -->
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
        <!-- 三格来自 /dashboard/task/list/record；取不到写「—」，不拿本地条数冒充 -->
        <div><b :class="{ 'is-dash': uav.taskTotal === null }">{{ uav.taskTotal ?? DASH }}</b><span>今日任务</span></div>
        <div><b>{{ uav.taskDone ?? DASH }}</b><span>已完成</span></div>
        <div><b :class="{ 'is-low': (uav.taskFailed ?? 0) > 0 }">{{ uav.taskFailed ?? DASH }}</b><span>失败次数</span></div>
      </div>

      <div v-if="uav.running" class="uav-mission">
        <div class="uav-mission-hd">
          <strong>当前巡检 · {{ uav.running.name }}</strong>
          <em v-if="runningPct !== null">{{ runningPct }}%</em>
        </div>
        <div v-if="runningPct !== null" class="uav-bar" aria-hidden="true"><i :style="{ width: `${runningPct}%` }"></i></div>
        <p>
          {{ uav.running.time }} 起飞 · 任务执行中<template v-if="uav.running.planMin !== null"> · 计划 {{ uav.running.planMin }} 分钟</template>
        </p>
      </div>
      <div v-else-if="uav.state === 'error'" class="data-empty">
        <p>{{ uav.error || '无人机任务加载失败' }}</p>
        <button class="data-empty-btn" type="button" @click="retry">重试</button>
      </div>
      <div v-else-if="!syncing && uav.taskTotal === 0" class="data-empty">
        <p>今日暂无无人机任务</p>
      </div>
    </section>

    <!-- ③ 设备参数（设计稿八格，全部有源） -->
    <section class="dev-block">
      <h4>设备参数</h4>
      <div class="uav-stats">
        <div><b :class="{ 'is-down': uav.live.stateDown }">{{ flyState }}</b><span>状态</span></div>
        <div><b :class="toneOf(pct(uav.live.battery), '电量')">{{ pct(uav.live.battery) }}</b><span>电量</span></div>
        <div><b>{{ dist(uav.live.homeDistance) }}</b><span>距机库</span></div>
        <div><b>{{ remain(uav.live.remainFlight) }}</b><span>续航</span></div>
        <div><b :class="toneOf(speed(uav.windSpeed), '风速')">{{ speed(uav.windSpeed) }}</b><span>风速</span></div>
        <div>
          <b
            v-if="netBars !== null"
            class="uav-sig"
            :class="netBars >= 4 ? 'is-ok' : netBars === 3 ? 'is-mid' : 'is-weak'"
            role="img"
            :aria-label="`网络质量 ${netBars}/5，速率 ${netRate}`"
          ><i v-for="n in 5" :key="n" :class="{ 'is-on': n <= netBars }" /></b>
          <b v-else class="is-dash">{{ DASH }}</b>
          <span>网络质量</span>
        </div>
        <div><b class="is-long" :class="toneOf(netRate, '网络速率')">{{ netRate }}</b><span>网络速率</span></div>
        <div><b :class="toneOf(uav.live.temp !== null ? `${uav.live.temp}℃` : DASH, '电池温度')">
          {{ uav.live.temp !== null ? `${uav.live.temp}℃` : DASH }}
        </b><span>电池温度</span></div>
      </div>

      <!-- 地面时续航为 0（不是没数据），一句话说清，不占飞行中的版面 -->
      <p v-if="remainNote" class="uav-note">{{ remainNote }}</p>
    </section>

    <!-- ④ 任务下发（二期占位） -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>任务下发</h4>
      </div>
      <div class="uav-soon">
        <b>接入中，敬请期待</b>
        <p>航线下发要走原厂控制台通道，平台没有对应接口；目前只做任务与航线只读，二期接入。</p>
      </div>
    </section>
  </div>
</template>
