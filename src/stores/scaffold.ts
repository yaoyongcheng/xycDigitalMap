import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchScaffold } from '@/api/scaffold'
import { summarize } from '@/utils/scaffold'
import type { ScaffoldSensor } from '@/types'

/**
 * 智能爬架传感器（CDN 静态 JSON）
 *
 * ## 为什么单独一个 store 而不是塞进 deviceLedger
 *
 * 两者是**两套完全不同的后端**：台账走 `:8084`（要 Bearer、登录后才可用），
 * 传感器走公网 CDN（免登录、谁都能读）。塞在一起会让「登出」和「CDN 挂了」
 * 互相牵连 —— 退出登录不该把传感器读数一起清掉。
 *
 * ## 不轮询
 *
 * 现场 `updateTime` 的实测跨度只有几分钟（13:58:53 → 14:02:49），这份数据
 * 本身就不是秒级实时的。一次会话拉一次 + 60s 失败冷却就够了，定时器只会
 * 白白打公网。
 */

const RETRY_GAP = 60_000

export type ScaffoldState = 'idle' | 'loading' | 'ok' | 'error'

export const useScaffoldStore = defineStore('scaffold', () => {
  const sensors = ref<ScaffoldSensor[]>([])
  const state = ref<ScaffoldState>('idle')
  const error = ref('')
  /**
   * 数据来源：CDN 实时 还是 项目内置快照。
   *
   * 仅供内部诊断（排查「线上为什么是旧数」时能一眼分出是 CDN 挂了还是被
   * mixed content 拦了），**不呈现给用户** —— 页面只报读数时间戳，
   * 让用户自己判断这几个数有多旧。
   */
  const source = ref<'live' | 'snapshot' | 'none'>('none')

  /** 三格（最不利机位）+ 机位数 + 最新更新时间 */
  const summary = computed(() => summarize(sensors.value))

  const hasData = computed(() => state.value === 'ok' && sensors.value.length > 0)

  let lastFailAt = 0
  let inflight: Promise<void> | null = null

  /** 测试接线点：直接灌数据（不走网络） */
  function apply(list: ScaffoldSensor[], from: 'live' | 'snapshot' = 'live'): void {
    sensors.value = list
    state.value = list.length ? 'ok' : 'error'
    error.value = list.length ? '' : '爬架传感器数据未取到'
    source.value = list.length ? from : 'none'
  }

  /**
   * 取一次传感器数据。
   *
   * CDN 免登录，所以**不需要 token**；失败 60s 内不重复打。
   */
  async function load(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && state.value === 'ok') return
    if (!force && state.value === 'error' && Date.now() - lastFailAt < RETRY_GAP) return

    state.value = 'loading'
    inflight = (async () => {
      try {
        const hit = await fetchScaffold()
        if (hit) {
          sensors.value = hit.sensors
          source.value = hit.source
          state.value = 'ok'
          error.value = ''
        } else {
          // 不清空 sensors：调用方可能在 force 重试，旧读数仍比空态有用？
          // 不 —— 旧读数会让人以为「这是最新的」。宁可空态。
          sensors.value = []
          source.value = 'none'
          state.value = 'error'
          error.value = '爬架传感器数据未取到'
          lastFailAt = Date.now()
        }
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /** 清空（页面卸载 / 强制重取时用；传感器不随登出清，见文件头） */
  function reset(): void {
    sensors.value = []
    source.value = 'none'
    state.value = 'idle'
    error.value = ''
    lastFailAt = 0
  }

  return { sensors, state, error, source, summary, hasData, apply, load, reset }
})
