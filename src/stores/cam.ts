import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { camShotPool, camShotTimes } from '@/data/config'
import { dayOffsetOf, startOfDay } from '@/utils/date'
import type { Camera } from '@/types'

/** 抓拍项（由 shotsFor 派生） */
export interface CamShot {
  time: string
  img: string
  pos: string
}

/**
 * 监控
 *
 * cameras 被 cam 全域与「工作台」快捷入口共用（app.js:1001），故进 store。
 */
export const useCamStore = defineStore('cam', () => {
  /**
   * 原 js/app.js:30-49
   * 注意尾部 .map((c) => Object.assign(c, { img: 'img/cam-crane2.jpg', pos: '' }))
   * 会把 18 个点位的 img 统一成同一张图、pos 统一置空 —— 这是原版现状，
   * 1:1 复刻下如实保留（接口接入后此处应改为真实点位图与裁切位置）。
   */
  const cameras = ref<Camera[]>(
    [
      { id: 'g1', name: '1#门监控', group: '出入口' },
      { id: 'g1a', name: '1#门安全通道门禁监控', group: '出入口' },
      { id: 'g2a', name: '2#门监控1', group: '出入口' },
      { id: 'g2b', name: '2#门监控2', group: '出入口' },
      { id: 'g3out', name: '3#门外监控', group: '出入口' },
      { id: 'g4', name: '4#门监控', group: '出入口' },
      { id: 'g4a', name: '4#门安全通道门禁监控', group: '出入口' },
      { id: 'g5', name: '5#门监控', group: '出入口' },
      { id: 'g5out', name: '5#门外监控', group: '出入口' },
      { id: 'cama', name: '监控A', group: '场内' },
      { id: 'camb', name: '监控B', group: '场内' },
      { id: 'weigh', name: '地磅全景', group: '场内' },
      { id: 'rebar', name: '钢筋加工棚', group: '场内' },
      { id: 'yard1', name: '场内1', group: '场内' },
      { id: 'yard2', name: '场内2', group: '场内' },
      { id: 'talk', name: '安全讲台', group: '场内' },
      { id: 'crane2', name: '2#塔吊', group: '塔吊' },
      { id: 'crane4', name: '4#塔吊', group: '塔吊' },
    ].map((c) => Object.assign(c, { img: 'img/cam-crane2.jpg', pos: '' }) as Camera),
  )

  /** 原 js/app.js:1026 —— 当前点位，初值为首个 */
  const camId = ref<string>(cameras.value[0].id)

  /** 原 js/app.js:1027 —— 'live' | 'shots' */
  const camMode = ref<'live' | 'shots'>('live')

  /** 原 js/app.js:1028 —— 抓拍视图选中日期 */
  const camShotDate = ref<Date>(startOfDay(new Date()))

  /** 原 js/app.js:1029 —— 抓拍日历当前显示月份 */
  const camCalMonth = ref<Date>(startOfDay(new Date()))

  /** 抓拍日历是否展开（原为 #camCal 的 .hide 类） */
  const camCalOpen = ref(false)

  /** 当前点位对象 */
  const currentCam = computed(() => cameras.value.find((c) => c.id === camId.value) ?? cameras.value[0])

  /** 原 js/app.js:1068-1075 —— 按点位与日期偏移派生 3 张抓拍图 */
  function shotsFor(id: string, day: number): CamShot[] {
    const i = cameras.value.findIndex((c) => c.id === id)
    return camShotTimes.map((t, n) => ({
      time: t,
      img: camShotPool[(i + Math.abs(day) + n) % camShotPool.length],
      pos: ['pos-left', 'pos-right', 'pos-bottom'][n],
    }))
  }

  /** 原 js/app.js:1173 —— camShots 是派生值（由 camId + camShotDate 唯一决定），故用 computed */
  const camShots = computed<CamShot[]>(() => shotsFor(camId.value, dayOffsetOf(camShotDate.value)))

  /** 原 js/app.js:1182 applyCam(id, keepLive) 的状态部分 */
  function applyCam(id: string): void {
    const cam = cameras.value.find((c) => c.id === id) ?? cameras.value[0]
    camId.value = cam.id
    camShotDate.value = startOfDay(new Date())
    camCalOpen.value = false
  }

  /** 原按 group 字段分组（renderCamChips 内联实现，app.js:1150-1158） */
  const grouped = computed(() => {
    const groups: { name: string; items: Camera[] }[] = []
    for (const c of cameras.value) {
      let g = groups.find((x) => x.name === c.group)
      if (!g) {
        g = { name: c.group, items: [] }
        groups.push(g)
      }
      g.items.push(c)
    }
    return groups
  })

  return {
    cameras,
    camId,
    camMode,
    camShotDate,
    camCalMonth,
    camCalOpen,
    currentCam,
    camShots,
    grouped,
    shotsFor,
    applyCam,
  }
})
