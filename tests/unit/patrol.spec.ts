import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import { clearSession } from '@/api/drone'
import SheetHost from '@/components/overlays/SheetHost.vue'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { usePatrolStore, type PatrolPhotoReal } from '@/stores/patrol'
import HomeSheet from '@/views/home/HomeSheet.vue'
import PatrolPanel from '@/views/home/PatrolPanel.vue'

/**
 * 智巡照片墙（2026-11 阶段 8：改真实航拍照片）
 *
 * 原版钉的是「六个手工分类 + 17 张写死静态图」，那套数据已全部删除 ——
 * 照片改接 keehang 真实航拍媒体（见 `stores/patrol.ts`）。
 *
 * 现在钉住的是**新口径**下更重要的三件事：
 *   1. 照片按拍摄时间倒序 —— 现场最关心「最近一张是什么」；
 *   2. 元信息用服务端给的字段（所属任务 / 来源 / 时间 / 大小），
 *      不再有编造的分类；
 *   3. **没有数据就是没有** —— 不许回落演示图，不许出现 0 张以外的假象。
 */

/** 造一张真实形态的照片（结构与 keehang 媒体一致） */
function photo(n: Partial<PatrolPhotoReal> & { id: string; name: string }): PatrolPhotoReal {
  return {
    id: n.id,
    name: n.name,
    url: n.url ?? `https://oss.keehang.com/iot-media/${n.id}.jpeg`,
    taskName: n.taskName ?? '向阳村-安全巡检',
    jobId: n.jobId ?? 147744,
    time: n.time ?? '2026-07-15 09:38:39',
    size: n.size ?? 5_378_048,
    mediaType: n.mediaType ?? 'image/jpeg',
  }
}

const Host = defineComponent({
  components: { PatrolPanel, SheetHost },
  setup: () => () => h('div', [h(PatrolPanel), h(SheetHost)]),
})

/**
 * 断掉真实网络。
 *
 * 面板挂载即 `patrol.load()`，不 stub 的话会真的去请求 keehang 平台 ——
 * 用例跑得慢、还可能拉到现场真实照片让断言飘。
 */
function offline(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ code: 500, msg: 'offline' }) })),
  )
}

describe('智巡面板（真实航拍照片）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    offline()
  })

  afterEach(async () => {
    // 先排空待决请求：上一个用例若没等 load() 结束，桩已被 unstubGlobals
    // 清掉，再放行就会真的打到 keehang 线上。
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  it('照片按拍摄时间倒序（最新的在前）', async () => {
    const patrol = usePatrolStore()
    patrol.apply([
      photo({ id: 'a', name: '旧图.jpeg', time: '2026-07-14 10:00:00' }),
      photo({ id: 'b', name: '新图.jpeg', time: '2026-07-15 09:38:39' }),
    ])
    const w = mount(PatrolPanel)
    await nextTick()

    const cards = w.findAll('.patrol-card')
    expect(cards).toHaveLength(2)
    // 卡片显示的是「所属任务 + 拍摄时间」，不是文件名
    expect(cards[0].text()).toContain('2026-07-15 09:38')
    expect(cards[1].text()).toContain('2026-07-14 10:00')
    expect(w.find('.patrol-hd em').text()).toBe('2 张')
    w.unmount()
  })

  it('卡片显示任务名与体积，不显示编造的分类', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-塔吊定点' })])
    const w = mount(PatrolPanel)
    await nextTick()

    const card = w.find('.patrol-card')
    expect(card.text()).toContain('向阳村-塔吊定点')
    expect(card.text()).toContain('5.1MB')
    // 分类标签是设计稿的人工归类，服务端没有这个字段，不该再出现
    expect(w.find('.patrol-cats').exists()).toBe(false)
    w.unmount()
  })

  it('没有真实照片时给空态，不回落演示图', async () => {
    const w = mount(PatrolPanel)
    // 等同步结束：同步中显示的是同构骨架（也用 .patrol-card），
    // 空态要等数据回来（这里返回失败 → 错误空态）才出现
    await flushPromises()
    await nextTick()

    expect(w.findAll('.patrol-card')).toHaveLength(0)
    // 空态里要能看到失败原因（服务端 msg），而不是笼统的「暂无」
    expect(w.find('[data-empty="patrol"]').text()).toContain('offline')
    expect(w.find('[data-empty="patrol"]').find('.data-empty-btn').exists()).toBe(true)
    w.unmount()
  })
})

describe('智巡大图弹层（真实航拍照片）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    offline()
  })

  afterEach(async () => {
    // 先排空待决请求：上一个用例若没等 load() 结束，桩已被 unstubGlobals
    // 清掉，再放行就会真的打到 keehang 线上。
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  it('点卡片开弹层，元信息用服务端字段', async () => {
    const patrol = usePatrolStore()
    patrol.apply([
      photo({
        id: 'a',
        name: 'DJI_20260715093839_0001_V.jpeg',
        taskName: '向阳村-安全巡检',
        time: '2026-07-15 09:38:39',
      }),
    ])
    const w = mount(Host)
    await nextTick()

    await w.findAll('.patrol-card')[0].trigger('click')
    await nextTick()

    const meta = w.find('.patrol-meta').text()
    expect(meta).toContain('向阳村-安全巡检')
    expect(meta).toContain('无人机')
    expect(meta).toContain('2026-07-15 09:38')
    // 大图 src 是 OSS 直链，不再是本地静态 webp
    expect(w.find('.patrol-view img').attributes('src')).toContain('oss.keehang.com')
    w.unmount()
  })

  it('弹层状态是 patrol', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'a.jpeg' })])
    const w = mount(Host)
    await nextTick()

    await w.findAll('.patrol-card')[0].trigger('click')
    await nextTick()

    expect(useBottomSheetStore().kind).toBe('patrol')
    w.unmount()
  })
})

describe('首页三模块', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    offline()
  })

  afterEach(async () => {
    // 先排空待决请求：上一个用例若没等 load() 结束，桩已被 unstubGlobals
    // 清掉，再放行就会真的打到 keehang 线上。
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  it('名称与顺序是 智巡 / 智眸 / 智控（含副标题）', () => {
    const w = mount(HomeSheet, { props: { dragTop: null } })
    const mods = w.findAll('.home-mod')

    expect(mods).toHaveLength(3)
    expect(mods.map((b) => b.text())).toEqual([
      '智巡风险预警・人员动态',
      '智眸现场快照・实景核验',
      '智控集群管控・数驱作业',
    ])
    expect(mods.map((b) => b.attributes('data-mod'))).toEqual(['safety', 'patrol', 'equip'])
    w.unmount()
  })

  it('切到智巡会挂载照片墙（面板容器随之重挂载）', async () => {
    const w = mount(HomeSheet, { props: { dragTop: null } })
    const before = w.find('#homePanels').element

    await w.findAll('.home-mod')[1].trigger('click')
    await nextTick()

    expect(w.find('#homePanels').element).not.toBe(before)
    expect(w.find('.patrol-grid').exists()).toBe(true)
    w.unmount()
  })
})
