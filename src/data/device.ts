import { reactive } from 'vue'

import type { DeviceKind, DeviceUnit } from '@/types'

/**
 * 设备详情（2026-10 版本同步 · 第四批，原 js/app.js:959-1397）
 *
 * 塔机与电梯在结构上是同一套东西：一排设备卡 + 页签。所以这里归一化成
 * DeviceUnit，页面只写一份（DevicePage）。
 *
 * **2026-11 第二轮：编造的机组与指标全部删除。**
 * 原先这里有 3 台塔机 + 4 台电梯的字面量（产权备案号、5 张趋势图的 7 天历史、
 * 吊次/吊重/利用率…），全部是设计稿示意值。现在设备清单来自台账接口
 * （`:8084` `/api/data/deviceinfos`，见 utils/deviceLedger.ts），本文件的
 * 职责只剩两件：
 *   ① 持有「当前真实机组」的响应式登记表（由 stores/deviceLedger 写入）；
 *   ② 给页面提供标题/名词这类与数据无关的元信息。
 *
 * 作业指标（吊次、吊重、利用率、近 7 日历史）来自 tsdb 接口
 * （`/api/data/v1/tsdb/queryRealTimeDataV2`），该路径在当前部署上 404
 * （80/443/8080–8091/9000 全试过），因此 `today` / `history` 恒为空，
 * 报表与历史弹层显示空态 —— 不拿曲线去填。
 */

/**
 * 当前真实机组（按设备类型分组）。
 *
 * 为什么放 `reactive` 而不是普通对象：`deviceSet` 是同步纯函数，被 5 个组件
 * 在 `computed` 里调用（设备页、报表、两个弹层、弹层宿主）。台账是登录后才
 * 异步到达的，如果这里不是响应式的，组件拿到的是空数组且**永远不重算**。
 */
const liveUnits = reactive<Record<DeviceKind, DeviceUnit[]>>({ crane: [], lift: [] })

/** 台账加载成功后由 stores/deviceLedger 写入；登出时传空数组清空 */
export function setLiveUnits(kind: DeviceKind, units: DeviceUnit[]): void {
  liveUnits[kind] = units
}

/** 是否已有真实机组（报表与历史弹层据此决定渲染数据还是空态） */
export function hasLiveUnits(kind: DeviceKind): boolean {
  return liveUnits[kind].length > 0
}

/** 按 kind 取设备组与配套文案 */
export function deviceSet(kind: DeviceKind): {
  units: DeviceUnit[]
  title: string
  reportTitle: string
  /** 单位名词，用于日报措辞 */
  noun: string
} {
  return kind === 'crane'
    ? { units: liveUnits.crane, title: '智能塔机', reportTitle: '塔机日报', noun: '塔机' }
    : { units: liveUnits.lift, title: '智能电梯', reportTitle: '电梯日报', noun: '电梯' }
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
