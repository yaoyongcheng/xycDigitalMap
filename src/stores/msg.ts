import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { fetchVideoAlarms, setAlarmStatus } from '@/api/video'
import { toAlarms } from '@/utils/videoAlarm'
import { useAlarmStore } from './alarm'
import { useAuthStore } from './auth'
import type { Alarm, Message } from '@/types'

/**
 * 消息（2026-11 阶段 5：改真实报警派生；阶段 6：20 条/页分页查询；
 * 阶段 7：已读改服务端 handleStatus + PATCH 标记已读）
 *
 * 原先是 2 条写死消息 + tabbar 上同样写死的角标 2。现在一条真实报警一条消息。
 *
 * **已读的权威来源是服务端的 `handleStatus` 字段**（0 = 未读，1 = 已读）——
 * 这是参照 Unity 端《万联装备集群作业系统》的 `AIAlarmMessage.AlarmStatus` 逻辑：
 *   ① 报警列表 `/api/video/alarms` 每行带 `handleStatus`；
 *   ② 消息列表据此显示未读红点（`unreadDot.SetActive(status == 0)`）；
 *   ③ 点开消息调 `PATCH /api/video/alarms/{id}/status`，body `{"status":1}` 置已读。
 * 状态存在服务端，**刷新/换端天然不丢** —— 早先靠前端本地 Set 记已读，刷新即归零，
 * 这正是用户反馈「刷新后消息数量没变」的根因。
 *
 * 前端只做「乐观更新」：点开即把本地那条 alarm 的 handleStatus 置 1 并立刻反映到
 * 角标，同时发 PATCH；接口失败不影响本地已读展示（下次重新同步会以服务端为准回正）。
 *
 * **分页口径（2026-11 调整）**：消息页自己按 `page_size=20` 一页页查——
 * 下滑一次 = 一次分页请求 = 列表 +20 条。首屏不再额外请求 page 1：登录后
 * 报警首屏同步（200 条/页 × 2）已经把最近 20 条拿到手，直接复用，避免进
 * 消息页先白打一趟。
 *
 * 分页拉回来的报警会 `alarm.appendLive()` 并进全局报警源 —— 否则点消息进
 * 详情时 `byId()` 找不到、抓拍图也按 id 拉不到。
 */

/** 消息页每页 / 每次下滑的条数 */
export const MSG_PAGE_SIZE = 20

