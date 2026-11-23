import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * 监控地址清单（V2 `monitorData.json`）在组件/状态机用例里不打真实网络：
 * 这里返回 null（= 清单没取到），fetcher 的调用次数就只反映「取快照」那一路，
 * 断言才有意义。清单自身的解析见 `tests/unit/cctv.spec.ts`。
 */
vi.mock('@/api/cctv', () => ({
  loadMonitorList: async () => null,
  findMonitorEntry: () => undefined,
  pickStreamUrl: () => '',
}))

import { CAM_POINTS } from '@/data/cams'
import { dateKey } from '@/utils/date'
import { useAirHazardStore } from '@/stores/airHazard'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { clearShots } from '@/utils/shotArchive'

import { blobUrls } from '../helpers/browser'

function pngFile(name = 'shot.png'): File {
  return new File(['x'], name, { type: 'image/png' })
}

function txtFile(name = 'note.txt'): File {
  return new File(['x'], name, { type: 'text/plain' })
}

/**
 * 状态层
 *
 * 三个 store 里塞着原版最容易被改坏的部分：抽屉档位的持久化与旧键迁移、
 * 覆盖层之间的互斥（开监控要关掉航拍/隐患）、以及抓拍/航拍这类
 * 「按日期偏移派生」的计算。这些行为没有 UI 断言可依赖，只能在这一层锁住。
 */
