import type { IotEventRow } from '@/api/iot'

/**
 * 智能电梯的数据整形（纯函数，无网络、无 Vue 依赖）
 *
 * 数据源是 IOT 网关上两类事件（契约见 `api/lift.ts`）：
 *   · `EVENT_WORKDATA`  —— 每次升降一条，带 `runStartTime` / `runEndTime`
 *   · `EVENT_POST_ATTR`  —— 周期性工况帧，带 `relFloor` / `height` / `load` / `numberOfPeople`
 *
 * ## 「今日累计运行时间」照 V2 的首尾相减（**不是**逐条累加）
 *
 * V2 `ElevatorRequester.<FetchWorkCycleAsync>d__9` 的 IL 原文：
 *
 * ```csharp
 * count   = Data.Count;
 * hours   = 0;
 * startStr = Data[0].ResultMap.RunStartTime;
 * endStr   = Data[count - 1].ResultMap.RunEndTime;
 * if (!IsNullOrEmpty(startStr) && !IsNullOrEmpty(endStr)
 *     && DateTime.TryParse(startStr) && DateTime.TryParse(endStr))
 *     hours = (endDateTime - startDateTime).TotalHours;
 * SetWorkCycleData(sn, count, hours);
 * ```
 *
 * 即「今天第一次升降的开始 → 最后一次升降的结束」的**墙钟跨度**，中间的停机
 * 时间全算在内。2026-11-13 实测 78 条：跨度 6.1h，逐条累加只有 1.3h ——
 * 差的 4.8 小时是两次升降之间没跑的时间。
 *
 * 这个口径在语义上是有争议的（「运行时间」含停机），但**现场要拿两个系统对账**，
 * 数字对不上比口径不纯更难受，所以这里与 V2 完全对齐（用户 2026-11-13 决定）。
 * 不在页面上额外标注口径：弹层是与 V2 并排对照的，V2 没有小注，多一句反而显得
 * 两边不一样（用户当天下午明确要求去掉）。
 *
 * 边界上只做一处改良：V2 在 `Data[count-1]` 的 `RunEndTime` 为空（最后一条还没
 * 跑完）时整个分支跳过、`hours` 保持 0，会把一格已经攒了一天的值打成 `0h`。
 * 这里改成「取最后一条**有**结束时间的记录」—— 数据完整时与 V2 逐字节相同，
 * 只在 V2 会掉成 0 的瞬间给出更合理的值。
 */

/** 单台电梯的当日作业指标 */
export interface LiftToday {
  /** 升降次数 = 事件条数（与 V2 `Data.Count` 同口径） */
  trips: number
  /** 今日累计运行秒数（**首尾跨度**，含停机；与 V2 同口径） */
  seconds: number
}

