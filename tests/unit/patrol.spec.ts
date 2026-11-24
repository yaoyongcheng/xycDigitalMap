import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import { clearSession } from '@/api/drone'
import SheetHost from '@/components/overlays/SheetHost.vue'
import { fetchFacilityGallery, fetchSafetyGallery, fetchSpotGallery, fetchYardGallery } from '@/api/drone'
import { GATE_SHOTS } from '@/data/cams'
import { PATROL_CATS, catOfTask } from '@/data/config'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { PANO_SHEET_ID, usePatrolStore, type PatrolPhotoReal } from '@/stores/patrol'
import { clearShots, saveShot } from '@/utils/shotArchive'
import HomeSheet from '@/views/home/HomeSheet.vue'
import PatrolPanel from '@/views/home/PatrolPanel.vue'

/**
 * 智眸照片墙（现场快照 · 实景核验）
 *
 * 分类固定六类（VR 360环视 / 全景航拍 / 设备设施 / 材料堆场 / 出入口管控 /
 * 安全巡查，2026-11-18 改的按钮文案），3 列 × 2 行不滚动，**没有「未分类」**。
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
    // 默认给一条**归到「出入口管控」（yard）**的航线：2026-11-20 起六格各有
    // 专用链，照片墙不再上屏，所以「卡片 / 弹层通用渲染」这类用例改成把夹具
    // 灌进 `gate`（`patrol.apply(list, 'gate')`）—— 那一格就是 `PatrolPhotoReal[]`
    // 直接铺在网格里，卡片渲染、缩略图兜底、点开大图的路径与其它格完全一致。
    taskName: n.taskName ?? '向阳村-材料堆场',
    taskId: n.taskId === undefined ? 4912 : n.taskId,
    jobId: n.jobId ?? 147744,
    time: n.time ?? '2026-07-15 09:38:39',
    size: n.size ?? 5_378_048,
    mediaType: n.mediaType ?? 'image/jpeg',
    // 来源标记：`snap: true` = 视频监控抓拍（卡片写「抓拍 / 视频监控」）
    ...(n.snap ? { snap: true } : {}),
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

const SIX = ['VR 360环视', '全景航拍', '设备设施', '材料堆场', '出入口管控', '安全巡查']

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
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-材料堆场' })], 'gate')
    const w = mount(PatrolPanel)
    await nextTick()

    const chips = w.findAll('.patrol-cats button')
    expect(chips.map((b) => b.text())).toEqual(SIX.map((n) => (n === '出入口管控' ? `${n}1` : n)))
    expect(w.text()).not.toContain('未分类')
    w.unmount()
  })

  it('默认落在第一个真有照片的分类上（不是写死的 VR 360环视）', async () => {
    const patrol = usePatrolStore()
    // 只有「出入口管控」（5 个门禁点位）有照片
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-材料堆场' })], 'gate')
    const w = mount(PatrolPanel)
    await nextTick()

    expect(w.find('.patrol-cats button.on').text()).toContain('出入口管控')
    expect(w.findAll('.patrol-card')).toHaveLength(1)
    w.unmount()
  })

  /**
   * 面板级进入 vs 子页切换（2026-11-24）
   *
   * 选中状态存在 store（`pickedCat`）里：首页切到智巡 / 智控再切回来，
   * 面板是卸载重建的，但选中的子页必须还是走之前那一格。
   */
  it('切走再回来仍停在用户上次选的子页', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-材料堆场' })], 'gate')

    const w1 = mount(PatrolPanel)
    await nextTick()
    expect(w1.find('.patrol-cats button.on').text()).toContain('出入口管控')

    // 用户自己点了「材料堆场」
    patrol.pickCat('equip')
    await nextTick()
    expect(w1.find('.patrol-cats button.on').text()).toContain('材料堆场')
    w1.unmount()

    // 卸载再挂载 = 首页切走又切回来
    const w2 = mount(PatrolPanel)
    await nextTick()
    expect(w2.find('.patrol-cats button.on').text()).toContain('材料堆场')
    w2.unmount()
  })

  it('从别的标签切回：只取上次那一格，不连带别的格', async () => {
    const patrol = usePatrolStore()
    patrol.pickCat('equip')
    const f = vi.fn(async (_url: string) => ({ ok: false, status: 500, json: async () => ({}) }))
    vi.stubGlobal('fetch', f)

    const w = mount(PatrolPanel)
    await flushPromises()

    // 「材料堆场」那条链只查执行记录 + 媒体：不拍门禁抓拍、不拉全景成果，
    // 也不扫「全景航拍 / 设备设施 / 安全巡查」那条条链
    const urls = f.mock.calls.map((c) => String(c[0])).join('\n')
    expect(urls).not.toContain('/snapshots/history')
    expect(urls).not.toContain('/dashboard/recreate/')
    expect(w.find('.patrol-cats button.on').text()).toContain('材料堆场')
    w.unmount()
  })

  it('「材料堆场」不再按航线名收照片：塔吊定点的照片不进这一格', async () => {
    const patrol = usePatrolStore()
    // 塔吊定点仍归类到 equip（`catOfTask` 没改），但这一格现在只认分区定点那 3 张
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-塔吊定点' })])
    const w = mount(PatrolPanel)
    await nextTick()

    const chips = w.findAll('.patrol-cats button')
    expect(chips[3].text()).toBe('材料堆场')
    expect(chips[3].text()).not.toContain('1')
    w.unmount()
  })

  it('照片墙按拍摄时间倒序（`list` 最新在前）', () => {
    const patrol = usePatrolStore()
    patrol.apply([
      photo({ id: 'a', name: '旧图.jpeg', time: '2026-07-14 10:00:00' }),
      photo({ id: 'b', name: '新图.jpeg', time: '2026-07-15 09:38:39' }),
    ])

    // 六格各自的顺序有各自规则（采集序号 / 来源表），只有照片墙这份原始列表按时间倒序
    expect(patrol.list.map((p) => p.time)).toEqual(['2026-07-15 09:38:39', '2026-07-14 10:00:00'])
  })

  it('卡片标题写真实航线名、徽标写归类（归错类也能看出是哪条航线）', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'a.jpeg', taskName: '向阳村-钢筋加工棚' })], 'gate')
    const w = mount(PatrolPanel)
    await nextTick()

    const card = w.find('.patrol-card')
    expect(card.text()).toContain('向阳村-钢筋加工棚')
    // 卡片显示的是「所属航线 + 拍摄时间」，不是文件名
    expect(card.text()).toContain('2026-07-15 09:38')
    // 2026-11-24：列表卡片不再显示照片体积（KB/MB/GB 一律不出现）
    expect(card.text()).not.toContain('MB')
    expect(card.text()).not.toContain('KB')
    expect(card.findAll('.patrol-tag').map((t) => t.text())).toEqual(['出入口管控'])
    expect(card.text()).toContain('无人机')
    w.unmount()
  })

  it('切到没有照片的分类给「这个分类下还没有照片」，不是空白', async () => {
    // 2026-11-24 子页改成懒加载：切过去会**真的取这一格**，所以先把「VR 360环视」
    // 桩成「取回来了，但没有全景」——它才是这一格自己的结论
    vi.stubGlobal('fetch', panoFetch({ recreate: [] }))
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'c', name: 'c.jpeg', taskName: '向阳村-土方1' })])
    const w = mount(PatrolPanel)
    await flushPromises()

    await w.findAll('.patrol-cats button')[0].trigger('click')
    await flushPromises()
    expect(w.find('.patrol-card').exists()).toBe(false)
    expect(w.find('.patrol-empty').text()).toBe('这个分类下还没有照片')
    w.unmount()
  })

  it('等待接口响应时写「图片刷新」（骨架同首屏），响应回来落回原文案', async () => {
    const patrol = usePatrolStore()
    // 别的分类已有照片 → 不是「整页首屏」那种全空骨架
    patrol.apply([photo({ id: 'a', name: 'a.jpeg' })])
    // 「安全巡查」这条链还在等响应
    patrol.safetyState = 'loading'
    const w = mount(PatrolPanel)
    await nextTick()

    await w.findAll('.patrol-cats button')[5].trigger('click')
    await nextTick()

    // 说明文字是「图片刷新」，不是「这个分类下还没有照片」
    expect(w.find('[data-state="patrol-refreshing"]').exists()).toBe(true)
    expect(w.find('.patrol-refreshing-tip').text()).toBe('图片刷新')
    expect(w.find('.patrol-empty').exists()).toBe(false)
    // 视觉沿用智眸首次加载那一套：4 张同构骨架卡
    expect(w.findAll('.patrol-card.is-skel')).toHaveLength(4)

    // 响应回来、这班确实没照片 → 恢复原有说明文案
    patrol.safetyState = 'ok'
    await nextTick()
    expect(w.find('[data-state="patrol-refreshing"]').exists()).toBe(false)
    expect(w.find('.patrol-refreshing-tip').exists()).toBe(false)
    expect(w.find('.patrol-empty').text()).toBe('这个分类下还没有照片')
    w.unmount()
  })

  it('已有内容时刷新不铺骨架：旧图继续显示，不闪「图片刷新」', async () => {
    const patrol = usePatrolStore()
    // `apply` = 刚刚同步完（state=ok，挂载时的 refresh() 会直接复用，不再重拉）
    patrol.apply([photo({ id: 'a', name: 'a.jpeg' })])
    // 「全景航拍」这条链重新拉（点重试），旧 9 张还在手里
    patrol.spot = [photo({ id: 's1', name: 's1.jpeg', taskName: '向阳村-全局定点拍照' })]
    patrol.spotState = 'loading'
    const w = mount(PatrolPanel)
    await nextTick()

    expect(w.find('.patrol-cats button.on').text()).toContain('全景航拍')
    expect(w.find('[data-state="patrol-refreshing"]').exists()).toBe(false)
    expect(w.find('.patrol-refreshing-tip').exists()).toBe(false)
    expect(w.findAll('.patrol-card')).toHaveLength(1)
    w.unmount()
  })

  it('有缩略图就渲染 img，没有则回退文字占位', async () => {
    const patrol = usePatrolStore()
    patrol.apply(
      [
        photo({ id: 'a', name: 'a.jpeg', thumbnail: 'https://oss.keehang.com/thumbnail/a.jpeg' }),
        photo({ id: 'b', name: 'b.jpeg', thumbnail: '', time: '2026-07-15 09:00:00' }),
      ],
      'gate',
    )
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
    patrol.apply([photo({ id: 'a', name: 'a.jpeg' })], 'gate')
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
    // 六格都取不到（offline）：写「暂时取不到」并给重试，不是「还没有照片」
    expect(w.find('.patrol-empty').text()).toContain('暂时取不到')
    expect(w.find('.patrol-empty').find('.data-empty-btn').exists()).toBe(true)
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

  it('点卡片开弹层：元信息用服务端字段，首帧铺缩略图并自动开始拉原图', async () => {
    const patrol = usePatrolStore()
    patrol.apply(
      [
        photo({
          id: 'a',
          name: 'DJI_20260715093839_0001_V.jpeg',
          taskName: '向阳村-材料堆场',
          time: '2026-07-15 09:38:39',
        }),
      ],
      'gate',
    )
    const w = mount(Host)
    await nextTick()

    // 原图请求挂着不回：只为钉住「打开就开始拉」这一帧，不等它落地
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))

    await w.findAll('.patrol-card')[0].trigger('click')
    await nextTick()

    const meta = w.find('.patrol-meta').text()
    expect(meta).toContain('向阳村-材料堆场')
    expect(meta).toContain('无人机')
    expect(meta).toContain('2026-07-15 09:38')
    // 首帧仍是列表那张缩略图（4~8MB 的原图还在路上），不白屏
    const src = w.find('.patrol-view img').attributes('src') ?? ''
    expect(src).toContain('oss.keehang.com')
    expect(src).toContain('/thumbnail/')
    // 2026-11-23：右上角「查看原图」整颗下线，工具条只剩「全屏」
    expect(w.findAll('.patrol-view .pano-tool').map((b) => b.text())).toEqual(['全屏'])
    // 打开即开始拉原图：画布底边有真实字节进度，角标写「原图…」
    expect(w.find('.hd-progress.is-in-stage').exists()).toBe(true)
    expect(w.find('.patrol-view-tag').text()).toContain('原图')
    w.unmount()
  })

  it('原图拉完自动换源：不用点任何按钮，进度条收掉、角标写「原图」', async () => {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'DJI_0001_V.jpeg', size: 7_825_440 })], 'gate')
    const w = mount(Host)
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

    await w.findAll('.patrol-card')[0].trigger('click')
    // 2026-11-24：详情不再写体积（原来这里有一行「大小 7.5MB」）
    expect(w.find('.patrol-meta').text()).not.toContain('MB')
    expect(w.find('.patrol-meta').text()).not.toContain('大小')
    await nextTick()

    // 等它落地：happy-dom 不解码图片，`preload` 走 1.2s 兜底 —— 轮询到「原图」为止
    for (let i = 0; i < 40; i += 1) {
      if (w.find('.patrol-view-tag').text() === '原图') break
      await new Promise((r) => setTimeout(r, 100))
    }
    await flushPromises()

    const src = w.find('.patrol-view img').attributes('src') ?? ''
    expect(src).not.toContain('/thumbnail/')
    expect(w.find('.patrol-view-tag').text()).toBe('原图')
    expect(w.find('.hd-progress').exists()).toBe(false)
    w.unmount()
  })

  it('2:1 全景图走进球面播放器，普通 4:3 仍是平面大图', async () => {
    const patrol = usePatrolStore()
    patrol.apply(
      [photo({ id: 'pano', name: 'pano.jpeg' }), photo({ id: 'flat', name: 'flat.jpeg' })],
      'gate',
    )

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
    patrol.apply([photo({ id: 'a', name: 'a.jpeg' })], 'gate')
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
      '智巡风险巡查',
      '智眸现场快照',
      '智控装备管控',
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

  it('俯视全场类（全景 / 正射 / 三维）归 pano（VR 360环视）', () => {
    expect(catOfTask('向阳村-全景')).toBe('pano')
    expect(catOfTask('向阳村-正射')).toBe('pano')
    expect(catOfTask('向阳村-三维（加密）')).toBe('pano')
    expect(catOfTask('测试全景')).toBe('pano')
  })

  it('土方归 pit、塔吊归 equip、定点拍照归 layout（显示名已换，id 未动）', () => {
    expect(catOfTask('向阳村-土方1')).toBe('pit')
    expect(catOfTask('向阳村-塔吊定点')).toBe('equip')
    expect(catOfTask('向阳村-配电箱定点拍照')).toBe('layout')
    expect(catOfTask('向阳村-道路垃圾和杂草生长')).toBe('layout')
  })

  it('没登记过的新航线也有归属（关键词 → 兜底），不会出现「没有分类」', () => {
    expect(catOfTask('向阳村-基坑支护加密')).toBe('pit')
    expect(catOfTask('3#楼作业面')).toBe('face')
    expect(catOfTask('钢筋加工棚')).toBe('yard')
    // 完全陌生的名字 → 兜底 layout（显示名「安全巡查」），仍是六类之一
    expect(catOfTask('例行飞行任务')).toBe('layout')
    expect(catOfTask('')).toBe('layout')
    expect(catOfTask(undefined as unknown as string)).toBe('layout')
  })
})

