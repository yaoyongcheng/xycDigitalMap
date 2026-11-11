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
  fetchMediaJobs,
  fetchRoutes,
  fetchTaskRecords,
  fetchTelemetry,
  toTaskRecords,
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
      { id: 147744, taskName: '向阳村-安全巡检', lineId: 12, dockId: 23452, start: '2026-11-11T15:00:00', end: '2026-11-11T15:20:00', status: 2, scheduled: true },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 147744, taskName: '向阳村-安全巡检', lineId: 12, status: 2, scheduled: true })
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
    })
    expect(t.battery).toBe(88)
    expect(t.temp).toBe(29.3)
    expect(t.horizontalSpeed).toBe(0)
    expect(t.verticalSpeed).toBeNull()
    expect(t.altitude).toBe(117)
    expect(t.heading).toBe(90)
  })

  it('整体缺失时所有读数为 null', () => {
    const t = toTelemetry(undefined)
    expect(t.battery).toBeNull()
    expect(t.temp).toBeNull()
    expect(t.lat).toBe('')
  })

  it('容量百分比兼容顶层 batteryInfo.capacityPercent', () => {
    expect(toTelemetry({ batteryInfo: { capacityPercent: 55 } }).battery).toBe(55)
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

  it('今日任务按当天过滤，按开始时间倒序', async () => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    vi.stubGlobal(
      'fetch',
      khRoute({
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
    expect(s.totalCount).toBe(2)
    expect(s.doneCount).toBe(1)
    expect(s.running?.name).toBe('午班巡检')
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
    expect(s.totalCount).toBe(0)
  })

  it('起飞条件三态：缺数据源的项算未知，不算满足', () => {
    const s = useUavStore()
    s.apply([])

    const wind = s.checks.find((c) => c.name === '风速')
    expect(wind?.unknown).toBe(true)
    expect(wind?.ok).toBe(false)
    // 有未知项 → 不可下发（保守侧）
    expect(s.canDispatch).toBe(false)
    expect(s.unknowns.map((c) => c.name)).toContain('风速')
    expect(s.dispatchNote).toContain('数据未接入')
  })

  it('电量低于 30% 是「明确不满足」，进风险列表', () => {
    const s = useUavStore()
    s.apply([], {
      status: 1,
      lat: '',
      lng: '',
      battery: 12,
      temp: 20,
      horizontalSpeed: 0,
      verticalSpeed: 0,
      altitude: 10,
      heading: 0,
    })

    const battery = s.checks.find((c) => c.name === '电量')
    expect(battery?.unknown).toBe(false)
    expect(battery?.ok).toBe(false)
    expect(s.risks.map((c) => c.name)).toContain('电量')
    expect(s.dispatchNote).toContain('未达标')
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
