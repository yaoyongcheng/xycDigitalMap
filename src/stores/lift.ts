import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  fetchLiftAttr,
  fetchLiftOnline,
  fetchLiftToday,
  LIVE_ATTR_WINDOW,
  liftAuthFailed,
  liftGatewayStale,
} from '@/api/lift'
import { clearToken } from '@/api/iot'
import type { LiftAttr, LiftToday } from '@/utils/lift'

/**
 * 智能电梯（IOT 网关）
 *
 * ## 为什么单独一个 store
 *
 * 与爬架同样的理由：这是**另一套后端**。台账走 `:8084`（要 Bearer，
 * 登出即失效），电梯走 `iot.cscec3b-iti.com`（项目级 ak/sk 换令牌，与用户
 * 账号无关）。塞进 deviceLedger 会让「登出」和「IOT 挂了」互相牵连。
 *
 * 顺带也解决了首页那一格的来源问题：设计稿电梯卡是
 * 「在线 x/y + 时长」，而台账里只有一个静态「高度」—— 以前那格
 * 只能显示高度（或「—」），因为当时没打通 IOT。
 *
 * ## 一次 refresh 打三个请求，彼此不牵连
 *
 * 在线（`EVENT_ON_OFF`）、今日作业（`EVENT_WORKDATA`）、当前工况
 * （`EVENT_POST_ATTR`）是三个事件码，V2 端也是分开轮询的。这里并发发出，
 * 任何一个失败只让对应那一格变成「—」，不影响别格 —— 工况帧拿不到时，
 * 「今天跑了多久」仍然是可信的。
 *
 * ## 不轮询（已改）
 *
 * 初版写的是「一次会话拉一次 + 切面板刷新」，理由是「现场电梯工况帧几十秒
 * 一条，轮询收益远小于流量」。那只是**帧的节奏**，不是**页面的期待**：
 * 用户盯着「当前楼层 / 当前载重」时，一帧卡在那里十分钟不动，看着就是坏了。
 *
 * 现在按 V2 的做法实时刷新（`stores/lift.ts` 的 `pollOnce`），但做了三处收敛：
 *   · 间隔 10 秒（V2 是 5 秒，但它是原生客户端且每轮只查需要的接口）；
 *   · 只轮询工况，在线/今日各自按 30 秒 / 60 秒节流（它们变化慢）；
 *   · 只在**有人看着**的页面（首页智控 / 电梯详情 / 设备信息弹层）且标签页
 *     可见时跑，`startLive/stopLive` 按名字登记，最后一个走才停。
 *
 * 凭证判定失效时整轮跳过 —— 否则每 10 秒往网关空撞一次，用户越等越糟。
 */

const RETRY_GAP = 60_000

/**
 * 实时工况的刷新间隔。
 *
 * V2 `PollRealtimeDataAsync` 是 `UniTask.Delay(5000)`，但它一轮只发 4 个
 * 请求（4 笼各一）；我们这轮还要周期性捎带在线/今日，10 秒既能让楼层和载重
 * 「看着是活的」，又不会把现场流量打满。
 */
const LIVE_MS = 10_000

/** 每 N 轮补一次在线状态（= 30 秒）；在线态变化慢，没必要跟着 10 秒跑 */
const ONLINE_EVERY = 3

/** 每 N 轮补一次今日作业（= 60 秒）；它是当天累计，一分钟一刷已经够细 */
const TODAY_EVERY = 6

export type LiftState = 'idle' | 'loading' | 'ok' | 'error'

