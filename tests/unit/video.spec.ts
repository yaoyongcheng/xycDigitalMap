/**
 * 视频报警（A′ 组 :8085）+ 报警 store 换源。
 *
 * 这一组的契约全部来自 Unity 端反编译，没有一份接口文档，所以最该被测试钉住的
 * 是「形状假设」：列表在 `data.list`、行字段是 Pascal 命名、成功码是 200、
 * 截图是 base64 纯文本。任何一条猜错都会让首页变成「今日预警 0」，
 * 而现场只会说「报警没了」，不会有人想到是字段名。
 *
 * 另一个重点是**回落**：接口不可达时必须是演示数据照常显示，而不是空白。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchAlarmPicture, fetchVideoAlarms, parseVideoAlarms } from '@/api/video'
import { useAlarmStore } from '@/stores/alarm'
import { normalizeTime, relTime, remoteIdOf, toAlarms } from '@/utils/videoAlarm'

/** video.ts 走 text() 而不是 json()，mock 也要对上 */
function body(body: unknown, status = 200): Response {
  return { ok: status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response
}

/** 截图接口返回的是裸文本（base64），不能 JSON.stringify */
function rawText(text: string, status = 200): Response {
  return { ok: status < 300, status, text: async () => text } as unknown as Response
}

const ROW = {
  Id: 1024,
  CaptureTime: '2026-11-11 08:12:30',
  AlertName: '未戴安全帽',
  AlertType: 3,
  HandleStatus: 0,
  ChannelNo: 7,
}

describe('parseVideoAlarms', () => {
  it('列表在 data.list（不是 data.rows）', () => {
    const p = parseVideoAlarms({ code: 200, data: { list: [ROW], total: 37 } })
    expect(p.total).toBe(37)
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0]).toEqual({
      id: '1024',
      alertName: '未戴安全帽',
      alertType: 3,
      captureTime: '2026-11-11 08:12:30',
      handleStatus: 0,
      channelNo: 7,
    })
  })

  it('data.rows / data 直接是数组也认', () => {
    expect(parseVideoAlarms({ data: { rows: [ROW] } }).rows).toHaveLength(1)
    expect(parseVideoAlarms({ data: [ROW] }).rows).toHaveLength(1)
    expect(parseVideoAlarms([ROW]).rows).toHaveLength(1)
  })

  it('缺 Id 或缺报警名的行丢掉（点不进详情也拉不到截图）', () => {
    const p = parseVideoAlarms({
      data: { list: [{ ...ROW, Id: undefined }, { ...ROW, AlertName: '' }, ROW] },
    })
    expect(p.rows).toHaveLength(1)
  })

  it('接口返回异常形状时给空结果，不抛错', () => {
    expect(parseVideoAlarms(null).rows).toEqual([])
    expect(parseVideoAlarms({ code: 200, data: null }).rows).toEqual([])
    expect(parseVideoAlarms({ code: 200, data: 'boom' }).rows).toEqual([])
  })

  it('total 缺省时按本页条数', () => {
    expect(parseVideoAlarms({ data: { list: [ROW, ROW] } }).total).toBe(2)
  })
})

describe('normalizeTime', () => {
  it('标准格式原样归一（补秒）', () => {
    expect(normalizeTime('2026-11-11 08:12:30')).toBe('2026-11-11 08:12:30')
    expect(normalizeTime('2026-11-11 08:12')).toBe('2026-11-11 08:12:00')
  })

  it('ISO 带 T 与时区也认', () => {
    expect(normalizeTime('2026-11-11T08:12:30+08:00')).toBe('2026-11-11 08:12:30')
  })

  it('解析不出来给空串（调用方据此丢弃，不能编一个时间）', () => {
    expect(normalizeTime('')).toBe('')
    expect(normalizeTime('刚刚')).toBe('')
    expect(normalizeTime('2026/11/11 08:12')).toBe('')
  })
})

