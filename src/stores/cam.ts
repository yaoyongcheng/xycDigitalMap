import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { fetchCamSnapshot } from '@/api/camsnap'
import { findMonitorEntry, loadMonitorList, pickStreamUrl, type MonitorEntry } from '@/api/cctv'
import { CAM_GROUPS, CAM_POINTS, findCamPoint } from '@/data/cams'
import { cctvPlayableUrl, cctvRtspUrl, streamModeOf, type StreamMode } from '@/data/cctv'
import { addDays, dateKey, formatCamDate, monthStart, startOfDay } from '@/utils/date'
import {
  clearShots as clearShotArchive,
  listShots,
  saveShot,
  SHOT_SLOT_HOURS,
  type ShotRecord,
} from '@/utils/shotArchive'
import { useAirHazardStore } from './airHazard'
import { useAuthStore } from './auth'
import { useShellStore } from './shell'
import { useSubpageStore } from './subpage'

/**
 * 视频监控（2026-11-18 按设计稿重做）
 *
 * ## 这次改了什么
 *
 * 旧版点位是从视频报警的 `channelNo` 反推出来的（现场只有 2 / 3 两个通道，
 * 于是监控页只有「材料堆场 / 安全讲台」两个点位），所谓「直播位」其实是最近一次
 * 报警抓拍，还挂着一个假的播放按钮 —— 点下去只弹一句「实时视频流未开放」。
 *
 * 现在改走万方媒体服务的**监控快照接口**（`api/camsnap.ts`，V2 桌面端同源画面）：
 *   · 点位是写死的 8 个白名单（`data/cams.ts`），分「出入口 / 场内 / 塔吊」三组；
 *   · 每个点位取自己通道的最新画面，按需加载 + 会话内缓存；
 *   · 不做轮询 —— 快照一天只更新几次，轮询只是白下流量。
 *
 * ## 双模：有流就播流，没流就取帧（2026-11-18 补播放联动）
 *
 * 播放键不是摆设，也不假装：`streamUrl` 有值（点位自带 `stream`，或 `.env` 里配了
 * `VITE_CAM_STREAM_TEMPLATE`）才渲染 `<video>`，播放键走 `play()/pause()`，按钮图标
 * 由 `<video>` 抛的 play / pause / waiting / error 事件驱动 —— 状态以媒体元素为准，
 * 不以点击次数为准，所以连点、切换、断流都不会把按钮和画面点岔。
 *
 * 没有流时（当前就是这种情况：媒体服务只提供定时快照）播放键 = 「重新取一帧」，
 * 与「刷新」同源，`state==='loading'` 时进禁用态，连点也只发一次请求。
 *
 * ## 状态只留「当前点位」一份
 *
 * 一次只显示一个画面，所以 `state / note` 是单份而不是按通道存：切点位时旧请求
 * 直接 abort（`seq` 兜住晚到的响应），不会出现「切到 A 却显示 B 的图」。
 * 已经取到的画面按通道缓存，来回切不重复下载（单张 200~500KB）。
 */

/** idle 未取 / loading 取图中 / ok 已到手 / error 取失败 */
export type CamFrameState = 'idle' | 'loading' | 'ok' | 'error'

/**
 * 播放态（只有「有直播流」的点位才会离开 idle）。
 *
 * 全部由流引擎 / `<video>` 的事件推进，组件不自己猜：
 *   · connecting → buffering（首次连流，`playNote` 是「正在连接现场画面…」）
 *   · reconnecting → reconnecting（断了在退避重连，`playNote` 带次数与倒计时）
 *   · playing → playing
 *   · pause   → paused
 *   · waiting → buffering（转圈）
 *   · error   → error（快速重试用完，说清原因；**注意引擎仍在后台低频重连**，
 *     不是永久判决 —— 流一回来就会自己变成 playing）
 *
 * 为什么单独留一个 `reconnecting`：重连期间画面临时让给快照、按钮该是转圈 +
 * 「立即重连」，和「暂停 / 播放」是两种语义。混进 `buffering` 的话，按钮会在
 * 三角和转圈之间来回跳，用户以为点坏了。
 */
