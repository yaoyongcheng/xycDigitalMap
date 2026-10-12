/**
 * 日期工具
 *
 * 逐字搬运自 js/app.js（原版基线），仅补类型标注。
 * 已排除原版中的死代码：camDayLabel(1057)、calMaxMonth(1086)。
 */

/** 原 js/app.js:1032 */
export function startOfDay(d: Date | number): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** 原 js/app.js:1038 */
export function sameDay(a: Date | number, b: Date | number): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime()
}

/** 原 js/app.js:1042 */
export function addDays(d: Date | number, n: number): Date {
  const x = startOfDay(d)
  x.setDate(x.getDate() + n)
  return x
}

/** 原 js/app.js:1048 */
export function dayOffsetOf(d: Date | number): number {
  return Math.round((startOfDay(new Date()).getTime() - startOfDay(d).getTime()) / 86400000)
}

/** 原 js/app.js:1052 */
export function formatMD(d: Date | number): string {
  const x = startOfDay(d)
  return String(x.getMonth() + 1).padStart(2, '0') + '/' + String(x.getDate()).padStart(2, '0')
}

/** 原 js/app.js:1061 —— 今天 / 昨天 / MM/DD */
export function formatCamDate(d: Date | number): string {
  const off = dayOffsetOf(d)
  if (off === 0) return '今天'
  if (off === 1) return '昨天'
  return formatMD(d)
}

/** 原 js/app.js:684 —— 'YYYY-MM-DD' */
export function dateKey(d: Date | number): string {
  const x = startOfDay(d)
  return (
    x.getFullYear() +
    '-' +
    String(x.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(x.getDate()).padStart(2, '0')
  )
}

/**
 * 原 js/app.js:678 —— 原型基准日，固定为 2026-10-08。
 * 原版所有历史数据的相对日期都以它为锚点。
 */
export function protoToday(): Date {
  return startOfDay(new Date(2026, 9, 8))
}

/** 原 js/app.js:694 */
export function inspCalMaxDay(): Date {
  return addDays(protoToday(), -1)
}

/** 原 js/app.js:1079 —— 可选月份下界：当前月往前 11 个月 */
export function calMinMonth(): Date {
  const d = startOfDay(new Date())
  d.setMonth(d.getMonth() - 11)
  d.setDate(1)
  return d
}

/** 原 js/app.js:1086 的等价内联逻辑（原 calMaxMonth 为死代码，此处按调用点原地保留用途） */
export function monthStart(d: Date | number): Date {
  const x = startOfDay(d)
  return startOfDay(new Date(x.getFullYear(), x.getMonth(), 1))
}
