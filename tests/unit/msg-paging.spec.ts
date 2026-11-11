import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import MsgPage from '@/views/MsgPage.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { MSG_PAGE_SIZE, useMsgStore } from '@/stores/msg'
import { dateKey } from '@/utils/date'
import type { Alarm } from '@/types'

/**
 * 阶段 6：消息页 20 条/页分页查询（2026-11）
 *
 * 背景：报警首屏同步 400 条、现场全量 1800+，早期 `slice(0, 20)` 把列表
 * 硬截断，于是「tabbar 角标 99+、列表只有 20 条，剩下的永远看不到」。
 *
 * 现在的口径：**下滑一次 = 一次 `page_size=20` 的分页请求 = 列表 +20 条**。
 * 首屏不重复请求第 1 页（复用报警首屏同步的最近 20 条），之后逐页向后查；
 * 拉回来的报警同时并入全局报警源，详情页与抓拍图才按 id 找得到。
 */

/** 造 n 条时间倒序的本地真实报警（不掺任何演示常量） */
function localAlarms(n: number, from = 0): Alarm[] {
  const base = Date.now()
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base - (from + i) * 60_000)
    return {
      id: `va-local-${from + i}`,
      day: 'today',
      src: 'cam',
      type: '反光衣检测',
      title: '防护报警',
      desc: '反光衣检测 · 2号通道抓拍',
      img: '',
      rel: '',
      at: `${dateKey(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`,
      geo: '',
      channelNo: 2,
    }
  })
}

/** `:8085 /api/video/alarms` 的真实信封形状（data.list + data.total） */
function serverRows(n: number, from = 0): Record<string, unknown>[] {
  const base = Date.now() - 100_000 * 60_000
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base - (from + i) * 60_000)
    return {
      Id: `page-${from + i}`,
      AlertName: '',
      AlertType: 12,
      CaptureTime: `${dateKey(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`,
      HandleStatus: 0,
      ChannelNo: 2,
    }
  })
}

function jsonResponse(body: unknown): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

function signIn(): void {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.expiresAt = Date.now() + 3_600_000
}

/** 把报警 store 摆成「首屏已同步 2 页」的样子 */
function seed(count: number, total = count): void {
  const alarm = useAlarmStore()
  alarm.liveAlarms = localAlarms(count)
  alarm.pagesLoaded = 2
  alarm.total = total
  alarm.liveState = 'ok'
}

/** 按 URL 里的 page 返回不同的一页 20 条，模拟真实分页 */
function pagedFetch(perPage = MSG_PAGE_SIZE) {
  return vi.fn(async (url: string) => {
    const u = new URL(String(url))
    const page = Number(u.searchParams.get('page') || '1')
    return jsonResponse({ code: 200, data: { list: serverRows(perPage, page * 1000), total: 1825 } })
  })
}

const asMock = () => fetch as unknown as ReturnType<typeof vi.fn>

