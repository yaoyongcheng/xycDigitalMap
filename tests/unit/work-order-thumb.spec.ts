/**
 * 无人机预警 · 列表图标位（2026-11-20）
 *
 * 现场要求：无人机预警页图标位的**显示条件 / 状态映射 / 样式 / 交互**与
 * 「监控预警」页一致，且**原有的灰底占位图标一个字节都不能变**。
 *
 * 监控那边在 `InspectItem.vue`：滚到视口附近才取图 → 拿到铺 `.insp-pic`，
 * 没有就铺 `.insp-pic.alarm-tile`（灰底 + 深灰图标）+ 进度环 `ThumbRing`。
 * 这一组钉的就是同一套行为落在无人机这边：
 *
 *   ① 有现场图 → 缩成 96px 的 data URL 铺进图标位；
 *   ② 行里没有图 → **一个请求都不发**，继续铺那颗灰底无人机图标；
 *   ③ 403（签名 2h 过期）/ 404 → 结论，永久不再重试；
 *   ④ 断网 / 超时 → 暂时的，冷却 30s 后允许再试；
 *   ⑤ 同一行在今日 / 历史两个页签里各渲染一次，只下一个请求；
 *   ⑥ 登出清空（含落盘那份），不把现场照片留给下一个人。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applySession, clearSession, fetchWorkOrderPicture, type DroneWorkOrder } from '@/api/drone'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { dateKey } from '@/utils/date'
import { resetThumbReveal } from '@/utils/thumbReveal'
import WorkOrderList from '@/views/sub/WorkOrderList.vue'

/** 一段最小的 JPEG 字节（够 btoa 编码就行，happy-dom 不解码） */
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])

/** 造一条工单（今日）；`image` 默认给一个直链 */
function wo(n: number, patch: Partial<DroneWorkOrder> = {}): DroneWorkOrder {
  const d = new Date()
  const p = (v: number) => String(v).padStart(2, '0')
  return {
    id: `dp-${n}`,
    at: `${dateKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}:00`,
    title: '人员佩戴不规范',
    label: '人员佩戴不规范',
    jobName: '向阳村-安全巡检',
    projectName: '向阳村数字工地',
    status: 'UNAUDITED',
    auditType: 'MANUAL_AUDIT',
    level: 'NOTIFICATION_LEVEN_2',
    lng: '114.2651',
    lat: '30.5312',
    alt: '35',
    image: `https://oss.example.com/${n}.jpg`,
    recordId: String(900 + n),
    ...patch,
  }
}

/** 造一个带字节的图片响应（服务端 Content-Type 是 octet-stream，没有 Cache-Control） */
function picResponse(
  bytes: Uint8Array,
  opts: { total?: number; status?: number } = {},
): Response {
  const status = opts.status ?? 200
  const headers = new Headers()
  headers.set('content-type', 'application/octet-stream')
  if (opts.total !== undefined) headers.set('content-length', String(opts.total))
  return {
    ok: status < 300,
    status,
    headers,
    body: null,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response
}

/**
 * 可读流版：第二块卡在 `gate` 上，好在请求进行中断言「正在下载」与进度。
 * 与服务端一致地把 `Content-Length` 暴露给 CORS。
 */
function streamPic(bytes: Uint8Array, total = bytes.byteLength): {
  res: Response
  release: () => void
} {
  const half = Math.floor(bytes.length / 2)
  let step = 0
  let release = (): void => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      step += 1
      if (step === 1) return { done: false, value: bytes.slice(0, half) }
      if (step === 2) {
        await gate
        return { done: false, value: bytes.slice(half) }
      }
      return { done: true }
    },
  }
  const headers = new Headers()
  headers.set('content-length', String(total))
  const res = {
    ok: true,
    status: 200,
    headers,
    body: { getReader: () => reader },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response
  return { res, release }
}

beforeEach(() => {
  setActivePinia(createPinia())
  /*
   * happy-dom 装了一个永不回调的 `IntersectionObserver` 桩 —— 留着它，`revealThumb`
   * 就只会 observe、永远不触发加载。这里按「不支持观察器」的环境来测：
   * 那正是 `thumbReveal.ts` 里 budget 降级分支（立即加载前 30 条）的真实行为。
   */
  vi.stubGlobal('IntersectionObserver', undefined)
  resetThumbReveal()
  applySession({ uid: '42', token: 'TOKEN-1', expiresAt: Date.now() + 3_600_000 })
})

