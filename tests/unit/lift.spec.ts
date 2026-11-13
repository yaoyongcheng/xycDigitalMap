/**
 * 智能电梯：数据整形（utils/lift）与 IOT 客户端（api/lift）。
 *
 * 这里钉住四件容易出错的事：
 *   ① 服务端时间是 `'yyyy-MM-dd HH:mm:ss'`（无时区），必须按 +08:00 解析，
 *      否则和 `timestamp` 混用会整错 8 小时；
 *   ② 「今日累计运行时间」是**首尾跨度**（末.end − 首.start），与 V2
 *      `FetchWorkCycleAsync` 同口径，停机时间计入；
 *   ③ 请求必须用**电梯产品码**，不是项目码 `P000000076`（拿错会被判「非法产品」）；
 *   ④ 网关没记录的台次不能写成 0 ——「今天没跑」和「没有数据」是两件事。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { clearToken, applyToken, fetchEventRows, fetchRealtimeRows } from '@/api/iot'
import {
  clearLiftAuthFailure,
  fetchLiftAttr,
  fetchLiftOnline,
  fetchLiftToday,
  LIFT_PRODUCT,
  liftAuthFailed,
  liftGatewayStale,
} from '@/api/lift'
import { LIFT_SNS } from '@/data/liftSn'
import { useLiftStore } from '@/stores/lift'
import {
  DASH,
  formatFloor,
  formatHeight,
  formatHours,
  formatLoad,
  formatPeople,
  formatRuntime,
  formatTrips,
  parseServerTime,
  stateText,
  sumWork,
  toAttr,
} from '@/utils/lift'
import type { IotEventRow } from '@/api/iot'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response
}

/** 一次成功的 IOT 响应信封：成功码是 `status === 0` */
function iotOk(data: unknown): Response {
  return jsonResponse({ status: 0, msg: '', data })
}

/** 造一条工作循环事件 */
function workRow(sn: string, start: string, end: string): IotEventRow {
  return {
    timestamp: 0,
    metricIndex: `${LIFT_PRODUCT}~${sn}~EVENT_WORKDATA`,
    resultMap: { runStartTime: start, runEndTime: end },
  }
}

afterEach(() => {
  // `clearToken()` 不清「废牌记忆」（见 api/iot.ts），用例之间显式抹掉
  applyToken(null)
  clearToken()
  // 凭证失效痕迹是模块级状态，不清会串到下一条用例
  clearLiftAuthFailure()
  vi.unstubAllGlobals()
})

describe('parseServerTime', () => {
  it('无时区的时间串按 +08:00 解析', () => {
    // 2026-11-13 06:23:53 (UTC+8) === 2026-11-12T22:23:53Z
    expect(parseServerTime('2026-11-13 06:23:53')).toBe(Date.UTC(2026, 10, 12, 22, 23, 53))
  })

  it('已经带时区的串不再补', () => {
    expect(parseServerTime('2026-11-13T06:23:53+08:00')).toBe(Date.UTC(2026, 10, 12, 22, 23, 53))
  })

  it('空串 / 垃圾串给 null（不拿 0 当起点）', () => {
    expect(parseServerTime('')).toBeNull()
    expect(parseServerTime(undefined)).toBeNull()
    expect(parseServerTime('昨天下午')).toBeNull()
  })
})

