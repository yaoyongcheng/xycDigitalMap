/**
 * 智能爬架 · 传感器读数
 *
 * 2026-11 设计稿 gx2 版同步（原 js/app.js:2474-2512）。爬架是「机位列表」型
 * 设备：36 个机位各有左右倾斜 / 前后倾斜 / 载重 / 读数时间四个值，其中
 * 30# 机位左右倾斜 179.70mm 超过 60mm 阈值，是全站唯一的异常点位 ——
 * 首页爬架卡片的「35/36 异常」与详情页高亮都从这份数据推导，不另写死。
 */

/** 最近一次上报时间（设计稿 sum 区固定文案） */
export const CLIMB_UPDATED = '2026-10-06 14:29:55'

/**
 * 传感器总数。设计稿 sum 区写 38，但有读数的机位只有 36 台 ——
 * 多出的 2 台按「未接入」理解，两处数字都按设计稿原样保留。
 */
export const CLIMB_TOTAL = 38

/** 左右倾斜异常阈值，卡片与详情页的异常文案共用 */
export const CLIMB_LR_LIMIT = '60mm'

/** 单个机位的读数（数值已按设计稿格式化为文本） */
export interface ClimbSensor {
  /** 机位号（1 起始） */
  id: number
  /** 左右倾斜，如 '0.16mm' */
  lr: string
  /** 前后倾斜，如 '3.11mm' */
  fb: string
  /** 载重，如 '1.03吨' */
  load: string
  /** 读数时间 HH:mm:ss */
  time: string
  /** 左右倾斜超限的机位（设计稿行尾的 'lr' 标记） */
  bad?: boolean
}

export const climbSensors: ClimbSensor[] = [
  { id: 1, lr: '0.16mm', fb: '3.11mm', load: '1.03吨', time: '14:02:37' },
  { id: 2, lr: '1.60mm', fb: '3.42mm', load: '1.03吨', time: '14:03:17' },
  { id: 3, lr: '0.54mm', fb: '4.16mm', load: '1.12吨', time: '14:04:02' },
  { id: 4, lr: '0.82mm', fb: '3.22mm', load: '1.15吨', time: '14:05:52' },
  { id: 5, lr: '0.05mm', fb: '3.34mm', load: '1.22吨', time: '14:06:33' },
  { id: 6, lr: '0.31mm', fb: '4.14mm', load: '1.15吨', time: '14:07:17' },
  { id: 7, lr: '1.47mm', fb: '4.20mm', load: '1.21吨', time: '14:07:52' },
  { id: 8, lr: '0.06mm', fb: '4.74mm', load: '0.86吨', time: '14:08:18' },
  { id: 9, lr: '0.20mm', fb: '4.99mm', load: '1.03吨', time: '14:08:48' },
  { id: 10, lr: '0.91mm', fb: '4.72mm', load: '1.04吨', time: '14:27:40' },
  { id: 11, lr: '0.12mm', fb: '4.51mm', load: '1.03吨', time: '14:10:03' },
  { id: 12, lr: '1.16mm', fb: '4.80mm', load: '1.05吨', time: '14:10:43' },
  { id: 13, lr: '0.37mm', fb: '5.27mm', load: '1.24吨', time: '14:11:08' },
  { id: 14, lr: '1.47mm', fb: '3.96mm', load: '1.29吨', time: '14:11:43' },
  { id: 15, lr: '0.28mm', fb: '4.79mm', load: '1.01吨', time: '14:12:23' },
  { id: 16, lr: '0.42mm', fb: '3.68mm', load: '1.08吨', time: '14:12:58' },
  { id: 17, lr: '1.05mm', fb: '4.33mm', load: '0.97吨', time: '14:13:28' },
  { id: 18, lr: '0.18mm', fb: '3.85mm', load: '1.18吨', time: '14:13:53' },
  { id: 19, lr: '0.73mm', fb: '5.02mm', load: '1.11吨', time: '14:14:18' },
  { id: 20, lr: '1.28mm', fb: '4.41mm', load: '0.92吨', time: '14:14:43' },
  { id: 21, lr: '0.09mm', fb: '3.57mm', load: '1.26吨', time: '14:15:13' },
  { id: 22, lr: '1.84mm', fb: '3.91mm', load: '0.84吨', time: '14:29:20' },
  { id: 23, lr: '0.65mm', fb: '5.77mm', load: '1.24吨', time: '14:15:48' },
  { id: 24, lr: '1.57mm', fb: '4.80mm', load: '1.34吨', time: '14:16:28' },
  { id: 25, lr: '0.23mm', fb: '4.86mm', load: '1.04吨', time: '14:17:03' },
  { id: 26, lr: '0.76mm', fb: '4.14mm', load: '1.33吨', time: '14:17:43' },
  { id: 27, lr: '0.10mm', fb: '3.61mm', load: '1.02吨', time: '14:18:18' },
  { id: 28, lr: '0.00mm', fb: '4.27mm', load: '0.93吨', time: '14:19:03' },
  { id: 29, lr: '1.16mm', fb: '2.87mm', load: '1.35吨', time: '14:19:48' },
  { id: 30, lr: '179.70mm', fb: '2.86mm', load: '0.99吨', time: '14:20:38', bad: true },
  { id: 31, lr: '0.13mm', fb: '4.65mm', load: '1.20吨', time: '14:23:13' },
  { id: 32, lr: '0.33mm', fb: '4.76mm', load: '1.16吨', time: '14:24:28' },
  { id: 33, lr: '0.17mm', fb: '2.95mm', load: '1.15吨', time: '14:26:08' },
  { id: 34, lr: '0.74mm', fb: '3.30mm', load: '1.24吨', time: '14:25:53' },
  { id: 35, lr: '0.19mm', fb: '3.93mm', load: '0.99吨', time: '14:01:37' },
  { id: 36, lr: '0.28mm', fb: '3.60mm', load: '1.20吨', time: '14:02:02' },
]

/** 数值文本拆成「数字 + 单位」两段，模板里给单位包小号字（原 climbUnit） */
export function splitUnit(text: string): { num: string; unit: string } {
  const m = /^([\d.]+)(.*)$/.exec(text)
  return m ? { num: m[1], unit: m[2] } : { num: text, unit: '' }
}