describe('stores', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    // 注意：这里**不能**提前实例化 auth/shell store。auth 会连带创建 shell，
    // 而 shell 的抽屉档位在初始化时就读 localStorage 并把默认值写回去；
    // 下面「抽屉档位持久化」用例随后才 setItem 就再也读不到了。
    // 阶段 5 的报警夹具只放进 cam 自己的 beforeEach。
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /* ============================================================ */

  describe('shell', () => {
    describe('抽屉档位持久化', () => {
      it('默认全开（与原版 sheetUp 初值 true 一致）', () => {
        const shell = useShellStore()
        expect(shell.sheetLevel).toBe(2)
      })

      it('优先读新的档位键', () => {
        localStorage.setItem('xyc.sheetLevel', '1')
        expect(useShellStore().sheetLevel).toBe(1)
      })

      it('历史「收起」档（0）在读档时抬到半开', () => {
        localStorage.setItem('xyc.sheetLevel', '0')
        expect(useShellStore().sheetLevel).toBe(1)
      })

      it('新键缺失时迁移旧布尔键：0→半开、1→全开', () => {
        localStorage.setItem('xyc.sheetUp', '0')
        expect(useShellStore().sheetLevel).toBe(1)

        setActivePinia(createPinia())
        localStorage.setItem('xyc.sheetUp', '1')
        expect(useShellStore().sheetLevel).toBe(2)
      })

      it('档位值非法时视为缺失，继续走旧键迁移', () => {
        localStorage.setItem('xyc.sheetLevel', 'x')
        localStorage.setItem('xyc.sheetUp', '0')
        expect(useShellStore().sheetLevel).toBe(1)
      })

      it('档位变化同时写新键与旧键（旧键恒为「已抬起」）', async () => {
        const shell = useShellStore()
        shell.sheetLevel = 1
        await nextTick()
        expect(localStorage.getItem('xyc.sheetLevel')).toBe('1')
        expect(localStorage.getItem('xyc.sheetUp')).toBe('1')

        shell.sheetLevel = 2
        await nextTick()
        expect(localStorage.getItem('xyc.sheetLevel')).toBe('2')
        expect(localStorage.getItem('xyc.sheetUp')).toBe('1')
      })

      it('存储不可用（隐私模式/配额满）时静默回退，不影响启动', async () => {
        vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
          throw new Error('SecurityError')
        })
        const shell = useShellStore()
        expect(shell.sheetLevel).toBe(2)

        vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
          throw new Error('QuotaExceededError')
        })
        shell.sheetLevel = 1
        await nextTick()
        // 写入失败但内存状态照常更新，本次会话内切换不受影响
        expect(shell.sheetLevel).toBe(1)
      })
    })

    describe('导航与 Toast', () => {
      it('标题跟随 tab', () => {
        const shell = useShellStore()
        expect(shell.navTitle).toBe('首页')
        shell.activeTab = 'work'
        expect(shell.navTitle).toBe('工作台')
        shell.activeTab = 'msg'
        expect(shell.navTitle).toBe('消息')
        shell.activeTab = 'mine'
        expect(shell.navTitle).toBe('我的')
      })

      it('Toast 1.6s 后自动隐藏', () => {
        vi.useFakeTimers()
        const shell = useShellStore()
        shell.showToast('已上报')
        expect(shell.toast).toBe('已上报')
        expect(shell.toastVisible).toBe(true)

        vi.advanceTimersByTime(1599)
        expect(shell.toastVisible).toBe(true)

        vi.advanceTimersByTime(1)
        expect(shell.toastVisible).toBe(false)
        // 原版只摘掉 .show，不清空文本 —— 保持一致
        expect(shell.toast).toBe('已上报')
        vi.useRealTimers()
      })

      it('连续调用会取消上一个定时器，不会提前隐藏', () => {
        vi.useFakeTimers()
        const shell = useShellStore()
        shell.showToast('A')
        vi.advanceTimersByTime(1000)
        shell.showToast('B')
        vi.advanceTimersByTime(1000)
        expect(shell.toastVisible).toBe(true)
        expect(shell.toast).toBe('B')

        vi.advanceTimersByTime(600)
        expect(shell.toastVisible).toBe(false)
        vi.useRealTimers()
      })
    })

    describe('全屏地图往返', () => {
      it('openMapLand 同时切横屏与地图层标记', () => {
        const shell = useShellStore()
        shell.openMapLand()
        expect(shell.isLandscape).toBe(true)
        expect(shell.mapLandOpen).toBe(true)
        expect(shell.mapLandReturn).toBe(false)
      })

      it('closeMapLand 清掉全部标记', () => {
        const shell = useShellStore()
        shell.openMapLand()
        shell.closeMapLand()
        expect(shell.isLandscape).toBe(false)
        expect(shell.mapLandOpen).toBe(false)
        expect(shell.mapLandReturn).toBe(false)
      })

      it('无约定时 backToMapLand 是空操作', () => {
        const shell = useShellStore()
        shell.backToMapLand()
        expect(shell.mapLandOpen).toBe(false)
      })

      it('有约定时关闭覆盖层后重新拉起地图，且约定只生效一次', () => {
        const shell = useShellStore()
        shell.mapLandReturn = true
        shell.backToMapLand()
        expect(shell.mapLandOpen).toBe(true)
        expect(shell.mapLandReturn).toBe(false)

        shell.closeMapLand()
        shell.backToMapLand()
        expect(shell.mapLandOpen).toBe(false)
      })
    })
  })

  /* ============================================================ */

  describe('cam（2026-11-18 设计稿白名单 + 直播流）', () => {
    let n = 0
    const revoked: string[] = []

    /** 抓拍图片：直出字节（不是 JSON 信封） */
    function imgResponse(size = 128): Response {
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        blob: async () => new Blob([new Uint8Array(size)], { type: 'image/jpeg' }),
        text: async () => '',
        json: async () => ({}),
      } as unknown as Response
    }

    /** 历史列表信封（`{code,message,data:{items,total,...}}`，照实测结构） */
    function jsonResponse(body: unknown, status = 200): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
          get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
        },
        json: async () => body,
        text: async () => JSON.stringify(body),
        blob: async () => new Blob([]),
      } as unknown as Response
    }

    /** 今天 08:00 / 12:00 两张（`mark` 按服务端规则拼，时刻用本地时间） */
    function todayItems(): Record<string, unknown>[] {
      const make = (h: number): Record<string, unknown> => {
        const d = new Date()
        d.setHours(h, 0, 0, 0)
        const p = (x: number): string => String(x).padStart(2, '0')
        const mark = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(h)}0000`
        return {
          capturedAt: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(h)}:00:00+08:00`,
          fileSize: 128,
          imageUrl: `/api/video/snapshots?channelId=x&mark=${mark}&pid=P000000076`,
          latest: h === 12,
          mark,
          timestamp: d.getTime(),
        }
      }
      return [make(12), make(8)]
    }

    /** 历史列表：只有「今天」有两条，其它日期空（与服务端按天查的行为一致） */
    function historyResponse(url: string): Response {
      const u = new URL(url)
      const today = dateKey(new Date())
      const items = u.searchParams.get('date') === today ? todayItems() : []
      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          channelId: u.searchParams.get('channelId'),
          items,
          page: Number(u.searchParams.get('page')) || 1,
          pageSize: Number(u.searchParams.get('pageSize')) || 100,
          pid: 'P000000076',
          rangeStart: '',
          rangeEnd: today,
          total: items.length,
        },
      })
    }

    beforeEach(() => {
      n = 0
      revoked.length = 0
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:cam/${++n}`)
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
        revoked.push(u)
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).includes('/snapshots/history') ? historyResponse(String(url)) : imgResponse(),
        ),
      )
      const auth = useAuthStore()
      auth.token = 'test-token'
      auth.expiresAt = Date.now() + 3_600_000
    })

    /**
     * 抓拍档案是进程级（IndexedDB / 内存兜底）的，用例之间必须清干净，
     * 否则「今天已经存过一张」会漏到下一个用例里，空态断言全部失真。
     */
    beforeEach(async () => {
      await clearShots()
    })

    it('点位是写死的 9 个白名单，分设备设施 / 材料堆场 / 出入口管控三组', () => {
      const cam = useCamStore()
      expect(cam.points).toHaveLength(9)
      expect(cam.grouped.map((g) => [g.name, g.items.length])).toEqual([
        ['设备设施', 4],
        ['材料堆场', 1],
        ['出入口管控', 4],
      ])
      // 默认选中第一个点位（设备设施置顶后是 2#塔吊）
      expect(cam.current.name).toBe('2#塔吊')
    })

    it('camId 指向不存在的通道时回退到首个点位', () => {
      const cam = useCamStore()
      cam.camId = 'nope'
      expect(cam.current.channelId).toBe(CAM_POINTS[0].channelId)
    })

    it('applyCam 切点位：只换当前点位，不再请求「最近一帧」快照', async () => {
      const cam = useCamStore()
      cam.applyCam('34020000001310000003')
      await flushPromises()

      expect(cam.current.name).toBe('地磅全景')
      // 旧 `…/snapshots?pid&channelId` 已下线：切点位只改选择，不发请求
      const spy = fetch as unknown as ReturnType<typeof vi.fn>
      expect(spy).not.toHaveBeenCalled()

      // 再点同一个点位：什么都不变，也不发请求
      cam.applyCam('34020000001310000003')
      await flushPromises()
      expect(cam.current.name).toBe('地磅全景')
      expect(spy).not.toHaveBeenCalled()
    })

    it('applyCam 忽略不存在的通道（不把页面切成空点位）', () => {
      const cam = useCamStore()
      cam.applyCam('unknown')
      expect(cam.current.channelId).toBe(CAM_POINTS[0].channelId)
    })

    it('openCam 关掉航拍与隐患、清横屏，并按登录守卫放行', () => {
      const shell = useShellStore()
      const cam = useCamStore()
      const air = useAirHazardStore()

      air.isOpen = true
      air.hazardOpen = true
      shell.isLandscape = true

      cam.openCam()
      expect(air.isOpen).toBe(false)
      expect(air.hazardOpen).toBe(false)
      expect(shell.isLand).toBe(false)
      expect(cam.isOpen).toBe(true)
      expect(cam.camId).toBe(CAM_POINTS[0].channelId)
    })

    it('closeCam 退出横屏并关层，抓拍视图一并收起', async () => {
      const cam = useCamStore()
      cam.openCam()
      await flushPromises()
      cam.setCamLand(true)
      cam.openShots()
      await flushPromises()
      expect(cam.shotsOpen).toBe(true)

      cam.closeCam()
      expect(cam.isOpen).toBe(false)
      expect(useShellStore().isLand).toBe(false)
      expect(cam.shotsOpen).toBe(false)
      expect(cam.shots).toEqual([])
    })

    it('setCamLand 同时切两个横屏标记', () => {
      const shell = useShellStore()
      const cam = useCamStore()
      cam.setCamLand(true)
      expect(shell.isLandscape).toBe(true)
      expect(shell.isLand).toBe(true)
      cam.setCamLand(false)
      expect(shell.isLandscape).toBe(false)
      expect(shell.isLand).toBe(false)
    })

    it('会话失效（登出）撤掉抓拍图片的 objectURL，不留给下一个人', async () => {
      const cam = useCamStore()
      cam.openShots()
      await flushPromises()
      // 一张抓拍两份 objectURL：列表用缩略图、详情用原图
      const n = cam.shots.length
      expect(n).toBeGreaterThan(0)
      expect(revoked).toEqual([])

      useAuthStore().clear()
      // token 的 watch 是 flush: pre，等一拍再断言
      await nextTick()
      expect(revoked).toHaveLength(n * 2)
      expect(cam.shots).toEqual([])
      expect(cam.shotsState).toBe('idle')
    })

    /**
     * 播放态（2026-11-18 播放键联动）
     *
     * 这一层的职责只是「如实记录媒体元素报上来的状态」：有流才有非 idle 的播放态，
     * 且 error 一旦成立不会被后面的 pause 改回去（否则断流后按钮会在转圈/暂停间横跳）。
     */
    it('默认按现场模板拼出 HTTP-FLV：地址与模板逐字同构，isLive=true', () => {
      const cam = useCamStore()
      const ch = CAM_POINTS[0].channelId

      expect(cam.playUrl).toBe(
        `http://120.26.34.95:9092/rtp/42010500441188000001_${ch}.live.flv?originTypeStr=rtp_push`,
      )
      expect(cam.playMode).toBe('flv')
      expect(cam.isLive).toBe(true)
      // 地址有了不等于在播：播放态仍要等媒体元素报上来
      expect(cam.playState).toBe('idle')
      expect(cam.isPlaying).toBe(false)
    })

    it('点位挂了 stream 时单点覆盖优先，地址逐字取点位配置', () => {
      const point = CAM_POINTS[0]
      point.stream = 'https://gw.test/live/a.m3u8'
      const cam = useCamStore()
      cam.camId = point.channelId

      expect(cam.isLive).toBe(true)
      expect(cam.playUrl).toBe('https://gw.test/live/a.m3u8')

      delete point.stream
    })

    it('播放态跟着媒体事件走，error 之后不再被 pause 改回', () => {
      const cam = useCamStore()

      cam.markBuffering()
      expect(cam.playState).toBe('buffering')

      cam.markPlaying()
      expect(cam.playState).toBe('playing')
      expect(cam.isPlaying).toBe(true)

      cam.markPaused()
      expect(cam.playState).toBe('paused')
      expect(cam.isPlaying).toBe(false)

      cam.markPlayError()
      expect(cam.playState).toBe('error')
      expect(cam.playNote).toContain('正在自动重连')

      // 重连中是一个独立状态：按钮据此画成「等它自己回来」，不跟暂停混淆
      cam.markReconnecting('2 秒后自动重连（1/3）')
      expect(cam.playState).toBe('reconnecting')
      expect(cam.playNote).toContain('1/3')

      cam.markPlayError()
      cam.markPaused()
      cam.markBuffering()
      expect(cam.playState).toBe('error')

      cam.resetPlay()
      expect(cam.playState).toBe('idle')
      expect(cam.playNote).toBe('')
    })

    it('切点位把播放态复位（不把上一个通道的「在播」带过去）', async () => {
      const cam = useCamStore()
      cam.markPlaying()
      cam.applyCam('34020000001310000003')
      await flushPromises()

      expect(cam.playState).toBe('idle')
    })

    /**
     * 历史抓拍（2026-11-20：服务端历史列表 + 本机图片缓存）
     *
     * 文档《监控快照接口.docx》：`/api/video/snapshots/history?pid&channelId&page&pageSize[&date]`
     * 返回 `data.items`（`mark` / `capturedAt` / `fileSize` / `imageUrl`）与 `data.total`，
     * `date` 按北京时间自然日、近 30 天。这一组钉住「按天查、时刻用服务端的、
     * 图逐张补、没有就说没有」。
     */
    it('历史抓拍：按 date 查当天，元信息来自服务端，图片逐张补上', async () => {
      const cam = useCamStore()
      expect(cam.shotsOpen).toBe(false)

      cam.openShots()
      await flushPromises()

      expect(cam.shotsOpen).toBe(true)
      expect(cam.shots).toHaveLength(2)
      expect(cam.shotsState).toBe('ok')
      // 服务端按抓拍时刻倒序：12:00 在前、08:00 在后（不是我们排的）
      expect(cam.shots.map((s) => s.hm)).toEqual(['12:00', '08:00'])
      expect(cam.shots[0].id).toBe(cam.shots[0].mark)
      expect(cam.shots[0].channelId).toBe(cam.camId)
      expect(cam.shots[0].size).toBe(128)
      expect(cam.shots[0].state).toBe('ok')
      expect(cam.shotsHint).toContain('当天 2 张')
      // 缩略图与原图各一份 objectURL（列表用缩略图，详情才换原图）
      expect(cam.shots[0].thumb).toMatch(/^blob:cam\//)
      expect(cam.shots[0].url).toMatch(/^blob:cam\//)

      // 请求参数照文档：pid / channelId / page=1 / pageSize=100 / date=今天
      const spy = fetch as unknown as ReturnType<typeof vi.fn>
      const histUrl = String(spy.mock.calls[0]?.[0])
      expect(histUrl).toContain('/api/video/snapshots/history')
      expect(histUrl).toContain('pid=P000000076')
      expect(histUrl).toContain(`channelId=${cam.camId}`)
      expect(histUrl).toContain('page=1')
      expect(histUrl).toContain('pageSize=100')
      expect(histUrl).toContain(`date=${dateKey(new Date())}`)

      cam.closeShots()
      expect(cam.shotsOpen).toBe(false)
      expect(cam.shots).toEqual([])
      expect(cam.shotsState).toBe('idle')
    })

    it('历史抓拍：再打开一次命中缓存，同一 mark 不重复下载', async () => {
      const cam = useCamStore()
      cam.openShots()
      await flushPromises()
      const first = cam.shots.map((s) => [s.id, s.at])

      const spy = fetch as unknown as ReturnType<typeof vi.fn>
      const calls = spy.mock.calls.length

      cam.openShots()
      await flushPromises()

      expect(cam.shots.map((s) => [s.id, s.at])).toEqual(first)
      // 只多了「查列表」这一次，图片走缓存
      expect(spy.mock.calls.length).toBe(calls + 1)
    })

    it('历史抓拍：其它日期照常按 date 查，服务端没记录就是空态', async () => {
      const cam = useCamStore()
      cam.openShots()
      await flushPromises()

      const spy = fetch as unknown as ReturnType<typeof vi.fn>
      const y = new Date()
      y.setDate(y.getDate() - 1)
      const before = spy.mock.calls.length
      cam.setShotDate(y)
      await flushPromises()

      expect(cam.shots).toEqual([])
      expect(cam.shotsState).toBe('empty')
      // 历史日只查列表，不额外补任何「最新一张」
      expect(spy.mock.calls.length).toBe(before + 1)
      expect(String(spy.mock.calls[before]?.[0])).toContain('/snapshots/history')
      expect(String(spy.mock.calls[before]?.[0])).toContain(`date=${dateKey(y)}`)
    })

    it('历史抓拍：今天没有记录就是空态，不再退「最近一帧」', async () => {
      // 2#/4# 塔吊、2#门等几路服务端没有历史索引（total=0）；
      // 旧实现会再打一发「最近一帧」，那个接口已下线 —— 现在只查一次列表。
      const spy = vi.fn(async (url: string) =>
        String(url).includes('/snapshots/history')
          ? jsonResponse({ code: 200, message: 'success', data: { items: [], total: 0 } })
          : imgResponse(),
      )
      vi.stubGlobal('fetch', spy)

      const cam = useCamStore()
      cam.openShots()
      await flushPromises()

      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]?.[0])).toContain('/snapshots/history')
      expect(cam.shots).toEqual([])
      expect(cam.shotsState).toBe('empty')
    })

    it('历史抓拍：接口失败且本机无缓存 → 失败态 + 服务端那句原因', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ code: 502, message: '上游视频服务异常' }, 502)),
      )
      const cam = useCamStore()
      cam.openShots()
      await flushPromises()

      expect(cam.shots).toEqual([])
      expect(cam.shotsState).toBe('error')
      expect(cam.shotsNote).toContain('上游视频服务')
    })

    it('历史抓拍：接口失败但本机有缓存 → 照常显示，并说明这是缓存', async () => {
      const cam = useCamStore()
      cam.openShots()
      await flushPromises()
      expect(cam.shots).toHaveLength(2)
      const mark = cam.shots[0].mark
      cam.closeShots()

      // 列表挂了
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ code: 502, message: '上游视频服务异常' }, 502)),
      )
      cam.openShots()
      await flushPromises()

      expect(cam.shots).toHaveLength(2)
      expect(cam.shots.map((s) => s.mark)).toContain(mark)
      expect(cam.shotsState).toBe('ok')
      expect(cam.shotsNote).toContain('本机缓存')
    })

    it('历史抓拍：日期只放行近 30 天，越界拦下并说明，当前日期不动', async () => {
      const cam = useCamStore()
      const shell = useShellStore()
      cam.openShots()
      await flushPromises()
      const today = cam.shotDate.getTime()

      // 区间两端：今天 / 今天往前 29 天（含今天正好 30 天）
      expect(cam.shotMaxDate.getTime()).toBe(today)
      expect(cam.shotMinDate.getTime()).toBe(today - 29 * 86400000)

      // ① 未来日期：直接拦下
      const future = new Date()
      future.setDate(future.getDate() + 1)
      expect(cam.setShotDate(future)).toBe(false)
      expect(shell.toast).toContain('未来日期')
      expect(cam.shotDate.getTime()).toBe(today)

      // ② 第 30 天前（超出近 30 天）：拦下，并把边界说清楚
      const tooOld = new Date()
      tooOld.setDate(tooOld.getDate() - 30)
      expect(cam.setShotDate(tooOld)).toBe(false)
      expect(shell.toast).toContain('近 30 天')
      expect(cam.shotDate.getTime()).toBe(today)

      // ③ 边界内侧（第 29 天）：放行，且真的去查
      const edge = new Date()
      edge.setDate(edge.getDate() - 29)
      expect(cam.setShotDate(edge)).toBe(true)
      await flushPromises()
      const edgeDay = new Date(edge)
      edgeDay.setHours(0, 0, 0, 0)
      expect(cam.shotDate.getTime()).toBe(edgeDay.getTime())
      expect(cam.shotsState).toBe('empty')
    })

    it('历史抓拍：日历月份被夹在可选区间内，翻不出 30 天', async () => {
      const cam = useCamStore()
      cam.openShots()
      await flushPromises()

      // 往前翻 999 个月 → 夹到可选区间的当月
      const far = new Date()
      far.setMonth(far.getMonth() - 999, 1)
      cam.setShotCalMonth(far)
      const minMonth = new Date(cam.shotMinDate.getFullYear(), cam.shotMinDate.getMonth(), 1)
      expect(cam.shotCalMonth.getTime()).toBe(minMonth.getTime())

      // 往后翻 999 个月 → 夹到本月
      far.setMonth(new Date().getMonth() + 999, 1)
      cam.setShotCalMonth(far)
      expect(cam.shotCalMonth.getFullYear()).toBe(new Date().getFullYear())
      expect(cam.shotCalMonth.getMonth()).toBe(new Date().getMonth())
    })

    it('详情：默认压缩预览，点「查看原图」才切原图，关掉即复位', async () => {
      const cam = useCamStore()
      cam.openShots()
      await flushPromises()

      const id = cam.shots[0].id
      cam.openShot(id)
      expect(cam.shotPopOpen).toBe(true)
      expect(cam.shotPop?.id).toBe(id)
      expect(cam.shotShowFull).toBe(false)

      cam.showShotFull()
      expect(cam.shotShowFull).toBe(true)

      cam.closeShot()
      expect(cam.shotPopOpen).toBe(false)
      expect(cam.shotShowFull).toBe(false)
    })
  })

  /* ============================================================ */

  describe('airHazard', () => {
    /**
     * 航拍照片（2026-11-19 改「站点 + 最新一次采集」）
     *
     * 取数链（任务记录 → 最新一班媒体 → 该班全景成果）在
     * `tests/unit/drone.spec.ts` 里用假响应完整跑过；这里只钉状态层自己的规矩：
     * 全景排第一、没有全景就只铺照片、列表用缩略图不用原图。
     *
     * fetch 一律失败 —— 谁要是偷偷发请求，用例会自己红。
     */
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            ({
              ok: false,
              status: 500,
              json: async () => ({ code: 500, msg: '测试不打网络' }),
            }) as unknown as Response,
        ),
      )
    })

    /** 一张真实照片（字段同 `PatrolPhotoReal`） */
    function airPhoto(n: number): {
      id: string
      name: string
      url: string
      thumbnail: string
      taskName: string
      taskId: number
      jobId: number
      time: string
      size: number
      mediaType: string
    } {
      return {
        id: `182577-DJI_${n}.jpeg`,
        name: `DJI_2026111908${n}_V.jpeg`,
        url: `https://oss.keehang.com/iot-media/${n}.jpeg`,
        thumbnail: `https://oss.keehang.com/thumbnail/iot/${n}.jpeg`,
        taskName: '向阳村-全局定点拍照',
        taskId: 4916,
        jobId: 182577,
        time: `2026-11-19 08:2${n}:13`,
        size: 7520256,
        mediaType: 'image/jpeg',
      }
    }

    describe('航拍照片（站点 + 最新一次采集）', () => {
      it('全景排第一，其余照片按拍摄顺序跟在后面', () => {
        const air = useAirHazardStore()
        air.station = '向阳村-全景'
        air.airState = 'ok'
        air.airAt = '2026-11-18T11:30:00'
        air.airPhotos = [airPhoto(1), airPhoto(2)]
        air.airPano = {
          id: 9001,
          secret: 's',
          recordId: 182493,
          projectId: 193640872670213,
          projectName: '中建三局-向阳村项目',
          taskName: '向阳村-全景_202611181130182493',
          name: '向阳村-全景_202611181130182493_0.jpg',
          time: '2026-11-18 12:10:03',
          preview: 'https://oss.keehang.com/thumbnail/model/pano.jpg',
          full: 'https://oss.keehang.com/model/pano_origin.jpg',
          size: 14299349,
        }

        // 第一格是全景，后面才是采集照片（顺序保持文件名升序）
        expect(air.airList).toHaveLength(3)
        expect(air.airList[0].pano).toBe(true)
        expect(air.airList[0].img).toContain('model/pano.jpg')
        expect(air.airList.slice(1).map((s) => s.photoId)).toEqual([
          '182577-DJI_1.jpeg',
          '182577-DJI_2.jpeg',
        ])
        expect(air.airHint).toContain('含全景')
        expect(air.airHint).toContain('11/18 11:30')
      })

      it('没有全景的站点只展示采集照片（不拿项目全景凑）', () => {
        const air = useAirHazardStore()
        air.station = '向阳村-全局定点拍照'
        air.airState = 'ok'
        air.airPhotos = [airPhoto(1)]
        air.airPano = null

        expect(air.airList).toHaveLength(1)
        expect(air.airList[0].pano).toBeUndefined()
        expect(air.airHint).not.toContain('含全景')
      })

      it('列表用缩略图（原图 7MB，列表里不下）', () => {
        const air = useAirHazardStore()
        air.airPhotos = [airPhoto(1)]
        expect(air.airList[0].img).toBe('https://oss.keehang.com/thumbnail/iot/1.jpeg')
      })

      it('切站点会先清空上一站的照片与全景，再进加载态', async () => {
        const air = useAirHazardStore()
        air.airState = 'ok'
        air.airPhotos = [airPhoto(1)]
        air.airPopOpen = true
        air.airPopIdx = 1

        const p = air.loadStation('向阳村-安全巡检')
        // 同步阶段就已经清干净，不会「点了新站点还看到旧图」
        expect(air.airPhotos).toEqual([])
        expect(air.airPano).toBeNull()
        expect(air.airPopOpen).toBe(false)
        expect(air.airPopIdx).toBe(0)
        expect(air.airState).toBe('loading')
        await p
      })
    })

    describe('隐患照片管理', () => {
      it('接受图片文件并创建预览 URL', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile('a.png'), pngFile('b.png')])
        expect(air.hazardImgs).toHaveLength(2)
        expect(blobUrls.created).toHaveLength(2)
        expect(air.hazardImgs[0]).toMatch(/^blob:/)
      })

      it('拒绝非图片文件', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([txtFile(), pngFile()])
        expect(air.hazardImgs).toHaveLength(1)
        expect(blobUrls.created).toHaveLength(1)
      })

      it('上限 6 张，超出的不再创建 URL', () => {
        const air = useAirHazardStore()
        air.addHazardFiles(Array.from({ length: 10 }, (_, i) => pngFile(`${i}.png`)))
        expect(air.hazardImgs).toHaveLength(6)
        expect(blobUrls.created).toHaveLength(6)
      })

      it('已满时再添加不产生任何副作用', () => {
        const air = useAirHazardStore()
        air.addHazardFiles(Array.from({ length: 6 }, (_, i) => pngFile(`${i}.png`)))
        const created = blobUrls.created.length
        air.addHazardFiles([pngFile('extra.png')])
        expect(air.hazardImgs).toHaveLength(6)
        expect(blobUrls.created).toHaveLength(created)
      })

      it('删除单张会释放它自己的 ObjectURL，且不影响其它', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile('a.png'), pngFile('b.png'), pngFile('c.png')])
        const [a, b, c] = [...air.hazardImgs]

        air.removeHazardImg(1)
        expect(air.hazardImgs).toEqual([a, c])
        expect(blobUrls.revoked).toEqual([b])
      })

      it('越界删除是空操作', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile()])
        air.removeHazardImg(9)
        expect(air.hazardImgs).toHaveLength(1)
        expect(blobUrls.revoked).toHaveLength(0)
      })

      it('resetHazard 释放全部 URL 并复位表单', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile('a.png'), pngFile('b.png')])
        air.hazardKind = '用电隐患'
        air.hazardDesc = '描述'
        const created = [...blobUrls.created]

        air.resetHazard()
        expect(air.hazardImgs).toEqual([])
        expect(air.hazardKind).toBe('安全防护')
        expect(air.hazardDesc).toBe('')
        expect(blobUrls.revoked).toEqual(created)
      })

      it('重复 reset 不会重复释放（避免二次 revoke）', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile()])
        air.resetHazard()
        air.resetHazard()
        expect(blobUrls.revoked).toHaveLength(1)
      })
    })

    describe('提交', () => {
      it('没有照片时拒绝并给出提示', () => {
        const air = useAirHazardStore()
        expect(air.submitHazard()).toEqual({ ok: false, message: '请先拍摄或选择现场照片' })
      })

      it('有照片时通过', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile()])
        expect(air.submitHazard()).toEqual({ ok: true, message: '隐患已上报，待整改' })
      })

      it('只填了描述、没有照片仍不放行（原版行为）', () => {
        const air = useAirHazardStore()
        air.hazardDesc = '现场有裸线'
        expect(air.submitHazard().ok).toBe(false)
      })
    })

    describe('覆盖层互斥', () => {
      it('openAir 关掉监控与隐患上报，并收起大图', () => {
        const cam = useCamStore()
        const air = useAirHazardStore()
        cam.isOpen = true
        air.hazardOpen = true
        air.airPopOpen = true

        air.openAir()
        expect(cam.isOpen).toBe(false)
        expect(air.hazardOpen).toBe(false)
        expect(air.airPopOpen).toBe(false)
        expect(air.isOpen).toBe(true)
      })

      it('openHazard 关掉监控与航拍，并清空上次表单', () => {
        const cam = useCamStore()
        const air = useAirHazardStore()
        cam.isOpen = true
        air.isOpen = true
        air.addHazardFiles([pngFile()])

        air.openHazard()
        expect(cam.isOpen).toBe(false)
        expect(air.isOpen).toBe(false)
        expect(air.hazardOpen).toBe(true)
        expect(air.hazardImgs).toEqual([])
        expect(blobUrls.revoked).toHaveLength(1)
      })

      it('closeAir / closeHazard 复位各自标记', () => {
        const air = useAirHazardStore()
        air.isOpen = true
        air.airPopOpen = true
        air.closeAir()
        expect([air.isOpen, air.airPopOpen]).toEqual([false, false])

        air.hazardOpen = true
        air.addHazardFiles([pngFile()])
        air.closeHazard()
        expect(air.hazardOpen).toBe(false)
        expect(air.hazardImgs).toEqual([])
        expect(blobUrls.revoked).toHaveLength(1)
      })
    })
  })
})
