import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { addDays, dateKey, formatMD, monthStart, protoToday, sameDay, startOfDay } from '@/utils/date'
import { fetchVideoAlarms } from '@/api/video'
import { toAlarms } from '@/utils/videoAlarm'
import type { Alarm, MapAlarm } from '@/types'

/**
 * 相对锚点生成绝对时间 'YYYY-MM-DD HH:mm:ss'。
 *
 * 原版把历史记录的日期硬编码成 2026-09-30 / 10-05~10-07（app.js:246-255），
 * 锚点却是固定的 protoToday()=2026-10-08，于是：
 *   - 真实日期一走远，日历可选上界（10-07）和数据就整体脱节；
 *   - h-net 的 at=2026-09-30 与 rel=「昨天 09:30」自相矛盾。
 * 这里改为「天偏移 + 时刻」派生，at 与 rel 同源，永远对得上。
 */
function atOf(dayOffset: number, hm: string): string {
  return `${dateKey(addDays(protoToday(), dayOffset))} ${hm}:00`
}

/** 相对时间文案：昨天显示「昨天 HH:mm」，更早显示「MM/DD HH:mm」 */
function relOf(dayOffset: number, hm: string): string {
  if (dayOffset === 0) return `今天 ${hm}`
  if (dayOffset === -1) return `昨天 ${hm}`
  return `${formatMD(addDays(protoToday(), dayOffset))} ${hm}`
}

/**
 * 巡检预警
 *
 * inspectAlarms 是全项目唯一被 4 个功能域消费的数据源：
 *   首页-安全面板趋势图 / 巡检列表 / 预警详情 / 预警轮播
 * 接入接口后，一次数据返回要触发这四处同步 —— 这正是本次迁移的核心动机。
 */