/* ================================================================ *
 * 项目全景（2026-11-16：吃平台拼好的重建成果，不自拼）                *
 * ================================================================ */

/** keehang 的响应包：`{code,msg,data}`，code === 200 才算成功 */
function khOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

/**
 * 抓拍图片的桩：`fetchCamShotImage` 要的是**直出图片字节**（不是 JSON）。
 *
 * 它会校验 `ok` / `content-type` 以 `image/` 开头 / `blob().size`，
 * 三者缺一就被判成「没有返回图片」，所以桩必须把这三样都给出来。
 */
function imgOk(bytes = 200_000): Response {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    blob: async () => blob,
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response
}

/**
 * 历史列表的桩：一条（`mark` 固定、`fileSize` 跟着 `bytes` 走）。
 *
 * 智眸这几格只查 `/snapshots/history`（旧「最近一帧」接口已下线）。
 * 列表是 JSON 信封，不能拿 `imgOk` 顶 —— 那样会解析失败、一路掉进缓存兜底，
 * 断言就测不到真实链路了。
 */
function histOk(bytes = 200_000, mark = '20261119120000'): Response {
  const at = new Date(2026, 10, 19, 12, 0, 0)
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => ({
      code: 200,
      message: 'success',
      data: {
        items: [
          {
            capturedAt: '2026-11-19T12:00:00+08:00',
            fileSize: bytes,
            imageUrl: `/api/video/snapshots?channelId=x&mark=${mark}&pid=P000000076`,
            latest: true,
            mark,
            timestamp: at.getTime(),
          },
        ],
        page: 1,
        pageSize: 1,
        total: 1,
        rangeStart: '',
        rangeEnd: '',
      },
    }),
    text: async () => '',
    blob: async () => new Blob([]),
  } as unknown as Response
}

/** 抓拍系列路由：历史列表走 JSON，图片走字节 */
function shotOk(url: string, bytes = 200_000): Response {
  return String(url).includes('/snapshots/history') ? histOk(bytes) : imgOk(bytes)
}

/**
 * 一条全景成果。
 *
 * 现场实测（2026-11-15，record 181616）：一次飞行产出 3 个成果，名字按
 * `_0 / _1 / _2` 结尾；`thumbnail` 是 3162×1581 的等距圆柱预览图（OSS 缩略图桶），
 * `download` 是 10000×5000 的 `origin.jpg`（moss 域名），`url` 指向立方体切片
 * 清单 `pano.json`（V2 的 `#/pano` 用它，我们不用）。
 */
function achievement(id: number, secret: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    secret,
    materialId: `m-${id}`,
    name,
    mediaType: 2,
    size: 13_688_984,
    recreateType: 'PANO',
    url: `https://oss.keehang.com:19090/models/${id}/pano.json`,
    thumbnail: `https://oss.keehang.com:19090/thumbnail/model/${id}/thumbnail.jpg`,
    download: `https://moss.keehang.com:9443/models/${id}/origin.jpg`,
    ...over,
  }
}

/** 一条全景重建任务（`getProjectRecreateInfo` 的一行，成果内嵌在 DTO 列表里） */
function panoTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '220fe3eb-06ac-43b9-98a6-94b0b44d00d2',
    recordId: 181616,
    projectId: 193640872670213,
    projectName: '中建三局-向阳村项目',
    taskName: '向阳村-全景_202611151130181616',
    lineName: '向阳村-全景',
    taskType: 2,
    progress: 100,
    status: 2,
    createTime: '2026-11-15 12:10:54',
    endTime: '2026-11-15 12:18:29',
    resultRecordDTOList: [
      achievement(103180, 'b3uT22dX', '向阳村-全景_202611151130181616_0.jpg'),
      achievement(103181, 'LsM8Eppu', '向阳村-全景_202611151130181616_1.jpg'),
      achievement(103182, 'QjPlKQbX', '向阳村-全景_202611151130181616_2.jpg'),
    ],
    ...over,
  }
}

/** 一条正射任务（同一个列表里混着的干扰项） */
function orthoTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordId: 181819,
    taskName: '向阳村-正射_202611160800181819',
    lineName: '向阳村-正射',
    taskType: 3,
    status: 2,
    createTime: '2026-11-16 09:00:28',
    resultRecordDTOList: [
      achievement(103342, 'NCQnEO4d', '向阳村-正射_202611160800181819_W.tif', { recreateType: 'ORTHO', mediaType: 3 }),
    ],
    ...over,
  }
}

/** 一次普通航拍飞行（照片墙的正经来源） */
function flightRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 147744,
    taskId: 4912,
    taskName: '向阳村-安全巡检',
    start: '2026-11-15T09:00:00',
    end: '2026-11-15T09:20:00',
    ...over,
  }
}

/**
 * 按 URL 分发的桩：CAS 两步 + 执行记录 + 媒体 + 重建任务列表。
 *
 * `recreate` 可以换成 Array 或 Response，用来演「接口挂了 / 一条全景都没有」。
 */
