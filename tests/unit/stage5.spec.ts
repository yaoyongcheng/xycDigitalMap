import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { clearPictureCache } from '@/api/video'
import { buildScenes, type SceneAtte } from '@/api/person'
import MsgPage from '@/views/MsgPage.vue'
import PeopleDist from '@/views/home/parts/PeopleDist.vue'
import WorkPage from '@/views/WorkPage.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useMsgStore } from '@/stores/msg'
import { useOverviewStore } from '@/stores/overview'
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

  describe('监控点位（2026-11-18 设计稿白名单）', () => {
    it('点位是写死的 8 个白名单，与报警数据无关', () => {
      const cam = useCamStore()
      // 旧版是从报警 channelNo 反推，没报警就一个点位都没有；现在反过来：
      // 点位固定，报警有没有都不影响监控页
      expect(useAlarmStore().liveAlarms).toEqual([])
      expect(cam.points).toHaveLength(8)
      expect(cam.current.name).toBe('2#门监控1')
      expect(cam.grouped.map((g) => [g.name, g.items.length])).toEqual([
        ['出入口', 4],
        ['场内', 2],
        ['塔吊', 2],
      ])
      expect(cam.points.map((p) => p.name)).toEqual([
        '2#门监控1',
        '2#门监控2',
        '4#门监控',
        '4#门外监控',
        '地磅全景',
        '钢筋加工棚',
        '2#塔吊',
        '4#塔吊',
      ])
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

    it('登录后从工作台进入：打开监控层并取首个点位画面', async () => {
      signIn()
      // 快照接口直出图片字节，与上面那条 JSON 桩不同，这里单独给一份
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: { get: () => 'image/jpeg' },
          blob: async () => new Blob([new Uint8Array(64)], { type: 'image/jpeg' }),
        })),
      )

      const w = mount(WorkPage)
      await w.find('[data-work="cam"]').trigger('click')
      await flushPromises()

      const cam = useCamStore()
      expect(cam.isOpen).toBe(true)
      expect(cam.camId).toBe(cam.points[0].channelId)
      expect(cam.state).toBe('ok')
      w.unmount()
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

  describe('人员分布：V2 三场景 + 人员姓名', () => {
    /**
     * 人员行照接口真实字段裁剪：`alive` 才是「此刻在场」，
     * 离线的人（areaName 为空、alive false）不计入任何区域。
     */
    const PEOPLE = [
      { personName: '何功纯', personTypeWork: '钢筋工', areaName: '智能钢筋加工区', alive: true, enterpriseName: '湖北瀚海星泊建设有限公司' },
      { personName: '雷承林', personTypeWork: '木工', areaName: '管理区域', alive: true, enterpriseName: '湖北瀚海星泊建设有限公司' },
      { personName: '王五', personTypeWork: '瓦工', areaName: '2#楼1F管控区', alive: true, enterpriseName: '中建三局' },
      { personName: '赵六', personTypeWork: '管理人员', areaName: 'B1管理区域', alive: true, enterpriseName: '中建三局' },
      { personName: '牟其兵', personTypeWork: '木工', areaName: null, alive: false, enterpriseName: '湖北瀚海星泊建设有限公司' },
    ]

    /** 兜底路径的输入：接口只给区域人数、没有人员名单 */
    const COUNTS = [
      { areaId: '1', areaName: '管理区域', onlinePersonNum: '33' },
      { areaId: '2', areaName: '智能钢筋加工区', onlinePersonNum: '2' },
      { areaId: '4', areaName: '2#楼4F管控区', onlinePersonNum: '0' },
      { areaId: '5', areaName: '2#楼1F管控区', onlinePersonNum: '4' },
      { areaId: '6', areaName: 'B1管理区域', onlinePersonNum: '2' },
      { areaId: '-1', areaName: '全部', onlinePersonNum: '41' },
    ]

    function seed(scenes: SceneAtte[], total: number | null): void {
      const ov = useOverviewStore()
      ov.scenes = scenes
      ov.sceneTotal = total
      ov.loading = false
    }

    it('管控区按 V2 地图归到三个场景，只算 alive 的人', () => {
      const { scenes, total } = buildScenes(PEOPLE, [])
      expect(scenes.map((s) => s.name)).toEqual(['场布图', '2#住宅楼', '地下室'])
      // 场布图 = 管理区域(雷承林) + 智能钢筋加工区(何功纯)
      expect(scenes[0].count).toBe(2)
      expect(scenes[1].count).toBe(1)
      expect(scenes[2].count).toBe(1)
      // 2# 住宅楼是固定 1F~5F 五层（与 V2 一致），王五在 1F
      expect(scenes[1].units.map((u) => u.name)).toEqual(['1F', '2F', '3F', '4F', '5F'])
      expect(scenes[1].units[0].count).toBe(1)
      // B1 就是负一层
      expect(scenes[2].units.map((u) => u.name)).toEqual(['-1F'])
      expect(scenes[2].units[0].count).toBe(1)
      // 离线的牟其兵（areaName 为空 / alive false）不进任何区域
      expect(total).toBe(4)
      expect(scenes.flatMap((s) => s.units.flatMap((a) => a.members.map((m) => m.name)))).not.toContain('牟其兵')
    })

    it('同一层的多条管控区合并，表外楼层排在 5F 之后', () => {
      const { scenes } = buildScenes(
        [
          { personName: '甲', personTypeWork: '木工', areaName: '2#楼5F管控区', alive: true },
          { personName: '乙', personTypeWork: '木工', areaName: '2#楼5F管控区_copy', alive: true },
          { personName: '丙', personTypeWork: '瓦工', areaName: '2#楼6F管控区', alive: true },
        ],
        [],
      )
      const s = scenes[1]
      expect(s.units.map((u) => u.name)).toEqual(['1F', '2F', '3F', '4F', '5F', '6F'])
      expect(s.units[4].count).toBe(2)
      expect(s.units[4].members.map((m) => m.name)).toEqual(['甲', '乙'])
      expect(s.count).toBe(3)
    })

    it('每个管控区带人员姓名与工种（人数 = 名单条数，不会对不上）', () => {
      const { scenes } = buildScenes(PEOPLE, [])
      const zb = scenes[0].units.find((a) => a.name === '智能钢筋加工区')
      expect(zb?.members).toEqual([
        { name: '何功纯', trade: '钢筋工', company: '湖北瀚海星泊建设有限公司' },
      ])
      for (const s of scenes) {
        for (const a of s.units) expect(a.count).toBe(a.members.length)
        expect(s.count).toBe(s.units.reduce((n, a) => n + a.count, 0))
      }
    })

    it('接口没给 alive 时退回区域人数（名单为空但数字仍是真的）', () => {
      const { scenes, total } = buildScenes(
        [{ personName: '无名', personTypeWork: '木工', areaName: '管理区域', alive: false }],
        COUNTS,
      )
      expect(total).toBe(41)
      expect(scenes[0].count).toBe(35)
      expect(scenes[0].units[0].members).toEqual([])
    })

    it('地下室现在只有 B1（-1F）；真出现 B2 才追加 -2F，且 -1F 在前', () => {
      const one = buildScenes([{ personName: '甲', areaName: 'B1管理区域', alive: true }], [])
      expect(one.scenes[2].units.map((u) => u.name)).toEqual(['-1F'])

      const two = buildScenes(
        [
          { personName: '甲', areaName: 'B1管理区域', alive: true },
          { personName: '乙', areaName: 'B2管理区域', alive: true },
        ],
        [],
      )
      expect(two.scenes[2].units.map((u) => u.name)).toEqual(['-1F', '-2F'])
      expect(two.scenes[2].units[1].count).toBe(1)
      // B2 归地下室，别漏到场布图
      expect(two.scenes[0].units.map((u) => u.name)).toEqual([])
    })

    it('三个场景都渲染，0 人的场景也明写「0人」', async () => {
      signIn()
      seed(buildScenes(PEOPLE, []).scenes, 4)
      const w = mount(PeopleDist)
      await nextTick()

      const rows = w.findAll('.people-scene')
      expect(rows).toHaveLength(3)
      expect(rows[0].text()).toContain('场布图')
      expect(rows[0].text()).toContain('2')
      expect(rows[1].text()).toContain('2#住宅楼')
      expect(rows[2].text()).toContain('地下室')
      expect(w.text()).not.toContain('—')
      w.unmount()
    })

    it('下钻 2#住宅楼：照 V2 列 1F~5F 五行，没人也占位', async () => {
      signIn()
      seed(buildScenes(PEOPLE, []).scenes, 4)
      const w = mount(PeopleDist)
      await nextTick()

      await w.findAll('.people-scene')[1].trigger('click')
      await nextTick()

      const rows = w.findAll('.people-group')
      expect(rows).toHaveLength(5)
      expect(rows.map((r) => r.find('.people-group-hd span').text())).toEqual(['1F', '2F', '3F', '4F', '5F'])
      // 楼层是一行一条数据，不是分组小标题
      expect(rows.every((r) => r.classes('is-floor'))).toBe(true)
      // 0 人的层不摆「暂无名单」，只有 1F 有王五
      expect(w.findAll('.people-no-member')).toHaveLength(0)
      expect(w.findAll('.people-members .pm-name').map((n) => n.text())).toEqual(['王五'])
      // 副标题按「层」计数
      expect(w.text()).toContain('共5层')
      w.unmount()
    })

    it('点场景下钻，能看到管控区和人员姓名', async () => {
      signIn()
      seed(buildScenes(PEOPLE, []).scenes, 4)
      const w = mount(PeopleDist)
      await nextTick()

      await w.findAll('.people-scene')[0].trigger('click')
      await nextTick()
      expect(w.find('[data-people="areas"]').exists()).toBe(true)
      expect(w.text()).toContain('管理区域')
      // 姓名 + 工种都在
      expect(w.findAll('.people-members .pm-name').map((n) => n.text())).toEqual(['雷承林', '何功纯'])
      expect(w.findAll('.people-members .pm-trade').map((n) => n.text())).toEqual(['木工', '钢筋工'])

      await w.find('[data-people="back"]').trigger('click')
      await nextTick()
      expect(w.find('[data-people="scenes"]').exists()).toBe(true)
      w.unmount()
    })

    it('加载中给同构骨架，不先说「暂无」', async () => {
      signIn()
      const ov = useOverviewStore()
      ov.scenes = []
      ov.loading = true
      const w = mount(PeopleDist)
      await nextTick()

      expect(w.find('[data-skel="people-dist"].people-scenes').exists()).toBe(true)
      expect(w.find('[data-empty="people-dist"]').exists()).toBe(false)
      expect(w.text()).not.toContain('0人')
      w.unmount()
    })

    it('接口没给区域口径时给空态，不拿 0 人冒充「没人」', async () => {
      signIn()
      seed([], null)
      const w = mount(PeopleDist)
      await nextTick()
      expect(w.find('[data-empty="people-dist"]').text()).toContain('暂无人员区域数据')
      expect(w.findAll('.people-scene')).toHaveLength(0)
      expect(w.text()).not.toContain('0人')
      w.unmount()
    })

    it('未登录时引导去登录', async () => {
      seed([], null)
      const w = mount(PeopleDist)
      await nextTick()
      expect(w.find('[data-empty="people-dist"]').text()).toContain('登录')
      w.unmount()
    })

    it('loadAreas 失败只影响区域台账，不把设备台账一起判失败', async () => {
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
