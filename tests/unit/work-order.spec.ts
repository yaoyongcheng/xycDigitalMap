import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applySession, clearSession, fetchAuditWorkOrders, type DroneWorkOrder } from '@/api/drone'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useSubpageStore } from '@/stores/subpage'
import { dateKey } from '@/utils/date'
import WorkOrderDetail from '@/views/sub/WorkOrderDetail.vue'
import WorkOrderList from '@/views/sub/WorkOrderList.vue'

/**
 * 无人机预警（= V2 大屏「工单列表」的 AI 工单）
 *
 * 这一组钉住的是**从 V2 抄过来的那套口径**，任何一处写歪，页面就会开始
 * 编数据或者干脆空白：
 *   ① 打在 `:12666` 的 `/audit_center/get_by_device_id`，`deviceId` 必须是
 *      **无人机**（23498）—— 机库/网关/空值分别回 0 条、「已拒绝该项目下的
 *      相关操作」、500；
 *   ② 不筛选就**不能**带 `auditStatusType`（空串会 400）；
 *   ③ 服务端忽略全部时间参数、但按 `businessTime` 倒序 → 「今日」是数据前缀，
 *      首屏用一页 100 条扫到 7 日窗口之外，今日条数与趋势就都是精确值；
 *   ④ 历史接着往后按 `size=20` 翻页；翻页失败不清空已有列表；
 *   ⑤ 红点没有「已读」可用，只能按状态：**今日 + 待处理**；历史一律不点。
 */

/** keehang 的响应包：`{code, msg, data}`，code === 200 才算成功 */
function khResponse(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response
}

/** 本地某天某点（用来造「今天 / 昨天 / 一周前」的行） */
function ago(days: number, hour = 10): Date {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, 0, 0, 0)
  return d
}

/** 服务端那种带毫秒的 ISO 时间 */
function isoAt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.120000`
}

/** 服务端工单行（字段名照接口原样）；`days` = 距今几天 */
function rowAt(n: number, days: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataPayloadId: `dp-${n}`,
    businessTime: isoAt(ago(days)),
    title: '道路垃圾',
    labelName: '道路垃圾',
    jobName: '向阳村-道路垃圾和杂草生长',
    projectName: '向阳村数字工地',
    auditStatusType: 'UNAUDITED',
    auditType: 'MANUAL_AUDIT',
    dataPayloadLevelType: 'NOTIFICATION_LEVEN_2',
    lng: '114.2651',
    lat: '30.5312',
    alt: '35',
    rawFiles: [{ fileUrl: `https://oss.example.com/a${n}.jpg` }],
    recordId: 900 + n,
    ...patch,
  }
}

/** 今天的行 */
function row(n: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return rowAt(n, 0, patch)
}

