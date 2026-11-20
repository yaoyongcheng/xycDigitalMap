import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearShots,
  ensureShot,
  getShot,
  latestShot,
  listCachedShots,
  makeThumb,
  prune,
  saveShot,
  shotKey,
  SHOT_KEEP_DAYS,
} from '@/utils/shotArchive'

/**
 * 历史抓拍数据层（2026-11-20 改走服务端历史接口）
 *
 * 这一层只干两件事：① 把服务端列表里的 `mark` 对应的图片缓存到本机（缩略图 + 原图）；
 * ② 提供「缓存优先、没有再下」的唯一取图入口 `ensureShot`。
 *
 * 钉住的是「改错了页面也不报错、但用户看到的是旧图 / 白图」那类：
 * 主键对不对、同一张会不会重复下、换了字节会不会覆盖、淘汰会不会把新的删了。
 *
 * 单测环境没有 IndexedDB（happy-dom），走的是内存兜底分支；两条分支行为一致。
 */
function jpg(size = 300): Blob {
  return new Blob([new Uint8Array(size)], { type: 'image/jpeg' })
}

/** 2026-11-19 12:00 本地时间（抓拍时刻的基准） */
const T = new Date(2026, 10, 19, 12, 0, 0).getTime()
const MARK = '20261119120000'

/** 图片响应：照实测带 `X-Snapshot-Mark` / `X-Snapshot-Time` */
function imgResponse(size = 300, mark = MARK): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase()
        if (key === 'content-type') return 'image/jpeg'
        if (key === 'x-snapshot-mark') return mark
        if (key === 'x-snapshot-time') return '2026-11-19T12:00:00+08:00'
        return null
      },
    },
    blob: async () => jpg(size),
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response
}

