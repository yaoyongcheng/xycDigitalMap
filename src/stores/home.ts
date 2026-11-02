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

  /** 原 js/app.js:534-558 —— 9 台设备 */
  const siteEquip = ref<Equip[]>([
    /*
     * 塔机与电梯的数值随 2026-10 版本同步更新（第四批）：原来塔机只有一台
     * 「5G塔机」，现在拆成 1#/2#/3# 三台与设备详情页的机组一一对应；
     * 电梯的循环次数也从 122/0/0/0 换成真实分布 86/18/9/24。
     * 首页卡片与详情页必须同源，否则点进去数字对不上。
     */
    { id: 'crane', name: '智能塔机', value: '18.58t', metric: '今日吊重', ico: 'crane',
      units: [
        { name: '1#塔机', on: true, rows: [['今日吊次', '10次'], ['今日吊重', '10.00t']] },
        { name: '2#塔机', on: true, rows: [['今日吊次', '9次'], ['今日吊重', '5.05t']] },
        { name: '3#塔机', on: true, rows: [['今日吊次', '7次'], ['今日吊重', '3.53t']] },
      ] },
    { id: 'lift', name: '智能电梯', value: '137次', metric: '今日循环次数', ico: 'lift',
      units: [
        { name: '智能电梯1-1', on: true, rows: [['今日循环次数', '86次'], ['今日运行时长', '6.4h']] },
        { name: '智能电梯1-2', on: false, rows: [['今日循环次数', '18次'], ['今日运行时长', '1.6h']] },
        { name: '智能电梯2-1', on: false, rows: [['今日循环次数', '9次'], ['今日运行时长', '0.8h']] },
        { name: '智能电梯2-2', on: true, rows: [['今日循环次数', '24次'], ['今日运行时长', '2.1h']] },
      ] },
    { id: 'drone', name: '无人机', value: '12次', metric: '今日作业次数', ico: 'drone',
      units: [{ name: '无人机', on: true, rows: [['今日作业次数', '12次']] }] },
    { id: 'climb', name: '智能爬架', value: '21m', metric: '爬升高度', ico: 'climb',
      units: [{ name: '智能爬架', on: true, rows: [['爬升高度', '21m']] }] },
    { id: 'grind', name: '地砖研磨机器人', value: '5次', metric: '今日作业次数', ico: 'robot',
      units: [{ name: '地砖研磨机器人', on: true, rows: [['今日作业次数', '5次']] }] },
    { id: 'plaster', name: '抹灰机器人', value: '4次', metric: '今日作业次数', ico: 'robot',
      units: [{ name: '抹灰机器人', on: true, rows: [['今日作业次数', '4次']] }] },
    { id: 'measure', name: '测量机器人', value: '7次', metric: '今日作业次数', ico: 'robot',
      units: [{ name: '测量机器人', on: true, rows: [['今日作业次数', '7次']] }] },
    { id: 'spray', name: '喷涂机器人', value: '9次', metric: '今日作业次数', ico: 'robot',
      units: [{ name: '喷涂机器人', on: true, rows: [['今日作业次数', '9次']] }] },
    { id: 'level', name: '混凝土整平机器人', value: '3次', metric: '今日作业次数', ico: 'robot',
      units: [{ name: '混凝土整平机器人', on: true, rows: [['今日作业次数', '3次']] }] },
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
