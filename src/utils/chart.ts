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
 *
 * 2026-10 触控改造：新增 *Model 函数 —— 在生成 SVG 字符串的同时返回
 * 点位元数据（刻度/系列/坐标），供 TouchChart 的触控热区、参考线与
 * 气泡使用；svg 字符串与既有输出逐字节一致，v-html 渲染路径不受影响。
 */

/** 控制点类型 [x, y] */
export type Pt = [number, number]

/** 折线图交互层的一条系列 */
export interface LineSeriesInfo {
  name: string
  color: string
  /** 与 ticks 对齐的数值；null 表示该刻度无数据（未到时段） */
  values: (number | null)[]
}

/** 折线图交互层模型：SVG 底图 + 点位元数据 */
export interface LineModel {
  svg: string
  w: number
  h: number
  /** 横轴刻度标签（与 xs 对齐） */
  ticks: string[]
  /** 每个刻度的 viewBox x 坐标 */
  xs: number[]
  series: LineSeriesInfo[]
  /** series[i] 每个刻度的 viewBox y 坐标（null 对应无数据） */
  ys: (number | null)[][]
}

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
 * 原 js/app.js:132-181 alarmTrendSvg(fillId) 的模型版。
 * 近 7 日预警趋势折线。历史值取自原版硬编码的 hist 字典，
 * 最后一天（i === 0）用当日预警条数，即原版的 latestAlarms.length。
 */
export function alarmTrendModel(latestCount: number, fillId = 'alarmFill'): LineModel {
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
  /*
   * 日期标签隔一个取一个（7 天 → 4 个）。
   *
   * 这张图会被缩进 170~230px 宽的卡片里，7 个「10/15」并排后每两个之间只剩
   * 约 4px；字号从 9px 提到 10px 后更是贴在一起。4 个标签间距约 60px，
   * 既看得出时间跨度，又不至于糊成一条。首尾必须保留（起点与「今天」）。
   */
  const labels = days
    .map((d, i) =>
      i % 2 === 0 || i === n - 1
        ? `<text x="${xAt(i).toFixed(1)}" y="${h - 1}" text-anchor="middle">${d}</text>`
        : '',
    )
    .join('')
  const dots = pts
    .map(
      ([x, y], i) =>
        // 描边动画的入场延迟随点位递增，形成「画线 → 落点」的节奏
        `<circle class="alarm-dot" style="animation-delay:${350 + i * 70}ms" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.3"/>`,
    )
    .join('')
  const gid = fillId || 'alarmFill'
  /*
   * 末点「在线」光晕：一圈不缩放、只呼吸透明度的圆。
   *
   * 刻意不用 transform: scale() 做雷达扩散 —— SVG 的 scale 基准是 viewBox
   * 原点，必须配 transform-box: fill-box 才会绕自身中心，而 iOS 14/15 对此
   * 支持不齐，一旦不生效圆点会飞出图表。只动 opacity 全平台一致。
   */
  const lastPt = pts[pts.length - 1]
  const live = `<circle class="alarm-live-halo" cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="6"/><circle class="alarm-live" cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="2.6"/>`
  /* 同一条路径、更宽更低透明度的一层，做出「线在发光」的观感（比 SVG filter 便宜得多） */
  const glow = `<path class="dl-glow" d="${line}" fill="none" stroke="#4C9FFF" stroke-width="5" stroke-opacity="0.16" stroke-linejoin="round"/>`
  const svg = `<svg class="alarm-svg" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4C9FFF" stop-opacity="0.38"/>
          <stop offset="100%" stop-color="#4C9FFF" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <g class="alarm-grid">${grids}</g>
      <path class="fa" d="${area}" fill="url(#${gid})"/>
      ${glow}
      <path class="dl" pathLength="1" d="${line}" fill="none" stroke="#4C9FFF" stroke-width="1.6" stroke-linejoin="round"/>
      ${dots}
      ${live}
      <g class="alarm-x">${labels}</g>
    </svg>`
  return {
    svg,
    w,
    h,
    ticks: days,
    xs: pts.map((p) => p[0]),
    series: [{ name: '预警', color: '#4C9FFF', values: vals }],
    ys: [pts.map((p) => p[1])],
  }
}

/** 兼容旧签名：只取 SVG 字符串（v-html 渲染路径） */
export function alarmTrendSvg(fillId: string, latestCount: number): string {
  return alarmTrendModel(latestCount, fillId || 'alarmFill').svg
}

