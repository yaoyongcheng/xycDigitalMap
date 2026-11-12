import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deviceSet } from '@/data/device'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { categoryOf, heightOf, parseExtraFields, toEquip, toUnit } from '@/utils/deviceLedger'
import { deviceRows, ledgerEnvelope } from '../fixtures/ledger'

/**
 * 设备台账映射（2026-11 第二轮）
 *
 * 这一层是「接口行 → 页面结构」的唯一转换点，最容易出错的地方都在这里：
 *   · `extra_fields` 是**字符串**，不是数组（直接 map 会 TypeError）
 *   · 设备没有类型字段，只能按名字归类（「传统塔机5」也是塔机）
 *   · 高度要补 m，其余字段原样；字段缺失要跳过而不是显示 'undefined'
 *   · 四张卡恒定存在（入口不能消失），某类 0 台时显示 0/0
 */

describe('deviceLedger 映射', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('按设备名归类：智能/传统塔机都算塔机，爬架先于电梯判定', () => {
    expect(categoryOf('智能塔机2')).toBe('crane')
    expect(categoryOf('传统塔机5')).toBe('crane')
    expect(categoryOf('智能电梯1')).toBe('lift')
    expect(categoryOf('2#智能爬架')).toBe('climb')
    expect(categoryOf('无人机')).toBe('drone')
    expect(categoryOf('智能安全帽')).toBeNull()
    expect(categoryOf('')).toBeNull()
  })

  it('extra_fields 解析：字符串 JSON、数字 value、空串与脏数据都不炸', () => {
    const raw = JSON.stringify([
      { label: '高度', value: 64 },
      { label: '安检有效期', value: '2026-12-10' },
    ])
    expect(parseExtraFields(raw)).toEqual([
      ['高度', '64'],
      ['安检有效期', '2026-12-10'],
    ])

    expect(parseExtraFields('')).toEqual([])
    expect(parseExtraFields(undefined)).toEqual([])
    expect(parseExtraFields('not-json')).toEqual([])
    expect(parseExtraFields('{"a":1}')).toEqual([])
    // 空 label / 空 value 的行直接丢，不产生「: 空」这种半截行
    expect(parseExtraFields(JSON.stringify([{ label: '', value: 'x' }, { label: 'k', value: '' }]))).toEqual([])
  })

  it('高度取值：取高度类字段，非高度字段不算，没有就是 null', () => {
    const rows = deviceRows()
    expect(heightOf(rows.find((r) => r.device_name === '智能塔机4')!)).toBe(70)
    expect(heightOf(rows.find((r) => r.device_name === '传统塔机5')!)).toBe(10.3)
    expect(heightOf(rows.find((r) => r.device_name === '2#智能爬架')!)).toBe(21)
    // 无人机 extra_fields 是空串
    expect(heightOf(rows.find((r) => r.device_name === '无人机')!)).toBeNull()
  })

  it('台账行 → 设备卡：四格按偏好字段排序、高度带单位、弹层含责任人与更新时间', () => {
    const row = deviceRows().find((r) => r.device_name === '智能塔机4')!
    const unit = toUnit(row)

    expect(unit.id).toBe('69')
    expect(unit.name).toBe('智能塔机4')
    expect(unit.status).toBe('在线')
    expect(unit.cells).toEqual([
      ['高度', '70m'],
      ['塔吊司机', '机师'],
      ['安检有效期', '2026-12-10'],
      ['质检报告状态', '正常'],
    ])
    // info = 全部台账字段 + 责任人 + 更新时间（顺序照接口给的顺序）。
    // 「是否隐藏」「更新时间」这类后台字段在这里**照样保留**，
    // 是否展示由弹层决定（DeviceInfoSheet 有 TECH_FIELDS 过滤），util 层不裁数据。
    expect(unit.info.map(([k]) => k)).toEqual([
      '高度',
      '是否隐藏',
      '安检有效期',
      '质检报告状态',
      '塔吊司机',
      '功效',
      '责任人',
      '更新时间',
    ])
    expect(unit.info[0]).toEqual(['高度', '70m'])
    // 作业指标没有数据源 → 恒为空对象 / 空数组（页面据此给空态）
    expect(unit.today).toEqual({})
    expect(unit.history).toEqual([])
  })

  it('台账行 → 首页四卡：卡片恒定 4 张，台数与在线数按真实行统计', () => {
    const cards = toEquip(deviceRows())

    expect(cards.map((c) => c.id)).toEqual(['crane', 'lift', 'drone', 'climb'])
    const crane = cards.find((c) => c.id === 'crane')!
    const lift = cards.find((c) => c.id === 'lift')!
    const drone = cards.find((c) => c.id === 'drone')!
    const climb = cards.find((c) => c.id === 'climb')!

    // 塔机 4 台（智能 2/3/4 + 传统 5），其中 3# 离线
    expect(crane.units).toHaveLength(4)
    expect(crane.units.filter((u) => u.on)).toHaveLength(3)
    expect(crane.value).toBe('70m')
    expect(crane.metric).toBe('最大高度')

    expect(lift.units).toHaveLength(2)
    expect(lift.value).toBe('60m')

    expect(drone.units).toHaveLength(1)
    // 无人机没有高度字段 → 数值位留空，不塞 0 / '--'
    expect(drone.value).toBeUndefined()

    expect(climb.units).toHaveLength(1)
    expect(climb.value).toBe('21m')
    expect(climb.metric).toBe('爬升高度')
  })

  it('某类 0 台时卡片仍存在（入口不能消失）', () => {
    const cards = toEquip(deviceRows().filter((r) => !r.device_name.includes('电梯')))
    const lift = cards.find((c) => c.id === 'lift')!
    expect(cards).toHaveLength(4)
    expect(lift.units).toEqual([])
    expect(lift.value).toBeUndefined()
  })
})

