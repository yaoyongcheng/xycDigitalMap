import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchTradeAtte } from '@/api/person'

/**
 * 「今日出勤工种」的口径（2026-11-17 现场核对）：
 * 用 `POST /location/personCurLocation/v2` 的在场人员清单 `stayPersonPageVos`，
 * 按每行自带的 `personTypeWork` 分组 —— 与 V2「今日入场人员」表格同一份数据
 * （那天木工 17 人，与表格筛选结果逐行对得上）。
 */
function stubPersons(rows: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ statusCode: 20000, data: { stayPersonPageVos: rows } }), { status: 200 }),
    ),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchTradeAtte', () => {
  it('按 personTypeWork 分组、人数降序', () => {
    stubPersons([
      { personTypeWork: '管理人员' },
      { personTypeWork: '木工' },
      { personTypeWork: '木工' },
      { personTypeWork: '钢筋工' },
    ])
    return fetchTradeAtte().then((rows) => {
      expect(rows).toEqual([
        { name: '木工', count: 2 },
        // 同为 1 人时按拼音排序（钢筋工 gang < 管理人员 guan），顺序稳定
        { name: '钢筋工', count: 1 },
        { name: '管理人员', count: 1 },
      ])
    })
  })

  it('人数相同按名字稳定排序（顺序不会每次刷新都跳）', async () => {
    stubPersons([{ personTypeWork: '瓦工' }, { personTypeWork: '焊工' }])
    const rows = await fetchTradeAtte()
    expect(rows.map((r) => r.name)).toEqual(['焊工', '瓦工'])
  })

  it('「其它」不管多少人一律沉底（不是真实工种，不参与排名）', async () => {
    stubPersons([
      { personTypeWork: '其它' },
      { personTypeWork: '其它' },
      { personTypeWork: '其它' },
      { personTypeWork: '木工' },
      { personTypeWork: '钢筋工' },
      { personTypeWork: '钢筋工' },
    ])
    const rows = await fetchTradeAtte()
    // 真实工种按人数排好，3 人的「其它」仍然被压在最后
    expect(rows.map((r) => r.name)).toEqual(['钢筋工', '木工', '其它'])
    expect(rows[2]).toEqual({ name: '其它', count: 3 })
  })

  it('缺工种的人归到「未填工种」，不被静默丢掉（人数要对得上在场总数）', async () => {
    stubPersons([{ personTypeWork: '木工' }, { personTypeWork: '' }, {}])
    const rows = await fetchTradeAtte()
    expect(rows).toEqual([
      { name: '木工', count: 1 },
      { name: '未填工种', count: 2 },
    ])
  })

  it('一次请求拿全量（不按工种逐个问）', async () => {
    stubPersons([])
    await fetchTradeAtte()
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls).toHaveLength(1)
    expect(String(calls[0][0])).toContain('/location/personCurLocation/v2')
    expect(calls[0][1].method).toBe('POST')
  })

  it('接口没人时给空数组（页面显示空态，不拿演示值补）', async () => {
    stubPersons([])
    await expect(fetchTradeAtte()).resolves.toEqual([])
  })

  it('接口失败时抛错（页面显示「暂无 / 重试」）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ statusCode: 57007, message: '接口权限未获取' }), { status: 200 }),
      ),
    )
    await expect(fetchTradeAtte()).rejects.toThrow('接口权限未获取')
  })
})
