/**
 * 报警缩略图（2026-11-19）
 *
 * 现场要求：报警预警列表、消息列表、首页「报警预警」轮播的图标位，都换成
 * **该条报警详情页里那张抓拍图**的缩略图。
 *
 * 这一组钉三件事：
 *   ① 同一条报警被三个列表同时引用时，接口只打一次（不能三份 1MB）；
 *   ② 没有抓拍图就保持空 —— 页面继续用原来的分类示意图，且不会每次滚动重试；
 *   ③ 登出清空，不把现场照片留在内存里。
 */
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearPictureCache } from '@/api/video'
import { useAlarmStore } from '@/stores/alarm'
import { shrinkDataUrl } from '@/utils/imageThumb'
import { toAlarms } from '@/utils/videoAlarm'

/** 截图接口走 text()，且返回的是 JSON 信封（base64 在 data.pictureData） */
function rawText(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response
}

/** 一段足够长的 base64（fetchAlarmPicture 有 64 字符下限防呆） */
const B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUf' +
  'GhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgo' +
  'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAA' +
  'AAAAAAAK/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/'

const PICTURE_OK = { code: 200, message: 'success', data: { id: 101, pictureData: B64 } }

describe('报警缩略图', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearPictureCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearPictureCache()
  })

  /** 种一条真实形状的报警进 store（id 会被包成 `va-101`） */
  function seed(id = '101'): string {
    const [a] = toAlarms([
      {
        id,
        alertName: '未戴安全帽',
        alertType: 1,
        captureTime: '2026-11-19 10:00:00',
        handleStatus: 0,
        channelNo: 3,
        deviceNo: '06d0680610086',
      },
    ])
    useAlarmStore().appendLive([a!])
    return a!.id
  }

  it('三个列表引用同一条报警：接口只打一次，结果缓存复用', async () => {
    const alarm = useAlarmStore()
    const id = seed()

    const spy = vi.fn(async () => rawText(PICTURE_OK))
    vi.stubGlobal('fetch', spy)

    // 首页轮播 / 消息页 / 报警预警列表会各调一次
    alarm.ensureThumb('t', id)
    alarm.ensureThumb('t', id)
    alarm.ensureThumb('t', id)
    await flushPromises()
    await flushPromises()

    expect(spy).toHaveBeenCalledTimes(1)
    // happy-dom 没有 canvas 2d：缩不了就把原图当缩略图（仍是同一张图）
    expect(alarm.thumbOf(id)).toBe(`data:image/jpeg;base64,${B64}`)
  })

  it('该条没有抓拍图：thumbOf 保持空（页面继续用原示意图），且不再重试', async () => {
    const alarm = useAlarmStore()
    const id = seed('102')

    // 200 但没有 pictureData —— 现场确实存在这种记录
    const spy = vi.fn(async () => rawText({ code: 200, message: 'success', data: { id: 102 } }))
    vi.stubGlobal('fetch', spy)

    alarm.ensureThumb('t', id)
    await flushPromises()
    await flushPromises()
    expect(alarm.thumbOf(id)).toBe('')

    // 滚动再来一次：不许重复打「必然失败」的请求
    alarm.ensureThumb('t', id)
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('没有 token / 不是视频报警：一个请求都不发', async () => {
    const alarm = useAlarmStore()
    const id = seed('103')
    const spy = vi.fn(async () => rawText(PICTURE_OK))
    vi.stubGlobal('fetch', spy)

    alarm.ensureThumb('', id)
    alarm.ensureThumb('t', '')
    alarm.ensureThumb('t', 'not-an-alarm')
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
  })

  it('登出清空缩略图，不把现场照片留给下一个人', async () => {
    const alarm = useAlarmStore()
    const id = seed('104')
    vi.stubGlobal('fetch', vi.fn(async () => rawText(PICTURE_OK)))

    alarm.ensureThumb('t', id)
    await flushPromises()
    await flushPromises()
    expect(alarm.thumbOf(id)).not.toBe('')

    alarm.clearLive()
    expect(alarm.thumbOf(id)).toBe('')
    expect(alarm.hasLive).toBe(false)
  })

  it('缩不了（无 canvas 2d）时原样返回，不退化成空串', async () => {
    const url = `data:image/jpeg;base64,${B64}`
    await expect(shrinkDataUrl(url)).resolves.toBe(url)
    await expect(shrinkDataUrl('')).resolves.toBe('')
  })

  /* ---------- 占位图标上的下载进度（2026-11-19） ---------- */

  /**
   * 造一个「可读流 + Content-Length」的响应。
   *
   * 第二块故意卡在 `gate` 上，好让测试在请求进行中断言进度状态 —— 否则
   * happy-dom 里两次 microtask 就跑完，只能看到最终结果。
   */
  function streamResponse(opts: { total?: number } = {}): {
    res: Response
    release: () => void
  } {
    const bytes = new TextEncoder().encode(JSON.stringify(PICTURE_OK))
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
    if (opts.total) headers.set('content-length', String(opts.total))
    const res = {
      ok: true,
      status: 200,
      headers,
      body: { getReader: () => reader },
      text: async () => JSON.stringify(PICTURE_OK),
    } as unknown as Response
    return { res, release }
  }

  it('下载中把真实百分比写进 store，图到了自动清空', async () => {
    const alarm = useAlarmStore()
    const id = seed('105')
    // 分母放大一倍：第一块到 25%，能看出「按真实字节算」而不是估算
    const { res, release } = streamResponse({ total: 400 })
    vi.stubGlobal('fetch', vi.fn(async () => res))

    alarm.ensureThumb('t', id)
    await flushPromises()
    await flushPromises()

    expect(alarm.thumbBusyOf(id)).toBe(true)
    expect(alarm.thumbPctOf(id)).toBeGreaterThan(0)

    release()
    await flushPromises()
    await flushPromises()
    await flushPromises()

    expect(alarm.thumbOf(id)).toBe(`data:image/jpeg;base64,${B64}`)
    // 图到了就不该再挂着「加载中」——否则图标位上会一直有一圈弧
    expect(alarm.thumbBusyOf(id)).toBe(false)
    expect(alarm.thumbPctOf(id)).toBe(0)
  })

  it('没有 Content-Length：不编百分比，只报「在下载」', async () => {
    const alarm = useAlarmStore()
    const id = seed('106')
    const { res, release } = streamResponse()
    vi.stubGlobal('fetch', vi.fn(async () => res))

    alarm.ensureThumb('t', id)
    await flushPromises()
    await flushPromises()

    expect(alarm.thumbBusyOf(id)).toBe(true)
    expect(alarm.thumbPctOf(id)).toBe(0)

    release()
    await flushPromises()
    await flushPromises()
    await flushPromises()
    expect(alarm.thumbBusyOf(id)).toBe(false)
  })

  it('登出时进度状态一并清空', async () => {
    const alarm = useAlarmStore()
    const id = seed('107')
    const { res } = streamResponse({ total: 400 })
    vi.stubGlobal('fetch', vi.fn(async () => res))

    alarm.ensureThumb('t', id)
    await flushPromises()
    await flushPromises()
    expect(alarm.thumbBusyOf(id)).toBe(true)

    alarm.clearLive()
    expect(alarm.thumbBusyOf(id)).toBe(false)
    expect(alarm.thumbPctOf(id)).toBe(0)
  })
})
