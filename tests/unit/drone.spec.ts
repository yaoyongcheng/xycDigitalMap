/**
 * 无人机平台（keehang）客户端 + 无人机 store + 巡检照片 store。
 *
 * 重点覆盖几件容易出错的事：
 *   ① CAS 是**两步**：login 拿 `tgt`/`st`，validate 用 `st`（不是 tgt）换令牌；
 *      业务请求带 `KH-USER-ID` / `KH-TOKEN` 两个头；
 *   ② 遥测里取不到的字段必须是 `null`（页面显示「—」），**不能写成 0**；
 *   ③ 起飞条件是**三态**：明确不满足 / 满足 / 没有数据源。缺数据源不能判成
 *      满足 —— 那是把安全门放松的方向；
 *   ④ 航线信息在响应的**内层** `task` 对象上，外层是设备；
 *   ⑤ 媒体是按**执行记录 id** 取的（不是 taskId），且只收 `image/*`。
 */
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applySession,
  casLogin,
  clearSession,
  fetchDockTelemetry,
  fetchLiveStream,
  fetchMediaJobs,
  fetchRoutes,
  fetchTaskRecords,
  fetchTaskStat,
  fetchTodayRecords,
  fetchProjectIds,
  fetchTelemetry,
  fetchLatestGalleryOf,
  fetchRecordPano,
  fetchStationDay,
  resetPanoIndex,
  pickLatestPano,
  toStations,
  toDock,
  toLiveStream,
  toTaskRecords,
  toTaskStat,
  type DroneTaskRecord,
  toTelemetry,
} from '@/api/drone'
import { useAirHazardStore, AIR_PAGE_SIZE } from '@/stores/airHazard'
import { usePatrolStore } from '@/stores/patrol'
import { useUavStore } from '@/stores/uav'

/** keehang 的响应包：`{code, msg, data}`，code === 200 才算成功 */
function khResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** CAS 登录两步的响应 */
function casResponses(): { login: unknown; validate: unknown } {
  return {
    login: { code: 200, data: { tgt: 'TGT-1', st: 'ST-1', userDetail: { uid: 42, username: 'fanwb' } } },
    validate: { code: 200, data: { uid: '42', token: 'TOKEN-1', timestamp: Date.now() } },
  }
}

/** 按 URL 分发：CAS 两步 + 业务接口 */
function khRoute(business: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const cas = casResponses()
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/cas/auth/login')) return khResponse(cas.login)
    if (u.includes('/cas/auth/validate')) return khResponse(cas.validate)
    const key = Object.keys(business).find((k) => u.includes(k))
    if (!key) return khResponse({ code: 404, msg: 'not found' }, 404)
    return khResponse({ code: 200, data: business[key] })
  })
}

afterEach(async () => {
  // 先排空待决请求再清桩，否则未 await 的请求会在桩被清后真的打到线上
  await flushPromises()
  clearSession()
  vi.unstubAllGlobals()
})

describe('CAS 两步登录', () => {
  it('第一步用 account/password，第二步用 st（不是 tgt）', async () => {
    const f = khRoute({})
    vi.stubGlobal('fetch', f)

    await casLogin()

    const calls = f.mock.calls.map((c) => String(c[0]))
    expect(calls[0]).toContain('/cas/auth/login')
    expect(calls[1]).toContain('/cas/auth/validate')

    const loginBody = JSON.parse(String(f.mock.calls[0][1]?.body))
    expect(loginBody).toHaveProperty('account')
    expect(loginBody).toHaveProperty('password')
    // validate 只传 st：传 tgt 会被服务端判「参数输入错误」
    const validateBody = JSON.parse(String(f.mock.calls[1][1]?.body))
    expect(validateBody.st).toBe('ST-1')
    expect(validateBody.tgt).toBeUndefined()
  })

  it('换到的令牌带 uid 与 token', async () => {
    vi.stubGlobal('fetch', khRoute({}))
    const s = await casLogin()
    expect(s.uid).toBe('42')
    expect(s.token).toBe('TOKEN-1')
    expect(s.expiresAt).toBeGreaterThan(Date.now())
  })

  it('login 没返回票据时抛错，不往下走', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => khResponse({ code: 200, data: { tgt: 'T' } })))
    await expect(casLogin()).rejects.toThrow('未返回票据')
  })

  it('业务码非 200 时抛出服务端文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/login')
          ? khResponse({ code: 200, data: { st: 'ST' } })
          : khResponse({ code: 400, msg: '参数输入错误！' }),
      ),
    )
    await expect(casLogin()).rejects.toThrow('参数输入错误')
  })
})

describe('业务请求头', () => {
  it('带 KH-USER-ID 与 KH-TOKEN', async () => {
    const f = khRoute({ '/task/exec/list/record': [] })
    vi.stubGlobal('fetch', f)

    await fetchTaskRecords()

    const init = f.mock.calls.find((c) => String(c[0]).includes('/task/exec/list/record'))?.[1] as
      | { headers: Record<string, string> }
      | undefined
    expect(init?.headers['KH-USER-ID']).toBe('42')
    expect(init?.headers['KH-TOKEN']).toBe('TOKEN-1')
  })

  it('令牌只登录一次，后续请求复用', async () => {
    const f = khRoute({ '/task/exec/list/record': [], '/dashboard/device/cache/telemetry': {} })
    vi.stubGlobal('fetch', f)

    await fetchTaskRecords()
    await fetchTelemetry()

    const logins = f.mock.calls.filter((c) => String(c[0]).includes('/cas/auth/login'))
    expect(logins).toHaveLength(1)
  })

  it('pid 必须带，否则会拿到平台全部项目', async () => {
    const f = khRoute({ '/task/exec/list/record': [] })
    vi.stubGlobal('fetch', f)

    await fetchTaskRecords()

    const url = String(f.mock.calls.find((c) => String(c[0]).includes('/task/exec/list/record'))?.[0])
    expect(url).toContain('pid=')
  })
})

describe('toTaskRecords 收敛', () => {
  it('映射 id / 任务名 / 时间 / 状态', () => {
    const rows = toTaskRecords([
      { id: 147744, taskId: 4912, taskName: '向阳村-安全巡检', lineId: 12, dockId: 23452, start: '2026-11-11T15:00:00', end: '2026-11-11T15:20:00', status: 2, scheduled: true },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 147744, taskId: 4912, taskName: '向阳村-安全巡检', lineId: 12, status: 2, scheduled: true })
  })

  it('taskId 缺失 → null（进度条按它查历史，不能拿别的东西顶）', () => {
    const rows = toTaskRecords([{ id: 1, taskName: 'x', start: '', end: '' }])
    expect(rows[0].taskId).toBeNull()
  })

  it('缺 id 或任务名的脏行丢掉', () => {
    expect(toTaskRecords([{ taskName: '无 id' }, { id: 1 }, null, 'x'])).toEqual([])
  })

  it('非数组当空结果', () => {
    expect(toTaskRecords({ rows: [] })).toEqual([])
    expect(toTaskRecords(undefined)).toEqual([])
  })
})