describe('sumWork', () => {
  it('按首尾跨度算（V2 口径），次数 = 条数', () => {
    const rows = [
      workRow('SN1', '2026-11-13 06:23:53', '2026-11-13 06:25:52'),
      workRow('SN1', '2026-11-13 06:30:29', '2026-11-13 06:32:22'),
    ]
    // 06:32:22 − 06:23:53 = 509s（若逐条累加只有 119 + 113 = 232s）
    expect(sumWork(rows)).toEqual({ trips: 2, seconds: 509 })
  })

  it('停机间隔计入 —— 与 V2 FetchWorkCycleAsync 逐字一致', () => {
    // 两条各 2 分钟，中间停 1 小时。V2 的 (末.end − 首.start) 就是 62 分钟，
    // 这里必须给同一个数：现场拿两个系统对账，差 1 小时就是「数据不准」。
    const rows = [
      workRow('SN1', '2026-11-13 08:00:00', '2026-11-13 08:02:00'),
      workRow('SN1', '2026-11-13 09:00:00', '2026-11-13 09:02:00'),
    ]
    expect(sumWork(rows).seconds).toBe(3720)
  })

  it('末条还没跑完（缺 end）时退到最后一条有效结束，不掉成 0', () => {
    // V2 在这一步是 `Data[count-1].RunEndTime` 为空就整段跳过 → 显示 0h。
    // 那会把一格攒了一天的值在最后一次升降期间打成 0，所以这里退一条。
    const rows: IotEventRow[] = [
      workRow('SN1', '2026-11-13 08:00:00', '2026-11-13 08:10:00'),
      { timestamp: 0, metricIndex: 'p~SN1~EVENT_WORKDATA', resultMap: { runStartTime: '2026-11-13 09:00:00' } },
    ]
    expect(sumWork(rows)).toEqual({ trips: 2, seconds: 600 })
  })

  it('首条缺 start 时退到后一条，脏行照样计入次数', () => {
    const rows: IotEventRow[] = [
      { timestamp: 0, metricIndex: 'p~SN1~EVENT_WORKDATA', resultMap: { runEndTime: '2026-11-13 07:00:00' } },
      workRow('SN1', '2026-11-13 08:00:00', '2026-11-13 08:30:00'),
    ]
    expect(sumWork(rows)).toEqual({ trips: 2, seconds: 1800 })
  })

  it('end 早于 start 的脏记录不造负值', () => {
    const rows = [workRow('SN1', '2026-11-13 09:00:00', '2026-11-13 08:00:00')]
    expect(sumWork(rows)).toEqual({ trips: 1, seconds: 0 })
  })

  it('resultMap 为 null 的行不崩', () => {
    const rows: IotEventRow[] = [{ timestamp: 0, metricIndex: 'p~SN1~EVENT_WORKDATA', resultMap: null }]
    expect(sumWork(rows)).toEqual({ trips: 1, seconds: 0 })
  })
})

describe('formatRuntime', () => {
  it('不足 1 分钟给 0min，不足 1 小时给分钟', () => {
    expect(formatRuntime(0)).toBe('0min')
    expect(formatRuntime(30)).toBe('1min')
    expect(formatRuntime(2841)).toBe('47min')
  })

  it('超过 1 小时给一位小数的小时', () => {
    expect(formatRuntime(3600)).toBe('1.0h')
    expect(formatRuntime(12600)).toBe('3.5h')
  })
})

describe('toAttr', () => {
  it('取 relFloor / height / numberOfPeople / load / runningState', () => {
    const a = toAttr(
      { relFloor: 15, height: 40.1, numberOfPeople: 3, load: 480.5, runningState: 2, speed: 0.3 },
      123,
    )
    expect(a).toEqual({
      floor: 15,
      height: 40.1,
      people: 3,
      load: 480.5,
      state: 2,
      speed: 0.3,
      at: 123,
    })
  })

  it('缺字段一律 null（不填 0）', () => {
    const a = toAttr({ relFloor: 0 }, null)
    expect(a.floor).toBe(0)
    expect(a.height).toBeNull()
    expect(a.people).toBeNull()
    expect(a.load).toBeNull()
    expect(a.state).toBeNull()
  })
})

describe('展示格式化（弹层与卡片共用）', () => {
  it('stateText 照 V2 的 switch：1 停止 / 2 上升 / 3 下降 / 其余在线', () => {
    expect(stateText(1)).toBe('停止')
    expect(stateText(2)).toBe('上升')
    expect(stateText(3)).toBe('下降')
    expect(stateText(4)).toBe('在线')
    // 没有工况帧就不给文案：那时连「在线」都不能断言
    expect(stateText(null)).toBeNull()
  })

  it('各项单位与小数位照 UIPanelElevator', () => {
    expect(formatFloor(8)).toBe('8F')
    expect(formatHeight(22.4)).toBe('22.4m')
    // 载重是 kg 不是吨
    expect(formatLoad(480.5)).toBe('480.5kg')
    expect(formatPeople(6)).toBe('6人')
    expect(formatHours(23_040)).toBe('6.4h')
    expect(formatTrips(86)).toBe('86次')
  })

  it('空值一律「—」，不写 0', () => {
    for (const f of [formatFloor, formatHeight, formatLoad, formatPeople, formatHours, formatTrips]) {
      expect(f(null)).toBe(DASH)
    }
  })
})