describe('deviceLedger store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('apply 后：有数据、在线数正确，并把机组同步给 deviceSet 的登记表', () => {
    const ledger = useDeviceLedgerStore()
    ledger.apply(deviceRows())

    expect(ledger.hasData).toBe(true)
    expect(ledger.total).toBe(8)
    expect(ledger.online).toBe(7) // 智能塔机3 离线
    expect(ledger.unitsOf('crane')).toHaveLength(4)
    expect(ledger.unitsOf('lift')).toHaveLength(2)
    expect(ledger.categoryUnits('climb')).toHaveLength(1)

    // deviceSet 是同步消费方（弹层宿主 / 报表），必须立刻看到同一批机组
    expect(deviceSet('crane').units).toHaveLength(4)
    // 机组按台号升序（服务端按 id 倒序返回，见 utils/deviceLedger.ts: byUnitNo）
    expect(deviceSet('lift').units.map((u) => u.name)).toEqual(['智能电梯1', '智能电梯2'])
    expect(deviceSet('crane').units.map((u) => u.name)).toEqual([
      '智能塔机2',
      '智能塔机3',
      '智能塔机4',
      '传统塔机5',
    ])
  })

  it('load 成功：state=ok 且有更新时间', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ledgerEnvelope()))
    const ledger = useDeviceLedgerStore()

    await ledger.load('token')

    expect(ledger.state).toBe('ok')
    expect(ledger.hasData).toBe(true)
    expect(ledger.updatedAt).toMatch(/^\d{2}:\d{2}$/)
  })

  it('没有 token 时不发请求（未登录交给登录守卫）', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const ledger = useDeviceLedgerStore()

    await ledger.load('')

    expect(spy).not.toHaveBeenCalled()
    expect(ledger.state).toBe('idle')
  })

  it('load 失败：state=error 并清空既有数据，避免把旧台账当最新', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }) as unknown as Response))
    const ledger = useDeviceLedgerStore()
    ledger.apply(deviceRows())

    await ledger.load('token', true)

    expect(ledger.state).toBe('error')
    expect(ledger.rows).toEqual([])
    expect(ledger.hasData).toBe(false)
    expect(deviceSet('crane').units).toEqual([])
  })

  it('reset 清空台账与登记表（退出登录 / 换账号）', () => {
    const ledger = useDeviceLedgerStore()
    ledger.apply(deviceRows())

    ledger.reset()

    expect(ledger.rows).toEqual([])
    expect(ledger.state).toBe('idle')
    expect(deviceSet('crane').units).toEqual([])
  })
})
