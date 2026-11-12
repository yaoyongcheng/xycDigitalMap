import { describe, expect, it, vi, afterEach } from 'vitest'

import { fetchScaffold, SCAFFOLD_SNAPSHOT_URL, SCAFFOLD_URL } from '@/api/scaffold'
import {
  SCAFFOLD_LIMIT,
  firstOverLabel,
  parseSensors,
  scaffoldLabel,
  summarize,
  timeHm,
  toNumber,
} from '@/utils/scaffold'
import type { ScaffoldSensor } from '@/types'

/**
 * 智能爬架传感器（2026-11 第四轮）
 *
 * 这一层的价值全在「读数和结论要能站得住」上：
 *   · 读数带单位后缀（'3.13mm' / '0.00吨'），解析失败必须是 null 不是 0 ——
 *     0 在这张卡上是「没有倾斜 / 没有载荷」的结论，不是「不知道」；
 *   · 超限按**绝对值**判（V2 的 Evaluate 用 Math.Abs），-179.5 与 179.5 同等对待；
 *   · 取不到数据时 `over` 必须是 false ——「不知道」不能表达成「超限」，
 *     也不能表达成「正常」。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 一处现场的原始行 */
const raw = {
  sensors: [
    { itemName: '1#机位', fbTilt: '3.13mm', lrTilt: '0.25mm', load: '0.00吨', updateTime: '2026-11-07 14:02:49' },
    { itemName: '30#机位', fbTilt: '2.10mm', lrTilt: '179.5mm', load: '0.20吨', updateTime: '2026-11-07 13:58:53' },
    { itemName: '19#机位', fbTilt: '6.36mm', lrTilt: '0.40mm', load: '0.10吨', updateTime: '2026-11-07 13:58:53' },
    { itemName: '6#机位', fbTilt: '3.30mm', lrTilt: '1.20mm', load: '0.61吨', updateTime: '2026-11-07 13:58:53' },
  ],
}

describe('toNumber：带单位后缀的读数', () => {
  it('抓前缀数字，忽略单位', () => {
    expect(toNumber('3.13mm')).toBe(3.13)
    expect(toNumber('0.00吨')).toBe(0)
    expect(toNumber('-179.5mm')).toBe(-179.5)
    expect(toNumber(' 12 mm ')).toBe(12)
    expect(toNumber(3.2)).toBe(3.2)
    expect(toNumber(0)).toBe(0)
  })

  it('抓不出数字一律 null，绝不回落成 0', () => {
    for (const bad of ['', '  ', '--', 'mm', null, undefined, NaN, Infinity, {}, []]) {
      expect(toNumber(bad)).toBeNull()
    }
  })
})

describe('parseSensors：脏行丢掉而不是抛错', () => {
  it('正常报文', () => {
    const list = parseSensors(raw)!
    expect(list).toHaveLength(4)
    expect(list[0]).toEqual({
      item: '1#机位',
      lrTilt: 0.25,
      fbTilt: 3.13,
      load: 0,
      time: '2026-11-07 14:02:49',
    })
  })

  it('信封不对一律 null', () => {
    expect(parseSensors(null)).toBeNull()
    expect(parseSensors({})).toBeNull()
    expect(parseSensors({ sensors: 'x' })).toBeNull()
    expect(parseSensors({ sensors: [] })).toBeNull()
  })

  it('机位名为空的行被丢掉（读数无法定位）', () => {
    const list = parseSensors({
      sensors: [
        { itemName: '  ', lrTilt: '1mm', fbTilt: '1mm', load: '1吨' },
        { itemName: '2#机位', lrTilt: '1mm', fbTilt: '1mm', load: '1吨' },
      ],
    })!
    expect(list.map((s) => s.item)).toEqual(['2#机位'])
  })

  it('三个读数全脏的行被丢掉（没有可判定信息）', () => {
    const list = parseSensors({
      sensors: [
        { itemName: '1#机位', lrTilt: '--', fbTilt: '', load: null },
        { itemName: '2#机位', lrTilt: '1mm', fbTilt: '--', load: '' },
      ],
    })!
    expect(list.map((s) => s.item)).toEqual(['2#机位'])
    expect(list[0].fbTilt).toBeNull()
  })

  it('全是脏行时返回 null 而不是空数组（「没数据」≠「0 个机位都正常」）', () => {
    expect(parseSensors({ sensors: [{ itemName: '', lrTilt: '' }] })).toBeNull()
  })
})

