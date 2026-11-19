/**
 * 场景截图底图（2D / 3D）—— 2026-11-18 接入
 *
 * 这一组钉住四件事，全是「改错了页面也不会报错、但用户看到的是错的图」那类：
 *   ① 请求真的带上了 `X-API-Key`，并且地址/参数与文档一致（密钥不放 URL）；
 *   ② 返回的字节要转成 Blob 才可能塞进 `<img>`（`<img>` 无法带请求头）；
 *   ③ 404「该项目没上传」与「网络挂了 / 密钥失效」必须分开，前者安静回落；
 *   ④ 取不到时回落到内置 site-map / site-flat，布局与首屏观感不变。
 *
 * 另外两条工程约束：一次会话内每个类型只下一次（3MB 量级，切来切去不能重复）；
 * 强制重取要 revoke 掉旧 objectURL（否则每刷一次就多留一张在内存里）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { fetchSceneBlob, SCENE_BASE, SCENE_KEY, SCENE_PID, SceneNotFoundError } from '@/api/scene'
import MapLand from '@/components/overlays/MapLand.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useSceneStore } from '@/stores/scene'
import { useShellStore } from '@/stores/shell'
import { clearSceneCache, fingerprint, readSceneCache, writeSceneCache } from '@/utils/sceneCache'
import { stubImageLoader } from '../helpers/browser'
import { alarmFixtures } from '../fixtures/alarms'

/**
 * 落盘写入用可断言的包装（读取与指纹用真实现，行为不变）：
 * 「同一张图不重复写」只能靠调用次数证明 —— 内存副本反正会被覆盖。
 */
vi.mock('@/utils/sceneCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/sceneCache')>()
  return { ...actual, writeSceneCache: vi.fn(actual.writeSceneCache) }
})

/** 一张「图片」响应：够 api 层校验 content-type 与体积；`salt` 换字节内容 */
function imgBlob(size = 1024, salt = 0, type = 'image/png'): Blob {
  const bytes = new Uint8Array(size)
  if (salt) bytes.fill(salt)
  return new Blob([bytes], { type })
}

function imgResponse(size = 1024, type = 'image/png', status = 200, salt = 0): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? type : null) },
    blob: async () => imgBlob(size, salt, type),
  } as unknown as Response
}

/** objectURL 桩：返回可预测的地址，并记录创建 / 释放 */
function stubObjectUrl(): { created: string[]; revoked: string[] } {
  const created: string[] = []
  const revoked: string[] = []
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:scene/${++n}`
    created.push(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
    revoked.push(u)
  })
  return { created, revoked }
}

describe('场景截图接口', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('地址、请求方式与鉴权头照文档来：X-API-Key 走请求头，不进 URL', async () => {
    const spy = vi.fn(async () => imgResponse())
    vi.stubGlobal('fetch', spy)

    const blob = await fetchSceneBlob('2d')
    expect(blob.size).toBe(1024)

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SCENE_BASE}/content?pid=${SCENE_PID}&type=2d`)
    expect(url).not.toContain(SCENE_KEY)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe(SCENE_KEY)
  })

  it('3d 只是换 type 参数，走同一个 /content 端点', async () => {
    const spy = vi.fn(async (url: string) => {
      expect(url).toContain('type=3d')
      expect(url).toContain('/content?')
      return imgResponse()
    })
    vi.stubGlobal('fetch', spy)

    await fetchSceneBlob('3d')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('404 = 该项目这个类型还没上传，单独一个错误类型（不能当成"网络挂了"）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(0, 'text/plain', 404)),
    )

    await expect(fetchSceneBlob('2d')).rejects.toBeInstanceOf(SceneNotFoundError)
  })

  it('401 密钥无效 / 403 无权限：带上状态码与可读说明', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(0, 'text/plain', 401)),
    )
    await expect(fetchSceneBlob('3d')).rejects.toMatchObject({ code: 401 })
    await expect(fetchSceneBlob('3d')).rejects.toThrow(/密钥/)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(0, 'text/plain', 403)),
    )
    await expect(fetchSceneBlob('3d')).rejects.toMatchObject({ code: 403 })
  })

  it('200 但不是图片 / 空文件：都要当失败，不能把坏字节塞给 img', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(10, 'application/json')),
    )
    await expect(fetchSceneBlob('3d')).rejects.toThrow(/没有返回图片/)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(0)),
    )
    await expect(fetchSceneBlob('3d')).rejects.toThrow(/空文件/)
  })

  it('网络层失败（跨域被拦 / 断网）收敛成可读错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(fetchSceneBlob('3d')).rejects.toMatchObject({ code: 0 })
    await expect(fetchSceneBlob('3d')).rejects.toThrow(/网络|跨域/)
  })
})

