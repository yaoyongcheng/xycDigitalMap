import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { ROBOT_CARDS } from '@/utils/deviceLedger'
import type { Equip, HomeMod, PeopleNode } from '@/types'

/**
 * 首页
 *
 * 承载首页模块的数据与下钻状态。
 *
 * 2026-10 版本同步 · 第三批：模块从「安全 / 质量 / 进度 / 设备」收成
 * 「智眸 / 智巡 / 智控」——质量管理与进度管理整块删除，qaCats 随之移除；
 * 智巡的照片数据是常量，放在 data/config.ts 而不进 store。
 *
 * **2026-11 第二轮：智控前四卡改由设备台账接口派生。**（第三轮补入 5 类机器人静态卡）
 * 原先这里写着 4 条设备的字面量（塔机 3 台 / 电梯 4 台 / 无人机 1 架 / 爬架 1 台），
 * 台数与在线态全是设计稿示意值。现在改为 `useDeviceLedgerStore().equip`：
 *   · 前四张卡恒定存在（入口不能消失），台数/在线数来自 `:8084` 台账；
 *     后五张是机器人静态卡（无数据源，见 utils/deviceLedger.ts: ROBOT_CARDS）；
 *   · 未登录、加载中、失败都只是「units 为空」，由面板给对应的空态，
 *     不再往卡片里塞假数字；
 *   · 数值位只放台账里真有的字段（高度），没有就不渲染 —— 见 utils/deviceLedger.ts。
 *
 * `siteBuildings`（6 栋楼的进度）一并删除：设计稿在 2026-10 改版后已无任何
 * 消费点，留着只是又一份没有出口的假数据。楼栋接口 `fetchBuildings()`
 * 已备在 api/data.ts，将来加回进度页时直接接。
 */
export const useHomeStore = defineStore('home', () => {
  const ledger = useDeviceLedgerStore()

  /** 原 js/app.js:60 —— 当前面板。被 switchTab(L70) 读取以决定是否启预警轮播 */
  const homeMod = ref<HomeMod>('safety')

  /** 原 js/app.js:334 —— 人员分布下钻到的节点，null 表示区域列表 */
  const peopleNode = ref<PeopleNode | null>(null)

  /**
   * 人员分布（2026-11 阶段 5：改真实区域台账）。
   *
   * 原先是 5 个手写区域 + 三栋楼各 5 层人数（`b*Occupied` 稀疏表），全是
   * 设计稿示意值。现在只列 `:8084 /api/data/areas` 返回的真实区域（现场 9 条）。
   *
   * **人数没有数据源**：大屏 open 的 `location/*` 返回 57007 无权限，
   * `:8084` 的 Swagger 里 20 个路由全是区域/楼栋/设备/房间的 CRUD，
   * 没有任何人员定位或人数接口。所以 `count` 一律 `null`，页面渲「—」
   * 并说明原因 —— 0 是个结论，此刻没资格下。
   */
  const peopleTree = computed<PeopleNode[]>(() =>
    ledger.areas.map((a) => ({ id: `area-${a.id}`, name: a.area_name, count: null })),
  )

  /**
   * 智控九卡（原 js/app.js:851-909）。
   *
   * 结构与设计稿 gx2 一致：塔机 / 电梯 / 无人机 / 爬架 + 5 类机器人。
   * 前四类能下钻到详情页、台数来自台账；后五类**没有任何数据源**，
   * 是静态入口卡（见 utils/deviceLedger.ts: ROBOT_CARDS）——
   * 卡片在、但不能点、数值位只放「—」。
   *
   * 台数不写死 —— `card.units` 就是台账里的真实设备，`equipCount()` 据此
   * 算在线 x/y 与状态色；某一类 0 台时卡片仍在（入口），显示 0/0。
   */
  const siteEquip = computed<Equip[]>(() => [...ledger.equip, ...ROBOT_CARDS])

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
    peopleChildren,
    equipCount,
  }
})