describe('summarize：三格取全场最不利机位', () => {
  const list = parseSensors(raw)!

  it('每个指标取绝对值最大的机位，value 保留原值', () => {
    const s = summarize(list)
    expect(s.count).toBe(4)
    expect(s.updatedAt).toBe('2026-11-07 14:02:49')

    const lr = s.cells.find((c) => c.key === 'lrTilt')!
    expect(lr.item).toBe('30#机位')
    expect(lr.value).toBe(179.5)
    expect(lr.limit).toBe(60)
    expect(lr.unit).toBe('mm')
    expect(lr.over).toBe(true)

    const fb = s.cells.find((c) => c.key === 'fbTilt')!
    expect(fb.item).toBe('19#机位')
    expect(fb.value).toBe(6.36)
    expect(fb.over).toBe(false)

    const load = s.cells.find((c) => c.key === 'load')!
    expect(load.item).toBe('6#机位')
    expect(load.value).toBe(0.61)
    expect(load.over).toBe(false)
  })

  it('每格数出「正常机位数 / 有读数的机位数」：4 台里只有 30# 左右倾斜超限', () => {
    const s = summarize(list)
    const of = (k: string) => s.cells.find((c) => c.key === k)!
    // 夹具 4 台，只有 30# 越限 → 卡片上写的是 3/4
    expect([of('lrTilt').normal, of('lrTilt').total]).toEqual([3, 4])
    // 前后倾斜与载荷四台全在阈值内
    expect([of('fbTilt').normal, of('fbTilt').total]).toEqual([4, 4])
    expect([of('load').normal, of('load').total]).toEqual([4, 4])
  })

  it('分母只数「有该指标读数」的机位，缺读数的机位不算异常', () => {
    const s = summarize([
      { item: '1#机位', lrTilt: 1, fbTilt: 1, load: 0.1, time: '' },
      { item: '2#机位', lrTilt: 1, fbTilt: 1, load: null, time: '' },
      { item: '3#机位', lrTilt: 1, fbTilt: 1, load: null, time: '' },
    ])
    const load = s.cells.find((c) => c.key === 'load')!
    // 只有 1 台上报了载荷 → 1/1，而不是 1/3（1/3 会被读成「有两台超载」）
    expect([load.normal, load.total]).toEqual([1, 1])
  })

  it('超限机位数按机位去重（这里只有 30# 一台）', () => {
    expect(summarize(list).overCount).toBe(1)
  })

  it('负值同样能超限：判定看绝对值', () => {
    const s = summarize([
      { item: 'a#机位', lrTilt: -70, fbTilt: 0, load: 0, time: '' },
      { item: 'b#机位', lrTilt: -10, fbTilt: 0, load: 0, time: '' },
    ])
    const lr = s.cells.find((c) => c.key === 'lrTilt')!
    expect(lr.item).toBe('a#机位')
    expect(lr.value).toBe(-70)
    expect(lr.over).toBe(true)
  })

  it('空列表：三格都没有结论，over 一律 false、计数一律 0/0', () => {
    const s = summarize([])
    expect(s.count).toBe(0)
    expect(s.updatedAt).toBe('')
    expect(s.overCount).toBe(0)
    for (const c of s.cells) {
      expect(c.value).toBeNull()
      expect(c.item).toBe('')
      expect(c.over).toBe(false)
      // 0/0 只是内部空态，页面遇到 total === 0 显示「—」，不会写出 0/0
      expect([c.normal, c.total]).toEqual([0, 0])
    }
  })

  it('某格全无读数时，该格 null 且不超限；另两格照常', () => {
    const s = summarize([
      { item: 'a#机位', lrTilt: null, fbTilt: 80, load: 0, time: '' },
    ])
    const lr = s.cells.find((c) => c.key === 'lrTilt')!
    expect(lr.value).toBeNull()
    expect(lr.over).toBe(false)
    expect([lr.normal, lr.total]).toEqual([0, 0])
    const fb = s.cells.find((c) => c.key === 'fbTilt')!
    expect(fb.value).toBe(80)
    expect(fb.over).toBe(true)
    expect([fb.normal, fb.total]).toEqual([0, 1])
  })
})