describe('toTelemetry 收敛', () => {
  it('电量取电池组首块，缺失为 null（不是 0）', () => {
    const t = toTelemetry({
      status: 1,
      lat: '30.5123',
      lng: '114.4567',
      batteryInfo: { batteries: [{ capacityPercent: 88, temperature: 29.3 }] },
      horizontalSpeed: 0,
      verticalSpeed: null,
      altitude: 117,
      attitudeHead: 90,
      attitudeRoll: -2.5,
    })
    expect(t.battery).toBe(88)
    expect(t.temp).toBe(29.3)
    expect(t.horizontalSpeed).toBe(0)
    expect(t.verticalSpeed).toBeNull()
    // 旧桩写 altitude，保留兜底
    expect(t.relativeAltitude).toBe(117)
    expect(t.heading).toBe(90)
    // 翻滚角原样收，负值不取绝对值
    expect(t.attitudeRoll).toBe(-2.5)
  })

  it('相对高度读 relativeAltitude，海拔读 height（2026-11-13 修正）', () => {
    // 服务端真实响应：在地面时 relativeAltitude=0、height=12.04。
    // 旧解析没有 relativeAltitude 这个键，退到 height —— 地面停着也显示「12m」。
    const t = toTelemetry({ relativeAltitude: 0, height: 12.04, windSpeed: 2.5, homeDistance: 0.054 })
    expect(t.relativeAltitude).toBe(0)
    expect(t.height).toBe(12.04)
    expect(t.windSpeed).toBe(2.5)
    expect(t.homeDistance).toBe(0.054)
  })

  it('累计飞行里程读 totalFlightDistance，与 homeDistance 分属两个字段', () => {
    // 2026-11-13 实测同一时刻：累计里程 10809054.8m（这台机飞了 3070 架次），
    // 而 homeDistance 0.0136m（飞机正停在库里）。V2 面板「飞行距离」= 前者。
    const t = toTelemetry({ totalFlightDistance: 10809054.798538862, homeDistance: 0.0136223491281271 })
    expect(t.totalFlightDistance).toBeCloseTo(10809054.8, 1)
    expect(t.homeDistance).toBeCloseTo(0.0136, 4)
    // 缺字段是 null（页面写「—」），不是 0
    expect(toTelemetry({}).totalFlightDistance).toBeNull()
  })

  it('剩余续航 / 累计架次 / 风速都在响应里，不能当「没有数据源」', () => {
    const t = toTelemetry({
      batteryInfo: { remainFlightTime: 1520 },
      totalFlightSorties: 3067,
      windSpeed: 0,
    })
    expect(t.remainFlightTime).toBe(1520)
    expect(t.totalSorties).toBe(3067)
    // 风速 0 是有效读数（此刻没风），不是「没数据」
    expect(t.windSpeed).toBe(0)
  })

  it('整体缺失时所有读数为 null', () => {
    const t = toTelemetry(undefined)
    expect(t.battery).toBeNull()
    expect(t.temp).toBeNull()
    expect(t.lat).toBe('')
    // 姿态角同理：没有就是 null，页面写「—」，不能是 0°
    expect(t.attitudeRoll).toBeNull()
    expect(t.heading).toBeNull()
  })

  it('容量百分比兼容顶层 batteryInfo.capacityPercent', () => {
    expect(toTelemetry({ batteryInfo: { capacityPercent: 55 } }).battery).toBe(55)
  })
})

describe('toDock 机库遥测收敛', () => {
  it('风 / 雨 / 网络 / 舱温 全部取到（这些是起飞条件的另一半）', () => {
    const d = toDock({
      status: 1,
      droneOnlineStatus: 1,
      cabinTemperature: 18.1,
      environmentTemperature: 17.4,
      humidity: 99,
      rainfall: 1,
      windSpeed: 0,
      networkQuality: 1,
      networkRate: 441,
      droneChargeState: 0,
      storageTotal: 76,
      storageUsed: 3,
      alarmState: false,
    })
    expect(d.droneOnline).toBe(true)
    expect(d.cabinTemp).toBe(18.1)
    expect(d.rainfall).toBe(1)
    expect(d.networkRate).toBe(441)
    expect(d.chargeState).toBe(0)
    expect(d.alarmState).toBe(false)
  })

  it('缺失字段为 null（不是 0）', () => {
    const d = toDock(undefined)
    expect(d.windSpeed).toBeNull()
    expect(d.networkRate).toBeNull()
    expect(d.droneOnline).toBeNull()
  })
})

describe('toTaskStat 今日统计', () => {
  it('三格 + 执行中 / 计划 / 暂停', () => {
    const s = toTaskStat({
      taskCount: 15,
      finishedCount: 11,
      failedCount: 0,
      runningCount: 0,
      planCount: 4,
      suspendedCount: 0,
    })
    expect(s.taskCount).toBe(15)
    expect(s.finishedCount).toBe(11)
    expect(s.planCount).toBe(4)
  })
})


describe('今日统计 / 机库遥测 接口', () => {
  it('统计走 /dashboard/task/list/record，机库遥测的类型段是 2', async () => {
    const f = khRoute({
      '/dashboard/task/list/record': { taskCount: 15, finishedCount: 11, failedCount: 0 },
      '/telemetry/23452/2': { cabinTemperature: 18.1, networkRate: 441 },
    })
    vi.stubGlobal('fetch', f)

    const stat = await fetchTaskStat()
    const dock = await fetchDockTelemetry()

    expect(stat.taskCount).toBe(15)
    expect(dock.networkRate).toBe(441)

    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/dashboard/task/list/record'))).toBe(true)
    // 用 1 查机库只会拿到一屏 null，必须 2
    expect(urls.some((u) => u.includes('/telemetry/23452/2'))).toBe(true)
  })

  it('响应里没有 taskCount → 抛错（不能当成「今天 0 条」）', async () => {
    vi.stubGlobal('fetch', khRoute({ '/dashboard/task/list/record': { hello: 1 } }))
    await expect(fetchTaskStat()).rejects.toThrow('无人机任务统计返回异常')
  })

  /**
   * 口径守卫（2026-11-16 用户要求「V2 咋获取的我就咋获取」）。
   *
   * 不传 `pid` → 该账号下所有项目的今日任务（实测 23 = 向阳村 15 + 光谷元著 8），
   * 这正是 V2 那一格显示的数值。别「顺手加回 pid」：
   * 加了就变回 15，与 V2 对不上，用户会认为是 bug。
   */
  it('统计默认不带 pid（V2 口径），显式传了才过滤项目', async () => {
    const f = khRoute({
      '/dashboard/task/list/record': { taskCount: 23, finishedCount: 5, failedCount: 0 },
    })
    vi.stubGlobal('fetch', f)

    await fetchTaskStat()
    await fetchTaskStat({ pid: 193640872670213 })

    const statUrls = f.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/dashboard/task/list/record'))
    expect(statUrls).toHaveLength(2)
    expect(statUrls[0]).not.toContain('pid=')
    expect(statUrls[1]).toContain('pid=193640872670213')
  })
})

