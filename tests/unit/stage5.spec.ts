import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { clearPictureCache } from '@/api/video'
import MsgPage from '@/views/MsgPage.vue'
import PeopleDist from '@/views/home/parts/PeopleDist.vue'
import WorkPage from '@/views/WorkPage.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useMsgStore } from '@/stores/msg'
import { useSubpageStore } from '@/stores/subpage'
import { camAlarmFixtures } from '../fixtures/camAlarms'

/**
 * 阶段 5：现场影像与消息的真数据化（2026-11）
 *
 * 这一组钉住「不再编造」这条底线：
 *   · 点位只能来自报警里的 channelNo，抓拍只能来自该通道该日的真实报警；
 *   · 没有定位接口时人数显示「—」，不许拿 0 或稀疏表顶替；
 *   · 消息与 tabbar 角标跟着真实报警走，没有报警就是空态；
 *   · 涉及 Bearer 的入口（监控）未登录要先去登录页。
 */

const B64 = '/9j/' + 'A'.repeat(120)

/** `:8084 /api/data/areas` 的真实形状（两条，字段照服务端原样） */
const AREA_ROWS = [
  { id: 175, project_id: 'P000000076', area_name: '智能电梯2', principal: '未设置' },
  { id: 132, project_id: 'P000000076', area_name: '酒店', principal: '未设置' },
]

function signIn(): void {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.expiresAt = Date.now() + 3_600_000
}

function jsonResponse(body: unknown): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