function panoFetch(opts: { recreate?: unknown; records?: unknown[] } = {}): ReturnType<typeof vi.fn> {
  const recreate = opts.recreate ?? [orthoTask(), panoTask()]
  const records = opts.records ?? [flightRecord()]
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/cas/auth/login')) {
      return khOk({ code: 200, data: { tgt: 'TGT', st: 'ST', userDetail: { uid: 42 } } })
    }
    if (u.includes('/cas/auth/validate')) {
      return khOk({ code: 200, data: { uid: '42', token: 'TOKEN-1', timestamp: Date.now() } })
    }
    if (u.includes('/dashboard/recreate/getProjectRecreateInfo')) {
      if (!Array.isArray(recreate)) return recreate as Response
      return khOk({ code: 200, data: { total: recreate.length, page: 1, size: 30, list: recreate } })
    }
    if (u.includes('/api/open/v1/task-record/page')) return khOk({ code: 200, data: records })
    if (u.includes('/media/task/job/')) {
      return khOk({
        code: 200,
        data: [
          {
            name: 'DJI_20261115090000_0001_V.jpeg',
            url: 'https://oss.keehang.com:19090/iot-media/a.jpeg',
            thumbnail: 'https://oss.keehang.com:19090/thumbnail/iot/a.jpeg',
            mediaType: 'image/jpeg',
            size: 4_411_392,
            lastModified: '2026-11-15 09:12:00',
          },
        ],
      })
    }
    return { ok: false, status: 404, json: async () => ({ code: 404 }) } as unknown as Response
  })
}

describe('项目全景（平台拼好的重建成果）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  it('拿的是重建成果（等距圆柱图），不是那 26 张原片', async () => {
    const f = panoFetch()
    vi.stubGlobal('fetch', f)
    const patrol = usePatrolStore()
    await patrol.load()

    expect(patrol.pano).not.toBeNull()
    expect(patrol.pano?.taskName).toBe('向阳村-全景_202611151130181616')
    // 预览 = OSS 缩略图桶里的等距圆柱图；高清 = moss 上的 origin.jpg
    expect(patrol.pano?.preview).toContain('/thumbnail/model/103180/thumbnail.jpg')
    expect(patrol.pano?.full).toContain('/models/103180/origin.jpg')
    expect(patrol.pano?.size).toBe(13_688_984)
    expect(patrol.panoState).toBe('ok')
  })

  it('全景航线的原片不进照片墙，也**不为它发媒体请求**', async () => {
    const f = panoFetch({
      records: [flightRecord({ id: 181616, taskId: 4911, taskName: '向阳村-全景', start: '2026-11-15T11:30:00' })],
    })
    vi.stubGlobal('fetch', f)
    const patrol = usePatrolStore()
    await patrol.load()

    expect(patrol.photos).toHaveLength(0)
    const media = f.mock.calls.filter((c) => String(c[0]).includes('/media/task/job/'))
    expect(media).toHaveLength(0)
  })

  it('只取最新一条，且必须是已完成（跳过更新的失败任务）', async () => {
    vi.stubGlobal(
      'fetch',
      panoFetch({
        recreate: [
          panoTask({ recordId: 181999, status: 1, createTime: '2026-11-16 10:00:00' }),
          orthoTask(),
          panoTask(),
          panoTask({ recordId: 181421, createTime: '2026-11-14 12:02:02' }),
        ],
      }),
    )
    const patrol = usePatrolStore()
    await patrol.load()
    expect(patrol.pano?.recordId).toBe(181616)
  })

  it('一次飞 3 个成果也只取第一个（用户要求只留一张）', async () => {
    vi.stubGlobal('fetch', panoFetch())
    const patrol = usePatrolStore()
    await patrol.load()

    expect(patrol.pano?.id).toBe(103180)
    expect(patrol.pano?.name).toContain('_0.jpg')
  })

  it('**按项目筛**：别的工地更新的全景不能顶进来（光谷元著 13:29 > 向阳村 12:10）', async () => {
    const gg = panoTask({
      recordId: 181656,
      projectId: 231070463906821,
      projectName: '中建三局-光谷元著项目',
      taskName: '光谷元著-全景_202611151300181656',
      createTime: '2026-11-15 13:29:17',
      resultRecordDTOList: [
        achievement(103195, 'gh000000', '光谷元著-全景_202611151300181656_0.jpg', { size: 14_519_091 }),
      ],
    })
    vi.stubGlobal('fetch', panoFetch({ recreate: [gg, panoTask()] }))
    const patrol = usePatrolStore()
    await patrol.load()

    // 更晚的那张属于另一个项目，必须被筛掉
    expect(patrol.pano?.recordId).toBe(181616)
    expect(patrol.pano?.projectId).toBe(193640872670213)
    expect(patrol.pano?.projectName).toBe('中建三局-向阳村项目')
  })

  it('请求里带 pid（V2 的 getProjectRecreateInfo 也是 {pid, pageNo} 一起传）', async () => {
    const f = panoFetch()
    vi.stubGlobal('fetch', f)
    const patrol = usePatrolStore()
    await patrol.load()

    const call = f.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/dashboard/recreate/getProjectRecreateInfo'))
    expect(call).toContain('pid=193640872670213')
    expect(call).toContain('pageNo=1')
  })

  it('列表里全是正射时，全景就是没有（null，不编一张）', async () => {
    vi.stubGlobal('fetch', panoFetch({ recreate: [orthoTask()] }))
    const patrol = usePatrolStore()
    await patrol.load()
    expect(patrol.pano).toBeNull()
    expect(patrol.panoState).toBe('ok')
  })

  it('重建接口挂了不影响照片墙（panoState=error，照片照常）', async () => {
    vi.stubGlobal(
      'fetch',
      panoFetch({ recreate: { ok: false, status: 500, json: async () => ({ code: 500 }), body: null } as unknown }),
    )
    const patrol = usePatrolStore()
    await patrol.load()

    expect(patrol.photos.length).toBeGreaterThan(0)
    expect(patrol.state).toBe('ok')
    expect(patrol.pano).toBeNull()
    expect(patrol.panoState).toBe('error')
  })

  it('签名过期后能重取（force 换一组新直链）', async () => {
    vi.stubGlobal('fetch', panoFetch())
    const patrol = usePatrolStore()
    await patrol.load()
    const first = patrol.pano?.full

    // 服务端换了一次签名：第二次拿到的是新 URL
    vi.stubGlobal(
      'fetch',
      panoFetch({
        recreate: [
          panoTask({
            resultRecordDTOList: [
              achievement(103180, 'b3uT22dX', '向阳村-全景_202611151130181616_0.jpg', {
                download: 'https://moss.keehang.com:9443/models/103180/origin.jpg?X-Amz-Signature=NEW',
              }),
            ],
          }),
        ],
      }),
    )
    await patrol.loadPano(true)
    expect(first).toContain('/models/103180/origin.jpg')
    expect(patrol.pano?.full).toContain('X-Amz-Signature=NEW')
  })

  it('重取期间不翻 loading、旧图继续在屏上（打开就重取，不能每次都闪骨架）', async () => {
    vi.stubGlobal('fetch', panoFetch())
    const patrol = usePatrolStore()
    await patrol.load()
    expect(patrol.panoState).toBe('ok')
    const first = patrol.pano

    // 把重取卡在半路，观察这中间的状态
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    const inner = panoFetch()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        await gate
        return (inner as unknown as (u: string) => Promise<unknown>)(url)
      }),
    )
    const task = patrol.loadPano(true)
    await Promise.resolve()

    // 关键：没有翻成 loading，也没有把旧图清掉
    expect(patrol.panoState).toBe('ok')
    expect(patrol.pano).toBe(first)

    release!()
    await task
    expect(patrol.panoState).toBe('ok')
  })

  it('静默重取失败时保留旧图（不把已经能看的图撤掉）', async () => {
    vi.stubGlobal('fetch', panoFetch())
    const patrol = usePatrolStore()
    await patrol.load()
    const first = patrol.pano

    vi.stubGlobal(
      'fetch',
      panoFetch({ recreate: { ok: false, status: 500, json: async () => ({ code: 500 }), body: null } as unknown }),
    )
    await patrol.loadPano(true)

    expect(patrol.pano).toBe(first)
    expect(patrol.panoState).toBe('ok')
  })
})

describe('智眸面板 · VR 360环视卡片', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    offline()
  })

  afterEach(async () => {
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  /** 灌一张现成的全景（绕过网络，只测渲染与点击） */
  function withPano(): void {
    const patrol = usePatrolStore()
    patrol.apply([])
    patrol.pano = {
      id: 103180,
      secret: 'b3uT22dX',
      recordId: 181616,
      projectId: 193640872670213,
      projectName: '中建三局-向阳村项目',
      taskName: '向阳村-全景_202611151130181616',
      name: '向阳村-全景_202611151130181616_0.jpg',
      time: '2026-11-15 12:18:29',
      preview: 'https://oss.keehang.com:19090/thumbnail/model/103180/thumbnail.jpg',
      full: 'https://moss.keehang.com:9443/models/103180/origin.jpg',
      size: 13_688_984,
    }
  }

  it('「VR 360环视」里是**一张**全景卡片（不是一堆俯视照片）', async () => {
    withPano()
    const w = mount(PatrolPanel)
    await nextTick()

    expect(w.find('.patrol-card.is-pano').exists()).toBe(true)
    expect(w.findAll('.patrol-card')).toHaveLength(1)
    const card = w.find('.patrol-card.is-pano').text()
    expect(card).toContain('向阳村-全景')
    expect(card).toContain('可环视')
    // 2026-11-24：全景卡片右下角那颗体积角标已删（列表不显示照片大小）
    expect(card).not.toContain('MB')
    w.unmount()
  })

  it('点卡片用保留 id 打开弹层（全景来自成果，没有照片 id 可用）', async () => {
    withPano()
    const sheet = useBottomSheetStore()
    const w = mount(Host)
    await nextTick()

    await w.find('.patrol-card.is-pano').trigger('click')
    expect(sheet.kind).toBe('patrol')
    expect(sheet.id).toBe(PANO_SHEET_ID)
    w.unmount()
  })

  it('每次打开全景弹层都重新取一次（用户要求「每次看都是最新那张」）', async () => {
    withPano()
    let recreateCalls = 0
    const inner = panoFetch()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/dashboard/recreate/getProjectRecreateInfo')) recreateCalls += 1
        return (inner as unknown as (u: string) => Promise<unknown>)(url)
      }),
    )
    const w = mount(Host)
    await nextTick()
    expect(recreateCalls).toBe(0)

    await w.find('.patrol-card.is-pano').trigger('click')
    await flushPromises()

    // 弹层是单实例，切换只改 props.id；「打开时取一次」必须挂在 id 变化上
    expect(recreateCalls).toBe(1)
    w.unmount()
  })

  it('只有全景、没有普通照片时不是空态（分类条照旧在）', async () => {
    withPano()
    const w = mount(PatrolPanel)
    await nextTick()

    expect(w.find('.patrol-cats').exists()).toBe(true)
    expect(w.find('.data-empty').exists()).toBe(false)
    expect(w.find('.patrol-cats button').text()).toContain('VR 360环视')
    w.unmount()
  })
})