describe('api/lift 请求契约', () => {
  function stub() {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    const f = vi.fn(async (_url: string, _init?: RequestInit) => iotOk([]))
    vi.stubGlobal('fetch', f)
    return f
  }

  it('在线状态用电梯产品码 + field/code，不落到项目码', async () => {
    const f = stub()
    await fetchLiftOnline()

    // 逐台请求（V2 `foreach (sn in DeviceSnList)`）：4 个轿厢发 4 个请求，
    // 每个 queryList 只装一台 —— 混批时一台无效会让错误归属变模糊
    expect(f).toHaveBeenCalledTimes(4)
    const sns: string[] = []
    for (const [, init] of f.mock.calls) {
      const body = JSON.parse(String(init?.body))
      expect(body.queryList).toHaveLength(1)
      expect(body.queryList[0].productCode).toBe(LIFT_PRODUCT)
      expect(body.queryList[0].productCode).not.toBe('P000000076')
      expect(body.queryList[0].field).toBe('online')
      expect(body.queryList[0].code).toBe('EVENT_ON_OFF')
      sns.push(body.queryList[0].sn)
    }
    expect(new Set(sns).size).toBe(4)
  })

  it('在线状态把 "true"/"false" 字符串转成布尔，没返回的编号不进表', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        iotOk([
          { timestamp: 1, metricIndex: `${LIFT_PRODUCT}~3225122202~EVENT_ON_OFF~online`, value: 'true' },
          { timestamp: 2, metricIndex: `${LIFT_PRODUCT}~E03C1CB9F5011824~EVENT_ON_OFF~online`, value: 'false' },
        ]),
      ),
    )

    const map = await fetchLiftOnline()
    expect(map).toEqual({ '3225122202': true, E03C1CB9F5011824: false })
    // 网关没记录的编号不出现 —— 上层据此区分「明确离线」与「没上报过」
    expect(map).not.toHaveProperty('32251222021')
  })

  it('今日作业按 sn 归组，没有事件的台次不出现在表里', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        iotOk([
          {
            timestamp: 1,
            metricIndex: `${LIFT_PRODUCT}~3225122202~EVENT_WORKDATA`,
            resultMap: { runStartTime: '2026-11-13 06:23:53', runEndTime: '2026-11-13 06:25:52' },
          },
        ]),
      ),
    )

    const map = await fetchLiftToday(new Date(2026, 10, 13, 10, 0, 0))
    expect(map).toEqual({ '3225122202': { trips: 1, seconds: 119 } })
    expect(Object.keys(map ?? {})).toHaveLength(1)
  })

  it('今日作业的时间窗是本地当天 00:00:00 ~ 23:59:59.999', async () => {
    const f = stub()
    await fetchLiftToday(new Date(2026, 10, 13, 10, 0, 0))

    const body = JSON.parse(String(f.mock.calls[0][1]?.body))
    expect(body.startTime).toBe(new Date(2026, 10, 13).getTime())
    expect(body.endTime).toBe(new Date(2026, 10, 13, 23, 59, 59, 999).getTime())
    expect(body.eventItems[0].eventCode).toBe('EVENT_WORKDATA')
    expect(body.eventItems[0].productCode).toBe(LIFT_PRODUCT)
  })

  it('工况取每台最新一帧', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        iotOk([
          { timestamp: 100, metricIndex: `${LIFT_PRODUCT}~3225122202~EVENT_POST_ATTR`, resultMap: { relFloor: 3 } },
          { timestamp: 300, metricIndex: `${LIFT_PRODUCT}~3225122202~EVENT_POST_ATTR`, resultMap: { relFloor: 15 } },
          { timestamp: 200, metricIndex: `${LIFT_PRODUCT}~3225122202~EVENT_POST_ATTR`, resultMap: { relFloor: 9 } },
        ]),
      ),
    )

    const map = await fetchLiftAttr()
    expect(map?.['3225122202'].floor).toBe(15)
  })

  it('网关报错时返回 null，不抛给页面', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 10, msg: '所选设备您无权操作' })),
    )

    expect(await fetchLiftOnline()).toBeNull()
    expect(await fetchLiftToday()).toBeNull()
    expect(await fetchLiftAttr()).toBeNull()
    // 业务报错（设备无权）不是凭证问题，不该弹「重新登录」
    expect(liftAuthFailed()).toBe(false)
  })

  /**
   * 令牌失效时网关回 **HTTP 401 + `{status:11, msg:"权限不足"}`**。
   * 这种情况必须留痕，页面才能提示用户重新登录 —— 只把边界收敛成 null，
   * 用户看到的会是满屏「—」而不知道该做什么。
   */
  it('令牌失效（401 + status 11）留下凭证失效痕迹，成功取数后自动清掉', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'STALE', expiresAt: Date.now() + 60_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 11, msg: '权限不足', data: null }, 401)),
    )

    expect(await fetchLiftOnline()).toBeNull()
    expect(liftAuthFailed()).toBe(true)

    // 换到好令牌后成功取数，痕迹应当自动清掉（否则提示条永远挂着）
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'FRESH', expiresAt: Date.now() + 60_000 })
    vi.stubGlobal('fetch', vi.fn(async () => iotOk([])))

    expect(await fetchLiftOnline()).toEqual({})
    expect(liftAuthFailed()).toBe(false)
  })

  /**
   * 「换了等于没换」：换令牌接口幂等，服务端没轮换之前会原样再发一张。
   * 这时**不能**再拿它去打 12 个数据接口（4 台 × 3 个取数），否则用户每点一次
   * 「重试」就白撞一轮网关。自检在 `api/iot.ts` 的 `ensureToken` 里就收手。
   */
  it('换回同一张令牌 → 记「网关尚未恢复」，不再带着废令牌重撞数据接口', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'STALE', expiresAt: Date.now() + 60_000 })
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('/access/token')) {
        return jsonResponse({ status: 0, data: { tokenKey: 'X-APP-USER', tokenValue: 'STALE', expireTs: 172800 } })
      }
      return jsonResponse({ status: 11, msg: '权限不足', data: null }, 401)
    })
    vi.stubGlobal('fetch', f)

    expect(await fetchLiftOnline()).toBeNull()
    expect(liftAuthFailed()).toBe(true)
    expect(liftGatewayStale()).toBe(true)

    // 数据请求只有首发那 4 次（每台一次去撞），没有「换牌后重试」的第 5 次
    const dataCalls = f.mock.calls.filter((c) => !String(c[0]).includes('/access/token'))
    expect(dataCalls).toHaveLength(LIFT_SNS.length)
  })
})