describe('直播流（与 V2 同一路 HTTP-FLV）', () => {
  const payload = [
    {
      deviceId: 23498,
      streams: [
        {
          id: 934,
          name: '中建三局-向阳村项目无人机2',
          online: true,
          playStreams: [
            { type: 'flv', protocol: 'http', url: 'http://live.keehang.com:8080/djiDock/uav.live.flv' },
            { type: 'flv', protocol: 'https', url: 'https://live.keehang.com:8443/djiDock/uav.live.flv' },
            { type: 'flv', protocol: 'wss', url: 'wss://live.keehang.com:8443/djiDock/uav.live.flv' },
            { type: 'rtsp', protocol: 'rtsp', url: 'rtsp://live.keehang.com:8554/djiDock/uav' },
          ],
        },
      ],
    },
  ]

  it('取 flv + https：http 版在 HTTPS 站点会被混合内容拦掉', () => {
    const s = toLiveStream(payload)
    expect(s?.flv).toBe('https://live.keehang.com:8443/djiDock/uav.live.flv')
    expect(s?.wsFlv).toBe('wss://live.keehang.com:8443/djiDock/uav.live.flv')
    expect(s?.rtsp).toBe('rtsp://live.keehang.com:8554/djiDock/uav')
    expect(s?.online).toBe(true)
    expect(s?.id).toBe(934)
  })

  it('只有 rtsp 的设备不算有可播流 → null（浏览器放不了 rtsp）', () => {
    const s = toLiveStream([
      {
        deviceId: 1,
        streams: [
          {
            id: 1,
            name: '某摄像头',
            online: true,
            playStreams: [{ type: 'rtsp', protocol: 'rtsp', url: 'rtsp://x/y' }],
          },
        ],
      },
    ])
    expect(s).toBeNull()
  })

  it('按 deviceId 过滤取流（全量列表 1197 组 / 1.5MB，拉全量是浪费）', async () => {
    const f = khRoute({ '/live/stream/list': payload })
    vi.stubGlobal('fetch', f)

    const s = await fetchLiveStream(23498)
    expect(s?.name).toBe('中建三局-向阳村项目无人机2')

    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/live/stream/list?deviceId=23498'))).toBe(true)
  })
})

describe('fetchRoutes 航线', () => {
  it('航线信息取内层 task 对象，外层是设备', async () => {
    vi.stubGlobal(
      'fetch',
      khRoute({
        '/task/list': {
          list: [{ task: { id: 9001, name: '向阳村-全景', lineId: 12, rth: 117, running: false } }],
        },
      }),
    )

    const routes = await fetchRoutes()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ id: 9001, taskId: 9001, name: '向阳村-全景', height: 117, running: false })
  })

  it('无 name / 无 id 的行丢掉', async () => {
    vi.stubGlobal('fetch', khRoute({ '/task/list': { list: [{ task: { id: 1 } }, { task: { name: 'x' } }] } }))
    expect(await fetchRoutes()).toEqual([])
  })
})

describe('fetchMediaJobs 媒体', () => {
  it('只收有 url 与 name 的项', async () => {
    vi.stubGlobal(
      'fetch',
      khRoute({
        '/media/task/job': [
          { name: 'DJI_1.jpeg', url: 'https://oss/1.jpeg', mediaType: 'image/jpeg', size: 5378048, lastModified: '2026-07-15 09:38:39' },
          { name: 'no-url.jpeg' },
        ],
      }),
    )

    const media = await fetchMediaJobs(147744)
    expect(media).toHaveLength(1)
    expect(media[0].name).toBe('DJI_1.jpeg')
    expect(media[0].size).toBe(5378048)
  })

  it('返回非数组时给空数组（该任务暂无媒体，不是错误）', async () => {
    vi.stubGlobal('fetch', khRoute({ '/media/task/job': { oops: true } }))
    expect(await fetchMediaJobs(147744)).toEqual([])
  })
})

describe('uav store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('今日任务按当天过滤、按开始时间倒序；三格取自统计接口', async () => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    vi.stubGlobal(
      'fetch',
      khRoute({
        '/dashboard/task/list/record': {
          taskCount: 3,
          finishedCount: 1,
          failedCount: 0,
          runningCount: 1,
          planCount: 1,
          suspendedCount: 0,
        },
        '/task/exec/list/record': [
          { id: 1, taskName: '早班巡检', start: `${today}T09:00:00`, status: 2 },
          { id: 2, taskName: '午班巡检', start: `${today}T15:00:00`, status: 1 },
          { id: 3, taskName: '昨天任务', start: '2026-01-01T10:00:00', status: 1 },
        ],
      }),
    )

    const s = useUavStore()
    await s.load()

    expect(s.todayTasks.map((t) => t.name)).toEqual(['午班巡检', '早班巡检'])
    expect(s.taskTotal).toBe(3)
    expect(s.taskDone).toBe(1)
    expect(s.taskFailed).toBe(0)
    expect(s.running?.name).toBe('午班巡检')
  })

  it('查今日明细必须带 start/end（不带拿到的是 7 月那几条最旧记录）', async () => {
    const f = khRoute({ '/task/exec/list/record': [] })
    vi.stubGlobal('fetch', f)

    const s = useUavStore()
    await s.load()

    const url = f.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/task/exec/list/record'))
    const today = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const key = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
    expect(url).toContain(`start=${key}`)
    // end 不含当天：查今天要传明天
    const tomorrow = new Date(today.getTime() + 86_400_000)
    const key2 = `${tomorrow.getFullYear()}-${p(tomorrow.getMonth() + 1)}-${p(tomorrow.getDate())}`
    expect(url).toContain(`end=${key2}`)
  })

  it('遥测失败不影响任务列表状态（各自成败互不影响）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/task/exec/list/record')) {
          return khResponse({ code: 200, data: [{ id: 1, taskName: '巡检', start: '2026-11-11T09:00:00', status: 2 }] })
        }
        return khResponse({ code: 500, msg: '遥测挂了' }, 500)
      }),
    )

    const s = useUavStore()
    await s.load()

    expect(s.state).toBe('ok')
    expect(s.telemetry).toBeNull()
  })

  it('任务接口失败：进 error 态并给原因，不回落演示任务', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        return khResponse({ code: 500, msg: '服务端故障' }, 500)
      }),
    )

    const s = useUavStore()
    await s.load()

    expect(s.state).toBe('error')
    expect(s.error).toContain('服务端故障')
    expect(s.records).toEqual([])
    // 统计接口也挂了 → 「—」，不拿 0 冒充「今天没任务」
    expect(s.taskTotal).toBeNull()
  })

  it('起飞条件三态：没有遥测时不给放行，也不写成「已满足」', () => {
    const s = useUavStore()
    s.apply([])

    const wind = s.checks.find((c) => c.name === '风速')
    expect(wind?.unknown).toBe(true)
    expect(wind?.ok).toBe(false)
    // 有未知项 → 不可下发（保守侧）
    expect(s.canDispatch).toBe(false)
    expect(s.unknowns.map((c) => c.name)).toContain('风速')
    expect(s.dispatchNote).toContain('口径未确认')
  })

  it('机库遥测到了之后，风速与网络变成真实判定', () => {
    const s = useUavStore()
    s.apply(
      [],
      {
        status: 1,
        modeCode: 1,
        lat: '',
        lng: '',
        battery: 88,
        temp: 26.4,
        horizontalSpeed: 0,
        verticalSpeed: 0,
        relativeAltitude: 0,
        height: 12,
        homeDistance: 0.05,
        totalFlightDistance: 10809054.8,
        windSpeed: 2.4,
        remainFlightTime: 0,
        totalSorties: 3067,
        heading: 0,
        attitudeRoll: 0,
      },
      { taskCount: 15, finishedCount: 11, failedCount: 0, runningCount: 0, planCount: 4, suspendedCount: 0 },
    )
    s.applyDock({
      status: 1,
      hatchStatus: 2,
      putterState: 2,
      droneOnline: true,
      droneLocation: 1,
      chargeState: 0,
      cabinTemp: 18.1,
      envTemp: 17.4,
      humidity: 99,
      rainfall: 1,
      windSpeed: 2.4,
      networkQuality: 1,
      networkRate: 720,
      storageTotal: 76,
      storageUsed: 3,
      alarmState: false,
      lat: '',
      lng: '',
      height: 12,
    })

    // 风速 / 网络 不再是「未接入」
    expect(s.checks.find((c) => c.name === '风速')?.unknown).toBe(false)
    expect(s.checks.find((c) => c.name === '风速')?.ok).toBe(true)
    expect(s.checks.find((c) => c.name === '网络')?.ok).toBe(true)
    // 雨量仍按未知处理（口径未确认），所以整体仍不放行 —— 但原因里带着原值
    expect(s.canDispatch).toBe(false)
    expect(s.unknowns.map((c) => c.name)).toEqual(['雨量'])
    expect(s.unknowns[0].risk).toContain('rainfall=1')
  })

  it('风速超 8m/s 是「明确不满足」', () => {
    const s = useUavStore()
    s.apply([], {
      status: 1,
      modeCode: 1,
      lat: '',
      lng: '',
      battery: 88,
      temp: 26.4,
      horizontalSpeed: 0,
      verticalSpeed: 0,
      relativeAltitude: 0,
      height: 12,
      homeDistance: 0,
      totalFlightDistance: 0,
      // 机载风速故意给个安全值：风速只认机库那一份（V2 面板同口径），
      // 机载这个数不该影响判定 —— 拿它顶上去就说明来源又写错了
      windSpeed: 0.5,
      remainFlightTime: 0,
      totalSorties: 0,
      heading: 0,
      attitudeRoll: 0,
    })
    s.applyDock({
      status: 1,
      hatchStatus: 0,
      putterState: 0,
      droneOnline: true,
      droneLocation: 1,
      chargeState: 0,
      cabinTemp: 20,
      envTemp: 20,
      humidity: 60,
      rainfall: 0,
      windSpeed: 9.6,
      networkQuality: 1,
      networkRate: 720,
      storageTotal: 76,
      storageUsed: 3,
      alarmState: false,
      lat: '',
      lng: '',
      height: 12,
    })

    expect(s.risks.map((c) => c.name)).toContain('风速')
  })

  it('电量低于 30% 是「明确不满足」，进风险列表', () => {
    const s = useUavStore()
    s.apply([], {
      status: 1,
      modeCode: 1,
      lat: '',
      lng: '',
      battery: 12,
      temp: 20,
      horizontalSpeed: 0,
      verticalSpeed: 0,
      relativeAltitude: 10,
      height: 10,
      homeDistance: 0,
      totalFlightDistance: 0,
      windSpeed: 2,
      remainFlightTime: 0,
      totalSorties: 0,
      heading: 0,
      attitudeRoll: 0,
    })

    const battery = s.checks.find((c) => c.name === '电量')
    expect(battery?.unknown).toBe(false)
    expect(battery?.ok).toBe(false)
    expect(s.risks.map((c) => c.name)).toContain('电量')
    expect(s.dispatchNote).toContain('未达标')
  })

  it('loadStat 只拉统计（首页那一格），不触发遥测 / 明细', async () => {
    const f = khRoute({ '/dashboard/task/list/record': { taskCount: 7, finishedCount: 6, failedCount: 1 } })
    vi.stubGlobal('fetch', f)

    const s = useUavStore()
    await s.loadStat()

    expect(s.taskTotal).toBe(7)
    expect(s.taskFailed).toBe(1)
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/task/exec/list/record'))).toBe(false)
    expect(urls.some((u) => u.includes('/telemetry'))).toBe(false)
  })

  it('遥测字段缺失时对应读数是 null（页面显示「—」）', () => {
    const s = useUavStore()
    s.apply([])
    expect(s.live.battery).toBeNull()
    expect(s.live.temp).toBeNull()
    expect(s.live.altitude).toBeNull()
  })

  it('reset 清空缓存并清掉会话', async () => {
    vi.stubGlobal('fetch', khRoute({ '/task/exec/list/record': [] }))
    const s = useUavStore()
    await s.load()
    expect(s.state).toBe('ok')

    s.reset()
    expect(s.state).toBe('idle')
    expect(s.records).toEqual([])
    expect(s.routes).toEqual([])
  })
})