/**
 * 全景弹层的工具条
 *
 * 2026-11-16：看高清从图片下方挪到画布上，与「复位」并排，下载改成「横屏」；
 * 2026-11-23：**「看高清」整颗下线** —— 打开全景就自动拉高清贴图（带真实进度），
 * 工具条只剩 复位 / 全屏（「横屏」已改名「全屏」）。这里钉住：
 *   1. 工具条在画布上，只剩 复位 / 全屏，看高清与下载都下线；
 *   2. 打开就自动拉高清：「先带进度拉流、下完再换源」，不是把 13MB 直接塞给 img；
 *   3. 点全屏能把画布搬到 body 铺满视口，再点回得去。
 */
describe('智眸大图弹层 · 全景工具条（复位 / 全屏）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    offline()
  })

  afterEach(async () => {
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  function withPano(): void {
    const patrol = usePatrolStore()
    patrol.apply([])
    patrol.pano = {
      id: 103180,
      secret: 'b3uT22dX',
      recordId: 181616,
      projectId: 193640872670213,
      projectName: '中建三局-向阳村项目',
      taskName: '向阳村-全景_202611151130181616',
      name: '向阳村-全景_202611151130181616_0.jpg',
      time: '2026-11-15 12:18:29',
      preview: 'https://oss.keehang.com:19090/thumbnail/model/103180/thumbnail.jpg',
      full: 'https://moss.keehang.com:9443/models/103180/origin.jpg',
      size: 13_688_984,
    }
  }

  /** 打开全景弹层（走卡片点击，与真实入口一致；挂到 body 上，横屏那条要查 document） */
  async function openPano(): Promise<ReturnType<typeof mount>> {
    const w = mount(Host, { attachTo: document.body })
    await nextTick()
    await w.find('.patrol-card.is-pano').trigger('click')
    await nextTick()
    return w
  }

  it('工具条在画布上：只剩复位与全屏，看高清 / 下载都已下线', async () => {
    withPano()
    const w = await openPano()

    const tools = w.find('.pano-tools')
    expect(tools.exists()).toBe(true)
    const labels = tools.findAll('.pano-tool').map((b) => b.text())
    // 无 WebGL（happy-dom）时「复位」按设计隐藏，所以这里只钉「全屏仍在、看高清已无」
    expect(labels).toContain('全屏')
    expect(labels).not.toContain('复位')
    // 2026-11-23：高清改为打开即自动拉，那颗按钮整颗下线
    expect(tools.text()).not.toContain('看高清')
    // 原来的「下载」整颗下线（全景要存相册走长按图片 / 系统菜单）
    expect(w.text()).not.toContain('下载')
    // 2026-11-24：整个弹层（含下方 meta）都不再出现体积
    expect(w.text()).not.toContain('13.1MB')
    expect(w.text()).not.toContain('大小')
    w.unmount()
  })

  it('打开全景即自动拉高清：底边有真进度条，下完换源（不用点按钮）', async () => {
    withPano()
    const bytes = 13_688_984
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!String(url).includes('origin.jpg')) {
          return { ok: false, status: 500, json: async () => ({ code: 500 }) }
        }
        await gate
        return {
          ok: true,
          status: 200,
          headers: {
            get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes) : null),
          },
          blob: async () => new Blob([new Uint8Array(8)], { type: 'image/jpeg' }),
        }
      }),
    )

    const w = mount(Host, { attachTo: document.body })
    await nextTick()
    await w.find('.patrol-card.is-pano').trigger('click')
    // 等「重新取一次最新成果」落地 —— 高清是紧随其后自动开始的
    await flushPromises()

    expect(w.find('.pano-stage img').attributes('src')).toContain('thumbnail')
    // 下载中：画布底边有真进度条（宽度来自已收字节，不是估算），角标写「高清…」
    expect(w.find('.hd-progress.is-in-stage').exists()).toBe(true)
    expect(w.find('.patrol-view-tag').text()).toContain('高清')

    release!()
    // 等解码兜底（happy-dom 不解码图片，走 preload 的 1.2s 超时）
    for (let i = 0; i < 40; i += 1) {
      if (w.find('.patrol-view-tag').text() === '全景 · 高清') break
      await new Promise((r) => setTimeout(r, 100))
    }
    await flushPromises()

    expect(w.find('.hd-progress.is-in-stage').exists()).toBe(false)
    expect(w.find('.pano-stage img').attributes('src')).not.toContain('thumbnail')
    w.unmount()
  })

  it('点「全屏」把画布搬到 body 铺满视口，再点「退出」回弹层', async () => {
    withPano()
    const w = await openPano()

    const stage = (): Element | null => document.body.querySelector('.pano-stage')
    const landBtn = (): HTMLButtonElement =>
      [...document.body.querySelectorAll('.pano-tool')].find((b) =>
        /全屏|退出/.test(b.textContent ?? ''),
      ) as HTMLButtonElement

    expect(stage()?.classList.contains('is-land')).toBe(false)

    landBtn().click()
    await nextTick()
    expect(stage()?.classList.contains('is-land')).toBe(true)
    // 弹层面板带 transform（popRise 收尾态），position:fixed 会被它当包含块 ——
    // 所以必须 Teleport 到 body 才能真正铺满视口
    expect(document.querySelector('.pop-panel .pano-stage')).toBeNull()
    expect(landBtn().textContent).toContain('退出')

    landBtn().click()
    await nextTick()
    expect(stage()?.classList.contains('is-land')).toBe(false)
    expect(document.querySelector('.pop-panel .pano-stage')).toBeTruthy()
    w.unmount()
  })
})

/**
 * 单张照片（全景航拍 / 照片墙）的工具条
 *
 * 历史：2026-11-18 照 VR 360 的「看高清 + 横屏」放过「查看原图 + 全屏」；
 * 2026-11-23 现场口径改成**打开即原图**，「查看原图」整颗下线，工具条只剩「全屏」。
 * 「下载」早已整块拿掉（要存图走长按 / 系统菜单，与全景一致）。
 */
describe('智眸大图弹层 · 单张照片工具条（只剩全屏）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    offline()
  })

  afterEach(async () => {
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  /** 打开一张 4:3 平面照片（尺寸非 2:1，不会走进球面播放器） */
  async function openFlat(): Promise<ReturnType<typeof mount>> {
    const patrol = usePatrolStore()
    patrol.apply([photo({ id: 'a', name: 'DJI_202611171530_0001_V.jpeg', size: 7_825_440 })], 'gate')
    patrol.setDims('a', 4032, 3024)
    const w = mount(Host, { attachTo: document.body })
    await nextTick()
    await w.findAll('.patrol-card')[0].trigger('click')
    await nextTick()
    return w
  }

  it('工具条在画布上：只剩「全屏」，查看原图与「下载」都已下线', async () => {
    const w = await openFlat()

    const tools = w.find('.patrol-view .pano-tools')
    expect(tools.exists()).toBe(true)
    // 2026-11-23：打开即原图，不再需要点一次「查看原图」
    expect(tools.findAll('.pano-tool').map((b) => b.text())).toEqual(['全屏'])
    // 下方那行「原图 / 下载」整块不存在了
    expect(w.find('.photo-actions').exists()).toBe(false)
    expect(w.text()).not.toContain('下载')
    // 2026-11-24：体积不再显示 —— 工具条和下方 meta 都没有
    expect(tools.text()).not.toContain('7.5MB')
    expect(w.find('.patrol-meta').text()).not.toContain('7.5MB')
    expect(w.find('.patrol-meta').text()).not.toContain('大小')
    w.unmount()
  })

  it('点「全屏」把画布搬到 body 铺满视口，再点「退出」回弹层', async () => {
    const w = await openFlat()

    const stage = (): Element | null => document.body.querySelector('.patrol-view')
    const landBtn = (): HTMLButtonElement =>
      [...document.body.querySelectorAll('.pano-tool')].find((b) =>
        /全屏|退出/.test(b.textContent ?? ''),
      ) as HTMLButtonElement

    expect(stage()?.classList.contains('is-land')).toBe(false)

    landBtn().click()
    await nextTick()
    expect(stage()?.classList.contains('is-land')).toBe(true)
    // 与全景同一条理由：弹层面板带 transform，不 Teleport 就铺不满
    expect(document.querySelector('.pop-panel .patrol-view')).toBeNull()
    expect(landBtn().textContent).toContain('退出')

    landBtn().click()
    await nextTick()
    expect(stage()?.classList.contains('is-land')).toBe(false)
    expect(document.querySelector('.pop-panel .patrol-view')).toBeTruthy()
    w.unmount()
  })
})

/* ================================================================ *
 * 全景航拍：全局定点拍照最近一班有照片的飞行（V2 采集图片同一条链）   *
 * ================================================================ */

