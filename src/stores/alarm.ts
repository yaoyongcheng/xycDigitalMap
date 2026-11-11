import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchVideoAlarms } from '@/api/video'
import { addDays, dateKey, dayOffsetOf, startOfDay } from '@/utils/date'
import { relTime, toAlarms } from '@/utils/videoAlarm'
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

    liveState.value = 'loading'
    liveTriedAt = Date.now()
    try {
      pagesLoaded.value = await fetchPages(token, 1, FIRST_PAGES)
      liveState.value = 'ok'
      liveError.value = ''
      return liveAlarms.value.length > 0
    } catch (err) {
      liveState.value = 'error'
      liveError.value = err instanceof Error ? err.message : '报警同步失败'
      return false
    }
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

  /** 退出登录 / 清会话时把真实数据一并清掉，别让下一个人看到上一个人的现场 */
  function clearLive(): void {
    liveAlarms.value = []
    liveState.value = 'idle'
    liveError.value = ''
    total.value = 0
    pagesLoaded.value = 0
    liveTriedAt = 0
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
    ensureDate,
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
  }
})
