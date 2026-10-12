import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { airImgs, airPos, airTimes, hazardKindList } from '@/data/config'
import { dayOffsetOf, startOfDay } from '@/utils/date'
// 与 cam 互相调用 closeXxx（原版 openAir 关 cam，openCam 关 air）。
// 循环 import 安全：两端都只在函数体内惰性调用 useXxxStore()。
import { useCamStore } from './cam'

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

  /** 原为 #airCal 的 .hide 类 */
  const airCalOpen = ref(false)

  /** 原为 #airPlayer 的 .open / hidden */
  const isOpen = ref(false)

  /** 原为 #airPop 的 .open / hidden */
  const airPopOpen = ref(false)

  /** 原通过 data-air 索引定位当前大图 */
  const airPopIdx = ref(0)

  /** 原 js/app.js:1402 —— 隐患类型当前选中 */
  const hazardKind = ref<string>(hazardKindList[0])

  /** 原 js/app.js:1403 —— 已选照片，元素为 URL.createObjectURL 结果 */
  const hazardImgs = ref<string[]>([])

  /**
   * 原为 #hazardDesc 的 value。
   * 原版存在缺陷：resetHazard() 会清空它（app.js:1429），但提交时
   * 完全不读取，即「描述文本实际不会提交」。1:1 复刻下保留该行为。
   */
  const hazardDesc = ref('')

  /** 原为 #hazardPage 的 .open / hidden */
  const hazardOpen = ref(false)

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

  /** 原 js/app.js:1425-1433 resetHazard() —— 同时释放已创建的 ObjectURL */
  function resetHazard(): void {
    hazardImgs.value.forEach((src) => URL.revokeObjectURL(src))
    hazardImgs.value = []
    hazardKind.value = hazardKindList[0]
    hazardDesc.value = ''
  }

  /** 原 js/app.js:1374-1384 openAir() */
  function openAir(): void {
    const cam = useCamStore()
    cam.closeCam()
    closeHazard()
    airDate.value = startOfDay(new Date())
    airCalOpen.value = false
    airPopOpen.value = false
    isOpen.value = true
  }

  /**
   * 原 js/app.js:1386-1394 closeAir()
   * 原版对 #airPop 的处理与 #camShotPop 不一致（L1557 只 remove("open")
   * 而不设 hidden）。因 CSS 有 `.cam-shot-pop:not(.open){display:none!important}`，
   * 两者视觉结果相同，这里统一由同一个状态驱动，不复制该不一致。
   */
  function closeAir(): void {
    airCalOpen.value = false
    isOpen.value = false
    airPopOpen.value = false
  }

  /** 原 js/app.js:1435-1442 openHazard() */
  function openHazard(): void {
    const cam = useCamStore()
    cam.closeCam()
    closeAir()
    resetHazard()
    hazardOpen.value = true
  }

  /** 原 js/app.js:1444-1450 closeHazard() */
  function closeHazard(): void {
    hazardOpen.value = false
    resetHazard()
  }

  /** 原 js/app.js:1469-1477 —— 文件选择，上限 6 张且仅 image/* */
  function addHazardFiles(files: FileList | File[]): void {
    Array.from(files).forEach((file) => {
      if (hazardImgs.value.length >= 6 || !file.type.startsWith('image/')) return
      hazardImgs.value.push(URL.createObjectURL(file))
    })
  }

  /** 原 js/app.js:1460-1466 —— 删除某张已选照片并释放 ObjectURL */
  function removeHazardImg(i: number): void {
    const src = hazardImgs.value[i]
    if (src) URL.revokeObjectURL(src)
    hazardImgs.value.splice(i, 1)
  }

  /** 原 js/app.js:1486-1493 —— 提交。注意原版不读取 hazardDesc */
  function submitHazard(): { ok: boolean; message: string } {
    if (!hazardImgs.value.length) {
      return { ok: false, message: '请先拍摄或选择现场照片' }
    }
    return { ok: true, message: '隐患已上报，待整改' }
  }

  return {
    airDate,
    airCalMonth,
    airCalOpen,
    isOpen,
    airPopOpen,
    airPopIdx,
    hazardKind,
    hazardImgs,
    hazardDesc,
    hazardOpen,
    airList,
    airShots,
    resetHazard,
    openAir,
    closeAir,
    openHazard,
    closeHazard,
    addHazardFiles,
    removeHazardImg,
    submitHazard,
  }
})
