/**
 * 「当前巡检」进度 —— 已飞多久、还要多久、走到百分之几
 *
 * ## 为什么「预计时长」是算出来的，不是问服务端要的
 *
 * keehang 的任务接口里**没有计划时长**：排班（`/task/list` 的 `schedule`）只有
 * 触发时刻（这台机是 09:45 / 13:20 / 15:00 / 17:45 四个点），没有「跑一趟要多久」；
 * 执行记录（`/task/exec/list/record`）执行中的那条 `end` 是 `null`；航线的 kmz
 * 只有航点坐标。全项目找过一遍，唯一能给出时长的字段是「已完成记录的实际起止」。
 *
 * 所以这里按时长取**同一任务近几次已完成执行的中位数**当分母 —— 是真实测出来的，
 * 不是拍一个「18 分钟」。现场数据很稳：安全巡检近 7 天 28 次里 24 次都是 11 分钟，
 * 中位数落在 11。若这个任务一次完整执行都没有，就不给分母 —— 页面只写已飞时长、
 * 不画进度条，**不拿 0 或排班间隔凑一个百分比**。
 *
 * 中位数而不是平均数：现场偶尔有一次跑成 20 分钟（中途等待/重试），
 * 平均数会被这一条拽偏，中位数不受影响。
 */

/** 一条执行记录里算时长要用的部分（服务端原样的字符串时间） */
export interface RunSpan {
  /** 任务 id：同一条航线每次执行都相同 */
  taskId: number | null
  /** 开始时间 'YYYY-MM-DDTHH:mm:ss' */
  start: string
  /** 结束时间；执行中为 '' */
  end: string
}

/** ISO 串 → 毫秒；解析不出来给 null */
function ms(v: string): number | null {
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** 一次执行的时长（分钟，小数）；起止缺一或倒挂 → null */
export function runMinutes(start: string, end: string): number | null {
  const a = ms(start)
  const b = ms(end)
  if (a === null || b === null || b <= a) return null
  return (b - a) / 60_000
}

/**
 * 每个任务的实测时长中位数（分钟，四舍五入、至少 1）。
 *
 * 没有可用样本的任务不会出现在结果里 —— 调用方据此判断「没有分母」。
 */
export function estimateByTask(rows: RunSpan[]): Record<string, number> {
  const buckets = new Map<number, number[]>()
  for (const r of rows) {
    if (r.taskId === null) continue
    const m = runMinutes(r.start, r.end)
    if (m === null) continue
    const arr = buckets.get(r.taskId) ?? []
    arr.push(m)
    buckets.set(r.taskId, arr)
  }
  const out: Record<string, number> = {}
  for (const [id, arr] of buckets) {
    arr.sort((x, y) => x - y)
    const mid = arr.length % 2 === 1
      ? arr[(arr.length - 1) / 2]
      : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2
    out[String(id)] = Math.max(1, Math.round(mid))
  }
  return out
}

/** 进度三件套，任一项取不到就是 null（页面对 null 不设默认值） */
export interface MissionProgress {
  /** 0~99 的整数；没有预计时长时为 null */
  pct: number | null
  /** 已飞分钟（一位小数）；没有起飞时刻时为 null */
  elapsedMin: number | null
  /** 预计分钟（历史中位数）；没有历史样本时为 null */
  estimateMin: number | null
}

/**
 * 算当前任务的进度。
 *
 * `pct` 封顶 99 而不是 100：任务还在「执行中」时（记录 `status` 仍是 1）
 * 画到 100% 会让人以为飞完了。已经飞过预计时长时停在 99，由文案里的
 * 两个分钟数说明实情，不假装完成。
 */
export function missionProgress(
  startAt: number | null,
  estimateMin: number | null,
  now: number,
): MissionProgress {
  const est = estimateMin !== null && estimateMin > 0 ? estimateMin : null
  const elapsed =
    startAt !== null && Number.isFinite(startAt) ? Math.max(0, (now - startAt) / 60_000) : null
  if (elapsed === null || est === null) return { pct: null, elapsedMin: elapsed, estimateMin: est }
  const pct = Math.round((elapsed / est) * 100)
  return { pct: Math.max(0, Math.min(99, pct)), elapsedMin: elapsed, estimateMin: est }
}
