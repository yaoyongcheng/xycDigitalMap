import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeviceInfoRow } from '@/api/data'
import { dayRange, fetchCraneWorkCycle, toWorkCycles } from '@/api/towerCrane'
import { CRANE_SNS } from '@/data/craneSn'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useHomeStore } from '@/stores/home'
import { ROBOT_CARDS, serialOf, toEquip } from '@/utils/deviceLedger'

import { deviceRows } from '../fixtures/ledger'

/**
 * 塔机工作循环（今日吊次 / 吊重）
 *
 * 这一层的价值全在「拿不到就别装拿到」上：
 *   · 没有 sn、超时、业务报错 → 一律 null（页面显示「—」），不 throw；
 *   · 响应结构未在真机上验证过（现场连一个塔机编号都拿不出来），
 *     所以 toWorkCycles 必须对多种信封与脏字段都收敛成同一个数组。
 */

describe('dayRange', () => {
  it('时间窗是当天 00:00:00 ~ 24:00:00 的日期字符串（本地时区）', () => {
    const d = new Date(2026, 10, 27, 15, 42, 10)
    // 必须是 'yyyy-MM-dd HH:mm:ss' 字符串，不能是 Unix 毫秒 ——
    // 实测发毫秒会被服务端回 400「塔机编号不存在」，那个文案会误导人去查编号
    expect(dayRange(d)).toEqual({
      startTime: '2026-11-27 00:00:00',
      endTime: '2026-11-27 24:00:00',
    })
  })

  it('月份与日期补零（1 月 5 日不能写成 2027-1-5）', () => {
    expect(dayRange(new Date(2027, 0, 5, 8, 0, 0))).toEqual({
      startTime: '2027-01-05 00:00:00',
      endTime: '2027-01-05 24:00:00',
    })
  })
})

describe('toWorkCycles 收敛', () => {
  it('裸数组：取 startTime / endTime / maxWeight / duration / type', () => {
    const raw = [
      { startTime: 1762000000000, endTime: 1762000060000, maxWeight: 1.87, duration: 60, type: '上料' },
      { startTime: 1762000100000, endTime: 1762000180000, maxWeight: 3.1 },
    ]
    expect(toWorkCycles(raw)).toEqual([
      { start: 1762000000000, end: 1762000060000, weight: 1.87, duration: 60, type: '上料' },
      // 没有 duration 就用 end-start 推（80000ms = 80s）
      { start: 1762000100000, end: 1762000180000, weight: 3.1, duration: 80, type: '' },
    ])
  })

  it('信封 { data: { list } } 与 { data: [] } 都认', () => {
    const items = [{ startTime: 1, endTime: 2, maxWeight: 1 }]
    expect(toWorkCycles({ code: 200, data: { list: items } })).toHaveLength(1)
    expect(toWorkCycles({ code: 200, data: items })).toHaveLength(1)
    expect(toWorkCycles({ code: 200, data: { records: items } })).toHaveLength(1)
    expect(toWorkCycles({ code: 200, data: [] })).toEqual([])
  })

  it('字段别名：beginTime/finishTime、loadWeight / start/end / weight', () => {
    const got = toWorkCycles([
      { beginTime: 1762000000000, finishTime: 1762000060000, loadWeight: '2.5' },
      { start: 1762000100000, end: 1762000180000, weight: 4 },
    ])
    expect(got).toEqual([
      { start: 1762000000000, end: 1762000060000, weight: 2.5, duration: 60, type: '' },
      { start: 1762000100000, end: 1762000180000, weight: 4, duration: 80, type: '' },
    ])
  })

  it('时长：服务端 duration 优先（秒），没有才用 end-start 推，都没有是 null', () => {
    const [a, b, c] = toWorkCycles([
      { startTime: 1762000000000, endTime: 1762000500000, duration: 655 },
      { startTime: '2026-11-12 09:00:00', endTime: '2026-11-12 09:03:00' },
      { startTime: 1762000000000 },
    ])
    // 655s 是服务端原值，不能被 500s 的 end-start 顶掉
    expect(a.duration).toBe(655)
    expect(b.duration).toBe(180)
    // 只有开始时间 → 推不出时长，给 null 而不是 0（0 秒会被当成「干活 0 秒」）
    expect(c.duration).toBeNull()
  })

  it('秒级时间戳补成毫秒，字符串时间按本地时间解析', () => {
    const [a] = toWorkCycles([{ startTime: 1762000000 }])
    expect(a.start).toBe(1762000000 * 1000)
    const [b] = toWorkCycles([{ startTime: '2026-11-27 08:30:00' }])
    expect(b.start).toBe(new Date(2026, 10, 27, 8, 30, 0).getTime())
    // 毫秒时间戳写成字符串也认（服务端有时把 long 序列化成 string）
    const [c] = toWorkCycles([{ startTime: '1762000000000' }])
    expect(c.start).toBe(1762000000000)
  })

  it('数字字段是字符串 / 脏值：能收敛的收敛，不能的一律 null（不写 0）', () => {
    const got = toWorkCycles([
      { startTime: '1762000000000', endTime: '1762000060000', maxWeight: '1.87' },
      { maxWeight: '--' },
      { maxWeight: '' },
      { maxWeight: null },
      { maxWeight: NaN },
      { maxWeight: true },
      { weight: '2,5' },
    ])
    expect(got[0]).toEqual({ start: 1762000000000, end: 1762000060000, weight: 1.87, duration: 60, type: '' })
    // '--' / '' / null / NaN / true 都不是重量；'2,5' 解析不出数字也算没有
    for (const c of got.slice(1)) expect(c.weight).toBeNull()
    // 7 条里有 1 条对象缺时间，其余也都保留（吊次按条数，不按字段完整度）
    expect(got).toHaveLength(7)
  })

  it('脏行不炸：非对象丢掉，缺字段给 null（吊次仍算一次）', () => {
    // 'x' / 42 不是对象 → 直接丢；两条缺值对象仍然是「两次吊」，
    // 只是时间与重量都不知道（吊次与吊重是两个独立指标）
    const got = toWorkCycles({ data: [null, 'x', 42, { maxWeight: '--' }, { startTime: '' }] })
    expect(got).toEqual([
      { start: null, end: null, weight: null, duration: null, type: '' },
      { start: null, end: null, weight: null, duration: null, type: '' },
    ])
  })

  it('空 / 畸形输入返回空数组', () => {
    expect(toWorkCycles(null)).toEqual([])
    expect(toWorkCycles(undefined)).toEqual([])
    expect(toWorkCycles('oops')).toEqual([])
    expect(toWorkCycles({ code: 400, data: null })).toEqual([])
  })
})

