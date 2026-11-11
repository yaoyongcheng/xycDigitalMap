/**
 * 视频报警（A′ 组 :8085）+ 报警 store 换源。
 *
 * 契约最初来自 Unity 端反编译，2026-11-11 已用现场账号逐条实测校准
 * （列表在 `data.list`、字段 camelCase、成功码 200、`alertName` 常为空串、
 * 截图返回**裸 base64 文本**、登出在 `/api/user/auth/logout`）。
 * 这些形状假设一旦猜错，首页会静默变成「今日预警 0」，而现场只会说
 * 「报警没了」，不会有人想到是字段名。
 *
 * 另一个重点是**回落**：接口不可达时必须是演示数据照常显示，而不是空白。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearPictureCache, fetchAlarmPicture, fetchVideoAlarms, parseVideoAlarms } from '@/api/video'
import { useAlarmStore } from '@/stores/alarm'
import { alarmTone } from '@/utils/alarmTone'
import { normalizeTime, relTime, remoteIdOf, toAlarms } from '@/utils/videoAlarm'

/** video.ts 走 text() 而不是 json()，mock 也要对上 */
function body(body: unknown, status = 200): Response {
  return { ok: status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response
}

/** 截图接口返回的是裸文本（base64），不能 JSON.stringify */
function rawText(text: string, status = 200): Response {
  return { ok: status < 300, status, text: async () => text } as unknown as Response
}

/** 一段足够长、以 JPEG 魔数开头的 base64（代码里有 64 字符的下限防呆） */
const B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUf' +
  'GhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgo' +
  'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAA' +
  'AAAAAAAK/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/' +
  'AKAAAAM/AP/Z'

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

  it('缺 Id 的行丢掉（点不进详情也拉不到截图），但空报警名必须保留', () => {
    const p = parseVideoAlarms({
      data: { list: [{ ...ROW, Id: undefined }, { ...ROW, AlertName: '' }, ROW] },
    })
    // 现场 alertName 常为空串，名字由 alertType 还原 —— 早先「没名就丢」会丢掉整页
    expect(p.rows).toHaveLength(2)
    expect(p.rows[0].alertName).toBe('')
  })

  it('接口返回异常形状时给空结果，不抛错', () => {
    expect(parseVideoAlarms(null).rows).toEqual([])
    expect(parseVideoAlarms({ code: 200, data: null }).rows).toEqual([])
    expect(parseVideoAlarms({ code: 200, data: 'boom' }).rows).toEqual([])
  })

  it('total 缺省时按本页条数', () => {
    expect(parseVideoAlarms({ data: { list: [ROW, ROW] } }).total).toBe(2)
  })

  it('现场原始行（camelCase + 字符串数字 + 空名）能原样收敛', () => {
    // 2026-11-11 实测首行的精简版：字段全小写驼峰，数字是字符串，名称是空串
    const raw = {
      type: 'alert',
      id: 85994,
      deviceNo: '06d0680610086',
      channelNo: '3',
      boxNo: '1',
      alertType: '12',
      alertName: '',
      captureTime: '2026-11-11 08:37:00',
      sceneCode: 'P000000076',
      plateNo: '',
      createTime: '2026-11-11T08:37:00.849494473+08:00',
      timestamp: 1794357420,
      extInfo: {},
      handleStatus: 0,
    }
    const p = parseVideoAlarms({ code: 200, message: 'success', data: { list: [raw], total: 1807 } })
    expect(p.total).toBe(1807)
    expect(p.rows[0]).toEqual({
      id: '85994',
      alertName: '',
      alertType: 12,
      captureTime: '2026-11-11 08:37:00',
      handleStatus: 0,
      channelNo: 3,
    })
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

  it('alertName 为空串时用 alertType 还原（现场最常见的形状）', () => {
    const [a] = toAlarms([
      { ...mk(1, '', '2026-11-11 08:37:00'), alertType: 12, channelNo: 3 },
    ])
    expect(a.type).toBe('反光衣检测')
    // 反光衣 → 防护类配图与风险色
    expect(a.title).toBe('防护报警')
    expect(a.img).toBe('img/alarm-net.webp')
    expect(a.desc).toBe('反光衣检测 · 3号通道抓拍')
  })

  it('名与类型码都取不到时给中性名，不丢行也不留空', () => {
    const rows = toAlarms([{ ...mk(1, '', '2026-11-11 09:00:00'), alertType: 9999 }])
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('AI 识别报警')
    expect(rows[0].img).toBe('img/alarm-net.webp')
  })

  it('多个常见类型码都能还原成可读名称', () => {
    const cases: [number, string][] = [
      [11, '安全帽检测'],
      [18, '车辆拥堵检测'],
      [30, '摔倒检测'],
      [56, '区域入侵检测'],
      [75, '工服检测'],
    ]
    for (const [code, name] of cases) {
      const [a] = toAlarms([{ ...mk(1, '', '2026-11-11 09:00:00'), alertType: code }])
      expect(a.type).toBe(name)
    }
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
  // 抓拍图缓存是模块级 Map，用例之间必须清，否则「第二次命中缓存」会跨用例串味
  beforeEach(() => clearPictureCache())
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

  it('截图走现场真实形状：base64 在 data.pictureData 里', async () => {
    // 2026-11-11 实测：200 + application/json，base64 藏在 data.pictureData
    const payload = { code: 200, message: 'success', data: { id: 85994, pictureData: B64 } }
    vi.stubGlobal('fetch', vi.fn(async () => rawText(JSON.stringify(payload))))
    await expect(fetchAlarmPicture('t', '85994')).resolves.toBe(`data:image/jpeg;base64,${B64}`)
  })

  it('data 直接是 base64 串的部署也认', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rawText(JSON.stringify({ code: 200, data: B64 }))))
    await expect(fetchAlarmPicture('t', 'p1')).resolves.toBe(`data:image/jpeg;base64,${B64}`)
  })

  it('裸 base64 文本也认（早期按「纯文本」实现的形状）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rawText(B64)))
    await expect(fetchAlarmPicture('t', 'p2')).resolves.toBe(`data:image/jpeg;base64,${B64}`)
  })

  it('已带 data 前缀的不重复拼', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rawText(`data:image/png;base64,${B64}`)))
    await expect(fetchAlarmPicture('t', 'p3')).resolves.toBe(`data:image/jpeg;base64,${B64}`)
  })

  it('取不到可用图时明确报错，不拼出必然加载失败的 src', async () => {
    // 空响应
    vi.stubGlobal('fetch', vi.fn(async () => rawText('')))
    await expect(fetchAlarmPicture('t', 'e1')).rejects.toThrow('没有可用的抓拍图')

    // 最典型的坑：把 data 对象当字符串，得到 [object Object]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => rawText(JSON.stringify({ code: 200, data: {}, picture: '' }))),
    )
    await expect(fetchAlarmPicture('t', 'e2')).rejects.toThrow('没有可用的抓拍图')

    // 过短的值（不是真图）
    vi.stubGlobal('fetch', vi.fn(async () => rawText('QUJD')))
    await expect(fetchAlarmPicture('t', 'e3')).rejects.toThrow('没有可用的抓拍图')
  })

  it('同一张图第二次直接命中缓存，不再打接口', async () => {
    const f = vi.fn(async () => rawText(JSON.stringify({ code: 200, data: { pictureData: B64 } })))
    vi.stubGlobal('fetch', f)
    await fetchAlarmPicture('t', 'cached-1')
    await fetchAlarmPicture('t', 'cached-1')
    expect(f).toHaveBeenCalledTimes(1)
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

/**
 * 真实报警名的风险分档（alarmTone）
 *
 * 原先只有演示数据那 4 个名字走精确匹配，接口下发的「反光衣检测」这类名字
 * 全部落到最低档蓝色 —— 管理员扫一眼分不出哪条该先处理。
 */
describe('alarmTone 覆盖真实报警名', () => {
  it('演示数据四个名字不变档（精确表优先）', () => {
    expect(alarmTone('安全网缺失')).toBe('guard')
    expect(alarmTone('电缆拖地')).toBe('power')
    expect(alarmTone('裸土未覆盖')).toBe('dust')
    expect(alarmTone('道路垃圾')).toBe('env')
  })

  it('人身防护 / 暴力 / 火灾 → guard', () => {
    for (const n of ['安全帽检测', '反光衣检测', '工服检测', '人员打架', '区域入侵检测', '摔倒检测', '烟火检测']) {
      expect(alarmTone(n)).toBe('guard')
    }
  })

  it('用电 / 消防设施 / 岗位失守 → power', () => {
    for (const n of ['消防车通道占用', '监控电缆破损', '离岗检测', '睡岗检测', '摄像头遮挡检测']) {
      expect(alarmTone(n)).toBe('power')
    }
  })

  it('环境扬尘 / 排污 → dust；统计与交通 → env', () => {
    expect(alarmTone('道路抛洒物检测')).toBe('dust')
    expect(alarmTone('排污口水质检测')).toBe('dust')
    expect(alarmTone('客流统计')).toBe('env')
    expect(alarmTone('车辆拥堵检测')).toBe('env')
  })

  it('真的不认识的，仍然按最低档，不误报成最高警报色', () => {
    expect(alarmTone('某种全新算法')).toBe('env')
    expect(alarmTone('')).toBe('env')
  })
})