export const useAlarmStore = defineStore('alarm', () => {
  /**
   * 原 js/app.js:246-255
   * 8 条记录：4 条 today + 4 条 hist。
   * day / at / rel 三个字段共同决定列表分组与日历筛选。
   *
   * 日期一律由「距今天多少天」派生（见 atOf / relOf），不再写死年月日。
   * 只在 store 创建时求值一次 —— 跨天常驻不刷新属原型可接受范围，
   * 真接入接口后数据由服务端下发，无需此处处理。
   */
  const alarms = ref<Alarm[]>([
    { id: 'trash', day: 'today', src: 'drone', type: '道路垃圾', title: '环境报警', desc: '场区道路发现垃圾堆放未清理！', img: 'img/alarm-trash.webp', rel: '1分钟前', at: atOf(0, '15:21'), geo: '114.24751233100210,30.53310211883421', pin: [32, 78], flat: [34, 86] },
    { id: 'cable', day: 'today', src: 'cam', type: '电缆拖地', title: '用电报警', desc: '作业面电缆拖地未架空，存在触电隐患！', img: 'img/alarm-cable.webp', rel: '3分钟前', at: atOf(0, '15:19'), geo: '114.24738810244102,30.53290155210933', pin: [48, 56], flat: [46, 40] },
    { id: 'net', day: 'today', src: 'snap', type: '安全网缺失', title: '防护报警', desc: '楼层临边安全网缺失，请立即整改！', img: 'img/alarm-net.webp', rel: '12分钟前', at: atOf(0, '15:10'), geo: '114.24742027911455,30.53296304904549', pin: [22, 48, 'left'], flat: [20, 34, 'left'] },
    { id: 'soil', day: 'today', src: 'drone', type: '裸土未覆盖', title: '扬尘报警', desc: '场区裸土未覆盖，扬尘风险较高！', img: 'img/alarm-soil.webp', rel: '1小时前', at: atOf(0, '14:22'), geo: '114.24760188412003,30.53322190771208', pin: [66, 62], flat: [60, 26] },
    { id: 'h-net', day: 'hist', src: 'snap', type: '安全网缺失', title: '防护报警', desc: '3#楼作业面临边安全网破损缺失。', img: 'img/alarm-net.webp', rel: relOf(-1, '09:30'), at: atOf(-1, '09:30'), geo: '114.24742027911455,30.53296304904549' },
    { id: 'h-trash', day: 'hist', src: 'drone', type: '道路垃圾', title: '环境报警', desc: '场区北侧道路垃圾堆放未及时清运。', img: 'img/alarm-trash.webp', rel: relOf(-2, '16:20'), at: atOf(-2, '16:20'), geo: '114.24749822001145,30.53308044122890' },
    { id: 'h-cable', day: 'hist', src: 'cam', type: '电缆拖地', title: '用电报警', desc: '钢筋加工区电缆拖地，存在漏电风险。', img: 'img/alarm-cable.webp', rel: relOf(-3, '11:08'), at: atOf(-3, '11:08'), geo: '114.24735501988210,30.53284411902341' },
    { id: 'h-soil', day: 'hist', src: 'drone', type: '裸土未覆盖', title: '扬尘报警', desc: '基坑周边裸土未覆盖，扬尘超标。', img: 'img/alarm-soil.webp', rel: relOf(-4, '08:46'), at: atOf(-4, '08:46'), geo: '114.24757700124480,30.53319822009112' },
  ])

  /* ---------- 真实报警（A′ 组 :8085 视频报警） ---------- */

  /**
   * 接口拉回来的真实报警。
   *
   * 与种子 `alarms` 并存而不是替换它，三个原因：
   *   ① 演示数据里 hist 那 4 条撑着「按日补齐」的模板池，替换掉历史页就没内容了；
   *   ② 接口只在**已登录**时才拉，未登录/离线时要保持可看的演示界面；
   *   ③ 接口失败时不能把已经拉到的真实数据也清空（刷新失败比没有数据更常见）。
   * 因此这里只做「有真数据就用真数据」的覆盖语义：latest 优先取这里。
   */
  const liveAlarms = ref<Alarm[]>([])

  /** 拉取状态：页面据此决定要不要显示「同步中」角标 */
  const liveState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle')

  /** 最近一次失败原因（成功时清空） */
  const liveError = ref('')

  /** 有没有拿到过真实报警 —— 用于区分「接口空结果」与「还没拉过」 */
  const hasLive = computed(() => liveAlarms.value.length > 0)

  /** 上限 50 条：够撑首页轮播与近几日历史，又不至于把基64截图一起拖慢 */
  const LIVE_PAGE_SIZE = 50

  /** 失败冷却（与首页人员块同一个口径：60s 内不重复打） */
  const LIVE_RETRY_MS = 60_000
  let liveTriedAt = 0

  /**
   * 从视频报警接口同步真实报警。
   *
   * 只在**已登录**时调用 —— 该接口要求 Bearer，未登录必然 401，没必要打一趟。
   * 成功后按 `alarms` 的语义整理（时间倒序、按日归类），失败保留现有数据并记下原因；
   * 一次失败后 60s 内不再重试，避免用户在首页反复切换面板时打爆接口。
   *
   * 返回是否真正取到了数据，便于调用方决定是否提示。
   */
  async function syncFromVideo(token: string, force = false): Promise<boolean> {
    if (!token) return false
    if (liveState.value === 'loading') return false
    if (!force && liveState.value === 'error' && Date.now() - liveTriedAt < LIVE_RETRY_MS) return false

    liveState.value = 'loading'
    liveTriedAt = Date.now()
    try {
      const page = await fetchVideoAlarms(token, { pageSize: LIVE_PAGE_SIZE })
      const rows = toAlarms(page.rows)
      if (rows.length) {
        liveAlarms.value = rows
        liveState.value = 'ok'
        liveError.value = ''
        return true
      }
      // 接口成功但一条都没有：不动已有数据（可能是真没报警，也可能是这个项目的
      // 通道还没配），只把状态标成 ok，让人知道「不是请求失败」
      liveState.value = 'ok'
      liveError.value = ''
      return false
    } catch (err) {
      liveState.value = 'error'
      liveError.value = err instanceof Error ? err.message : '报警同步失败'
      return false
    }
  }

  /** 退出登录 / 清会话时把真实数据一并清掉，别让下一个人看到上一个人的现场 */
  function clearLive(): void {
    liveAlarms.value = []
    liveState.value = 'idle'
    liveError.value = ''
    liveTriedAt = 0
  }

  /** 原 js/app.js:257 —— 首页安全面板与轮播只看当日 */
  const latest = computed(() =>
    hasLive.value
      ? liveAlarms.value.filter((a) => a.day === 'today')
      : alarms.value.filter((a) => a.day === 'today'),
  )

  /**
   * 历史记录模板池（原 app.js:2778-2787 ALARM_POOL）。
   *
   * 8 条模板与 alarms 的 8 条种子记录内容完全一致（同 src/type/title/desc/
   * img/geo），直接从种子派生而不是再抄一份 —— 单一数据源，改文案只改一处。
   */
  const pool = alarms.value.map((a) => ({
    src: a.src,
    type: a.type,
    title: a.title,
    desc: a.desc,
    img: a.img,
    geo: a.geo,
  }))

  /** 按日生成的补充记录缓存（原 app.js:2789 alarmExtra），保证同一天两次取相同 */
  const extraCache = new Map<string, Alarm>()

  /**
   * 某日预警条数（原 app.js:133-145 alarmDayCount）。
   * 已知分布 [8,13,16,6,3,2] 覆盖近 6 天，更早进入 24 元循环表；
   * 未来日期返回 null（日历上不可选）。
   */
  function dayCount(d: Date): number | null {
    const off = Math.round((startOfDay(protoToday()).getTime() - startOfDay(d).getTime()) / 86400000)
    if (off < 0) return null
    if (off === 0) return latest.value.length
    // 真实数据覆盖到的那几天按真实条数算，否则日历上的圆点会与点进去的列表不符
    const key = dateKey(d)
    const live = liveAlarms.value.filter((a) => a.at.slice(0, 10) === key).length
    if (live) return live
    const known = [8, 13, 16, 6, 3, 2]
    if (off <= known.length) return known[off - 1]
    const older = [5, 1, 4, 7, 2, 9, 3, 6, 0, 4, 8, 2, 5, 1, 3, 6, 2, 0, 4, 7, 3, 1, 5, 2]
    return older[(off - known.length - 1) % older.length]
  }

  /**
   * 某日预警记录（原 app.js:2796-2822 alarmDayRecords）。
   *
   * 当日直接返回 latest；其余日期先取种子记录，不足 dayCount 的部分从
   * 模板池按 (offset+i) 轮转补齐、时刻从 16:40 起每条提前 22 分钟，
   * 结果按时间倒序。补齐的记录进 extraCache，同一天反复进出页面数据不漂移。
   */
  function dayRecords(d: Date): Alarm[] {
    if (sameDay(d, protoToday())) return latest.value.slice()
    const key = dateKey(d)
    const n = dayCount(d) ?? 0
    const out = [...liveAlarms.value, ...alarms.value]
      .filter((a) => a.day === 'hist' && a.at.slice(0, 10) === key)
      .slice(0, n)
    const off = Math.round((startOfDay(protoToday()).getTime() - startOfDay(d).getTime()) / 86400000)
    for (let i = out.length; i < n; i++) {
      const id = `day-${key}-${i}`
      let rec = extraCache.get(id)
      if (!rec) {
        const tpl = pool[(off + i) % pool.length]
        const mins = 16 * 60 + 40 - i * 22
        const hh = String(Math.floor(mins / 60)).padStart(2, '0')
        const mm = String(mins % 60).padStart(2, '0')
        rec = { id, day: 'hist', src: tpl.src, type: tpl.type, title: tpl.title, desc: tpl.desc, img: tpl.img, geo: tpl.geo, at: `${key} ${hh}:${mm}:00`, rel: `${hh}:${mm}` }
        extraCache.set(id, rec)
      }
      out.push(rec)
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1))
  }

  /** 原 js/app.js:677 —— 巡检列表当前页签 */
  const inspTab = ref<'today' | 'hist'>('today')

  /** 原 js/app.js:681 —— 历史页当前选中日，锚点为 protoToday() */
  const inspHistDate = ref<Date>(addDays(protoToday(), -1))

  /** 原 js/app.js:682 —— 日历当前显示月份 */
  const inspCalMonth = ref<Date>(monthStart(inspHistDate.value))

  /** 巡检日历是否展开（原为 #inspCal 的 .hide 类，closeSub 需读取，故提到 store） */
  const inspCalOpen = ref(false)

  /* ---------- 报警预警历史页（2026-11 设计稿 gx2 版，原 app.js:2634-2636） ---------- */

  /** 历史页当前页签 —— 设计稿默认落在「历史预警」 */
  const histTab = ref<'today' | 'hist'>('hist')

  /** 历史页当前选中日（原 alarmHistDate），锚点为 protoToday() */
  const histDate = ref<Date>(addDays(protoToday(), -1))

  /** 历史页日历当前显示月份（原 alarmHistCalMonth） */
  const histCalMonth = ref<Date>(monthStart(histDate.value))

  /** 历史页日历是否展开 */
  const histCalOpen = ref(false)

  /** 原 js/app.js:684-696 的 alarmsOnDate(d) —— 历史页按日筛选 */
  function alarmsOnDate(d: Date): Alarm[] {
    const key = dateKey(d)
    return [...liveAlarms.value, ...alarms.value].filter(
      (a) => a.day === 'hist' && a.at.slice(0, 10) === key,
    )
  }

  /** 原多处以 inspectAlarms.find(...) 内联实现；真实报警也要能点进详情 */
  function byId(id: string): Alarm | undefined {
    return liveAlarms.value.find((a) => a.id === id) ?? alarms.value.find((a) => a.id === id)
  }

  /**
   * 当日预警 → 地图撒点（2026-10 版本同步 · 第二批）
   *
   * 三维图与二维图各有一套坐标（AlarmSpot），由调用方声明要哪一套。
   * 只撒当日预警 —— 历史记录已经整改关闭，标在地图上会误导现场。
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

  return {
    alarms,
    latest,
    liveAlarms,
    liveState,
    liveError,
    hasLive,
    syncFromVideo,
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
