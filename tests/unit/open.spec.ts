/**
 * 大屏 open 接口客户端 + 首页人员块 store。
 *
 * 重点覆盖几件容易出错的事：
 *   ① 签名串拼接顺序与 URL 参数名必须与现场一致（错了就是 403，看不出原因）；
 *   ② 信封里 `success` / `successful` 两种拼写都有，不能被判成失败；
 *   ③ 取不到数时给 null / 空数组（页面显示空态），**不再回落演示数据**；
 *   ④ 班组 / 分时两个接口的字段收敛（`hours` 是小时数不是人数，最容易看反）。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toPersonHour, toTeams, toWeekEnterprise } from '@/api/home'
import { openGet, signedUrl } from '@/api/open'
import { fetchPersonOverall } from '@/api/overview'
import { KPI_META, useOverviewStore } from '@/stores/overview'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('大屏 open 签名', () => {
  it('URL 带齐 projectKey / accessKey / timestamp / nonce / sign', () => {
    const url = new URL(signedUrl('/bigScreen/BigsHome/personOverall'))
    expect(url.origin + url.pathname).toBe('https://dw.yzw.cn/open/bigScreen/BigsHome/personOverall')
    expect(url.searchParams.get('projectKey')).toBe('b35df2e91ed642c595ca96d0bc2d9ed9')
    expect(url.searchParams.get('accessKey')).toBe('be69162bdd4e46619ac95824a88b1ec2')
    expect(url.searchParams.get('timestamp')).toMatch(/^\d{13}$/)
    expect(url.searchParams.get('nonce')).toMatch(/^[0-9a-f]{32}$/)
    // PKCS#1 v1.5 签名是 128 字节固定长度，Base64 后 172 字符且以 "=" 收尾
    const sign = url.searchParams.get('sign') ?? ''
    expect(sign).toHaveLength(172)
    expect(sign.endsWith('=')).toBe(true)
  })

  it('额外查询参数会带上（筛选条件全靠它）', () => {
    const url = new URL(signedUrl('/bigScreen/bigAlarm/getAlarmRecord', { startTime: '2026-11-01', page: 2 }))
    expect(url.searchParams.get('startTime')).toBe('2026-11-01')
    expect(url.searchParams.get('page')).toBe('2')
  })
})

describe('openGet', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('解包 data，且接受 successful 拼写', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ statusCode: 20000, successful: true, data: { managedNum: 160 } })))
    await expect(openGet('/bigScreen/BigsHome/personOverall')).resolves.toEqual({ managedNum: 160 })
  })

  it('statusCode 非 20000 时抛出服务端文案（实测 57007 = 接口权限未获取）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ statusCode: 57007, message: '接口权限未获取' })))
    await expect(openGet('/person/page')).rejects.toThrow('接口权限未获取')
  })

  it('HTTP 层失败也要抛错，不能把 undefined 当数据往下传', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 403)))
    await expect(openGet('/person/page')).rejects.toThrow('HTTP 403')
  })
})

describe('fetchPersonOverall 字段收敛', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('字符串数字转成 number，缺字段留 undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          statusCode: 20000,
          data: { managedNum: '352', workingNum: 24, atteRate: '30.0000' },
        }),
      ),
    )
    const d = await fetchPersonOverall()
    expect(d.managedNum).toBe(352)
    expect(d.workingNum).toBe(24)
    expect(d.atteRate).toBe(30)
    expect(d.atteNum).toBeUndefined()
  })
})

describe('overview store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 10, 10, 9, 30))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('取数成功：四指标用真值，出勤率保留一位', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          statusCode: 20000,
          data: { managedNum: 352, workingNum: 24, atteNum: 48, atteRate: 30.0000 },
        }),
      ),
    )
    const s = useOverviewStore()
    await s.load()

    expect(s.hasLive).toBe(true)
    expect(s.kpis.map(([n]) => n)).toEqual([352, 24, 48, 30])
    expect(s.kpis.map(([, , name]) => name)).toEqual(KPI_META.map(([, name]) => name))
    expect(s.updatedAt).toBe('09:30')
  })

  it('取数失败：指标留空（不回落演示值）并记下错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)))
    const s = useOverviewStore()
    await s.load()

    expect(s.hasLive).toBe(false)
    expect(s.error).toContain('HTTP 500')
    // 四个指标全部为 null —— 页面渲染成「—」，绝不拿写死的数字顶上去
    expect(s.kpis.map(([n]) => n)).toEqual([null, null, null, null])
    expect(s.updatedAt).toBe('')
  })

  it('只缺某一项时该项留空，不整组丢真值', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ statusCode: 20000, data: { managedNum: 352 } })))
    const s = useOverviewStore()
    await s.load()

    expect(s.kpis[0][0]).toBe(352)
    expect(s.kpis[1][0]).toBeNull()
  })

  it('失败后冷却期内不再重复请求，force 可绕过', async () => {
    const f = vi.fn(async () => jsonResponse({}, 500))
    vi.stubGlobal('fetch', f)
    const s = useOverviewStore()
    await s.load()
    await s.load()
    // 一次 load 会并发打三个接口（人员总览 / 班组出勤 / 分时人数），冷却期内不该再打
    expect(f).toHaveBeenCalledTimes(3)

    await s.load(true)
    expect(f).toHaveBeenCalledTimes(6)
  })
})

/* ---------------------------------------------------------------------------
 * 阶段 2：今日班组出勤 / 今日分时人数
 * ------------------------------------------------------------------------- */

