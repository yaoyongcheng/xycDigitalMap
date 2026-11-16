import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchBlobWithProgress } from '@/utils/blobFetch'
import {
  clampFov,
  clampPitch,
  degPerPixel,
  isEquirect,
  PANO_TEX_MAX_PX,
  panoLabel,
  panoTexScale,
  wrapYaw,
} from '@/utils/pano'

/**
 * 全景判定与环视数学（2026-11-16）
 *
 * 这些断言的源头是实测数据：本项目 12 条航线的**原片**（媒体接口）逐条抽样，
 * 尺寸全是 4032×3024 或 4000×3000 —— 一条 2:1 都没有。真正的 2:1 是平台拼好的
 * 重建成果（`origin.jpg` 10000×5000 / 缩略图 3162×1581），那条链不走这里。
 * 判定因此只能按几何形状做，而"4:3 不能进球面"正是最要紧的一条：
 * 判错会把普通照片糊成一圈畸变画面。
 */
describe('isEquirect（2:1 才认作球面全景）', () => {
  it('真全景（2:1）通过', () => {
    expect(isEquirect(8192, 4096)).toBe(true)
    expect(isEquirect(4096, 2048)).toBe(true)
    // 容差边界：服务端导出常带 1~2 像素的零头
    expect(isEquirect(4090, 2048)).toBe(true)
  })

  it('现场实际尺寸（4:3 / 4:3.03）一律不是全景', () => {
    // 实测：全景航线 4032×3024、塔吊定点 4000×3000
    expect(isEquirect(4032, 3024)).toBe(false)
    expect(isEquirect(4000, 3000)).toBe(false)
    expect(isEquirect(1920, 1080)).toBe(false)
  })

  it('尺寸拿不到时按「不是全景」处理（宁可按平面看）', () => {
    expect(isEquirect(0, 0)).toBe(false)
    expect(isEquirect(Number.NaN, 4096)).toBe(false)
    expect(isEquirect(-8192, 4096)).toBe(false)
  })

  it('小图即使 2:1 也不算（缩略图不是全景资产）', () => {
    expect(isEquirect(512, 256)).toBe(false)
  })
})

describe('环视角度', () => {
  it('俯仰夹在 ±85°，越界会在天顶翻面', () => {
    expect(clampPitch(120)).toBe(85)
    expect(clampPitch(-120)).toBe(-85)
    expect(clampPitch(30)).toBe(30)
  })

  it('水平角归一到 [0, 360)，连续拖动不会越滚越大', () => {
    expect(wrapYaw(370)).toBe(10)
    expect(wrapYaw(-10)).toBe(350)
    expect(wrapYaw(720)).toBe(0)
    expect(wrapYaw(0)).toBe(0)
  })

  it('视场角夹在 25°~100°', () => {
    expect(clampFov(5)).toBe(25)
    expect(clampFov(180)).toBe(100)
    expect(clampFov(60)).toBe(60)
  })

  it('像素→角度按垂直视场角 / 视口高度算；视口为 0 时不除零', () => {
    expect(degPerPixel(75, 750)).toBeCloseTo(0.1, 5)
    expect(degPerPixel(75, 0)).toBe(0)
    // 违反范围先夹住：传 200° 视场角等于 100°
    expect(degPerPixel(200, 500)).toBeCloseTo(0.2, 5)
  })
})

/**
 * 带进度的二进制拉取
 *
 * 进度必须是"已收字节 / Content-Length"，不能是估算值 —— 原图 4~8MB，
 * 手机上那十几秒里用户只看这一条信息。
 */
describe('fetchBlobWithProgress', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function streamRes(chunks: Uint8Array[], len: string | null): unknown {
    let i = 0
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? len : 'image/jpeg') },
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        }),
      },
    }
  }

  it('边读边报累计字节与总长度，最后拼成 Blob', async () => {
    const chunks = [new Uint8Array(3), new Uint8Array(5)]
    vi.stubGlobal('fetch', vi.fn(async () => streamRes(chunks, '8')))
    const seen: Array<[number, number | null]> = []
    const blob = await fetchBlobWithProgress('https://oss.keehang.com/x.jpeg', (loaded, total) =>
      seen.push([loaded, total]),
    )

    expect(seen).toEqual([
      [3, 8],
      [8, 8],
    ])
    expect(blob.size).toBe(8)
  })

  it('服务端没给 Content-Length 时 total 是 null（页面不硬凑百分比）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamRes([new Uint8Array(4)], null)))
    const seen: Array<number | null> = []
    await fetchBlobWithProgress('https://oss.keehang.com/x.jpeg', (_l, total) => seen.push(total))
    expect(seen.every((t) => t === null)).toBe(true)
  })

  it('HTTP 失败往上抛（调用方自己决定退回直链）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, headers: { get: () => null } })))
    await expect(fetchBlobWithProgress('https://oss.keehang.com/x.jpeg')).rejects.toThrow('HTTP 403')
  })
})

describe('panoLabel（服务端任务名 → 界面标题）', () => {
  it('去掉末尾的执行记录 id', () => {
    expect(panoLabel('光谷元著-全景_202611151300181656')).toBe('光谷元著-全景')
    expect(panoLabel('向阳村-全景_202611151130181616')).toBe('向阳村-全景')
  })

  it('没有 id 后缀就原样返回（不误删航线名里的下划线）', () => {
    expect(panoLabel('向阳村-全景')).toBe('向阳村-全景')
    expect(panoLabel('向阳村_土方1')).toBe('向阳村_土方1')
    expect(panoLabel('')).toBe('')
  })
})

describe('panoTexScale（贴图上传前缩到显卡吃得下的尺寸）', () => {
  it('现场原图 10000×5000 在 8192 上限的设备上必须缩（不缩就整屏黑）', () => {
    // 这是实测踩到的坑：SwiftShader / 多数手机 GPU 的 MAX_TEXTURE_SIZE 是 8192，
    // 10000×5000 直接 texImage2D INVALID_VALUE，贴图不完整 → 画面全黑
    const k = panoTexScale(10000, 5000, 8192)
    expect(k).toBeLessThan(1)
    expect(Math.round(10000 * k)).toBeLessThanOrEqual(8192)
    expect(Math.round(5000 * k)).toBeLessThanOrEqual(8192)
  })

  it('边长没超限也要受像素预算约束（8192×4096 是 134MB，会 OOM）', () => {
    const k = panoTexScale(8192, 4096, 16384)
    expect(k).toBeLessThan(1)
    expect(8192 * k * 4096 * k).toBeLessThanOrEqual(PANO_TEX_MAX_PX * 1.001)
  })

  it('缩略图 3162×1581 不缩（本来就在预算内）', () => {
    expect(panoTexScale(3162, 1581, 8192)).toBe(1)
  })

  it('尺寸拿不到时返回 1，交给调用方自己兜底', () => {
    expect(panoTexScale(0, 0, 8192)).toBe(1)
    expect(panoTexScale(Number.NaN, 100, 8192)).toBe(1)
    expect(panoTexScale(100, 100, Number.NaN)).toBeLessThanOrEqual(1)
  })
})
