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

/** 隐患上报的提交载荷（接口接入后即为 POST body） */
export interface HazardPayload {
  kind: string
  photos: number
  desc: string
  at: string
}

/** 选图结果：用于把「被拒了、拒了几张、为什么」如实告诉用户 */
export interface AddFilesResult {
  added: number
  /** 因不是图片被拒 */
  rejectedType: number
  /** 因超过 6 张上限被拒 */
  rejectedLimit: number
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
   *
   * 原版存在缺陷：resetHazard() 会清空它（app.js:1429），但提交时
   * 完全不读取，即「描述文本实际不会提交」。
   * 2026-10 交互优化已修正：描述随 commitHazard() 进入提交载荷
   * （见 lastSubmit），成功反馈也会回显描述字数 —— 用户填了却毫无
   * 感知属欺骗性交互，不值得为 1:1 保留。
   */
  const hazardDesc = ref('')

  /** 原为 #hazardPage 的 .open / hidden */
  const hazardOpen = ref(false)

  /** 提交中（防连点 + 按钮 loading 文案） */
  const hazardSubmitting = ref(false)

  /**
   * 最近一次成功提交的载荷（2026-10 新增，替代「填了不读」的原版行为）。
   * 目前没有后端，落到这个 ref 上，接入接口后即为 POST 的 body。
   */
  const lastSubmit = ref<HazardPayload | null>(null)

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

  /**
   * 原 js/app.js:1469-1477 —— 文件选择，上限 6 张且仅 image/*
   *
   * 2026-10 交互优化：原来被拒的文件是静默丢弃（forEach 里直接 return），
   * 用户选了 10 张只进来 6 张、或选了个 PDF，界面上完全没有反应。
   * 现在把拒绝数量回给调用方，由页面明确提示。
   */
  function addHazardFiles(files: FileList | File[]): AddFilesResult {
    const r: AddFilesResult = { added: 0, rejectedType: 0, rejectedLimit: 0 }
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) {
        r.rejectedType += 1
        return
      }
      if (hazardImgs.value.length >= 6) {
        r.rejectedLimit += 1
        return
      }
      hazardImgs.value.push(URL.createObjectURL(file))
      r.added += 1
    })
    return r
  }

  /** 原 js/app.js:1460-1466 —— 删除某张已选照片并释放 ObjectURL */
  function removeHazardImg(i: number): void {
    const src = hazardImgs.value[i]
    if (src) URL.revokeObjectURL(src)
    hazardImgs.value.splice(i, 1)
  }

  /**
   * 原 js/app.js:1486-1493 —— 提交校验（纯规则，不含异步）。
   *
   * 只做「能不能提交」的判断并返回文案，不产生副作用，便于单测直接断言；
   * 真正带 loading 的提交走 commitHazard()。
   */
  function submitHazard(): { ok: boolean; message: string } {
    if (!hazardImgs.value.length) {
      return { ok: false, message: '请先拍摄或选择现场照片' }
    }
    return { ok: true, message: '隐患已上报，待整改' }
  }

  /**
   * 带 loading 的提交（2026-10 新增，非原版内容）。
   *
   * 改造前的 onSubmit 是同步的：点一下立即 Toast + 关闭页面，连点会重复触发，
   * 且没有任何「正在提交」的过程反馈。这里：
   *   - 用 hazardSubmitting 挡住重复提交（按钮同时 disabled，双保险）
   *   - 模拟一次网络往返，让按钮真的走完 loading → 成功 的状态机
   *   - 描述文本进入载荷（原版缺陷：填了不读），成功文案回显描述字数
   *
   * 接入真实接口后，把 sleep 换成请求即可，其余状态机不用动。
   */
  async function commitHazard(): Promise<{ ok: boolean; message: string }> {
    if (hazardSubmitting.value) {
      return { ok: false, message: '正在提交，请勿重复点击' }
    }
    const guard = submitHazard()
    if (!guard.ok) return guard

    hazardSubmitting.value = true
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 600))

      const desc = hazardDesc.value.trim()
      lastSubmit.value = {
        kind: hazardKind.value,
        photos: hazardImgs.value.length,
        desc,
        at: new Date().toISOString(),
      }
      return {
        ok: true,
        message: desc
          ? `隐患已上报，待整改（${hazardKind.value} · ${lastSubmit.value.photos}张 · 描述${desc.length}字）`
          : `隐患已上报，待整改（${hazardKind.value} · ${lastSubmit.value.photos}张）`,
      }
    } finally {
      hazardSubmitting.value = false
    }
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
    hazardSubmitting,
    lastSubmit,
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
    commitHazard,
  }
})
