import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { fetchVideoAlarms } from '@/api/video'
import { toAlarms } from '@/utils/videoAlarm'
import { useAlarmStore } from './alarm'
import { useAuthStore } from './auth'
import type { Alarm, Message } from '@/types'

/**
 * 消息（2026-11 阶段 5：改真实报警派生；阶段 6：20 条/页分页查询）
 *
 * 原先是 2 条写死消息 + tabbar 上同样写死的角标 2。现在一条真实报警一条消息，
 * 未读 = 本次会话里还没点开过的报警；点开跳对应报警详情。
 *
 * 没有独立的「消息接口」：五套后端都没有消息中心，唯一的真实推送源就是
 * `:8085` 的视频报警。宁可让消息页在没数据时空着，也不编一条「人员预警」
 * 出来。已读状态是本地 UI 状态，刷新重置、换账号由 `auth.clear()` 清掉。
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

  /** 本次会话已点开过的报警 id */
  const readIds = ref<Set<string>>(new Set())

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

  const messages = computed<Message[]>(() =>
    items.value.map((a) => ({
      id: a.id,
      kind: 'video',
      title: a.title,
      desc: a.desc,
      time: a.rel,
      unread: readIds.value.has(a.id) ? 0 : 1,
    })),
  )

  /** 总条数取服务端 total 与本机已展示条数的较大值 */
  const totalCount = computed(() => Math.max(alarm.total, items.value.length))

  /** 底部 tabbar 的消息角标；点开一条减一条 */
  const unreadTotal = computed(() => Math.max(0, totalCount.value - readIds.value.size))

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

  /** 点开某条消息 → 已读（参数为报警 id，不再按 kind 一类全清） */
  function markRead(id: string): void {
    if (readIds.value.has(id)) return
    const next = new Set(readIds.value)
    next.add(id)
    readIds.value = next
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

  /** 退出登录 / 换账号时清掉本地已读态与分页游标 */
  function reset(): void {
    readIds.value = new Set()
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
