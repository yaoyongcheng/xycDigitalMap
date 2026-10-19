import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { addDays, dateKey, formatMD, monthStart, protoToday } from '@/utils/date'
import type { Alarm } from '@/types'

/**
 * 相对锚点生成绝对时间 'YYYY-MM-DD HH:mm:ss'。
 *
 * 原版把历史记录的日期硬编码成 2026-09-30 / 10-05~10-07（app.js:246-255），
 * 锚点却是固定的 protoToday()=2026-10-08，于是：
 *   - 真实日期一走远，日历可选上界（10-07）和数据就整体脱节；
 *   - h-net 的 at=2026-09-30 与 rel=「昨天 09:30」自相矛盾。
 * 这里改为「天偏移 + 时刻」派生，at 与 rel 同源，永远对得上。
 */
function atOf(dayOffset: number, hm: string): string {
  return `${dateKey(addDays(protoToday(), dayOffset))} ${hm}:00`
}

/** 相对时间文案：昨天显示「昨天 HH:mm」，更早显示「MM/DD HH:mm」 */
function relOf(dayOffset: number, hm: string): string {
  if (dayOffset === 0) return `今天 ${hm}`
  if (dayOffset === -1) return `昨天 ${hm}`
  return `${formatMD(addDays(protoToday(), dayOffset))} ${hm}`
}

/**
 * 巡检预警
 *
 * inspectAlarms 是全项目唯一被 4 个功能域消费的数据源：
 *   首页-安全面板趋势图 / 巡检列表 / 预警详情 / 预警轮播
 * 接入接口后，一次数据返回要触发这四处同步 —— 这正是本次迁移的核心动机。
 */
export const useAlarmStore = defineStore('alarm', () => {
  /**
   * 原 js/app.js:246-255
   * 8 条记录：4 条 today + 4 条 hist。
   * day / at / rel 三个字段共同决定列表分组与日历筛选。
   *
   * 日期一律由「距今天多少天」派生（见 atOf / relOf），不再写死年月日。
   * 只在 store 创建时求值一次 —— 跨天常驻不刷新属原型可接受范围，
   * 真接入接口后数据由服务端下发，无需此处处理。
   */
  const alarms = ref<Alarm[]>([
    { id: 'trash', day: 'today', type: '道路垃圾', title: '环境报警', desc: '场区道路发现垃圾堆放未清理！', img: 'img/alarm-trash.webp', rel: '1分钟前', at: atOf(0, '15:21'), geo: '114.24751233100210,30.53310211883421' },
    { id: 'cable', day: 'today', type: '电缆拖地', title: '用电报警', desc: '作业面电缆拖地未架空，存在触电隐患！', img: 'img/alarm-cable.webp', rel: '3分钟前', at: atOf(0, '15:19'), geo: '114.24738810244102,30.53290155210933' },
    { id: 'net', day: 'today', type: '安全网缺失', title: '防护报警', desc: '楼层临边安全网缺失，请立即整改！', img: 'img/alarm-net.webp', rel: '12分钟前', at: atOf(0, '15:10'), geo: '114.24742027911455,30.53296304904549' },
    { id: 'soil', day: 'today', type: '裸土未覆盖', title: '扬尘报警', desc: '场区裸土未覆盖，扬尘风险较高！', img: 'img/alarm-soil.webp', rel: '1小时前', at: atOf(0, '14:22'), geo: '114.24760188412003,30.53322190771208' },
    { id: 'h-net', day: 'hist', type: '安全网缺失', title: '防护报警', desc: '3#楼作业面临边安全网破损缺失。', img: 'img/alarm-net.webp', rel: relOf(-1, '09:30'), at: atOf(-1, '09:30'), geo: '114.24742027911455,30.53296304904549' },
    { id: 'h-trash', day: 'hist', type: '道路垃圾', title: '环境报警', desc: '场区北侧道路垃圾堆放未及时清运。', img: 'img/alarm-trash.webp', rel: relOf(-2, '16:20'), at: atOf(-2, '16:20'), geo: '114.24749822001145,30.53308044122890' },
    { id: 'h-cable', day: 'hist', type: '电缆拖地', title: '用电报警', desc: '钢筋加工区电缆拖地，存在漏电风险。', img: 'img/alarm-cable.webp', rel: relOf(-3, '11:08'), at: atOf(-3, '11:08'), geo: '114.24735501988210,30.53284411902341' },
    { id: 'h-soil', day: 'hist', type: '裸土未覆盖', title: '扬尘报警', desc: '基坑周边裸土未覆盖，扬尘超标。', img: 'img/alarm-soil.webp', rel: relOf(-4, '08:46'), at: atOf(-4, '08:46'), geo: '114.24757700124480,30.53319822009112' },
  ])

  /** 原 js/app.js:257 —— 首页安全面板与轮播只看当日 */
  const latest = computed(() => alarms.value.filter((a) => a.day === 'today'))

  /** 原 js/app.js:677 —— 巡检列表当前页签 */
  const inspTab = ref<'today' | 'hist'>('today')

  /** 原 js/app.js:681 —— 历史页当前选中日，锚点为 protoToday() */
  const inspHistDate = ref<Date>(addDays(protoToday(), -1))

  /** 原 js/app.js:682 —— 日历当前显示月份 */
  const inspCalMonth = ref<Date>(monthStart(inspHistDate.value))

  /** 巡检日历是否展开（原为 #inspCal 的 .hide 类，closeSub 需读取，故提到 store） */
  const inspCalOpen = ref(false)

  /** 原 js/app.js:684-696 的 alarmsOnDate(d) —— 历史页按日筛选 */
  function alarmsOnDate(d: Date): Alarm[] {
    const key = dateKey(d)
    return alarms.value.filter((a) => a.day === 'hist' && a.at.slice(0, 10) === key)
  }

  /** 原多处以 inspectAlarms.find(...) 内联实现 */
  function byId(id: string): Alarm | undefined {
    return alarms.value.find((a) => a.id === id)
  }

  return {
    alarms,
    latest,
    inspTab,
    inspHistDate,
    inspCalMonth,
    inspCalOpen,
    alarmsOnDate,
    byId,
  }
})