describe('toTeams 收敛', () => {
  it('字段映射 + 按出勤率降序', () => {
    const rows = toTeams([
      { organId: 'a', organName: '产业工人班组', personNum: 38, atteNum: 6, atteRate: 15.79 },
      { organId: 'b', organName: '管理人员', personNum: 19, atteNum: 12, atteRate: 63.16 },
      { organId: 'c', organName: '劳务班组', personNum: 103, atteNum: 31, atteRate: 30.1 },
    ])
    expect(rows.map((r) => r.organName)).toEqual(['管理人员', '劳务班组', '产业工人班组'])
    expect(rows[0]).toEqual({ organId: 'b', organName: '管理人员', personNum: 19, atteNum: 12, atteRate: 63.16 })
  })

  it('数字可能是字符串；缺名或缺出勤数的脏行丢掉', () => {
    const rows = toTeams([
      { organName: '木工班', personNum: '10', atteNum: '4', atteRate: '40.0' },
      { organName: '', atteNum: 3 },
      { organName: '没出勤数' },
      null,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ organName: '木工班', personNum: 10, atteNum: 4, atteRate: 40 })
  })

  it('非数组（接口异常返回对象/字符串）当作空结果', () => {
    expect(toTeams({ rows: [] })).toEqual([])
    expect(toTeams(undefined)).toEqual([])
  })
})

describe('toPersonHour 收敛', () => {
  it('接口字段叫 hours（小时数），不是人数', () => {
    const d = toPersonHour({
      manager: [{ hours: 9, num: 12 }, { hours: 8, num: 5 }],
      worker: [{ hours: 8, num: 18 }],
    })
    // 排序后按小时升序
    expect(d.manager).toEqual([{ hour: 8, num: 5 }, { hour: 9, num: 12 }])
    expect(d.worker).toEqual([{ hour: 8, num: 18 }])
  })

  it('越界小时与非法人数被丢掉', () => {
    const d = toPersonHour({ manager: [{ hours: 24, num: 1 }, { hours: -1, num: 2 }, { hours: 3 }], worker: [] })
    expect(d.manager).toEqual([])
    expect(d.worker).toEqual([])
  })

  it('缺字段时给空数组，不抛错', () => {
    expect(toPersonHour(undefined)).toEqual({ manager: [], worker: [] })
    expect(toPersonHour({})).toEqual({ manager: [], worker: [] })
  })
})

