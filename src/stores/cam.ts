import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { fetchAlarmPicture } from '@/api/video'
import { addDays, dateKey, dayOffsetOf, startOfDay } from '@/utils/date'
import { remoteIdOf } from '@/utils/videoAlarm'
import { useAirHazardStore } from './airHazard'
import { useAlarmStore } from './alarm'
import { useAuthStore } from './auth'
import { useShellStore } from './shell'
import { useSubpageStore } from './subpage'
import type { Alarm, Camera } from '@/types'

/**
 * 监控（2026-11 阶段 5：点位与抓拍改真实数据）
 *
 * 原版是 18 个写死的点位名，`.map()` 把 img 统一刷成同一张
 * `cam-crane2.webp`，再按「点位序号 + 日期偏移」轮转出每天 3 张假抓拍 ——
 * 切点位画面完全不变（原版现状，1:1 复刻时保留）。现在改为：
 *
 *   · 点位 = `:8085` 真实报警里的 `channelNo` 去重（现场 2/3/4/5/6 五个通道）；
 *   · 抓拍 = 该通道、该日期的真实报警，时间取 `captureTime`；
 *   · 图片 = `/api/video/alarms/{id}/picture` 的真实 base64，按需加载 + 缓存；
 *   · 没有实时流接口（萤石云未接），所以直播位显示「最近一次报警抓拍」，
 *     并在无图/未登录时给明确占位，不再挂一张示意图假装是直播。
 *
 * 点位分组、日历、转场、横屏等交互状态保持原样，避免改动牵连全站。
 */

export interface CamShot {
  /** 抓拍时刻 HH:mm:ss（来自 captureTime） */
  time: string
  /** 已加载的抓拍图 dataURL；未加载为空串（SmartImg 会显示占位） */
  img: string
  pos: string
  /** 本地 Alarm.id，点开消息/详情用 */
  alarmId: string
  /** 服务端 Id，截图接口用 */
  remoteId: string
}

/** 没有任何真实点位时的兜底，保证 `currentCam.name` 之类取值不会炸 */
const EMPTY_CAM: Camera = {
  id: '',
  name: '暂无监控点位',
  group: '视频监控',
  img: '',
  pos: '',
}

/** 一次最多预取几张抓拍（每张约 1MB，手机流量下不能放开拉） */
const PREFETCH_N = 6

/** 通道号（点位的 id 形如 ch-3） */
function channelOf(id: string): number {
  const m = /^ch-(\d+)$/.exec(id)
  return m ? Number(m[1]) : 0
}

