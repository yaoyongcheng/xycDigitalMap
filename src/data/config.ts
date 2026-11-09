import type { Alarm, MineMenu, PatrolCat, PatrolPhoto, TabId } from '@/types'

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
 * 「我的」三个菜单的占位说明（2026-10 交互优化新增）。
 *
 * 原先三个入口点进去是同一句通用文案 —— 用户点了「设置」看到的是
 * 「『设置』内页…后续按账号、工地和设置补齐」，等于什么都没说，也不知道
 * 这个入口到底打算干什么。这里给每个入口一句各自的范围说明，让占位页
 * 至少能传达「这里将来放什么」。
 */
export const mineNotes: Record<string, string> = {
  我的工地: '在这里切换当前工地、查看已加入的项目与成员。接入账号体系后按账号权限返回可切换列表。',
  设置: '消息推送、地图图层、离线缓存等偏好设置。当前为演示版，配置项尚未开放。',
  关于: '版本号、更新日志与第三方许可说明。当前为演示版，版本信息由 PWA 更新提示提供。',
}

/**
 * 原 js/app.js:50 —— 抓拍池，3 项均为同一张图
 * 图片统一为 WebP（2026-10 图片压缩，原 .jpg 源图移入 legacy/img-unused/）
 */
export const camShotPool = ['img/cam-crane2.webp', 'img/cam-crane2.webp', 'img/cam-crane2.webp']

/** 原 js/app.js:51 */
export const camShotTimes = ['08:12', '12:36', '16:50']

/** 原 js/app.js:259 —— 预警轮播可视条数 */
export const ALARM_FEED_SHOW = 3

/**
 * 预警采集来源（2026-11 设计稿 gx2 版，原 app.js:255-259）。
 *
 * tag：列表徽标上的短文案；name / sub：详情页大图角标的主副标题。
 * 同一来源的徽标与角标必须同源取值，否则列表说「随手拍」、
 * 详情页却写「自动巡航无人机」就穿帮了。
 */
export const ALARM_SRC = {
  drone: { tag: '无人机', name: '自动巡航无人机', sub: 'UAV-25638583' },
  cam: { tag: '视频监控', name: '视频监控抓拍', sub: 'CAM-2#塔吊' },
  snap: { tag: '随手拍', name: '管理人员随手拍', sub: '张工 安全员' },
} as const

/** 原 alarmSrc(a)（app.js:261-263）—— 未知来源回退到无人机 */
export function alarmSrcOf(src: Alarm['src']): (typeof ALARM_SRC)[Alarm['src']] {
  return ALARM_SRC[src] ?? ALARM_SRC.drone
}

/** 原 js/app.js:318-319 —— 2#楼各层占用人数的稀疏表 + 总层数 */
export const b2Occupied: Record<number, number> = { 1: 5, 4: 1 }
export const b2FloorCount = 5

/*
 * 原 qaSteps（验收工序环形图）与 milestones（里程碑时间轴）随 2026-10 版本
 * 同步删除：设计稿把「质量管理」与「进度管理」两个首页模块整块拿掉，
 * 这两个数组再没有消费方。
 */

/**
 * 巡检照片分类（2026-10 版本同步 · 第三批，原 js/app.js:547-554）
 *
 * 顺序即界面上的排列顺序（三列网格，两行）：项目全景 / 基坑区域 / 作业面
 * 是第一行，施工装备 / 材料堆场 / 现场场布 是第二行。
 */
export const patrolCats: PatrolCat[] = [
  { id: 'pano', name: '项目全景' },
  { id: 'pit', name: '基坑区域' },
  { id: 'face', name: '作业面' },
  { id: 'equip', name: '施工装备' },
  { id: 'yard', name: '材料堆场' },
  { id: 'layout', name: '现场场布' },
]

const PATROL_SRC = {
  pano: 'img/patrol-pano.webp',
  face: 'img/patrol-face.webp',
  crane: 'img/patrol-crane.webp',
  crane2: 'img/patrol-crane-2.webp',
  yard: 'img/patrol-yard.webp',
  layout: 'img/patrol-layout.webp',
  layout2: 'img/patrol-layout-2.webp',
  road: 'img/patrol-road.webp',
  power: 'img/patrol-power.webp',
  aerialA: 'img/aerial-a.webp',
  aerialB: 'img/aerial-b.webp',
  cam: 'img/cam-crane2.webp',
} as const

/**
 * 巡检照片（原 js/app.js:555-573，17 张）
 *
 * 图片一律 WebP（2026-10 版本同步时从设计稿取原图，按 720px 宽转码压缩）：
 * 这些照片同时用于 96px 缩略图与 210px 大图，720px 在 2x 屏下仍有余量，
 * 单张 48~87KB，九张合计 664KB。
 */
export const patrolPhotos: PatrolPhoto[] = [
  { id: 'pano', cat: 'pano', name: '项目全景', src: 'drone', img: PATROL_SRC.pano, pos: 'fit', time: '16:12' },
  { id: 'pano-2', cat: 'pano', name: '项目鸟瞰', src: 'drone', img: PATROL_SRC.aerialA, pos: 'fit', time: '15:48' },
  { id: 'pit-slope', cat: 'pit', name: '基坑边坡', src: 'drone', img: PATROL_SRC.aerialB, pos: 'p-l', time: '15:28' },
  { id: 'pit-edge', cat: 'pit', name: '坑边', src: 'drone', img: PATROL_SRC.aerialB, pos: 'p-r', time: '15:22' },
  { id: 'pit-drain', cat: 'pit', name: '排水沟', src: 'drone', img: PATROL_SRC.aerialA, pos: 'p-b', time: '15:16' },
  { id: 'face-work', cat: 'face', name: '作业面', src: 'drone', img: PATROL_SRC.face, pos: 'fit', time: '14:55' },
  { id: 'face-scaffold', cat: 'face', name: '外架/悬挑架', src: 'drone', img: PATROL_SRC.aerialB, pos: 'p-tl', time: '14:48' },
  { id: 'equip-crane', cat: 'equip', name: '塔机', src: 'drone', img: PATROL_SRC.crane, pos: 'fit', time: '16:50' },
  { id: 'equip-crane-2', cat: 'equip', name: '塔吊', src: 'drone', img: PATROL_SRC.crane2, pos: 'fit', time: '16:55' },
  { id: 'equip-lift', cat: 'equip', name: '施工电梯', src: 'cam', img: PATROL_SRC.cam, pos: 'p-r', time: '16:42' },
  { id: 'yard-rebar', cat: 'yard', name: '钢筋加工棚', src: 'cam', img: PATROL_SRC.cam, pos: 'p-b', time: '16:36' },
  { id: 'yard-form', cat: 'yard', name: '模板加工区', src: 'cam', img: PATROL_SRC.cam, pos: 'p-t', time: '16:28' },
  { id: 'yard-stock', cat: 'yard', name: '堆场', src: 'drone', img: PATROL_SRC.yard, pos: 'fit', time: '16:48' },
  { id: 'layout', cat: 'layout', name: '现场场布', src: 'drone', img: PATROL_SRC.layout, pos: 'fit', time: '16:18' },
  { id: 'layout-2', cat: 'layout', name: '场区鸟瞰', src: 'drone', img: PATROL_SRC.layout2, pos: 'fit', time: '16:26' },
  { id: 'layout-road', cat: 'layout', name: '道路', src: 'drone', img: PATROL_SRC.road, pos: 'fit', time: '16:34' },
  { id: 'layout-power', cat: 'layout', name: '配电箱', src: 'drone', img: PATROL_SRC.power, pos: 'fit', time: '16:40' },
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
