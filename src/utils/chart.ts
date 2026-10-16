import { addDays, startOfDay } from './date'

/**
 * SVG 图表生成
 *
 * 逐字搬运自 js/app.js（原版基线），仅做两处纯化：
 *   alarmTrendSvg  原本读模块级 latestAlarms，改为入参 latestCount
 *   peopleHourSvg  原本内部取 new Date().getHours()，改为入参 nowHour
 * 两处都只是把隐式依赖显式化，输出字符串逐字节不变。
 *
 * 输出形态是 HTML 字符串，组件侧用 v-html 渲染 —— 与原版 innerHTML 写法一致。
 *
 * 2026-10 改造：折线加 class="dl" + pathLength="1"（描边入场动画），
 * 面积加 class="fa"（淡入），数据点带递增 animation-delay —— 仅附加
 * 动效钩子，几何与配色与原版逐字节一致。动画规则在 app.css 末尾，
 * 整体包裹在 prefers-reduced-motion: no-preference 内。
 */

/** 控制点类型 [x, y] */
export type Pt = [number, number]

/** 原 js/app.js:113-130 —— Catmull-Rom 风格平滑折线，输出 path 的 d */
export function lineThrough(pts: Pt[], tension?: number): string {
  if (!pts.length) return ''
  const t = tension == null ? 0.7 : tension
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  if (pts.length === 1) return d
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * t
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * t
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * t
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * t
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return d
}

/** 原 js/app.js:183-190 —— 中点平滑折线 */
export function smoothPath(pts: Pt[]): string {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const cpx = ((pts[i][0] + pts[i + 1][0]) / 2).toFixed(1)
    d += ` C${cpx},${pts[i][1].toFixed(1)} ${cpx},${pts[i + 1][1].toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`
  }
  return d
}

/**
 * 原 js/app.js:132-181 alarmTrendSvg(fillId)
 * 近 7 日预警趋势折线。历史值取自原版硬编码的 hist 字典，
 * 最后一天（i === 0）用当日预警条数，即原版的 latestAlarms.length。
 */
export function alarmTrendSvg(fillId: string, latestCount: number): string {
  const hist: Record<string, number> = {
    '10/2': 2, '10/3': 3, '10/4': 6, '10/5': 16, '10/6': 13, '10/7': 8, '10/8': 4,
  }
  const end = startOfDay(new Date())
  const days: string[] = []
  const vals: number[] = []
  for (let i = 6; i >= 0; i--) {
    const d = addDays(end, -i)
    const lab = d.getMonth() + 1 + '/' + d.getDate()
    days.push(lab)
    vals.push(i === 0 ? latestCount : hist[lab] != null ? hist[lab] : 3)
  }
  const w = 260
  const h = 78
  const pl = 24
  const pr = 16
  const pt = 10
  const pb = 20
  const maxY = 20
  const n = days.length
  const xAt = (i: number): number => pl + (i / (n - 1)) * (w - pl - pr)
  const yAt = (v: number): number => pt + (1 - v / maxY) * (h - pt - pb)
  const pts: Pt[] = vals.map((v, i) => [xAt(i), yAt(v)])
  const line = lineThrough(pts, 0.7)
  const base = yAt(0).toFixed(1)
  const area = `${line} L${xAt(n - 1).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`
  const grids = [0, 10, 20]
    .map((t) => {
      const y = yAt(t).toFixed(1)
      return `<line x1="${pl}" x2="${w - pr}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${t}</text>`
    })
    .join('')
  const labels = days
    .map((d, i) => `<text x="${xAt(i).toFixed(1)}" y="${h - 1}" text-anchor="middle">${d}</text>`)
    .join('')
  const dots = pts
    .map(
      ([x, y], i) =>
        // 描边动画的入场延迟随点位递增，形成「画线 → 落点」的节奏
        `<circle class="alarm-dot" style="animation-delay:${350 + i * 70}ms" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.3"/>`,
    )
    .join('')
  const gid = fillId || 'alarmFill'
  return `<svg class="alarm-svg" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4C9FFF" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="#4C9FFF" stop-opacity="0.03"/>
        </linearGradient>
      </defs>
      <g class="alarm-grid">${grids}</g>
      <path class="fa" d="${area}" fill="url(#${gid})"/>
      <path class="dl" pathLength="1" d="${line}" fill="none" stroke="#4C9FFF" stroke-width="1.6" stroke-linejoin="round"/>
      ${dots}
      <g class="alarm-x">${labels}</g>
    </svg>`
}

/**
 * 原 js/app.js:192-244 peopleHourSvg()
 * 按时段的人员在场曲线（工人在职绿线 + 管理人员蓝线）。
 * 只画到当前小时为止，未到的时段标签淡化处理。
 */
export function peopleHourSvg(nowHour: number): string {
  const hourNums = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]
  const hours = hourNums.map((h) => h + ':00')
  const workersAll = [2, 2, 2, 8, 36, 33, 18, 24, 27, 12, 4, 2]
  const managersAll = [2, 2, 2, 2, 7, 19, 3, 5, 10, 6, 2, 2]
  const liveN = hourNums.reduce((n, h, i) => (h <= nowHour ? i + 1 : n), 0)
  const workers = workersAll.slice(0, liveN)
  const managers = managersAll.slice(0, liveN)
  const w = 320
  const h = 148
  const pl = 28
  const pr = 16
  const pt = 10
  const pb = 22
  const maxY = 40
  const ticksN = hours.length
  const xAt = (i: number): number => pl + (i / (ticksN - 1)) * (w - pl - pr)
  const yAt = (v: number): number => pt + (1 - v / maxY) * (h - pt - pb)
  const wPts: Pt[] = workers.map((v, i) => [xAt(i), yAt(v)])
  const mPts: Pt[] = managers.map((v, i) => [xAt(i), yAt(v)])
  const wLine = wPts.length ? smoothPath(wPts) : ''
  const mLine = mPts.length ? smoothPath(mPts) : ''
  const last = Math.max(workers.length - 1, 0)
  const base = yAt(0).toFixed(1)
  const area = wPts.length
    ? `${wLine} L${xAt(last).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`
    : ''
  const grids = [0, 10, 20, 30, 40]
    .map((t) => {
      const y = yAt(t).toFixed(1)
      return `<line x1="${pl}" x2="${w - pr}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${t}</text>`
    })
    .join('')
  const labels = hours
    .map((_d, i) => {
      const show = i === 0 || i === ticksN - 1 || i % 2 === 0
      if (!show) return ''
      const anchor = i === 0 ? 'start' : i === ticksN - 1 ? 'end' : 'middle'
      const dim = i >= liveN ? ` opacity="0.35"` : ''
      return `<text x="${xAt(i).toFixed(1)}" y="${h - 4}" text-anchor="${anchor}"${dim}>${hourNums[i]}:00</text>`
    })
    .join('')
  return `<svg class="people-hour-svg" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="peopleFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3DDC97" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#3DDC97" stop-opacity="0.04"/>
        </linearGradient>
      </defs>
      <g class="alarm-grid">${grids}</g>
      <path class="fa" d="${area}" fill="url(#peopleFill)"/>
      <path class="dl" pathLength="1" d="${wLine}" fill="none" stroke="#3DDC97" stroke-width="2"/>
      <path class="dl" pathLength="1" style="animation-delay:.25s" d="${mLine}" fill="none" stroke="#4C9FFF" stroke-width="2"/>
      <g class="alarm-x">${labels}</g>
    </svg>`
}
