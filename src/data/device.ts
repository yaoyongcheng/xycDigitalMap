import { addDays, protoToday } from '@/utils/date'
import type { DeviceKind, DeviceMetric, DeviceUnit } from '@/types'

/**
 * 设备详情数据（2026-10 版本同步 · 第四批，原 js/app.js:959-1397）
 *
 * 塔机与电梯在结构上是同一套东西：一排设备卡 + 当日对比仪表 + 五张趋势图
 * + 历史数据 + 日报。所以这里归一化成 DeviceUnit，页面只写一份（DevicePage）。
 * 差异收在三个地方：
 *   · metrics    五张趋势图分别画什么
 *   · compare    当日对比哪几项
 *   · meterGroups 下面那组「A/B/C 三行 + 进度条」的仪表
 *
 * 数值一律存数字不存「10次」「10.00t」这类字符串 —— 图表要算均值、
 * 日报要算同比，字符串得来回 parseFloat 再拼回去，小数点位数会漂。
 * 单位与小数位交给 metrics 里的 dp，显示时统一 formatMetric()。
 */

/* ---------------- 指标定义 ---------------- */

const CRANE_METRICS: DeviceMetric[] = [
  { key: 'trips', name: '累计吊次', unit: '次', dp: 0 },
  { key: 'weight', name: '累计吊重', unit: 't', dp: 2 },
  { key: 'avgTime', name: '平均单次吊运时长', unit: '分钟', dp: 1 },
  { key: 'util', name: '时长利用率', unit: '%', dp: 0 },
  { key: 'rate', name: '吊重负荷率', unit: '%', dp: 0 },
]

const LIFT_METRICS: DeviceMetric[] = [
  { key: 'trips', name: '循环次数', unit: '次', dp: 0 },
  { key: 'time', name: '运行时长', unit: 'h', dp: 1 },
  { key: 'people', name: '运送人数', unit: '人', dp: 0 },
  { key: 'load', name: '累计载重', unit: 't', dp: 2 },
  { key: 'util', name: '时长利用率', unit: '%', dp: 0 },
]

/** 当日对比项（今日值 vs 近 7 日均值，带涨跌百分比） */
export interface CompareRow {
  label: string
  /** 今日值的指标 key */
  key: string
  /** 均值的指标 key */
  avgKey: string
  unit: string
  /** 小数位：次数取 0，重量 2，时长 1 */
  dp: number
}

const CRANE_COMPARE: CompareRow[] = [
  { label: '累计吊次', key: 'trips', avgKey: 'weekTrips', unit: '次', dp: 0 },
  { label: '累计吊重', key: 'weight', avgKey: 'weekWeight', unit: 't', dp: 2 },
  { label: '平均单次吊运时长', key: 'avgTime', avgKey: 'weekTime', unit: '分钟', dp: 1 },
]

const LIFT_COMPARE: CompareRow[] = [
  { label: '循环次数', key: 'trips', avgKey: 'weekTrips', unit: '次', dp: 0 },
  { label: '运行时长', key: 'time', avgKey: 'weekTime', unit: 'h', dp: 1 },
  { label: '运送人数', key: 'people', avgKey: 'weekPeople', unit: '人', dp: 0 },
  { label: '累计载重', key: 'load', avgKey: 'weekLoad', unit: 't', dp: 2 },
]

/** 「A/B/C 三行 + 进度条」的仪表组 */
export interface MeterGroup {
  rows: { label: string; key: string; em?: boolean }[]
  /** 进度条的百分比取哪个 key */
  pctKey: string
}

const CRANE_METERS: MeterGroup[] = [
  {
    rows: [
      { label: '总通电时长', key: 'power' },
      { label: '有效工作时长', key: 'work' },
      { label: '时长利用率', key: 'util', em: true },
    ],
    pctKey: 'util',
  },
  {
    rows: [
      { label: '平均单次吊重', key: 'avgWeight' },
      { label: '最大单次吊重', key: 'maxWeight' },
      { label: '吊重负荷率', key: 'rate', em: true },
    ],
    pctKey: 'rate',
  },
]

const LIFT_METERS: MeterGroup[] = [
  {
    rows: [
      { label: '通电时长', key: 'power' },
      { label: '运行时长', key: 'work' },
      { label: '时长利用率', key: 'util', em: true },
    ],
    pctKey: 'util',
  },
]

/* ---------------- 历史日期 ---------------- */