/** 收敛后的工单（`toWorkOrder` 的输出形状，组件直接用）；`days` = 距今几天 */
function wo(days: number, n = 1, patch: Partial<DroneWorkOrder> = {}): DroneWorkOrder {
  const d = ago(days)
  const p = (v: number) => String(v).padStart(2, '0')
  return {
    id: `dp-${n}`,
    at: `${dateKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    title: '道路垃圾',
    label: '道路垃圾',
    jobName: '向阳村-道路垃圾和杂草生长',
    projectName: '向阳村数字工地',
    status: 'UNAUDITED',
    auditType: 'MANUAL_AUDIT',
    level: 'NOTIFICATION_LEVEN_2',
    lng: '114.2651',
    lat: '30.5312',
    alt: '35',
    image: '',
    recordId: String(900 + n),
    ...patch,
  }
}

/** 记录下最近一次请求的 URL 与 JSON body */
function spyFetch(reply: () => unknown): { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return khResponse(reply())
    }),
  )
  return { calls }
}

/**
 * 按 body 分页的桩：`pageNum/pageSize` 决定切哪一片 —— 与真实接口的分页语义一致
 * （真实接口还会忽略时间参数，这里也不需要它做时间筛选）。
 */
function pagedStub(opts: { rows?: Record<string, unknown>[]; total?: number }): { calls: Record<string, unknown>[] } {
  const rows = opts.rows ?? []
  const calls: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, number | string>
      calls.push(body)
      const size = Number(body.pageSize)
      const start = (Number(body.pageNum) - 1) * size
      return khResponse({
        code: 200,
        data: { data: rows.slice(start, start + size), totalRecord: opts.total ?? rows.length },
      })
    }),
  )
  return { calls }
}

beforeEach(() => {
  setActivePinia(createPinia())
  // 跳过 CAS 两步：这里测的是审核中心那一段
  applySession({ uid: '42', token: 'TOKEN-1', expiresAt: Date.now() + 3_600_000 })
})

afterEach(async () => {
  await flushPromises()
  clearSession()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('审核中心工单接口', () => {
  it('POST 到 :12666 的 audit_center，deviceId 必须传无人机而不是机库/网关', async () => {
    const spy = spyFetch(() => ({ code: 200, data: { data: [row(1), row(2)], totalRecord: 1048 } }))

    const page = await fetchAuditWorkOrders()

    expect(spy.calls[0].url).toBe(
      'https://iot.keehang.com:12666/audit_center/get_by_device_id?pidList=193640872670213',
    )
    // 23498 = 无人机；23452（机库）回 0 条，263（网关）回「已拒绝该项目下的相关操作」
    expect(spy.calls[0].body).toEqual({ pageNum: 1, pageSize: 20, deviceId: 23498 })
    // 不筛选就不许带这个字段：传空串服务端回 400
    expect('auditStatusType' in spy.calls[0].body).toBe(false)
    expect(page.total).toBe(1048)
    expect(page.rows).toHaveLength(2)
  })

  it('传了状态才带 auditStatusType，页码/页长都夹在服务端接受的范围内', async () => {
    const spy = spyFetch(() => ({ code: 200, data: { data: [row(1)], totalRecord: 316 } }))

    await fetchAuditWorkOrders({ page: 0, size: 500, status: 'AUDITED' })

    expect(spy.calls[0].body).toEqual({
      pageNum: 1,
      pageSize: 100,
      deviceId: 23498,
      auditStatusType: 'AUDITED',
    })
  })

  it('字段映射：businessTime 截到秒、rawFiles[0] 当现场图、状态原样', async () => {
    spyFetch(() => ({ code: 200, data: { data: [row(1)], totalRecord: 1 } }))

    const [w] = (await fetchAuditWorkOrders()).rows

    expect(w.at).toBe(`${dateKey(new Date())} 10:00:00`) // T 换空格、毫秒丢掉
    expect(w.title).toBe('道路垃圾')
    expect(w.jobName).toBe('向阳村-道路垃圾和杂草生长')
    expect(w.image).toBe('https://oss.example.com/a1.jpg')
    expect(w.status).toBe('UNAUDITED')
    expect(w.auditType).toBe('MANUAL_AUDIT')
    expect(w.level).toBe('NOTIFICATION_LEVEN_2')
    expect(w.alt).toBe('35')
  })

  it('类别/任务名的兜底字段；没有 id 的行直接跳过（不编一条假的）', async () => {
    spyFetch(() => ({
      code: 200,
      data: {
        data: [
          { dataPayloadId: 'dp-x', title: '', labelName: '未戴安全帽', lineName: '向阳村-安全巡检' },
          { title: '没有 dataPayloadId 的行' },
        ],
      },
    }))

    const page = await fetchAuditWorkOrders()

    expect(page.rows).toHaveLength(1)
    expect(page.rows[0].title).toBe('未戴安全帽')
    expect(page.rows[0].jobName).toBe('向阳村-安全巡检')
    expect(page.rows[0].image).toBe('')
    // 服务端没给状态就留空串，页面写「—」，不猜「待处理」
    expect(page.rows[0].status).toBe('')
    // totalRecord 缺失时退化成行数，而不是 0
    expect(page.total).toBe(1)
  })
})

describe('无人机预警 store · 今日 / 历史 / 趋势', () => {
  it('首屏一页 100 条扫到 7 日窗口外：今日条数与趋势一次拿全', async () => {
    // 今天 5 条（1 条已完成），其余 95 条在 8~20 天前（已出窗口）
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(i + 1)),
      ...Array.from({ length: 95 }, (_, i) => rowAt(100 + i, 8 + Math.floor(i / 6))),
    ]
    rows[2].auditStatusType = 'AUDITED'
    const { calls } = pagedStub({ rows, total: 1048 })

    const drone = useDroneAlarmStore()
    await drone.load()

    expect(calls).toHaveLength(1) // 一页就够，不多打
    expect(calls[0]).toMatchObject({ pageNum: 1, pageSize: 100 })
    expect('auditStatusType' in calls[0]).toBe(false) // 不筛选就不带

    expect(drone.items).toHaveLength(100)
    expect(drone.todayCount).toBe(5)
    expect(drone.todayPending).toBe(4) // 已完成的那条不算
    expect(drone.todayKnown).toBe(true)
    expect(drone.histCount).toBe(95)
    expect(drone.total).toBe(1048)
    expect(drone.hasMore).toBe(true)
    expect(drone.hiddenCount).toBe(948)
  })

  it('第一页整页都还在 7 日内就继续扫第二页（今日很密时不会漏）', async () => {
    // 150 条全部落在最近 7 天内：今日 25 条，其余按天摊到 1~6 天前
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => row(i + 1)),
      ...Array.from({ length: 125 }, (_, i) => rowAt(100 + i, 1 + (i % 6))),
    ]
    const { calls } = pagedStub({ rows, total: 150 })

    const drone = useDroneAlarmStore()
    await drone.load()

    expect(calls.map((c) => c.pageNum)).toEqual([1, 2])
    expect(drone.items).toHaveLength(150)
    expect(drone.todayCount).toBe(25)
    expect(drone.exhausted).toBe(true)
  })

  it('今日 / 历史 / 近 7 日趋势按 businessTime 切分', async () => {
    const rows = [
      row(1),
      row(2),
      row(3, { auditStatusType: 'AUDITED' }),
      rowAt(4, 1),
      rowAt(5, 1),
      rowAt(6, 3),
      rowAt(7, 3),
      rowAt(8, 3),
    ]
    pagedStub({ rows, total: 8 })

    const drone = useDroneAlarmStore()
    await drone.load()

    expect(drone.todayItems.map((w) => w.id)).toEqual(['dp-1', 'dp-2', 'dp-3'])
    expect(drone.todayCount).toBe(3)
    expect(drone.todayPending).toBe(2)
    expect(drone.histItems.map((w) => w.id)).toEqual(['dp-4', 'dp-5', 'dp-6', 'dp-7', 'dp-8'])
    expect(drone.histCount).toBe(5)

    // 7 个点：最后一个是今天，往前依次是昨天、前天……
    const trend = drone.weekTrend
    expect(trend).toHaveLength(7)
    expect(trend[6].value).toBe(3) // 今天
    expect(trend[5].value).toBe(2) // 昨天
    expect(trend[3].value).toBe(3) // 3 天前
    expect(trend[0].value).toBe(0) // 6 天前没有
  })

  it('红点判据：今日 + 待处理；历史与已完成都不带', async () => {
    const rows = [row(1), row(2, { auditStatusType: 'AUDITED' }), rowAt(3, 1)]
    pagedStub({ rows, total: 3 })

    const drone = useDroneAlarmStore()
    await drone.load()

    const [a, b, c] = drone.items
    expect(drone.isUnread(a)).toBe(true)
    expect(drone.isUnread(b)).toBe(false) // 已完成
    expect(drone.isUnread(c)).toBe(false) // 历史，哪怕是待处理
  })

  it('下滑接着扫描的页号往后翻，只追加一页', async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(i + 1)),
      ...Array.from({ length: 95 }, (_, i) => rowAt(100 + i, 8 + Math.floor(i / 6))),
      ...Array.from({ length: 60 }, (_, i) => rowAt(300 + i, 25 + Math.floor(i / 6))),
    ]
    const { calls } = pagedStub({ rows, total: 160 })

    const drone = useDroneAlarmStore()
    await drone.load()
    expect(drone.items).toHaveLength(100)
    expect(drone.nextPage).toBe(6) // 100 条 = 5 × 20

    await drone.loadMore()

    expect(calls[1]).toMatchObject({ pageNum: 6, pageSize: 20 })
    expect(drone.items).toHaveLength(120)
    expect(drone.nextPage).toBe(7)
  })

  it('这一页全是已展示过的（偏移期间插入新工单）不重复堆，继续往后翻', async () => {
    // 服务端永远回同一批：不按 pageNum 切
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => khResponse({ code: 200, data: { data: [row(1), row(2)], totalRecord: 1048 } })),
    )

    const drone = useDroneAlarmStore()
    await drone.load()
    await drone.loadMore()

    expect(drone.items).toHaveLength(2)
    expect(drone.nextPage).toBe(2) // 页号照样推进，不会卡在同一页
    expect(drone.exhausted).toBe(false) // 服务端说还有 1048 条
  })

  it('2 分钟内重复进入不重扫，过期或强制才重来（切 tab 不白打请求）', async () => {
    const { calls } = pagedStub({ rows: [row(1)], total: 1 })
    const drone = useDroneAlarmStore()

    await drone.load()
    await drone.load()
    expect(calls).toHaveLength(1) // 第二趟被保鲜期挡掉

    await drone.load(true)
    expect(calls).toHaveLength(2)
  })

  it('首屏失败保留已有列表，只给错误与重试（不清空、不假装没预警）', async () => {
    const drone = useDroneAlarmStore()
    drone.apply([wo(0, 1), wo(0, 2)], { total: 1048 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('断网')
      }),
    )

    await drone.load(true)

    expect(drone.items).toHaveLength(2)
    expect(drone.state).toBe('error')
    expect(drone.error).toContain('无人机平台不可达')
  })

  it('退出登录清空列表、今日数与游标', async () => {
    pagedStub({ rows: [row(1)], total: 1 })
    const drone = useDroneAlarmStore()
    await drone.load()
    expect(drone.items).toHaveLength(1)
    expect(drone.todayKnown).toBe(true)

    drone.reset()
    expect(drone.items).toHaveLength(0)
    expect(drone.todayKnown).toBe(false)
    expect(drone.todayCount).toBe(0)
    expect(drone.nextPage).toBe(0)
    expect(drone.state).toBe('idle')
  })
})

describe('无人机预警列表', () => {
  /** 灌一批工单（不发请求）：今日 2 条（1 待处理 1 已完成）+ 历史 1 条 */
  function seed(total = 1048): void {
    const drone = useDroneAlarmStore()
    drone.apply(
      [
        wo(0, 1),
        wo(0, 2, {
          title: '人员未戴安全帽',
          label: '人员未戴安全帽',
          jobName: '向阳村-安全巡检',
          status: 'AUDITED',
        }),
        wo(1, 3),
      ],
      { total },
    )
  }

  it('版式与监控子页一致：今日预警 / 历史预警两个页签 + 今日预警数 + 近 7 日趋势', () => {
    seed()
    const w = mount(WorkOrderList)

    expect(w.findAll('.insp-tab').map((t) => t.text())).toEqual(['今日预警', '历史预警'])
    expect(w.find('.insp-tab.on').text()).toBe('今日预警')

    const stat = w.find('.home-stat')
    expect(stat.text()).toContain('2') // 今日两条
    expect(stat.text()).toContain('今日预警数')
    // 趋势图与监控同一套触控折线（不是另画一个 svg）
    expect(w.find('.home-chart-card .alarm-mini-lab').text()).toBe('近7日预警趋势')
    expect(w.find('.touch-chart').exists()).toBe(true)
    w.unmount()
  })

  it('今日列表：来源徽标 + 状态徽标；未带红点、已完成不带；不铺现场图', () => {
    seed()
    const w = mount(WorkOrderList)

    const items = w.findAll('.insp-pane:not(.insp-hist) .insp-item')
    expect(items).toHaveLength(2) // 历史那条不在今日页签里
    expect(items[0].find('.alarm-src-drone').text()).toBe('无人机')
    expect(items[0].find('.alarm-src-todo').text()).toBe('待处理')
    expect(items[0].find('.insp-dot').exists()).toBe(true)
    expect(items[1].find('.alarm-src-done').text()).toBe('已完成')
    expect(items[1].find('.insp-dot').exists()).toBe(false)
    // 这批工单行里本来就没有现场图（image 为空）→ 一个请求都不发，继续铺灰底占位图标
    // （「有图就铺图」那条链路由 work-order-thumb.spec 单独钉）
    expect(w.find('.insp-pic img').exists()).toBe(false)
    expect(w.findAll('.insp-pic.alarm-tile')).toHaveLength(2)
    w.unmount()
  })

  it('切到历史：只剩更早的条目，一条红点都没有', async () => {
    seed()
    const w = mount(WorkOrderList)

    await w.find('[data-wo-tab="hist"]').trigger('click')

    expect(w.findAll('.insp-tab')[1].classes()).toContain('on')
    expect(w.find('.insp-hist-hd').text()).toContain('更早的预警')
    const hist = w.findAll('.insp-hist .insp-item')
    expect(hist).toHaveLength(1)
    expect(hist[0].find('.insp-dot').exists()).toBe(false)
    w.unmount()
  })

  it('切回今日：今日那批回来了（两个页签不是两个列表）', async () => {
    seed()
    const w = mount(WorkOrderList)

    await w.find('[data-wo-tab="hist"]').trigger('click')
    expect(w.find('.insp-pane:not(.insp-hist)').classes()).toContain('hide')
    expect(w.find('.insp-hist').classes()).not.toContain('hide')

    await w.find('[data-wo-tab="today"]').trigger('click')
    expect(w.find('.insp-pane:not(.insp-hist)').classes()).not.toContain('hide')
    expect(w.find('.insp-hist').classes()).toContain('hide')
    w.unmount()
  })

  it('点一条进详情，返回目标回到列表', async () => {
    seed()
    const w = mount(WorkOrderList)
    await w.findAll('.insp-item')[1].trigger('click')

    const sub = useSubpageStore()
    expect(sub.view).toEqual({ kind: 'work-order-detail', id: 'dp-2' })
    expect(sub.title).toBe('预警详情')
    sub.close()
    expect(sub.view).toEqual({ kind: 'work-orders' })
    w.unmount()
  })

  it('垫底层（decorative）不响应点击，避免右滑时穿透', async () => {
    seed()
    const w = mount(WorkOrderList, { props: { decorative: true } })
    await w.findAll('.insp-item')[0].trigger('click')
    expect(useSubpageStore().view.kind).toBe('none')
    w.unmount()
  })

  it('今日没有记录时给「今日暂无」，页签仍留着可切换', async () => {
    const drone = useDroneAlarmStore()
    drone.apply([wo(1, 3)], { total: 1 })
    const w = mount(WorkOrderList)

    expect(w.find('[data-wo-empty]').text()).toContain('今日暂无无人机预警')
    expect(w.findAll('.insp-pane:not(.insp-hist) .insp-item')).toHaveLength(0)
    expect(w.findAll('.insp-tab')).toHaveLength(2)

    // 历史还有一条：切过去能看到
    await w.find('[data-wo-tab="hist"]').trigger('click')
    expect(w.findAll('.insp-hist .insp-item')).toHaveLength(1)
    w.unmount()
  })

  it('一条都没有时趋势位写「近 7 日暂无预警」，不画一条假线', () => {
    const drone = useDroneAlarmStore()
    drone.apply([], { total: 0 })
    const w = mount(WorkOrderList)

    expect(w.find('.chart-empty').text()).toBe('近 7 日暂无预警')
    expect(w.find('.touch-chart').exists()).toBe(false)
    w.unmount()
  })

  it('首屏失败：写清原因并给重试', () => {
    const drone = useDroneAlarmStore()
    drone.state = 'error'
    drone.error = '无人机平台不可达'
    const w = mount(WorkOrderList)

    expect(w.find('[data-wo-empty]').text()).toContain('无人机平台不可达')
    expect(w.find('.data-empty-btn').text()).toBe('重试')
    w.unmount()
  })

  it('历史底部给「还有 N 条」（只算历史那一侧）', async () => {
    seed()
    const w = mount(WorkOrderList)
    await w.find('[data-wo-tab="hist"]').trigger('click')

    expect(w.find('.insp-hist [data-more="more"]').text()).toContain('还有 1045 条')
    w.unmount()
  })
})

describe('无人机预警详情', () => {
  const WORK = {
    id: 'dp-1',
    at: '2026-11-20 13:28:01',
    title: '道路垃圾',
    label: '道路垃圾',
    jobName: '向阳村-道路垃圾和杂草生长',
    projectName: '向阳村数字工地',
    status: 'UNAUDITED' as const,
    auditType: 'MANUAL_AUDIT',
    level: 'NOTIFICATION_LEVEN_2',
    lng: '114.2651',
    lat: '30.5312',
    alt: '35',
    image: 'https://oss.example.com/a1.jpg',
    recordId: '901',
  }

  it('字段逐项照服务端渲染（任务名 / 检测时间 / 识别结果 / 经纬度）', () => {
    const w = mount(WorkOrderDetail, { props: { work: WORK } })

    const kv = w.findAll('.alarm-kv').map((n) => n.text())
    expect(kv).toContain('项目名称向阳村数字工地')
    expect(kv).toContain('任务名称向阳村-道路垃圾和杂草生长')
    expect(kv).toContain('检测时间2026-11-20 13:28:01')
    expect(kv).toContain('处理状态待处理')
    expect(kv).toContain('识别类别道路垃圾')
    expect(kv).toContain('识别方式人工审核')
    expect(kv).toContain('通知等级2 级')
    expect(kv).toContain('经纬度114.2651, 30.5312')
    expect(kv).toContain('相对高度35 m')
    w.unmount()
  })

  it('缺字段写「—」：半条坐标没有意义，等级取不到不猜', () => {
    const w = mount(WorkOrderDetail, {
      props: { work: { ...WORK, lng: '114.2651', lat: '', alt: '', level: '', auditType: '' } },
    })

    const kv = w.findAll('.alarm-kv').map((n) => n.text())
    expect(kv).toContain('经纬度—')
    expect(kv).toContain('相对高度—')
    expect(kv).toContain('通知等级—')
    expect(kv).toContain('识别方式—')
    w.unmount()
  })

  it('大图加载失败明说，不留破图', async () => {
    const w = mount(WorkOrderDetail, { props: { work: WORK } })
    await w.find('img').trigger('error')
    expect(w.find('.alarm-hero-empty').text()).toContain('现场图加载失败')
    expect(w.find('img').exists()).toBe(false)
    w.unmount()
  })

  it('没有现场图时说的是「暂无」而不是「加载失败」', () => {
    const w = mount(WorkOrderDetail, { props: { work: { ...WORK, image: '' } } })
    expect(w.find('.alarm-hero-empty').text()).toContain('该预警暂无现场图')
    w.unmount()
  })
})