describe('patrol store 巡检照片', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('按执行记录取媒体，只收图片类', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/task/exec/list/record')) {
          return khResponse({ code: 200, data: [{ id: 147744, taskName: '向阳村-安全巡检', start: '2026-07-15T09:38:39' }] })
        }
        return khResponse({
          code: 200,
          data: [
            { name: 'DJI_1.jpeg', url: 'https://oss/1.jpeg', mediaType: 'image/jpeg', size: 5378048, lastModified: '2026-07-15 09:38:39' },
            { name: 'clip.mp4', url: 'https://oss/1.mp4', mediaType: 'video/mp4', size: 100, lastModified: '2026-07-15 09:39:00' },
          ],
        })
      }),
    )

    const s = usePatrolStore()
    await s.load()

    expect(s.photos).toHaveLength(1)
    expect(s.photos[0].name).toBe('DJI_1.jpeg')
    expect(s.photos[0].taskName).toBe('向阳村-安全巡检')
    expect(s.flightCount).toBe(1)
  })

  it('某个任务的媒体取不到时跳过，其余照常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/task/exec/list/record')) {
          return khResponse({ code: 200, data: [{ id: 1, taskName: 'A', start: '2026-07-15T09:00:00' }] })
        }
        return khResponse({ code: 500, msg: '媒体服务挂了' }, 500)
      }),
    )

    const s = usePatrolStore()
    await s.load()

    expect(s.state).toBe('ok')
    expect(s.photos).toEqual([])
  })

  it('任务接口失败：进 error 态并给原因，不回落演示图', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        return khResponse({ code: 500, msg: '任务服务挂了' }, 500)
      }),
    )

    const s = usePatrolStore()
    await s.load()

    expect(s.state).toBe('error')
    expect(s.error).toContain('任务服务挂了')
    expect(s.photos).toEqual([])
  })

  it('体积摘要按量级切换单位', () => {
    const s = usePatrolStore()
    expect(s.sizeText(512)).toBe('512B')
    expect(s.sizeText(2048)).toBe('2KB')
    expect(s.sizeText(5_378_048)).toBe('5.1MB')
    expect(s.sizeText(0)).toBe('')
  })
})

