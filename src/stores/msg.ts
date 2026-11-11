import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { useAlarmStore } from './alarm'
import { useAuthStore } from './auth'
import type { Message } from '@/types'

/**
 * 消息（2026-11 阶段 5：改真实报警派生）
 *
 * 原先是 2 条写死消息 + tabbar 上同样写死的角标 2。现在一条真实报警一条消息，
 * 未读 = 本次会话里还没点开过的报警；点开跳对应报警详情。
 *
 * 没有独立的「消息接口」：五套后端都没有消息中心，唯一的真实推送源就是
 * `:8085` 的视频报警。宁可让消息页在没数据时空着，也不编一条「人员预警」
 * 出来。已读状态是本地 UI 状态，刷新重置、换账号由 `auth.clear()` 清掉。
 */

/** 消息页最多列多少条（报警可能上千条，首页角标仍按全部未读算） */
const MAX_ITEMS = 20

export const useMsgStore = defineStore('msg', () => {
  const alarm = useAlarmStore()
  const auth = useAuthStore()

  /** 本次会话已点开过的报警 id */
  const readIds = ref<Set<string>>(new Set())

  const messages = computed<Message[]>(() =>
    alarm.liveAlarms.slice(0, MAX_ITEMS).map((a) => ({
      id: a.id,
      kind: 'video',
      title: a.title,
      desc: a.desc,
      time: a.rel,
      unread: readIds.value.has(a.id) ? 0 : 1,
    })),
  )

  /** 底部 tabbar 的消息角标 */
  const unreadTotal = computed(() =>
    alarm.liveAlarms.reduce((sum, a) => sum + (readIds.value.has(a.id) ? 0 : 1), 0),
  )

  /** 点开某条消息 → 已读（参数为报警 id，不再按 kind 一类全清） */
  function markRead(id: string): void {
    if (readIds.value.has(id)) return
    const next = new Set(readIds.value)
    next.add(id)
    readIds.value = next
  }

  /** 退出登录 / 换账号时清掉本地已读态 */
  function reset(): void {
    readIds.value = new Set()
  }

  watch(
    () => auth.token,
    (t) => {
      if (!t) reset()
    },
  )

  return { messages, unreadTotal, markRead, reset }
})