describe('阶段 5 · 真实数据', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearPictureCache()
    // 按 URL 分流：抓拍图 → {data:{pictureData}}；区域台账 → {data:{list,total}}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        jsonResponse(
          String(url).includes('/api/data/areas')
            ? { code: 200, data: { list: AREA_ROWS, total: AREA_ROWS.length } }
            : { code: 200, data: { pictureData: B64 } },
        ),
      ),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('监控点位与报警抓拍', () => {
    it('点位由真实报警的 channelNo 去重派生，没有报警就没有点位', () => {
      const cam = useCamStore()
      expect(cam.cameras).toEqual([])
      expect(cam.currentCam.name).toBe('暂无监控点位')

      useAlarmStore().liveAlarms = camAlarmFixtures()
      expect(cam.cameras.map((c) => [c.id, c.name])).toEqual([
        ['ch-2', '2号通道'],
        ['ch-3', '3号通道'],
      ])
      expect(cam.grouped.map((g) => g.name)).toEqual(['视频监控'])
    })

    it('抓拍按「通道 + 日期」真实过滤，不再恒定 3 张 / 不轮转假图', () => {
      signIn()
      useAlarmStore().liveAlarms = camAlarmFixtures()
      const cam = useCamStore()
      cam.camId = 'ch-2'

      expect(cam.camShots.map((s) => s.time)).toEqual(['08:12:00', '12:36:00', '16:50:00'])
      expect(cam.camShots.every((s) => s.pos === '' && s.img === '')).toBe(true)
      // 昨天只有 1 条；更早的日子没有任何记录 → 空数组（明确空态，不编 3 张）
      expect(cam.shotsFor('ch-2', 1)).toHaveLength(1)
      expect(cam.shotsFor('ch-2', 7)).toEqual([])
      expect(cam.shotsFor('ch-3', 0)).toHaveLength(1)
      expect(cam.shotsFor('unknown', 0)).toEqual([])
    })

    it('未登录点监控：跳登录页而不是先摆一个空播放器', async () => {
      const w = mount(WorkPage)
      await w.find('[data-work="cam"]').trigger('click')
      const sub = useSubpageStore()
      expect(sub.view).toEqual({ kind: 'login' })
      expect(sub.loginNotice).toContain('登录')
      expect(useCamStore().isOpen).toBe(false)
      w.unmount()
    })

    it('抓拍图走真实截图接口，回填到对应灰条位置并缓存', async () => {
      signIn()
      useAlarmStore().liveAlarms = camAlarmFixtures()
      const cam = useCamStore()
      cam.camId = 'ch-2'
      cam.showCamMode('shots')
      await flushPromises()

      expect(cam.camShots[0].img).toContain('data:image/jpeg;base64,')
      expect(cam.currentCam.img).toContain('data:image/jpeg;base64,')
      // 同一条不重复打接口（LRU + store 内缓存）
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length
      await cam.ensurePictures(['101'])
      await flushPromises()
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
    })

    it('报警晚到时自动选中首个真实通道，抓拍视图不会一直空着', async () => {
      signIn()
      const cam = useCamStore()
      cam.openCam('')
      expect(cam.camId).toBe('')

      useAlarmStore().liveAlarms = camAlarmFixtures()
      await nextTick()
      expect(cam.camId).toBe('ch-2')
      expect(cam.camShots.length).toBeGreaterThan(0)
    })
  })

  describe('消息中心与 tabbar 角标', () => {
    it('一条真实报警一条消息，未读按 id 清而不是按类型全清', async () => {
      const feed = camAlarmFixtures().slice(0, 3)
      useAlarmStore().liveAlarms = feed
      const msg = useMsgStore()
      expect(msg.messages.map((m) => m.id)).toEqual(feed.map((a) => a.id))
      expect(msg.messages.every((m) => m.kind === 'video')).toBe(true)
      expect(msg.unreadTotal).toBe(3)

      msg.markRead(feed[1].id)
      await nextTick()
      expect(msg.unreadTotal).toBe(2)
      expect(msg.messages[1].unread).toBe(0)
      expect(msg.messages[0].unread).toBe(1)
    })

    it('没有报警时消息页是空态，未登录给去登录入口', async () => {
      const w = mount(MsgPage)
      expect(w.find('[data-empty="msg"]').text()).toContain('登录后可查看现场报警消息')
      expect(w.find('.data-empty-btn').exists()).toBe(true)

      signIn()
      await nextTick()
      expect(w.find('[data-empty="msg"]').text()).toContain('暂无消息')
      expect(w.find('.msg-item').exists()).toBe(false)
      w.unmount()
    })

    it('报警首屏同步期间不先说「暂无消息」，只铺同构灰条', async () => {
      const alarm = useAlarmStore()
      alarm.liveState = 'loading'
      const w = mount(MsgPage)
      await nextTick()
      expect(w.find('[data-skel="msg"]').exists()).toBe(true)
      expect(w.find('[data-empty="msg"]').exists()).toBe(false)

      alarm.liveState = 'ok'
      await nextTick()
      expect(w.find('[data-skel="msg"]').exists()).toBe(false)
      expect(w.find('[data-empty="msg"]').exists()).toBe(true)
      w.unmount()
    })

    it('点开消息落回对应报警详情', async () => {
      const feed = camAlarmFixtures().slice(0, 2)
      useAlarmStore().liveAlarms = feed
      const w = mount(MsgPage)
      await w.findAll('.msg-item')[1].trigger('click')
      expect(useSubpageStore().view).toEqual({ kind: 'alarm-detail', id: feed[1].id })
      expect(useMsgStore().unreadTotal).toBe(1)
      w.unmount()
    })

    it('已读状态来自服务端 handleStatus，未读红点据此显示', () => {
      const feed = camAlarmFixtures().slice(0, 3)
      feed[1].handleStatus = 1 // 这条已读
      useAlarmStore().liveAlarms = feed
      const msg = useMsgStore()

      // 已读那条不显示未读角标
      expect(msg.messages[0].unread).toBe(1)
      expect(msg.messages[1].unread).toBe(0)
      expect(msg.messages[2].unread).toBe(1)
      expect(msg.unreadTotal).toBe(2) // 3 条里 1 条已读
    })

    it('点开消息乐观置已读并发 PATCH /status，body 为 {status:1}', async () => {
      signIn()
      const feed = camAlarmFixtures().slice(0, 2)
      useAlarmStore().liveAlarms = feed
      const asMock = fetch as unknown as ReturnType<typeof vi.fn>

      const msg = useMsgStore()
      await msg.markRead(feed[1].id) // id = va-102 → 远程 102
      await flushPromises()

      // 乐观更新：本地这条已置 1
      expect(feed[1].handleStatus).toBe(1)
      expect(msg.unreadTotal).toBe(1)

      // 发出了 PATCH 请求，路径 /api/video/alarms/102/status
      const patchCall = asMock.mock.calls.find((c) => String(c[1]?.method) === 'PATCH')
      expect(patchCall).toBeTruthy()
      const [url, init] = patchCall as [string, RequestInit]
      expect(String(url)).toContain('/api/video/alarms/102/status')
      expect(JSON.parse(String(init.body))).toEqual({ status: 1 })
      expect(init.method).toBe('PATCH')
    })
  })

  describe('人员分布：真实区域台账 + 人数空态', () => {
    it('面板挂载即拉 :8084 区域清单，人数显示「—」而不是 0 人', async () => {
      signIn()
      const w = mount(PeopleDist)
      // 关键：人员面板自己触发取数，不能等用户先点开智控/设备页
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/data/areas'),
        expect.anything(),
      )
      await flushPromises()
      await nextTick()

      expect(w.findAll('.people-zone')).toHaveLength(2)
      expect(w.text()).toContain('智能电梯2')
      expect(w.text()).toContain('人员实时定位接口未开放')
      expect(w.text()).not.toContain('0人')
      expect(w.text()).toContain('—')
      w.unmount()
    })

    it('加载中不说「暂无」，慢请求灰条与真实卡片同构', async () => {
      signIn()
      let release: ((r: unknown) => void) | undefined
      vi.stubGlobal('fetch', vi.fn(() => new Promise((res) => { release = res })))
      const w = mount(PeopleDist)
      await nextTick()

      expect(w.find('[data-skel="people-dist"].people-zones').exists()).toBe(true)
      expect(w.find('[data-empty="people-dist"]').exists()).toBe(false)

      release?.(jsonResponse({ code: 200, data: { list: AREA_ROWS, total: 2 } }))
      await flushPromises()
      await nextTick()
      expect(w.find('[data-skel="people-dist"]').exists()).toBe(false)
      expect(w.findAll('.people-zone')).toHaveLength(2)
      w.unmount()
    })

    it('区域接口没有数据时给空态，不用设计稿的 5 个区域顶上', async () => {
      signIn()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ code: 200, data: { list: [], total: 0 } })),
      )
      const w = mount(PeopleDist)
      await flushPromises()
      expect(w.find('[data-empty="people-dist"]').text()).toContain('暂无项目区域数据')
      expect(w.findAll('.people-zone')).toHaveLength(0)
      w.unmount()
    })

    it('loadAreas 失败只影响区域这一块，不把设备台账一起判失败', async () => {
      signIn()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 500, text: async () => 'oops' })),
      )
      const ledger = useDeviceLedgerStore()
      await ledger.loadAreas(useAuthStore().token, true)
      expect(ledger.areas).toEqual([])
      expect(ledger.areasState).toBe('error')
      expect(ledger.state).toBe('idle')
    })
  })
})
