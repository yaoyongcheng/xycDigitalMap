import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import {
  fetchCamShotHistory,
  SHOT_PAGE_SIZE,
  SHOT_RANGE_DAYS,
  SNAP_UPDATE_HOURS,
  type CamShotItem,
} from '@/api/camsnap'
import { findMonitorEntry, loadMonitorList, pickStreamUrl, type MonitorEntry } from '@/api/cctv'
import { CAM_GROUPS, CAM_POINTS, findCamPoint } from '@/data/cams'
import { cctvPlayableUrl, cctvRtspUrl, streamModeOf, type StreamMode } from '@/data/cctv'
import { addDays, dateKey, formatCamDate, monthStart, startOfDay } from '@/utils/date'
import {
  clearShots as clearShotArchive,
  ensureShot,
  listCachedShots,
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
 * 点位是写死的 9 个白名单（`data/cams.ts`），分「设备设施 / 材料堆场 /
 * 出入口管控」三组；画面一律来自直播流（`data/cctv.ts` 按通道拼的 HTTP-FLV，
 * 生命周期在 `utils/flvStream.ts`）。
 *
 * ## 不再取定时快照（2026-11-20 晚）
 *
 * 旧实现每打开一个点位就 GET 一次 `/api/video/snapshots?pid&channelId` 取「最近
 * 一帧」，再把它当 `<video poster>` 和断流时的兜底图。该接口已随历史接口上线下线：
 *   · 画面只留直播流 —— 连不上就是空的，不再拿一张定时图冒充「现场画面」；
 *   · 要「这台相机最近的照片」走历史抓拍（`loadShots` → `/snapshots/history`），
 *     与首页智眸同一套数据源。
 *
 * ## 状态只留「当前点位」一份
 *
 * 一次只显示一个画面，播放态（`playState / playNote`）是单份而不是按通道存：
 * 切点位时复位，不把上一个点位的「在播」带过来。
 */

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
 * 为什么单独留一个 `reconnecting`：重连期间画面蒙着、说明条写「在恢复」，
 * 与「暂停 / 播放」是两种语义。混进 `buffering` 的话，状态会在
 * 三角和转圈之间来回跳，用户以为点坏了。
 */
export type CamPlayState = 'idle' | 'buffering' | 'reconnecting' | 'playing' | 'paused' | 'error'

/**
 * 一张历史抓拍。
 *
 * 字段以服务端历史列表为准（`mark` / 抓拍时刻 / 字节数），本机只补两样东西：
 * 图片的 objectURL（列表用缩略图、详情用原图）与「这张图还没取回来」的状态。
 */
export interface CamShot {
  /** 主键 = 服务端 `mark`（`YYYYMMDDHHmmss`，同通道唯一） */
  id: string
  /** 同上，单独留一份便于排查 */
  mark: string
  /** 压缩预览（列表用，长边 480 的 WebP；未取回时为空串） */
  thumb: string
  /** 原图（详情「查看原图」用；未取回时为空串） */
  url: string
  /** 抓拍时刻（ms，服务端给的） */
  at: number
  /** 抓拍时刻（'HH:mm'，列表标签直接用） */
  hm: string
  /** 原图字节数（服务端声明） */
  size: number
  /** 所属点位 */
  channelId: string
  /** 图片本身的状态（元信息先上屏，图逐张补） */
  state: 'loading' | 'ok' | 'error'
}

/**
 * 历史抓拍的可查范围：以今天为基准的**近 30 天**（含今天）。
 *
 * 跟服务端的口径对齐（文档：北京时间近 30 个自然日），越界请求会被服务端 400，
 * 所以日期芯片 / 日历必须在这里就先拦下来，别把用户送进一次必然失败的请求。
 */
export { SHOT_RANGE_DAYS }

export const useCamStore = defineStore('cam', () => {
  const shell = useShellStore()
  const auth = useAuthStore()

  const isOpen = ref(false)

  /** 当前点位（channelId）。默认第一个，关掉再开保持上次选择 */
  const camId = ref<string>(CAM_POINTS[0].channelId)

  const points = CAM_POINTS

  const current = computed(() => findCamPoint(camId.value) ?? CAM_POINTS[0])

  /** 分组（空组不出现在页面上，`h5` 里的数字是这一组的点位数） */
  const grouped = computed(() =>
    CAM_GROUPS.map((name) => ({ name, items: points.filter((p) => p.group === name) })).filter(
      (g) => g.items.length > 0,
    ),
  )

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
   * 流打不开：记下**引擎给的具体原因**。
   *
   * 这不是「放弃」—— `msg` 里已经写明还会继续自动重连、点画面可以立即重试；
   * 流一旦回来，引擎会再抛 `playing` 把这里盖掉。
   */
  function markPlayError(msg = ''): void {
    playState.value = 'error'
    playNote.value = msg || '直播流连接失败，正在自动重连'
  }

  /** 切点位/关层时复位，别把上一个点位「正在播放」带过来 */
  function resetPlay(): void {
    playState.value = 'idle'
    playNote.value = ''
  }

  /* ---------------- 历史抓拍（2026-11-20：走服务端历史接口） ---------------- */

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
   * 这个区间与服务端的「近 30 个自然日」逐日对齐（实测 rangeStart = 今天 - 29）。
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
   * 更新节奏来自接口文档（每天 08:00 / 12:00 / 18:00 由服务端逐通道更新，不是整点
   * 同时完成），「当天 N 张」是这次列表真的返回了几张 —— 有的通道三张、有的通道
   * 服务端没有历史索引一张没有，所以数字以接口为准，不写死 3。
   */
  const shotsHint = computed(() => {
    const hours = SNAP_UPDATE_HOURS.join(' / ')
    return `每天 ${hours} 点更新 · 当天 ${shots.value.length} 张`
  })

  /** 'M月D日'（区间说明里的人话日期） */
  function md(d: Date): string {
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }

  /** 'HH:mm'（列表标签、详情标题都用它） */
  function hmOf(at: number): string {
    const d = new Date(at)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  /** 空态那句话（今天 / 历史日口径不同） */
  function shotEmptyNote(): string {
    if (shotDateLabel.value === '今天') {
      return '服务端今天还没有这个点位的历史抓拍（相机离线，或今天的几次更新都没成功）。点下面「重新获取」再查一次。'
    }
    return `服务端只保留近 ${SHOT_RANGE_DAYS} 天（${md(shotMinDate.value)} 起）的抓拍，这一天没有记录。`
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

  function revokeShotUrl(u: string): void {
    if (!u) return
    try {
      URL.revokeObjectURL(u)
    } catch {
      /* 忽略 */
    }
    const i = shotUrls.indexOf(u)
    if (i >= 0) shotUrls.splice(i, 1)
  }

  /** blob → objectURL（登记到 `shotUrls`，重查 / 关层统一撤） */
  function makeShotUrl(b: Blob): string {
    if (typeof URL.createObjectURL !== 'function') return ''
    const u = URL.createObjectURL(b)
    shotUrls.push(u)
    return u
  }

  /** 列表行（元信息）→ 视图：图还没取回来，先摆时刻与张数 */
  function metaShot(item: CamShotItem, channelId: string): CamShot {
    return {
      id: item.mark,
      mark: item.mark,
      thumb: '',
      url: '',
      at: item.at,
      hm: hmOf(item.at),
      size: item.size,
      channelId,
      state: 'loading',
    }
  }

  /** 缓存记录 → 视图（两份 objectURL：缩略图 / 原图） */
  function toCamShot(rec: ShotRecord): CamShot {
    return {
      id: rec.mark,
      mark: rec.mark,
      thumb: makeShotUrl(rec.thumb),
      url: makeShotUrl(rec.full),
      at: rec.at,
      hm: hmOf(rec.at),
      size: rec.size,
      channelId: rec.channelId,
      state: 'ok',
    }
  }

  /** 就地替换一条（`shots` 是 ref 数组，整体换引用才触发渲染） */
  function patchShot(mark: string, fn: (s: CamShot) => CamShot): void {
    const i = shots.value.findIndex((s) => s.mark === mark)
    if (i < 0) return
    const next = shots.value.slice()
    next[i] = fn(next[i])
    shots.value = next
  }

  /**
   * 取回一张抓拍图片（缓存优先）。
   *
   * 单张 200~340KB，文档要求「逐张请求、别并发占带宽」；这里用 2 路（与报警
   * 缩略图同口径）：三列网格里上屏够快，也不至于把现场上行打满。
   */
  async function loadShotImage(
    channelId: string,
    item: CamShotItem,
    signal: AbortSignal,
    alive: () => boolean,
  ): Promise<void> {
    try {
      const rec = await ensureShot(channelId, item, signal)
      if (!alive()) return
      const prev = shots.value.find((s) => s.mark === item.mark)
      if (prev) {
        revokeShotUrl(prev.thumb)
        revokeShotUrl(prev.url)
      }
      patchShot(item.mark, (s) => ({
        ...s,
        thumb: makeShotUrl(rec.thumb),
        url: makeShotUrl(rec.full),
        size: rec.size,
        state: 'ok',
      }))
    } catch (e) {
      if (!alive()) return
      // 自己取消的不算失败；内部的 12s 超时（同样是 AbortError）要给「重试」，
      // 不能留一张永远转圈的格子。
      if ((e as Error)?.name === 'AbortError' && signal.aborted) return
      patchShot(item.mark, (s) => ({ ...s, state: 'error' }))
    }
  }

  /** 把一页里所有图片按 2 路并发补上（元信息已经在屏上了） */
  async function loadShotImages(
    channelId: string,
    items: CamShotItem[],
    signal: AbortSignal,
    alive: () => boolean,
  ): Promise<void> {
    const queue = items.slice()
    const worker = async (): Promise<void> => {
      for (;;) {
        const it = queue.shift()
        if (!it || !alive()) return
        await loadShotImage(channelId, it, signal, alive)
      }
    }
    await Promise.all([worker(), worker()])
  }

  /**
   * 查询某天某点位的抓拍。**这里是历史抓拍的唯一数据接入点。**
   *
   * 文档（《监控快照接口.docx》）：`GET /api/video/snapshots/history?pid&channelId&page&pageSize[&date]`，
   * `data.items` 是当前页、`data.total` 是总数；`date` 只支持北京时间近 30 天，
   * `pageSize` 最大 100 —— 一天最多 3~7 张，所以一次取满不翻页。
   *
   * 流程：
   *   ① 调历史列表 → **元信息先上屏**（时刻、张数立刻是真的）；
   *   ② 图片逐张补（缓存优先、2 路并发），补一张亮一张；
   *   ③ 列表为空就是「这一天没有」—— 不再退「最近一帧」（那个接口已下线）；
   *   ④ 接口整体失败 → 有本机缓存就摆缓存并说明「这是缓存」，没有才报错。
   *
   * 图片地址一律用服务端行里的 `imageUrl`（拼测试环境入口 + 带 `X-API-Key`），
   * **不自己拼 mark** —— 这是文档明确要求的一条。
   */
  async function loadShots(): Promise<void> {
    const id = camId.value
    if (!id) return
    const day = dateKey(shotDate.value)

    shotInflight?.abort()
    const ac = new AbortController()
    shotInflight = ac
    const my = ++shotSeq
    const alive = (): boolean => my === shotSeq && !ac.signal.aborted

    releaseShotUrls()
    shots.value = []
    shotPopId.value = ''
    shotShowFull.value = false
    shotsState.value = 'loading'
    shotsNote.value = ''

    /** 收尾：放开 inflight，别让「加载中」把下一次查询挡住 */
    const done = (): void => {
      if (shotInflight === ac) shotInflight = null
    }

    let items: CamShotItem[] = []
    try {
      const page = await fetchCamShotHistory(
        id,
        { date: day, page: 1, pageSize: SHOT_PAGE_SIZE },
        ac.signal,
      )
      if (!alive()) return
      items = page.items
    } catch (e) {
      if (!alive()) return
      const timedOut = (e as Error)?.name === 'AbortError'
      // 只有「自己取消的」才安静退出（切日期 / 关层 / 换点位）；
      // 内部 10s 超时也是 AbortError，但它得落到失败态，否则页面一直转圈。
      if (timedOut && ac.signal.aborted) return
      const why = timedOut ? '监控服务响应超时' : (e as Error)?.message || '抓拍获取失败'
      // 接口挂了：本机缓存里这一天的照片还能看（`mark` / 时刻都是服务端给过的真值），
      // 说明一句「这是缓存」，不拿别的日期顶替。
      const cached = await listCachedShots(id, day)
      if (!alive()) return
      if (cached.length) {
        shots.value = cached.map(toCamShot)
        shotsState.value = 'ok'
        shotsNote.value = `服务端暂时取不到（${why}），下面是本机缓存的抓拍`
      } else {
        shotsState.value = 'error'
        shotsNote.value = why
      }
      done()
      return
    }

    if (!items.length) {
      shotsState.value = 'empty'
      shotsNote.value = shotEmptyNote()
      done()
      return
    }

    // ① 元信息先上屏 ② 图片逐张补
    shots.value = items.map((it) => metaShot(it, id))
    shotsState.value = 'ok'
    await loadShotImages(id, items, ac.signal, alive)
    if (!alive()) return
    done()
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

  /**
   * 打开一张抓拍的大图（从压缩预览起步，与智眸一致）。
   *
   * 图还没取回来（或上次失败）时不硬开一张空白大图：重查这一天 —— 缓存已经在
   * 本机的会立刻上屏，没取到的重新下一张。
   */
  function openShot(id: string): void {
    const s = shots.value.find((x) => x.id === id)
    if (!s) return
    if (s.state !== 'ok') {
      void loadShots()
      return
    }
    shotShowFull.value = false
    shotPopId.value = id
  }

  function closeShot(): void {
    shotPopId.value = ''
    shotShowFull.value = false
  }

  /** 详情里切「查看原图」（原图已随缩略图一起落本机缓存，切换是即时的） */
  function showShotFull(): void {
    if (!shotPop.value) return
    shotShowFull.value = true
  }

  function setCamLand(on: boolean): void {
    shell.isLandscape = on
    shell.isLand = on
  }

  /**
   * 切点位。
   *
   * 不做 `keepLive` 之类的判断 —— 切过去就是取那张图；若新点位有直播流，
   * 播放态复位成 idle，等用户按播放键重新起播（`<video>` 也会按 key 重挂）。
   */
  function applyCam(id: string): void {
    if (!findCamPoint(id)) return
    if (id === camId.value) return
    camId.value = id
    resetPlay()
    closeShots()
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
    void loadManifest()
  }

  function closeCam(): void {
    setCamLand(false)
    resetPlay()
    closeShots()
    isOpen.value = false
  }

  /** 登出 / 换账号：抓拍列表、objectURL、本机档案都不留给下一个人 */
  function clearAll(): void {
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
  }

  // 会话失效就清画面：现场监控不该留给下一个人
  watch(
    () => auth.token,
    (t) => {
      if (!t) clearAll()
    },
  )

  return {
    isOpen,
    camId,
    points,
    current,
    grouped,
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
    applyCam,
    openCam,
    closeCam,
    clearAll,
  }
})