export const useLiftStore = defineStore('lift', () => {
  /** `sn → 是否在线`；表里没有的编号 = 网关没这条记录（不是「离线」） */
  const online = ref<Record<string, boolean>>({})
  /** `sn → 今日作业`；没有事件的台次不在表里 */
  const today = ref<Record<string, LiftToday>>({})
  /** `sn → 最新工况帧` */
  const attr = ref<Record<string, LiftAttr>>({})

  const state = ref<LiftState>('idle')
  /** 成功取数的时刻（HH:mm），卡片说明行用 */
  const updatedAt = ref('')
  /**
   * 网关不认我们的凭证（HTTP 401，自动重换一次仍失败）。
   *
   * 与「这台电梯没数据」是两件事：前者再显示「—」就是在骗人，页面要给一条
   * 带「重试」的提示，否则用户看到的全是横杠、不知道该做什么。
   * 网络层的自愈（清令牌重换）在 `api/iot.ts` 里，这里只接「自愈也没救回来」。
   */
  const authLost = ref(false)

  /**
   * 「重试过了，网关还没轮换」。
   *
   * 判据很硬：重换回来的令牌与刚被判 401 的那张**逐字节相同**。换令牌接口是
   * 幂等的，出现这种情况只有一种解释 —— 服务端还没恢复。网络层此时已经收手
   * （12 个数据请求一个都没发），页面上的提示条要换句话，否则用户会以为
   * 自己刚才那一下没点上，继续反复点。
   */
  const gatewayStale = ref(false)

  let lastFailAt = 0
  let inflight: Promise<void> | null = null

  /* ---------- 实时刷新 ---------- */

  /**
   * 正在「看着」电梯数据的页面，按名字登记（首页智控 / 电梯详情 / 设备信息弹层）。
   *
   * 用名字而不是计数器：同一个组件重复 `startLive` 不会把计数抬高，
   * 卸载时也只减自己那一份。三个消费方可能同时存在（详情页开着弹层），
   * 最后一个离开才真的停表。
   */
  const liveOwners = new Set<string>()
  let liveTimer = 0
  let liveTicks = 0
  /** 是否在实时刷新 —— 页面据此显示「实时」标记 */
  const live = ref(false)

  /** 有没有任何一条 IOT 数据可用（决定卡片走真实值还是「—」） */
  const hasData = computed(
    () =>
      Object.keys(online.value).length > 0 ||
      Object.keys(today.value).length > 0 ||
      Object.keys(attr.value).length > 0,
  )

  /**
   * 单个轿厢是否在线 —— **照 V2 `ElevatorIotModel.IsOnline` 的口径**：
   * `TryGetValue` 查不到就取 `out` 的默认值 `false`，即「网关里没有这条记录」
   * 按**离线**计。
   *
   * 注意这是「**网关已应答**」前提下才有意义：整批在线状态都没取到时表是空的，
   * 每个 sn 都查不到 → 全部返回 `false`（离线）。这是**有意为之**：连不上就报
   * 离线，比留上一轮的 `true` 更诚实（见 `onlineKnown` 的注释）。
   */
  function isOnline(sn: string): boolean {
    return online.value[sn] === true
  }

  /**
   * 这一轮到底拿没拿到在线状态。
   *
   * `false` = 网关没应答 / 没开通（整批空）。此时**一律按离线算**，不回落台账：
   * 台账的 `online_status` 是平台登记态，跟「这一刻这台电梯通不通」无关，拿它
   * 顶替会造出「4/4 在线」但每一格都是「—」的自相矛盾画面（2026-11-13 用户
   * 在凭证失效那天看到的就是这个）。
   *
   * 宁可保守报离线：连不上时用户该看到的是灰色点和提示条，不是绿色对勾。
   *
   * 页面不再据此分叉（连不上与真离线都渲染「离线」），保留它是为了排查时能
   * 区分这两种情况，以及给未来的「状态未知」留口子。
   */
  const onlineKnown = computed(() => Object.keys(online.value).length > 0)

  /**
   * 一台电梯的今日作业（多个轿厢求和）。
   *
   * `null` = 这台电梯的轿厢全都没有今日事件 —— 上层显示「—」而不是 `0min`
   * （「今天没跑」与「今天没数据」在页面上必须能分开）。
   */
  function todayOf(sns: readonly string[]): LiftToday | null {
    let hit = false
    let trips = 0
    let seconds = 0
    for (const sn of sns) {
      const t = today.value[sn]
      if (!t) continue
      hit = true
      trips += t.trips
      seconds += t.seconds
    }
    return hit ? { trips, seconds } : null
  }

  /**
   * 一台电梯的当前工况 —— 取该台轿厢里**时间最新**的那一帧。
   *
   * 不按轿厢名次挑：1-1 可能整天没动（帧停在早上），1-2 刚跑完一趟，
   * 那「当前楼层」当然该看 1-2 的。
   */
  function attrOf(sns: readonly string[]): LiftAttr | null {
    let best: LiftAttr | null = null
    for (const sn of sns) {
      const a = attr.value[sn]
      if (!a) continue
      if (!best || (a.at ?? 0) > (best.at ?? 0)) best = a
    }
    return best
  }

  /**
   * 全部台次的合计运行秒数；一台数据都没有时 null。
   *
   * 每台的值是 **V2 口径的首尾跨度**（含停机，见 `utils/lift.ts`），所以多台
   * 相加只是「各台跨度之和」，不是「今天有多少时间有电梯在跑」—— 两笼同时
   * 运行的那一小时会被算两次。首页那一格是个摘要，现场只有 1 台有数，
   * 真要按楼栋看量级得进详情页。宁可留着不同口径的注释，也不改成累加：
   * 那样首页和弹层又会对不上。
   */
  const totalSeconds = computed<number | null>(() => {
    const list = Object.values(today.value)
    if (!list.length) return null
    return list.reduce((s, t) => s + t.seconds, 0)
  })

  /**
   * 单个轿厢的今日作业 / 最新工况。
   *
   * 「设备信息」弹层是按轿厢打开的（`智能电梯1-1`），不能像卡片那样把一栋楼的
   * 几个轿厢合起来 —— 合起来之后「当前楼层」会变成两笼里较新的那一笼，
   * 打开的是 1-1 却看到 1-2 的读数。
   */
  function todayOfSn(sn: string): LiftToday | null {
    return today.value[sn] ?? null
  }

  function attrOfSn(sn: string): LiftAttr | null {
    return attr.value[sn] ?? null
  }

  /** 测试接线点：直接灌数据（不走网络） */
  function apply(patch: {
    online?: Record<string, boolean>
    today?: Record<string, LiftToday>
    attr?: Record<string, LiftAttr>
  }): void {
    if (patch.online) online.value = patch.online
    if (patch.today) today.value = patch.today
    if (patch.attr) attr.value = patch.attr
    state.value = 'ok'
    if (!updatedAt.value) updatedAt.value = stamp()
  }

  function stamp(): string {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /**
   * 取一轮电梯数据。
   *
   * `force` 只给页面上的「重试」用；切面板走 `refresh()`（失败冷却仍生效）。
   */
  async function load(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && state.value === 'ok') return
    if (!force && state.value === 'error' && Date.now() - lastFailAt < RETRY_GAP) return

    state.value = 'loading'
    inflight = (async () => {
      const [on, day, live] = await Promise.all([
        fetchLiftOnline(),
        fetchLiftToday(),
        fetchLiftAttr(),
      ])

      // 逐块替换：某块失败时保住上一次的值，不让它连带清空别块 —— **在线状态例外**。
      // 它是唯一会被读成「设备一切正常」的读数：网关已经连不上了还留着上一轮的
      // 4 条 `true`，首页就是「4/4 在线 + 绿点 + 凭证失效提示条」同时出现。
      // 工况/今日留残值无害（自带时间戳），在线留残值就是在报假平安。
      if (on) online.value = on
      else online.value = {}
      if (day) today.value = day
      if (live) attr.value = live

      authLost.value = liftAuthFailed()
      gatewayStale.value = liftGatewayStale()

      if (on || day || live) {
        state.value = 'ok'
        updatedAt.value = stamp()
      } else {
        state.value = 'error'
        lastFailAt = Date.now()
      }
      inflight = null
    })()
    return inflight
  }

  /**
   * 切回智控面板时的刷新 —— 与 `load(true)` 的唯一区别是**失败冷却仍生效**。
   *
   * 连点标签不该把三个注定失败的请求连打三遍（现场弱网很常见）。
   */
  async function refresh(): Promise<void> {
    if (state.value === 'error' && Date.now() - lastFailAt < RETRY_GAP) return
    return load(true)
  }

  /**
   * 一轮实时刷新：**工况必刷**，在线/今日各自节流。
   *
   * 三件事分开的理由是节奏不同：楼层/载重每秒都在变（也是用户盯着看的那两格），
   * 在线态分钟级才动一次，今日作业是当天累计、一分钟一刷都嫌勤。若每轮全量打
   * 一遍，就是每 10 秒 12 个请求 —— 下午的电梯越跑，工况帧越多，越不划算。
   *
   * 两种情况下整轮跳过：
   *   · 标签页在后台（手机上切走还刷纯烧流量和电）；
   *   · 凭证已判定失效（每 10 秒空撞一次网关只会更糟，等用户点「重试」）。
   */
  async function pollOnce(): Promise<void> {
    if (document.visibilityState === 'hidden') return
    if (authLost.value) return
    // 首次加载还没回来时不叠一轮，免得同一批数据打两遍
    if (inflight) return

    liveTicks += 1
    // 节流：这两路不是每轮都查。`due*` 必须留着，否则「没查」会被当成「查了没结果」
    const dueOnline = liveTicks % ONLINE_EVERY === 0
    const dueToday = liveTicks % TODAY_EVERY === 0
    const [liveAttr, on, day] = await Promise.all([
      // 窄窗口：6 小时的全量只留给首轮，轮询只看最近 3 分钟
      fetchLiftAttr(Date.now(), LIVE_ATTR_WINDOW),
      dueOnline ? fetchLiftOnline() : Promise.resolve(null),
      dueToday ? fetchLiftToday() : Promise.resolve(null),
    ])

    // 静止的轿厢窗口内没有新帧 → **保留上一次读数**。清空会让「5F」在电梯
    // 停下三分钟后突然变成「—」，看着像坏了；旧读数自带时间戳，不会骗人。
    if (liveAttr && Object.keys(liveAttr).length > 0) attr.value = liveAttr
    // 在线不同：这一轮**真的查过**却没结果（网关不通 / 401）就清空 → 全部按离线。
    // 与 `load()` 同一条理由：在线残值会把「连不上」画成「全在线」。
    if (on) online.value = on
    else if (dueOnline) online.value = {}
    if (day) today.value = day

    authLost.value = liftAuthFailed()
    gatewayStale.value = liftGatewayStale()
    if (liveAttr || on || day) {
      state.value = 'ok'
      updatedAt.value = stamp()
    }
  }

  /** 页面可见性变化：切回来立刻补一轮，不用干等下一个 10 秒 */
  function onVisible(): void {
    if (document.visibilityState === 'visible') void pollOnce()
  }

  /**
   * 开始实时刷新（幂等）。
   *
   * `owner` 是页面名，不是实例 —— 三个消费方各登记自己那一份，
   * 最后一个 `stopLive` 才真正停表。
   */
  function startLive(owner: string): void {
    if (liveOwners.has(owner)) return
    liveOwners.add(owner)
    if (liveTimer) return
    live.value = true
    document.addEventListener('visibilitychange', onVisible)
    liveTimer = window.setInterval(() => void pollOnce(), LIVE_MS)
  }

  /** 停止实时刷新；`owner` 不在登记表里时什么也不做 */
  function stopLive(owner: string): void {
    if (!liveOwners.delete(owner)) return
    if (liveOwners.size) return
    window.clearInterval(liveTimer)
    liveTimer = 0
    live.value = false
    document.removeEventListener('visibilitychange', onVisible)
  }

  /**
   * 重取一次（用户点提示条上的「重试」）。
   *
   * **不是登录**。电梯走 IOT 云网关的项目级 ak/sk，跟 `:8081` 那套业务账号
   * （`xiangyangcun` / Bearer）是两套完全不同的凭证 —— 登录换不到 IOT 令牌。
   * 这里唯一有效的动作是：丢掉缓存的旧令牌，用 ak/sk 重新换一张。
   *
   * 名字沿用 `relogin` 是因为它确实「重新登录到 IOT 网关」，但页面上叫「重试」，
   * 免得用户以为要去业务登录页。顺带清掉失败冷却，让这一下是真的在重取。
   */
  async function relogin(): Promise<void> {
    clearToken()
    authLost.value = false
    lastFailAt = 0
    await load(true)
  }

  /** 清空（换项目 / 强制重取时用；IOT 与登录账号无关，登出不清） */
  function reset(): void {
    online.value = {}
    today.value = {}
    attr.value = {}
    state.value = 'idle'
    updatedAt.value = ''
    authLost.value = false
    gatewayStale.value = false
    lastFailAt = 0
  }

  // store 的作用域被销毁（换项目 / 测试重建 pinia）时把表停掉，不留孤儿定时器
  onScopeDispose(() => {
    liveOwners.clear()
    window.clearInterval(liveTimer)
    liveTimer = 0
    live.value = false
    document.removeEventListener('visibilitychange', onVisible)
  })

  /*
   * 刻意**不**监听 `auth.token`。
   *
   * 曾经加过一条「登录成功就重取」，前提是「登录能拿到 IOT 令牌」—— 那是错的。
   * 业务 Bearer（`:8081`）与 IOT 的 ak/sk 令牌不同源，登录对这里毫无影响；
   * 反过来，登录时顺手 `clearToken()` 还会把本来好用的一张令牌丢掉重换，
   * 白白让电梯数据抖一下。IOT 是项目级凭据，与账号无关，登出也不清。
   */

  return {
    online,
    today,
    attr,
    state,
    updatedAt,
    authLost,
    gatewayStale,
    hasData,
    totalSeconds,
    onlineKnown,
    isOnline,
    todayOf,
    attrOf,
    todayOfSn,
    attrOfSn,
    apply,
    load,
    refresh,
    /** 实时刷新开关：页面按名字登记，最后一个离开才停表 */
    startLive,
    stopLive,
    live,
    relogin,
    reset,
  }
})
