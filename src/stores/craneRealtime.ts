import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { subscribeCraneRealtime } from '@/api/craneRealtime'
import type { CraneRealtime } from '@/api/craneRealtime'
import type { MqttState } from '@/api/mqttWs'

/**
 * 塔机实时工况（一份 store，多个视图共用）
 *
 * ## 生命周期
 *
 * 用**引用计数**：谁要看谁 `open()`，离开 `close()`。弹层关闭后 0 引用即断开，
 * 不常驻连接（现场是手机流量，一条常连的 WebSocket 没必要开着）。
 *
 * ## 新鲜度
 *
 * 报文里的 `monitorDateTime` 是设备/平台时钟，和手机可能差几分钟，
 * 所以「多久没更新」用**本地收到时刻**算，不用报文时间。
 * 超过 `OFFLINE_MS`（25s，与 V2 `CraneRealtimeRequester.offlineTimeout` 一致）
 * 就当作没有数据 —— 页面显示「—」，而不是一直挂着最后一帧假装还在动。
 *
 * 时间推进靠 `tick` 定时器驱动（有引用时每 2s 一次），而不是在 computed 里读
 * `Date.now()` —— 后者不会触发重渲染，界面会停在旧值上。
 */

/** 多久收不到推送就认为离线（毫秒）；V2 的预制体里是 offlineTimeout = 25s */
const OFFLINE_MS = 25_000

/** 界面状态：idle 未连 / connecting 连接中 / live 有数据在推 / down 连不上 */
export type CraneRealtimeStatus = 'idle' | 'connecting' | 'live' | 'down'

/** 一帧 + 本地收到时刻 + 是否在动作 */
interface Entry {
  frame: CraneRealtime
  receivedAt: number
  /**
   * 与上一帧比是否有位移 —— V2 `CraneModel.UpdateState` 用的是
   * `|Δangle| > 0.1 || |Δrange| > 0.1 || |Δheight| > 0.1`（首帧按 0 比），
   * 这里照抄，供「工作中 / 待机」判断。
   */
  moving: boolean
}

/** 塔机「当前状态」四态，文案与 V2 `CraneModel.GetTowerState` 完全一致 */
export type CraneRunState = '离线' | '正在吊装' | '工作中' | '待机'

/** V2 判断「动了」的阈值（float 0.1） */
const MOVE_EPS = 0.1

export const useCraneRealtimeStore = defineStore('craneRealtime', () => {
  const entries = ref<Record<string, Entry>>({})
  const status = ref<CraneRealtimeStatus>('idle')

  /** 只是一个「让界面重算新鲜度」的节拍器 */
  const tick = ref(Date.now())

  let refs = 0
  let stop: (() => void) | null = null
  let ticker: ReturnType<typeof setInterval> | null = null

  function stopTicker(): void {
    if (ticker) {
      clearInterval(ticker)
      ticker = null
    }
  }

  function start(): void {
    if (stop) return
    status.value = 'connecting'
    stop = subscribeCraneRealtime({
      onData: (frame) => {
        const prev = entries.value[frame.sn]?.frame
        const moving =
          Math.abs(frame.angle - (prev?.angle ?? 0)) > MOVE_EPS ||
          Math.abs(frame.range - (prev?.range ?? 0)) > MOVE_EPS ||
          Math.abs(frame.height - (prev?.height ?? 0)) > MOVE_EPS
        entries.value = {
          ...entries.value,
          [frame.sn]: { frame, receivedAt: Date.now(), moving },
        }
        status.value = 'live'
        tick.value = Date.now()
      },
      onState: (s: MqttState) => {
        if (s === 'open') {
          // 已连上但还没收到帧 —— 不马上翻成 live，等第一帧
          if (status.value !== 'live') status.value = 'connecting'
          return
        }
        if (s === 'closed') {
          // 有引用还在等重连；把状态压回 connecting（不是 down，down 留给「一直没有帧」）
          if (refs > 0 && status.value !== 'live') status.value = 'connecting'
        }
      },
    })
    stopTicker()
    ticker = setInterval(() => {
      tick.value = Date.now()
    }, 2000)
  }

  function halt(): void {
    stopTicker()
    stop?.()
    stop = null
    status.value = 'idle'
  }

  /** 有视图需要实时数据时调用（幂等，靠计数） */
  function open(): void {
    refs += 1
    if (refs === 1) start()
  }

  /** 视图离开时调用；归零才真正断开 */
  function close(): void {
    refs = Math.max(0, refs - 1)
    if (refs === 0) halt()
  }

  /** 当前是否「有在推」（任意一台） */
  const isLive = computed(() => status.value === 'live' && refs > 0)

  /**
   * 取某台塔机的最新一帧；没有 / 过期返回 null。
   *
   * `tick` 在这里被读一次，让它成为依赖：定时器推进时这个 computed 会重算，
   * 过期帧会自己变成 null。
   */
  function of(sn: string | null | undefined): CraneRealtime | null {
    if (!sn) return null
    const e = entries.value[sn]
    if (!e) return null
    void tick.value
    return Date.now() - e.receivedAt > OFFLINE_MS ? null : e.frame
  }

  /** 该 sn 是否曾经收到过数据（用于区分「没接入」与「连不上」） */
  function everSeen(sn: string | null | undefined): boolean {
    return !!sn && !!entries.value[sn]
  }

  /**
   * 塔机「当前状态」—— 口径照 V2 `CraneModel.GetTowerState`，**不是台账的 online_status**：
   *
   * ```
   * 有帧 && hasLoad && weight > 0 → 正在吊装
   * 有帧 && 与上一帧比动了         → 工作中
   * 有帧 && 没动                   → 待机
   * 没帧（含 25s 过期）            → 离线
   * ```
   *
   * 没有 sn 的塔机（传统塔机5）直接「离线」—— 它不在平台的推送列表里，
   * V2 的弹层对这台车显示的也正是「离线」。
   *
   * 返回 `null` 表示**判断不了**：整条通道还没通（页面在 HTTPS 且没有 WS 反代时），
   * 这时由调用方回落到台账的状态，免得把「我们看不到」写成「设备离线」。
   */
  function stateOf(sn: string | null | undefined): CraneRunState | null {
    if (!sn) return '离线'
    const frame = of(sn)
    if (frame) {
      if (frame.hasLoad && frame.weight > 0) return '正在吊装'
      return entries.value[sn]?.moving ? '工作中' : '待机'
    }
    // 曾经收过但这会儿过期了 → 确实掉了
    if (entries.value[sn]) return '离线'
    // 通道在通、只是没有这台 → 平台没在推它
    return status.value === 'live' ? '离线' : null
  }

  return { status, isLive, of, everSeen, stateOf, open, close, OFFLINE_MS }
})
