import { computed } from 'vue'
import { defineStore } from 'pinia'

import { useAlarmStore } from './alarm'
import { useDroneAlarmStore } from './droneAlarm'

/**
 * 消息（两类预警汇总）
 *
 * 消息页不分「一条一条消息」，而是两块分类：
 *   · 监控预警 —— `:8085` 视频报警；
 *   · 无人机预警 —— keehang 审核中心的 AI 工单（= V2 大屏「工单列表」），
 *     见 `stores/droneAlarm.ts`。
 *
 * ## 状态：只读（2026-11-24 三轮口径）
 *
 * 移动端**不提供任何状态变更操作**，两边的状态都照服务端原样展示：
 *
 *   · 监控预警：`handleStatus`（0 待处理 / 1 已完成），列表徽标与详情「处理状态」
 *     都读它，缺省按待处理；
 *   · 无人机预警：`auditStatusType`（`UNAUDITED` 待处理 / `AUDITED` 已完成），
 *     同样只读。
 *
 * 早先的「一键已读」（顶栏按钮 + 批量 PATCH）与「点开即已读」（进详情顺手
 * 置 1）**已全部下线**：状态由审核 / 处置流程在服务端推进，本机只看不改。
 * 因此 `stores/alarm.ts` 里那套「本地乐观置读 + 屏障」也随之删除。
 *
 * ## 今日待处理
 *
 * 两个列表页各显示一份「今日待处理」，底栏角标是两份之和
 * （{@link monitorPending} + {@link dronePending} = {@link pendingTotal}）。
 * 「待处理」是事实状态，不会因为「看过」而减少 —— 点进列表能处理，处理完
 * 由服务端把状态改成已完成，下次刷新数字跟着降。
 *
 * 只算今日：历史预警是回看，不计入待办。
 */

/** 一类预警在消息页上的汇总 */
export interface MsgCategory {
  id: 'monitor' | 'drone'
  title: string
  desc: string
  /** 相对时间（「1分钟前」）；没有数据时是空串 */
  time: string
  /** 数字的含义：两处统一「今日待处理」，避免一个读成未读、一个读成总数 */
  hint: string
  /** 右侧数字：今日待处理条数；0 表示不显示 */
  count: number
  /** 已知条数（未登录或还没加载时为 false，卡片写「—」而不是 0） */
  known: boolean
}

export const useMsgStore = defineStore('msg', () => {
  const alarm = useAlarmStore()
  const drone = useDroneAlarmStore()

  /**
   * 监控预警「今日待处理」。
   *
   * 判据与服务端一致：`handleStatus === 1` 才算已完成，其余（0 / 缺省）都算待处理。
   * 取 `alarm.latest`（今日）而不是全部已加载报警 —— 历史不参与待办统计。
   */
  const monitorPending = computed(
    () => alarm.latest.filter((a) => a.handleStatus !== 1).length,
  )

  /** 无人机预警「今日待处理」：今日 + `UNAUDITED`（首屏扫描的今日前缀，精确值） */
  const dronePending = computed(() => drone.todayPending)

  /**
   * 底栏消息角标 = 两类今日待处理之和（2026-11-24 现场口径）。
   *
   * 无人机没扫描完时 `todayPending` 是 0，角标先只显示监控那一份，扫完再补上 ——
   * 不做「未知就不显示」的处理：监控那份是已知的，没理由一起藏起来。
   */
  const pendingTotal = computed(() => monitorPending.value + dronePending.value)

  /**
   * 监控预警的最新一条：优先今日，今日没有才退到已加载里最新的一条。
   *
   * 退到历史那条时时间会写成「昨天 21:41」，卡片上不会误读成今天 ——
   * 而空着更糟：一条报警都看不到时会以为这模块没数据。
   */
  const monitorLatest = computed(() => alarm.latest[0] ?? alarm.liveAlarms[0])

  /** 两类预警的汇总卡片（顺序固定：监控在前、无人机在后） */
  const categories = computed<MsgCategory[]>(() => {
    const latest = monitorLatest.value
    const top = drone.latest
    return [
      {
        id: 'monitor',
        title: '监控预警',
        desc: '视频监控 AI 智能识别风险',
        time: latest?.rel ?? '',
        hint: '今日待处理',
        count: monitorPending.value,
        // 首屏同步完成 / 失败都算「已知」：失败时列表页会写清楚原因
        known: alarm.hasLive || alarm.liveState === 'ok' || alarm.liveState === 'error',
      },
      {
        id: 'drone',
        title: '无人机预警',
        desc: '无人机巡检 AI 智能识别风险',
        time: top ? drone.relOf(top) : '',
        // 与监控用同一个标签、同一种红色徽标：两边都报「今日还有几条待处理」，
        // 口径不一致会让人以为一个在说未读、一个在说总数
        hint: '今日待处理',
        count: dronePending.value,
        known: drone.todayKnown,
      },
    ]
  })

  /** 是否一条预警都没有（两类都空）—— 消息页据此给空态 */
  const isEmpty = computed(
    () =>
      !alarm.liveAlarms.length &&
      !drone.items.length &&
      alarm.liveState !== 'loading' &&
      drone.state !== 'loading',
  )

  return {
    categories,
    isEmpty,
    monitorPending,
    dronePending,
    pendingTotal,
    monitorLatest,
  }
})