describe('relTime', () => {
  const now = new Date(2026, 10, 11, 10, 0)

  it('一分钟内算「刚刚」', () => {
    expect(relTime('2026-11-11 09:59:40', now)).toBe('刚刚')
  })

  it('一小时内按分钟', () => {
    expect(relTime('2026-11-11 09:24:00', now)).toBe('36分钟前')
  })

  it('同日更早按「今天 HH:mm」，跨日按昨天 / MM/DD', () => {
    expect(relTime('2026-11-11 07:05:00', now)).toBe('今天 07:05')
    expect(relTime('2026-11-10 21:30:00', now)).toBe('昨天 21:30')
    expect(relTime('2026-11-08 16:40:00', now)).toBe('11/08 16:40')
  })
})

describe('toAlarms', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 10, 11, 10, 0))
  })
  afterEach(() => vi.useRealTimers())

  const mk = (id: number, name: string, time: string) => ({
    id: String(id),
    alertName: name,
    alertType: 1,
    captureTime: time,
    handleStatus: 0,
    channelNo: 3,
  })

  it('按时间倒序，并区分今日 / 历史', () => {
    const rows = toAlarms([
      mk(1, '未戴安全帽', '2026-11-09 09:00:00'),
      mk(2, '道路垃圾', '2026-11-11 09:30:00'),
      mk(3, '电缆拖地', '2026-11-11 08:00:00'),
    ])
    expect(rows.map((r) => r.at)).toEqual([
      '2026-11-11 09:30:00',
      '2026-11-11 08:00:00',
      '2026-11-09 09:00:00',
    ])
    expect(rows.map((r) => r.day)).toEqual(['today', 'today', 'hist'])
  })

  it('报警名进 type（详情页标题要用原话），分类名进 title', () => {
    const [a] = toAlarms([mk(1, '裸土未覆盖', '2026-11-11 09:00:00')])
    expect(a.type).toBe('裸土未覆盖')
    expect(a.title).toBe('扬尘报警')
    expect(a.src).toBe('cam')
  })

  it('按关键词配图，归不进去也必须有图（详情页直接拿它当 src）', () => {
    const imgs = toAlarms([
      mk(1, '道路垃圾', '2026-11-11 09:00:00'),
      mk(2, '电缆拖地', '2026-11-11 09:00:00'),
      mk(3, '临边防护缺失', '2026-11-11 09:00:00'),
      mk(4, '渣土未覆盖', '2026-11-11 09:00:00'),
      mk(5, '火星识别', '2026-11-11 09:00:00'),
    ]).map((a) => a.img)
    expect(imgs).toEqual([
      'img/alarm-trash.webp',
      'img/alarm-cable.webp',
      'img/alarm-net.webp',
      'img/alarm-soil.webp',
      'img/alarm-net.webp',
    ])
  })

  it('没有坐标就不给 pin/flat（不撒假点）', () => {
    const [a] = toAlarms([mk(1, '未戴安全帽', '2026-11-11 09:00:00')])
    expect(a.pin).toBeUndefined()
    expect(a.flat).toBeUndefined()
    expect(a.geo).toBe('')
  })

  it('时间解析不出来的记录被丢弃', () => {
    expect(toAlarms([{ ...mk(1, '未戴安全帽', ''), captureTime: '' }])).toEqual([])
  })

  it('本地 id 加 va- 前缀，截图时能还原服务端 Id', () => {
    const [a] = toAlarms([mk(1024, '未戴安全帽', '2026-11-11 09:00:00')])
    expect(a.id).toBe('va-1024')
    expect(remoteIdOf(a)).toBe('1024')
    // 演示数据的 id 不该被截断成乱码
    expect(remoteIdOf({ ...a, id: 'trash' })).toBe('')
  })
})

