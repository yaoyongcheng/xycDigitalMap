import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import { clearSession } from '@/api/drone'
import SheetHost from '@/components/overlays/SheetHost.vue'
import { PATROL_CATS, catOfTask } from '@/data/config'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { usePatrolStore, type PatrolPhotoReal } from '@/stores/patrol'
import HomeSheet from '@/views/home/HomeSheet.vue'
import PatrolPanel from '@/views/home/PatrolPanel.vue'

/**
 * 智眸照片墙（现场快照 · 实景核验）
 *
 * 分类按设计稿固定六类（项目全景 / 基坑区域 / 作业面 / 施工装备 / 材料堆场 /
 * 现场场布），3 列 × 2 行不滚动，**没有「未分类」**。
 *
 * 服务端没有分类字段（keehang 媒体接口没有、万联 devDroneMedia 表也没有），
 * 所以归类靠 `data/config.ts` 的**航线名映射**：显式登记表 → 关键词 → 兜底。
 * 三者必有结果，这就是「未分类」消失的原因。
 *
 * 现在钉住的是：
 *   1. 六类恒定显示、3×2 固定位置（0 张也占位）；
 *   2. 默认落在第一个**真有照片**的分类上；
 *   3. 真实航线归到设计稿的对应类，且没有「未分类」按钮；
 *   4. 缩略图有就显示、没有就回退文字，加载失败不留破图；
 *   5. **没有数据就是没有** —— 不许回落演示图。
 */

/** 造一张真实形态的照片（结构与 keehang 媒体一致） */
function photo(n: Partial<PatrolPhotoReal> & { id: string; name: string }): PatrolPhotoReal {
  return {
    id: n.id,
    name: n.name,
    url: n.url ?? `https://oss.keehang.com/iot-media/${n.id}.jpeg`,
    thumbnail: n.thumbnail ?? `https://oss.keehang.com/thumbnail/iot/${n.id}.jpeg`,
    taskName: n.taskName ?? '向阳村-安全巡检',
    taskId: n.taskId === undefined ? 4912 : n.taskId,
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
 * 面板挂载即 `patrol.refresh()`，不 stub 的话会真的去请求 keehang 平台 ——
 * 用例跑得慢、还可能拉到现场真实照片让断言飘。
 */
function offline(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ code: 500, msg: 'offline' }) })),
  )
}

const SIX = ['项目全景', '基坑区域', '作业面', '施工装备', '材料堆场', '现场场布']