export type CamPlayState = 'idle' | 'buffering' | 'reconnecting' | 'playing' | 'paused' | 'error'

/**
 * 一张历史抓拍。
 *
 * 字段按「接入真实接口后视图不用改」来定：缩略图与原图分开（列表只下缩略图）、
 * 记通道（换点位后仍能说清是哪台相机）、记时刻（分组与排序都靠它）。
 */
export interface CamShot {
  /** 主键 = `通道|日期|档位` */
  id: string
  /** 压缩预览（列表用，长边 480 的 WebP） */
  thumb: string
  /** 原图（点开看大图用） */
  url: string
  /** 抓拍时刻（ms） */
  at: number
  /** 档位序号 0/1/2（08:00 / 12:00 / 18:00） */
  slot: number
  /** 原图字节数 */
  size: number
  /** 所属点位 */
  channelId: string
}

/**
 * 历史抓拍的可查范围：以今天为基准的**近 30 天**（含今天）。
 *
 * 上下界都不是随便定的：
 *   · 上界必须是今天 —— 服务端只有「最近一帧」，未来日期连数据源都不存在；
 *   · 下界跟着本机档案的淘汰天数走（`SHOT_KEEP_DAYS`），比档案更早的日期
 *     必然是空的，放开了只会让人白点一次、看到「本机没有记录」。
 * 两边一起改，别只改一边（改一边就会出现「能选但永远没图」的死日期）。
 */
export const SHOT_RANGE_DAYS = 30

/** 一个通道已取到的画面 */
interface CamFrame {
  /** objectURL（换图时 revoke） */
  url: string
  /** 取图时刻（ms）—— 画面本身带相机 OSD 时间，这里只记「什么时候拿到的」 */
  at: number
}