/** 历史记录的日期：从昨天往前数 7 天，随系统日期走（原版写死 10-15~10-21） */
const HIST_DATES = Array.from({ length: 7 }, (_, i) => {
  const d = addDays(protoToday(), -1 - i)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})

/**
 * 把「每列一个数组」压成历史行。
 *
 * 数据源在参考实现里是 7 个对象、每个对象 7~9 个字段，逐行抄是 50 行
 * 纯字面量且极易错位；这里按列写，压缩后一眼能核对「11 天 → 7 天」的对应关系。
 */
function hist(cols: Record<string, number[]>): DeviceUnit['history'] {
  return HIST_DATES.map((date, i) => {
    const vals: Record<string, number> = {}
    for (const [k, arr] of Object.entries(cols)) vals[k] = arr[i]
    return { date, vals }
  })
}

/* ---------------- 塔机 ---------------- */

export const craneMetrics = CRANE_METRICS
export const craneCompare = CRANE_COMPARE
export const craneMeters = CRANE_METERS

export const craneUnits: DeviceUnit[] = [
  {
    id: '2',
    tab: '1#塔机',
    name: '1#塔机',
    status: '待机',
    alarms: '0次',
    cells: [['塔司', '周磊'], ['报警次数', '0次'], ['实时回转', '56.48°'], ['实时高度', '27.00m']],
    info: [
      ['产权备案号', '鄂AA-T32016'],
      ['关联塔吊人脸识别设备', '053325077320'],
      ['设备型号', 'STC100A'],
      ['设备出厂时间', '2026-04-16'],
      ['已使用年限', '0.5年'],
    ],
    today: { trips: 10, weight: 10.0, avgTime: 3.5, util: 56, rate: 32, power: 8.6, work: 4.8, avgWeight: 1.0, maxWeight: 2.4, weekTrips: 8.6, weekWeight: 8.5, weekTime: 4.1 },
    history: hist({
      trips: [9, 7, 11, 8, 6, 10, 8],
      weight: [8.6, 6.4, 9.8, 7.2, 5.1, 9.2, 7.8],
      avgTime: [3.8, 4.6, 3.2, 4.0, 5.1, 3.6, 4.3],
      util: [61, 48, 72, 54, 41, 63, 57],
      rate: [34, 28, 41, 30, 22, 36, 31],
      power: [7.5, 7.9, 7.5, 7.6, 7.8, 7.9, 7.7],
      work: [4.6, 3.8, 5.4, 4.1, 3.2, 5.0, 4.4],
      avgWeight: [0.96, 0.91, 0.89, 0.9, 0.85, 0.92, 0.98],
      maxWeight: [2.1, 1.8, 2.6, 2.2, 1.6, 2.4, 2.0],
    }),
  },
  {
    id: '3',
    tab: '2#塔机',
    name: '2#塔机',
    status: '工作中',
    alarms: '0次',
    cells: [['塔司', '陈浩'], ['报警次数', '0次'], ['实时回转', '112.36°'], ['实时高度', '46.50m']],
    info: [
      ['产权备案号', '鄂AA-T32018'],
      ['关联塔吊人脸识别设备', '053325077321'],
      ['设备型号', 'STC100A'],
      ['设备出厂时间', '2026-03-08'],
      ['已使用年限', '0.6年'],
    ],
    live: { value: '1.26t', pct: 36 },
    today: { trips: 9, weight: 5.05, avgTime: 4.2, util: 69, rate: 28, power: 7.4, work: 5.1, avgWeight: 0.56, maxWeight: 1.8, weekTrips: 11.0, weekWeight: 6.8, weekTime: 3.6 },
    history: hist({
      trips: [12, 10, 13, 9, 11, 8, 12],
      weight: [7.1, 6.2, 8.4, 5.6, 6.9, 4.8, 7.4],
      avgTime: [3.2, 3.8, 3.0, 4.1, 3.5, 4.4, 3.3],
      util: [74, 66, 81, 58, 70, 52, 76],
      rate: [31, 26, 38, 24, 29, 22, 33],
      power: [7.3, 7.3, 7.2, 7.2, 7.1, 6.9, 7.2],
      work: [5.4, 4.8, 5.8, 4.2, 5.0, 3.6, 5.5],
      avgWeight: [0.59, 0.62, 0.65, 0.62, 0.63, 0.6, 0.62],
      maxWeight: [1.6, 1.4, 2.1, 1.5, 1.7, 1.2, 1.9],
    }),
  },
  {
    id: '4',
    tab: '3#塔机',
    name: '3#塔机',
    status: '工作中',
    alarms: '3次',
    cells: [['塔司', '李明'], ['报警次数', '3次'], ['实时回转', '18.74°'], ['实时高度', '35.10m']],
    info: [
      ['产权备案号', '鄂AA-T32021'],
      ['关联塔吊人脸识别设备', '053325077328'],
      ['设备型号', 'STC80A'],
      ['设备出厂时间', '2025-11-18'],
      ['已使用年限', '0.9年'],
    ],
    live: { value: '0.92t', pct: 71 },
    today: { trips: 7, weight: 3.53, avgTime: 2.8, util: 39, rate: 44, power: 6.2, work: 2.4, avgWeight: 0.5, maxWeight: 1.35, weekTrips: 9.5, weekWeight: 5.2, weekTime: 3.8 },
    history: hist({
      trips: [8, 11, 6, 9, 10, 7, 12],
      weight: [4.2, 6.1, 3.4, 5.0, 5.8, 3.9, 6.6],
      avgTime: [3.4, 4.2, 4.6, 3.6, 3.1, 4.8, 3.3],
      util: [36, 48, 28, 41, 45, 32, 51],
      rate: [38, 46, 30, 42, 48, 34, 50],
      power: [7.2, 7.1, 7.1, 6.8, 6.9, 6.9, 7.1],
      work: [2.6, 3.4, 2.0, 2.8, 3.1, 2.2, 3.6],
      avgWeight: [0.53, 0.55, 0.57, 0.56, 0.58, 0.56, 0.55],
      maxWeight: [1.2, 1.5, 0.9, 1.3, 1.4, 1.1, 1.6],
    }),
  },
]

