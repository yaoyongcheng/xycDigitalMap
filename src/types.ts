/**
 * 领域类型定义
 *
 * 全部依据 js/app.js（原版基线）中的数据字面量结构反推，
 * 字段名与顺序保持原样，便于后续接入后端接口时逐字段对齐。
 */

/** 顶部 tab 标识 */
export type TabId = 'home' | 'work' | 'msg' | 'mine'

/** 首页四大模块 */
export type HomeMod = 'safety' | 'quality' | 'progress' | 'equip'

/** 监控分组 */
export type CamGroup = '出入口' | '场内' | '塔吊'

/** 监控点位（对应原 cameras 数组，18 条） */
export interface Camera {
  id: string
  name: string
  group: CamGroup
  /** 原始数据中被 .map() 统一覆盖为 'img/cam-crane2.webp' */
  img: string
  /** 原始数据中被 .map() 统一覆盖为 '' */
  pos: string
}

/** 预警日归属：当日 / 历史 */
export type AlarmDay = 'today' | 'hist'

/** 巡检预警（对应原 inspectAlarms 数组，8 条） */
export interface Alarm {
  id: string
  day: AlarmDay
  type: string
  title: string
  desc: string
  img: string
  /** 相对时间文案，如「1分钟前」 */
  rel: string
  /** 绝对时间，'YYYY-MM-DD HH:mm:ss' */
  at: string
  /** 经纬度，'lng,lat' */
  geo: string
}

/** 消息列表项（对应原 messages 数组） */
export interface Message {
  kind: 'people' | 'inspect'
  title: string
  desc: string
  time: string
  unread: number
}

/** 「我的」菜单项 */
export interface MineMenu {
  id: string
  name: string
}

/** 楼栋进度（对应原 siteBuildings 数组） */
export interface Building {
  name: string
  done: number
  total: number
  plan: string
  rate: number
}

/** 质量类目（对应原 qaCats 数组） */
export interface QaCat {
  name: string
  last: number
  now: number
}

/** 质量验收工序（对应原 qaSteps 数组） */
export interface QaStep {
  name: string
  n: number
  color: string
}

/** 设备下辖单元（对应原 siteEquip[].units[]） */
export interface EquipUnit {
  name: string
  on: boolean
  /** [指标名, 数值] 二元组 */
  rows: [string, string][]
}

/** 设备（对应原 siteEquip 数组，9 条） */
export interface Equip {
  id: string
  name: string
  value: string
  metric: string
  ico: string
  units: EquipUnit[]
}

/** 人员分布节点（对应原 peopleTree） */
export interface PeopleNode {
  id: string
  name: string
  count: number
  children?: PeopleNode[]
}

/** 里程碑（原位于 renderProgress 函数内的硬编码数组） */
export interface Milestone {
  name: string
  plan: string
  actual: string
  delta?: number
  state: 'done' | 'now' | 'todo'
}

/** 日历单元格 */
export interface CalCell {
  /** 日号，空串表示补位空格 */
  day: string
  /** 是否为当前选中日 */
  on: boolean
  /** 是否禁用（超出可选范围） */
  off: boolean
}

/** 地图点位类别：摄像头 / 塔吊 / 楼栋 */
export type MapPointKind = 'cam' | 'crane' | 'building'

/**
 * 地图撒点（交互地图层新增）
 *
 * x/y 为相对底图宽高的百分比（0-100），与底图内容绑定，
 * 与容器尺寸、缩放级别无关 —— 缩放/平移由 MapViewer 统一处理。
 */
export interface MapPoint {
  id: string
  kind: MapPointKind
  name: string
  x: number
  y: number
  /** cam / crane 点位关联的监控 id（cameras 中的点位） */
  camId?: string
}