afterEach(async () => {
  await flushPromises()
  clearSession()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('工单现场图接口', () => {
  it('读字节转 data URL，并强制标成 image/jpeg（服务端给的是 octet-stream）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => picResponse(JPG)))

    const url = await fetchWorkOrderPicture('https://oss.example.com/1.jpg')

    // 少数内核会按 MIME 拒绝解码 octet-stream，所以类型必须改写
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(atob(url.split(',')[1]).length).toBe(JPG.byteLength)
  })

  it('有 Content-Length 时按真实字节报进度，最后补一次 1', async () => {
    // 第一块正好是半包 → 只能说 50%，能看出是「按字节算」而不是按块数估的
    const { res, release } = streamPic(JPG)
    vi.stubGlobal('fetch', vi.fn(async () => res))
    const seen: number[] = []

    const p = fetchWorkOrderPicture('https://oss.example.com/1.jpg', {
      onProgress: (r) => seen.push(Math.round(r * 100)),
    })
    await flushPromises()
    expect(seen[0]).toBe(50)

    release()
    await p
    expect(seen[seen.length - 1]).toBe(100)
  })

  it('403（签名过期）与 404 抛带状态码的错，调用方据此永久放弃', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => picResponse(JPG, { status: 403 })))
    await expect(fetchWorkOrderPicture('https://oss.example.com/1.jpg')).rejects.toMatchObject({
      code: 403,
      message: '现场图已失效',
    })

    vi.stubGlobal('fetch', vi.fn(async () => picResponse(JPG, { status: 404 })))
    await expect(fetchWorkOrderPicture('https://oss.example.com/1.jpg')).rejects.toMatchObject({
      code: 404,
    })
  })

  it('断网 / 超时是暂时性失败（code 0），不是「这张图没有」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(fetchWorkOrderPicture('https://oss.example.com/1.jpg')).rejects.toMatchObject({
      code: 0,
    })
  })

  it('没有直链就不发请求', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(fetchWorkOrderPicture('')).rejects.toMatchObject({ code: 0 })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('无人机预警 store · 缩略图', () => {
  it('取到图后 thumbOf 有值；同一行被两处引用只下一个请求', async () => {
    const drone = useDroneAlarmStore()
    drone.apply([wo(1)])
    const spy = vi.fn(async () => picResponse(JPG))
    vi.stubGlobal('fetch', spy)

    // 今日 / 历史两个页签同时在 DOM 里 → 同一行会被渲染两次
    drone.ensureThumb('dp-1')
    drone.ensureThumb('dp-1')
    drone.ensureThumb('dp-1')
    await flushPromises()
    await flushPromises()

    expect(spy).toHaveBeenCalledTimes(1)
    // happy-dom 没有 canvas 2d：缩不了就把原图当缩略图（仍是同一张图）
    expect(drone.thumbOf('dp-1').startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('行里本来就没有现场图：一个请求都不发，也不再重试', async () => {
    const drone = useDroneAlarmStore()
    drone.apply([wo(1, { image: '' })])
    const spy = vi.fn(async () => picResponse(JPG))
    vi.stubGlobal('fetch', spy)

    drone.ensureThumb('dp-1')
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    expect(drone.thumbOf('dp-1')).toBe('')

    drone.ensureThumb('dp-1')
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
  })

  it('403 是结论：滚动回来也不重复打', async () => {
    const drone = useDroneAlarmStore()
    drone.apply([wo(1)])
    const spy = vi.fn(async () => picResponse(JPG, { status: 403 }))
    vi.stubGlobal('fetch', spy)

    drone.ensureThumb('dp-1')
    await flushPromises()
    await flushPromises()
    expect(drone.thumbOf('dp-1')).toBe('')

    drone.ensureThumb('dp-1')
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('断网是暂时的：冷却 30s 内不重试，过了允许再来一次', async () => {
    const drone = useDroneAlarmStore()
    drone.apply([wo(1)])
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const spy = vi.fn(async () => picResponse(JPG))
    // 第一次：断网
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    drone.ensureThumb('dp-1')
    await flushPromises()
    await flushPromises()

    // 冷却期内再滚回来：不重试
    const offline = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    expect(offline).toHaveBeenCalledTimes(1)
    drone.ensureThumb('dp-1')
    await flushPromises()
    expect(offline).toHaveBeenCalledTimes(1)

    // 冷却过了、网络也回来了：应该能取到
    now.mockReturnValue(1_000_000 + 31_000)
    vi.stubGlobal('fetch', spy)
    drone.ensureThumb('dp-1')
    await flushPromises()
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(drone.thumbOf('dp-1')).not.toBe('')
  })

  it('登出清空缩略图与进度状态', async () => {
    const drone = useDroneAlarmStore()
    drone.apply([wo(1)])
    vi.stubGlobal('fetch', vi.fn(async () => picResponse(JPG)))

    drone.ensureThumb('dp-1')
    await flushPromises()
    await flushPromises()
    expect(drone.thumbOf('dp-1')).not.toBe('')

    drone.reset()
    expect(drone.thumbOf('dp-1')).toBe('')
    expect(drone.thumbBusyOf('dp-1')).toBe(false)
    expect(drone.thumbPctOf('dp-1')).toBe(0)
  })
})

describe('无人机预警列表 · 图标位', () => {
  it('有图铺缩略图；行里没图就铺原来那颗灰底占位图标；红点与图无关', async () => {
    const drone = useDroneAlarmStore()
    drone.apply([wo(1), wo(2, { image: '' })])
    vi.stubGlobal('fetch', vi.fn(async () => picResponse(JPG)))

    const w = mount(WorkOrderList)
    await flushPromises()
    await flushPromises()

    const items = w.findAll('.insp-pane:not(.insp-hist) .insp-item')
    expect(items).toHaveLength(2)

    // 第一条取到图：和监控列表同一个类名、同一个容器
    expect(items[0].find('.insp-pic-box img.insp-pic').exists()).toBe(true)
    expect(items[0].find('.alarm-tile').exists()).toBe(false)

    // 第二条本来就没图：灰底占位图标还在（只认身份图标的 svg，不数进度环）
    expect(items[1].find('.insp-pic.alarm-tile').exists()).toBe(true)
    expect(items[1].find('.alarm-tile > svg:not(.tile-ring)').exists()).toBe(true)

    // 红点只看状态，与有没有图无关
    expect(items[0].find('.insp-dot').exists()).toBe(true)
    expect(items[1].find('.insp-dot').exists()).toBe(true)
    w.unmount()
  })

  it('取图过程中在占位图标外圈挂进度环，图到了自动撤掉', async () => {
    const drone = useDroneAlarmStore()
    drone.apply([wo(1)])
    const { res, release } = streamPic(JPG, JPG.byteLength * 2)
    vi.stubGlobal('fetch', vi.fn(async () => res))

    // 先把请求发出去并卡在半路（Icon 位此时还是占位图标 + 环）
    drone.ensureThumb('dp-1')
    await flushPromises()
    await flushPromises()

    const w = mount(WorkOrderList)
    const box = () => w.find('.insp-pane:not(.insp-hist) .insp-item .insp-pic-box')
    expect(box().find('.tile-ring').exists()).toBe(true)
    expect(box().find('img').exists()).toBe(false)

    release()
    await flushPromises()
    await flushPromises()
    await flushPromises()

    expect(box().find('img.insp-pic').exists()).toBe(true)
    expect(box().find('.tile-ring').exists()).toBe(false)
    w.unmount()
  })

  it('历史条目同样铺图，但不带红点（与监控历史一致）', async () => {
    const drone = useDroneAlarmStore()
    const d = new Date(Date.now() - 86_400_000)
    const p = (v: number) => String(v).padStart(2, '0')
    drone.apply([
      wo(1),
      wo(2, { at: `${dateKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}:00` }),
    ])
    vi.stubGlobal('fetch', vi.fn(async () => picResponse(JPG)))

    const w = mount(WorkOrderList)
    await flushPromises()
    await flushPromises()

    await w.find('[data-wo-tab="hist"]').trigger('click')
    const hist = w.findAll('.insp-hist .insp-item')
    expect(hist).toHaveLength(1)
    expect(hist[0].find('.insp-dot').exists()).toBe(false)
    expect(hist[0].find('.insp-pic-box').exists()).toBe(true)
    w.unmount()
  })
})