/* ---------------- 智能电梯 ---------------- */

export const liftMetrics = LIFT_METRICS
export const liftCompare = LIFT_COMPARE
export const liftMeters = LIFT_METERS

export const liftUnits: DeviceUnit[] = [
  {
    id: '11',
    tab: '1-1',
    name: '智能电梯1-1',
    status: '在线',
    cells: [['当前楼层', '8F'], ['当前高度', '22.4m'], ['当前人数', '6人'], ['当前载重', '480kg']],
    info: [['升降机编号', 'E03C1CB9F5011821']],
    today: { trips: 86, time: 6.4, people: 640, load: 12.8, util: 78, power: 8.2, work: 6.4, weekTrips: 72, weekTime: 7.1, weekPeople: 580, weekLoad: 9.4 },
    history: hist({
      trips: [78, 64, 91, 70, 55, 82, 68],
      time: [6.8, 5.6, 7.4, 6.2, 4.8, 7.0, 6.0],
      people: [610, 520, 690, 560, 440, 630, 540],
      load: [11.2, 8.4, 13.1, 9.1, 7.2, 10.8, 8.8],
      util: [79, 72, 82, 74, 67, 80, 75],
      power: [8.6, 7.8, 9.0, 8.4, 7.2, 8.8, 8.0],
      work: [6.8, 5.6, 7.4, 6.2, 4.8, 7.0, 6.0],
    }),
  },
  {
    id: '12',
    tab: '1-2',
    name: '智能电梯1-2',
    status: '离线',
    cells: [['当前楼层', '--'], ['当前高度', '--'], ['当前人数', '--'], ['当前载重', '--']],
    info: [['升降机编号', 'E03C1CB9F5011822']],
    today: { trips: 18, time: 1.6, people: 96, load: 2.1, util: 50, power: 3.2, work: 1.6, weekTrips: 26, weekTime: 2.8, weekPeople: 140, weekLoad: 3.2 },
    history: hist({
      trips: [22, 28, 16, 30, 24, 19, 27],
      time: [2.4, 3.1, 1.8, 3.4, 2.6, 2.0, 2.9],
      people: [120, 150, 90, 160, 130, 100, 145],
      load: [2.6, 3.4, 1.9, 3.8, 2.9, 2.2, 3.3],
      util: [55, 60, 50, 61, 54, 50, 58],
      power: [4.4, 5.2, 3.6, 5.6, 4.8, 4.0, 5.0],
      work: [2.4, 3.1, 1.8, 3.4, 2.6, 2.0, 2.9],
    }),
  },
  {
    id: '21',
    tab: '2-1',
    name: '智能电梯2-1',
    status: '离线',
    cells: [['当前楼层', '--'], ['当前高度', '--'], ['当前人数', '--'], ['当前载重', '--']],
    info: [['升降机编号', 'E03C1CB9F5011823']],
    today: { trips: 9, time: 0.8, people: 42, load: 0.86, util: 33, power: 2.4, work: 0.8, weekTrips: 18, weekTime: 2.2, weekPeople: 90, weekLoad: 1.9 },
    history: hist({
      trips: [14, 20, 11, 22, 16, 8, 18],
      time: [1.6, 2.4, 1.2, 2.6, 1.8, 0.9, 2.1],
      people: [70, 100, 55, 110, 80, 40, 92],
      load: [1.4, 2.1, 1.1, 2.4, 1.7, 0.8, 1.9],
      util: [44, 50, 38, 50, 43, 35, 46],
      power: [3.6, 4.8, 3.2, 5.2, 4.2, 2.6, 4.6],
      work: [1.6, 2.4, 1.2, 2.6, 1.8, 0.9, 2.1],
    }),
  },
  {
    id: '22',
    tab: '2-2',
    name: '智能电梯2-2',
    status: '停止',
    cells: [['当前楼层', '15F'], ['当前高度', '41.8m'], ['当前人数', '0人'], ['当前载重', '0.0kg']],
    info: [['升降机编号', 'E03C1CB9F5011824']],
    today: { trips: 24, time: 2.1, people: 168, load: 3.5, util: 46, power: 4.6, work: 2.1, weekTrips: 31, weekTime: 3.6, weekPeople: 220, weekLoad: 4.8 },
    history: hist({
      trips: [28, 34, 22, 36, 30, 19, 33],
      time: [3.2, 3.8, 2.4, 4.1, 3.4, 2.0, 3.7],
      people: [200, 240, 160, 260, 210, 140, 230],
      load: [4.2, 5.1, 3.4, 5.6, 4.6, 3.1, 5.0],
      util: [50, 53, 44, 54, 50, 42, 53],
      power: [6.4, 7.2, 5.4, 7.6, 6.8, 4.8, 7.0],
      work: [3.2, 3.8, 2.4, 4.1, 3.4, 2.0, 3.7],
    }),
  },
]

