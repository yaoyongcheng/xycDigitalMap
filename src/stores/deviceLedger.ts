/**
 * 设备台账（数据服务 `:8084`，需 Bearer）
 *
 * 口径与首页其它面板一致：**只展示真实数据，取不到就空态 + 重试**。
 * 上一轮已经没有任何设备侧的演示数字（原先 data/device.ts 里有 3 台塔机 +
 * 4 台电梯的完整假数据），这里补上唯一的真实来源。
 *
 * 三个要点：
 *   ① 台账要靠登录态（`:8084/api/data/*` 无 token 回 401），所以取数入口带
 *      token；登出时必须 `reset()`，否则换账号还能看到上一个人的机组；
 *   ② 拉回来的行同时喂给两个消费方：首页四卡（toEquip）与设备详情/弹层
 *      （toUnit → data/device.ts 的响应式登记表）；
 *   ③ 失败不静默重试到底：60s 冷却，避免每次进首页都打一遍失败请求。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchDeviceInfos, type DeviceInfoRow } from '@/api/data'
import { setLiveUnits } from '@/data/device'
import { categoryOf, toEquip, toUnit, type DeviceCategory } from '@/utils/deviceLedger'
import type { DeviceKind, DeviceUnit, Equip } from '@/types'

/** 失败后的冷却时间（与 overview 一致） */
const RETRY_GAP = 60_000

/** 台账状态：idle 未请求 / loading 请求中 / ok 已取到 / error 失败 */
export type LedgerState = 'idle' | 'loading' | 'ok' | 'error'

export const useDeviceLedgerStore = defineStore('deviceLedger', () => {
  /** 原始台账行（保留服务端字段，页面派生时再映射） */
  const rows = ref<DeviceInfoRow[]>([])

  const state = ref<LedgerState>('idle')
  const error = ref('')
  /** 成功取数的时刻（HH:mm） */
  const updatedAt = ref('')

  let lastFailAt = 0
  let inflight: Promise<void> | null = null

  const equip = computed<Equip[]>(() => toEquip(rows.value))

  const hasData = computed(() => state.value === 'ok' && rows.value.length > 0)

  /** 设备总数与在线数（首页计数卡用；含未归类的设备，按真实台账算） */
  const total = computed(() => rows.value.length)
  const online = computed(() => rows.value.filter((r) => Number(r.online_status) === 1).length)

  /** 某一类的真实机组（塔机 / 电梯 / 爬架 / 无人机），设备页与弹层共用 */
  function categoryUnits(kind: DeviceCategory): DeviceUnit[] {
    return rows.value.filter((r) => categoryOf(r.device_name) === kind).map(toUnit)
  }

  /** 塔机 / 电梯（DeviceKind 交集）—— 与 deviceSet 的登记表同名同源 */
  function unitsOf(kind: DeviceKind): DeviceUnit[] {
    return categoryUnits(kind)
  }

  /** 把真实机组同步给 data/device.ts 的响应式登记表（弹层宿主等同步消费方靠它） */
  function syncLive(): void {
    setLiveUnits('crane', unitsOf('crane'))
    setLiveUnits('lift', unitsOf('lift'))
  }

  /** 测试与「接口优先」的接线点：直接灌入一批行（不走网络） */
  function apply(list: DeviceInfoRow[]): void {
    rows.value = list
    state.value = 'ok'
    error.value = ''
    syncLive()
  }

  function stamp(): string {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /**
   * 取台账。`token` 为空直接返回（未登录由调用方走登录守卫）。
   *
   * 并发调用复用同一个 Promise：首页智控面板与设备页可能同时挂载。
   */
  async function load(token: string, force = false): Promise<void> {
    if (!token) return
    if (inflight) return inflight
    if (!force && state.value === 'ok') return
    if (!force && state.value === 'error' && Date.now() - lastFailAt < RETRY_GAP) return

    state.value = 'loading'
    inflight = (async () => {
      try {
        const list = await fetchDeviceInfos()
        rows.value = list
        state.value = 'ok'
        error.value = ''
        updatedAt.value = stamp()
        syncLive()
      } catch (e) {
        state.value = 'error'
        error.value = e instanceof Error ? e.message : '设备台账加载失败'
        lastFailAt = Date.now()
        // 失败时清空：留着上一次的行会让人以为「这是最新的」
        rows.value = []
        syncLive()
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /** 退出登录 / 换账号时清空 */
  function reset(): void {
    rows.value = []
    state.value = 'idle'
    error.value = ''
    updatedAt.value = ''
    lastFailAt = 0
    syncLive()
  }

  return {
    rows,
    state,
    error,
    updatedAt,
    equip,
    hasData,
    total,
    online,
    categoryUnits,
    unitsOf,
    apply,
    load,
    reset,
  }
})
