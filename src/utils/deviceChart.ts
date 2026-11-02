import { smoothPath, type LineModel, type Pt } from './chart'
import { addDays, protoToday } from './date'
import type { DeviceMetric, DeviceUnit } from '@/types'

/**
 * 设备趋势图（2026-10 版本同步 · 第四批，原 js/app.js:1500-1637）
 *
 * 每台设备五个指标各一张折线图，可切近 7 日 / 近 30 日与设备页签。
 * 输出沿用 chart.ts 的 LineModel，因此直接复用 TouchChart 的触控层 ——
 * 原版是一张死 SVG，这里顺手拿到了「按住看某天数值」。
 *
 * 数据只有最近 7 天是真的（DeviceUnit.history + today）；近 30 日里更早的
 * 那 23 天是**按设备与日期派生**的演示值，不是随机数：
 * 同一台设备的同一天，刷新多少次都得到同一个数，图表不会跳。
 */

const W = 340
const H = 104
const PL = 30
const PR = 12
const PT = 10
const PB = 18

/** 由字符串派生的稳定伪随机（FNV-1a），返回 0~1 */
function rand01(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return ((h >>> 0) % 1000) / 999
}

/** 演示值的取值边界：比例类不能越界，计数类不能为负 */
function clampOf(metric: DeviceMetric): (v: number) => number {
  if (metric.unit === '%') return (v) => Math.max(8, Math.min(96, Math.round(v)))
  if (metric.dp === 0) return (v) => Math.max(1, Math.round(v))
  return (v) => Math.max(0.1, Math.round(v * Math.pow(10, metric.dp)) / Math.pow(10, metric.dp))
}

/** 坐标轴：比例类固定 0~100，其余按最大值取整到「好看的步长」 */
function axisOf(maxVal: number, unit: string): { maxY: number; ticks: number[] } {
  if (unit === '%') return { maxY: 100, ticks: [0, 25, 50, 75, 100] }
  const padded = Math.max(maxVal, 0.1) * 1.15
  const rough = padded / 4
  const exp = Math.pow(10, Math.floor(Math.log10(rough)))
  const n = rough / exp
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * exp
  const maxY = Math.ceil(padded / step) * step
  const ticks: number[] = []
  for (let t = 0; t <= maxY + step * 0.01; t += step) ticks.push(Math.round(t * 1000) / 1000)
  return { maxY, ticks }
}

function tickText(v: number): string {
  if (Math.abs(v - Math.round(v)) < 0.05) return String(Math.round(v))
  return String(Math.round(v * 10) / 10)
}

/** 'MM-DD' → 'M/D' */
function mdLabel(date: string): string {
  return `${Number(date.slice(0, 2))}/${Number(date.slice(3))}`
}