/** 按 kind 取一组设备与配套定义 */
export function deviceSet(kind: DeviceKind): {
  units: DeviceUnit[]
  metrics: DeviceMetric[]
  compare: CompareRow[]
  meters: MeterGroup[]
  title: string
  reportTitle: string
  /** 单位名词，用于日报措辞 */
  noun: string
} {
  return kind === 'crane'
    ? { units: craneUnits, metrics: craneMetrics, compare: craneCompare, meters: craneMeters, title: '智能塔机', reportTitle: '塔机日报', noun: '塔机' }
    : { units: liftUnits, metrics: liftMetrics, compare: liftCompare, meters: liftMeters, title: '智能电梯', reportTitle: '电梯日报', noun: '电梯' }
}

/* ---------------- 无人机 ---------------- */

export interface UavTask {
  time: string
  name: string
  state: '执行中' | '待执行' | '已完成'
  pct?: number
}

export const uavRoutes = [
  { id: 'daily', name: '向阳村日常巡航', meta: '全场航线 · 约 18 分钟' },
  { id: 'crane', name: '塔吊巡查航线', meta: '塔吊作业区 · 约 8 分钟' },
  { id: 'face', name: '作业面定点航线', meta: '主体作业面 · 约 6 分钟' },
  { id: 'loop', name: '场区环绕航线', meta: '基坑一周 · 约 12 分钟' },
]

export const uavTodayTasks: UavTask[] = [
  { time: '08:30', name: '向阳村日常巡航', state: '执行中', pct: 62 },
  { time: '10:00', name: '塔吊巡查航线', state: '待执行' },
  { time: '14:30', name: '作业面定点航线', state: '已完成' },
]

/** 机载实时读数：起飞条件校验与设备参数共用同一份 */
export const uavLive = { wind: 2, battery: 78, netKbps: 2079, temp: 28.8, rain: false }

/** 起飞条件（原 uavDispatchChecks） */
export const uavChecks = [
  { name: '风速', ok: uavLive.wind <= 8, risk: '风速超过 8m/s' },
  { name: '电量', ok: uavLive.battery >= 30, risk: '电量低于 30%' },
  { name: '网络质量', ok: uavLive.netKbps >= 500, risk: '网络质量不足' },
  { name: '电池温度', ok: uavLive.temp >= 0 && uavLive.temp <= 45, risk: '电池温度异常' },
  { name: '雨量', ok: !uavLive.rain, risk: '当前有雨' },
]