describe('fetchCraneWorkCycle', () => {
  it('没有 sn 直接返回 null，且不发请求', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await fetchCraneWorkCycle('', new Date())).toBeNull()
    expect(await fetchCraneWorkCycle('   ', new Date())).toBeNull()
    expect(f).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('成功：POST 到工作循环路径，请求体是 deviceSN + 当天日期字符串', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 200, success: true, data: [{ startTime: 1, endTime: 2, maxWeight: 1.5 }] }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', f)

    const date = new Date(2026, 10, 27, 9, 0, 0)
    const list = await fetchCraneWorkCycle('TC-001', date)

    expect(list).toHaveLength(1)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/towercranedataservice/getWorkCycleInfoHis')
    const body = JSON.parse(String(init.body))
    // 字段名是大写 SN 的 deviceSN：写 sn 会被回「塔机编号不存在」
    expect(body.deviceSN).toBe('TC-001')
    expect(body.startTime).toBe('2026-11-27 00:00:00')
    expect(body.endTime).toBe('2026-11-27 24:00:00')
    // 请求体只有这三项：**不能**退回实时数据那套 {productCode, sn, field, code}，
    // 也不能塞事件查询的 eventCode（这条路由按编号 + 时间窗查）
    expect(Object.keys(body).sort()).toEqual(['deviceSN', 'endTime', 'startTime'])
    expect(init.method).toBe('POST')
    vi.unstubAllGlobals()
  })

  it('业务报错（400 塔机编号不存在）返回 null，不 throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ code: 400, success: false, msg: '塔机编号不存在' }),
    }) as unknown as Response))
    expect(await fetchCraneWorkCycle('TC-404', new Date())).toBeNull()
    vi.unstubAllGlobals()
  })

  it('HTTP 200 但 success:false / 非 0-200 业务码，同样当没有数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 200, success: false, data: [{ startTime: 1 }] }),
    }) as unknown as Response))
    expect(await fetchCraneWorkCycle('TC-001', new Date())).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 500, data: [{ startTime: 1 }] }),
    }) as unknown as Response))
    expect(await fetchCraneWorkCycle('TC-001', new Date())).toBeNull()
    vi.unstubAllGlobals()
  })

  it('网络异常 / 非 JSON（网关 HTML 错误页）返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('boom')
    }))
    expect(await fetchCraneWorkCycle('TC-001', new Date())).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    }) as unknown as Response))
    expect(await fetchCraneWorkCycle('TC-001', new Date())).toBeNull()
    vi.unstubAllGlobals()
  })

  /*
   * 现场响应结构**从未被验证过**（服务端对任何编号都回「塔机编号不存在」）。
   * 于是有两种「空」必须分开，否则卡片会写下一个假结论：
   *   · `{data: []}`   → 接口通了、今天没吊 → 「0 次」是结论；
   *   · `{data: {…}}`  → 认不出列表结构 → 只能「—」，绝不能当 0 次。
   */
  it('当天确实没吊（空数组）返回 [] —— 0 次是有效结论', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 200, success: true, data: [] }),
    }) as unknown as Response))
    expect(await fetchCraneWorkCycle('TC-001', new Date())).toEqual([])
    vi.unstubAllGlobals()
  })

  it('响应结构认不出来（既无 data 也无列表键）返回 null，不冒充「0 次」', async () => {
    for (const body of [
      { code: 200, success: true },
      { code: 200, success: true, data: null },
      { code: 200, success: true, data: { total: 0 } },
      { code: 200, success: true, data: { workCycleInfoList: [] } },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => body,
      }) as unknown as Response))
      expect(await fetchCraneWorkCycle('TC-001', new Date()), JSON.stringify(body)).toBeNull()
    }
    vi.unstubAllGlobals()
  })
})

