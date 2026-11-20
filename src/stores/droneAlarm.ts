import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { ApiError } from '@/api/http'
import { fetchAuditWorkOrders, fetchWorkOrderPicture, type DroneWorkOrder } from '@/api/drone'
import { useAuthStore } from './auth'
import { relTime } from '@/utils/videoAlarm'
import { addDays, dateKey, startOfDay } from '@/utils/date'
import { shrinkDataUrl } from '@/utils/imageThumb'
import { clearThumbCache, readThumb, writeThumb } from '@/utils/thumbCache'
import type { TrendPoint } from '@/utils/chart'

/**
 * 无人机预警（= V2 大屏「工单列表」的 AI 工单）
 *
 * ## 数据源
 *
 * `POST https://iot.keehang.com:12666/audit_center/get_by_device_id?pidList={pid}`
 * —— 参数、字段与实测记录见 `api/drone.ts::fetchAuditWorkOrders`。
 *
 * ## 为什么单独一个 store
 *
 * 监控预警（`:8085` 视频报警）与无人机预警是**两套后端、两套分页**：
 * 一个按 `page/page_size + sceneCode`，一个按 `pageNum/pageSize`，
 * 未读语义也不同（前者是 `handleStatus`，后者只有「待处理 / 已完成」）。
 * 混在一个 store 里早晚互相污染，所以这里只管无人机这一侧。
 *
 * ## 「今日 / 历史」怎么切（2026-11-20 二次现场口径）
 *
 * 审核中心**没有任何时间筛选能力**（`startTime` / `endTime` / `businessStartTime` /
 * `startDate` 传与不传，`totalRecord` 恒为 1048 —— 2026-11-20 复测），但返回是
 * 按 `businessTime` **倒序**的，于是「今日」就是这份有序数据的前缀：
 *
 *   · 首屏用 `size=100` 扫一到两页，直到某行的日期早于 7 日窗口起点（或扫完）；
 *     100 条实测正好覆盖 7 天（11-14 ~ 11-20），所以**通常一次请求就够**；
 *   · `今日` = 前缀里 `businessTime` 是今天的那些（`todayItems`），条数是**精确值**；
 *   · `近7日趋势` = 同一批行按日期分桶（窗口内的日子一定被完整覆盖）；
 *   · `历史` = 其余行，继续用 `size=20` 往后翻页（`nextPage` 接着扫描的页号）。
 *
 * 早先这里问两次 `size=1` 只为拿「待处理 / 已完成」的总数（717 / 316）——
 * 现场只要「今日多少条待处理」，那两个全局总数就不必再打了，省两次往返。
 *
 * ## 红点（未处理）
 *
 * 行数据里**没有**未读/已读字段（`auditStatusType` 只有 `UNAUDITED` / `AUDITED`，
 * 没有 `readStatus` 之类），所以按现场规则退化成**状态**：今日且 `UNAUDITED`
 * 的条目带红点，`AUDITED` 不带；历史一律不带、也不参与计数。
 * 点开一条不会让它变少 —— 那是审核平台里的人工动作，本 App 不做，不假装能做。
 */

/** 历史翻页一页多少条 */
export const WORK_PAGE_SIZE = 20

/** 首屏扫描一页多少条（100 条 ≈ 7 天，一次请求就够） */
const SCAN_SIZE = 100

/** 最多扫几页（防「一周内几百条」时一直翻下去） */
const SCAN_MAX_PAGES = 3

/** 趋势窗口天数（与监控预警一致：近 7 日） */
export const WO_TREND_DAYS = 7

/**
 * 首屏扫描结果的有效期。
 *
 * 消息页与底栏角标都读这份数据，而这 App 是长驻的 PWA：只在启动时扫一次，
 * 放到后台半天后角标就是错的。2 分钟内重复进入不重扫（切 tab 不白打请求），
 * 超过就重来一趟 —— 一次请求 300KB 上下，不能每次点都打。
 */
const STALE_MS = 120_000

/* ---------- 现场图缩略图的三个闸门（与 `stores/alarm.ts` 同一套口径） ---------- */

/** 同一时刻最多几路在下载：工单图单张 200~300KB，一屏十来条一起拉会把现场网络打满 */
const THUMB_PARALLEL = 2

/** 暂时性失败（超时 / 断网）之后多久才允许再试 */
const THUMB_RETRY_MS = 30_000