describe('全景航拍（全局定点拍照最新 9 张）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  /** 一班执行记录（字段照 `/task/exec/list/record` 真实形状裁剪） */
  function job(id: number, start: string, status: number): Record<string, unknown> {
    return {
      id,
      uuid: `uuid-${id}`,
      taskName: '向阳村-全局定点拍照',
      taskId: 4916,
      start,
      end: start,
      status,
    }
  }

  /** 一班的媒体：9 张 JPEG + 1 个飞行日志（实测每班都这样） */
  function mediaOfJob(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (let i = 1; i <= 9; i += 1) {
      const n = String(i).padStart(4, '0')
      out.push({
        name: `DJI_2026111715${3300 + i}_${n}_V.jpeg`,
        url: `https://moss.keehang.com:9443/models/a/${n}.jpeg`,
        thumbnail: `https://oss.keehang.com:19090/thumbnail/iot/${n}.jpeg`,
        mediaType: 'image/jpeg',
        size: 8_000_000,
        lastModified: '2026-11-17 15:39:38',
      })
    }
    out.push({
      name: 'DJI_2026_11_17_15_30_49_7CTDM7R00B1498.DAT',
      url: 'https://moss.keehang.com/a.DAT',
      thumbnail: '',
      mediaType: 'application/octet-stream',
      size: 271_207,
      lastModified: '2026-11-17 15:39:42',
    })
    return out
  }

  /**
   * 三条记录（照 2026-11-20 实测的真实班次）：
   *   · 11-19 15:30 `status=-1` —— 未来排班，不能取；
   *   · **11-19 08:20 `status=2` —— 最新一班，9 张**（用户说的「11-19 那 9 张」）；
   *   · 11-17 15:30 `status=2` —— 更早的一班，也 9 张，**不该被取到**。
   */
  function spotFetch(): ReturnType<typeof vi.fn> {
    const rows = [
      job(31, '2026-11-19T15:30:00', -1),
      job(30, '2026-11-19T08:20:00', 2),
      job(29, '2026-11-17T15:30:00', 2),
    ]
    return vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/cas/auth/login')) {
        return khOk({ code: 200, data: { tgt: 'T', st: 'S', userDetail: { uid: 42 } } })
      }
      if (u.includes('/cas/auth/validate')) {
        return khOk({ code: 200, data: { uid: '42', token: 'TOKEN', timestamp: Date.now() } })
      }
      if (u.includes('/api/open/v1/task-record/page')) return khOk({ code: 200, data: rows })
      if (u.includes('/media/task/job/30')) return khOk({ code: 200, data: mediaOfJob() })
      if (u.includes('/media/task/job/29')) return khOk({ code: 200, data: mediaOfJob() })
      if (u.includes('/dashboard/recreate/getProjectRecreateInfo')) {
        return khOk({ code: 200, data: { total: 0, list: [] } })
      }
      return khOk({ code: 200, data: [] })
    })
  }

  it('只认最新一班：跳过未来排班，也不因为「更早那班也有 9 张」就退回去', async () => {
    vi.stubGlobal('fetch', spotFetch())

    const g = await fetchSpotGallery()
    expect(g?.jobId).toBe(30)
    expect(g?.start).toBe('2026-11-19T08:20:00')
    expect(g?.taskName).toBe('向阳村-全局定点拍照')
  })

  it('只留图片（丢掉 .DAT 日志），按 DJI 序号升序，正好 9 张', async () => {
    vi.stubGlobal('fetch', spotFetch())

    const g = await fetchSpotGallery()
    expect(g?.media).toHaveLength(9)
    expect(g?.media.every((m) => m.mediaType.startsWith('image/'))).toBe(true)
    expect(g?.media.map((m) => /_(\d{4})_V\.jpeg$/.exec(m.name)?.[1])).toEqual([
      '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009',
    ])
    expect(g?.media.some((m) => m.name.endsWith('.DAT'))).toBe(false)
  })

  it('面板：全景航拍显示 9 张，列表用缩略图，点开走大图弹层', async () => {
    vi.stubGlobal('fetch', spotFetch())

    const w = mount(PatrolPanel)
    await flushPromises()
    await nextTick()

    // 分类条计数与默认落点都在「全景航拍」
    const chips = w.findAll('.patrol-cats button')
    expect(chips[1].text()).toBe('全景航拍9')
    expect(chips[1].classes()).toContain('on')
    expect(w.find('.patrol-hd em').text()).toBe('9 张')

    const cards = w.findAll('.patrol-card')
    expect(cards).toHaveLength(9)
    // 列表只加载缩略图（原图要等点「查看原图」）
    expect(cards[0].find('.patrol-thumb img').attributes('src')).toContain('/thumbnail/')
    expect(cards[0].text()).toContain('向阳村-全局定点拍照')
    // 顺序与 V2 那排缩略图一致：0001 在最左
    const photoId = photoIdOf()
    await cards[0].trigger('click')
    expect(useBottomSheetStore().id).toBe(photoId)
    w.unmount()
  })

  /** 从 store 里反查第一张图的 id（卡片本身不挂 id，避免 DOM 里出现签名直链） */
  function photoIdOf(): string {
    const store = usePatrolStore()
    expect(store.spot).toHaveLength(9)
    expect(store.spot[0].name).toContain('_0001_V')
    expect(store.spot[8].name).toContain('_0009_V')
    expect(store.spot[0].thumbnail).toContain('/thumbnail/')
    expect(store.spot[0].url).toContain('/models/')
    expect(store.photoById(store.spot[0].id)?.name).toBe(store.spot[0].name)
    return store.spot[0].id
  }
})

/* ================================================================ *
 * 材料堆场：「向阳村-分区定点拍照」最近一班的第 1、第 2、第 37 张          *
 * ================================================================ */

/**
 * 用户给的依据是 V2「任务记录 → 向阳村-分区定点拍照 → 采集数据 → 采集照片(41)」
 * 那张网格（2026-11-17 12:30 那班，实测 41 张）：第 1、第 2 和第 **37** 张才是
 * 材料堆场那几堆料，其余是别处。所以这一格钉的是：
 *   1. 数据源只有这一条航线（名字全等，不能把「全局定点拍照」混进来）；
 *   2. 只取第 1、2、37 张，顺序按拍摄先后（文件名升序 = DJI 序号）；
 *   3. 每次刷新重新取最近一班（新一班飞完，三张跟着换）；
 *   4. 班次不足 37 张时**只给存在的那几张**，不拿最后一张凑数。
 */
describe('材料堆场（分区定点拍照第 1、2、37 张）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  /** 一班执行记录（字段照 `/task/exec/list/record` 真实形状裁剪） */
  function job(
    id: number,
    start: string,
    status: number,
    taskName = '向阳村-分区定点拍照',
  ): Record<string, unknown> {
    return { id, uuid: `uuid-${id}`, taskName, taskId: 4917, start, end: start, status }
  }

  /** 一班的媒体：`count` 张 JPEG（序号补齐 4 位）+ 1 个飞行日志 */
  function mediaOf(count: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (let i = 1; i <= count; i += 1) {
      const n = String(i).padStart(4, '0')
      out.push({
        name: `DJI_2026111712${String(3000 + i)}_${n}_V.jpeg`,
        url: `https://moss.keehang.com:9443/models/yard/${n}.jpeg`,
        thumbnail: `https://oss.keehang.com:19090/thumbnail/iot/yard/${n}.jpeg`,
        mediaType: 'image/jpeg',
        size: 7_000_000,
        lastModified: '2026-11-17 12:39:38',
      })
    }
    out.push({
      name: 'DJI_2026_11_17_12_30_49_7CTDM7R00B1498.DAT',
      url: 'https://moss.keehang.com/yard.DAT',
      thumbnail: '',
      mediaType: 'application/octet-stream',
      size: 271_207,
      lastModified: '2026-11-17 12:39:42',
    })
    return out
  }

  /**
   * 接口桩。默认四条记录：
   *   · 11-18 15:30「全局定点拍照」9 张 —— 名字相近，**不能**被取到；
   *   · 11-19 12:30 分区 `status=-1` —— 未来排班；
   *   · 11-18 08:20 分区 `status=2` 但 0 条媒体 —— 要跳过；
   *   · 11-17 12:30 分区 `status=2` 41 张 —— **就是截图里那班**。
   */
  function yardFetch(picCount = 41): ReturnType<typeof vi.fn> {
    const rows = [
      // 名字相近但不是「分区定点拍照」；用未完成状态，免得它把默认落点抢走
      job(50, '2026-11-18T15:30:00', -1, '向阳村-全局定点拍照'),
      job(41, '2026-11-19T12:30:00', -1),
      job(40, '2026-11-18T08:20:00', 2),
      job(39, '2026-11-17T12:30:00', 2),
    ]
    return vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/cas/auth/login')) {
        return khOk({ code: 200, data: { tgt: 'T', st: 'S', userDetail: { uid: 42 } } })
      }
      if (u.includes('/cas/auth/validate')) {
        return khOk({ code: 200, data: { uid: '42', token: 'TOKEN', timestamp: Date.now() } })
      }
      if (u.includes('/api/open/v1/task-record/page')) return khOk({ code: 200, data: rows })
      if (u.includes('/media/task/job/50')) return khOk({ code: 200, data: mediaOf(9) })
      if (u.includes('/media/task/job/40')) return khOk({ code: 200, data: [] })
      if (u.includes('/media/task/job/39')) return khOk({ code: 200, data: mediaOf(picCount) })
      if (u.includes('/dashboard/recreate/getProjectRecreateInfo')) {
        return khOk({ code: 200, data: { total: 0, list: [] } })
      }
      return khOk({ code: 200, data: [] })
    })
  }

  /** 媒体名 → DJI 序号（`_0001_V` → `0001`） */
  function seqOf(name: string): string | undefined {
    return /_(\d{4})_V\.jpeg$/.exec(name)?.[1]
  }

  it('只认「分区定点拍照」，不混进「全局定点拍照」；跳过未来排班与空媒体', async () => {
    vi.stubGlobal('fetch', yardFetch())

    const g = await fetchYardGallery()
    expect(g?.jobId).toBe(39)
    expect(g?.taskName).toBe('向阳村-分区定点拍照')
    expect(g?.start).toBe('2026-11-17T12:30:00')
  })

  it('只取第 1、第 2、第 37 张（按拍摄顺序，日志不算图片）', async () => {
    vi.stubGlobal('fetch', yardFetch())

    const g = await fetchYardGallery()
    expect(g?.media).toHaveLength(3)
    expect(g?.media.map((m) => seqOf(m.name))).toEqual(['0001', '0002', '0037'])
    expect(g?.media.every((m) => m.mediaType.startsWith('image/'))).toBe(true)
  })

  it('班次不足 37 张时不凑数：只有第 1、第 2 张', async () => {
    vi.stubGlobal('fetch', yardFetch(5))

    const g = await fetchYardGallery()
    expect(g?.media.map((m) => seqOf(m.name))).toEqual(['0001', '0002'])
  })

  it('面板：材料堆场 3 张、默认落点、列表用缩略图，点开走大图弹层', async () => {
    vi.stubGlobal('fetch', yardFetch())

    const w = mount(PatrolPanel)
    await flushPromises()
    await nextTick()

    const chips = w.findAll('.patrol-cats button')
    expect(chips[3].text()).toBe('材料堆场3')
    expect(chips[3].classes()).toContain('on')
    expect(w.find('.patrol-hd em').text()).toBe('3 张')

    const cards = w.findAll('.patrol-card')
    expect(cards).toHaveLength(3)
    expect(cards[0].text()).toContain('向阳村-分区定点拍照')
    // 列表只加载缩略图（原图等点「查看原图」）
    expect(cards[0].find('.patrol-thumb img').attributes('src')).toContain('/thumbnail/')

    const store = usePatrolStore()
    expect(store.yard.map((p) => seqOf(p.name))).toEqual(['0001', '0002', '0037'])
    // 弹层只拿到 id，store 得能在 yard 里找到这张
    expect(store.photoById(store.yard[2].id)?.name).toBe(store.yard[2].name)
    w.unmount()
  })

  it('每次刷新重取最近一班：新班次飞完，三张跟着换', async () => {
    const patrol = usePatrolStore()
    vi.stubGlobal('fetch', yardFetch())
    await patrol.loadYard()
    expect(patrol.yard.map((p) => seqOf(p.name))).toEqual(['0001', '0002', '0037'])
    const first = patrol.yard[0].id

    // 再飞一班（更新的一班，媒体换成 3 张）→ 刷新后必须换成新的
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) {
          return khOk({ code: 200, data: { tgt: 'T', st: 'S', userDetail: { uid: 42 } } })
        }
        if (u.includes('/cas/auth/validate')) {
          return khOk({ code: 200, data: { uid: '42', token: 'T2', timestamp: Date.now() } })
        }
        if (u.includes('/api/open/v1/task-record/page')) {
          // 又飞了一班（比 11-17 12:30 那班新，且已开始）
          return khOk({ code: 200, data: [job(42, '2026-11-17T18:30:00', 2)] })
        }
        if (u.includes('/media/task/job/42')) return khOk({ code: 200, data: mediaOf(3) })
        return khOk({ code: 200, data: [] })
      }),
    )
    await patrol.loadYard()

    expect(patrol.yard[0].id).not.toBe(first)
    expect(patrol.yard.map((p) => seqOf(p.name))).toEqual(['0001', '0002'])
    expect(patrol.yardState).toBe('ok')
  })
})

