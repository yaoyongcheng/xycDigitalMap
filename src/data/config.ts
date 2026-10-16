import type { MapPoint, MineMenu, Milestone, QaStep, TabId } from '@/types'

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

/**
 * 原 js/app.js:50 —— 抓拍池，3 项均为同一张图
 * 图片统一为 WebP（2026-10 图片压缩，原 .jpg 源图移入 legacy/img-unused/）
 */
export const camShotPool = ['img/cam-crane2.webp', 'img/cam-crane2.webp', 'img/cam-crane2.webp']

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
export const airImgs = ['img/aerial-a.webp', 'img/aerial-b.webp']
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

/**
 * 人员概况四指标（原 renderSafety 内联硬编码，非接口数据）。
 * 安全面板与横屏 KPI 数据坞共用，接后端后由接口替换。
 */
export const crewKpis: [number, string, string][] = [
  [160, '人', '项目人数'],
  [40, '人', '正在上班'],
  [76, '人', '今日出勤'],
  [47.5, '%', '出勤率'],
]

/**
 * 地图撒点（交互地图层新增，非原版内容）
 *
 * 坐标为相对底图 site-map.webp（1024×735）的百分比，按底图内容目测定标：
 *   - cam/crane 点位关联 cameras 中的真实点位 id，点击直接打开监控
 *   - building 点位关联 siteBuildings 的楼栋名，点击弹出进度摘要
 * 接入后端后应由接口返回坐标，此处为演示标定值。
 */
export const mapPoints: MapPoint[] = [
  // 出入口摄像头
  { id: 'mp-g1', kind: 'cam', name: '1#门', x: 44, y: 90, camId: 'g1' },
  { id: 'mp-g4', kind: 'cam', name: '4#门', x: 9, y: 62, camId: 'g4' },
  { id: 'mp-g2a', kind: 'cam', name: '2#门', x: 93, y: 57, camId: 'g2a' },
  { id: 'mp-cama', kind: 'cam', name: '场内A', x: 55, y: 58, camId: 'cama' },
  // 塔吊
  { id: 'mp-crane2', kind: 'crane', name: '2#塔吊', x: 48, y: 41, camId: 'crane2' },
  { id: 'mp-crane4', kind: 'crane', name: '4#塔吊', x: 72, y: 33, camId: 'crane4' },
  // 楼栋
  { id: 'mp-hotel', kind: 'building', name: '酒店', x: 25, y: 53 },
  { id: 'mp-b1', kind: 'building', name: '1#楼', x: 42, y: 26 },
  { id: 'mp-b2', kind: 'building', name: '2#楼', x: 61, y: 71 },
  { id: 'mp-b3', kind: 'building', name: '3#楼', x: 81, y: 27 },
  { id: 'mp-b4', kind: 'building', name: '4#楼', x: 78, y: 54 },
  { id: 'mp-kg', kind: 'building', name: '幼儿园', x: 60, y: 49 },
]