export const useCamStore = defineStore('cam', () => {
  const shell = useShellStore()
  const alarm = useAlarmStore()
  const auth = useAuthStore()

  /** 真实报警按通道聚合（只保留服务端标了通道号的） */
  const channelCounts = computed(() => {
    const m = new Map<number, number>()
    for (const a of alarm.liveAlarms) {
      if (!a.channelNo || a.channelNo <= 0) continue
      m.set(a.channelNo, (m.get(a.channelNo) ?? 0) + 1)
    }
    return m
  })

  /** 每个通道最近一条报警（直播位封面 + 预取入口） */
  const latestByChannel = computed(() => {
    const m = new Map<number, Alarm>()
    for (const a of alarm.liveAlarms) {
      if (!a.channelNo || a.channelNo <= 0) continue
      if (!m.has(a.channelNo)) m.set(a.channelNo, a)
    }
    return m
  })

  /** 抓拍图缓存：remoteId → dataURL。登出时清空 */
  const pictures = ref<Record<string, string>>({})
  const pending = new Set<string>()

  function imgOf(remoteId: string): string {
    return remoteId ? pictures.value[remoteId] ?? '' : ''
  }

  /**
   * 真实点位。channelNo 是唯一可靠的标识 —— 服务端不下发点位名称，
   * 所以只能叫「N号通道」，不编「1#门监控」这种名字。
   */
  const cameras = computed<Camera[]>(() =>
    [...channelCounts.value.keys()]
      .sort((a, b) => a - b)
      .map((ch) => {
        const latest = latestByChannel.value.get(ch)
        return {
          id: `ch-${ch}`,
          name: `${ch}号通道`,
          group: '视频监控' as const,
          channelNo: ch,
          img: latest ? imgOf(remoteIdOf(latest)) : '',
          pos: '',
        }
      }),
  )

  /** 原 js/app.js:1026 —— 当前点位。没有点位时为空串，不再依赖 cameras[0] */
  const camId = ref<string>('')

  /** 原 js/app.js:1027 —— 'live' | 'shots' */
  const camMode = ref<'live' | 'shots'>('live')

  /** 原 js/app.js:1028 —— 抓拍视图选中日期 */
  const camShotDate = ref<Date>(startOfDay(new Date()))

  /** 原 js/app.js:1029 —— 抓拍日历当前显示月份 */
  const camCalMonth = ref<Date>(startOfDay(new Date()))

  const camCalOpen = ref(false)
  const isOpen = ref(false)
  const isLive = ref(false)
  const shotPopOpen = ref(false)
  const shotPopIdx = ref(0)

  const currentCam = computed<Camera>(
    () => cameras.value.find((c) => c.id === camId.value) ?? cameras.value[0] ?? EMPTY_CAM,
  )

  /** 当前通道最近一条报警（可能是几天前，但确实是这个点位的最后一张真实图） */
  const latestShot = computed(() => {
    const ch = channelOf(currentCam.value.id)
    return ch ? latestByChannel.value.get(ch) : undefined
  })

  /**
   * 原 js/app.js:1068-1075 的 `shotsFor(id, dayOffset)`。
   *
   * 签名保留（dayOffset：今天 0 / 昨天 1），语义换成「按通道 + 真实日期
   * 过滤报警」。没有记录的那天就是空数组，不再轮转假图凑 3 张。
   */
  function shotsFor(id: string, dayOffset: number): CamShot[] {
    const ch = channelOf(id)
    if (!ch) return []
    const key = dateKey(addDays(startOfDay(new Date()), -dayOffset))
    return alarm.liveAlarms
      .filter((a) => a.channelNo === ch && a.at.slice(0, 10) === key)
      .map((a) => {
        const remoteId = remoteIdOf(a)
        return {
          time: a.at.slice(11, 19),
          img: imgOf(remoteId),
          pos: '',
          alarmId: a.id,
          remoteId,
        }
      })
  }

  const camShots = computed<CamShot[]>(() => shotsFor(camId.value, dayOffsetOf(camShotDate.value)))

  /** 原按 group 字段分组 */
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

  /**
   * 按需取真实抓拍图。
   * 失败（含 401、无图）静默留空：SmartImg 会显示占位，不会破图。
   */
  async function ensurePictures(remoteIds: string[]): Promise<void> {
    if (!auth.token) return
    const todo = [...new Set(remoteIds)].filter((id) => id && !pictures.value[id] && !pending.has(id))
    if (!todo.length) return
    for (const id of todo) pending.add(id)
    await Promise.allSettled(
      todo.map(async (id) => {
        try {
          const src = await fetchAlarmPicture(auth.token, id)
          pictures.value = { ...pictures.value, [id]: src }
        } finally {
          pending.delete(id)
        }
      }),
    )
  }

  /** 只在真的要看图时预取：直播位 1 张，抓拍视图额外 6 张 */
  function prefetch(): void {
    const ids: string[] = []
    const latest = latestShot.value
    if (latest) ids.push(remoteIdOf(latest))
    if (camMode.value === 'shots') {
      for (const s of camShots.value.slice(0, PREFETCH_N)) ids.push(s.remoteId)
    }
    void ensurePictures(ids)
  }

  // 首屏 / 登录态后到 / 切点位 / 切日期 / 切视图 都要补一次预取
  watch(
    () => [
      auth.token,
      camId.value,
      camMode.value,
      camShotDate.value.getTime(),
      alarm.liveAlarms.length,
    ],
    () => prefetch(),
    { immediate: true },
  )

  /**
   * 点位是异步到手的，`openCam('')` 可能发生在报警同步完成之前。
   * 那时 `applyCam()` 只能把 camId 设成空串，而 `shotsFor()` 依赖 camId，
   * 不补一次的话抓拍视图会一直空着（直播位靠 computed 兜底反而是好的）。
   */
  watch(
    cameras,
    (list) => {
      if (!list.length) {
        if (camId.value) camId.value = ''
        return
      }
      if (!list.some((c) => c.id === camId.value)) camId.value = list[0].id
    },
    { immediate: true },
  )

  // 会话一失效就把现场照片清掉（不在 auth.clear() 里反向 import cam，
  // 否则 auth ↔ cam 会形成模块循环）
  watch(
    () => auth.token,
    (t) => {
      if (!t) clearPictures()
    },
  )

  /** 登出时连图一起清，避免下一个账号看到上一个人的现场照片 */
  function clearPictures(): void {
    pictures.value = {}
    pending.clear()
    camId.value = ''
    shotPopOpen.value = false
  }

  function setCamLand(on: boolean): void {
    shell.isLandscape = on
    shell.isLand = on
  }

  function applyCam(id: string, keepLive = false): void {
    const cam = cameras.value.find((c) => c.id === id) ?? cameras.value[0] ?? EMPTY_CAM
    camId.value = cam.id
    camShotDate.value = startOfDay(new Date())
    camCalOpen.value = false
    if (!keepLive) isLive.value = false
  }

  function openCam(id: string): void {
    // 支付宝式登录守卫：抓拍接口要 Bearer，未登录别先摆一个空播放器
    if (!auth.isLoggedIn) {
      useSubpageStore().openLogin('登录后可查看现场监控抓拍')
      return
    }
    const air = useAirHazardStore()
    air.closeAir()
    air.closeHazard()
    setCamLand(false)
    isOpen.value = true
    applyCam(id, false)
    camMode.value = 'live'
  }

  function closeCam(): void {
    setCamLand(false)
    isOpen.value = false
    isLive.value = false
    shotPopOpen.value = false
    camCalOpen.value = false
    camMode.value = 'live'
  }

  function showCamMode(mode: 'live' | 'shots'): void {
    camMode.value = mode
  }

  /** 打开大图时补拉那一张（可能不在首屏预取的 6 张里） */
  function openShotPop(i: number): void {
    shotPopIdx.value = i
    shotPopOpen.value = true
    const s = camShots.value[i]
    if (s) void ensurePictures([s.remoteId])
  }

  function closeShotPop(): void {
    shotPopOpen.value = false
  }

  return {
    cameras,
    camId,
    camMode,
    camShotDate,
    camCalMonth,
    camCalOpen,
    isOpen,
    isLive,
    shotPopOpen,
    shotPopIdx,
    currentCam,
    latestShot,
    camShots,
    grouped,
    shotsFor,
    ensurePictures,
    clearPictures,
    setCamLand,
    applyCam,
    openCam,
    closeCam,
    showCamMode,
    openShotPop,
    closeShotPop,
  }
})
