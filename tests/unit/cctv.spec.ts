import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CCTV_MANIFEST_SNAPSHOT_URL,
  CCTV_MANIFEST_URL,
  channelIdOfEntry,
  findMonitorEntry,
  loadMonitorList,
  parseMonitorList,
  pickStreamUrl,
  type MonitorEntry,
} from '@/api/cctv'
import {
  CCTV_CHANNELS,
  CCTV_V2_NAME,
  cctvFlvUrl,
  cctvPlayableUrl,
  cctvRtspUrl,
  cctvStreamId,
  streamModeOf,
} from '@/data/cctv'

/**
 * 监控流媒体地址（V2 `monitorData.json`）—— 2026-11-18 迁移
 *
 * 这一组钉的是「和 V2 对不对得上」，因为地址错了页面只会一直转圈，不报错：
 *   ① 地址拼法必须与 V2 清单逐字同构（`/rtp/{设备}_{通道}?originTypeStr=rtp_push`）；
 *   ② 播法判定照 V2 `CheckUrlMode`：地址含 flv 就是 FLV，其余按 RTSP；
 *   ③ 清单解析按 V2 字段名（`type` / `monitorName` / `videoPath`），不认识的当没取到；
 *   ④ 点位靠**地址里的 channelId** 对齐，不靠名字（上游有两个同名「2#门监控」）；
 *   ⑤ 线上 CDN 拿不到要退内置快照，两者都没有才算失败。
 */

const V2_SAMPLE =
  'rtsp://120.26.34.95:554/rtp/42010500441188000001_34020000001310000003?originTypeStr=rtp_push'

/** 现场给的 HTTP-FLV 模板（2026-11-18，逐字），只换 channelId 就是每个通道的流地址 */
const LIVE_SAMPLE =
  'http://120.26.34.95:9092/rtp/42010500441188000001_34020000001320000005.live.flv?originTypeStr=rtp_push'

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 502,
    json: async () => body,
  } as unknown as Response
}

function htmlResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token <')
    },
  } as unknown as Response
}

const ENTRY: MonitorEntry = { type: 'Null', monitorName: '地磅全景', videoPath: [V2_SAMPLE] }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('data/cctv · 地址拼法', () => {
  it('RTSP 地址与 V2 清单逐字同构（含 originTypeStr=rtp_push）', () => {
    expect(cctvStreamId('34020000001310000003')).toBe(
      '42010500441188000001_34020000001310000003',
    )
    expect(cctvRtspUrl('34020000001310000003')).toBe(V2_SAMPLE)
  })

  it('没有通道号时不拼地址（不返回半截 URL）', () => {
    expect(cctvRtspUrl('')).toBe('')
    expect(cctvFlvUrl('')).toBe('')
    expect(cctvPlayableUrl('')).toBe('')
  })

  /**
   * 现场 2026-11-18 给的模板（逐字）：
   *   http://120.26.34.95:9092/rtp/42010500441188000001_34020000001320000005.live.flv?originTypeStr=rtp_push
   *
   * 这条必须逐字同构，不能「差不多」：
   *   · 端口是 **9092**（给浏览器），不是 554（给桌面 RTSP）；
   *   · 前缀 `/rtp/`、后缀 `.live.flv`、query `originTypeStr=rtp_push` 一个都不能少 ——
   *     少了 originTypeStr，ZLM 会把它当成回放请求。
   */
  it('FLV 地址与现场模板逐字同构，仅 channelId 不同', () => {
    expect(cctvFlvUrl('34020000001320000005')).toBe(LIVE_SAMPLE)
    // 换通道只换那一段 20 位编号，其余部分完全一致
    expect(cctvFlvUrl('34020000001320000003')).toBe(LIVE_SAMPLE.replace(
      '34020000001320000005',
      '34020000001320000003',
    ))
  })

  it('20 个通道全部能拼出地址，且域名 / 端口 / 路径前缀 / originTypeStr 完全一致', () => {
    expect(CCTV_CHANNELS).toHaveLength(20)
    for (const { channelId } of CCTV_CHANNELS) {
      const url = cctvFlvUrl(channelId)
      expect(url.startsWith('http://120.26.34.95:9092/rtp/42010500441188000001_')).toBe(true)
      expect(url.endsWith('.live.flv?originTypeStr=rtp_push')).toBe(true)
      expect(url).toContain(`_${channelId}.live.flv`)
    }
  })

  it('默认就给出可播的 FLV 地址（不再需要等运维配模板）', () => {
    const url = cctvPlayableUrl('34020000001320000005')
    expect(url).toBe(LIVE_SAMPLE)
    expect(streamModeOf(url)).toBe('flv')
  })

  /** 全设备统一走 FLV（2026-11-18 现场确认，不做按机型分流） */
  it('任何 UA 下最终地址都是 FLV（不按机型换协议）', () => {
    expect(cctvPlayableUrl('34020000001320000005')).toBe(LIVE_SAMPLE)
    expect(streamModeOf(cctvPlayableUrl('34020000001320000005'))).toBe('flv')
  })

  it('通道名单与现场核对表一致：20 条、编号不重复', () => {
    const ids = CCTV_CHANNELS.map((c) => c.channelId)
    expect(new Set(ids).size).toBe(20)
    expect(CCTV_V2_NAME['34020000001310000003']).toBe('地磅全景')
    expect(CCTV_V2_NAME['34020000001320000016']).toBe('4#塔吊')
    expect(CCTV_V2_NAME['34020000001320000017']).toBe('2#塔吊')
  })

  it('播法判定与 V2 CheckUrlMode 一致：含 flv 即 FLV，其余 RTSP', () => {
    expect(streamModeOf('http://120.26.34.95:10000/rtp/a.live.flv')).toBe('flv')
    expect(streamModeOf('wss://gw/x.live.flv')).toBe('flv')
    expect(streamModeOf(V2_SAMPLE)).toBe('rtsp')
    expect(streamModeOf('https://gw/x/index.m3u8')).toBe('hls')
    expect(streamModeOf('https://gw/x.mp4')).toBe('other')
    expect(streamModeOf('')).toBe('none')
  })
})

