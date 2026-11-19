/**
 * 报警缩略图本机缓存（2026-11-19）
 *
 * 背景：抓拍图接口单张 820KB~1.3MB、无 gzip、无缓存头，重开页面就得重下。
 * 缩略图缩完只有 8~12KB，落到 IndexedDB 后二次进入是毫秒级。
 *
 * 这一组钉三件事：
 *   ① 写进去能读回来，读不到就是空串（调用方据此回退到占位图标）；
 *   ② 超过保留期就作废 —— 现场照片不该在本机无限期留着；
 *   ③ 登出清空（`clearThumbCache`）。
 *
 * happy-dom 没有 IndexedDB，所以这里跑的是**内存兜底路径**，与隐私模式下的
 * 真实表现一致（读写都不抛错，本次会话内仍命中）。
 */
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { THUMB_KEEP_DAYS, clearThumbCache, readThumb, writeThumb } from '@/utils/thumbCache'

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJ'

describe('缩略图本机缓存', () => {
  beforeEach(async () => {
    await clearThumbCache()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await clearThumbCache()
  })

  it('写入后能读回，没写过的返回空串', async () => {
    writeThumb('va-101', IMG)
    await flushPromises()

    expect(await readThumb('va-101')).toBe(IMG)
    expect(await readThumb('va-999')).toBe('')
  })

  it('空 id / 空数据不写入', async () => {
    writeThumb('', IMG)
    writeThumb('va-102', '')
    await flushPromises()

    expect(await readThumb('')).toBe('')
    expect(await readThumb('va-102')).toBe('')
  })

  it(`超过 ${THUMB_KEEP_DAYS} 天就作废（不把现场照片长期留在本机）`, async () => {
    writeThumb('va-103', IMG)
    await flushPromises()
    expect(await readThumb('va-103')).toBe(IMG)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + (THUMB_KEEP_DAYS + 1) * 86400_000)
    expect(await readThumb('va-103')).toBe('')
  })

  it('登出清空后一条都不剩', async () => {
    writeThumb('va-104', IMG)
    writeThumb('va-105', IMG)
    await flushPromises()

    await clearThumbCache()
    expect(await readThumb('va-104')).toBe('')
    expect(await readThumb('va-105')).toBe('')
  })
})