describe('utils/shotArchive', () => {
  beforeEach(async () => {
    await clearShots()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('saveShot / getShot', () => {
    it('主键是「通道|mark」，时刻与自然日都按服务端给的算', async () => {
      const rec = await saveShot('ch1', MARK, T, jpg(300))
      expect(rec.key).toBe(shotKey('ch1', MARK))
      expect(rec.key).toBe('ch1|20261119120000')
      expect(rec.day).toBe('2026-11-19')
      expect(rec.at).toBe(T)
      expect(rec.size).toBe(300)
      expect((await getShot('ch1', MARK))?.mark).toBe(MARK)
      // 换通道同 mark 是另一条
      expect(await getShot('ch2', MARK)).toBeNull()
    })

    it('同一 mark 同样大小：不重复存，保留原来的缩略图', async () => {
      const first = await saveShot('ch1', MARK, T, jpg(300))
      const again = await saveShot('ch1', MARK, T + 60_000, jpg(300))
      expect(again.thumb).toBe(first.thumb)
      expect(again.at).toBe(T)
    })

    it('同一 mark 字节变了（服务端换了图）：覆盖并记新时刻', async () => {
      await saveShot('ch1', MARK, T, jpg(300))
      const next = await saveShot('ch1', MARK, T + 120_000, jpg(420))
      expect(next.size).toBe(420)
      expect(next.at).toBe(T + 120_000)
      expect((await listCachedShots('ch1', '2026-11-19')).length).toBe(1)
    })

    it('listCachedShots 只回该通道该天，按抓拍时刻倒序', async () => {
      const at = (h: number): number => new Date(2026, 10, 19, h, 0, 0).getTime()
      await saveShot('ch1', '20261119080000', at(8), jpg(100))
      await saveShot('ch1', '20261119180000', at(18), jpg(100))
      await saveShot('ch1', '20261119120000', at(12), jpg(100))
      await saveShot('ch2', '20261119120000', at(12), jpg(100))
      await saveShot('ch1', '20261118120000', new Date(2026, 10, 18, 12).getTime(), jpg(100))

      const rows = await listCachedShots('ch1', '2026-11-19')
      expect(rows.map((r) => r.mark)).toEqual([
        '20261119180000',
        '20261119120000',
        '20261119080000',
      ])
      expect(rows.every((r) => r.channelId === 'ch1' && r.day === '2026-11-19')).toBe(true)
    })
  })

  describe('ensureShot：缓存优先的唯一取图入口', () => {
    it('缓存命中且字节数一致：不再发请求', async () => {
      await saveShot('ch1', MARK, T, jpg(300))
      const spy = vi.fn(async () => imgResponse(300))
      vi.stubGlobal('fetch', spy)

      const rec = await ensureShot('ch1', { mark: MARK, at: T, size: 300, imageUrl: '/x' })
      expect(rec.size).toBe(300)
      expect(spy).not.toHaveBeenCalled()
    })

    it('缓存没有：按行里的 imageUrl 取图并落缓存（带 X-API-Key，不把密钥放 URL）', async () => {
      const spy = vi.fn(async () => imgResponse(300))
      vi.stubGlobal('fetch', spy)

      const rec = await ensureShot('ch1', {
        mark: MARK,
        at: T,
        size: 300,
        imageUrl: `/api/video/snapshots?channelId=ch1&mark=${MARK}&pid=P000000076`,
      })

      expect(rec.size).toBe(300)
      expect(spy).toHaveBeenCalledTimes(1)
      const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
      expect(String(url)).toContain('/api/video/snapshots?channelId=ch1')
      expect(String(url)).toContain(`mark=${MARK}`)
      expect(String(url)).not.toContain('1c7582231acd998de531f61d6cf1127')
      expect((init.headers as Record<string, string>)['X-API-Key']).toBeTruthy()
      // 落进缓存：第二次直接命中
      expect((await getShot('ch1', MARK))?.size).toBe(300)
    })

    it('缓存字节数和服务端声明不一致（服务端换了图）：重下并覆盖', async () => {
      await saveShot('ch1', MARK, T, jpg(100))
      const spy = vi.fn(async () => imgResponse(360))
      vi.stubGlobal('fetch', spy)

      const rec = await ensureShot('ch1', { mark: MARK, at: T, size: 360, imageUrl: '/x' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(rec.size).toBe(360)
    })

    it('没给 imageUrl：报「缺少抓拍图片地址」，不拼默认地址、也不落一条空记录', async () => {
      const spy = vi.fn(async () => imgResponse(240))
      vi.stubGlobal('fetch', spy)

      // 「最近一帧」那条兜底地址已随旧接口下线：缺 imageUrl 就是数据问题，
      // 不能拿别的地址顶替（那会取到一张不对的图）
      await expect(ensureShot('ch1', { mark: MARK, at: T })).rejects.toThrow('缺少抓拍图片地址')
      expect(spy).not.toHaveBeenCalled()
      expect(await getShot('ch1', MARK)).toBeNull()
    })
  })

  describe('prune：只留最近这些天', () => {
    it('超过保留天数的记录被清掉，当天的不受影响', async () => {
      const old = T - (SHOT_KEEP_DAYS + 1) * 86400000
      await saveShot('ch1', '20261019080000', old, jpg(100))
      await saveShot('ch1', MARK, T, jpg(100))

      await prune(T)

      expect(await listCachedShots('ch1', '2026-10-19')).toHaveLength(0)
      expect(await listCachedShots('ch1', '2026-11-19')).toHaveLength(1)
    })
  })

  describe('latestShot：缓存里最新的一张（接口不可用时兜底）', () => {
    it('按抓拍时刻倒序取第一条，不跨通道', async () => {
      await saveShot('ch1', '20261119080000', new Date(2026, 10, 19, 8).getTime(), jpg(100))
      await saveShot('ch1', '20261119180000', new Date(2026, 10, 19, 18).getTime(), jpg(100))
      await saveShot('ch2', '20261120120000', new Date(2026, 10, 20, 12).getTime(), jpg(100))

      expect((await latestShot('ch1'))?.mark).toBe('20261119180000')
      expect((await latestShot('ch2'))?.mark).toBe('20261120120000')
      expect(await latestShot('ch3')).toBeNull()
      // 空通道号不查库
      expect(await latestShot('')).toBeNull()
    })
  })

  it('makeThumb 拿不到 canvas 时退回原图（宁可大一点，不能卡住列表）', async () => {
    const blob = jpg(256)
    const thumb = await makeThumb(blob)
    expect(thumb.size).toBeGreaterThan(0)
  })
})