describe('api/cctv · 清单解析', () => {
  it('按 V2 字段名解析，丢掉没有地址的条目', () => {
    const list = parseMonitorList([
      { type: 'Null', monitorName: '地磅全景', videoPath: [V2_SAMPLE] },
      { type: 'Null', monitorName: '空点位', videoPath: [] },
      { type: 'Null', videoPath: ['rtsp://x'] },
      'not-an-object',
    ])
    expect(list).toHaveLength(1)
    expect(list?.[0]).toEqual(ENTRY)
  })

  it('结构不对一律当没取到（不返回半个数组）', () => {
    expect(parseMonitorList(null)).toBeNull()
    expect(parseMonitorList({ list: [] })).toBeNull()
    expect(parseMonitorList([])).toBeNull()
    expect(parseMonitorList([{ type: 'Null' }])).toBeNull()
  })

  it('从地址里取 channelId：取最后一段 20 位数字', () => {
    expect(channelIdOfEntry(ENTRY)).toBe('34020000001310000003')
    expect(channelIdOfEntry({ ...ENTRY, videoPath: ['rtsp://x/live/a.flv'] })).toBe('')
  })

  it('一条清单里 flv 优先、其次 m3u8，最后才用第一个（RTSP）', () => {
    expect(
      pickStreamUrl({
        ...ENTRY,
        videoPath: [V2_SAMPLE, 'http://gw/a.live.flv', 'http://gw/a.m3u8'],
      }),
    ).toBe('http://gw/a.live.flv')

    expect(pickStreamUrl({ ...ENTRY, videoPath: [V2_SAMPLE, 'http://gw/a.m3u8'] })).toBe(
      'http://gw/a.m3u8',
    )

    expect(pickStreamUrl(ENTRY)).toBe(V2_SAMPLE)
  })

  it('按 channelId 找条目：同名通道不会张冠李戴', () => {
    const list: MonitorEntry[] = [
      { type: 'Null', monitorName: '2#门监控 1', videoPath: [cctvRtspUrl('34020000001320000003')] },
      { type: 'Null', monitorName: '2#门监控 2', videoPath: [cctvRtspUrl('34020000001320000006')] },
    ]
    expect(findMonitorEntry(list, '34020000001320000006')?.monitorName).toBe('2#门监控 2')
    expect(findMonitorEntry(list, '34020000001310000001')).toBeUndefined()
    expect(findMonitorEntry(list, '')).toBeUndefined()
  })
})

describe('api/cctv · 取清单（线上优先，快照兜底）', () => {
  it('线上 CDN 成功即用，不再碰快照', async () => {
    const spy = vi.fn(async (_url: string) => jsonResponse([ENTRY]))
    vi.stubGlobal('fetch', spy)

    const res = await loadMonitorList()
    expect(res?.source).toBe('live')
    expect(res?.list).toHaveLength(1)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0]?.[0])).toBe(CCTV_MANIFEST_URL)
    expect(CCTV_MANIFEST_URL).toBe('http://120.26.34.95:9689/CDN/PC/monitorData.json')
  })

  it('线上失败（HTTP 5xx / HTML 错误页）退内置快照', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        call += 1
        if (String(url) === CCTV_MANIFEST_URL) return htmlResponse()
        return jsonResponse([ENTRY])
      }),
    )

    const res = await loadMonitorList()
    expect(call).toBe(2)
    expect(res?.source).toBe('snapshot')
    expect(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0])).toBe(
      CCTV_MANIFEST_SNAPSHOT_URL,
    )
  })

  it('都拿不到返回 null（页面据此写「没有流地址」，不抛错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null, false)))
    expect(await loadMonitorList()).toBeNull()
  })

  it('网络直接抛错也不往上冒（混合内容 / 断网）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    expect(await loadMonitorList()).toBeNull()
  })
})

describe('内置快照 public/data/cctv.json', () => {
  it('是 V2 清单的真实副本：20 条、全 RTSP、通道不重复', () => {
    const file = resolve(process.cwd(), 'public/data/cctv.json')
    const list = parseMonitorList(JSON.parse(readFileSync(file, 'utf-8')))
    expect(list).toHaveLength(20)

    const ids = list!.map((e) => channelIdOfEntry(e))
    expect(ids.every((id) => id.length === 20)).toBe(true)
    expect(new Set(ids).size).toBe(20)

    for (const e of list!) {
      expect(e.type).toBe('Null')
      expect(e.videoPath.every((u) => u.startsWith('rtsp://120.26.34.95:554/rtp/'))).toBe(true)
      expect(e.videoPath.every((u) => u.endsWith('?originTypeStr=rtp_push'))).toBe(true)
    }
  })
})