/** 单台电梯的最新工况帧 */
export interface LiftAttr {
  /** 相对楼层（V2 `txtRelFloor`，`-1` 表示无楼层信息） */
  floor: number | null
  /** 当前高度 m（V2 `txtHeight`） */
  height: number | null
  /** 当前人数（V2 `txtNumberOfPeople`） */
  people: number | null
  /**
   * 当前载重，**kg** —— 单位照 V2 `UIPanelElevator.UpdateRealtimeInfo`
   * 的 `Load.ToString("F1") + "kg"`，网关没有给换算说明。
   */
  load: number | null
  /** 运行状态枚举（V2 `RunningState`），文案见 `stateText` */
  state: number | null
  /** 运行速度 m/s（V2 面板未展示，留给上层按需用） */
  speed: number | null
  /** 这一帧的服务端时间（ms） */
  at: number | null
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 服务端时间字符串 → 毫秒。
 *
 * 服务端一律给 `'2026-11-13 06:23:53'`（北京时间，无时区标记）。
 * 显式补 `+08:00` 而不是交给 `new Date()` 猜：猜的是**浏览器本地时区**，
 * 换个时区算出来的差值虽然不变，但和 `timestamp`（真 UTC 毫秒）混用时会错开
 * 8 小时。解析失败返回 null，由调用方跳过那一条 —— 不拿 0 当起点。
 */
export function parseServerTime(v: unknown): number | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  const withZone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}+08:00`
  const t = Date.parse(withZone)
  return Number.isFinite(t) ? t : null
}

/**
 * 一组工作循环事件 → 「升降次数 + 今日累计运行秒数」。
 *
 * · 次数按**行数**算：一条事件就是一次完整升降（含没有有效时间的脏行，
 *   与 V2 `Data.Count` 一致）；某条时间解析不出来只是不影响时长，不减次数。
 * · 时长 = **最后一条的结束 − 第一条的开始**（V2 口径，见文件头）。
 *   首或尾解析不出来时给 0；算出负数（时区错乱 / 未闭合）也给 0，不造负值。
 *
 * 为什么不像 V2 那样直接 `Data[count-1]`：最后一条很可能还没跑完（`runEndTime`
 * 为空），V2 会在那一刻把整格打成 `0h`。这里退到「最后一个有效的结束时间」，
 * 数据完整时两者结果完全相同。
 */
export function sumWork(rows: readonly IotEventRow[]): LiftToday {
  let firstStart: number | null = null
  let lastEnd: number | null = null
  for (const r of rows) {
    const start = parseServerTime(r.resultMap?.runStartTime)
    const end = parseServerTime(r.resultMap?.runEndTime)
    if (start !== null && firstStart === null) firstStart = start
    if (end !== null) lastEnd = end
  }
  const span = firstStart !== null && lastEnd !== null ? (lastEnd - firstStart) / 1000 : 0
  return { trips: rows.length, seconds: span > 0 ? Math.round(span) : 0 }
}

/**
 * 运行时长 → 卡片文案。
 *
 * 照设计稿的形态（`2 min`）：不足 1 小时用分钟，超过 1 小时用一位小数的小时
 * （`3.5h`）—— 480min 这种读法在现场没有意义。
 * 0 秒是有效结论（今天确实没跑），写 `0min`；没有数据源由调用方给「—」。
 */
export function formatRuntime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  // 分钟档统一四舍五入：30 秒 → `1min`（写 `0min` 会被读成「今天没跑」）
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`
  return `${(seconds / 3600).toFixed(1)}h`
}

/** 一帧工况的 resultMap → LiftAttr；缺字段一律 null（不填 0） */
export function toAttr(resultMap: Record<string, unknown> | null, at: number | null): LiftAttr {
  const m = resultMap ?? {}
  return {
    floor: num(m.relFloor),
    height: num(m.height),
    people: num(m.numberOfPeople),
    load: num(m.load),
    state: num(m.runningState),
    speed: num(m.speed),
    at,
  }
}

/* ---------- 展示格式化（弹层与卡片共用，避免两处各写一份单位） ---------- */

/** 空值占位，与全站一致（不写 0、不写「暂无」） */
export const DASH = '—'

/**
 * 运行状态文案 —— 逐字照 V2 `UIPanelElevator.UpdateOnlineState` 的 switch：
 *
 * ```csharp
 * switch (runningState - 1) {   // 1 → 停止 / 2 → 上升 / 3 → 下降 / 其余 → 在线
 * ```
 *
 * `null`（没有工况帧）**不给文案**：那时连「在线」都不能断言，由调用方先看
 * 在线状态再决定 —— 与 V2 里 `IsOnline == false` 直接写「离线」是同一条路径。
 */
export function stateText(state: number | null): string | null {
  if (state === null) return null
  if (state === 1) return '停止'
  if (state === 2) return '上升'
  if (state === 3) return '下降'
  return '在线'
}

/** 相对楼层 → `8F`（V2 `RelFloor.ToString() + "F"`，负数楼层原样带符号） */
export function formatFloor(v: number | null): string {
  return v === null ? DASH : `${v}F`
}

/** 高度 → `22.4m`（V2 `F1`） */
export function formatHeight(v: number | null): string {
  return v === null ? DASH : `${v.toFixed(1)}m`
}

/** 人数 → `6人`（V2 整数） */
export function formatPeople(v: number | null): string {
  return v === null ? DASH : `${v}人`
}

/** 载重 → `480.0kg`（V2 `F1`；单位是 V2 硬编码的 kg） */
export function formatLoad(v: number | null): string {
  return v === null ? DASH : `${v.toFixed(1)}kg`
}

/** 今日运行时长 → `6.4h`（V2 `txtTodayRuntimeHours` 的 `F1` + `h`） */
export function formatHours(seconds: number | null): string {
  return seconds === null ? DASH : `${(seconds / 3600).toFixed(1)}h`
}

/** 今日升降次数 → `86次`（V2 `txtTodayLiftCount` 整数） */
export function formatTrips(n: number | null): string {
  return n === null ? DASH : `${n}次`
}