describe('toWeekEnterprise 收敛', () => {
  it('按日拆出企业列表', () => {
    const d = toWeekEnterprise([
      { date: '11-10', enterpriseList: [{ enterpriseId: 'e1', enterpriseName: '中建三局', personNum: 19, atteNum: 12, atteRate: 24.49 }] },
      { date: '11-09', enterpriseList: [] },
    ])
    expect(d).toHaveLength(2)
    expect(d[0].date).toBe('11-10')
    expect(d[0].list[0].enterpriseName).toBe('中建三局')
  })
})

describe('首页人员块 store 换源', () => {
  /** 按 URL 片段分发响应：一次 load 会并发打三个接口 */
  function route(inflight: Record<string, unknown>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const key = Object.keys(inflight).find((k) => String(url).includes(k))
        return key ? jsonResponse({ statusCode: 20000, data: inflight[key] }) : jsonResponse({}, 500)
      }),
    )
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 10, 10, 10, 5))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('三块数据都取到真值时全部上屏', async () => {
    route({
      personOverall: { managedNum: 160, workingNum: 19, atteNum: 48, atteRate: 30 },
      todayTeamsAtteStat: [
        { organName: '管理人员', personNum: 19, atteNum: 12, atteRate: 63.16 },
        { organName: '劳务班组', personNum: 103, atteNum: 31, atteRate: 30.1 },
      ],
      todayPersonHourStat: {
        manager: [{ hours: 9, num: 12 }, { hours: 10, num: 13 }],
        worker: [{ hours: 9, num: 18 }, { hours: 10, num: 17 }],
      },
    })
    const s = useOverviewStore()
    await s.load()

    expect(s.kpis.map(([n]) => n)).toEqual([160, 19, 48, 30])
    expect(s.teamRows).toEqual([
      ['管理人员', 12, '63.16%'],
      ['劳务班组', 31, '30.10%'],
    ])
    expect(s.hourLive).toEqual({ hours: [9, 10], workers: [18, 17], managers: [12, 13] })
    expect(s.updatedAt).toBe('10:05')
  })

  it('两条系列整点不一致时按并集对齐、缺的一侧补 0', async () => {
    route({
      personOverall: { managedNum: 160 },
      todayTeamsAtteStat: [],
      // 管理人员 8:00 就在场，工人 9:00 才到
      todayPersonHourStat: {
        manager: [{ hours: 8, num: 5 }, { hours: 9, num: 12 }],
        worker: [{ hours: 9, num: 18 }, { hours: 10, num: 17 }],
      },
    })
    const s = useOverviewStore()
    await s.load()

    expect(s.hourLive).toEqual({ hours: [8, 9, 10], workers: [0, 18, 17], managers: [5, 12, 0] })
  })

  it('班组接口返回空数组时给空列表（页面显示「暂无班组出勤数据」）', async () => {
    route({
      personOverall: { managedNum: 160 },
      todayTeamsAtteStat: [],
      todayPersonHourStat: { manager: [], worker: [] },
    })
    const s = useOverviewStore()
    await s.load()

    expect(s.teamRows).toEqual([])
    expect(s.teamsState).toBe('ok')
    expect(s.hourLive).toBeUndefined()
  })

  it('分时数据不足两个整点时不画真线，回落演示曲线', async () => {
    route({
      personOverall: { managedNum: 160 },
      todayTeamsAtteStat: [],
      todayPersonHourStat: { manager: [{ hours: 9, num: 12 }], worker: [{ hours: 9, num: 18 }] },
    })
    const s = useOverviewStore()
    await s.load()

    expect(s.hourLive).toBeUndefined()
  })

  it('某个接口失败只影响它自己那块，其余真值不丢', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('personOverall')) {
          return jsonResponse({ statusCode: 20000, data: { managedNum: 160, atteNum: 48 } })
        }
        return jsonResponse({ statusCode: 57007, message: '接口权限未获取' })
      }),
    )
    const s = useOverviewStore()
    await s.load()

    expect(s.kpis[0][0]).toBe(160)
    expect(s.error).toBe('')
    // 班组 / 分时两个接口挂了：给空，不拿演示数据补
    expect(s.teamRows).toEqual([])
    expect(s.teamsState).toBe('error')
    expect(s.hourLive).toBeUndefined()
  })
})