describe('场景截图 store', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    // 本地兜底图是跨实例（模块级内存副本）的，用例之间必须清干净，
    // 否则前一条留下的「兜底图」会让后一条走「同图不换」分支
    await clearSceneCache()
    vi.mocked(writeSceneCache).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('取成功后 src 换成 blob 地址，内置底图不再使用', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse()),
    )

    const scene = useSceneStore()
    // 未取之前：内置 site-map 兜底
    expect(scene.src('3d')).toContain('img/site-map.webp')
    expect(scene.isLive('3d')).toBe(false)

    await scene.load('3d')

    expect(scene.state('3d')).toBe('ok')
    expect(scene.isLive('3d')).toBe(true)
    expect(scene.src('3d')).toBe('blob:scene/1')
    expect(scene.src('2d')).toContain('img/site-flat.webp')
  })

  it('一次会话只下一次：成功后普通 load 不再请求，并发调用也只发一次', async () => {
    stubObjectUrl()
    const spy = vi.fn(async () => imgResponse())
    vi.stubGlobal('fetch', spy)

    const scene = useSceneStore()
    await Promise.all([scene.load('3d'), scene.load('3d')])
    expect(spy).toHaveBeenCalledTimes(1)

    await scene.load('3d')
    expect(spy).toHaveBeenCalledTimes(1)

    // force 才重取，并且要撤掉旧的 objectURL
    await scene.load('3d', true)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('404（未上传）：状态 empty、回落到内置底图，且不会被反复重试', async () => {
    stubObjectUrl()
    const spy = vi.fn(async () => imgResponse(0, 'text/plain', 404))
    vi.stubGlobal('fetch', spy)

    const scene = useSceneStore()
    await scene.load('2d')

    expect(scene.state('2d')).toBe('empty')
    expect(scene.note('2d')).toContain('还没有上传')
    expect(scene.src('2d')).toContain('img/site-flat.webp')

    await scene.load('2d')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('断网：状态 error、保留内置底图；已有旧图时刷新失败不清图', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    const scene = useSceneStore()
    await scene.load('3d')
    expect(scene.state('3d')).toBe('error')
    expect(scene.src('3d')).toContain('img/site-map.webp')

    // 先成功一次，再让网络挂掉后 force 重取：旧图必须留着
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse()),
    )
    await scene.load('3d', true)
    const live = scene.src('3d')
    expect(live).toBe('blob:scene/1')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await scene.load('3d', true)
    expect(scene.state('3d')).toBe('error')
    expect(scene.src('3d')).toBe(live)
  })

  it('reset 撤掉 objectURL 并回到 idle', async () => {
    const { revoked } = stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse()),
    )

    const scene = useSceneStore()
    await scene.load('3d')
    scene.reset()

    expect(revoked).toEqual(['blob:scene/1'])
    expect(scene.state('3d')).toBe('idle')
    expect(scene.src('3d')).toContain('img/site-map.webp')
  })
})