/* ================================================================ *
 * 设备设施：「向阳村-塔吊定点」最近一班的第 2、第 7 张                 *
 * ================================================================ */

/**
 * 用户给的依据是 V2「任务记录 → 向阳村-塔吊定点 → 采集数据 → 采集照片(16)」
 * 那张网格（截图里 2026-11-17 14:15 那班，采集 16 张）：只有第 2 张和第 7 张
 * 是设备设施那几台塔吊，其余是别处。这一格钉的是：
 *   1. 数据源只有这一条航线（名字全等，不能把「安全巡检」「分区定点拍照」混进来）；
 *   2. 只取第 2、第 7 张，顺序按拍摄先后（文件名升序 = DJI 序号）；
 *   3. 每次刷新重新取最近一班（新一班飞完，两张跟着换）；
 *   4. 班次不足 7 张时只给存在的那几张，不拿别的凑数。
 *
 * 另外两张来自「视频监控-塔吊-2#/4# 塔吊」各自最新的一张 —— 监控侧没有照片
 * 查询接口，用户 2026-11-18 明确本轮不接入，所以这里断言的就是 **2 张**。
 */
describe('设备设施（塔吊定点第 2、7 张 + 2#/4# 塔吊最新抓拍）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await flushPromises()
    clearSession()
    // 本机抓拍档案是模块级状态（IndexedDB 没有时退内存）：不查清会串到下一条用例
    await clearShots()
    vi.unstubAllGlobals()
  })

  /** 一班执行记录（字段照 `/task/exec/list/record` 真实形状裁剪） */
  function job(
    id: number,
    start: string,
    status: number,
    taskName = '向阳村-塔吊定点',
  ): Record<string, unknown> {
    return { id, uuid: `uuid-${id}`, taskName, taskId: 4917, start, end: start, status }
  }

  /** 一班的媒体：`count` 张 JPEG（序号补齐 4 位）+ 1 个飞行日志 */
  function mediaOf(count: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (let i = 1; i <= count; i += 1) {
      const n = String(i).padStart(4, '0')
      out.push({
        name: `DJI_2026111714${String(1500 + i)}_${n}_V.jpeg`,
        url: `https://moss.keehang.com:9443/models/crane/${n}.jpeg`,
        thumbnail: `https://oss.keehang.com:19090/thumbnail/iot/crane/${n}.jpeg`,
        mediaType: 'image/jpeg',
        size: 6_800_000,
        lastModified: '2026-11-17 14:21:30',
      })
    }
    out.push({
      name: 'DJI_2026_11_17_14_15_03_7CTDM7R00B1498.DAT',
      url: 'https://moss.keehang.com/crane.DAT',
      thumbnail: '',
      mediaType: 'application/octet-stream',
      size: 271_207,
      lastModified: '2026-11-17 14:21:34',
    })
    return out
  }

  /**
   * 接口桩。默认四条记录：
   *   · 11-18 10:00「安全巡检」16 张 —— 别的航线，**不能**被取到；
   *   · 11-19 14:15 塔吊定点 `status=-1` —— 未来排班；
   *   · 11-18 09:00 塔吊定点 `status=2` 但 0 条媒体 —— 要跳过；
   *   · 11-17 14:15 塔吊定点 `status=2` 16 张 —— **就是截图里那班**。
   */
  function facilityFetch(picCount = 16): ReturnType<typeof vi.fn> {
    const rows = [
      job(60, '2026-11-18T10:00:00', 2, '向阳村-安全巡检'),
      job(52, '2026-11-19T14:15:00', -1),
      job(51, '2026-11-18T09:00:00', 2),
      job(50, '2026-11-17T14:15:00', 2),
    ]
    return vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/cas/auth/login')) {
        return khOk({ code: 200, data: { tgt: 'T', st: 'S', userDetail: { uid: 42 } } })
      }
      if (u.includes('/cas/auth/validate')) {
        return khOk({ code: 200, data: { uid: '42', token: 'TOKEN', timestamp: Date.now() } })
      }
      if (u.includes('/api/open/v1/task-record/page')) return khOk({ code: 200, data: rows })
      if (u.includes('/media/task/job/60')) return khOk({ code: 200, data: mediaOf(16) })
      if (u.includes('/media/task/job/51')) return khOk({ code: 200, data: [] })
      if (u.includes('/media/task/job/50')) return khOk({ code: 200, data: mediaOf(picCount) })
      // 2# / 4# 塔吊的抓拍：设备设施后两张（视频监控）走这里
      if (u.includes('/api/video/snapshots')) return shotOk(u)
      if (u.includes('/dashboard/recreate/getProjectRecreateInfo')) {
        return khOk({ code: 200, data: { total: 0, list: [] } })
      }
      return khOk({ code: 200, data: [] })
    })
  }

  /** 媒体名 → DJI 序号（`_0001_V` → `0001`） */
  function seqOf(name: string): string | undefined {
    return /_(\d{4})_V\.jpeg$/.exec(name)?.[1]
  }

  it('只认「塔吊定点」；跳过未来排班与空媒体', async () => {
    vi.stubGlobal('fetch', facilityFetch())

    const g = await fetchFacilityGallery()
    expect(g?.jobId).toBe(50)
    expect(g?.taskName).toBe('向阳村-塔吊定点')
    expect(g?.start).toBe('2026-11-17T14:15:00')
  })

  it('只取第 2、第 7 张（按拍摄顺序，日志不算图片）', async () => {
    vi.stubGlobal('fetch', facilityFetch())

    const g = await fetchFacilityGallery()
    expect(g?.media).toHaveLength(2)
    expect(g?.media.map((m) => seqOf(m.name))).toEqual(['0002', '0007'])
    expect(g?.media.every((m) => m.mediaType.startsWith('image/'))).toBe(true)
  })

  it('班次不足 7 张时不凑数：只有第 2 张', async () => {
    vi.stubGlobal('fetch', facilityFetch(4))

    const g = await fetchFacilityGallery()
    expect(g?.media.map((m) => seqOf(m.name))).toEqual(['0002'])
  })

  it('面板：设备设施 4 张（航拍 2 + 塔吊抓拍 2），默认落点、点开走大图弹层', async () => {
    vi.stubGlobal('fetch', facilityFetch())

    const w = mount(PatrolPanel)
    await flushPromises()
    await nextTick()

    const chips = w.findAll('.patrol-cats button')
    expect(chips[2].text()).toBe('设备设施4')
    expect(chips[2].classes()).toContain('on')
    expect(w.find('.patrol-hd em').text()).toBe('4 张')

    const cards = w.findAll('.patrol-card')
    expect(cards).toHaveLength(4)
    // 前两张仍是塔吊定点的航拍（第 2、第 7 张）
    expect(cards[0].text()).toContain('向阳村-塔吊定点')
    expect(cards[0].text()).toContain('无人机')
    expect(cards[1].text()).toContain('向阳村-塔吊定点')
    // 列表只加载缩略图（原图等点「查看原图」）
    expect(cards[0].find('.patrol-thumb img').attributes('src')).toContain('/thumbnail/')

    // 后两张是 2# / 4# 塔吊的最新抓拍：标题是点位名、来源写「视频监控」
    expect(cards[2].text()).toContain('2#塔吊')
    expect(cards[3].text()).toContain('4#塔吊')
    expect(cards[2].text()).toContain('视频监控')
    expect(cards[2].find('.patrol-thumb-tag').text()).toBe('抓拍')

    const store = usePatrolStore()
    expect(store.facility).toHaveLength(4)
    expect(store.facility.slice(0, 2).map((p) => seqOf(p.name))).toEqual(['0002', '0007'])
    expect(store.facility.slice(2).every((p) => p.snap)).toBe(true)
    // 弹层只拿到 id，store 得能在 facility 里找到这张
    expect(store.photoById(store.facility[1].id)?.name).toBe(store.facility[1].name)
    expect(store.photoById(store.facility[3].id)?.taskName).toBe('4#塔吊')
    w.unmount()
  })

  it('抓拍取不到时退回档案里最新那条；档案也空就少这两张，不影响前两张', async () => {
    // 相机/网络全挂：只有档案里那一条能用
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/api/video/snapshots')) {
          return { ok: false, status: 502, headers: { get: () => null } } as unknown as Response
        }
        return facilityFetch()(url)
      }),
    )
    // 先往本机档案里存一条 2#塔吊 的抓拍（= 之前看过监控留下的那张）
    await saveShot(
      '34020000001320000017',
      '20261119120000',
      new Date(2026, 10, 19, 12).getTime(),
      new Blob([new Uint8Array(180_000)], { type: 'image/jpeg' }),
    )

    const patrol = usePatrolStore()
    await patrol.loadFacility()
    await flushPromises()

    // 前两张不受影响；2#塔吊 用档案那条，4#塔吊 档案里没有 → 不出现
    expect(patrol.facility.filter((p) => !p.snap).map((p) => seqOf(p.name))).toEqual(['0002', '0007'])
    const snaps = patrol.facility.filter((p) => p.snap)
    expect(snaps).toHaveLength(1)
    expect(snaps[0].taskName).toBe('2#塔吊')
    expect(patrol.facilityState).toBe('ok')
  })

  it('每次刷新重取最近一班：新班次飞完，两张航拍跟着换', async () => {
    const patrol = usePatrolStore()
    vi.stubGlobal('fetch', facilityFetch())
    await patrol.loadFacility()
    expect(patrol.facility.slice(0, 2).map((p) => seqOf(p.name))).toEqual(['0002', '0007'])
    const first = patrol.facility[0].id

    // 再飞一班（更新的一班，媒体换成 9 张）→ 刷新后必须换成新的
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) {
          return khOk({ code: 200, data: { tgt: 'T', st: 'S', userDetail: { uid: 42 } } })
        }
        if (u.includes('/cas/auth/validate')) {
          return khOk({ code: 200, data: { uid: '42', token: 'T2', timestamp: Date.now() } })
        }
        if (u.includes('/api/open/v1/task-record/page')) {
          // 又飞了一班（比 11-17 14:15 那班新，且已开始）
          return khOk({ code: 200, data: [job(61, '2026-11-17T18:15:00', 2)] })
        }
        if (u.includes('/media/task/job/61')) return khOk({ code: 200, data: mediaOf(9) })
        if (u.includes('/api/video/snapshots')) return shotOk(u)
        return khOk({ code: 200, data: [] })
      }),
    )
    await patrol.loadFacility()

    const flights = patrol.facility.filter((p) => !p.snap)
    expect(flights[0].id).not.toBe(first)
    // id 是 `${执行记录 id}-${文件名}`：换成 61 那班说明重取的是新班次，不是缓存
    expect(flights.every((p) => p.id.startsWith('61-'))).toBe(true)
    expect(flights.map((p) => seqOf(p.name))).toEqual(['0002', '0007'])
    // 抓拍那两张与航拍那条链互不影响，仍是 2 张
    expect(patrol.facility.filter((p) => p.snap)).toHaveLength(2)
    expect(patrol.facilityState).toBe('ok')
  })
})

