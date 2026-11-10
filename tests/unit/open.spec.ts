/**
 * 大屏 open 接口客户端 + 人员总览 store。
 *
 * 重点覆盖三件容易出错的事：
 *   ① 签名串拼接顺序与 URL 参数名必须与现场一致（错了就是 403，看不出原因）；
 *   ② 信封里 `success` / `successful` 两种拼写都有，不能被判成失败；
 *   ③ 取不到数时要回落到演示数据，而不是把首页变成 0。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openGet, signedUrl } from '@/api/open'
import { fetchPersonOverall } from '@/api/overview'
import { crewKpis } from '@/data/config'
import { useOverviewStore } from '@/stores/overview'

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
    expect(s.kpis.map(([, , name]) => name)).toEqual(crewKpis.map(([, , name]) => name))
    expect(s.updatedAt).toBe('09:30')
  })

  it('取数失败：整组回落到演示数据，并记下错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)))
    const s = useOverviewStore()
    await s.load()

    expect(s.hasLive).toBe(false)
    expect(s.error).toContain('HTTP 500')
    expect(s.kpis.map(([n]) => n)).toEqual(crewKpis.map(([n]) => n))
    expect(s.updatedAt).toBe('')
  })

  it('只缺某一项时逐项回落，不整组丢真值', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ statusCode: 20000, data: { managedNum: 352 } })))
    const s = useOverviewStore()
    await s.load()

    expect(s.kpis[0][0]).toBe(352)
    expect(s.kpis[1][0]).toBe(crewKpis[1][0])
  })

  it('失败后冷却期内不再重复请求，force 可绕过', async () => {
    const f = vi.fn(async () => jsonResponse({}, 500))
    vi.stubGlobal('fetch', f)
    const s = useOverviewStore()
    await s.load()
    await s.load()
    expect(f).toHaveBeenCalledTimes(1)

    await s.load(true)
    expect(f).toHaveBeenCalledTimes(2)
  })
})