describe('智眸面板（真实航拍照片）', () => {
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

  it('六类固定 3×2 显示（0 张也占位），没有「未分类」', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-塔吊定点' })])
    const w = mount(PatrolPanel)
    await nextTick()

    const chips = w.findAll('.patrol-cats button')
    expect(chips.map((b) => b.text())).toEqual(SIX.map((n) => (n === '施工装备' ? `${n}1` : n)))
    expect(w.text()).not.toContain('未分类')
    w.unmount()
  })

  it('默认落在第一个真有照片的分类上（不是写死的项目全景）', async () => {
    const patrol = usePatrolStore()
    // 只有塔吊（施工装备）有照片
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-塔吊定点' })])
    const w = mount(PatrolPanel)
    await nextTick()

    expect(w.find('.patrol-cats button.on').text()).toContain('施工装备')
    expect(w.findAll('.patrol-card')).toHaveLength(1)
    w.unmount()
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
    // 卡片显示的是「所属航线 + 拍摄时间」，不是文件名
    expect(cards[0].text()).toContain('2026-07-15 09:38')
    expect(cards[1].text()).toContain('2026-07-14 10:00')
    expect(w.find('.patrol-hd em').text()).toBe('2 张')
    w.unmount()
  })

  it('卡片标题写真实航线名、徽标写归类（归错类也能看出是哪条航线）', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-配电箱定点拍照' })])
    const w = mount(PatrolPanel)
    await nextTick()

    const card = w.find('.patrol-card')
    expect(card.text()).toContain('向阳村-配电箱定点拍照')
    expect(card.text()).toContain('5.1MB')
    expect(card.findAll('.patrol-tag').map((t) => t.text())).toEqual(['现场场布'])
    expect(card.text()).toContain('无人机')
    w.unmount()
  })

  it('切到没有照片的分类给「这个分类下还没有照片」，不是空白', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'c', name: 'c.jpeg', taskName: '向阳村-土方1' })])
    const w = mount(PatrolPanel)
    await nextTick()

    // 只有「基坑区域」有照片，切到「项目全景」
    await w.findAll('.patrol-cats button')[0].trigger('click')
    expect(w.find('.patrol-card').exists()).toBe(false)
    expect(w.find('.patrol-empty').text()).toBe('这个分类下还没有照片')
    w.unmount()
  })

  it('有缩略图就渲染 img，没有则回退文字占位', async () => {
    const patrol = usePatrolStore()
    patrol.apply([
      photo({ id: 'a', name: 'a.jpeg', thumbnail: 'https://oss.keehang.com/thumbnail/a.jpeg' }),
      photo({ id: 'b', name: 'b.jpeg', thumbnail: '', time: '2026-07-15 09:00:00' }),
    ])
    const w = mount(PatrolPanel)
    await nextTick()

    const cards = w.findAll('.patrol-card')
    const img = cards[0].find('.patrol-thumb img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toContain('/thumbnail/')
    // 缩略图延迟加载，别在首屏就把 440KB × N 拉下来
    expect(img.attributes('loading')).toBe('lazy')

    expect(cards[1].find('.patrol-thumb img').exists()).toBe(false)
    expect(cards[1].find('.patrol-thumb-hint').text()).toContain('点击查看原图')
    w.unmount()
  })

  it('缩略图加载失败时回退文字占位（不留破图）', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'a.jpeg' })])
    const w = mount(PatrolPanel)
    await nextTick()

    await w.find('.patrol-thumb img').trigger('error')
    await nextTick()

    expect(w.find('.patrol-thumb img').exists()).toBe(false)
    expect(w.find('.patrol-thumb-hint').text()).toContain('点击查看原图')
    w.unmount()
  })

  it('没有真实照片时给空态，不回落演示图', async () => {
    const w = mount(PatrolPanel)
    await flushPromises()
    await nextTick()

    expect(w.findAll('.patrol-card')).toHaveLength(0)
    expect(w.find('[data-empty="patrol"]').text()).toContain('offline')
    expect(w.find('[data-empty="patrol"]').find('.data-empty-btn').exists()).toBe(true)
    w.unmount()
  })
})

