/**
 * 物联网网关（C 组）、定位设备台账（B 组）、天气代理（E 组）三个客户端。
 *
 * 这三组的坑各不相同，各钉一条：
 *   ① C 组换令牌的字段是 `ak`/`sk`（不是 appKey/appSecret），且**成功码是
 *      `status === 0`**（不是 200）—— 判错成功码会把失败当成功；
 *   ② B 组网关有 `areaName`，但**定位标签行没有区域字段**，所以「区域人数」
 *      这条链路走不通（人数位只能显示「—」）；
 *   ③ E 组 `city` 要的是**六位 adcode**，传城市名会被判 400。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyToken,
  clearToken,
  fetchEvents,
  fetchRealtimeData,
  requestToken,
  toPoints,
} from '@/api/iot'
import { fetchBeacons, fetchGateways, fetchLabels } from '@/api/iotDevice'
import {
  DEFAULT_ADCODE,
  fetchForecastWeather,
  fetchLiveWeather,
  toForecast,
  toLiveWeather,
} from '@/api/weather'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** B 组 open 的信封：`{statusCode:20000, data}` */
function openResponse(data: unknown): Response {
  return jsonResponse({ statusCode: 20000, success: true, data })
}

afterEach(() => {
  clearToken()
  vi.unstubAllGlobals()
})

describe('C 组换令牌', () => {
  it('请求体是 ak/sk（不是 appKey/appSecret）', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: 0, data: { tokenKey: 'X-APP-USER', tokenValue: 'V1', expireTs: 172800 } }),
    )
    vi.stubGlobal('fetch', f)

    const t = await requestToken()

    const body = JSON.parse(String(f.mock.calls[0][1]?.body))
    expect(body).toHaveProperty('ak')
    expect(body).toHaveProperty('sk')
    expect(body.appKey).toBeUndefined()
    expect(t.tokenKey).toBe('X-APP-USER')
    expect(t.tokenValue).toBe('V1')
  })

  it('成功码是 status === 0，不是 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 10, msg: '缺少必要输入' })))
    await expect(requestToken()).rejects.toThrow('缺少必要输入')
  })

  it('没返回令牌时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 0, data: {} })))
    await expect(requestToken()).rejects.toThrow('未返回令牌')
  })

  it('业务请求带上令牌头', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ status: 0, data: [] }))
    vi.stubGlobal('fetch', f)

    await fetchRealtimeData([{ productCode: 'P000000076', sn: 'SN1', field: 'height', code: 'c1' }])

    const init = f.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers['X-APP-USER']).toBe('V1')
  })

  it('查询体是 queryList，缺 productCode 时用项目码兜底', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ status: 0, data: [] }))
    vi.stubGlobal('fetch', f)

    await fetchRealtimeData([{ productCode: '', sn: 'SN1', field: 'height', code: 'c1' }])

    const body = JSON.parse(String(f.mock.calls[0][1]?.body))
    expect(body.queryList).toHaveLength(1)
    expect(body.queryList[0].productCode).toBe('P000000076')
    expect(body.queryList[0].sn).toBe('SN1')
  })

  it('查询项为空时直接返回空数组，不发请求', async () => {
    const f = vi.fn(async () => jsonResponse({ status: 0, data: [] }))
    vi.stubGlobal('fetch', f)

    expect(await fetchRealtimeData([])).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })

  it('事件查询体是 startTime / endTime / eventItems', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ status: 0, data: [] }))
    vi.stubGlobal('fetch', f)

    await fetchEvents([{ productCode: 'P000000076', sn: 'SN1', field: 'height', code: 'c1' }], '2026-11-01 00:00:00', '2026-11-02 00:00:00')

    const body = JSON.parse(String(f.mock.calls[0][1]?.body))
    expect(body.startTime).toBe('2026-11-01 00:00:00')
    expect(body.endTime).toBe('2026-11-02 00:00:00')
    expect(body.eventItems).toHaveLength(1)
  })
})

describe('toPoints 收敛', () => {
  it('映射 uuid / timestamp / metricIndex / value', () => {
    const p = toPoints([{ uuid: 'u1', timestamp: 1762000000000, metricIndex: 0, value: 12.5 }])
    expect(p).toEqual([{ uuid: 'u1', timestamp: 1762000000000, metricIndex: 0, value: 12.5 }])
  })

  it('缺 uuid 的行丢掉；缺 value 是 null 不是 0', () => {
    const p = toPoints([{ timestamp: 1 }, { uuid: 'u1' }])
    expect(p).toHaveLength(1)
    expect(p[0].value).toBeNull()
  })

  it('非数组当空结果', () => {
    expect(toPoints(undefined)).toEqual([])
  })
})