describe('serialOf 取设备序列号', () => {
  const withExtra = (extra: string): ReturnType<typeof deviceRows>[number] => ({
    id: 1,
    project_id: 'P000000076',
    device_name: '智能塔机2',
    online_status: 1,
    device_info: { extra_fields: extra },
  })

  it('认「序列号 / SN / 设备编号」这些键', () => {
    expect(serialOf(withExtra(JSON.stringify([{ label: '序列号', value: 'TC-9' }])))).toBe('TC-9')
    expect(serialOf(withExtra(JSON.stringify([{ label: 'SN', value: 'TC-9' }])))).toBe('TC-9')
    expect(serialOf(withExtra(JSON.stringify([{ label: '设备编号', value: 'TC-9' }])))).toBe('TC-9')
  })

  it('不认模糊键（「设备名称」里带「编号」两个字不算），占位值也算没有', () => {
    expect(serialOf(withExtra(JSON.stringify([{ label: '设备名称', value: 'TC-9' }])))).toBeNull()
    expect(serialOf(withExtra(JSON.stringify([{ label: '序列号', value: '--' }])))).toBeNull()
    expect(serialOf(withExtra(JSON.stringify([{ label: '序列号', value: '无' }])))).toBeNull()
    expect(serialOf(withExtra(''))).toBeNull()
  })

  it('现场夹具（没有序列号字段）一律返回 null —— 不许拿设备名凑编号', () => {
    for (const row of deviceRows()) expect(serialOf(row)).toBeNull()
  })
})

describe('首页卡片的静态机器人组', () => {
  it('5 类机器人：无 page（不可点）、无 units（不渲染在线 x/y）、数值取 V2 预置值', () => {
    expect(ROBOT_CARDS.map((c) => c.id)).toEqual(['grind', 'plaster', 'survey', 'spray', 'screed'])
    // 与 V2 预制体 `UIView 装备管理一张图 / 底部栏 / 施工机器人栏` 的 Value 逐条对齐
    // （见 src/data/robotStats.ts 的取证记录）
    expect(ROBOT_CARDS.map((c) => c.value)).toEqual(['5次', '4次', '7次', '9次', '3次'])
    for (const c of ROBOT_CARDS) {
      expect(c.page).toBeUndefined()
      expect(c.linked).toBe(false)
      expect(c.units).toEqual([])
      expect(c.metric).toBe('今日作业次数')
      // 立绘键按机型分开（设计稿 eq-{grind,plaster,…}.jpg），不再共用 robot 一枚剪影
      expect(c.ico).toBe(c.id)
    }
  })

  it('塔机卡：有作业指标就换成「今日吊重 + 今日吊次」两格，高度让位', () => {
    const cards = toEquip(deviceRows(), { trips: 26, weight: 1.87 })
    const crane = cards.find((c) => c.id === 'crane')!
    expect(crane.stats).toEqual([
      { value: '1.87t', metric: '今日吊重' },
      { value: '26次', metric: '今日吊次' },
    ])
    // 台账里的高度仍在（模板不会渲染它，因为 stats 优先），不清空以免丢信息
    expect(crane.value).toBe('70m')
  })

  it('塔机卡：没有作业指标时 stats 为空（模板退回高度那格）', () => {
    const cards = toEquip(deviceRows())
    expect(cards.find((c) => c.id === 'crane')!.stats).toBeUndefined()
  })

  it('当天没吊（weight 为 null）时吊重写 0.00t，不是横杠', () => {
    const cards = toEquip(deviceRows(), { trips: 0, weight: null })
    expect(cards.find((c) => c.id === 'crane')!.stats).toEqual([
      { value: '0.00t', metric: '今日吊重' },
      { value: '0次', metric: '今日吊次' },
    ])
  })
})

/**
 * store 侧的汇总口径（`stores/deviceLedger.ts: loadCraneDay`）
 *
 * 这一段是「接上工作循环接口」真正落地的地方：有了 sn 才查，查回来的若干条
 * 循环要汇总成两个数。三条规则各有一次踩坑的风险，各钉一条。
 */