/**
 * 缩略图缓存键的前缀。
 *
 * 工单与报警共用 `utils/thumbCache.ts` 那一个 IndexedDB 库（登出时一起清，
 * 语义一致）；报警的 id 是 `va-<服务端id>`、工单的是 uuid，本来就撞不上，
 * 加前缀只是让库里一眼能分清谁是谁。
 */
const THUMB_KEY = 'wo:'

/** 加载状态：idle 未开始 / loading 首屏 / ok / error 首屏失败 */
export type WorkOrderState = 'idle' | 'loading' | 'ok' | 'error'

/** 本地日期键 'YYYY-MM-DD' */
function todayKey(): string {
  return dateKey(new Date())
}

/** 7 日窗口的起点（今天往前 6 天） */
function weekStartKey(): string {
  return dateKey(addDays(new Date(), -(WO_TREND_DAYS - 1)))
}

/** 一行属于哪一天（服务端给的是 'YYYY-MM-DD HH:mm:ss'） */
function dayOf(w: DroneWorkOrder): string {
  return w.at.slice(0, 10)
}

export const useDroneAlarmStore = defineStore('droneAlarm', () => {
  const auth = useAuthStore()

  /** 已加载的工单（按 businessTime 倒序，服务端就是这个顺序；今日在头部） */
  const items = ref<DroneWorkOrder[]>([])

  /** 服务端命中的总条数（全部状态、全部日期） */
  const total = ref(0)

  const state = ref<WorkOrderState>('idle')

  /** 首屏失败原因（成功即清空），只在列表页的空态里展示 */
  const error = ref('')

  /** 正在拉下一页 */
  const loadingMore = ref(false)

  /** 下一页失败原因（只影响列表底部） */
  const loadError = ref('')

  /** 已经翻到底（服务端没有更多了） */
  const exhausted = ref(false)

  /** 历史翻页的下一趟页号（`size=WORK_PAGE_SIZE` 的口径） */
  const nextPage = ref(0)

  /** 首屏扫描是否完成 —— 今日条数与 7 日趋势这时才是结论 */
  const scanned = ref(false)

  /** 上次扫描成功的时刻（配合 `STALE_MS` 决定要不要重扫） */
  const fetchedAt = ref(0)

  /** 最新一条（消息页卡片的时间 + 概况） */
  const latest = computed<DroneWorkOrder | undefined>(() => items.value[0])

  /** 今日预警（列表前缀 + 日期就是今天） */
  const todayItems = computed(() => items.value.filter((w) => dayOf(w) === todayKey()))

  /** 今日预警数（统计卡的大数字） */
  const todayCount = computed(() => todayItems.value.length)

  /**
   * 今日未处理数 —— 消息页「无人机预警」卡上的数字、tabbar 角标的一半。
   *
   * 与列表红点同一条判据（`status === 'UNAUDITED'` && 今日），
   * 所以卡片上的数与今日列表里的红点个数永远一致。
   */
  const todayPending = computed(
    () => todayItems.value.filter((w) => w.status === 'UNAUDITED').length,
  )

  /** 今日数是否已知（首屏扫描完成才算；未完成时卡片写「—」而不是 0） */
  const todayKnown = computed(() => scanned.value)

  /** 历史预警（今天之前的，已加载部分） */
  const histItems = computed(() => items.value.filter((w) => dayOf(w) !== todayKey()))

  /** 历史已加载条数 */
  const histCount = computed(() => histItems.value.length)

  /** 近 7 日趋势（窗口内每天一条，没有数据的日子就是 0） */
  const weekTrend = computed<TrendPoint[]>(() => {
    const counts = new Map<string, number>()
    for (const w of items.value) {
      const k = dayOf(w)
      if (!k) continue
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const base = startOfDay(new Date())
    const out: TrendPoint[] = []
    for (let i = WO_TREND_DAYS - 1; i >= 0; i--) {
      const d = addDays(base, -i)
      out.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, value: counts.get(dateKey(d)) ?? 0 })
    }
    return out
  })

  /**
   * 窗口是否被完整覆盖（最老的一条已经早于窗口起点，或服务端本来就到底了）。
   *
   * 没覆盖时趋势窗口最左那一天会偏少 —— 页面照画（比空白有信息），
   * 内部知道这件事就够了，不必在界面上解释。
   */
  const weekComplete = computed(() => {
    if (exhausted.value) return true
    const last = items.value[items.value.length - 1]
    return !!last && dayOf(last) < weekStartKey()
  })

  /** 还有多少条没展示 */
  const hiddenCount = computed(() => Math.max(0, total.value - items.value.length))

  const hasMore = computed(() => !exhausted.value && items.value.length < total.value)

  /** 按 id 找一条（详情页只拿到 id，与报警详情同一套做法） */
  function byId(id: string): DroneWorkOrder | undefined {
    return items.value.find((w) => w.id === id)
  }

  /** 状态文案（服务端没给就写「—」，不猜「待处理」） */
  function statusText(w: DroneWorkOrder): string {
    if (w.status === 'AUDITED') return '已完成'
    if (w.status === 'UNAUDITED') return '待处理'
    return '—'
  }

  /** 卡片/列表上的相对时间（取不到时间就空串，不写「刚刚」） */
  function relOf(w: DroneWorkOrder): string {
    return w.at ? relTime(w.at) : ''
  }

  /** 今日 + 待处理 = 带红点 */
  function isUnread(w: DroneWorkOrder): boolean {
    return w.status === 'UNAUDITED' && dayOf(w) === todayKey()
  }

  /* ---------- 现场图缩略图（列表图标位） ---------- */

  /**
   * 图标位显示什么，与「监控预警」用的是同一套规则（2026-11-20 现场要求
   * 「两个子页的图标处理逻辑保持一致」）：
   *
   *   · 拿到缩略图 → 铺图（`.insp-pic`，48px 圆角、`object-fit: cover`）；
   *   · 没有 / 还没到 → **原样铺那颗灰底无人机占位图标**（`.alarm-tile`），
   *     灰底、内描边、图标 50% 尺寸一个像素都不动；
   *   · 取图过程中在占位图标外圈叠一圈**真实字节进度**（`ThumbRing`）；
   *   · 红点与图无关，仍由 {@link isUnread} 单独决定。
   *
   * 取不到的两类失败要分开，否则一条卡住的请求会让那一行永远停在占位图标上：
   *   · 403（签名 2h 过期）/ 404（对象没了）→ **结论**，永久不再重试；
   *   · 超时 / 断网 → 冷却 {@link THUMB_RETRY_MS} 后再试。
   *
   * 收在 store 而不是各组各取：同一条工单在「今日 / 历史 / 详情」会被渲染两次
   * （两个页签同时在 DOM 里），必须按 id 去重，否则一张图下两遍。
   */
  const thumbs = ref<Record<string, string>>({})

  /** 结论性失败（服务端明确没有这张图）的 id：永久不再重试 */
  const thumbFailed = new Set<string>()

  /** 暂时性失败的 id → 可再次尝试的时刻 */
  const thumbRetryAt = new Map<string, number>()

  /** 排队中 / 请求中的 id（去重：同一行被多处引用时只打一次） */
  const thumbWaiting = new Set<string>()
  const thumbQueue: string[] = []
  let thumbActive = 0

  /** 代际：登出之后，在途请求的结果一律丢弃 */
  let thumbGen = 0

  /**
   * 下载进度（0~100，缺省 = 还不知道）。
   *
   * 与 `thumbs` 分开放、且用 `reactive` 而不是整对象替换：进度是**高频写入**的，
   * 若也走 `thumbs.value = {...}`，每一格进度都会让整份列表重算 computed。
   */
  const thumbPct = reactive<Record<string, number>>({})

  /** 该 id 此刻**真的在下载**（排队中不算：让一屏图标一起转圈像整页都在加载） */
  const thumbBusy = reactive<Record<string, boolean>>({})

  /** 缩略图（data URL）；空串 = 还没有，调用方据此退回占位图标 */
  function thumbOf(id: string): string {
    return thumbs.value[id] || ''
  }

  function thumbPctOf(id: string): number {
    return thumbPct[id] ?? 0
  }

  function thumbBusyOf(id: string): boolean {
    return thumbBusy[id] === true
  }

  /**
   * 某条工单的缩略图（幂等，可反复调 —— 每次滚到视口附近都会再叫一次）。
   *
   * 不需要 token：现场图是 OSS 预签名直链，签名在 URL 里（见
   * `api/drone.ts::fetchWorkOrderPicture`）。
   */
  function ensureThumb(id: string): void {
    if (!id) return
    if (thumbs.value[id] || thumbFailed.has(id) || thumbWaiting.has(id)) return
    // 上一次超时 / 断网：冷却期内不重试，过了允许再来一次
    const retryAt = thumbRetryAt.get(id) || 0
    if (retryAt && Date.now() < retryAt) return
    const w = byId(id)
    // 行里没有图 = 结论（服务端没存），不必打一趟必然 404 的请求
    if (!w || !w.image) {
      thumbFailed.add(id)
      return
    }
    thumbWaiting.add(id)
    thumbQueue.push(id)
    pumpThumbs()
  }

  function pumpThumbs(): void {
    while (thumbActive < THUMB_PARALLEL && thumbQueue.length) {
      const id = thumbQueue.shift() as string
      thumbActive += 1
      void runThumb(id).finally(() => {
        thumbActive -= 1
        pumpThumbs()
      })
    }
  }

  async function runThumb(id: string): Promise<void> {
    const gen = thumbGen
    try {
      // ① 先看本机缓存：命中就不走网络（一条只有 4~6KB，毫秒级）
      const hit = await readThumb(THUMB_KEY + id)
      if (hit) {
        if (gen === thumbGen) thumbs.value = { ...thumbs.value, [id]: hit }
        return
      }

      const w = byId(id)
      if (!w?.image) return

      // ② 真开始下载才点亮进度：图标位上要能看到它在一格一格动
      thumbBusy[id] = true
      const full = await fetchWorkOrderPicture(w.image, {
        onProgress: (ratio) => {
          if (gen !== thumbGen) return
          const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100)
          // 4 个点以内不重渲染：一屏十几颗图标，每个 chunk 都写一遍纯属浪费
          if (pct < 100 && pct - (thumbPct[id] ?? 0) < 4) return
          thumbPct[id] = pct
        },
      })
      // 缩略图只是优化：缩不了（无 canvas 2d）就把原图当缩略图用
      const small = await shrinkDataUrl(full)
      if (gen !== thumbGen) return
      thumbs.value = { ...thumbs.value, [id]: small || full }
      // ③ 只有真缩下来才落盘：没缩成的那份是 200KB 原图，按 400 条存会把配额吃光
      if (small && small !== full) writeThumb(THUMB_KEY + id, small)
    } catch (err) {
      if (gen !== thumbGen) return
      // 403 / 404 是结论（签名过期 / 对象没了）；其余是暂时的，冷却后还能再试
      if (err instanceof ApiError && (err.code === 403 || err.code === 404)) {
        thumbFailed.add(id)
      } else if (err instanceof ApiError && err.code === 0 && /暂无现场图/.test(err.message)) {
        thumbFailed.add(id)
      } else {
        thumbRetryAt.set(id, Date.now() + THUMB_RETRY_MS)
      }
    } finally {
      thumbWaiting.delete(id)
      // 进度状态只服务于「还没图」的那一帧，图到了 / 放弃了就该清掉
      delete thumbBusy[id]
      delete thumbPct[id]
    }
  }

  /**
   * 清空缩略图（登出 / 换账号）。
   *
   * 落盘的那份也要清：现场照片不能留给下一个登录的人 —— 与报警侧
   * `stores/alarm.ts::clearThumbs` 同一时刻被调用，重复清库是幂等的。
   */
  function clearThumbs(): void {
    thumbGen += 1
    thumbs.value = {}
    thumbFailed.clear()
    thumbRetryAt.clear()
    thumbWaiting.clear()
    thumbQueue.length = 0
    for (const k of Object.keys(thumbPct)) delete thumbPct[k]
    for (const k of Object.keys(thumbBusy)) delete thumbBusy[k]
    void clearThumbCache()
  }

  /**
   * 首屏：扫到 7 日窗口之外（今日 + 趋势一次拿全）。
   *
   * 循环条件写的是「还能不能再扫」而不是固定页数：数据少时一页就停，
   * 一周内特别多时最多扫 3 页（300 条），宁可趋势最左边一天偏少也不无限翻。
   */
  async function load(force = false): Promise<void> {
    if (state.value === 'loading') return
    // 手里有一份还新鲜的就不重扫（切 tab / 重进列表都会走到这里）
    if (!force && scanned.value && Date.now() - fetchedAt.value < STALE_MS) return
    state.value = 'loading'
    error.value = ''
    try {
      const out: DroneWorkOrder[] = []
      let totalN = 0
      for (let p = 1; p <= SCAN_MAX_PAGES; p++) {
        const page = await fetchAuditWorkOrders({ page: p, size: SCAN_SIZE })
        totalN = Math.max(totalN, page.total)
        const known = new Set(out.map((w) => w.id))
        out.push(...page.rows.filter((w) => !known.has(w.id)))
        // 服务端没有下一页了（这一页不满 / 已经够 total）
        if (!page.rows.length || page.rows.length < SCAN_SIZE) break
        if (out.length >= totalN) break
        // 已经越过 7 日窗口：今日与趋势都齐了，不必再翻
        const last = out[out.length - 1]
        if (!last || dayOf(last) < weekStartKey()) break
      }
      items.value = out
      total.value = totalN
      nextPage.value = Math.floor(out.length / WORK_PAGE_SIZE) + 1
      exhausted.value = out.length >= totalN
      scanned.value = true
      fetchedAt.value = Date.now()
      state.value = 'ok'
    } catch (e) {
      // 保留上一批（刷新失败不该把已经看到的预警清空）
      error.value = e instanceof Error ? e.message : '无人机预警加载失败'
      state.value = 'error'
    }
  }

  /**
   * 下滑触底：只追加一页历史。
   *
   * 页号用 `nextPage` 递增而不是按 `items.length` 换算 —— 服务端只认 `pageNum`，
   * 翻页期间有新工单推送时整体会偏移，能把同一页重复拉到（按 id 去重就丢了）。
   * 失败不推进 `nextPage`，重试仍查同一页。
   */
  async function loadMore(): Promise<void> {
    if (loadingMore.value || !hasMore.value || state.value !== 'ok') return
    if (nextPage.value < 1) return
    loadingMore.value = true
    loadError.value = ''
    const p = nextPage.value
    try {
      const page = await fetchAuditWorkOrders({ page: p, size: WORK_PAGE_SIZE })
      total.value = Math.max(total.value, page.total)
      const known = new Set(items.value.map((w) => w.id))
      const fresh = page.rows.filter((w) => !known.has(w.id))
      nextPage.value = p + 1
      if (!page.rows.length) {
        exhausted.value = true
        return
      }
      if (fresh.length) items.value = [...items.value, ...fresh]
      if (items.value.length >= total.value) exhausted.value = true
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : '更多无人机预警加载失败'
    } finally {
      loadingMore.value = false
    }
  }

  /**
   * 测试接线点：直接灌一批工单（等价于「刚刚扫完首屏」），不会触发请求。
   *
   * 与 `stores/patrol.ts::apply` 同一约定 —— 单测不该为了渲染一个列表
   * 去跑一遍 keehang 的 CAS 两步登录。
   */
  function apply(rows: DroneWorkOrder[], meta: { total?: number } = {}): void {
    items.value = rows
    total.value = meta.total ?? rows.length
    nextPage.value = Math.floor(rows.length / WORK_PAGE_SIZE) + 1
    exhausted.value = rows.length >= total.value
    scanned.value = true
    fetchedAt.value = Date.now()
    state.value = 'ok'
    error.value = ''
  }

  /** 退出登录 / 换账号：清列表与游标 */
  function reset(): void {
    items.value = []
    total.value = 0
    state.value = 'idle'
    error.value = ''
    loadingMore.value = false
    loadError.value = ''
    exhausted.value = false
    nextPage.value = 0
    scanned.value = false
    fetchedAt.value = 0
    clearThumbs()
  }

  watch(
    () => auth.token,
    (t) => {
      if (!t) reset()
    },
  )

  return {
    items,
    total,
    state,
    error,
    loadingMore,
    loadError,
    exhausted,
    nextPage,
    scanned,
    latest,
    todayItems,
    todayCount,
    todayPending,
    todayKnown,
    histItems,
    histCount,
    weekTrend,
    weekComplete,
    hiddenCount,
    hasMore,
    byId,
    statusText,
    relOf,
    isUnread,
    thumbOf,
    thumbPctOf,
    thumbBusyOf,
    ensureThumb,
    clearThumbs,
    load,
    loadMore,
    apply,
    reset,
  }
})