describe('fetchVideoAlarms / fetchAlarmPicture', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('打到 8085 的 /api/video/alarms，带齐 page / page_size / sceneCode 与 Bearer', async () => {
    const f = vi.fn(async () => body({ code: 200, data: { list: [ROW] } }))
    vi.stubGlobal('fetch', f)
    await fetchVideoAlarms('tok-1')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://115.159.67.12:8085/api/video/alarms?page=1&page_size=50&sceneCode=P000000076')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  it('业务码不是 200 时抛错并带上服务端文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => body({ code: 500, message: '工作流异常' }, 500)))
    await expect(fetchVideoAlarms('t')).rejects.toThrow('工作流异常')
  })

  it('401 单独识别（登录过期，不是网络问题）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => body({ code: 401, message: '未提供认证令牌' }, 401)))
    await expect(fetchVideoAlarms('t')).rejects.toMatchObject({ code: 401 })
  })

  it('连不上时给可读文案，而不是 undici 的 TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(fetchVideoAlarms('t')).rejects.toThrow('视频报警服务不可达')
  })

  it('截图接口返回 base64 纯文本（不是 JSON），拼成 data URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rawText('/9j/4AAQSkZJRg==')))
    await expect(fetchAlarmPicture('t', '1024')).resolves.toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==')
  })

  it('已带 data 前缀的不重复拼；空图明确报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rawText('data:image/png;base64,AAA')))
    await expect(fetchAlarmPicture('t', '1')).resolves.toBe('data:image/jpeg;base64,AAA')

    vi.stubGlobal('fetch', vi.fn(async () => rawText('')))
    await expect(fetchAlarmPicture('t', '1')).rejects.toThrow('没有抓拍图')
  })

  it('JSON 包一层的部署也认', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rawText(JSON.stringify({ code: 200, data: 'QUJD' }))))
    await expect(fetchAlarmPicture('t', '1')).resolves.toBe('data:image/jpeg;base64,QUJD')
  })

  it('截图 404 时给出可读错误，不吐 JSON 解析异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => 'not found' }) as unknown as Response),
    )
    await expect(fetchAlarmPicture('t', '9')).rejects.toThrow('抓拍图获取失败（HTTP 404）')
  })
})

describe('alarm store 换源', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 10, 11, 10, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const listOf = (...names: string[]) =>
    body({
      code: 200,
      data: {
        list: names.map((n, i) => ({ ...ROW, Id: i + 1, AlertName: n, CaptureTime: `2026-11-11 0${9 - i}:00:00` })),
        total: names.length,
      },
    })

  it('未登录直接返回，不打接口（必然 401，没必要浪费一趟）', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const s = useAlarmStore()
    expect(await s.syncFromVideo('')).toBe(false)
    expect(f).not.toHaveBeenCalled()
    expect(s.hasLive).toBe(false)
  })

  it('拉到真数据后，今日预警数与轮播换成真数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listOf('未戴安全帽', '道路垃圾')))
    const s = useAlarmStore()
    expect(await s.syncFromVideo('tok')).toBe(true)
    expect(s.hasLive).toBe(true)
    expect(s.latest).toHaveLength(2)
    expect(s.latest[0].type).toBe('未戴安全帽')
    // 详情页要能按 live 的 id 找到记录
    expect(s.byId('va-1')?.type).toBe('未戴安全帽')
    expect(s.liveError).toBe('')
  })

  it('失败时保留演示数据，首页不会变成 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const s = useAlarmStore()
    const before = s.latest.length
    expect(await s.syncFromVideo('tok')).toBe(false)
    expect(s.hasLive).toBe(false)
    expect(s.latest).toHaveLength(before)
    expect(s.liveError).toBe('视频报警服务不可达')
    expect(s.liveState).toBe('error')
  })

  it('失败后 60s 内不再重试，force 可绕过', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed') })
    vi.stubGlobal('fetch', f)
    const s = useAlarmStore()
    await s.syncFromVideo('tok')
    await s.syncFromVideo('tok')
    expect(f).toHaveBeenCalledTimes(1)

    await s.syncFromVideo('tok', true)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('接口成功但空列表：不覆盖已有真数据，状态标成 ok 而不是 error', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(listOf('未戴安全帽'))
      .mockResolvedValueOnce(body({ code: 200, data: { list: [], total: 0 } }))
    vi.stubGlobal('fetch', f)
    const s = useAlarmStore()
    await s.syncFromVideo('tok')
    expect(await s.syncFromVideo('tok', true)).toBe(false)
    expect(s.hasLive).toBe(true)
    expect(s.latest).toHaveLength(1)
    expect(s.liveState).toBe('ok')
  })

  it('退出登录清空真实报警，避免下一个人看到上一个人的现场', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listOf('未戴安全帽')))
    const s = useAlarmStore()
    await s.syncFromVideo('tok')
    s.clearLive()
    expect(s.hasLive).toBe(false)
    expect(s.liveState).toBe('idle')
    // 回到演示数据而不是空白
    expect(s.latest.length).toBeGreaterThan(0)
  })
})
