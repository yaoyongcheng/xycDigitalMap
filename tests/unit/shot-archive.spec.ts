import { beforeEach, describe, expect, it } from 'vitest'

import { dateKey } from '@/utils/date'
import {
  clearShots,
  listShots,
  makeThumb,
  prune,
  saveShot,
  SHOT_KEEP_DAYS,
  slotAt,
} from '@/utils/shotArchive'

/**
 * 历史抓拍档案（2026-11-19）
 *
 * 这一层只干一件事：把「最近一帧快照」按**更新档**存下来，让历史抓拍页有真照片
 * 可看。档位判定错一天、同档重复存成两张、淘汰把新的删了 —— 都是现场一眼能看出、
 * 代码里却不会报错的错，所以在这里钉住。
 *
 * 单测环境没有 IndexedDB（happy-dom），走的是内存兜底分支；两条分支的行为一致。
 */
function jpg(size = 300): Blob {
  return new Blob([new Uint8Array(size)], { type: 'image/jpeg' })
}

/** 2026-11-19 10:00 本地时间（档位判定的基准） */
const T = new Date(2026, 10, 19, 10, 0, 0).getTime()

describe('utils/shotArchive', () => {
  beforeEach(async () => {
    await clearShots()
  })

  describe('slotAt：最近一次已经发生的更新档', () => {
    it('09:19 属于今天 08:00 那一档', () => {
      const t = new Date(2026, 10, 19, 9, 19).getTime()
      expect(slotAt(t)).toEqual({
        day: '2026-11-19',
        slot: 0,
        boundary: new Date(2026, 10, 19, 8, 0, 0).getTime(),
      })
    })

    it('07:30 还是昨天 18:00 那一档（今天 08:00 的还没生成）', () => {
      const t = new Date(2026, 10, 19, 7, 30).getTime()
      const ref = slotAt(t)
      expect(ref.day).toBe('2026-11-18')
      expect(ref.slot).toBe(2)
    })

    it('整点那一刻算当前档', () => {
      expect(slotAt(new Date(2026, 10, 19, 12, 0, 0).getTime()).slot).toBe(1)
      expect(slotAt(new Date(2026, 10, 19, 18, 0, 0).getTime()).slot).toBe(2)
    })
  })

  describe('saveShot / listShots', () => {
    it('同一档取到同样大小的字节：不重复存，时刻保持第一次', async () => {
      const first = await saveShot('ch1', jpg(300), T)
      const again = await saveShot('ch1', jpg(300), T + 60_000)

      expect(again.key).toBe(first.key)
      expect(again.at).toBe(T)
      expect(await listShots('ch1', dateKey(T))).toHaveLength(1)
    })

    it('同一档字节变了（服务端真的换了图）：覆盖并记新时刻', async () => {
      await saveShot('ch1', jpg(300), T)
      const next = await saveShot('ch1', jpg(420), T + 120_000)

      expect(next.at).toBe(T + 120_000)
      const rows = await listShots('ch1', dateKey(T))
      expect(rows).toHaveLength(1)
      expect(rows[0].size).toBe(420)
    })

    it('按档位正序返回，且只回该通道该天', async () => {
      const d = (h: number): number => new Date(2026, 10, 19, h, 5).getTime()
      await saveShot('ch1', jpg(100), d(18))
      await saveShot('ch1', jpg(100), d(8))
      await saveShot('ch1', jpg(100), d(12))
      await saveShot('ch2', jpg(100), d(8))
      await saveShot('ch1', jpg(100), new Date(2026, 10, 18, 12, 5).getTime())

      const rows = await listShots('ch1', '2026-11-19')
      expect(rows.map((r) => r.slot)).toEqual([0, 1, 2])
      expect(rows.every((r) => r.channelId === 'ch1' && r.day === '2026-11-19')).toBe(true)
    })
  })

  describe('prune：只留最近这些天', () => {
    it('超过保留天数的记录被清掉，当天的不受影响', async () => {
      const old = T - (SHOT_KEEP_DAYS + 1) * 86400000
      await saveShot('ch1', jpg(100), old)
      await saveShot('ch1', jpg(100), T)

      await prune(T)

      expect(await listShots('ch1', dateKey(old))).toHaveLength(0)
      expect(await listShots('ch1', dateKey(T))).toHaveLength(1)
    })
  })

  it('makeThumb 拿不到 canvas 时退回原图（宁可大一点，不能卡住列表）', async () => {
    const blob = jpg(256)
    const thumb = await makeThumb(blob)
    expect(thumb.size).toBeGreaterThan(0)
  })
})