describe('本地兜底图：比对、替换与降级', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    await clearSceneCache()
    vi.mocked(writeSceneCache).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('首次没有本地兜底图：直接显示接口图，并把它存成兜底图', async () => {
    const { created } = stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(2048, 'image/png', 200, 1)),
    )

    const scene = useSceneStore()
    await scene.load('3d')

    expect(scene.src('3d')).toBe('blob:scene/1')
    expect(scene.state('3d')).toBe('ok')
    expect(created).toHaveLength(1)

    const saved = await readSceneCache('3d')
    expect(saved?.blob.size).toBe(2048)
    expect(saved?.hash).toBe(await fingerprint(imgBlob(2048, 1)))
    expect(vi.mocked(writeSceneCache)).toHaveBeenCalledTimes(1)
  })

  it('刷新后接口回同一张：先上兜底图，比对一致就不换 URL、不重写', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(2048, 'image/png', 200, 1)),
    )
    await useSceneStore().load('3d')
    expect(vi.mocked(writeSceneCache)).toHaveBeenCalledTimes(1)

    // 模拟刷新：新 store 实例，但本地兜底图还在
    setActivePinia(createPinia())
    vi.mocked(writeSceneCache).mockClear()
    const { created, revoked } = stubObjectUrl()

    const scene = useSceneStore()
    await scene.load('3d')

    // 只有「挂载兜底图」这一次 objectURL，接口那张没有被再建一次
    expect(created).toEqual(['blob:scene/1'])
    expect(revoked).toEqual([])
    expect(scene.src('3d')).toBe('blob:scene/1')
    expect(scene.state('3d')).toBe('ok')
    // 关键：指纹相同 → 一次都不写
    expect(vi.mocked(writeSceneCache)).not.toHaveBeenCalled()
  })

  it('接口回新图：立即换成新图，并用它替换兜底图', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(2048, 'image/png', 200, 1)),
    )
    await useSceneStore().load('3d')
    const oldHash = (await readSceneCache('3d'))?.hash

    setActivePinia(createPinia())
    vi.mocked(writeSceneCache).mockClear()
    const { created, revoked } = stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(2048, 'image/png', 200, 2)),
    )

    const scene = useSceneStore()
    await scene.load('3d')

    // 「兜底图」与「新图」各建一次 URL，旧的自然释放
    expect(created).toEqual(['blob:scene/1', 'blob:scene/2'])
    expect(revoked).toEqual(['blob:scene/1'])
    expect(scene.src('3d')).toBe('blob:scene/2')

    const saved = await readSceneCache('3d')
    expect(saved?.hash).toBe(await fingerprint(imgBlob(2048, 2)))
    expect(saved?.hash).not.toBe(oldHash)
    expect(vi.mocked(writeSceneCache)).toHaveBeenCalledTimes(1)
  })

  it('接口字节解不出图（下载不完整）：保留兜底图，也不覆盖它', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(2048, 'image/png', 200, 1)),
    )
    await useSceneStore().load('3d')
    const before = (await readSceneCache('3d'))?.hash

    setActivePinia(createPinia())
    vi.mocked(writeSceneCache).mockClear()
    stubObjectUrl()
    // 明确解码失败：等价于截断/损坏的 PNG
    class BadImage {
      src = ''
      decode(): Promise<void> {
        return Promise.reject(new Error('EncodingError'))
      }
    }
    vi.stubGlobal('Image', BadImage as unknown as typeof Image)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(2048, 'image/png', 200, 2)),
    )

    const scene = useSceneStore()
    await scene.load('3d')

    // 画面还是兜底图，坏图既没上屏也没落盘
    expect(scene.state('3d')).toBe('cache')
    expect(scene.note('3d')).toMatch(/解码/)
    expect(scene.src('3d')).toBe('blob:scene/1')
    expect(vi.mocked(writeSceneCache)).not.toHaveBeenCalled()
    expect((await readSceneCache('3d'))?.hash).toBe(before)
  })

  it('接口挂了但有兜底图：画面继续用兜底图，不退回打包图', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(2048, 'image/png', 200, 1)),
    )
    await useSceneStore().load('3d')

    setActivePinia(createPinia())
    const { created } = stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline')
      }),
    )

    const scene = useSceneStore()
    await scene.load('3d')

    expect(scene.state('3d')).toBe('error')
    expect(scene.note('3d')).toMatch(/网络|跨域/)
    expect(scene.src('3d')).toBe('blob:scene/1')
    expect(created).toHaveLength(1)
  })

  it('接口 404（本项目没上传）但有兜底图：也是继续显示兜底图', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(2048, 'image/png', 200, 1)),
    )
    await useSceneStore().load('3d')

    setActivePinia(createPinia())
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(0, 'text/plain', 404)),
    )

    const scene = useSceneStore()
    await scene.load('3d')

    expect(scene.state('3d')).toBe('empty')
    expect(scene.src('3d')).toBe('blob:scene/1')
  })

  it('接口返回空文件且本地没有兜底图：落到打包图，也不写缓存', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(0)),
    )

    const scene = useSceneStore()
    await scene.load('3d')

    expect(scene.state('3d')).toBe('error')
    expect(scene.note('3d')).toMatch(/空文件/)
    expect(scene.src('3d')).toContain('img/site-map.webp')
    expect(vi.mocked(writeSceneCache)).not.toHaveBeenCalled()
    expect(await readSceneCache('3d')).toBeNull()
  })

  it('reset 之后重新 load：会重新从兜底图恢复（不残留上次的 objectURL）', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imgResponse(2048, 'image/png', 200, 1)),
    )
    const scene = useSceneStore()
    await scene.load('3d')
    scene.reset()
    expect(scene.src('3d')).toContain('img/site-map.webp')

    const { created } = stubObjectUrl()
    await scene.load('3d')
    expect(created).toEqual(['blob:scene/1'])
    expect(scene.src('3d')).toBe('blob:scene/1')
  })
})

