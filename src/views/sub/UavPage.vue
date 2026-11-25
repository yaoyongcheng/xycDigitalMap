<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import LivePlayer from '@/components/ui/LivePlayer.vue'
import Skel from '@/components/ui/Skel.vue'
import { useAuthStore } from '@/stores/auth'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useUavStore } from '@/stores/uav'
import { DASH } from '@/utils/lift'
import { useMissionClock } from '@/utils/missionClock'
import { useSlowLoading } from '@/utils/slowLoading'
import { useStreamHold } from '@/utils/streamHold'
import { missionLine, missionProgress } from '@/utils/uavProgress'

/**
 * 无人机页（2026-11-13 按设计稿 gx2 重排）
 *
 * ## 四块照设计稿（2026-11-23 按现场要求删了两块）
 *
 * ① 实时监控：页签（只剩「无人机」，机库页签已删）+ 画面区
 * ② 任务管理：三格（今日任务 / 已完成 / 失败次数，**只算本项目**）+ 执行中任务的进度
 * ③ 设备参数：八格（状态 / 电量 / 距机库 / 续航 / 风速 / 网络质量 / 网络速率 / 电池温度）
 * ④ 任务下发：**二期**，当前只给「接入中，敬请期待」占位（用户 2026-11-13 定）
 *
 * 2026-11-23 下线的两处：飞行参数七格（状态/海拔/飞行距离/两向速度/翻滚角/偏航角）
 * 整块撤掉；「机库」页签撤掉，机库那套读数（无人机在库、充电、舱温、湿度、网速）
 * 随之不再展示。遥测数据本身仍在 store 里刷新，设备参数那几格照旧。
 *
 * ## 数据全部来自 keehang（与 V2 同一批接口）
 *
 * | 区块 | 接口 |
 * |---|---|
 * | 任务管理三格 | `/dashboard/task/list/record?pid=本项目`（`taskCount/finishedCount/failedCount`） |
 * | 今日任务明细 | `/task/exec/list/record?pid=本项目&start=今天&end=明天` |
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
 * ② **画面与读数只认无人机这一路**（2026-11-23 删掉机库页签后）：机库摄像头的流
 *    与读数都不再上屏。门禁是「有没有执行中的起飞任务」（2026-11-24 用户要求）：
 *    没有任务时**不挂播放器、不连流、不排队重连**（那时本来就没有推流，重连只是
 *    白烧流量和电），画面区改说「当前无正在执行的任务，无视频画面」；有任务时才
 *    **有地址就先连**（`online` 只是 30s 快照，拿它当门禁会在起飞推流那半分钟里
 *    空窗），连不上由播放器说「画面未开播」并每 20s 自动重连。
 *    任务结束**留 2 分钟宽限**（`STREAM_HOLD_MS`）再卸载：飞机收尾往往还在推最后
 *    几秒，按 `running` 立刻切会「活生生断在半空」，落地那一下看不到。
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

/**
 * 画面来源。
 *
 * 2026-11-23 用户要求删掉「机库」页签，所以这里恒为 `'fly'` —— 状态与
 * `streamNow` / 播放器 key 的写法一并保留：两路流的结构没拆，将来若要把
 * 机库页签加回来，只需要补一个按钮，其余代码不用动。
 */
const tab = ref<'fly' | 'dock'>('fly')

/**
 * 进度条的时间源 —— **与首页卡片共用同一个时钟**（`utils/missionClock.ts`）。
 *
 * 这里原先自己 `ref(Date.now())` + 一条 30s `setInterval`，与首页那条的相位
 * 由各自挂载时刻决定，同一条任务在两处能差近一拍：现场就是首页 50%、
 * 进这一页 61%。现在两处读同一个 `now`，切页面不会再跳数。
 */
const now = useMissionClock()

onMounted(() => {
  void uav.load()
  uav.startLive('uav-page')
})