describe('账号口径的今日任务（2026-11-16 起：23 条都放开）', () => {
  /** 本项目（向阳村） */
  const OWN = 193640872670213
  /** 同账号下的另一个项目（光谷元著） */
  const OTHER = 231070463906821
  /**
   * 今天 / 明天（`end` 不含当天）。
   *
   * **必须是运行时算的，不能写死日期**：store 的 `todayRecords` 拿真实
   * `new Date()` 取当天 key 再过滤，夹具若钉在某一天，过了那天记录就成了
   * 「昨天」，`todayTasks` 恒为空 —— 用例会在跨天后无缘无故挂掉
   * （2026-11-17 就是这么挂的，一开始误以为是业务代码写死了日期）。
   */
  function dayKey(offset: number): string {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const START = dayKey(0)
  const END = dayKey(1)

  /** 一条执行记录（服务端 start 是 ISO 串） */
  function rec(over: Record<string, unknown>): Record<string, unknown> {
    const start = `${START}T08:00:00`
    return {
      id: 1,
      uuid: 'u-1',
      taskName: '向阳村-安全巡检',
      taskId: 4912,
      lineId: 12,
      dockId: 23452,
      start,
      end: start,
      status: 2,
      scheduled: true,
      pid: OWN,
      ...over,
    }
  }

  /** 按 pid 分发执行记录；`failPid` 用来模拟某个项目挂掉 */
  function pidRoute(opts: { pids: number[]; rows: Record<string, unknown>[]; failPid?: number }) {
    const cas = casResponses()
    return vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/cas/auth/login')) return khResponse(cas.login)
      if (u.includes('/cas/auth/validate')) return khResponse(cas.validate)
      if (u.includes('/dashboard/device/list')) {
        return khResponse({ code: 200, data: opts.pids.map((pid) => ({ deviceInfo: { pid } })) })
      }
      if (u.includes('/task/exec/list/record')) {
        const pid = Number(new URL(u).searchParams.get('pid'))
        if (pid === opts.failPid) return khResponse({ code: 500, msg: '该项目的任务服务挂了' }, 500)
        return khResponse({ code: 200, data: opts.rows.filter((r) => r.pid === pid) })
      }
      return khResponse({ code: 404, msg: 'not found' }, 404)
    })
  }

  it('项目清单来自设备列表，本项目永远排第一', async () => {
    // 设备列表按 id 升序，光谷元著那条在前 —— 输出仍应让本项目打头
    vi.stubGlobal('fetch', pidRoute({ pids: [OTHER, OWN, OWN], rows: [] }))
    expect(await fetchProjectIds()).toEqual([OWN, OTHER])
  })

  it('设备列表取不到 → 只回本项目，不编 pid', async () => {
    const cas = casResponses()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(cas.login)
        if (u.includes('/cas/auth/validate')) return khResponse(cas.validate)
        return khResponse({ code: 500, msg: '设备服务挂了' }, 500)
      }),
    )
    expect(await fetchProjectIds()).toEqual([OWN])
  })

  it('逐个 pid 取完合并：向阳村 1 + 光谷元著 1 = 2 条', async () => {
    vi.stubGlobal(
      'fetch',
      pidRoute({
        pids: [OWN, OTHER],
        rows: [
          rec({ id: 1, uuid: 'u-1' }),
          rec({ id: 2, uuid: 'o-1', taskName: '光谷元著-安全巡检', pid: OTHER }),
        ],
      }),
    )
    const rows = await fetchTodayRecords({ start: START, end: END })
    expect(rows.map((r) => r.uuid).sort()).toEqual(['o-1', 'u-1'])
    // 明细也带上 pid，页面才能区分是不是本项目
    expect(rows.find((r) => r.uuid === 'o-1')?.pid).toBe(OTHER)
  })

  it('同一 uuid 只留一条（跨项目/跨页重复取到也不重复计数）', async () => {
    vi.stubGlobal(
      'fetch',
      pidRoute({
        pids: [OWN, OTHER],
        rows: [rec({ uuid: 'dup' }), rec({ uuid: 'dup', pid: OTHER })],
      }),
    )
    const rows = await fetchTodayRecords({ start: START, end: END })
    expect(rows).toHaveLength(1)
  })

  it('某个项目挂了仍返回其它项目（宁可少列，整页不塌）', async () => {
    vi.stubGlobal(
      'fetch',
      pidRoute({
        pids: [OWN, OTHER],
        failPid: OTHER,
        rows: [rec({ id: 1, uuid: 'u-1', pid: OWN })],
      }),
    )
    const rows = await fetchTodayRecords({ start: START, end: END })
    expect(rows.map((r) => r.uuid)).toEqual(['u-1'])
  })

  it('全部项目都挂 → 抛服务端原文（页面据此写加载失败）', async () => {
    vi.stubGlobal('fetch', pidRoute({ pids: [OWN], failPid: OWN, rows: [] }))
    await expect(fetchTodayRecords({ start: START, end: END })).rejects.toThrow('该项目的任务服务挂了')
  })

  it('store：今日列表放开到全账号，当前巡检仍只认本项目', () => {
    const s = useUavStore()
    s.apply([
      rec({ id: 1, uuid: 'u-1', taskName: '向阳村-安全巡检', status: 1 }) as unknown as DroneTaskRecord,
      rec({ id: 2, uuid: 'o-1', taskName: '光谷元著-安全巡检', pid: OTHER, status: 1 }) as unknown as DroneTaskRecord,
    ])
    expect(s.todayTasks).toHaveLength(2)
    expect(s.todayHasOthers).toBe(true)
    // 两条都在执行中，只认本项目那条 —— 遥测是向阳村机库的
    expect(s.running?.name).toBe('向阳村-安全巡检')
  })

  it('store：只有别的项目在执行时不给「当前巡检」（不张冠李戴）', () => {
    const s = useUavStore()
    s.apply([rec({ uuid: 'o-1', taskName: '光谷元著-安全巡检', pid: OTHER, status: 1 }) as never])
    expect(s.todayHasOthers).toBe(true)
    expect(s.running).toBeNull()
  })
})

describe('会话注入', () => {
  it('applySession 可以直接灌一个会话，跳过 CAS', async () => {
    applySession({ uid: '9', token: 'T', expiresAt: Date.now() + 60_000 })
    const f = khRoute({ '/task/exec/list/record': [] })
    vi.stubGlobal('fetch', f)

    await fetchTaskRecords()

    const logins = f.mock.calls.filter((c) => String(c[0]).includes('/cas/auth/login'))
    expect(logins).toHaveLength(0)
  })
})

/**
 * 项目全景：从重建任务列表里挑最新一个「等距圆柱成果」。
 *
 * 结构是对着现场实测抄的（2026-11-15 record 181616）：列表按 createTime 倒序、
 * 混着正射/三维、每条内嵌 `resultRecordDTOList`、一次飞行 3 个 PANO 成果。
 */
describe('pickLatestPano（重建成果里挑全景）', () => {
  const pano = (id: number, secret: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    secret,
    name,
    mediaType: 2,
    size: 13_688_984,
    recreateType: 'PANO',
    url: `https://oss.keehang.com:19090/models/${id}/pano.json`,
    thumbnail: `https://oss.keehang.com:19090/thumbnail/model/${id}/thumbnail.jpg`,
    download: `https://moss.keehang.com:9443/models/${id}/origin.jpg`,
    ...over,
  })
  const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    recordId: 181616,
    taskName: '向阳村-全景_202611151130181616',
    taskType: 2,
    status: 2,
    createTime: '2026-11-15 12:10:54',
    endTime: '2026-11-15 12:18:29',
    updateTime: '2026-11-15 12:18:29',
    resultRecordDTOList: [
      pano(103181, 'LsM8Eppu', 'pano_1.jpg'),
      pano(103180, 'b3uT22dX', 'pano_0.jpg'),
      pano(103182, 'QjPlKQbX', 'pano_2.jpg'),
    ],
    ...over,
  })

  it('按名字排序取第一个（一次飞 3 个只留一张）', () => {
    const p = pickLatestPano({ list: [task()] })
    expect(p?.id).toBe(103180)
    expect(p?.name).toBe('pano_0.jpg')
    expect(p?.secret).toBe('b3uT22dX')
    expect(p?.preview).toContain('/thumbnail/model/103180/')
    expect(p?.full).toContain('/models/103180/origin.jpg')
  })

  it('跳过正射 / 三维和未完成的任务，取最新一条已完成全景', () => {
    const p = pickLatestPano({
      list: [
        { ...task(), recordId: 1, taskType: 3, createTime: '2026-11-16 09:00:00' },
        { ...task(), recordId: 2, status: 1, createTime: '2026-11-16 10:00:00' },
        { ...task(), recordId: 3, createTime: '2026-11-14 12:00:00' },
        task(),
      ],
    })
    expect(p?.recordId).toBe(181616)
  })

  it('只有预览图没有原图时，preview / full 都落到预览上（不返回空 URL）', () => {
    const p = pickLatestPano({
      list: [task({ resultRecordDTOList: [pano(103180, 'S', 'pano_0.jpg', { download: '' })] })],
    })
    expect(p?.preview).toContain('/thumbnail/')
    expect(p?.full).toBe(p?.preview)
  })

  it('时间取**完成时刻**（endTime），不是重建开始时刻（createTime）', () => {
    // 现场实测 2026-11-17：createTime 11:58:40 / endTime 12:07:30。
    // V2 的重建成果列表显示的是 12:07:30，同一张图在两处必须一致。
    const p = pickLatestPano({ list: [task()] })
    expect(p?.time).toBe('2026-11-15 12:18:29')
  })

  it('老记录没有 endTime 时退 updateTime，再退 createTime（不显示空）', () => {
    expect(pickLatestPano({ list: [task({ endTime: undefined })] })?.time).toBe('2026-11-15 12:18:29')
    expect(pickLatestPano({ list: [task({ endTime: undefined, updateTime: undefined })] })?.time).toBe('2026-11-15 12:10:54')
  })

  it('成果为空 / 只有切片没有等距圆柱图 → null（宁可不显示，也不给个空壳）', () => {
    expect(pickLatestPano({ list: [task({ resultRecordDTOList: [] })] })).toBeNull()
    expect(pickLatestPano({ list: [task({ resultRecordDTOList: [pano(1, 'S', 'x', { thumbnail: '', download: '' })] })] })).toBeNull()
    expect(pickLatestPano({ list: [] })).toBeNull()
    expect(pickLatestPano(null)).toBeNull()
  })
})

