import { ref } from 'vue'
import { defineStore } from 'pinia'

import { b2FloorCount, b2Occupied } from '@/data/config'
import type { Building, Equip, HomeMod, PeopleNode } from '@/types'

/**
 * 首页
 *
 * 承载首页模块的数据与下钻状态。
 *
 * 2026-10 版本同步 · 第三批：模块从「安全 / 质量 / 进度 / 设备」收成
 * 「智眸 / 智巡 / 智控」——质量管理与进度管理整块删除，qaCats 随之移除；
 * 智巡的照片数据是常量，放在 data/config.ts 而不进 store。
 * siteEquip / siteBuildings 在原版有第二消费点，但均位于横屏地图的死代码链上
 * （landDevices / landBuildings），跳过死代码后它们实际是单域数据，归到此处。
 */
export const useHomeStore = defineStore('home', () => {
  /** 原 js/app.js:60 —— 当前面板。被 switchTab(L70) 读取以决定是否启预警轮播 */
  const homeMod = ref<HomeMod>('safety')

  /** 原 js/app.js:334 —— 人员分布下钻到的节点，null 表示区域列表 */
  const peopleNode = ref<PeopleNode | null>(null)

  /** 原 js/app.js:320-332 */
  const peopleTree = ref<PeopleNode[]>([
    { id: 'yard', name: '场布', count: 38 },
    {
      id: 'b2',
      name: '2#楼',
      count: 6,
      children: Array.from({ length: b2FloorCount }, (_, i) => {
        const n = i + 1
        return { id: 'b2-' + n, name: n + 'F', count: b2Occupied[n] || 0 }
      }),
    },
    { id: 'base', name: '地下室', count: 2 },
  ])

  /**
   * 原 js/app.js:851-878（2026-11 设计稿 gx2 版）
   *
   * 设备从 9 条收成 4 条：六台机器人整组删除；塔机加「今日吊重 + 今日吊次」
   * 双指标；电梯的卡片指标换成「累计运行时间」；无人机改成「作业任务 1/3」
   * 且整机离线；爬架改成异常态（卡片数据取自 data/climb.ts）。
   *
   * 机组数量刻意与详情页（data/device.ts）同源而不是照抄设计稿首页：
   * 设计稿自己就对不上（首页 4 台塔机 / 7 台电梯，详情页却是 3 台 / 4 台），
   * 点进卡片数字对不上会被当成 bug —— 按「卡片即入口」的项目约定，
   * 台数以详情页为准。
   */
  const siteEquip = ref<Equip[]>([
    { id: 'crane', name: '智能塔机', value: '1.87t', metric: '今日吊重', ico: 'crane', page: 'crane',
      stats: [
        { value: '1.87t', metric: '今日吊重' },
        { value: '26次', metric: '今日吊次' },
      ],
      units: [
        { name: '1#塔机', on: true, rows: [] },
        { name: '2#塔机', on: true, rows: [] },
        { name: '3#塔机', on: true, rows: [] },
      ] },
    { id: 'lift', name: '智能电梯', value: '2min', metric: '累计运行时间', ico: 'lift', page: 'lift',
      units: [
        { name: '智能电梯1-1', on: true, rows: [] },
        { name: '智能电梯1-2', on: false, rows: [] },
        { name: '智能电梯2-1', on: false, rows: [] },
        { name: '智能电梯2-2', on: true, rows: [] },
      ] },
    { id: 'drone', name: '无人机', value: '1/3', metric: '作业任务', ico: 'drone', page: 'uav',
      jobs: { done: 1, total: 3 },
      units: [{ name: '无人机', on: false, rows: [] }] },
    { id: 'climb', name: '智能爬架', value: '异常', metric: '左右倾斜', ico: 'climb', page: 'climb',
      units: [{ name: '智能爬架', on: true, rows: [] }] },
  ])

  /** 原 js/app.js:414-421 */
  const siteBuildings = ref<Building[]>([
    { name: '酒店', done: 16, total: 16, plan: '正常', rate: 96 },
    { name: '1#楼', done: 1, total: 8, plan: '正常', rate: 92 },
    { name: '2#楼', done: 1, total: 33, plan: '正常', rate: 88 },
    { name: '3#楼', done: 1, total: 33, plan: '正常', rate: 71 },
    { name: '4#楼', done: 1, total: 8, plan: '正常', rate: 90 },
    { name: '幼儿园', done: 3, total: 3, plan: '正常', rate: 94 },
  ])

  /** 原 js/app.js:336-338 peopleChildren() */
  function peopleChildren(): PeopleNode[] {
    return peopleNode.value ? peopleNode.value.children || [] : peopleTree.value
  }

  /**
   * 原 js/app.js:562-566 equipCount(d)
   * st 的三个取值 "off" / "warn" / "on" 会被拼进 CSS class，不可改名。
   */
  function equipCount(d: Equip): { on: number; total: number; st: 'off' | 'warn' | 'on' } {
    const on = d.units.filter((u) => u.on).length
    const total = d.units.length
    return { on, total, st: on <= 0 ? 'off' : on < total ? 'warn' : 'on' }
  }

  return {
    homeMod,
    peopleNode,
    peopleTree,
    siteEquip,
    siteBuildings,
    peopleChildren,
    equipCount,
  }
})
