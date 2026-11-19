import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchAlarmPicture, fetchVideoAlarms } from '@/api/video'
import { ApiError } from '@/api/http'
import { addDays, dateKey, dayOffsetOf, startOfDay } from '@/utils/date'
import { shrinkDataUrl } from '@/utils/imageThumb'
import { clearThumbCache, readThumb, writeThumb } from '@/utils/thumbCache'
import { relTime, remoteIdOf, toAlarms } from '@/utils/videoAlarm'
import type { TrendPoint } from '@/utils/chart'
import type { Alarm, MapAlarm } from '@/types'

/**
 * 巡检预警
 *
 * **只存真实数据**（2026-11 接口迁移收口）。
 *
 * 此前这里内置 8 条演示种子，接口失败/未登录时首页照样「有内容」。问题是
 * 演示数字与现场完全对不上，而且没有任何视觉标识说明它是假的 —— 现场拿着
 * 「今日 4 条预警」去对账，服务端实际 8 条，比空着更糟。现在改为：
 *   · 没有任何真实数据时就是空，页面显示「暂无数据 / 登录后查看」；
 *   · 接口失败保留已拉到的数据 + 错误态，不用假数据顶替；
 *   · 会话清空时一并清掉（`clearLive`，由 auth store 调用）。
 *
 * 数据源：A′ 组 `:8085 /api/video/alarms`（唯一有真实报警的接口，需 Bearer）。
 * 一次拉 2 页共 400 条（`page_size` 上限 200），覆盖约一个月 —— 近 7 日趋势与
 * 历史页按日查看都在范围内；用户翻到更早的日期时按需回补（`ensureDate`）。
 */

/** 单页上限（服务端实测上限 200） */
const PAGE_SIZE = 200

/** 首屏并发拉的页数：400 条 ≈ 一个月，够趋势图与历史页默认视图 */
const FIRST_PAGES = 2

/** 按需回补的总页数上限：1807 条全量在手机上没必要，8 页 ≈ 4 个月 */
const MAX_PAGES = 8

/** 今日 0 条时轮播退到最近几条（2 页 × 3 条） */
const FEED_FALLBACK_N = 6

/** 近 7 日趋势的天数 */
const TREND_DAYS = 7

/** 失败冷却：60s 内不重复打，避免用户在首页反复切面板时打爆接口 */
const RETRY_MS = 60_000

/** 相对时间在「筛选时」重算：`toAlarms` 只在拉取那一刻算过一次，挂久了会停在「3分钟前」 */
function withRel(a: Alarm): Alarm {
  return { ...a, rel: relTime(a.at) || a.rel }
}

/**
 * 是否值得预取缩略图。
 *
 * 现场大多数是 4G / wifi；省流模式与 2G/3G 下不预取 —— 为了「首屏快一点」
 * 替用户多花几 MB 流量不划算。`navigator.connection` 在 iOS Safari 上没有，
 * 这时按「可以」处理：今日最新 4 张本来就要看，提前拉不算浪费。
 */
function canPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false
  const c = (navigator as unknown as {
    connection?: { saveData?: boolean; effectiveType?: string }
  }).connection
  if (!c) return true
  if (c.saveData) return false
  return !/^(slow-)?2g$|^3g$/.test(String(c.effectiveType || ''))
}

/**
 * 缩略图并发数。
 *
 * 单张约 1MB，2 路并发在 4G 上大约 1~2s 一张；再多会让首屏那几张互相抢带宽，
 * 反而更慢。实测 2 路时列表第一屏的图在 3s 内陆续出来。
 *
 * 2026-11-19 复测补充：4 路并发时每张要 8~10s（单张串行只要 2.7~3.4s），
 * 说明这条链路的瓶颈是带宽而不是连接数 —— **不要调高**，调高只会让第一张更晚。
 * 真正省时间的是「不重复下载」：`utils/thumbCache.ts` 落盘 + 首屏预取。
 */
const THUMB_PARALLEL = 2

/** 网络类失败（超时 / 断网）的重试间隔：这类失败不是结论，滚回来还要再试 */
const THUMB_RETRY_MS = 30_000

