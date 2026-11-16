import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import { clearSession } from '@/api/drone'
import SheetHost from '@/components/overlays/SheetHost.vue'
import { PATROL_CATS, catOfTask } from '@/data/config'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { PANO_SHEET_ID, usePatrolStore, type PatrolPhotoReal } from '@/stores/patrol'
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

/* ================================================================ *
 * 项目全景（2026-11-16：吃平台拼好的重建成果，不自拼）                *
 * ================================================================ */

/** keehang 的响应包：`{code,msg,data}`，code === 200 才算成功 */
function khOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
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
    if (u.includes('/task/exec/list/record')) return khOk({ code: 200, data: records })
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

describe('智眸面板 · 项目全景卡片', () => {
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
      time: '2026-11-15 12:10:54',
      preview: 'https://oss.keehang.com:19090/thumbnail/model/103180/thumbnail.jpg',
      full: 'https://moss.keehang.com:9443/models/103180/origin.jpg',
      size: 13_688_984,
    }
  }

  it('「项目全景」里是**一张**全景卡片（不是一堆俯视照片）', async () => {
    withPano()
    const w = mount(PatrolPanel)
    await nextTick()

    expect(w.find('.patrol-card.is-pano').exists()).toBe(true)
    expect(w.findAll('.patrol-card')).toHaveLength(1)
    const card = w.find('.patrol-card.is-pano').text()
    expect(card).toContain('向阳村-全景')
    expect(card).toContain('可环视')
    // 角标写真实体积（13.1MB），不写「N 张拼接」——那是原片张数，已不是显示对象
    expect(card).toContain('13.1MB')
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
    expect(w.find('.patrol-cats button').text()).toContain('项目全景')
    w.unmount()
  })
})

/**
 * 全景弹层的工具条（2026-11-16 用户要求）
 *
 * 「看高清 / 下载」原本在图片下方那一行按钮里，用户要求：看高清挪到画布上、
 * 与「复位」并排且同样式，下载那颗改成「横屏」。所以这里钉住三件事：
 *   1. 工具条在画布上，只剩 复位 / 看高清 / 横屏，**下载下线**；
 *   2. 点看高清是「先带进度拉流、下完再换源」，不是把 13MB 直接塞给 img；
 *   3. 点横屏能把画布搬到 body 铺满视口，再点回得去。
 */
describe('智眸大图弹层 · 全景工具条（复位 / 看高清 / 横屏）', () => {
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
      time: '2026-11-15 12:10:54',
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

  it('工具条在画布上：看高清与复位并排，下载改成横屏', async () => {
    withPano()
    const w = await openPano()

    const tools = w.find('.pano-tools')
    expect(tools.exists()).toBe(true)
    const labels = tools.findAll('.pano-tool').map((b) => b.text())
    expect(labels).toContain('看高清')
    expect(labels).toContain('横屏')
    // 原来的「下载」整颗下线（全景要存相册走长按图片 / 系统菜单）
    expect(w.find('.photo-actions').exists()).toBe(false)
    expect(tools.text()).not.toContain('下载')
    // 体积不再挤在按钮上（弹层下方 meta 的「大小」已经写了 13.1MB）
    expect(tools.text()).not.toContain('13.1MB')
    w.unmount()
  })

  it('点「看高清」先拉流显示进度条，下完才换源', async () => {
    withPano()
    const w = await openPano()
    expect(w.find('.pano-stage img').attributes('src')).toContain('thumbnail')

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

    const btn = w.findAll('.pano-tool').find((b) => b.text().includes('看高清'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await nextTick()

    // 下载中：画布底边有真进度条（宽度来自已收字节，不是估算），按钮变成加载态
    expect(w.find('.hd-progress.is-in-stage').exists()).toBe(true)
    expect(w.findAll('.pano-tool').some((b) => b.text().includes('高清'))).toBe(true)

    release!()
    // 等解码兜底（happy-dom 不解码图片，走 preload 的 1.2s 超时）
    await new Promise((r) => setTimeout(r, 1400))
    await flushPromises()

    expect(w.find('.hd-progress.is-in-stage').exists()).toBe(false)
    expect(w.find('.pano-stage img').attributes('src')).not.toContain('thumbnail')
    w.unmount()
  })

  it('点「横屏」把画布搬到 body 铺满视口，再点「竖屏」回弹层', async () => {
    withPano()
    const w = await openPano()

    const stage = (): Element | null => document.body.querySelector('.pano-stage')
    const landBtn = (): HTMLButtonElement =>
      [...document.body.querySelectorAll('.pano-tool')].find((b) =>
        /横屏|竖屏/.test(b.textContent ?? ''),
      ) as HTMLButtonElement

    expect(stage()?.classList.contains('is-land')).toBe(false)

    landBtn().click()
    await nextTick()
    expect(stage()?.classList.contains('is-land')).toBe(true)
    // 弹层面板带 transform（popRise 收尾态），position:fixed 会被它当包含块 ——
    // 所以必须 Teleport 到 body 才能真正铺满视口
    expect(document.querySelector('.pop-panel .pano-stage')).toBeNull()
    expect(landBtn().textContent).toContain('竖屏')

    landBtn().click()
    await nextTick()
    expect(stage()?.classList.contains('is-land')).toBe(false)
    expect(document.querySelector('.pop-panel .pano-stage')).toBeTruthy()
    w.unmount()
  })
})
