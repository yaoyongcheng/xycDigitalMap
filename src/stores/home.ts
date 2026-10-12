import { ref } from 'vue'
import { defineStore } from 'pinia'

import { b2FloorCount, b2Occupied } from '@/data/config'
import type { Building, Equip, HomeMod, PeopleNode, QaCat } from '@/types'

/**
 * 首页
 *
 * 承载四大面板（安全 / 质量 / 进度 / 设备）的数据与下钻状态。
 * 其中 siteEquip / siteBuildings / qaCats 在原版有第二消费点，但均位于
 * 横屏地图的死代码链上（landDevices / landBuildings / renderLandQa），
 * 跳过死代码后它们实际是单域数据，归到此处。
 */
export const useHomeStore = defineStore('home', () => {
  /** 原 js/app.js:60 —— 当前面板。被 switchTab(L70) 读取以决定是否启预警轮播 */
  const homeMod = ref<HomeMod>('safety')

  /** 原 js/app.js:334 —— 人员分布下钻到的节点，null 表示区域列表 */
  const peopleNode = ref<PeopleNode | null>(null)

  /** 原 js/app.js:560 —— 设备面板下钻到的设备，null 表示列表 */
  const eqNode = ref<Equip | null>(null)

  /** 原 js/app.js:261 —— 预警轮播当前位置 */
  const alarmFeedIdx = ref(0)

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
    { id: 'crane', name: '5G塔机', value: '15.69t', metric: '今日吊重', ico: 'crane',
      units: [{ name: '5G塔机', on: true, rows: [['今日吊重', '15.69t']] }] },
    { id: 'lift', name: '智能电梯', value: '122次', metric: '今日升降次数', ico: 'lift',
      units: [
        { name: '智能电梯1-1', on: true, rows: [['今日循环次数', '122次'], ['今日运行时长', '10.2h']] },
        { name: '智能电梯1-2', on: false, rows: [['今日循环次数', '0次'], ['今日运行时长', '0.0h']] },
        { name: '智能电梯2-1', on: false, rows: [['今日循环次数', '0次'], ['今日运行时长', '0.0h']] },
        { name: '智能电梯2-2', on: true, rows: [['今日循环次数', '0次'], ['今日运行时长', '0.0h']] },
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

  /** 原 js/app.js:422-428 */
  const qaCats = ref<QaCat[]>([
    { name: '土建主体', last: 93, now: 93 },
    { name: '二次结构', last: 89, now: 89 },
    { name: '门窗栏杆', last: 91, now: 91 },
    { name: '机电', last: 89, now: 89 },
    { name: '外立面', last: 89, now: 89 },
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
    eqNode,
    alarmFeedIdx,
    peopleTree,
    siteEquip,
    siteBuildings,
    qaCats,
    peopleChildren,
    equipCount,
  }
})
