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
import { useAirHazardStore } from '@/stores/airHazard'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { usePatrolStore } from '@/stores/patrol'
import { useShellStore } from '@/stores/shell'

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
        expect(shell.sheetUp).toBe(true)
      })

      it('优先读新的档位键', () => {
        localStorage.setItem('xyc.sheetLevel', '1')
        expect(useShellStore().sheetLevel).toBe(1)
      })

      it('新键缺失时迁移旧布尔键：0→收起、1→全开', () => {
        localStorage.setItem('xyc.sheetUp', '0')
        expect(useShellStore().sheetLevel).toBe(0)

        setActivePinia(createPinia())
        localStorage.setItem('xyc.sheetUp', '1')
        expect(useShellStore().sheetLevel).toBe(2)
      })

      it('档位值非法时视为缺失，继续走旧键迁移', () => {
        localStorage.setItem('xyc.sheetLevel', 'x')
        localStorage.setItem('xyc.sheetUp', '0')
        expect(useShellStore().sheetLevel).toBe(0)
      })

      it('档位变化同时写新键与旧键（回退旧版本不丢状态）', async () => {
        const shell = useShellStore()
        shell.sheetLevel = 1
        await nextTick()
        expect(localStorage.getItem('xyc.sheetLevel')).toBe('1')
        expect(localStorage.getItem('xyc.sheetUp')).toBe('1')

        shell.sheetLevel = 0
        await nextTick()
        expect(localStorage.getItem('xyc.sheetLevel')).toBe('0')
        expect(localStorage.getItem('xyc.sheetUp')).toBe('0')
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

      it('sheetUp 布尔访问器与档位双向映射', () => {
        const shell = useShellStore()
        shell.sheetUp = false
        expect(shell.sheetLevel).toBe(0)
        expect(shell.sheetUp).toBe(false)

        shell.sheetUp = true
        expect(shell.sheetLevel).toBe(2)
        expect(shell.sheetUp).toBe(true)

        shell.sheetLevel = 1
        expect(shell.sheetUp).toBe(true)
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

  describe('cam（2026-11-18 设计稿白名单 + 快照接口）', () => {
    let n = 0
    const revoked: string[] = []

    /** 快照接口直出图片字节（不是 JSON 信封） */
    function snapResponse(size = 128): Response {
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        blob: async () => new Blob([new Uint8Array(size)], { type: 'image/jpeg' }),
      } as unknown as Response
    }

    beforeEach(() => {
      n = 0
      revoked.length = 0
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:cam/${++n}`)
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
        revoked.push(u)
      })
      vi.stubGlobal('fetch', vi.fn(async () => snapResponse()))
      const auth = useAuthStore()
      auth.token = 'test-token'
      auth.expiresAt = Date.now() + 3_600_000
    })

    it('点位是写死的 8 个白名单，分出入口 / 场内 / 塔吊三组', () => {
      const cam = useCamStore()
      expect(cam.points).toHaveLength(8)
      expect(cam.grouped.map((g) => [g.name, g.items.length])).toEqual([
        ['出入口', 4],
        ['场内', 2],
        ['塔吊', 2],
      ])
      // 默认选中第一个点位，未取图前没有画面地址
      expect(cam.current.name).toBe('2#门监控1')
      expect(cam.frameUrl).toBe('')
      expect(cam.state).toBe('idle')
    })

    it('camId 指向不存在的通道时回退到首个点位', () => {
      const cam = useCamStore()
      cam.camId = 'nope'
      expect(cam.current.channelId).toBe('34020000001320000003')
    })

    it('applyCam 切点位并取图；同一点位不重复请求', async () => {
      const cam = useCamStore()
      cam.applyCam('34020000001310000003')
      await flushPromises()

      const spy = fetch as unknown as ReturnType<typeof vi.fn>
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]?.[0])).toContain('channelId=34020000001310000003')
      expect(cam.current.name).toBe('地磅全景')
      expect(cam.state).toBe('ok')
      expect(cam.frameUrl).toBe('blob:cam/1')

      // 再点一次同一个点位：命中缓存，不再请求
      cam.applyCam('34020000001310000003')
      await flushPromises()
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('refresh 强制重取并撤掉旧 objectURL', async () => {
      const cam = useCamStore()
      cam.applyCam('34020000001310000003')
      await flushPromises()
      cam.refresh()
      await flushPromises()

      const spy = fetch as unknown as ReturnType<typeof vi.fn>
      expect(spy).toHaveBeenCalledTimes(2)
      expect(cam.frameUrl).toBe('blob:cam/2')
      expect(revoked).toEqual(['blob:cam/1'])
    })

    it('取图失败记 error + 原因，切到别的点位不受影响', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 502,
          headers: { get: () => null },
          blob: async () => new Blob([]),
        })),
      )
      const cam = useCamStore()
      cam.applyCam('34020000001310000003')
      await flushPromises()
      expect(cam.state).toBe('error')
      expect(cam.note).toContain('上游视频服务异常')
      expect(cam.frameUrl).toBe('')
    })

    it('applyCam 忽略不存在的通道（不把页面切成空点位）', () => {
      const cam = useCamStore()
      cam.applyCam('unknown')
      expect(cam.current.channelId).toBe('34020000001320000003')
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
      expect(cam.camId).toBe('34020000001320000003')
    })

    it('closeCam 退出横屏并关层，但保留已取到的画面（会话内缓存）', async () => {
      const cam = useCamStore()
      cam.openCam()
      await flushPromises()
      cam.setCamLand(true)
      cam.closeCam()

      expect(cam.isOpen).toBe(false)
      expect(useShellStore().isLand).toBe(false)
      expect(cam.frameUrl).toBe('blob:cam/1')
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

    it('会话失效（登出）撤掉全部 objectURL，不留给下一个人', async () => {
      const cam = useCamStore()
      cam.openCam()
      await flushPromises()
      cam.applyCam('34020000001320000017')
      await flushPromises()

      useAuthStore().clear()
      // token 的 watch 是 flush: pre，等一拍再断言
      await nextTick()
      expect(revoked).toEqual(['blob:cam/1', 'blob:cam/2'])
      expect(cam.frameUrl).toBe('')
      expect(cam.state).toBe('idle')
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
      expect(cam.playNote).toContain('已回到定时快照')

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
     * 历史抓拍（2026-11-18）
     *
     * 入口已通、数据待接入：`loadShots()` 现在返回空列表 + 一句说明，不编造照片。
     * 分组逻辑按真实字段（at）算，所以接口一接上，日期芯片与照片顺序就自动成立 ——
     * 这两条就是钉这件事。
     */
    it('历史抓拍：开关与空态说明（数据待接入，不塞示例照片）', async () => {
      const cam = useCamStore()
      expect(cam.shotsOpen).toBe(false)
      expect(cam.shots).toEqual([])

      cam.openShots()
      await flushPromises()

      expect(cam.shotsOpen).toBe(true)
      expect(cam.shots).toEqual([])
      expect(cam.shotsState).toBe('ok')
      expect(cam.shotsNote).toContain('接口尚未接入')

      cam.closeShots()
      expect(cam.shotsOpen).toBe(false)
    })

    it('历史抓拍按天分组，同一天按时刻倒序（接口一接上就成立）', () => {
      const cam = useCamStore()
      const day = 24 * 3600 * 1000
      const t0 = new Date(2026, 10, 18, 9, 0).getTime()

      cam.shots = [
        { id: 'a', thumb: 'ta', url: 'ua', at: t0, channelId: 'c1' },
        { id: 'b', thumb: 'tb', url: 'ub', at: t0 + day, channelId: 'c1' },
        { id: 'c', thumb: 'tc', url: 'uc', at: t0 + 3_600_000, channelId: 'c1' },
      ]

      expect(cam.shotDays.map((d) => d.label)).toEqual(['11月18日', '11月19日'])
      expect(cam.shotDays[0].items.map((s) => s.id)).toEqual(['c', 'a'])
    })
  })

  /* ============================================================ */

  describe('airHazard', () => {
    describe('航拍派生（2026-11 阶段 8：改真实航拍照片）', () => {
      /**
       * 原先是「按日期偏移派生 8~10 张编出来的照片」，图片在两张静态 webp 间轮换、
       * 时刻取自写死的 airTimes。现在照片来自真实媒体，按**拍摄日期**过滤 ——
       * 日期对不上就是没有，不拿别的日期的照片冒充。
       */
      function seedPatrol(dates: string[]): void {
        const patrol = usePatrolStore()
        patrol.apply(
          dates.map((d, i) => ({
            id: `p${i}`,
            name: `${d}.jpeg`,
            url: `https://oss.keehang.com/iot-media/${d}.jpeg`,
            thumbnail: `https://oss.keehang.com/thumbnail/iot/${d}.jpeg`,
            taskName: '向阳村-安全巡检',
            taskId: 4912,
            jobId: 100 + i,
            time: `${d} 09:00:00`,
            size: 1024,
            mediaType: 'image/jpeg',
          })),
        )
      }

      it('只列出拍摄日期与选中日一致的照片', () => {
        seedPatrol(['2026-07-15', '2026-07-14'])
        const air = useAirHazardStore()
        air.airDate = new Date(2026, 6, 15)

        expect(air.airList).toHaveLength(1)
        expect(air.airList[0].time).toBe('09:00')
        expect(air.airList[0].img).toContain('2026-07-15')
      })

      it('日期对不上时为空，不回落任何演示图', () => {
        seedPatrol(['2026-07-15'])
        const air = useAirHazardStore()
        air.airDate = new Date(2026, 6, 1)

        expect(air.airList).toHaveLength(0)
      })

      it('没有任何真实照片时为空（不编造数量）', () => {
        const air = useAirHazardStore()
        expect(air.airList).toHaveLength(0)
      })

      it('airList 随选中日期变化', () => {
        seedPatrol(['2026-07-15', '2026-07-14'])
        const air = useAirHazardStore()
        air.airDate = new Date(2026, 6, 15)
        expect(air.airList).toHaveLength(1)

        air.airDate = new Date(2026, 6, 14)
        expect(air.airList).toHaveLength(1)
        expect(air.airList[0].img).toContain('2026-07-14')
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
      it('openAir 关掉监控与隐患上报并复位日期视图', () => {
        const cam = useCamStore()
        const air = useAirHazardStore()
        cam.isOpen = true
        air.hazardOpen = true
        air.airCalOpen = true
        air.airPopOpen = true

        air.openAir()
        expect(cam.isOpen).toBe(false)
        expect(air.hazardOpen).toBe(false)
        expect(air.airCalOpen).toBe(false)
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
        air.airCalOpen = true
        air.airPopOpen = true
        air.closeAir()
        expect([air.isOpen, air.airCalOpen, air.airPopOpen]).toEqual([false, false, false])

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