export const useCamStore = defineStore('cam', () => {
  const shell = useShellStore()
  const auth = useAuthStore()

  const isOpen = ref(false)

  /** 当前点位（channelId）。默认第一个，关掉再开保持上次选择 */
  const camId = ref<string>(CAM_POINTS[0].channelId)

  const state = ref<CamFrameState>('idle')
  const note = ref('')

  /** channelId → 已取到的画面（会话内缓存） */
  const frames = ref<Record<string, CamFrame>>({})

  /** 取图序号：切点位/重取时只让最后一次落地 */
  let seq = 0
  let inflight: AbortController | null = null

  const points = CAM_POINTS

  const current = computed(() => findCamPoint(camId.value) ?? CAM_POINTS[0])

  /** 分组（空组不出现在页面上，`h5` 里的数字是这一组的点位数） */
  const grouped = computed(() =>
    CAM_GROUPS.map((name) => ({ name, items: points.filter((p) => p.group === name) })).filter(
      (g) => g.items.length > 0,
    ),
  )

  const frame = computed<CamFrame | null>(() => frames.value[current.value.channelId] ?? null)

  /** 当前点位画面地址（空串 = 还没有，页面上是加载态/空态） */
  const frameUrl = computed(() => frame.value?.url ?? '')

  /** 当前画面是什么时候取到的（ms，0 = 没取到） */
  const frameAt = computed(() => frame.value?.at ?? 0)

  /* ---------------- 直播流（有则播、无则只有快照） ---------------- */

  const playState = ref<CamPlayState>('idle')
  const playNote = ref('')

  /**
   * V2 的监控地址清单（`monitorData.json`，20 条）。
   *
   * 打开监控层时拉一次，会话内复用；拉不到就是空数组，后面按「没有流地址」走。
   */
  const monitorList = ref<MonitorEntry[]>([])
  const manifestSource = ref<'live' | 'snapshot' | 'none'>('none')
  let manifestTried = false

  /** 取 V2 清单（线上 → 内置快照，只试一次；失败不阻塞画面） */
  async function loadManifest(): Promise<void> {
    if (manifestTried) return
    manifestTried = true
    const res = await loadMonitorList()
    if (!res) {
      manifestSource.value = 'none'
      return
    }
    monitorList.value = res.list
    manifestSource.value = res.source
  }

  /** 当前点位在 V2 清单里的条目（按地址里的 channelId 对，不按名字） */
  const monitorEntry = computed(() => findMonitorEntry(monitorList.value, current.value.channelId))

  /** 清单里这条的地址（可能是 flv / hls / rtsp） */
  const manifestUrl = computed(() => (monitorEntry.value ? pickStreamUrl(monitorEntry.value) : ''))

  /**
   * 可播地址（能进 `<video>` 的那种）。
   *
   * 优先级（命中即用）：
   *   1. 点位单点覆盖（`CamPoint.stream`，联调/换机时用）；
   *   2. 清单里给的 flv / hls（清单若哪天真的给了浏览器可播地址，以它为准）；
   *   3. `cctvPlayableUrl()` —— 默认按现场模板拼的 HTTP-FLV（`:9092`）。
   *
   * 第 2、3 步会**跳过 rtsp**：V2 清单 20 条全是 RTSP，浏览器播不了，
   * 硬塞给 `<video>` 只会得到一块黑屏。
   */
  const playUrl = computed(() => {
    const p = current.value
    if (p.stream) return p.stream
    const fromList = manifestUrl.value
    if (fromList && !/^rtsp:/i.test(fromList)) return fromList
    return cctvPlayableUrl(p.channelId)
  })

  /**
   * 原始 RTSP 地址（V2 清单原样，或按 V2 规则拼出来的）。
   *
   * 只在「连 FLV 都起不来」时交给人 —— 浏览器播不了它，但运维/桌面客户端能用，
   * 比留一块黑屏强。
   */
  const rtspUrl = computed(() => {
    const fromList = manifestUrl.value
    if (/^rtsp:/i.test(fromList)) return fromList
    return cctvRtspUrl(current.value.channelId)
  })

  /** 地址类型：flv / hls / rtsp / other / none（判定口径同 V2 CheckUrlMode） */
  const playMode = computed<StreamMode>(() => streamModeOf(playUrl.value))

  /** 有没有能进播放器的地址（rtsp 不算） */
  const isLive = computed(() => playUrl.value !== '')

  /** 播放键此刻该是什么样（组件只读它，不自己维护第二份状态） */
  const isPlaying = computed(() => playState.value === 'playing')

  function markPlaying(): void {
    playState.value = 'playing'
    playNote.value = ''
  }

  /**
   * 连接 / 重连中（画面还没出帧）。
   *
   * 与 `markBuffering` 的区别：这条允许从 `error` 回到 `buffering` —— 重连正是
   * 「从失败里往外爬」，写死成不可逆的话，第一次断开之后就再也显示不出重连进度。
   * `msg` 是给人看的一句（「3 秒后重连（1/3）」），页面写在画面下方的说明条里。
   */
  function markConnecting(msg = ''): void {
    playState.value = 'buffering'
    playNote.value = msg
  }

  /**
   * 断流了、正在自动重连。
   *
   * 与 `markConnecting` 分开记：页面据此把播放键画成转圈 + 「立即重连」，
   * 说明条直接显示引擎给的那句话（第几次、几秒后、还是已经转入低频重连）。
   * 允许从 `error` 回来 —— 用户点「立即重连」正是从失败往外爬。
   */
  function markReconnecting(msg = ''): void {
    playState.value = 'reconnecting'
    playNote.value = msg
  }

  /** 缓冲结束、真正出画（`playing` 事件）；`msg` 用于「等待自动恢复播放」这类说明 */
  function markBuffering(msg = ''): void {
    // 已经失败的不再被后续事件改回来，避免「报错了又显示转圈」反复横跳
    if (playState.value === 'error') return
    playState.value = 'buffering'
    playNote.value = msg
  }

  function markPaused(): void {
    if (playState.value === 'error') return
    playState.value = 'paused'
  }

  /**
   * 流打不开：记下**引擎给的具体原因**，页面回到快照兜底。
   *
   * 这不是「放弃」—— `msg` 里已经写明还会继续自动重连、可以点播放键立即重试；
   * 流一旦回来，引擎会再抛 `playing` 把这里盖掉。
   */
  function markPlayError(msg = ''): void {
    playState.value = 'error'
    playNote.value = msg || '直播流连接失败，已回到定时快照'
  }

  /** 切点位/关层时复位，别把上一个点位「正在播放」带过来 */
  function resetPlay(): void {
    playState.value = 'idle'
    playNote.value = ''
  }

  /* ---------------- 历史抓拍（2026-11-19：接真实快照 + 本机档案） ---------------- */

  /** 是否停在「历史抓拍」视图（画面视图与之互斥） */
  const shotsOpen = ref(false)

  /** 选中日期（默认今天） */
  const shotDate = ref<Date>(startOfDay(new Date()))
  const shotCalOpen = ref(false)
  const shotCalMonth = ref<Date>(monthStart(new Date()))

  /**
   * 可选区间的上界（今天）与下界（今天往前 {@link SHOT_RANGE_DAYS} 天）。
   *
   * 写成 computed 而不是常量：应用挂在前台跨过零点时，「今天」会变，
   * 区间要跟着挪一天，否则第二天早上打开还是只能选到昨天。
   */
  const shotMaxDate = computed(() => startOfDay(new Date()))
  const shotMinDate = computed(() => addDays(shotMaxDate.value, 1 - SHOT_RANGE_DAYS))

  const shots = ref<CamShot[]>([])
  /** idle 未查 / loading 查询中 / ok 有照片 / empty 这天没有 / error 请求失败 */
  const shotsState = ref<'idle' | 'loading' | 'ok' | 'empty' | 'error'>('idle')
  const shotsNote = ref('')

  /** 详情弹层：正在看的那张 */
  const shotPopId = ref('')
  const shotPopOpen = computed(() => shotPopId.value !== '')
  const shotPop = computed(() => shots.value.find((s) => s.id === shotPopId.value) ?? null)
  /** 详情里是否已切到原图 */
  const shotShowFull = ref(false)

  /** 列表里的 objectURL（重查 / 关层时统一撤） */
  let shotUrls: string[] = []
  let shotSeq = 0
  let shotInflight: AbortController | null = null

  /** 选中日期的人话（今天 / 昨天 / MM/DD） */
  const shotDateLabel = computed(() => formatCamDate(shotDate.value))

  /**
   * 标题右侧那句说明。
   *
   * 设计稿写的是「每天 3 张，点开查看照片」—— 前半句是真的（上游每天
   * 08:00 / 12:00 / 18:00 各更新一次），但「3 张」指的是**服务端的更新次数**，
   * 不是一份随时可查的历史列表。所以这里把口径写实：更新节奏 + 当天留了几张。
   */
  const shotsHint = computed(() => {
    const hours = SHOT_SLOT_HOURS.join(' / ')
    return `每天 ${hours} 点更新 · 当天 ${shots.value.length} 张`
  })

  /** 'M月D日'（区间说明里的人话日期） */
  function md(d: Date): string {
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }

  /** 空态那句话（今天 / 历史日口径不同） */
  function shotEmptyNote(): string {
    if (shotDateLabel.value === '今天') {
      return '服务端只保留最近一帧快照（每天 08 / 12 / 18 点各更新一次），今天还没取到画面。点下面「重新获取」立刻抓一张。'
    }
    return `服务端只保留最近一帧快照、不保存历史；这一天本机也没有留存记录（本机只存近 ${SHOT_RANGE_DAYS} 天）。`
  }

  function releaseShotUrls(): void {
    for (const u of shotUrls) {
      try {
        URL.revokeObjectURL(u)
      } catch {
        /* 忽略 */
      }
    }
    shotUrls = []
  }

  /** 一条档案 → 视图用的 CamShot（两份 objectURL：缩略图 / 原图） */
  function toCamShot(rec: ShotRecord): CamShot {
    const make = (b: Blob): string => {
      if (typeof URL.createObjectURL !== 'function') return ''
      const u = URL.createObjectURL(b)
      shotUrls.push(u)
      return u
    }
    return {
      id: rec.key,
      at: rec.at,
      slot: rec.slot,
      size: rec.size,
      channelId: rec.channelId,
      thumb: make(rec.thumb),
      url: make(rec.full),
    }
  }

  /**
   * 查询某天某点位的抓拍。**这里是唯一的数据接入点。**
   *
   * 服务端能力（《监控快照接口使用说明》+ 2026-11-19 实测）：
   *   · 只有 `GET /api/video/snapshots?pid&channelId` 一种，回**最近一帧**；
   *   · 带 `date` / `startTime` 之类参数直接 400「不支持的查询参数」；
   *   · `/snapshots/history`、`/list`、`/records`、`/count` 全 404。
   *
   * 所以流程是：
   *   ① 先读本机档案 → 本机有的照片立刻上屏（不等网络）；
   *   ② 选中的是**今天**时，再真请求一次快照，按「更新档」存进档案
   *      （同档重复取到同样大小的字节不覆盖，时刻保持第一次看到的那个），落档后重画；
   *   ③ 今天请求失败但档案里有旧记录 → 照常显示，只在说明里提一句失败。
   *
   * 将来万方开了历史接口，只改 ② 这一段（换成 `fetchCamShots(channelId, day)`），
   * 视图、日期芯片、日历、详情弹层都不用动。
   */
  async function loadShots(): Promise<void> {
    const id = camId.value
    if (!id) return
    const day = dateKey(shotDate.value)
    const isToday = day === dateKey(new Date())

    shotInflight?.abort()
    const ac = new AbortController()
    shotInflight = ac
    const my = ++shotSeq

    releaseShotUrls()
    shots.value = []
    shotPopId.value = ''
    shotsState.value = 'loading'
    shotsNote.value = ''

    /** 把一批档案铺到页面上（`keepWhenEmpty` 为真时不清掉已经显示的照片） */
    const paint = async (keepWhenEmpty = false): Promise<boolean> => {
      const recs = await listShots(id, day)
      if (my !== shotSeq) return false
      if (!recs.length && keepWhenEmpty) return false
      releaseShotUrls()
      shots.value = recs.map(toCamShot)
      return true
    }

    /**
     * ① 先出档案：本机有的照片立刻显示，不等网络。
     * 手机在工地上网慢，为了「取最新一帧」让整页转好几秒是不划算的。
     */
    let shown = false
    try {
      shown = await paint()
      if (my !== shotSeq) return
      if (shown) {
        shotsState.value = 'ok'
      }
    } catch {
      /* 档案读不出来不致命，下面还会试接口 */
    }

    /**
     * ② 今天再补一次最新：真请求 `/api/video/snapshots`，落档后重画。
     * 别的日期不发请求 —— 服务端没有按天查询这回事。
     */
    let snapErr = ''
    if (isToday) {
      try {
        const blob = await fetchCamSnapshot(id, ac.signal)
        if (my !== shotSeq) return
        await saveShot(id, blob)
        if (my !== shotSeq) return
        shown = (await paint(true)) || shown
      } catch (e) {
        if (ac.signal.aborted || (e as Error)?.name === 'AbortError') return
        if (my !== shotSeq) return
        snapErr = (e as Error)?.message || '监控画面获取失败'
      }
    }
    if (my !== shotSeq) return

    if (shots.value.length) {
      shotsState.value = 'ok'
      shotsNote.value = snapErr ? `最近一帧获取失败（${snapErr}），下面是已留存的历史` : ''
    } else if (snapErr) {
      shotsState.value = 'error'
      shotsNote.value = snapErr
    } else {
      shotsState.value = 'empty'
      shotsNote.value = shotEmptyNote()
    }

    if (shotInflight === ac) shotInflight = null
  }

  /** 展开 / 收起日历（展开时把月份对齐到选中日，同设计稿 showCamCal） */
  function toggleShotCal(): void {
    shotCalOpen.value = !shotCalOpen.value
    if (shotCalOpen.value) shotCalMonth.value = monthStart(shotDate.value)
  }

  function setShotCalMonth(d: Date): void {
    // 月份也夹在区间内：日历上一月/下一月已经禁掉了越界，这里再兜一层，
    // 防止别的入口（键盘、将来补的快捷跳转）把月份翻出可选范围。
    const m = monthStart(d)
    const lo = monthStart(shotMinDate.value).getTime()
    const hi = monthStart(shotMaxDate.value).getTime()
    const t = m.getTime()
    shotCalMonth.value = t < lo ? new Date(lo) : t > hi ? new Date(hi) : m
  }

  /**
   * 切日期（今天 / 昨天 / 日历选中的某天）。
   *
   * **日期范围校验的唯一裁决点**：芯片、日历、以后可能补的别的入口都走这里，
   * 规则只维护一处。只接受「近 {@link SHOT_RANGE_DAYS} 天」内的日期，
   * 越界即拦下并说明原因，返回是否真的切了 —— 拦下时保持原来的日期与列表，
   * 不闪空态、也不发多余请求。
   */
  function setShotDate(d: Date): boolean {
    const day = startOfDay(d)
    const t = day.getTime()
    if (t > shotMaxDate.value.getTime()) {
      shell.showToast('不能查看未来日期的抓拍', 'warn')
      return false
    }
    if (t < shotMinDate.value.getTime()) {
      shell.showToast(
        `只能查看近 ${SHOT_RANGE_DAYS} 天（${md(shotMinDate.value)} 起）的抓拍`,
        'info',
      )
      return false
    }
    shotDate.value = day
    shotCalOpen.value = false
    shotCalMonth.value = monthStart(day)
    shotPopId.value = ''
    shotShowFull.value = false
    void loadShots()
    return true
  }

  /** 打开历史抓拍视图（设计稿里画面视图与抓拍视图互斥） */
  function openShots(): void {
    shotsOpen.value = true
    shotCalOpen.value = false
    shotDate.value = startOfDay(new Date())
    shotCalMonth.value = monthStart(shotDate.value)
    shotPopId.value = ''
    shotShowFull.value = false
    void loadShots()
  }

  function closeShots(): void {
    shotsOpen.value = false
    shotCalOpen.value = false
    shotPopId.value = ''
    shotShowFull.value = false
    shotInflight?.abort()
    shotInflight = null
    shotSeq += 1
    releaseShotUrls()
    shots.value = []
    shotsState.value = 'idle'
    shotsNote.value = ''
  }

  /** 打开一张抓拍的大图（从压缩预览起步，与智眸一致） */
  function openShot(id: string): void {
    if (!shots.value.some((s) => s.id === id)) return
    shotShowFull.value = false
    shotPopId.value = id
  }

  function closeShot(): void {
    shotPopId.value = ''
    shotShowFull.value = false
  }

  /** 详情里切「查看原图」（原图就在本机档案里，切换是即时的） */
  function showShotFull(): void {
    if (!shotPop.value) return
    shotShowFull.value = true
  }

  function setCamLand(on: boolean): void {
    shell.isLandscape = on
    shell.isLand = on
  }

  /**
   * 取当前点位的画面。
   *
   * - 已有缓存且不是 `force` → 不再请求（来回切点位不重复下 200~500KB）；
   * - 切点位时 abort 上一次 —— 慢请求回来得晚也不会盖掉新点位的图；
   * - 失败只记状态与原因，页面给重试按钮，不清掉别的点位已取到的画面。
   */
  async function load(force = false): Promise<void> {
    const id = camId.value
    if (!id) return
    if (!force && frames.value[id]) {
      state.value = 'ok'
      note.value = ''
      return
    }

    inflight?.abort()
    const ac = new AbortController()
    inflight = ac
    const my = ++seq
    state.value = 'loading'
    note.value = ''

    try {
      const blob = await fetchCamSnapshot(id, ac.signal)
      if (my !== seq) return
      if (typeof URL.createObjectURL !== 'function') throw new Error('当前环境不支持 objectURL')
      const url = URL.createObjectURL(blob)
      const prev = frames.value[id]
      frames.value = { ...frames.value, [id]: { url, at: Date.now() } }
      if (prev && prev.url !== url) URL.revokeObjectURL(prev.url)
      state.value = 'ok'
    } catch (e) {
      // 自己取消的（切了点位 / 关了页面）不算失败
      if (ac.signal.aborted || (e as Error)?.name === 'AbortError') return
      if (my !== seq) return
      state.value = 'error'
      note.value = (e as Error)?.message || '监控画面获取失败'
    } finally {
      if (inflight === ac) inflight = null
    }
  }

  /** 手动刷新当前画面（页面上的「刷新」；快照更新后想立刻看到最新一张时用） */
  function refresh(): void {
    void load(true)
  }

  /**
   * 切点位。
   *
   * 不做 `keepLive` 之类的判断 —— 切过去就是取那张图；若新点位有直播流，
   * 播放态复位成 idle，等用户按播放键重新起播（`<video>` 也会按 key 重挂）。
   */
  function applyCam(id: string): void {
    if (!findCamPoint(id)) return
    if (id === camId.value && frames.value[id]) return
    camId.value = id
    resetPlay()
    closeShots()
    void load()
  }

  /** 打开监控层（入口：工作台「视频监控」）。未登录先去登录，不摆空播放器 */
  function openCam(id?: string): void {
    if (!auth.isLoggedIn) {
      useSubpageStore().openLogin('登录后可查看现场监控')
      return
    }
    const air = useAirHazardStore()
    air.closeAir()
    air.closeHazard()
    setCamLand(false)
    if (id && findCamPoint(id)) camId.value = id
    resetPlay()
    closeShots()
    isOpen.value = true
    void load()
    void loadManifest()
  }

  function closeCam(): void {
    setCamLand(false)
    resetPlay()
    closeShots()
    isOpen.value = false
  }

  /** 撤掉所有 objectURL（登出 / 换账号时用；单张 200~500KB，攒着没意义） */
  function clearFrames(): void {
    for (const f of Object.values(frames.value)) URL.revokeObjectURL(f.url)
    frames.value = {}
    state.value = 'idle'
    note.value = ''
    resetPlay()
    closeShots()
    shotInflight?.abort()
    shotInflight = null
    shotSeq += 1
    shots.value = []
    shotsState.value = 'idle'
    shotsNote.value = ''
    shotPopId.value = ''
    shotShowFull.value = false
    // 抓拍档案也是按会话存的：登出后下一个人不该看到上一个人的现场照
    void clearShotArchive()
    inflight?.abort()
    inflight = null
  }

  // 会话失效就清画面：现场监控不该留给下一个人
  watch(
    () => auth.token,
    (t) => {
      if (!t) clearFrames()
    },
  )

  return {
    isOpen,
    camId,
    points,
    current,
    grouped,
    state,
    note,
    frameUrl,
    frameAt,
    monitorList,
    manifestSource,
    loadManifest,
    playUrl,
    playMode,
    rtspUrl,
    isLive,
    playState,
    playNote,
    isPlaying,
    markPlaying,
    markConnecting,
    markReconnecting,
    markBuffering,
    markPaused,
    markPlayError,
    resetPlay,
    shotsOpen,
    shots,
    shotsState,
    shotsNote,
    shotsHint,
    shotDate,
    shotDateLabel,
    shotMinDate,
    shotMaxDate,
    shotCalOpen,
    shotCalMonth,
    shotPopId,
    shotPopOpen,
    shotPop,
    shotShowFull,
    loadShots,
    openShots,
    closeShots,
    setShotDate,
    toggleShotCal,
    setShotCalMonth,
    openShot,
    closeShot,
    showShotFull,
    setCamLand,
    load,
    refresh,
    applyCam,
    openCam,
    closeCam,
    clearFrames,
  }
})