export const useMsgStore = defineStore('msg', () => {
  const alarm = useAlarmStore()
  const auth = useAuthStore()

  /** 消息页自己的分页列表：首屏复用报警同步结果，之后每次下滑追加一页 */
  const items = ref<Alarm[]>([])

  /** 已覆盖到第几页（0 = 一条都还没拿；首屏 20 条 = 第 1 页） */
  const pageNo = ref(0)

  /** 正在请求下一页 */
  const loadingMore = ref(false)

  /** 下一页失败原因（成功或重试时清空），只影响消息页底部，不污染全局报警态 */
  const loadError = ref('')

  /** 某页没带回新数据 → 到底了，别再空打接口 */
  const exhausted = ref(false)

  /** 已读判定：服务端 handleStatus === 1 才算已读；取不到（旧数据/夹具）按未读 */
  function isRead(a: Alarm): boolean {
    return a.handleStatus === 1
  }

  const messages = computed<Message[]>(() =>
    items.value.map((a) => ({
      id: a.id,
      kind: 'video',
      title: a.title,
      desc: a.desc,
      time: a.rel,
      unread: isRead(a) ? 0 : 1,
    })),
  )

  /** 总条数取服务端 total 与本机已展示条数的较大值 */
  const totalCount = computed(() => Math.max(alarm.total, items.value.length))

  /**
   * 底部 tabbar 的消息角标。
   *
   * 以「已加载报警里未读（handleStatus !== 1）的条数」为准，而不是「服务端 total
   * - 已读」：现场 total 有 1800+，而首屏只加载 400、消息页只展开 20，用 total 相减
   * 角标永远钉在 99+，用户点开几条也看不到变化。点开一条 → 该条 handleStatus 置 1
   * → 角标减 1，反馈即时且真实。
   */
  const unreadTotal = computed(() => alarm.liveAlarms.filter((a) => !isRead(a)).length)

  /** 还有多少条没展示（服务端总数 - 已展示） */
  const hiddenCount = computed(() => Math.max(0, totalCount.value - items.value.length))

  /** 是否还能继续下滑加载 */
  const hasMore = computed(() => !exhausted.value && items.value.length < totalCount.value)

  /**
   * 首屏复用报警首屏同步的结果（最多 20 条）。
   *
   * `pageNo` 按「已展示条数 / 20」取整：整 20 条就是第 1 页，下次从第 2 页
   * 开始；只有 5 条时是第 0 页，下次从第 1 页开始（去重后正好补齐 6-20），
   * 不会跳过中间那段。
   */
  function seed(): void {
    if (items.value.length || !alarm.liveAlarms.length) return
    items.value = alarm.liveAlarms.slice(0, MSG_PAGE_SIZE)
    pageNo.value = Math.floor(items.value.length / MSG_PAGE_SIZE)
  }

  // 首屏同步完成（或失败后重试成功）时播种；清空时由 reset() 处理
  watch(() => alarm.liveAlarms.length, seed, { immediate: true })

  /**
   * 点开某条消息 → 标记已读。
   *
   * 参照 Unity 端的 `AIAlarmDetail.UpdateLocalAlarmStatus`：先本地乐观更新
   * （把这条 alarm 的 handleStatus 置 1，角标立即减一），再发 PATCH 把服务端
   * 状态也置 1。PATCH 失败静默吞掉 —— 本地已读不回退，等下次重新同步时
   * 以服务端为准（若服务端没成功，那条会重新变回未读，行为可接受）。
   */
  async function markRead(id: string): Promise<void> {
    const target = alarm.byId(id)
    if (target && !isRead(target)) {
      // 乐观更新：就地改 handleStatus，让 messages/unreadTotal 的 computed 立即反映
      target.handleStatus = 1
    }
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

  /**
   * 下滑触底：向 `:8085` 查下一页（`page_size=20`），追加到消息列表。
   *
   * 失败不上抛、不清空已有消息、`pageNo` 不推进 —— 底部给「重试」，
   * 重试仍从同一页开始。
   */
  async function loadMore(token: string = auth.token): Promise<void> {
    if (loadingMore.value || !hasMore.value || !token) return
    loadingMore.value = true
    loadError.value = ''
    const next = pageNo.value + 1
    try {
      const page = await fetchVideoAlarms(token, { page: next, pageSize: MSG_PAGE_SIZE })
      const rows = toAlarms(page.rows)
      // 并入全局报警源：详情页按 id 查、抓拍图按 id 拉都依赖它
      alarm.appendLive(rows, page.total)

      const known = new Set(items.value.map((a) => a.id))
      const fresh = rows.filter((a) => !known.has(a.id))
      if (!fresh.length) {
        // 该页全是已展示过的（服务端偏移期间有新报警插入）或已空 —— 到底了
        exhausted.value = true
        return
      }
      pageNo.value = next
      items.value = [...items.value, ...fresh]
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : '更多消息加载失败'
    } finally {
      loadingMore.value = false
    }
  }

  /** 退出登录 / 换账号时清掉分页游标（已读态由服务端 handleStatus 承载，无需本地清） */
  function reset(): void {
    items.value = []
    pageNo.value = 0
    loadingMore.value = false
    loadError.value = ''
    exhausted.value = false
  }

  watch(
    () => auth.token,
    (t) => {
      if (!t) reset()
    },
  )

  return {
    messages,
    items,
    pageNo,
    totalCount,
    hiddenCount,
    hasMore,
    loadingMore,
    loadError,
    unreadTotal,
    markRead,
    loadMore,
    reset,
  }
})