describe('B 组定位设备台账', () => {
  it('网关映射 areaName / gpsCoord / 在线态', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        openResponse({
          total: '102',
          rows: [
            {
              id: '2069606121346019329',
              gatewayNo: 'YZBS025E154D8CBDE4',
              name: '主基站—地下室负一层灯带变压器',
              isOnline: 1,
              areaId: '2069609381016481793',
              areaName: 'B1管理区域',
              height: 200,
              coverRange: 100,
              gpsCoord: '{"lat":30.5369,"lng":114.2577}',
            },
          ],
        }),
      ),
    )

    const rows = await fetchGateways()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      gatewayNo: 'YZBS025E154D8CBDE4',
      areaName: 'B1管理区域',
      isOnline: 1,
      height: 200,
      coverRange: 100,
    })
    expect(rows[0].gpsCoord).toContain('30.5369')
  })

  it('标签映射 personId / 在线态 / 电量', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        openResponse({
          total: '200',
          rows: [
            {
              labelSn: 'YZLB020976764DBC2E',
              personId: '2070676604222607364',
              thirdpartyPersonId: '2007685',
              isOnline: 1,
              power: 100,
              isMotionless: 1,
            },
          ],
        }),
      ),
    )

    const rows = await fetchLabels()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ labelSn: 'YZLB020976764DBC2E', personId: '2070676604222607364', isOnline: 1, power: 100 })
  })

  it('标签行没有区域字段 —— 区域人数这条链路走不通', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        openResponse({
          total: '1',
          rows: [{ labelSn: 'S1', personId: 'P1', isOnline: 1, power: 100 }],
        }),
      ),
    )

    const rows = await fetchLabels()
    // 没有任何区域/网关关联字段：不能靠标签推断人员所在区域
    expect(Object.keys(rows[0])).not.toContain('areaId')
    expect(Object.keys(rows[0])).not.toContain('areaName')
    expect(Object.keys(rows[0])).not.toContain('gatewayNo')
  })

  it('信标映射网关关联与部署态', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        openResponse({
          total: '78',
          rows: [{ gatewaySn: 'G1', gatewayName: '主基站', isOnline: 1, isDeploy: 1, power: 90 }],
        }),
      ),
    )

    const rows = await fetchBeacons()
    expect(rows[0]).toMatchObject({ gatewaySn: 'G1', gatewayName: '主基站', isOnline: 1, isDeploy: 1, power: 90 })
  })

  it('缺关键字段的行丢掉', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openResponse({ total: '2', rows: [{ name: '无 sn' }, { gatewayNo: 'G1' }] })))
    const rows = await fetchGateways()
    expect(rows).toHaveLength(1)
    expect(rows[0].gatewayNo).toBe('G1')
  })

  it('服务端 total 与实际返回不一致时按唯一键去重，不重复累加', async () => {
    // 实测会出现 total=102 但当页只回 1 行的情况；不去重的话同一行会被累加 5 次，
    // 在线设备数会虚高。
    vi.stubGlobal('fetch', vi.fn(async () => openResponse({ total: '102', rows: [{ gatewayNo: 'G1', isOnline: 1 }] })))
    const rows = await fetchGateways()
    expect(rows).toHaveLength(1)
  })

  it('分页取满 total 即停，不多打一页', async () => {
    const f = vi.fn(async () => openResponse({ total: '1', rows: [{ gatewayNo: 'G1' }] }))
    vi.stubGlobal('fetch', f)

    await fetchGateways()

    expect(f).toHaveBeenCalledTimes(1)
  })

  it('open 业务码非 20000 时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ statusCode: 57007, message: '接口权限未获取' })))
    await expect(fetchGateways()).rejects.toThrow('接口权限未获取')
  })
})

describe('E 组天气', () => {
  it('city 传的是六位 adcode，不是城市名', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ status: '1', lives: [] }))
    vi.stubGlobal('fetch', f)

    await fetchLiveWeather()

    expect(String(f.mock.calls[0][0])).toContain(`city=${DEFAULT_ADCODE}`)
    expect(DEFAULT_ADCODE).toMatch(/^\d{6}$/)
  })

  it('实时天气映射字段', () => {
    const w = toLiveWeather({
      status: '1',
      lives: [
        {
          province: '湖北省',
          city: '武汉市',
          adcode: '420100',
          weather: '阴',
          temperature: '19',
          winddirection: '东南',
          windpower: '≤3',
          humidity: '75',
          reporttime: '16:31',
        },
      ],
    })
    expect(w).toMatchObject({ city: '武汉市', weather: '阴', temperature: '19', humidity: '75' })
  })

  it('没有 lives 时返回 null（页面显示空态）', () => {
    expect(toLiveWeather({ status: '1', lives: [] })).toBeNull()
    expect(toLiveWeather(undefined)).toBeNull()
  })

  it('预报按天拆出 casts', () => {
    const f = toForecast({
      status: '1',
      forecasts: [
        {
          city: '武汉市',
          adcode: '420100',
          province: '湖北省',
          reporttime: '16:31',
          casts: [{ date: '2026-11-12', week: '4', dayweather: '晴', daytemp: '22', nighttemp: '12' }],
        },
      ],
    })
    expect(f?.casts).toHaveLength(1)
    expect(f?.casts[0].date).toBe('2026-11-12')
    expect(f?.casts[0].dayweather).toBe('晴')
  })

  it('没有 forecasts 时返回 null', () => {
    expect(toForecast({ status: '1', forecasts: [] })).toBeNull()
  })

  it('高德参数错误（code 400）时抛服务端文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 400, message: 'city must be a six-digit adcode' }, 400)))
    await expect(fetchLiveWeather('河源')).rejects.toThrow('six-digit adcode')
  })

  it('网络不可达时抛「天气服务不可达」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(fetchForecastWeather()).rejects.toThrow('天气服务不可达')
  })
})