describe('deviceLedger.loadCraneDay 汇总', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 一台带序列号的塔机（其余字段照现场形状） */
  function craneRow(id: number, sn: string | null): DeviceInfoRow {
    const base = deviceRows().find((r) => r.id === 67)!
    const extra: { label: string; value: string | number }[] = [{ label: '高度', value: 64 }]
    if (sn) extra.push({ label: '序列号', value: sn })
    return {
      ...base,
      id,
      device_name: '智能塔机2',
      device_info: { ...(base.device_info ?? {}), extra_fields: JSON.stringify(extra) },
    }
  }

  /** 给工作循环接口打桩：按 sn 返回不同的循环条数 */
  function stubCycles(bySn: Record<string, unknown[] | null>): ReturnType<typeof vi.fn> {
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const sn = String(JSON.parse(String(init?.body)).deviceSN)
      const data = bySn[sn]
      if (data === null) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
      return { ok: true, status: 200, json: async () => ({ code: 200, success: true, data }) } as unknown as Response
    })
    vi.stubGlobal('fetch', f)
    return f
  }

  it('台账没有 sn 时退到 V2 登记表：按那 3 台车各查一次', async () => {
    // 现场现状：:8084 台账没有序列号字段。此时不能就此放弃 ——
    // V2 场景里登记了 3 台向阳村塔机，桌面端就是用它们算今日合计的，
    // 页面要和 V2 一致就必须同样按这 3 个编号查。
    const bySn: Record<string, unknown[]> = {}
    for (const c of CRANE_SNS) bySn[c.sn] = []
    const f = stubCycles(bySn)

    useDeviceLedgerStore().apply(deviceRows())
    await flushPromises()

    expect(f).toHaveBeenCalledTimes(CRANE_SNS.length)
    expect(useDeviceLedgerStore().craneDay).toEqual({ trips: 0, weight: null })
  })

  it('按 sn 查一次，吊次 = 总条数，吊重 = 有重量那些的和', async () => {
    const f = stubCycles({
      'TC-1': [
        { startTime: 1762000000000, endTime: 1762000060000, maxWeight: 1.2 },
        { startTime: 1762000100000, endTime: 1762000180000, maxWeight: '0.67' },
        // 没有重量的循环仍然是一次吊
        { startTime: 1762000200000, endTime: 1762000280000 },
      ],
    })
    useDeviceLedgerStore().apply([craneRow(67, 'TC-1')])
    await flushPromises()

    expect(f).toHaveBeenCalledTimes(1)
    expect(useDeviceLedgerStore().craneDay).toEqual({ trips: 3, weight: 1.87 })
    // 卡片上就是这两格
    const crane = useHomeStore().siteEquip.find((d) => d.id === 'crane')!
    expect(crane.stats).toEqual([
      { value: '1.87t', metric: '今日吊重' },
      { value: '3次', metric: '今日吊次' },
    ])
  })

  it('一条循环都没重量时吊重给 null（→「—」），不写 0.00t', async () => {
    stubCycles({ 'TC-1': [{ startTime: 1, endTime: 2 }] })
    useDeviceLedgerStore().apply([craneRow(67, 'TC-1')])
    await flushPromises()

    expect(useDeviceLedgerStore().craneDay).toEqual({ trips: 1, weight: null })
  })

  it('接口通了但当天没吊（空数组）是有效结论：0 次；不是「拿不到」', async () => {
    stubCycles({ 'TC-1': [] })
    useDeviceLedgerStore().apply([craneRow(67, 'TC-1')])
    await flushPromises()

    expect(useDeviceLedgerStore().craneDay).toEqual({ trips: 0, weight: null })
  })

  it('多台塔机各自查一次；只要有一台失败就整体算拿不到（不交半份合计）', async () => {
    const f = stubCycles({
      'TC-1': [{ startTime: 1, endTime: 2, maxWeight: 1 }],
      'TC-2': null,
    })
    useDeviceLedgerStore().apply([craneRow(67, 'TC-1'), craneRow(68, 'TC-2')])
    await flushPromises()

    expect(f).toHaveBeenCalledTimes(2)
    expect(useDeviceLedgerStore().craneDay).toBeNull()
  })

  it('重复的 sn 只查一次（同一台设备不会在台账里被算两遍）', async () => {
    const f = stubCycles({ 'TC-1': [{ startTime: 1, endTime: 2, maxWeight: 1 }] })
    useDeviceLedgerStore().apply([craneRow(67, 'TC-1'), craneRow(68, 'TC-1')])
    await flushPromises()

    expect(f).toHaveBeenCalledTimes(1)
    expect(useDeviceLedgerStore().craneDay).toEqual({ trips: 1, weight: 1 })
  })
})