describe('阈值与文案', () => {
  it('阈值与 V2 客户端一致：倾斜 60mm、载荷 5 吨', () => {
    expect(SCAFFOLD_LIMIT).toEqual({ lrTilt: 60, fbTilt: 60, load: 5 })
  })

  it('告警文案照设计稿句式：机位 + 指标 + 读数 + 超过阈值', () => {
    const list = parseSensors(raw)!
    const lr = summarize(list).cells.find((c) => c.key === 'lrTilt')!
    expect(scaffoldLabel(lr)).toBe('30#机位 左右倾斜 179.5mm，超过 60mm')
  })

  it('没有读数时文案为空串（不编「0mm 正常」）', () => {
    const cell = summarize([]).cells[0]
    expect(scaffoldLabel(cell)).toBe('')
  })

  it('firstOverLabel 按 左右倾斜 → 前后倾斜 → 载荷 的顺序取第一条', () => {
    const list = parseSensors({
      sensors: [
        { itemName: 'x#机位', lrTilt: '0mm', fbTilt: '0mm', load: '9吨', updateTime: '' },
        { itemName: 'y#机位', lrTilt: '100mm', fbTilt: '0mm', load: '0吨', updateTime: '' },
      ],
    })!
    // 两个都超限，先报倾斜
    expect(firstOverLabel(summarize(list))).toBe('y#机位 左右倾斜 100mm，超过 60mm')
  })

  it('timeHm 只取到分钟', () => {
    expect(timeHm('2026-11-07 14:02:49')).toBe('14:02')
    expect(timeHm('')).toBe('')
    expect(timeHm('2026-11-07')).toBe('')
  })
})

describe('fetchScaffold：CDN 优先，内置快照兜底', () => {
  function okJson(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }

  it('CDN 拿到就用，source = live，且只请求 CDN', async () => {
    const f = vi.fn(async () => okJson(raw))
    vi.stubGlobal('fetch', f)
    const res = await fetchScaffold()
    expect(res?.source).toBe('live')
    expect(res?.sensors).toHaveLength(4)
    expect(f).toHaveBeenCalledTimes(1)
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(SCAFFOLD_URL)
  })

  it('CDN 失败（非 2xx）→ 退到内置快照，source = snapshot', async () => {
    const f = vi.fn(async (url: string) => {
      if (url === SCAFFOLD_URL) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
      return okJson(raw)
    })
    vi.stubGlobal('fetch', f)
    const res = await fetchScaffold()
    expect(res?.source).toBe('snapshot')
    expect(String((f.mock.calls[1] as unknown[])[0])).toBe(SCAFFOLD_SNAPSHOT_URL)
  })

  it('CDN 抛错（mixed content 被拦 / 断网）也退到快照', async () => {
    const f = vi.fn(async (url: string) => {
      if (url === SCAFFOLD_URL) throw new Error('Mixed Content')
      return okJson(raw)
    })
    vi.stubGlobal('fetch', f)
    expect((await fetchScaffold())?.source).toBe('snapshot')
  })

  it('两者都失败 → null（页面走空态，不编读数）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('boom')
    }))
    expect(await fetchScaffold()).toBeNull()
  })

  it('快照文件本身坏了（不是合法 JSON 结构）→ null', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === SCAFFOLD_URL) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
      return okJson({ hello: 'world' })
    }))
    expect(await fetchScaffold()).toBeNull()
  })
})

describe('内置快照文件', () => {
  it('public/data/scaffold.json 结构与 CDN 一致，能被解析出机位', async () => {
    // 用 node 直接读文件，验证随仓库发布的那份快照没有写坏
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const body = JSON.parse(readFileSync(resolve(process.cwd(), 'public/data/scaffold.json'), 'utf8')) as unknown
    const list = parseSensors(body) as ScaffoldSensor[] | null
    expect(list).not.toBeNull()
    expect(list!.length).toBeGreaterThan(0)
    // 每条都必须是可用读数（至少一个指标能解析出来）
    for (const s of list!) {
      expect(s.item).not.toBe('')
      expect(s.lrTilt !== null || s.fbTilt !== null || s.load !== null).toBe(true)
    }
  })
})
