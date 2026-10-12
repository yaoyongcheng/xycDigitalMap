import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { airImgs, airPos, airTimes, hazardKindList } from '@/data/config'
import { dayOffsetOf, startOfDay } from '@/utils/date'

/** 无人机巡检照片（由 airShots 派生） */
export interface AirShot {
  time: string
  img: string
  pos: string
}

/**
 * 无人机巡检 + 隐患上报
 *
 * 两者在原版均为单域状态，合并为一个 store 以减少文件数（依据迁移方案）。
 */
export const useAirHazardStore = defineStore('airHazard', () => {
  /** 原 js/app.js:1334 */
  const airDate = ref<Date>(startOfDay(new Date()))

  /** 原 js/app.js:1335 —— 航拍日历当前显示月份 */
  const airCalMonth = ref<Date>(startOfDay(new Date()))

  /** 航拍日历是否展开（原为 #airCal 的 .hide 类） */
  const airCalOpen = ref(false)

  /** 原 js/app.js:1402 —— 隐患类型当前选中 */
  const hazardKind = ref<string>(hazardKindList[0])

  /** 原 js/app.js:1403 —— 已选照片，元素为 URL.createObjectURL 结果 */
  const hazardImgs = ref<string[]>([])

  /** 原 js/app.js:1338-1345 —— 按日期偏移派生照片数（8~10 张） */
  function airShots(day: number): AirShot[] {
    const n = 8 + (Math.abs(day) % 3)
    return airTimes.slice(0, n).map((t, i) => ({
      time: t,
      img: airImgs[(i + Math.abs(day)) % airImgs.length],
      pos: airPos[i % airPos.length],
    }))
  }

  /** 原 js/app.js:1364 —— airList 是派生值，用 computed */
  const airList = computed<AirShot[]>(() => airShots(dayOffsetOf(airDate.value)))

  return {
    airDate,
    airCalMonth,
    airCalOpen,
    hazardKind,
    hazardImgs,
    airList,
    airShots,
  }
})