onBeforeUnmount(() => {
  uav.stopLive('uav-page')
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
 * 现在只有设备参数的**当前距机库**在用它（`homeDistance`，在库里是 0.01m 这种）。
 * 原先飞行参数的累计里程（`totalFlightDistance`，实测 10809054.8 ≈ 10809.1km）
 * 也走这里，2026-11-23 那一段读数整块下线后只剩这一处 —— 函数本身没动，
 * 别再写回「10808461.45m」那种八位数。
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

/**
 * 风速 → `Nm/s`（**整数**，与 V2 一致）
 *
 * V2 弹层那句是 `txtWindSpeed.text = dockNet.wind_speed + "m/s"`
 * （`UIDronePop.cs:189`），而 `wind_speed` 在它的模型里声明成 `int`
 * —— 所以 V2 面板上从来没有小数位。我们这边天气站给的是 2.6 / 1.2 这种，
 * 写一位小数并排一看就「对不齐」，这里按 V2 的渲染取整。
 *
 * 水平 / 垂直速度仍保留一位小数（那是飞控的速度，V2 面板也带小数）。
 */
function wind(v: number | null): string {
  return v === null ? DASH : `${Math.round(v)}m/s`
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
 * **有没有正在执行的起飞任务** —— 实时画面的总开关（2026-11-24 用户要求）。
 *
 * 没有任务时无人机根本不推流，此时去连流只会一直「挂着等」到超时、
 * 再每 20s 重连一次，白白烧流量和电；而画面区还摆一个「重试」按钮，
 * 更像是平台出了问题。所以门禁改成任务状态，而不是「有没有地址」：
 *
 * · `false` → 播放器**不挂载**（卸载即 `teardown()` + `seq++`，重连定时器
 *   一并清掉，见 `LivePlayer.vue` 的 `onBeforeUnmount`），画面区说明原因；
 * · `true`  → 回到原来的逻辑：有地址就先连、连不上由播放器自己收口。
 *
 * 用 `running`（只认本项目、`status === 1` 执行中）而不是「今日有没有任务」：
 * 已排班未起飞、已完成的架次都不推流，挂上去就是空转。
 */
const missionOn = computed(() => uav.running !== null)

/**
 * 任务结束后的**宽限窗口**（2 分钟，2026-11-24）。
 *
 * 服务端把架次标成「已完成」的那一刻，飞机往往还在推最后几秒（落地、回库、
 * 云台回中）。按 `running` 立刻卸载播放器，现场就是「画面活生生被切断」。
 * 宽限窗口内 `streamOn` 仍为真：播放器不卸载、`LIVE` 角标不摘、断流重连照旧；
 * 到点自动卸载，回到「当前无正在执行的任务，无视频画面」。
 *
 * 规则本体在 `utils/streamHold.ts`（可单测）：状态只在「跑过 → 结束」时开窗，
 * 页面初开时没有任务不算「刚结束」；到期判据是共享时钟 `now`，不另开定时器。
 */
const { on: streamOn, minutes: holdMinutes } = useStreamHold(missionOn, now)

/**
 * 有任务 + 有地址才挂播放器。
 *
 * `online` 是 30s 一次的快照：无人机起飞推流那一刻它还是 false，
 * 早先拿它当门禁，起飞后要等下一轮刷新才出画面 —— 那半分钟的空窗就是这么来的。
 * 任务在执行时 ZLM 对未开始推流的流是「挂着等」的，先连上去，推流一开始就在
 * 同一根连接上出数据。这与「没任务不连」不矛盾：门禁是任务，不是 `online`。
 */
const hasStream = computed(() => !!streamNow.value?.flv)

/**
 * 播放器回报的真实状态：LIVE 角标只认 `playing`，别拿「有地址」冒充在播。
 * （状态枚举的权威定义在 `LivePlayer.vue`，这里按字符串比，不复制一份类型守卫。）
 */
const liveState = ref<string>('idle')

/**
 * 切页签 / 画面真正下屏时才清状态。
 *
 * 注意看的是 `streamOn` 而不是 `missionOn`：任务刚结束的那 2 分钟画面还在播，
 * 这时把 `liveState` 清掉会把 `LIVE` 角标摘掉 —— 明明在播却装作没播。
 */
watch([tab, streamOn], () => {
  liveState.value = 'idle'
})

/** 有任务、但平台没给地址时才走整块占位（地址在但没推流由播放器说「未开播」） */
const noStreamNote = '平台没有这台无人机的直播流'

/** 未开播时补的那句原因 */
const offAirHint = '无人机起飞推流后会自动出画面，不用手动刷新'

/** 没有执行中任务时补的那句「什么时候会有画面」——与上面那句同一语气 */
const idleHint = '起飞任务开始后会自动连上画面'

/**
 * 状态 = 厂家状态码的文案（`utils/uavState.ts`），与 V2 同一张表。
 *
 * 早先是「有执行中的任务就说作业中，否则停泊」—— 那是拿任务状态冒充飞机状态，
 * 在库里飞控断电时 V2 写「关机」、我们写「停泊」，对不上。
 */
const flyState = computed(() => uav.live.state)

/**
 * 执行中任务的进度：`(now − start) / (end − start)`。
 *
 * 设计稿那根进度条是写死的 62%。我们不编：用接口给的计划起止时间算，
 * 超出计划就停在 100%（不写 137% 这种吓人的数）。
 */
/** 当前巡检的进度：已飞多久 / 预计多久 / 百分之几（分母是历史实测中位数） */
const mission = computed(() =>
  missionProgress(uav.running?.startAt ?? null, uav.runningEstimate, now.value),
)

/**
 * 「10:50 起飞 · 已飞 5.1 分钟 · 预计 7 分钟」。
 *
 * 2026-11-24：这句**不再在这里拼**，改由 `missionLine()` 统一出字 —— 首页无人机卡
 * 也要显示同一行，两处各拼一遍就会慢慢长歪（空格 / 小数位 / 有没有「任务执行中」）。
 */
const missionNote = computed(() =>
  uav.running ? missionLine(uav.running.time, mission.value) : '',
)

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
        </div>
      </div>

      <!--
        实时画面 = keehang 的 HTTP-FLV 直播（与 V2 同一路流，见 api/drone.ts）。

        门禁是**有没有执行中的起飞任务**（2026-11-24）：没任务就不挂播放器 ——
        卸载即清掉重连定时器，不再对着一条不存在的推流每 20s 空试一次；
        有任务才回到「有地址就先连」（ZLM 会挂着等推流），连不上由播放器自己说原因。
        任务刚结束的 2 分钟内仍算「有画面」（`streamOn`，见上面的宽限窗口）——
        飞机收尾可能还在推流，不能一刀切掉。
        两种情况都不挂静态示意图 —— 示意图长得像现场画面，会被当成实时情况看。
      -->
      <div class="uav-stage" :class="{ 'is-wait': !streamOn || !hasStream }">
        <LivePlayer
          v-if="streamOn && hasStream"
          :key="`${tab}-${streamNow?.id}`"
          :src="streamNow?.flv ?? null"
          :off-air-hint="offAirHint"
          @state="liveState = $event"
        />
        <span v-if="streamOn && liveState === 'playing'" class="uav-live"><i></i>LIVE</span>

        <template v-if="!streamOn">
          <p>当前无正在执行的任务，无视频画面</p>
          <p class="uav-stage-sub">{{ idleHint }}</p>
        </template>
        <template v-else-if="!hasStream">
          <p>实时画面未开播</p>
          <p class="uav-stage-sub">{{ noStreamNote }}</p>
        </template>
      </div>

      <!--
        任务刚结束、画面还在的那 2 分钟：说清为什么还有画面，不让它像卡住了。
        `hasStream` 一起判 —— 平台没给地址时画面区本来就在说「未开播」，
        再补一句「保留 2 分钟」会自相矛盾。
      -->
      <p v-if="!missionOn && streamOn && hasStream" class="uav-note">
        任务已结束，画面保留 {{ holdMinutes }} 分钟后自动关闭
      </p>

      <!--
        飞行参数七格（状态 / 海拔 / 飞行距离 / 水平速度 / 垂直速度 / 翻滚角 / 偏航角）
        2026-11-23 按现场要求**整块下线**：只留监控画面，读数不再占用版面。
        遥测仍在 store 里照常刷新（设备参数那几格、起飞校验都还用着），
        只是不再画在这一段。
      -->
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
          <em v-if="mission.pct !== null">{{ mission.pct }}%</em>
        </div>
        <!-- 进度条：分母是同一任务近 7 天真跑出来的中位数，不是写死的百分比 -->
        <div
          v-if="mission.pct !== null"
          class="uav-bar"
          role="progressbar"
          :aria-valuenow="mission.pct"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`当前巡检进度 ${mission.pct}%`"
        ><i :style="{ width: `${mission.pct}%` }"></i></div>
        <p :title="mission.estimateMin !== null ? '预计时长按同一任务近 7 天已完成执行的中位数' : ''">
          {{ missionNote }}
        </p>
      </div>
      <div v-else-if="uav.state === 'error'" class="data-empty">
        <p>{{ uav.error || '无人机任务加载失败' }}</p>
        <button class="data-empty-btn" type="button" @click="retry">重试</button>
      </div>
      <div v-else-if="!syncing && uav.taskTotal === 0" class="data-empty">
        <p>今日暂无无人机任务</p>
      </div>

      <!--
        刷新失败但手里还有上一轮数据（`load()` 不再清空 records，见 stores/uav.ts）：
        明说这是旧的，别让三格和「当前巡检」看着像实时 —— 数据可以有，但不能装。
      -->
      <p v-if="uav.state === 'error' && (uav.records.length > 0 || uav.stat)" class="uav-note">
        刷新失败，以上为上一次的数据
      </p>
    </section>

    <!-- ③ 设备参数（设计稿八格，全部有源） -->
    <section class="dev-block">
      <h4>设备参数</h4>
      <div class="uav-stats">
        <div><b :class="{ 'is-down': uav.live.stateDown }">{{ flyState }}</b><span>状态</span></div>
        <div><b :class="toneOf(pct(uav.live.battery), '电量')">{{ pct(uav.live.battery) }}</b><span>电量</span></div>
        <div><b>{{ dist(uav.live.homeDistance) }}</b><span>距机库</span></div>
        <div><b>{{ remain(uav.live.remainFlight) }}</b><span>续航</span></div>
        <div><b :class="toneOf(wind(uav.windSpeed), '风速')">{{ wind(uav.windSpeed) }}</b><span>风速</span></div>
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
      </div>
    </section>
  </div>
</template>
