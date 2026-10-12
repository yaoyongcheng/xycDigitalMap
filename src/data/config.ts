import type { MineMenu, Milestone, QaStep, TabId } from '@/types'

/**
 * 纯静态配置常量
 *
 * 这些值不随接口返回而变化，故不进 Pinia store，直接 import 使用。
 * 逐字搬运自 js/app.js（原版基线），仅补类型标注。
 */

/** 原 js/app.js:2 */
export const titles: Record<TabId, string> = {
  home: '首页',
  work: '工作台',
  msg: '消息',
  mine: '我的',
}

/** 原 js/app.js:23 */
export const mineMenus: MineMenu[] = [
  { id: 'sites', name: '我的工地' },
  { id: 'setting', name: '设置' },
  { id: 'about', name: '关于' },
]

/** 原 js/app.js:50 —— 抓拍池，3 项均为同一张图 */
export const camShotPool = ['img/cam-crane2.jpg', 'img/cam-crane2.jpg', 'img/cam-crane2.jpg']

/** 原 js/app.js:51 */
export const camShotTimes = ['08:12', '12:36', '16:50']

/** 原 js/app.js:259 —— 预警轮播可视条数 */
export const ALARM_FEED_SHOW = 3

/** 原 js/app.js:318-319 —— 2#楼各层占用人数的稀疏表 + 总层数 */
export const b2Occupied: Record<number, number> = { 1: 5, 4: 1 }
export const b2FloorCount = 5

/** 原 js/app.js:429 */
export const qaSteps: QaStep[] = [
  { name: '验收工序1', n: 1, color: '#4C9FFF' },
  { name: '验收工序2', n: 1, color: '#22C55E' },
  { name: '验收工序3', n: 3, color: '#F5C14A' },
  { name: '验收工序4', n: 1, color: '#FF6B6B' },
]

/**
 * 原 js/app.js:492-500
 * 注意：原版该数组写在 renderProgress() 函数体内（每次渲染重建），
 * 这里提到模块作用域。数据内容逐字不变，且为常量，行为等同。
 */
export const milestones: Milestone[] = [
  { name: '项目开始', plan: '2025-08-15', actual: '2026-07-15', delta: -31, state: 'done' },
  { name: '施工图审查完成', plan: '2025-10-15', actual: '2025-09-30', delta: -15, state: 'done' },
  { name: '新建地下室出正负零', plan: '2026-11-01', actual: '--', state: 'now' },
  { name: '既有结构加固改造完成', plan: '2026-12-30', actual: '--', state: 'todo' },
  { name: '主体结构封顶', plan: '2027-03-16', actual: '--', state: 'todo' },
  { name: '外立面、机电安装完成', plan: '2027-09-30', actual: '--', state: 'todo' },
  { name: '项目竣工', plan: '2027-10-23', actual: '--', state: 'todo' },
]

/** 原 js/app.js:1331-1333 —— 无人机巡检素材 */
export const airImgs = ['img/aerial-a.jpg', 'img/aerial-b.jpg']
export const airTimes = [
  '07:22', '08:15', '09:08', '10:32', '11:46',
  '13:18', '14:55', '16:12', '17:38', '18:21',
]
export const airPos = [
  'pos-tl', 'pos-tr', 'pos-c', 'pos-bl', 'pos-br',
  'pos-l', 'pos-r', 'pos-t', 'pos-b', 'pos-c',
]

/** 原 js/app.js:1401 */
export const hazardKindList = ['安全防护', '文明施工', '用电隐患', '消防通道', '其他']