/* ================================================================ *
 * 出入口管控：5 个门禁点位各取最新一张历史抓拍（固定 5 张）            *
 * ================================================================ */

/**
 * 用户点名 5 个来源、每个来源只展示最新一张，**总数固定 5 张、不重复不缺项**：
 *
 *   1. 视频监控A（`34020000001310000001`，监控页叫「监控A」）；
 *   2. 视频监控-2#门监控1；3. 2#门监控2；4. 4#门监控；5. 4#门外监控
 *   —— 后四条按名字从 `CAM_POINTS` 取通道号。
 *
 * 取法与「设备设施」后两张同源（`snapShotOf`）：现取一帧落本机档案 → 取不到
 * 退回档案里最新那条 → 都没有就不出现（不编照片）。这里钉住的是：
 *
 *   1. 来源表固定 5 条、通道号能解析且互不重复（改名 / 复制粘贴出错会当场挂）；
 *   2. 5 张的顺序就是来源表顺序，标题是点位名、来源是「视频监控」；
 *   3. 某一路没画面时其余照常，并**说出缺的是哪一路**；
 *   4. 5 路全挂才写「暂时取不到」+ 重试，不当成「还没有照片」；
 *   5. 每次刷新重取，不拿上一批当最新。
 */
describe('出入口管控（5 个点位各最新一张抓拍）', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    // 本机档案是跨用例的（happy-dom 没有 IndexedDB，走模块级内存兜底），先清空
    await clearShots()
  })

  afterEach(async () => {
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  /**
   * 快照接口的桩：按 `channelId` 分路，`over` 里的通道走指定响应。
   *
   * `bytes` 是这一帧的字节数 —— 同档同样字节约等于「服务端还没更新」，
   * `saveShot` 会保留原记录，所以测「重取」时要换一个字节数。
   */
  function gateFetch(
    over: Record<string, () => Response> = {},
    bytes = 200_000,
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/video/snapshots')) {
        const ch = decodeURIComponent(/channelId=([^&]+)/.exec(u)?.[1] ?? '')
        const hit = over[ch]
        if (hit) return hit()
        return shotOk(u, bytes)
      }
      return khOk({ code: 200, data: [] })
    })
  }

  /** 一路取不到（相机离线 / 上游 502） */
  const dead = (): Response => ({ ok: false, status: 502, headers: { get: () => null } }) as unknown as Response

  it('来源表固定 5 条：通道号都能解析出来、互不重复', () => {
    expect(GATE_SHOTS.map((s) => s.name)).toEqual([
      '监控A',
      '2#门监控1',
      '2#门监控2',
      '4#门监控',
      '4#门外监控',
    ])
    expect(GATE_SHOTS.map((s) => s.channelId)).toEqual([
      '34020000001310000001',
      '34020000001320000003',
      '34020000001320000006',
      '34020000001320000007',
      '34020000001320000004',
    ])
  })

  it('取回 5 张，顺序即来源表顺序；标题是点位名、来源是视频监控', async () => {
    vi.stubGlobal('fetch', gateFetch())
    const patrol = usePatrolStore()
    await patrol.loadGate()

    expect(patrol.gate).toHaveLength(5)
    expect(patrol.gate.map((p) => p.taskName)).toEqual(GATE_SHOTS.map((s) => s.name))
    expect(patrol.gate.every((p) => p.snap)).toBe(true)
    expect(patrol.gate.every((p) => p.time)).toBeTruthy()
    // 弹层只拿 id：5 张必须都能在 gate 里找到，且 id 不重复
    expect(new Set(patrol.gate.map((p) => p.id)).size).toBe(5)
    for (const p of patrol.gate) expect(patrol.photoById(p.id)?.taskName).toBe(p.taskName)
    expect(patrol.gateState).toBe('ok')
  })

  it('某一路没有画面：其余照常，状态仍是 ok（不整格变空）', async () => {
    vi.stubGlobal('fetch', gateFetch({ '34020000001320000006': dead }))
    const patrol = usePatrolStore()
    await patrol.loadGate()

    expect(patrol.gate).toHaveLength(4)
    expect(patrol.gate.map((p) => p.taskName)).not.toContain('2#门监控2')
    expect(patrol.gateState).toBe('ok')
  })

  it('相机离线时退回本机档案里最新那张（真实抓拍，不拿别的图顶替）', async () => {
    // 之前看过 4#门监控，档案里留了一张
    await saveShot(
      '34020000001320000007',
      '20261119120000',
      new Date(2026, 10, 19, 12).getTime(),
      new Blob([new Uint8Array(120_000)], { type: 'image/jpeg' }),
    )
    vi.stubGlobal('fetch', gateFetch({ '34020000001320000007': dead }))

    const patrol = usePatrolStore()
    await patrol.loadGate()

    // 其余 4 路照常新鲜取回，只有 4#门监控 用的是档案里那张（字节数就是当年那张）
    expect(patrol.gate).toHaveLength(5)
    const fallback = patrol.gate.find((p) => p.taskName === '4#门监控')
    expect(fallback?.size).toBe(120_000)
    expect(fallback?.snap).toBe(true)
  })

  it('5 路全挂才算失败：状态 error、一张不留（面板写「暂时取不到」）', async () => {
    const allDead = Object.fromEntries(GATE_SHOTS.map((s) => [s.channelId, dead]))
    vi.stubGlobal('fetch', gateFetch(allDead))

    const patrol = usePatrolStore()
    await patrol.loadGate()

    expect(patrol.gate).toHaveLength(0)
    expect(patrol.gateState).toBe('error')
  })

  it('每次刷新重取一遍：字节变了就换成新的那张', async () => {
    vi.stubGlobal('fetch', gateFetch())
    const patrol = usePatrolStore()
    await patrol.loadGate()
    expect(patrol.gate.every((p) => p.size === 200_000)).toBe(true)

    // 服务端换了一帧（字节数不同）→ 同一档位覆盖，体积跟着变
    // （id 是「通道|日期|档位」，同一档不变 —— 弹层的 id 因此稳定，图是新的）
    vi.stubGlobal('fetch', gateFetch({}, 260_000))
    await patrol.loadGate()

    expect(patrol.gate).toHaveLength(5)
    expect(patrol.gate.every((p) => p.size === 260_000)).toBe(true)
  })

  it('面板：5 张都标「抓拍 / 视频监控」，标题是各自点位名', async () => {
    const patrol = usePatrolStore()
    patrol.apply(
      GATE_SHOTS.map((s, i) => photo({ id: `g${i}`, name: `${s.name}.jpg`, taskName: s.name, snap: true })),
      'gate',
    )
    // `apply` 已把 state / lastOkAt 摆成「刚同步完」，挂载时的 refresh() 会直接复用
    offline()
    const w = mount(PatrolPanel)
    await nextTick()

    expect(w.find('.patrol-hd em').text()).toBe('5 张')
    const chips = w.findAll('.patrol-cats button')
    expect(chips[4].text()).toBe('出入口管控5')

    const cards = w.findAll('.patrol-card')
    expect(cards).toHaveLength(5)
    expect(cards.map((c) => c.find('.patrol-card-name strong').text())).toEqual(
      GATE_SHOTS.map((s) => s.name),
    )
    expect(cards[0].find('.patrol-thumb-tag').text()).toBe('抓拍')
    expect(cards[0].find('.alarm-src').text()).toBe('视频监控')
    // 5 张都在时不显示缺项说明
    expect(w.find('.patrol-gate-note').exists()).toBe(false)
    w.unmount()
  })

  it('面板：少一路时把缺的点位名说出来（张数变 4 之外还要解释）', async () => {
    const patrol = usePatrolStore()
    patrol.apply(
      // 缺最后一路「4#门外监控」
      GATE_SHOTS.slice(0, 4).map((s, i) =>
        photo({ id: `g${i}`, name: `${s.name}.jpg`, taskName: s.name, snap: true }),
      ),
      'gate',
    )
    offline()
    const w = mount(PatrolPanel)
    await nextTick()

    expect(w.find('.patrol-hd em').text()).toBe('4 张')
    expect(w.findAll('.patrol-card')).toHaveLength(4)
    expect(w.find('.patrol-gate-note').text()).toBe('4#门外监控 暂时没有画面')
    w.unmount()
  })
})

/* ================================================================ *
 * 安全巡查：土方1 第 1 张 + 分区定点拍照第 34 张（两条航线各一张）      *
 * ================================================================ */

/**
 * 用户给了两张 V2 截图：
 *   · 「向阳村-土方1」2026-11-17 17:00–17:05（采集 50 张）→ 第 1 张；
 *   · 「向阳村-分区定点拍照」2026-11-17 12:30（采集 41 张）→ 第 34 张。
 *
 * 这一格和前面几格的区别是**跨两条航线**，所以钉的是：
 *   1. 只认这两条航线（名字全等），别的航线一张都不进；
 *   2. 各取自己那班指定的那一张，顺序按来源表（土方在前）；
 *   3. 一条取不到时只少一张，另一张照常显示（不整格变空）；
 *   4. 每次刷新重取最近一班。
 */