describe('pickLatestPano · 项目守卫', () => {
  const t = (over: Record<string, unknown>): Record<string, unknown> => ({
    recordId: 1,
    projectId: 193640872670213,
    projectName: '中建三局-向阳村项目',
    taskName: '向阳村-全景',
    taskType: 2,
    status: 2,
    createTime: '2026-11-15 12:10:54',
    resultRecordDTOList: [
      {
        id: 1,
        secret: 'S',
        name: 'a_0.jpg',
        mediaType: 2,
        size: 1,
        recreateType: 'PANO',
        url: '',
        thumbnail: 'https://oss/x/thumbnail/1.jpg',
        download: 'https://moss/x/1/origin.jpg',
      },
    ],
    ...over,
  })

  it('带上 projectId 时，别的项目更新的记录直接被跳过', () => {
    const p = pickLatestPano(
      { list: [t({ recordId: 181656, projectId: 231070463906821, createTime: '2026-11-15 13:29:17' }), t({ recordId: 181616 })] },
      193640872670213,
    )
    expect(p?.recordId).toBe(181616)
  })

  it('不带 projectId 时取最新（守卫可选，便于排查「到底是哪条」）', () => {
    const p = pickLatestPano({
      list: [t({ recordId: 181656, projectId: 231070463906821, createTime: '2026-11-15 13:29:17' }), t({ recordId: 181616 })],
    })
    expect(p?.recordId).toBe(181656)
  })

  it('本项目一条都没有时返回 null（不会退而求其次拿别的项目）', () => {
    const p = pickLatestPano({ list: [t({ recordId: 181656, projectId: 231070463906821 })] }, 193640872670213)
    expect(p).toBeNull()
  })
})

/* ============================================================ *
 * 航拍照片：站点 → 最新一次采集（2026-11-19）
 * ============================================================ */

describe('站点清单（V2 任务记录里的站点名去重）', () => {
  it('同名记录合成一个站点，按最近一次执行倒序，架次按条数算', () => {
    const rows = toTaskRecords([
      { id: 1, taskName: '向阳村-塔吊定点', taskId: 4912, start: '2026-11-18T09:00:00' },
      { id: 2, taskName: '向阳村-塔吊定点', taskId: 4912, start: '2026-11-19T09:00:00' },
      { id: 3, taskName: '向阳村-全局定点拍照', taskId: 4916, start: '2026-11-18T08:20:00' },
      { id: 4, taskName: ' 向阳村-土方1 ', taskId: 4913, start: '2026-11-17T17:00:00' },
    ])

    const st = toStations(rows)
    expect(st.map((s) => s.name)).toEqual(['向阳村-塔吊定点', '向阳村-全局定点拍照', '向阳村-土方1'])
    expect(st[0].runs).toBe(2)
    expect(st[0].lastStart).toBe('2026-11-19T09:00:00')
    // 名字两边空白不影响归组（下拉里不会出现「向阳村-土方1 」和「向阳村-土方1」两项）
    expect(st[2].name).toBe('向阳村-土方1')
  })

  /*
   * 下拉的语义是「拍照站点」（2026-11-19 现场确认）：非拍照任务与重复建图
   * 航线一律不出现。半角括号、多余空白都要能认出来。
   */
  it('下拉只留拍照站点：安全巡检 / 三维（新·加密）/ 环绕视频 / 测试航线全部剔除', () => {
    const names = [
      '向阳村-全局定点拍照',
      '向阳村-安全巡检',
      '向阳村-三维（新）',
      '向阳村-三维（加密）',
      '向阳村-三维(加密)',
      '向阳村-环绕视频',
      ' 测试 ',
      '测试全景',
    ]
    const rows = toTaskRecords(
      names.map((taskName, i) => ({
        id: i + 1,
        taskName,
        taskId: 4900 + i,
        start: '2026-11-18T09:00:00',
      })),
    )
    expect(toStations(rows).map((s) => s.name)).toEqual(['向阳村-全局定点拍照'])
  })
})