/** 首屏预取条数（只取今日最新几条 —— 正好是消息页 / 预警列表打开时最上面那几行） */
const PREFETCH_N = 4

export const useAlarmStore = defineStore('alarm', () => {
  /* ---------- 真实报警 ---------- */

  /** 接口拉回来的真实报警（时间倒序，累积多页） */
  const liveAlarms = ref<Alarm[]>([])

  /** 拉取状态：页面据此决定显示「加载中 / 暂无数据 / 加载失败」 */
  const liveState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle')

  /** 最近一次失败原因（成功时清空） */
  const liveError = ref('')

  /** 服务端报告的总条数（分页用；0 = 还不知道） */
  const total = ref(0)

  /** 已成功加载的页数（`ensureDate` 的游标） */
  const pagesLoaded = ref(0)

  let liveTriedAt = 0

  /** 有没有拿到过真实报警 */
  const hasLive = computed(() => liveAlarms.value.length > 0)

  /** 已加载数据里最早的一天（YYYY-MM-DD），空数据时为 '' */
  const earliestDay = computed(() =>
    liveAlarms.value.length ? liveAlarms.value[liveAlarms.value.length - 1].at.slice(0, 10) : '',
  )

  /**
   * 把一批数据并进现有集合。
   *
   * 用 id 去重：回补更早的页时难免与上一批重叠（服务端没有稳定游标，
   * 拉取期间新报警会把整页往后挤），重复项留在列表里会变成两条一样的卡片。
   */
  function merge(incoming: Alarm[]): void {
    if (!incoming.length) return
    const map = new Map<string, Alarm>()
    for (const a of liveAlarms.value) map.set(a.id, a)
    for (const a of incoming) map.set(a.id, a)
    liveAlarms.value = [...map.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }

  /**
   * 拉指定的一段页码，并发发出。
   *
   * 用 `allSettled`：中间某一页 500 不该把已拿到的几页一起丢掉，那正是
   * 「翻历史翻到一半突然空了」的由来。整段全失败才抛错。
   */
  async function fetchPages(token: string, from: number, count: number): Promise<number> {
    const reqs = Array.from({ length: count }, (_, i) =>
      fetchVideoAlarms(token, { page: from + i, pageSize: PAGE_SIZE }),
    )
    const settled = await Promise.allSettled(reqs)
    const got: Alarm[] = []
    let okPages = 0
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue
      okPages += 1
      total.value = Math.max(total.value, r.value.total)
      got.push(...toAlarms(r.value.rows))
    }
    if (!okPages) {
      const first = settled.find((r) => r.status === 'rejected')
      throw first && first.status === 'rejected' ? first.reason : new Error('报警同步失败')
    }
    merge(got)
    return okPages
  }

  /**
   * 从视频报警接口同步真实报警（登录后 / 进首页时调用）。
   *
   * 失败保留现有数据并记录原因；一次失败后 `RETRY_MS` 内不重试。
   * 返回是否取到了数据，便于调用方决定要不要提示。
   */
  async function syncFromVideo(token: string, force = false): Promise<boolean> {
    if (!token) return false
    if (liveState.value === 'loading') return false
    if (!force && liveState.value === 'error' && Date.now() - liveTriedAt < RETRY_MS) return false
    // 已经成功同步过就直接复用：首页安全面板（onMounted + watch token）与
    // 消息页（刷新后直接落在消息 tab）都会触发这里，不拦的话首屏 400 条
    // 会被来回打好几遍，现场网络下纯属浪费
    if (!force && liveState.value === 'ok' && liveAlarms.value.length) return true

    liveState.value = 'loading'
    liveTriedAt = Date.now()
    try {
      pagesLoaded.value = await fetchPages(token, 1, FIRST_PAGES)
      liveState.value = 'ok'
      liveError.value = ''
      // 数据到手就把首屏那几张图排上队（详见 prefetchThumbs 的三条闸门）
      prefetchThumbs(token)
      return liveAlarms.value.length > 0
    } catch (err) {
      liveState.value = 'error'
      liveError.value = err instanceof Error ? err.message : '报警同步失败'
      return false
    }
  }

  /**
   * 切回智巡面板时的刷新（首页标签切换会调用）。
   *
   * 与 `syncFromVideo(token, true)` 的区别：**失败冷却仍生效** ——
   * 连点标签时不该把注定失败的请求反复打出去；页面上的「重试」按钮
   * 才走 force 版本。成功过的也要重拉：现场报警是持续新增的，
   * 切回来看到的应该是此刻的今日条数与趋势。
   */
  async function refresh(token: string): Promise<boolean> {
    if (!token) return false
    if (liveState.value === 'error' && Date.now() - liveTriedAt < RETRY_MS) return false
    return syncFromVideo(token, true)
  }

  /**
   * 按需回补更早的历史（历史页翻月历时用）。
   *
   * 目标日期已在已加载范围内就直接返回 —— 绝大多数点击都是这种情况，
   * 不该为此再打一趟网络。真需要更早的数据才逐页往回拉，最多 `MAX_PAGES`。
   */
  async function ensureDate(token: string, d: Date): Promise<void> {
    if (!token || liveState.value === 'loading') return
    const need = dateKey(d)
    if (earliestDay.value && need >= earliestDay.value) return
    if (total.value && pagesLoaded.value * PAGE_SIZE >= total.value) return
    if (pagesLoaded.value >= MAX_PAGES) return

    liveState.value = 'loading'
    try {
      while (pagesLoaded.value < MAX_PAGES) {
        const from = pagesLoaded.value + 1
        const ok = await fetchPages(token, from, 1)
        pagesLoaded.value = from
        const earliest = earliestDay.value
        // 该页没数据（到底了）/ 已覆盖目标日 / 已追上 total，三种情况都可停
        if (!ok || (earliest && earliest <= need) || (total.value && pagesLoaded.value * PAGE_SIZE >= total.value)) break
      }
      liveState.value = 'ok'
      liveError.value = ''
    } catch (err) {
      liveState.value = 'error'
      liveError.value = err instanceof Error ? err.message : '报警同步失败'
    }
  }

  /**
   * 把外部（消息页按 20 条/页分页查询）拿到的真实报警并入集合。
   *
   * 消息页有自己的小页游标，不能复用 `pagesLoaded`（那是首屏 200 条/页的口径），
   * 但拉回来的报警必须进这里 —— 否则点消息进详情时 `byId()` 找不到、抓拍图也
   * 拉不到。`total` 取两者较大值，避免小页查询把服务端总数改小。
   */
  function appendLive(incoming: Alarm[], totalCount = 0): void {
    if (totalCount > 0) total.value = Math.max(total.value, totalCount)
    merge(incoming)
  }

  /* ---------- 抓拍缩略图（列表 / 消息 / 首页轮播的图标位） ---------- */

  /**
   * 图标位改成「与详情页同一张抓拍图」的缩略图（2026-11-19 现场要求）。
   *
   * 为什么收在 store 里而不是各页各取：
   *   · 同一条报警会同时出现在首页轮播、消息页、报警预警列表，各取一次就是
   *     三份 1MB 的 base64；
   *   · 抓拍图接口单张约 1MB，必须限制并发（{@link THUMB_PARALLEL}），否则
   *     一屏 8 条同时拉会把现场网络打满；
   *   · 登出必须一起清掉（见 {@link clearLive}），不能让下一个人看到现场照片。
   *
   * 取不到（该报警确实没有抓拍图 / 未登录 / 不是视频报警）只记一笔、不再重试，
   * 列表退回**统一占位图标**（`.alarm-tile`：灰底 + 深灰摄像机），不会变成破图。
   * 取图过程中占位图标外圈会显示真实下载进度（见 {@link thumbPctOf}）。
   */
  const thumbs = ref<Record<string, string>>({})

  /** 取失败（**确实没有抓拍图**）的 id：结论性的失败，永久不再重试 */
  const thumbFailed = new Set<string>()

  /** 网络类失败（超时 / 断网）的 id → 可再次尝试的时刻 */
  const thumbRetryAt = new Map<string, number>()

  /** 排队中 / 请求中的 id：同一个点位在首页、消息、列表同时出现时只打一次 */
  const thumbWaiting = new Set<string>()
  const thumbQueue: string[] = []
  let thumbActive = 0

  /** 代际：清空（登出）之后，在途请求的结果一律丢弃 */
  let thumbGen = 0

  /** 缩略图（data URL）；空串 = 还没有，调用方据此退回统一占位图标 */
  function thumbOf(id: string): string {
    return thumbs.value[id] || ''
  }

  /**
   * 下载进度（0~100，缺省 = 还不知道）。
   *
   * 与 `thumbs` 分开放、且用 `reactive` 而不是整对象替换：进度是**高频写入**
   * 的（每收一个 chunk 就变一次），若也走 `thumbs.value = { ... }`，每条报警
   * 的进度更新都会让三处列表里所有图标的 computed 重新求值。`reactive` 下只有
   * 真正读这个 id 的组件会重渲染。
   */
  const thumbPct = reactive<Record<string, number>>({})

  /**
   * 该 id 此刻是否**真的在下载**（已过缓存查询、已发请求）。
   *
   * 排队中不算：队列里排着 20 条时，让 20 颗图标一起转圈会像整页都在加载；
   * 没开始就没有进度可报，保持灰底静止更诚实。
   */
  const thumbBusy = reactive<Record<string, boolean>>({})

  function thumbPctOf(id: string): number {
    return thumbPct[id] ?? 0
  }

  function thumbBusyOf(id: string): boolean {
    return thumbBusy[id] === true
  }

  /**
   * 某条报警的缩略图（幂等，可反复调）。
   *
   * `token` 由调用方传入而不是在这里 `useAuthStore()` —— auth store 反向
   * import 了本 store（登出时 clearLive），互相 import 会成环。
   */
  function ensureThumb(token: string, id: string): void {
    if (!token || !id) return
    if (thumbs.value[id] || thumbFailed.has(id) || thumbWaiting.has(id)) return
    // 上一次是超时 / 断网：冷却期内不重试，冷却过了允许再来一次（这类失败不是结论）
    const retryAt = thumbRetryAt.get(id) || 0
    if (retryAt && Date.now() < retryAt) return
    const target = byId(id)
    if (!target || !remoteIdOf(target)) return
    thumbWaiting.add(id)
    thumbQueue.push(id)
    pumpThumbs(token)
  }

  /**
   * 首屏预取（2026-11-19）。
   *
   * 为什么在同步成功后就开始拉：缩略图单张 820KB~1.3MB、实测 2.7~3.4s，
   * 等用户点进消息页 / 预警列表再拉，第一屏必然「先看到一排占位图标」。
   * 首页拿到报警数据时先把**今日最新 {@link PREFETCH_N} 条**排队，
   * 用户切过去时这几张通常已经在内存（或已落盘）里了。
   *
   * 三条闸门，避免把流量当不要钱：
   *   · 只在「非省流、非 2G/3G」时预取（{@link canPrefetch}）；
   *   · 只取今日最新几条（不是整页）—— 再多就变成替用户预载他没看的照片；
   *   · 走 `requestIdleCallback` 排队，不与首页自己的报警请求抢带宽。
   */
  function prefetchThumbs(token: string): void {
    if (!token || !canPrefetch()) return
    const list = liveAlarms.value.filter((a) => a.day === 'today').slice(0, PREFETCH_N)
    if (!list.length) return
    const kick = (): void => {
      for (const a of list) ensureThumb(token, a.id)
    }
    const ric = (
      globalThis as {
        requestIdleCallback?: (cb: () => void, opt?: { timeout: number }) => number
      }
    ).requestIdleCallback
    // 有 requestIdleCallback 就等空闲；没有（iOS Safari）立刻排队 ——
    // 此刻报警列表已经拉完，队列里只有缩略图，不存在抢带宽的问题。
    // 刻意**不用 setTimeout 兜底**：它会在组件卸载后继续触发，等于给已离开的页面拉图。
    if (ric) ric(kick, { timeout: 2500 })
    else kick()
  }

  function pumpThumbs(token: string): void {
    while (thumbActive < THUMB_PARALLEL && thumbQueue.length) {
      const id = thumbQueue.shift() as string
      thumbActive += 1
      void runThumb(token, id).finally(() => {
        thumbActive -= 1
        pumpThumbs(token)
      })
    }
  }

  async function runThumb(token: string, id: string): Promise<void> {
    const gen = thumbGen
    try {
      // ① 先看本机缓存：命中就不用走网络（一条只有 4~6KB，读出来是毫秒级）。
      //    这一步放在请求之前，是「第二次进页面秒出图」的全部原因。
      const hit = await readThumb(id)
      if (hit) {
        if (gen === thumbGen) thumbs.value = { ...thumbs.value, [id]: hit }
        return
      }

      const target = byId(id)
      const rid = target ? remoteIdOf(target) : ''
      if (!rid) return

      // ② 真开始下载了才点亮进度：接口 1MB、2~3s，图标位上要能看到它在一格一格动
      thumbBusy[id] = true
      const full = await fetchAlarmPicture(token, rid, undefined, (ratio) => {
        if (gen !== thumbGen) return
        const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100)
        // 4 个点以内不重渲染：一屏十几颗图标，每个 chunk 都写一遍纯属浪费
        if (pct < 100 && pct - (thumbPct[id] ?? 0) < 4) return
        thumbPct[id] = pct
      })
      // 缩略图只是优化：缩不了就把原图当缩略图用（见 utils/imageThumb.ts）
      const small = await shrinkDataUrl(full)
      // 期间登出过：这张照片不能再留在内存里
      if (gen !== thumbGen) return
      thumbs.value = { ...thumbs.value, [id]: small || full }
      // ② 缩略图落盘：下次进页面 / 下次冷启动直接命中，不再下 1MB
      writeThumb(id, small || full)
    } catch (err) {
      if (gen !== thumbGen) return
      // 「没有可用的抓拍图」是结论（服务端确实没存这张），永久不再重试；
      // 超时 / 断网是暂时的，冷却 30s 后滚回来还能再试一次 ——
      // 否则一条卡住的请求会让那一行永远停在占位图标上。
      if (err instanceof ApiError && /没有可用的抓拍图/.test(err.message)) thumbFailed.add(id)
      else thumbRetryAt.set(id, Date.now() + THUMB_RETRY_MS)
    } finally {
      thumbWaiting.delete(id)
      // 进度状态只服务于「还没图」的那一帧，图到了 / 放弃了就该清掉，
      // 不然一张列表滚过去会在 reactive 里留几百个死 key。
      delete thumbBusy[id]
      delete thumbPct[id]
    }
  }

  function clearThumbs(): void {
    thumbGen += 1
    thumbs.value = {}
    thumbFailed.clear()
    thumbRetryAt.clear()
    thumbWaiting.clear()
    thumbQueue.length = 0
    for (const k of Object.keys(thumbPct)) delete thumbPct[k]
    for (const k of Object.keys(thumbBusy)) delete thumbBusy[k]
    // 落盘的那份也要清：现场照片不能留给下一个登录的人
    void clearThumbCache()
  }

  /** 退出登录 / 清会话时把真实数据一并清掉，别让下一个人看到上一个人的现场 */
  function clearLive(): void {
    liveAlarms.value = []
    liveState.value = 'idle'
    liveError.value = ''
    total.value = 0
    pagesLoaded.value = 0
    liveTriedAt = 0
    clearThumbs()
  }

  /* ---------- 派生数据（全部只来自 liveAlarms） ---------- */

  /** 某日（YYYY-MM-DD）的全部报警，时间倒序 */
  function recordsOn(d: Date): Alarm[] {
    const key = dateKey(d)
    return liveAlarms.value.filter((a) => a.at.slice(0, 10) === key).map(withRel)
  }

  /** 今日报警 —— 首页计数 / 趋势 / 撒点共用，严格「今日」 */
  const latest = computed(() => recordsOn(new Date()))

  /**
   * 轮播专用数据源：今日为空时退到最近 6 条。
   *
   * 凌晨 / 停工日今日报警为 0 时，让轮播显示最近几条真实报警比留一张空卡片
   * 有用 —— 卡片自带「昨天 21:41」这样的时间，不会误导成今天的。
   */
  const feed = computed<Alarm[]>(() => {
    if (!latest.value.length) return liveAlarms.value.slice(0, FEED_FALLBACK_N).map(withRel)
    return latest.value
  })

  /**
   * 近 7 日预警趋势（真实按日聚合）。
   *
   * 没有数据的日子就是 0 —— 不再用固定的演示曲线描一条好看的上升线。
   * 横轴标签取 `M/D`，与接口无关，纯按本地日期生成。
   */
  const trend = computed<TrendPoint[]>(() => {
    const base = startOfDay(new Date())
    const out: TrendPoint[] = []
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const d = addDays(base, -i)
      const key = dateKey(d)
      const value = liveAlarms.value.filter((a) => a.at.slice(0, 10) === key).length
      out.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, value })
    }
    return out
  })

  /** 某日预警条数；未来日期返回 null（日历上不可选） */
  function dayCount(d: Date): number | null {
    if (dayOffsetOf(d) < 0) return null
    const key = dateKey(d)
    return liveAlarms.value.filter((a) => a.at.slice(0, 10) === key).length
  }

  /** 某日预警记录（历史页 / 巡检历史页） */
  function dayRecords(d: Date): Alarm[] {
    return recordsOn(d)
  }

  /** 历史按日筛选（原名保留：调用方在巡检列表与历史页两处） */
  function alarmsOnDate(d: Date): Alarm[] {
    return recordsOn(d)
  }

  /** 详情页按 id 找数据 */
  function byId(id: string): Alarm | undefined {
    return liveAlarms.value.find((a) => a.id === id)
  }

  /**
   * 当日预警 → 地图撒点。
   *
   * 视频报警只有通道号、没有经纬度（服务端不下发），所以真实数据在图上
   * **不会产生任何撒点**。这里保留实现是给以后接入带坐标的报警源留口子，
   * 绝不为「地图上要有东西」编造坐标。
   */
  function mapAlarms(space: 'pin' | 'flat' = 'pin'): MapAlarm[] {
    const out: MapAlarm[] = []
    for (const a of latest.value) {
      const spot = a[space]
      if (!spot) continue
      out.push({ id: a.id, title: a.title, x: spot[0], y: spot[1], left: spot[2] === 'left' })
    }
    return out
  }

  /* ---------- 页签与日历状态（原 app.js:677-696，1:1 保留） ---------- */

  /** 原 js/app.js:677 —— 巡检列表当前页签 */
  const inspTab = ref<'today' | 'hist'>('today')

  /** 原 js/app.js:681 —— 历史页当前选中日 */
  const inspHistDate = ref<Date>(addDays(startOfDay(new Date()), -1))

  /** 原 js/app.js:682 —— 日历当前显示月份 */
  const inspCalMonth = ref<Date>(new Date(inspHistDate.value.getFullYear(), inspHistDate.value.getMonth(), 1))

  /** 巡检日历是否展开 */
  const inspCalOpen = ref(false)

  /** 历史页当前页签 —— 设计稿默认落在「历史预警」 */
  const histTab = ref<'today' | 'hist'>('hist')

  /** 历史页当前选中日 */
  const histDate = ref<Date>(addDays(startOfDay(new Date()), -1))

  /** 历史页日历当前显示月份 */
  const histCalMonth = ref<Date>(new Date(histDate.value.getFullYear(), histDate.value.getMonth(), 1))

  /** 历史页日历是否展开 */
  const histCalOpen = ref(false)

  return {
    liveAlarms,
    liveState,
    liveError,
    total,
    pagesLoaded,
    hasLive,
    earliestDay,
    latest,
    feed,
    trend,
    syncFromVideo,
    refresh,
    ensureDate,
    appendLive,
    clearLive,
    inspTab,
    inspHistDate,
    inspCalMonth,
    inspCalOpen,
    histTab,
    histDate,
    histCalMonth,
    histCalOpen,
    alarmsOnDate,
    dayCount,
    dayRecords,
    byId,
    mapAlarms,
    // 列表 / 消息 / 首页轮播的图标位：与详情页同一张抓拍图的缩略图
    thumbOf,
    ensureThumb,
    // 占位图标上的下载进度（0~100 / 是否正在下载）
    thumbPctOf,
    thumbBusyOf,
  }
})