describe('场景截图指纹', () => {
  it('同样的字节 → 同一个指纹；换一版字节 → 不同指纹', async () => {
    expect(await fingerprint(imgBlob(4096, 7))).toBe(await fingerprint(imgBlob(4096, 7)))
    expect(await fingerprint(imgBlob(4096, 7))).not.toBe(await fingerprint(imgBlob(4096, 8)))
    // 体积也是判等的一部分：只改尾部内容同样要判成不同
    expect(await fingerprint(imgBlob(4096, 7))).not.toBe(await fingerprint(imgBlob(5000, 7)))
  })

  it('空 Blob 给一个固定的空标记，不抛错', async () => {
    await expect(fingerprint(new Blob([]))).resolves.toBe('empty')
  })
})

describe('全屏地图用接口底图', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    await clearSceneCache()
    useAlarmStore().liveAlarms = alarmFixtures()
    // 换底图要等新图「像素就绪」才上屏（见 MapViewer 的双缓冲），
    // happy-dom 的 Image 不会加载，这里给同步 onload
    stubImageLoader()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('打开全屏 → 三维底图是接口图；点二维才去取 2D 并切过去', async () => {
    stubObjectUrl()
    const spy = vi.fn(async (_url: string) => imgResponse(2048, 'image/png'))
    vi.stubGlobal('fetch', spy)

    useShellStore().openMapLand()
    const w = mount(MapLand)
    await flushPromises()
    await nextTick()

    // 三维：接口图（不是内置 site-map.webp）
    expect(w.find('.map-canvas img.is-front').attributes('src')).toBe('blob:scene/1')
    expect(String(spy.mock.calls[0]?.[0])).toContain('type=3d')

    // 切二维：这时才发第二个请求
    await w.find('.map-land-flat').trigger('click')
    await flushPromises()
    await nextTick()

    expect(w.find('.map-canvas img.is-front').attributes('src')).toBe('blob:scene/2')
    expect(String(spy.mock.calls[1]?.[0])).toContain('type=2d')
    expect(w.find('.map-land').classes()).toContain('is-flat')
    w.unmount()
  })

  it('接口全挂时仍显示内置底图，切换逻辑不受影响', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline')
      }),
    )

    useShellStore().openMapLand()
    const w = mount(MapLand)
    await flushPromises()
    await nextTick()

    expect(w.find('.map-canvas img.is-front').attributes('src')).toContain('site-map.webp')

    await w.find('.map-land-flat').trigger('click')
    await flushPromises()
    await nextTick()

    expect(w.find('.map-canvas img.is-front').attributes('src')).toContain('site-flat.webp')
    expect(w.find('.map-land-flat').text()).toBe('三维地图')
    w.unmount()
  })
})