describe('航拍照片：最新一次采集 + 带全景', () => {
  /*
   * 每个用例一个新 pinia：此前这个 describe 没重置，store 状态跨用例复用 ——
   * `loadStations` 因 5 分钟 TTL 直接返回，用例看到的是上一个用例的站点与照片。
   */
  beforeEach(() => setActivePinia(createPinia()))

  const OWN = 193640872670213

  /** 一条执行记录 */
  function rec(id: number, start: string, name = '向阳村-全局定点拍照') {
    return { id, uuid: `u${id}`, taskName: name, taskId: 4916, start, end: start, status: 2, pid: OWN }
  }

  /** 一班的媒体：N 张图片 + 1 个飞行日志 */
  function media(n: number): unknown[] {
    return [
      ...Array.from({ length: n }, (_, i) => ({
        name: `DJI_000${i + 1}_V.jpeg`,
        url: `https://oss/${i}.jpeg`,
        thumbnail: `https://oss/thumb/${i}.jpeg`,
        mediaType: 'image/jpeg',
        size: 1000 + i,
        lastModified: '2026-07-15 09:38:39',
      })),
      { name: 'DJI_log.DAT', url: 'https://oss/log.dat', mediaType: 'application/octet-stream', size: 10 },
    ]
  }

  /** 成果列表的一页 */
  function recreate(rows: unknown[]): unknown {
    return { list: rows }
  }

  it('跳过「已完成但 0 媒体」的班，取最近一班有照片的全部图片（不含 .DAT）', async () => {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        asked.push(u)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/media/task/job/2')) return khResponse({ code: 200, data: [] })
        if (u.includes('/media/task/job/1')) return khResponse({ code: 200, data: media(9) })
        return khResponse({ code: 200, data: {} })
      }),
    )

    const g = await fetchLatestGalleryOf('向阳村-全局定点拍照', toTaskRecords([
      rec(1, '2026-07-15T08:20:00'),
      // 比上面那条新，但媒体是空的（实测 2026-11-18 08:20 那班就是这样）
      rec(2, '2026-07-15T10:20:00'),
    ]))

    expect(g?.jobId).toBe(1)
    expect(g?.media).toHaveLength(9)
    expect(g?.media[0].name).toBe('DJI_0001_V.jpeg')
    // 先探最新的那条，空了才往下找
    expect(asked.some((u) => u.includes('/media/task/job/2'))).toBe(true)
  })

  it('未来排班与未完成的班不进候选（它们没有媒体）', async () => {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        asked.push(u)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/media/task/job/')) return khResponse({ code: 200, data: media(1) })
        return khResponse({ code: 200, data: {} })
      }),
    )

    const rows = toTaskRecords([
      rec(9, '2099-01-01T08:00:00'), // 未来排班
      rec(8, '2026-07-15T08:00:00'),
    ])
    const g = await fetchLatestGalleryOf('向阳村-全局定点拍照', rows)
    expect(g?.jobId).toBe(8)
    expect(asked.some((u) => u.includes('/media/task/job/9'))).toBe(false)
  })

  it('按 recordId 找该班的全景，只用本项目的 PANO 成果', async () => {
    resetPanoIndex()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        return khResponse({
          code: 200,
          data: recreate([
            {
              taskType: 1,
              status: 2,
              projectId: OWN,
              recordId: 11,
              createTime: '2026-07-15 11:00:00',
              resultRecordDTOList: [{ id: 5, recreateType: 'OSGB', name: 'x.zip', size: 1 }],
            },
            {
              taskType: 2,
              status: 2,
              projectId: OWN,
              recordId: 10,
              taskName: '向阳村-全景_20260715090010',
              createTime: '2026-07-15 10:20:00',
              endTime: '2026-07-15 10:30:00',
              resultRecordDTOList: [
                {
                  id: 7,
                  secret: 'S',
                  recreateType: 'PANO',
                  name: 'a_1.jpg',
                  size: 100,
                  thumbnail: 'https://oss/thumb/a1.jpg',
                  download: 'https://oss/a1_origin.jpg',
                },
                {
                  id: 6,
                  secret: 'S',
                  recreateType: 'PANO',
                  name: 'a_0.jpg',
                  size: 200,
                  thumbnail: 'https://oss/thumb/a0.jpg',
                  download: 'https://oss/a0_origin.jpg',
                },
              ],
            },
            {
              taskType: 2,
              status: 2,
              projectId: 231070463906821, // 别的项目
              recordId: 12,
              createTime: '2026-07-15 10:40:00',
              resultRecordDTOList: [
                { id: 9, recreateType: 'PANO', name: 'b_0.jpg', size: 1, thumbnail: 'https://oss/thumb/b.jpg' },
              ],
            },
          ]),
        })
      }),
    )

    const pano = await fetchRecordPano([10], '2026-07-12 00:00:00')
    expect(pano?.recordId).toBe(10)
    // 同一次飞行的多个全景点取名字排序第一个（与「项目全景」同一口径）
    expect(pano?.name).toBe('a_0.jpg')
    expect(pano?.preview).toContain('a0.jpg')
    expect(pano?.full).toContain('a0_origin.jpg')
    // 完成时刻用 endTime（V2 列表显示的就是它）
    expect(pano?.time).toBe('2026-07-15 10:30:00')

    // 别的项目的记录 id 找不到全景
    expect(await fetchRecordPano([12], '2026-07-12 00:00:00')).toBeNull()
  })

  it('站点没有全景成果：返回 null，且翻到比记录更早的成果就停', async () => {
    resetPanoIndex()
    let pages = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        pages += 1
        // 一页 1 条（远小于 pageSize）—— 翻到底了
        return khResponse({
          code: 200,
          data: recreate([
            {
              taskType: 2,
              status: 2,
              projectId: OWN,
              recordId: 99,
              createTime: '2026-07-15 10:20:00',
              resultRecordDTOList: [{ id: 1, recreateType: 'PANO', name: 'c_0.jpg', size: 1, thumbnail: 'https://oss/t.jpg' }],
            },
          ]),
        })
      }),
    )

    expect(await fetchRecordPano([500], '2026-07-14 00:00:00')).toBeNull()
    expect(pages).toBe(1)
  })

  it('store 串起来：打开航拍自动选最近站点，列表 = 全景 + 全部照片', async () => {
    resetPanoIndex()
    // 打开时按「今天」取数（日期默认今天），所以记录与全景成果都得落在今天
    const d = new Date()
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/task/exec/list/record')) {
          return khResponse({
            code: 200,
            data: [
              rec(147744, `${today}T09:38:39`),
              rec(147700, '2026-07-14T09:00:00', '向阳村-安全巡检'),
            ],
          })
        }
        if (u.includes('/media/task/job/147744')) return khResponse({ code: 200, data: media(9) })
        if (u.includes('/recreate/getProjectRecreateInfo')) {
          return khResponse({
            code: 200,
            data: recreate([
              {
                taskType: 2,
                status: 2,
                projectId: OWN,
                recordId: 147744,
                taskName: '向阳村-全景_202607150938147744',
                createTime: `${today} 10:20:00`,
                endTime: `${today} 10:30:00`,
                resultRecordDTOList: [
                  {
                    id: 1,
                    secret: 'S',
                    recreateType: 'PANO',
                    name: 'p_0.jpg',
                    size: 100,
                    thumbnail: 'https://oss/thumb/p.jpg',
                    download: 'https://oss/p_origin.jpg',
                  },
                ],
              },
            ]),
          })
        }
        return khResponse({ code: 200, data: [] })
      }),
    )

    const air = useAirHazardStore()
    air.openAir()
    // 首次加载比之前多一层（清单 → 站点当日 → 媒体 → 全景），多等几轮微任务
    for (let i = 0; i < 5; i++) await flushPromises()

    // 安全巡检不再进下拉（只留拍照站点），所以这里只剩一条
    expect(air.stations.map((s) => s.name)).toEqual(['向阳村-全局定点拍照'])
    expect(air.station).toBe('向阳村-全局定点拍照')
    expect(air.airState).toBe('ok')
    // 全景 1 张 + 采集照片 9 张，全景排第一
    expect(air.airList).toHaveLength(10)
    expect(air.airList[0].pano).toBe(true)
    expect(air.airList.filter((s) => s.pano)).toHaveLength(1)
    expect(air.airHint).toContain('9 张')
    expect(air.airHint).toContain('含全景')
  })

  /* ---------------- 日期控件恢复（2026-11-19）：按「站点 + 日期」取数 ---------------- */

  it('按日期取数：只认那一天，同一天飞了两班取后一班', async () => {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        asked.push(u)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/media/task/job/22')) return khResponse({ code: 200, data: media(3) })
        if (u.includes('/media/task/job/21')) return khResponse({ code: 200, data: media(1) })
        if (u.includes('/task/exec/list/record')) {
          return khResponse({
            code: 200,
            data: [rec(21, '2026-07-14T08:00:00'), rec(22, '2026-07-14T15:00:00')],
          })
        }
        return khResponse({ code: 200, data: {} })
      }),
    )

    const g = await fetchStationDay('向阳村-全局定点拍照', '2026-07-14')
    expect(g?.jobId).toBe(22)
    expect(g?.media).toHaveLength(3)
    // 服务端 end 不含当天 → 传次日，区间正好是这一天
    expect(asked.some((u) => u.includes('start=2026-07-14') && u.includes('end=2026-07-15'))).toBe(true)
  })

  it('按日期取数：这一天没有该站点（或没有媒体）时返回 null，不回落到别的日期', async () => {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        asked.push(u)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/task/exec/list/record')) {
          // 这一天只有别的站点
          return khResponse({ code: 200, data: [rec(31, '2026-07-14T09:00:00', '向阳村-安全巡检')] })
        }
        if (u.includes('/media/task/job/')) return khResponse({ code: 200, data: media(2) })
        return khResponse({ code: 200, data: {} })
      }),
    )

    expect(await fetchStationDay('向阳村-全局定点拍照', '2026-07-14')).toBeNull()
    // 站点都没匹配上，不该再去要媒体
    expect(asked.some((u) => u.includes('/media/task/job/'))).toBe(false)
  })

  it('store：首次打开按「站点 + 今天」取数；选日期只换日期；未来与超窗口的日期都不切', async () => {
    resetPanoIndex()
    const key = (shift: number): string => {
      const d = new Date()
      d.setDate(d.getDate() + shift)
      const p = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    const today = key(0)
    const day5 = key(-5)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/task/exec/list/record')) {
          if (u.includes(`start=${day5}`)) {
            return khResponse({ code: 200, data: [rec(31, `${day5}T09:00:00`)] })
          }
          // 今天是「最近一次」：首次打开就该走这条，而不是回填成别的日期
          return khResponse({ code: 200, data: [rec(147744, `${today}T09:38:39`)] })
        }
        if (u.includes('/media/task/job/31')) return khResponse({ code: 200, data: media(2) })
        if (u.includes('/media/task/job/147744')) return khResponse({ code: 200, data: media(9) })
        return khResponse({ code: 200, data: { list: [] } })
      }),
    )

    const air = useAirHazardStore()
    air.openAir()
    for (let i = 0; i < 5; i++) await flushPromises()
    // 首次打开：站点自动选最新飞过的那个，但**日期必须是今天**，
    // 不能因为「最近一次采集的 start」被回填成别的日期
    expect(air.station).toBe('向阳村-全局定点拍照')
    expect(air.airDateLabel).toBe('今天')
    expect(air.airList).toHaveLength(9)

    // 选 5 天前：按站点 + 日期取，列表换成那一班
    const d5 = new Date()
    d5.setDate(d5.getDate() - 5)
    expect(air.setAirDate(d5)).toBe(true)
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(air.airDate.getDate()).toBe(d5.getDate())
    expect(air.airList).toHaveLength(2)

    // 未来日期：拦下，日期与列表都不动
    const before = air.airDate.getTime()
    expect(air.setAirDate(new Date(Date.now() + 3 * 86400000))).toBe(false)
    expect(air.airDate.getTime()).toBe(before)
    expect(air.airList).toHaveLength(2)

    // 超出窗口（今天往前 90 天以外）：同样拦下
    const old = new Date()
    old.setDate(old.getDate() - 120)
    expect(air.setAirDate(old)).toBe(false)
    expect(air.airDate.getTime()).toBe(before)
  })

  /**
   * 现场 bug（2026-11-19）：默认站点最近一次是今天，切到「向阳村-全景」
   * （最近一次是昨天）→ 日期芯片从今天跳成昨天。日期与站点必须互相独立。
   */
  it('store：切站点不碰日期；新站点当天没飞就空态，也不把日期改走', async () => {
    resetPanoIndex()
    const key = (shift: number): string => {
      const d = new Date()
      d.setDate(d.getDate() + shift)
      const p = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    const today = key(0)
    const yest = key(-1)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
        if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
        if (u.includes('/task/exec/list/record')) {
          // 查「昨天」这一天的区间（start=昨天&end=今天）
          if (u.includes(`start=${yest}`)) {
            return khResponse({ code: 200, data: [rec(52, `${yest}T15:00:00`, '向阳村-全景')] })
          }
          // 90 天清单 / 查今天：塔吊定点今天飞过，全景最近一次在昨天
          return khResponse({
            code: 200,
            data: [
              rec(51, `${today}T09:00:00`, '向阳村-塔吊定点'),
              rec(52, `${yest}T15:00:00`, '向阳村-全景'),
            ],
          })
        }
        if (u.includes('/media/task/job/51')) return khResponse({ code: 200, data: media(2) })
        if (u.includes('/media/task/job/52')) return khResponse({ code: 200, data: media(3) })
        return khResponse({ code: 200, data: { list: [] } })
      }),
    )

    const air = useAirHazardStore()
    air.openAir()
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(air.airDateLabel).toBe('今天')
    expect(air.airList).toHaveLength(2)

    // 切到「最近一次在昨天」的站点：日期仍是今天，不是昨天
    air.pickStation('向阳村-全景')
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(air.station).toBe('向阳村-全景')
    expect(air.airDateLabel).toBe('今天')
    expect(air.airState).toBe('empty')
    // 空态里点明该站点最近一次是哪天，给用户下一步
    expect(air.airNote).toContain('最近一次')
    expect(air.airNote).toContain('昨天')

    // 用户自己选昨天才切过去，列表跟着日期变
    const y = new Date()
    y.setDate(y.getDate() - 1)
    expect(air.setAirDate(y)).toBe(true)
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(air.airDateLabel).toBe('昨天')
    expect(air.airList).toHaveLength(3)
  })

  /**
   * 分页（2026-11-19）：首屏只铺 8 张，`loadMoreAir()` 每次 +8。
   *
   * 断言的是**渲染窗口**而不是请求次数 —— 接口一次就回整班清单、没有
   * page/size，所以反过来要保证「分页不会多打一次媒体接口」。
   */
  it('store：首屏只铺 8 张，追加一页 +8，到底不再加也不再多请求', async () => {
    resetPanoIndex()
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`

    const stub = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/cas/auth/login')) return khResponse(casResponses().login)
      if (u.includes('/cas/auth/validate')) return khResponse(casResponses().validate)
      if (u.includes('/task/exec/list/record')) {
        return khResponse({ code: 200, data: [rec(61, `${today}T09:00:00`)] })
      }
      if (u.includes('/media/task/job/61')) return khResponse({ code: 200, data: media(20) })
      return khResponse({ code: 200, data: { list: [] } })
    })
    vi.stubGlobal('fetch', stub)

    const air = useAirHazardStore()
    air.openAir()
    for (let i = 0; i < 5; i++) await flushPromises()

    // 全量 20 张在内存里，但网格只铺前 8 张
    expect(air.airList).toHaveLength(20)
    expect(air.airListShown).toHaveLength(AIR_PAGE_SIZE)
    expect(air.airHasMore).toBe(true)
    expect(air.airRemain).toBe(12)

    const mediaCalls = (): number =>
      stub.mock.calls.filter((c) => String(c[0]).includes('/media/task/job/')).length
    const before = mediaCalls()

    await air.loadMoreAir()
    await flushPromises()
    expect(air.airListShown).toHaveLength(AIR_PAGE_SIZE * 2)
    expect(air.airRemain).toBe(4)
    // 分页在渲染层：不能再打一次媒体接口
    expect(mediaCalls()).toBe(before)

    await air.loadMoreAir()
    await flushPromises()
    expect(air.airListShown).toHaveLength(20)
    expect(air.airHasMore).toBe(false)

    // 到底之后再调：不越界、不加空页
    await air.loadMoreAir()
    expect(air.airListShown).toHaveLength(20)
  })
})