/**
 * 实时刷新（`stores/lift.ts` 的 `startLive / pollOnce`）。
 *
 * 两件事必须钉住，它们同时决定「页面会不会跳」：
 *   ① 轮询**只换值**，不重进 loading —— 一旦 state 翻成 loading，页面会先铺骨架
 *      再回填，那就是肉眼可见的跳动；
 *   ② 不是每轮都全量打：工况 10 秒一轮，在线 30 秒、今日 60 秒 —— 全量的话
 *      每 10 秒就是 12 个请求。
 */
describe('实时刷新', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('10 秒一轮刷工况；在线每 3 轮、今日每 6 轮才补；stopLive 后不再请求', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 3_600_000 })
    const f = vi.fn(async () => iotOk([]))
    vi.stubGlobal('fetch', f)

    const store = useLiftStore()
    store.startLive('t')
    // 起表本身不发请求：首轮由页面挂载时的 refresh() 负责
    expect(f).toHaveBeenCalledTimes(0)

    await vi.advanceTimersByTimeAsync(10_000)
    // 第 1 轮：只查工况，4 台各一次
    expect(f).toHaveBeenCalledTimes(LIFT_SNS.length)

    await vi.advanceTimersByTimeAsync(20_000)
    // 第 3 轮：工况 4 + 在线 4（前两轮各 4，累计 8）
    expect(f).toHaveBeenCalledTimes(LIFT_SNS.length * 4)
    // 轮询全程不把 state 打回 loading —— 页面靠这一条才不闪骨架
    expect(store.state).toBe('ok')

    store.stopLive('t')
    const at = f.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f).toHaveBeenCalledTimes(at)
  })

  it('凭证已失效时整轮跳过，不每 10 秒空撞一次网关', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'STALE', expiresAt: Date.now() + 3_600_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/access/token')) {
          return jsonResponse({ status: 0, data: { tokenKey: 'X-APP-USER', tokenValue: 'STALE', expireTs: 172800 } })
        }
        return jsonResponse({ status: 11, msg: '权限不足', data: null }, 401)
      }),
    )

    const store = useLiftStore()
    await store.load(true)
    expect(store.authLost).toBe(true)

    const f = vi.mocked(fetch)
    const before = f.mock.calls.length
    store.startLive('t')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.mock.calls.length).toBe(before)
    store.stopLive('t')
  })
})

describe('iot 原始行', () => {
  it('fetchEventRows 保留 resultMap，缺 metricIndex 的行丢掉', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        iotOk([{ timestamp: 1, metricIndex: 'p~SN1~E', resultMap: { a: 1 } }, { timestamp: 2, resultMap: { a: 2 } }]),
      ),
    )

    const rows = await fetchEventRows([{ sn: 'SN1', eventCode: 'E' }], 0, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0].resultMap).toEqual({ a: 1 })
  })

  it('fetchRealtimeRows 保留 "false"（不被当空值丢掉）', async () => {
    applyToken({ tokenKey: 'X-APP-USER', tokenValue: 'V1', expiresAt: Date.now() + 60_000 })
    vi.stubGlobal('fetch', vi.fn(async () => iotOk([{ timestamp: 1, metricIndex: 'p~SN1~E', value: 'false' }])))

    const rows = await fetchRealtimeRows([
      { productCode: LIFT_PRODUCT, sn: 'SN1', field: 'online', code: 'EVENT_ON_OFF' },
    ])
    expect(rows).toEqual([{ timestamp: 1, metricIndex: 'p~SN1~E', value: 'false' }])
  })
})