/**
 * 原 js/app.js:192-244 peopleHourSvg() 的模型版。
 * 按时段的人员在场曲线（工人在职绿线 + 管理人员蓝线）。
 * 只画到当前小时为止，未到的时段标签淡化处理。
 */
export function peopleHourModel(nowHour: number): LineModel {
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
  /*
   * 刻度标签：每 3 个取一个 + 末点。
   *
   * 原先是 i%2（隔一个取一个），在 320 宽的图上步长只有 25px，
   * 而「21:00」这种标签本身约 30px 宽 —— 最后三个标签（17:00 / 21:00 / 23:00）
   * 里 21:00 是中点锚、23:00 是终点锚，实测横向压在一起，渲染成
   * 「173:00 213:00 2300」，像坏掉的坐标轴。
   *
   * 改成 i%3：1:00 / 7:00 / 13:00 / 19:00 / 23:00，步长 69px（末段 50px），
   * 任何两个标签之间都留得下空气。末点必须保留 —— 它是「现在」的锚。
   */
  const labels = hours
    .map((_d, i) => {
      const show = i === 0 || i === ticksN - 1 || i % 3 === 0
      if (!show) return ''
      const anchor = i === 0 ? 'start' : i === ticksN - 1 ? 'end' : 'middle'
      const dim = i >= liveN ? ` opacity="0.35"` : ''
      return `<text x="${xAt(i).toFixed(1)}" y="${h - 4}" text-anchor="${anchor}"${dim}>${hourNums[i]}:00</text>`
    })
    .join('')
  /*
   * 峰值标注 + 末点光晕。
   *
   * 这张卡是全宽的大图，字号 9px 下 6 个汉字放得下，标出峰值比让用户自己
   * 找最高点有用；而首页那张 170px 宽的迷你图就不标 —— 7 个日期标签已经
   * 挤到约 7px 渲染宽度，再加文字只会糊成一团。
   * wPts 为空（凌晨未到第一个时段）时整段跳过。
   */
  const peak = ((): string => {
    if (!wPts.length) return ''
    let mi = 0
    workers.forEach((v, i) => {
      if (v > workers[mi]) mi = i
    })
    const [px, py] = wPts[mi]
    return `<text class="peak-lab" x="${px.toFixed(1)}" y="${(py - 7).toFixed(1)}" text-anchor="middle">峰值 ${workers[mi]}人</text>`
  })()
  const live = ((): string => {
    if (!wPts.length) return ''
    const [lx, ly] = wPts[wPts.length - 1]
    return `<circle class="alarm-live-halo live-worker" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="7"/><circle class="alarm-live live-worker" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.8"/>`
  })()
  const glow = wPts.length
    ? `<path class="dl-glow" d="${wLine}" fill="none" stroke="#3DDC97" stroke-width="6" stroke-opacity="0.14" stroke-linejoin="round"/>`
    : ''
  const svg = `<svg class="people-hour-svg" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="peopleFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3DDC97" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#3DDC97" stop-opacity="0.04"/>
        </linearGradient>
      </defs>
      <g class="alarm-grid">${grids}</g>
      <path class="fa" d="${area}" fill="url(#peopleFill)"/>
      ${glow}
      <path class="dl" pathLength="1" d="${wLine}" fill="none" stroke="#3DDC97" stroke-width="2"/>
      <path class="dl" pathLength="1" style="animation-delay:.25s" d="${mLine}" fill="none" stroke="#4C9FFF" stroke-width="2"/>
      ${live}
      ${peak}
      <g class="alarm-x">${labels}</g>
    </svg>`
  /** 未到时段填 null（交互层显示 —，线本身照旧只画到当前小时） */
  const pad = (arr: number[]): (number | null)[] => arr.map((v, i) => (i < liveN ? v : null))
  const yOf = (v: number | null): number | null => (v == null ? null : yAt(v))
  return {
    svg,
    w,
    h,
    ticks: hours,
    xs: hourNums.map((_, i) => xAt(i)),
    series: [
      { name: '工人', color: '#3DDC97', values: pad(workersAll) },
      { name: '管理', color: '#4C9FFF', values: pad(managersAll) },
    ],
    ys: [pad(workersAll).map(yOf), pad(managersAll).map(yOf)],
  }
}

/** 兼容旧签名：只取 SVG 字符串（v-html 渲染路径） */
export function peopleHourSvg(nowHour: number): string {
  return peopleHourModel(nowHour).svg
}
