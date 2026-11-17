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
  pickLatestPano,
  toDock,
  toLiveStream,
  toTaskRecords,
  toTaskStat,
  type DroneTaskRecord,
  toTelemetry,
} from '@/api/drone'
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
