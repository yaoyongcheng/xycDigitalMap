import { computed } from 'vue'
import { defineStore } from 'pinia'

import { setAlarmStatus } from '@/api/video'
import { useAlarmStore } from './alarm'
import { useAuthStore } from './auth'
import { useDroneAlarmStore } from './droneAlarm'

/**
 * 消息（2026-11-20 改为**两类预警**）
 *
 * 消息页不再一条报警一条消息，而是两块分类：
 *   · 监控预警 —— `:8085` 视频报警（原有数据源，一字未改）；
 *   · 无人机预警 —— keehang 审核中心的 AI 工单（= V2 大屏「工单列表」），
 *     见 `stores/droneAlarm.ts`。
 *
 * 点「监控预警」进现有的巡检预警列表（今日 / 历史、分页、日历都在那里），
 * 点「无人机预警」进新的工单列表页。这样消息页只负责「有没有、几条」，
 * 明细仍在各自的列表里，不重复实现两套。
 *
 * ## 已读
 *
 * 监控预警的已读**权威来源仍是服务端 `handleStatus`**（0 未读 / 1 已读），
 * 点开某条报警时 `markRead()` 本地乐观置 1 并 PATCH 回去（原逻辑保留）。
 *
 * 无人机预警的数据里**没有未读/已读字段**（`auditStatusType` 只有
 * `UNAUDITED` / `AUDITED`），所以按现场规则用状态代替：**今日 + 待处理**算未处理。
 * 点开一条不会让它变少 —— 那是审核平台里的人工动作，本 App 不做。
 *
 * ## 今日口径（2026-11-20 二次定稿）
 *
 * 两类的数字**都只算今日**：监控是「今日未读」、无人机是「今日待处理」。
 * 历史预警不参与任何计数，列表里也不点红点 —— 「还没看」只对今天有意义。
 *
 * ## tabbar 角标
 *
 * = 监控今日未读 + 无人机今日待处理（两类之和，2026-11-20 现场要求）。
 * 都只算今日，所以不会出现「几百条待处理把角标钉死在 99+、点开还不减」那种情况。
 */

/** 一类预警在消息页上的汇总 */
export interface MsgCategory {
  id: 'monitor' | 'drone'
  title: string
  desc: string
  /** 相对时间（「1分钟前」）；没有数据时是空串 */
  time: string
  /** 数字的含义（「今日未读」/「今日待处理」）—— 卡片上紧挨着数字显示，避免读成别的口径 */
  hint: string
  /** 未读 / 待处理条数（都只算今日）；0 表示不显示红点 */
  unread: number
  /** 已知条数（未登录或还没加载时为 false，卡片写「—」而不是 0） */
  known: boolean
}

export const useMsgStore = defineStore('msg', () => {
  const alarm = useAlarmStore()
  const auth = useAuthStore()
  const drone = useDroneAlarmStore()

  /** 已读判定：服务端 handleStatus === 1 才算已读；取不到（旧数据/夹具）按未读 */
  function isRead(a: { handleStatus?: number }): boolean {
    return a.handleStatus === 1
  }

  /**
   * 监控预警未读数 —— **只算今日**（2026-11-20 现场口径）。
   *
   * 已读/未读只对今日预警有意义（历史报警是回看，不存在「还没看」），
   * 所以这里取 `alarm.latest`（今日列表）而不是全部已加载报警；
   * 明细页的红点用的是同一条判据，卡片数字与红点个数因此永远一致。
   */
  const monitorUnread = computed(() => alarm.latest.filter((a) => !isRead(a)).length)

  /**
   * 监控预警的最新一条：优先今日，今日没有才退到已加载里最新的一条。
   *
   * 退到历史那条时时间会写成「昨天 21:41」，卡片上不会误读成今天 ——
   * 而空着更糟：一条报警都看不到时会以为这模块没数据。
   */
  const monitorLatest = computed(() => alarm.latest[0] ?? alarm.liveAlarms[0])

  /**
   * 底部 tabbar 的消息角标 = **两类之和**（监控今日未读 + 无人机今日待处理）。
   *
   * 两边都只算今日，因此角标永远等于「点进消息页看到的那两个数字相加」，
   * 不会因为无人机历史遗留的几百条待处理而钉死在 99+。
   */
  const unreadTotal = computed(() => monitorUnread.value + drone.todayPending)

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
        hint: '今日未读',
        unread: monitorUnread.value,
        // 首屏同步完成 / 失败都算「已知」：失败时列表页会写清楚原因
        known: alarm.hasLive || alarm.liveState === 'ok' || alarm.liveState === 'error',
      },
      {
        id: 'drone',
        title: '无人机预警',
        desc: '无人机巡检 AI 智能识别风险',
        time: top ? drone.relOf(top) : '',
        // 与监控卡片同一口径：都只数今日（无人机没有未读字段，用「待处理」代替）
        hint: '今日待处理',
        unread: drone.todayPending,
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

  /**
   * 点开某条监控报警 → 标记已读。
   *
   * 与改造前一致：先本地乐观更新（handleStatus 置 1，角标立即减一），
   * 再发 PATCH 把服务端状态也置 1。PATCH 失败静默吞掉，等下次同步以服务端为准。
   */
  async function markRead(id: string): Promise<void> {
    const target = alarm.byId(id)
    if (target && !isRead(target)) target.handleStatus = 1
    const token = auth.token
    if (!token) return
    const remoteId = id.startsWith('va-') ? id.slice(3) : id
    if (!remoteId) return
    try {
      await setAlarmStatus(token, remoteId, 1)
    } catch {
      // 标记失败不打扰用户：本地已乐观更新，服务端下次同步会回正
    }
  }

  return {
    categories,
    isEmpty,
    monitorUnread,
    monitorLatest,
    unreadTotal,
    markRead,
  }
})
