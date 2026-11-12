import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import { clearSession } from '@/api/drone'
import SheetHost from '@/components/overlays/SheetHost.vue'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { catOfTask } from '@/data/config'
import { usePatrolStore, type PatrolPhotoReal } from '@/stores/patrol'
import HomeSheet from '@/views/home/HomeSheet.vue'
import PatrolPanel from '@/views/home/PatrolPanel.vue'

/**
 * 智眸照片墙（现场快照 · 实景核验）
 *
 * 原版钉的是「六个手工分类 + 17 张写死静态图」，那套数据已删除 ——
 * 照片改接 keehang 真实航拍媒体（见 `stores/patrol.ts`）。
 *
 * 2026-11 第四轮按设计稿把**分类作为展示维度**恢复，但归属不写死在数据上：
 * 由任务名关键词推导（`data/config.ts` 的 `catOfTask`），推不出的归「未分类」。
 *
 * 现在钉住的是新口径下最重要的四件事：
 *   1. 照片按拍摄时间倒序 —— 现场最关心「最近一张是什么」；
 *   2. 六个分类恒定显示，且默认落在**真有照片**的那一类上；
 *   3. 推不出分类的照片不会被藏起来（归「未分类」，仅在有时出现）；
 *   4. **没有数据就是没有** —— 不许回落演示图，不许出现 0 张以外的假象。
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

  it('分类按任务名推导，卡片标出所属分类（设计稿六个分类）', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-塔吊定点' })])
    const w = mount(PatrolPanel)
    await nextTick()

    // 六个分类恒定显示（0 张也要占位，否则来数据就错行）
    expect(w.findAll('.patrol-cats button').map((b) => b.text())).toEqual([
      '项目全景',
      '基坑区域',
      '作业面',
      '施工装备',
      '材料堆场',
      '现场场布',
    ])
    // 任务名含「塔吊」→ 施工装备；默认落在第一个**真有照片**的分类上
    expect(w.find('.patrol-cats button.on').text()).toBe('施工装备')

    const card = w.find('.patrol-card')
    expect(card.text()).toContain('向阳村-塔吊定点')
    expect(card.text()).toContain('5.1MB')
    // 分类徽标与来源徽标并排（设计稿 .patrol-card-ft）
    expect(card.text()).toContain('施工装备')
    expect(card.text()).toContain('无人机')
    w.unmount()
  })

  it('推不出分类的照片归「未分类」，该分类只在真有照片时出现', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'b', name: 'b.jpeg', taskName: '例行飞行任务' })])
    const w = mount(PatrolPanel)
    await nextTick()

    const chips = w.findAll('.patrol-cats button')
    expect(chips).toHaveLength(7)
    expect(chips[6].text()).toBe('未分类')
    // 默认选中「未分类」——否则一进来就是「这个分类下还没有照片」
    expect(w.find('.patrol-cats button.on').text()).toBe('未分类')
    expect(w.find('.patrol-card').exists()).toBe(true)
    w.unmount()
  })

  it('切到没有照片的分类给「这个分类下还没有照片」，不是空白', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'c', name: 'c.jpeg', taskName: '基坑边坡巡查' })])
    const w = mount(PatrolPanel)
    await nextTick()

    // 只有「基坑区域」有照片，切到「项目全景」应给空态文案
    await w.findAll('.patrol-cats button')[0].trigger('click')
    expect(w.find('.patrol-card').exists()).toBe(false)
    expect(w.find('.patrol-empty').text()).toBe('这个分类下还没有照片')
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

/**
 * 分类推导规则（`data/config.ts` 的 catOfTask）
 *
 * 这条规则是「展示维度」的唯一来源，改错了整页照片都会归错类 —— 尤其
 * `项目全景` 排在第一位，一旦它的词太泛（曾写过 `全场|场区`），后面五类
 * 的关键词就永远轮不到。
 */
describe('照片分类推导（catOfTask）', () => {
  it('「场区XX」不能被项目全景吃掉：范围词不是画面词', () => {
    expect(catOfTask('向阳村-场区道路巡检')).toBe('layout')
    expect(catOfTask('向阳村-场区材料堆场')).toBe('yard')
    expect(catOfTask('向阳村-场区基坑支护')).toBe('pit')
    expect(catOfTask('全场安全巡查')).toBe('other')
  })

  it('六个分类各自命中一次', () => {
    expect(catOfTask('项目全景巡航')).toBe('pano')
    expect(catOfTask('基坑边坡巡查')).toBe('pit')
    expect(catOfTask('3#楼作业面')).toBe('face')
    expect(catOfTask('塔机专项')).toBe('equip')
    expect(catOfTask('钢筋加工棚')).toBe('yard')
    expect(catOfTask('场区围挡检查')).toBe('layout')
  })

  it('推不出来就归「未分类」，空名字也不抛', () => {
    expect(catOfTask('例行飞行任务')).toBe('other')
    expect(catOfTask('')).toBe('other')
    expect(catOfTask(undefined as unknown as string)).toBe('other')
  })
})
