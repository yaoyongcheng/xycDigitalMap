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

/** 趋势图的一个数据点（近 7 日预警） */
export interface TrendPoint {
  /** 横轴标签，如 '11/11' */
  label: string
  /** 该日条数 */
  value: number
}

/**
 * 趋势折线的几何绘制。
 *
 * 演示基线（`alarmTrendModel`）与真实数据（`alarmTrendLive`）共用这一份，
 * 两者只差「刻度值 / 纵轴上限 / 网格」三样，观感才不会一份粗一份细。
 */
function trendChart(days: string[], vals: number[], maxY: number, gridVals: number[], fillId: string): LineModel {
  const w = 260
  const h = 78
  const pl = 24
  const pr = 16
  const pt = 10
  const pb = 20
  const n = days.length
  const xAt = (i: number): number => pl + (i / (n - 1)) * (w - pl - pr)
  const yAt = (v: number): number => pt + (1 - v / maxY) * (h - pt - pb)
  const pts: Pt[] = vals.map((v, i) => [xAt(i), yAt(v)])
  const line = lineThrough(pts, 0.7)
  const base = yAt(0).toFixed(1)
  const area = `${line} L${xAt(n - 1).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`
  const grids = gridVals
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

/**
 * 原 js/app.js:132-181 alarmTrendSvg(fillId) 的模型版（**演示基线**）。
 *
 * 2026-11 起首页/列表/历史页都不再调用它 —— 趋势图改成 `alarmTrendLive`
 * 喂真实按日条数。保留实现是因为它被单测当作「原版几何基线」锁住，
 * 而且真实数据为空时页面显示空态而不是退回到这条曲线。
 */
export function alarmTrendModel(latestCount: number, fillId = 'alarmFill'): LineModel {
  /**
   * 近 6 日条数按「距今天数」索引（原 app.js:133-145 alarmDayCount 的 known 表）。
   * 旧版按 '10/2' 这类日期标签查表，真实日期一走远就全部落进兜底值 3。
   */
  const histByOffset = [8, 13, 16, 6, 3, 2] // 按偏移 1..6 索引
  const end = startOfDay(new Date())
  const days: string[] = []
  const vals: number[] = []
  for (let i = 6; i >= 0; i--) {
    const d = addDays(end, -i)
    days.push(d.getMonth() + 1 + '/' + d.getDate())
    vals.push(i === 0 ? latestCount : histByOffset[i - 1])
  }
  return trendChart(days, vals, 20, [0, 10, 20], fillId)
}

/**
 * 近 7 日预警趋势（**真实数据**）。
 *
 * 入参由 `stores/alarm.ts` 的 `trend` 按日聚合得到，没有数据的日子就是 0。
 * 纵轴上限跟着峰值走（向上取整到 4 的倍数，保证网格刻度是整数）——
 * 现场一天 40 条时若沿用演示的 20，曲线会整条顶出画布。
 */
export function alarmTrendLive(points: TrendPoint[], fillId = 'alarmFill'): LineModel {
  const n = points.length
  if (!n) return trendChart(['', ''], [0, 0], 4, [0, 2, 4], fillId)
  const vals = points.map((p) => Math.max(0, p.value))
  const peak = Math.max(...vals, 1)
  const maxY = Math.max(4, Math.ceil(peak / 4) * 4)
  return trendChart(
    points.map((p) => p.label),
    vals,
    maxY,
    [0, maxY / 2, maxY],
    fillId,
  )
}

/** 兼容旧签名：只取 SVG 字符串（v-html 渲染路径） */
export function alarmTrendSvg(fillId: string, latestCount: number): string {
  return alarmTrendModel(latestCount, fillId || 'alarmFill').svg
}

/**
 * 真实分时人数（来自 `todayPersonHourStat`）。
 *
 * 三个数组按下标一一对应：`hours[i]` 时刻有 `workers[i]` 名工人、
 * `managers[i]` 名管理人员在册。小时数以接口返回为准（现场是 0..17 整点），
 * 不假设固定刻度。
 */
export interface HourLiveData {
  hours: number[]
  workers: number[]
  managers: number[]
}

/** 共用绘制参数：把「刻度 / 数据 / 上限」抽出来，演示版与真实版只差这三样 */
interface HourChartSpec {
  /** 横轴数值小时，按下标对应 x 位置（全天轴时就是 0..23） */
  hourNums: number[]
  /** 各刻度的工人数；null = 该刻度不画点、不连线（未到时段 / 接口没给这一格） */
  workersAll: (number | null)[]
  managersAll: (number | null)[]
  /** 纵轴上限 */
  maxY: number
  /**
   * 未到时段是否**画在 0 线上**（V2「今日人员分布」的画法，2026-11-17 对齐）。
   *
   * 只改几何：`series.values` / `ys` 仍是 null，触控气泡对没到的时刻显示「—」，
   * 不把「还没到」说成「0 个人」。
   */
  tailToZero?: boolean
  /** 该下标是否显示刻度文案 */
  pickLabel: (i: number, n: number) => boolean
}

/**
 * 分时人数折线图（整点在场人数）。演示数据版与真实数据版共用这一份几何，
 * 保证两种数据源画出来的图形观感一致。
 *
 * 数据里允许 null：null = 「这一格没有真实值」。画不画由 `tailToZero` 决定：
 *   · 演示基线 / 默认：null 处断线留白；
 *   · 接真实数据（`peopleHourModel` 的 live 分支）：**尾部贴 0**，与 V2 的
 *     「今日人员分布」画面一致 —— 曲线一路铺到 23:00，未到的时段压在 0 线上。
 *     但 `series` / `ys` 仍留 null，触控气泡对没到的时刻显示「—」，不当成 0 人。
 */
function hourChart(spec: HourChartSpec): LineModel {
  const { hourNums, workersAll, managersAll, maxY, pickLabel, tailToZero } = spec
  const hours = hourNums.map((h) => h + ':00')
  /*
   * 画布尺寸（viewBox 单位）。
   *
   * 2026-11-23：宽 320 → 378、右内边距 16 → 10。SVG 在卡片里是
   * `width: 100%; height: 132px`，320×148 的 viewBox 在 338px 宽的内容区里
   * 受高度约束缩放（132/148 ≈ 0.89），画出来只有约 286px，左右各空出 26px ——
   * 观感是「图缩在卡片中间」。把 viewBox 加宽到与容器同比例后，缩略完全由
   * 高度决定，图形横向铺满，左右只剩 1px 级余量。
   *
   * 高度（148）与 pt/pb 一等不动，所以纵轴刻度、线宽、字号在屏幕上都不变，
   * 变的只是横向的格距（更舒展）与右端的留白（更贴近卡片边框）。
   */
  const w = 378
  const h = 148
  const pl = 28
  const pr = 10
  const pt = 10
  const pb = 22
  const ticksN = hours.length
  /* 单点（只有一个整点有数据）时避免除零 */
  const span = Math.max(ticksN - 1, 1)
  const xAt = (i: number): number => pl + (i / span) * (w - pl - pr)
  const yAt = (v: number): number => pt + (1 - v / maxY) * (h - pt - pb)
  /** 最后一条有值的下标（-1 = 一条都没有）；右侧未到时段靠它淡化刻度 */
  const lastIdx = ((): number => {
    let k = -1
    const n = Math.max(workersAll.length, managersAll.length)
    for (let i = 0; i < n; i += 1) if (workersAll[i] != null || managersAll[i] != null) k = i
    return k
  })()
  const ptOf = (i: number, v: number | null): Pt | null => (v == null ? null : [xAt(i), yAt(v)])
  /** null 处断线：连续非空的点各自成段，合成一个 path 的多个子路径 */
  const segmentsOf = (vals: (number | null)[]): Pt[][] => {
    const out: Pt[][] = []
    let cur: Pt[] = []
    for (let i = 0; i < vals.length; i += 1) {
      const p = ptOf(i, vals[i])
      if (p) cur.push(p)
      else if (cur.length) {
        out.push(cur)
        cur = []
      }
    }
    if (cur.length) out.push(cur)
    return out
  }
  /* 尾部贴 0：几何上补齐（V2 的画面），但 series/ys 仍是 null（见 tailToZero） */
  const drawW = tailToZero ? workersAll.map((v) => v ?? 0) : workersAll
  const drawM = tailToZero ? managersAll.map((v) => v ?? 0) : managersAll
  const wSegs = segmentsOf(drawW)
  const mSegs = segmentsOf(drawM)
  const wLine = wSegs.map(smoothPath).join(' ')
  const mLine = mSegs.map(smoothPath).join(' ')
  const base = yAt(0).toFixed(1)
  /* 面积只填第一段（从 0 点到此刻，实测数据连续；中间断格时不硬连过去） */
  const first = wSegs[0]
  const area = first
    ? `${smoothPath(first)} L${first[first.length - 1][0].toFixed(1)},${base} L${first[0][0].toFixed(1)},${base} Z`
    : ''
  /* 四条等分网格线：上限 40 时正好是 0/10/20/30/40，与原先写死的刻度一致 */
  const grids = Array.from({ length: 5 }, (_, k) => Math.round((maxY * k) / 4))
    .map((t) => {
      const y = yAt(t).toFixed(1)
      return `<line x1="${pl}" x2="${w - pr}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${t}</text>`
    })
    .join('')
  /*
   * 刻度标签文案：由调用方挑（演示 12 格挑 i%3，真实 24 格挑 i%4），这里的
   * 通用规则是「首、末必留」——末点是「现在」或「23:00」的锚，丢了轴就不完整。
   * 未到的刻度淡化（opacity .35），不画假数据但也不让轴突然断掉。
   */
  const labels = hours
    .map((_d, i) => {
      if (!pickLabel(i, ticksN)) return ''
      const anchor = i === 0 ? 'start' : i === ticksN - 1 ? 'end' : 'middle'
      const dim = i > lastIdx ? ` opacity="0.35"` : ''
      return `<text x="${xAt(i).toFixed(1)}" y="${h - 4}" text-anchor="${anchor}"${dim}>${hourNums[i]}:00</text>`
    })
    .join('')
  /*
   * 峰值标注 + 末点光晕。
   *
   * 这张卡是全宽的大图，字号 9px 下 6 个汉字放得下，标出峰值比让用户自己
   * 找最高点有用；而首页那张 170px 宽的迷你图就不标 —— 7 个日期标签已经
   * 挤到约 7px 渲染宽度，再加文字只会糊成一团。
   * 一条有效数据都没有（凌晨未到第一个时段）时整段跳过。
   */
  const peak = ((): string => {
    let mi = -1
    workersAll.forEach((v, i) => {
      if (v == null) return
      if (mi < 0 || v > (workersAll[mi] as number)) mi = i
    })
    if (mi < 0) return ''
    const px = xAt(mi).toFixed(1)
    const py = (yAt(workersAll[mi] as number) - 7).toFixed(1)
    return `<text class="peak-lab" x="${px}" y="${py}" text-anchor="middle">峰值 ${workersAll[mi]}人</text>`
  })()
  /*
   * 末点光晕标在**最后一个真实有值**的整点（不是贴 0 的尾部）：尾段是补齐的
   * 0 线，把「此刻」的光点画到 23:00 上会指错时间。
   */
  const live = ((): string => {
    let li = -1
    workersAll.forEach((v, i) => {
      if (v != null) li = i
    })
    if (li < 0) return ''
    const lx = xAt(li).toFixed(1)
    const ly = yAt(workersAll[li] as number).toFixed(1)
    return `<circle class="alarm-live-halo live-worker" cx="${lx}" cy="${ly}" r="7"/><circle class="alarm-live live-worker" cx="${lx}" cy="${ly}" r="2.8"/>`
  })()
  const glow = wSegs.length
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
  return {
    svg,
    w,
    h,
    ticks: hours,
    xs: hourNums.map((_, i) => xAt(i)),
    series: [
      { name: '工人', color: '#3DDC97', values: workersAll },
      { name: '管理', color: '#4C9FFF', values: managersAll },
    ],
    ys: [
      workersAll.map((v) => (v == null ? null : yAt(v))),
      managersAll.map((v) => (v == null ? null : yAt(v))),
    ],
  }
}

/**
 * V2「今日人员分布」的横轴口径 —— 2026-11-17 逐帧核对后照搬（详见
 * `docs/api-migration.md` 的「分时人数的横轴 V2 右移一小时」）。
 *
 * 接口 `hours` 是 **0 基点**（数组里 0 点…现在这个整点都在，实测 16 点回 0/0），
 * 但 V2 的横轴从 1:00 起、把第 i 个数据点直接摆在第 i 格 —— 于是 **接口 11 点的值
 * 画在 12:00 刻度上**，曲线和气泡数字一起右移一小时。现场对得上：
 * V2 气泡「12:00 工人 18 / 管理 6」，接口 11 点正是 18/6；V2 曲线在 7:00 才 4 人，
 * 接口 7 点已是 23 人（它把接口 6 点的 4 人画在 7:00）。
 *
 * 这里照它的画法对齐：刻度、曲线、气泡三处同时右移，同一刻度两边显示同一个数。
 * **要回到「刻度 = 接口小时」的正确口径，把它改成 0 即可**（只有这一处依赖它）。
 */
const V2_HOUR_SHIFT = 1

/**
 * 原 js/app.js:192-244 peopleHourSvg() 的模型版。
 * 按时段的人员在场曲线（工人在职绿线 + 管理人员蓝线）。
 *
 * 演示数据按 1/3/5…23 的 12 个刻度画；传 `live` 时改用接口真实数据
 * （`todayPersonHourStat`），横轴换成 V2 那根 **1:00→23:00 固定轴**、未到时段尾部
 * 贴 0，并且每个点按 V2 的口径右移一格（见 `V2_HOUR_SHIFT`）—— 这样同一刻度上
 * 两边的曲线高度、气泡数字都一致。纵轴同样是 0/10/20/30/40。
 *
 * 纵轴上限按实际峰值向上取整到 10 的倍数（现状峰值 31 → 40，与 V2 的 0/10/20/30/40
 * 刻度恰好一致）。
 */
export function peopleHourModel(nowHour: number, live?: HourLiveData): LineModel {
  if (live && live.hours.length > 1 && live.workers.length && live.managers.length) {
    /*
     * 位置 i 的刻度是 `(i + V2_HOUR_SHIFT):00`，装的是接口 hours = i 的数。
     * 23 格（1:00→23:00）是这个口径下能摆下的全部位置，接口的 23 点无处可放 ——
     * V2 同样会把它挤出轴外，现场那个点恒为 0，不影响画面。
     */
    const labels = Array.from({ length: 24 - V2_HOUR_SHIFT }, (_, i) => i + V2_HOUR_SHIFT)
    const wMap = new Map(live.hours.map((hh, i) => [hh, live.workers[i]]))
    const mMap = new Map(live.hours.map((hh, i) => [hh, live.managers[i]]))
    /*
     * 两件事分开处理：
     *   · 还没到的时段（hours > nowHour）→ null，几何上由 tailToZero 贴到 0 线（V2 的画面），
     *     但气泡显示「—」，不把「还没到」说成「0 个人」；
     *   · 接口没给这一格 → 同样 null。
     * 当前整点另算：现场接口按时段累加，这一小时刚开头必然是 0，原样画出来会让
     * 曲线在最右边垂直跳水，看着像「人都走光了」，所以也留白。
     */
    const pick = (map: Map<number, number>, hh: number): number | null => {
      if (hh > nowHour) return null
      const v = map.get(hh)
      if (v === undefined) return null
      // v 可能是 0（凌晨真没人），只有「当前整点且两条线都是 0」才当未结算
      return v
    }
    const ws = labels.map((_, i) => pick(wMap, i))
    const ms = labels.map((_, i) => pick(mMap, i))
    /* 当前整点：接口按时段累加，这一小时刚开头必然是 0，原样画会让末点垂直跳水 */
    if (nowHour >= 0 && nowHour < labels.length && ws[nowHour] === 0 && ms[nowHour] === 0) {
      ws[nowHour] = null
      ms[nowHour] = null
    }
    const vals = [...ws, ...ms].filter((v): v is number => v != null)
    const peak = Math.max(...vals, 1)
    return hourChart({
      hourNums: labels,
      workersAll: ws,
      managersAll: ms,
      /*
       * 纵轴与 V2 同一起点：0/10/20/30/40 四条网格，峰值 31 落在 30 与 40 之间，
       * 和 V2 图上那条绿线的位置一致（它峰顶基本压在 30 刻度线上）。
       * 现场真超过 40 人时按 10 的倍数放大，宁可刻度变多也不让峰值顶出画布。
       */
      maxY: Math.max(40, Math.ceil(peak / 10) * 10),
      /* 未到时段画在 0 线上（V2 的画法），见 HourChartSpec.tailToZero */
      tailToZero: true,
      /*
       * 刻度标签：1/5/9/13/17/**23** —— 每 4 格一个，末端挂 23:00。
       *
       * 画布加宽到 378 后每格 15.5 单位、两个标签的最小安全间距约 33 单位
       * （「21:00」在 --fs-11 下约 32 单位宽）。21:00 与 23:00 只隔两格（31 单位），
       * 硬塞两个四位数会直接压字，所以这里把 21:00 让位给 23:00：轴末端是
       * 「今天收尾」的锚点，比中间多一个 21:00 更有信息量，标签数量仍是 6 个。
       * 17:00 与 23:00 之间隔 6 格（93 单位），空白足够。
       */
      pickLabel: (i, n) => i === n - 1 || (i % 4 === 0 && i <= n - 7),
    })
  }

  const demoHours = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]
  /** 未到时段不画（演示基线靠这个保住：等价于原先「只画到当前小时」） */
  const mask = (arr: number[]): (number | null)[] => arr.map((v, i) => (demoHours[i] <= nowHour ? v : null))
  return hourChart({
    hourNums: demoHours,
    workersAll: mask([2, 2, 2, 8, 36, 33, 18, 24, 27, 12, 4, 2]),
    managersAll: mask([2, 2, 2, 2, 7, 19, 3, 5, 10, 6, 2, 2]),
    maxY: 40,
    pickLabel: (i, n) => i === 0 || i === n - 1 || i % 3 === 0,
  })
}

/** 兼容旧签名：只取 SVG 字符串（v-html 渲染路径） */
export function peopleHourSvg(nowHour: number): string {
  return peopleHourModel(nowHour).svg
}