describe('智眸大图弹层（真实航拍照片）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    offline()
  })

  afterEach(async () => {
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
    // 2026-11-16 起首屏只给缩略图（微信式两层）：原图 4~8MB，点「查看原图」才拉
    const src = w.find('.patrol-view img').attributes('src') ?? ''
    expect(src).toContain('oss.keehang.com')
    expect(src).toContain('/thumbnail/')
    expect(w.find('.photo-btn').text()).toContain('查看原图')
    w.unmount()
  })

  it('点「查看原图」才换成原图（不点就一直在缩略图上）', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'DJI_0001_V.jpeg', size: 7_825_440 })])
    const w = mount(Host)
    await nextTick()
    await w.findAll('.patrol-card')[0].trigger('click')
    await nextTick()

    // 原图下载：返回一份真字节的 blob（带 content-length 才能算进度）
    const bytes = 7_825_440
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes) : null) },
        blob: async () => new Blob([new Uint8Array(8)], { type: 'image/jpeg' }),
      })),
    )

    const btn = w.find('.photo-btn')
    expect(btn.text()).toContain('查看原图 · 7.5MB')
    await btn.trigger('click')
    // 等解码兜底（短则立刻，长则 1.2s 超时）；这里给足余量
    await new Promise((r) => setTimeout(r, 1400))
    await flushPromises()

    const src = w.find('.patrol-view img').attributes('src') ?? ''
    expect(src).not.toContain('/thumbnail/')
    expect(w.find('.photo-btn').text()).toContain('已是原图')
    w.unmount()
  })

  it('2:1 全景图走进球面播放器，普通 4:3 仍是平面大图', async () => {
    const patrol = usePatrolStore()
    patrol.apply([
      photo({ id: 'pano', name: 'pano.jpeg' }),
      photo({ id: 'flat', name: 'flat.jpeg' }),
    ])

    // 尺寸来自列表里缩略图的 naturalWidth/Height；这里直接灌进 store
    patrol.setDims('pano', 8192, 4096)
    patrol.setDims('flat', 4032, 3024)

    const w = mount(Host)
    await nextTick()

    useBottomSheetStore().openPatrol('pano')
    await nextTick()
    await nextTick()
    expect(w.find('.pano-stage').exists()).toBe(true)
    expect(w.find('.patrol-view').exists()).toBe(false)
    // happy-dom 没有 WebGL：必须退回平面并写明，不能白屏
    expect(w.find('.pano-hint').text()).toContain('不支持全景渲染')
    expect(w.find('.pano-host img').exists()).toBe(true)

    useBottomSheetStore().openPatrol('flat')
    await nextTick()
    await nextTick()
    expect(w.find('.pano-stage').exists()).toBe(false)
    expect(w.find('.patrol-view').exists()).toBe(true)
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

  it('切到智眸会挂载照片墙（面板容器随之重挂载）', async () => {
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
 * 航线 → 六类映射。
 *
 * 这张表是「照片归到哪一类」的唯一来源。现场 15 条航线（2026-11-16 `/task/list`
 * 实测）必须每条都有归属 —— 只要有一条掉到「没有分类」，页面就会重新长出
 * 「未分类」这个按钮，而用户明确要求它不存在。
 */
describe('航线分类映射（catOfTask）', () => {
  it('现场 15 条真实航线全部落在设计稿六类里', () => {
    const real = [
      '测试',
      '测试全景',
      '向阳村-正射',
      '向阳村-三维（飞前请检查）',
      '向阳村-全景',
      '向阳村-安全巡检',
      '向阳村-环绕视频',
      '向阳村-全局定点拍照',
      '向阳村-塔吊定点',
      '向阳村-三维（新）',
      '向阳村-分区定点拍照',
      '向阳村-土方1',
      '向阳村-三维（加密）',
      '向阳村-道路垃圾和杂草生长',
      '向阳村-配电箱定点拍照',
    ]
    const ids = PATROL_CATS.map((c) => c.id)
    for (const name of real) expect(ids).toContain(catOfTask(name))
    // 分类 id 互不重复且正好六类
    expect(new Set(ids).size).toBe(6)
  })

  it('俯视全场类（全景 / 正射 / 三维）归项目全景', () => {
    expect(catOfTask('向阳村-全景')).toBe('pano')
    expect(catOfTask('向阳村-正射')).toBe('pano')
    expect(catOfTask('向阳村-三维（加密）')).toBe('pano')
    expect(catOfTask('测试全景')).toBe('pano')
  })

  it('土方归基坑、塔吊归施工装备、定点拍照归现场场布', () => {
    expect(catOfTask('向阳村-土方1')).toBe('pit')
    expect(catOfTask('向阳村-塔吊定点')).toBe('equip')
    expect(catOfTask('向阳村-配电箱定点拍照')).toBe('layout')
    expect(catOfTask('向阳村-道路垃圾和杂草生长')).toBe('layout')
  })

  it('没登记过的新航线也有归属（关键词 → 兜底），不会出现「没有分类」', () => {
    expect(catOfTask('向阳村-基坑支护加密')).toBe('pit')
    expect(catOfTask('3#楼作业面')).toBe('face')
    expect(catOfTask('钢筋加工棚')).toBe('yard')
    // 完全陌生的名字 → 兜底「现场场布」，仍是六类之一
    expect(catOfTask('例行飞行任务')).toBe('layout')
    expect(catOfTask('')).toBe('layout')
    expect(catOfTask(undefined as unknown as string)).toBe('layout')
  })
})