/** 近 count 天的日期（旧 → 新），最后一天是今天 */
function lastDates(count: number): string[] {
  const end = protoToday()
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = addDays(end, -i)
    out.push(`${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  return out
}

/** 某台设备某天某指标的数值：有真数据用真数据，没有就派生一个稳定的演示值 */
function seriesOf(unit: DeviceUnit, metric: DeviceMetric, count: number): { dates: string[]; vals: number[] } {
  const dates = lastDates(count)
  const known: Record<string, number> = {}
  for (const day of unit.history) {
    if (day.vals[metric.key] != null) known[day.date] = day.vals[metric.key]
  }
  const todayLabel = dates[dates.length - 1]
  if (unit.today[metric.key] != null) known[todayLabel] = unit.today[metric.key]

  // 派生基准取「已知值的均值」，让虚构的日期落在真实数据附近
  const baseVals = Object.values(known)
  const base = baseVals.length ? baseVals.reduce((s, v) => s + v, 0) / baseVals.length : 1
  const clamp = clampOf(metric)

  const vals = dates.map((date) =>
    known[date] != null
      ? known[date]
      : clamp(base + (rand01(`${unit.id}|${date}|${metric.key}`) - 0.5) * base * 0.56),
  )
  return { dates, vals }
}

export function deviceTrendModel(
  unit: DeviceUnit,
  metric: DeviceMetric,
  count = 7,
  fillId = 'devFill',
): LineModel {
  const { dates, vals } = seriesOf(unit, metric, count)
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length
  const axis = axisOf(Math.max(avg, ...vals), metric.unit)

  const n = vals.length
  const xAt = (i: number): number => PL + (n === 1 ? (W - PL - PR) / 2 : (i * (W - PL - PR)) / (n - 1))
  const yAt = (v: number): number => PT + (1 - v / axis.maxY) * (H - PT - PB)

  const pts: Pt[] = vals.map((v, i) => [xAt(i), yAt(v)])
  const line = smoothPath(pts)
  const base = yAt(0).toFixed(1)
  const area = `${line} L${xAt(n - 1).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`

  const grids = axis.ticks
    .map((t) => {
      const y = yAt(t).toFixed(1)
      return `<line x1="${PL}" x2="${W - PR}" y1="${y}" y2="${y}"/><text x="${PL - 4}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${tickText(t)}</text>`
    })
    .join('')

  /*
   * 横轴标签：7 天全画会挤成一团（每两个只隔约 40px），隔一个取一个；
   * 30 天每 7 天取一个，并保证首尾都在。首尾必须保留 —— 缺了起点或
   * 「今天」，读图的人就不知道这段区间到底落在哪。
   */
  const idx: number[] = n <= 8 ? vals.map((_, i) => i) : vals.map((_, i) => i).filter((i) => i % 7 === 0)
  if (idx[idx.length - 1] !== n - 1) {
    if (n - 1 - idx[idx.length - 1] < 4) idx[idx.length - 1] = n - 1
    else idx.push(n - 1)
  }
  const xLabels = idx
    .map((i) => {
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'
      return `<text x="${xAt(i).toFixed(1)}" y="${H - 4}" text-anchor="${anchor}">${mdLabel(dates[i])}</text>`
    })
    .join('')

  // 点数少时标每点的值，多了只留线 —— 30 天全标会糊成一片
  const valsText =
    n > 8
      ? ''
      : vals
          .map((v, i) => {
            const px = xAt(i)
            const py = yAt(v)
            const color = v >= avg ? '#FF9A3C' : '#4C9FFF'
            const ly = py - 7 >= 8 ? py - 7 : py + 12
            // 首点用 start、末点用 end：这两个点贴着纵轴与右边界，
            // 居中对齐会把数字推到轴标签上（实测「9.20」盖住了「10」）
            const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'
            const text = v.toFixed(metric.dp)
            return `<text class="dev-chart-val" x="${px.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" fill="${color}">${text}</text>`
          })
          .join('')

  const svg = `<svg class="dev-chart-svg" viewBox="0 0 ${W} ${H}" role="img">
      <defs>
        <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3DDC97" stop-opacity="0.42"/>
          <stop offset="100%" stop-color="#3DDC97" stop-opacity="0.03"/>
        </linearGradient>
      </defs>
      <g class="alarm-grid">${grids}</g>
      <path d="${area}" fill="url(#${fillId})"/>
      <line x1="${PL}" y1="${yAt(avg).toFixed(1)}" x2="${W - PR}" y2="${yAt(avg).toFixed(1)}" stroke="#8A9BB0" stroke-width="1" stroke-dasharray="4 3"/>
      <path d="${line}" fill="none" stroke="#3DDC97" stroke-width="2" stroke-linejoin="round"/>
      ${valsText}
      <g class="alarm-x">${xLabels}</g>
    </svg>`

  return {
    svg,
    w: W,
    h: H,
    ticks: dates.map(mdLabel),
    xs: pts.map((p) => p[0]),
    series: [{ name: metric.name, color: '#3DDC97', values: vals }],
    ys: [pts.map((p) => p[1])],
  }
}