describe('阶段 6 · 消息 20 条/页分页查询', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 200, data: { list: [], total: 0 } })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('首屏复用报警同步的最近 20 条，不再重复请求第 1 页', () => {
    seed(45, 1825)
    const msg = useMsgStore()

    expect(msg.messages).toHaveLength(20)
    expect(msg.pageNo).toBe(1)
    expect(msg.hasMore).toBe(true)
    expect(msg.hiddenCount).toBe(1805)
    expect(msg.unreadTotal).toBe(1825)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('下滑一次 = 一次 page_size=20 的分页查询，列表正好 +20', async () => {
    seed(20, 1825)
    const msg = useMsgStore()
    vi.stubGlobal('fetch', pagedFetch())

    await msg.loadMore('test-token')

    expect(asMock().mock.calls).toHaveLength(1)
    const u = new URL(String(asMock().mock.calls[0][0]))
    expect(u.pathname).toBe('/api/video/alarms')
    expect(u.searchParams.get('page')).toBe('2')
    expect(u.searchParams.get('page_size')).toBe('20')
    expect(msg.messages).toHaveLength(40)
    expect(msg.pageNo).toBe(2)
  })

  it('连续下滑按 page=3、page=4 逐页查，每次只多 20 条', async () => {
    seed(20, 1825)
    const msg = useMsgStore()
    vi.stubGlobal('fetch', pagedFetch())

    await msg.loadMore('test-token')
    await msg.loadMore('test-token')

    const pages = asMock().mock.calls.map((c) => new URL(String(c[0])).searchParams.get('page'))
    expect(pages).toEqual(['2', '3'])
    expect(msg.messages).toHaveLength(60)
  })

  it('分页拉回的报警并入全局报警源，详情与抓拍按 id 能查到', async () => {
    seed(20, 1825)
    const msg = useMsgStore()
    vi.stubGlobal('fetch', pagedFetch())

    await msg.loadMore('test-token')

    const alarm = useAlarmStore()
    expect(alarm.total).toBe(1825)
    expect(alarm.byId('va-page-2000')).toBeTruthy()
  })

  it('某页没有新数据就判定到底，不再空打接口', async () => {
    seed(20, 1825)
    const msg = useMsgStore()
    // 服务端这页返回的 20 条与已展示的完全重复
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          code: 200,
          data: {
            list: localAlarms(20).map((a) => ({
              Id: a.id.replace('va-', ''),
              AlertName: '',
              AlertType: 12,
              CaptureTime: a.at,
              HandleStatus: 0,
              ChannelNo: 2,
            })),
            total: 1825,
          },
        }),
      ),
    )

    await msg.loadMore('test-token')
    expect(msg.hasMore).toBe(false)

    await msg.loadMore('test-token')
    expect(asMock().mock.calls).toHaveLength(1)
  })

  it('拉页失败保留已有 20 条、给错误可重试，重试仍查同一页', async () => {
    seed(20, 1825)
    const msg = useMsgStore()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('断网') }))

    await msg.loadMore('test-token')
    expect(msg.messages).toHaveLength(20)
    expect(msg.loadError).toBeTruthy()
    expect(msg.pageNo).toBe(1)

    vi.stubGlobal('fetch', pagedFetch())
    await msg.loadMore('test-token')
    expect(msg.loadError).toBe('')
    expect(msg.messages).toHaveLength(40)
    expect(new URL(String(asMock().mock.calls[0][0])).searchParams.get('page')).toBe('2')
  })

  it('未登录不发带空 Bearer 的分页请求', async () => {
    seed(20, 1825)
    const msg = useMsgStore()
    await msg.loadMore()
    expect(fetch).not.toHaveBeenCalled()
    expect(msg.messages).toHaveLength(20)
  })

  it('首屏只同步到 5 条时从第 1 页补，不跳过第 6-20 条', () => {
    seed(5, 1825)
    const msg = useMsgStore()
    expect(msg.messages).toHaveLength(5)
    expect(msg.pageNo).toBe(0)
    expect(msg.hasMore).toBe(true)
  })

  it('点底部按钮查下一页，列表从 20 条变 40 条', async () => {
    seed(20, 1825)
    signIn()
    vi.stubGlobal('fetch', pagedFetch())
    const w = mount(MsgPage)

    expect(w.findAll('#msgList .msg-item')).toHaveLength(20)
    expect(w.find('[data-more="more"]').text()).toContain('还有 1805 条')

    await w.find('.msg-more-btn').trigger('click')
    await flushPromises()

    expect(w.findAll('#msgList .msg-item')).toHaveLength(40)
    expect(new URL(String(asMock().mock.calls[0][0])).searchParams.get('page')).toBe('2')
    w.unmount()
  })

  it('滚到列表底部触发下一页查询，距底远时不请求', async () => {
    seed(20, 1825)
    signIn()
    vi.stubGlobal('fetch', pagedFetch())
    const w = mount(MsgPage)
    const el = w.find('#page-msg').element as HTMLElement
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 800 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 1100 })

    await w.find('#page-msg').trigger('scroll')
    await flushPromises()
    expect(asMock().mock.calls).toHaveLength(1)
    expect(w.findAll('#msgList .msg-item')).toHaveLength(40)

    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 0 })
    await w.find('#page-msg').trigger('scroll')
    await flushPromises()
    expect(asMock().mock.calls).toHaveLength(1)
    w.unmount()
  })

  it('服务端只有 5 条时显示「已显示全部」', () => {
    seed(5, 5)
    const w = mount(MsgPage)
    expect(w.find('[data-more="end"]').text()).toContain('已显示全部 5 条消息')
    expect(w.find('[data-more="more"]').exists()).toBe(false)
    w.unmount()
  })

  it('加载下一页时显示状态文字，已有列表不清空', async () => {
    seed(20, 1825)
    signIn()
    let release: ((r: ReturnType<typeof jsonResponse>) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise((res) => { release = res })))
    const w = mount(MsgPage)

    const pending = useMsgStore().loadMore()
    await nextTick()
    expect(w.find('[data-more="loading"]').exists()).toBe(true)
    expect(w.findAll('#msgList .msg-item')).toHaveLength(20)

    release?.(jsonResponse({ code: 200, data: { list: serverRows(20, 2000), total: 1825 } }))
    await pending
    await flushPromises()
    expect(w.find('[data-more="loading"]').exists()).toBe(false)
    expect(w.findAll('#msgList .msg-item')).toHaveLength(40)
    w.unmount()
  })

  it('刷新后直接落在消息 tab：挂载时补一次首屏同步，不会停在「暂无消息」', async () => {
    signIn()
    vi.stubGlobal('fetch', pagedFetch())
    const w = mount(MsgPage)
    await flushPromises()
    await flushPromises()

    expect(asMock().mock.calls.length).toBeGreaterThan(0)
    expect(useAlarmStore().liveAlarms.length).toBeGreaterThan(0)
    expect(w.findAll('#msgList .msg-item').length).toBeGreaterThan(0)
    w.unmount()
  })
})