describe('安全巡查（土方1 第 1 张 + 分区定点第 34 张）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await flushPromises()
    clearSession()
    vi.unstubAllGlobals()
  })

  function job(
    id: number,
    start: string,
    status: number,
    taskName: string,
  ): Record<string, unknown> {
    return { id, uuid: `uuid-${id}`, taskName, taskId: 4917, start, end: start, status }
  }

  /** 一班的媒体：`count` 张 JPEG（序号补齐 4 位）+ 1 个飞行日志 */
  function mediaOf(count: number, tag: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (let i = 1; i <= count; i += 1) {
      const n = String(i).padStart(4, '0')
      out.push({
        name: `DJI_20261117${tag}_${n}_V.jpeg`,
        url: `https://moss.keehang.com:9443/models/${tag}/${n}.jpeg`,
        thumbnail: `https://oss.keehang.com:19090/thumbnail/iot/${tag}/${n}.jpeg`,
        mediaType: 'image/jpeg',
        size: 6_500_000,
        lastModified: '2026-11-17 17:05:00',
      })
    }
    out.push({
      name: `DJI_2026_11_17_${tag}_log.DAT`,
      url: `https://moss.keehang.com/${tag}.DAT`,
      thumbnail: '',
      mediaType: 'application/octet-stream',
      size: 271_207,
      lastModified: '2026-11-17 17:05:04',
    })
    return out
  }

  /**
   * 接口桩：
   *   · 土方1：11-19 未来班（`status=-1`）、11-18 09:00 空媒体、11-17 17:00 50 张；
   *   · 分区定点：11-18 09:30 空媒体、11-17 12:30 41 张；
   *   · 「向阳村-安全巡检」50 张 —— 名字相近的干扰项，不能进这一格。
   *
   * 两类班次的 `start` 分处不同日期，正好也验「各自找各自的最近一班」。
   */
  function safetyFetch(opts: { soil?: number; yard?: number } = {}): ReturnType<typeof vi.fn> {
    const soilPics = opts.soil ?? 50
    const yardPics = opts.yard ?? 41
    const rows = [
      job(72, '2026-11-19T17:00:00', -1, '向阳村-土方1'),
      job(71, '2026-11-18T09:00:00', 2, '向阳村-土方1'),
      job(70, '2026-11-17T17:00:00', 2, '向阳村-土方1'),
      job(82, '2026-11-18T09:30:00', 2, '向阳村-分区定点拍照'),
      job(80, '2026-11-17T12:30:00', 2, '向阳村-分区定点拍照'),
      job(90, '2026-11-17T17:45:00', 2, '向阳村-安全巡检'),
    ]
    return vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/cas/auth/login')) {
        return khOk({ code: 200, data: { tgt: 'T', st: 'S', userDetail: { uid: 42 } } })
      }
      if (u.includes('/cas/auth/validate')) {
        return khOk({ code: 200, data: { uid: '42', token: 'TOKEN', timestamp: Date.now() } })
      }
      if (u.includes('/api/open/v1/task-record/page')) return khOk({ code: 200, data: rows })
      if (u.includes('/media/task/job/71')) return khOk({ code: 200, data: [] })
      if (u.includes('/media/task/job/70')) return khOk({ code: 200, data: mediaOf(soilPics, 'soil') })
      if (u.includes('/media/task/job/82')) return khOk({ code: 200, data: [] })
      if (u.includes('/media/task/job/80')) return khOk({ code: 200, data: mediaOf(yardPics, 'zone') })
      if (u.includes('/media/task/job/90')) return khOk({ code: 200, data: mediaOf(5, 'patrol') })
      if (u.includes('/dashboard/recreate/getProjectRecreateInfo')) {
        return khOk({ code: 200, data: { total: 0, list: [] } })
      }
      return khOk({ code: 200, data: [] })
    })
  }

  function seqOf(name: string): string | undefined {
    return /_(\d{4})_V\.jpeg$/.exec(name)?.[1]
  }

  it('两条航线各取最近一班：土方1 第 1 张 + 分区定点第 34 张，顺序按来源表', async () => {
    vi.stubGlobal('fetch', safetyFetch())

    const groups = await fetchSafetyGallery()
    expect(groups).toHaveLength(2)
    // 顺序就是 SAFETY_SOURCES 的顺序：土方在前
    expect(groups.map((g) => g.taskName)).toEqual(['向阳村-土方1', '向阳村-分区定点拍照'])
    expect(groups[0].jobId).toBe(70)
    expect(groups[0].media.map((m) => seqOf(m.name))).toEqual(['0001'])
    expect(groups[1].jobId).toBe(80)
    expect(groups[1].media.map((m) => seqOf(m.name))).toEqual(['0034'])
    // 「安全巡检」那班 50 张一张都没进来
    expect(groups.every((g) => g.taskName !== '向阳村-安全巡检')).toBe(true)
  })

  it('班次不足 34 张时只给土方那张，不拿别的凑数', async () => {
    vi.stubGlobal('fetch', safetyFetch({ yard: 20 }))

    const groups = await fetchSafetyGallery()
    expect(groups).toHaveLength(1)
    expect(groups[0].taskName).toBe('向阳村-土方1')
    expect(groups[0].media.map((m) => seqOf(m.name))).toEqual(['0001'])
  })

  it('一条航线取不到时只少一张，另一条照常（不整格变空）', async () => {
    // 分区定点每一班都没媒体 → `latestTaskMedia` 返回 null，土方那组仍要给
    vi.stubGlobal('fetch', safetyFetch({ yard: 0 }))

    const groups = await fetchSafetyGallery()
    expect(groups.map((g) => g.taskName)).toEqual(['向阳村-土方1'])
  })

  it('面板：安全巡查 2 张、标题各是真实航线名、列表用缩略图，点开走大图弹层', async () => {
    vi.stubGlobal('fetch', safetyFetch())

    const w = mount(PatrolPanel)
    await flushPromises()
    await nextTick()

    const chips = w.findAll('.patrol-cats button')
    expect(chips[5].text()).toBe('安全巡查2')
    // 桩里「分区定点拍照」也有数据 → 默认落点是更靠前的「材料堆场」，
    // 这里显式点「安全巡查」，断言的才是这一格自己
    await chips[5].trigger('click')
    expect(w.find('.patrol-hd em').text()).toBe('2 张')

    const cards = w.findAll('.patrol-card')
    expect(cards).toHaveLength(2)
    // 两张来自不同航线，卡片标题各写自己的（不统一成「安全巡查」）
    expect(cards[0].text()).toContain('向阳村-土方1')
    expect(cards[1].text()).toContain('向阳村-分区定点拍照')
    expect(cards[0].find('.patrol-thumb img').attributes('src')).toContain('/thumbnail/')

    const store = usePatrolStore()
    expect(store.safety.map((p) => seqOf(p.name))).toEqual(['0001', '0034'])
    // 弹层只拿到 id，store 得能在 safety 里找到——两张都要能找
    expect(store.photoById(store.safety[0].id)?.name).toBe(store.safety[0].name)
    expect(store.photoById(store.safety[1].id)?.name).toBe(store.safety[1].name)
    w.unmount()
  })

  it('每次刷新重取最近一班：两条航线都换成新班次', async () => {
    const patrol = usePatrolStore()
    vi.stubGlobal('fetch', safetyFetch())
    await patrol.loadSafety()
    expect(patrol.safety.map((p) => p.id.split('-')[0])).toEqual(['70', '80'])

    // 两条航线各又飞了一班（已开始，比原班新）
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) {
          return khOk({ code: 200, data: { tgt: 'T', st: 'S', userDetail: { uid: 42 } } })
        }
        if (u.includes('/cas/auth/validate')) {
          return khOk({ code: 200, data: { uid: '42', token: 'T2', timestamp: Date.now() } })
        }
        if (u.includes('/api/open/v1/task-record/page')) {
          return khOk({
            code: 200,
            data: [
              job(73, '2026-11-17T18:00:00', 2, '向阳村-土方1'),
              job(81, '2026-11-17T18:30:00', 2, '向阳村-分区定点拍照'),
            ],
          })
        }
        if (u.includes('/media/task/job/73')) return khOk({ code: 200, data: mediaOf(8, 'soil2') })
        if (u.includes('/media/task/job/81')) return khOk({ code: 200, data: mediaOf(40, 'zone2') })
        return khOk({ code: 200, data: [] })
      }),
    )
    await patrol.loadSafety()

    expect(patrol.safety.map((p) => p.id.split('-')[0])).toEqual(['73', '81'])
    expect(patrol.safety.map((p) => seqOf(p.name))).toEqual(['0001', '0034'])
    expect(patrol.safetyState).toBe('ok')
  })

  /**
   * 「有时只剩一张」的直接复现：一条来源取数失败时，旧实现把它当成
   * 「这条航线没照片」静默跳过，整格就只剩另一条的一张。
   */
  it('一条来源取数失败时补取一次，最终仍是两张（顺序不回退）', async () => {
    const base = safetyFetch()
    let zoneCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/media/task/job/80')) {
          zoneCalls += 1
          // 第一次 500（非限流码，`stationMedia` 不会原地重试）→ 直接进补取
          if (zoneCalls === 1) return khOk({ code: 500, msg: 'boom' })
        }
        return base(url, init)
      }),
    )

    const groups = await fetchSafetyGallery()
    expect(zoneCalls).toBeGreaterThanOrEqual(2)
    // 顺序仍按 SAFETY_SOURCES：补取是后发生的，不能把两张顺序颠倒
    expect(groups.map((g) => g.taskName)).toEqual(['向阳村-土方1', '向阳村-分区定点拍照'])
    expect(groups[1]!.media.map((m) => seqOf(m.name))).toEqual(['0034'])
  }, 20_000)

  /** 两条来源查同一个窗口：共享一份执行记录，别各翻 5 页（那是 429 的来源） */
  it('两条来源共享执行记录：同一个窗口只查一次', async () => {
    const stub = safetyFetch()
    vi.stubGlobal('fetch', stub)

    await fetchSafetyGallery()

    const pages = stub.mock.calls.filter(([u]) => String(u).includes('/api/open/v1/task-record/page'))
    expect(pages).toHaveLength(1)
  })
})
