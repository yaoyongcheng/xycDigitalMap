import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
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

/**
 * FLV 引擎在组件用例里不真跑：happy-dom 没有 MSE，真起流会立刻 `isSupported()` false
 * 并把 `playState` 打成 error，把本文件那些「说明条 / 取图」的断言全带歪。
 * 引擎自己的时序与释放见 `flv-stream.spec.ts`，组件与引擎的接线见 `cam-player-flv.spec.ts`。
 */
vi.mock('@/utils/flvStream', () => ({
  FlvStream: class {
    async start(): Promise<void> {}
    async play(): Promise<void> {}
    pause(): void {}
    retry(): void {}
    stop(): void {}
    destroy(): void {}
  },
}))

/**
 * 本文件测的是「快照侧」的行为（取图、空态、切点位缓存、说明条），
 * 所以把「网关拼出的可播地址」压成空串 —— 这样页面停在快照模式，
 * 断言不被 `<video>` 和 mpegts 干扰。
 *
 * 真实拼法（`http://120.26.34.95:9092/rtp/…live.flv?originTypeStr=rtp_push`）
 * 由 `tests/unit/cctv.spec.ts` 钉住，那里才是地址的归属地。
 */
vi.mock('@/data/cctv', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/cctv')>()
  return { ...real, cctvPlayableUrl: () => '' }
})

import CamPlayer from '@/components/overlays/CamPlayer.vue'
import { CAM_POINTS } from '@/data/cams'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'

/**
 * 视频监控层（2026-11-18 设计稿重做）
 *
 * 这一组钉住五件事，都是「改错了页面也不报错、但现场看到的是错的」那类：
 *   ① 点位只有设计稿圈定的 8 个，分「出入口 / 场内 / 塔吊」三组，顺序照设计稿；
 *   ② 画面区只有控件（播放键 + 刷新 + 全屏），不叠时间戳 / 点位名那种文字标签；
 *   ③ 每次取图都带 `X-API-Key` 与当前 `channelId`，切点位按需取、来回切不重复下；
 *   ④ 取不到图给明确空态 + 重试，绝不挂示意图假装有画面；
 *   ⑤ 播放键与媒体状态一致：有流时点画面→play；**播放中再点不 pause**（手机误触
 *      不能把直播停住），状态由 `<video>` 的 play / pause / error 事件驱动，
 *      连点不叠加请求也不重复起流。
 */

const A = CAM_POINTS[0].channelId // 2#门监控1
const B = CAM_POINTS[1].channelId // 2#门监控2

/** 一张「图片」响应：够 api 层校验 content-type 与体积 */
function imgResponse(size = 512): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    blob: async () => new Blob([new Uint8Array(size)], { type: 'image/jpeg' }),
  } as unknown as Response
}

function failResponse(status = 500): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    blob: async () => new Blob([]),
  } as unknown as Response
}

function signIn(): void {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.expiresAt = Date.now() + 3_600_000
}

function stubObjectUrl(): { created: string[]; revoked: string[] } {
  const created: string[] = []
  const revoked: string[] = []
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:cam/${++n}`
    created.push(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
    revoked.push(u)
  })
  return { created, revoked }
}

describe('components/overlays/CamPlayer', () => {
  let wrapper: VueWrapper
  let cam: ReturnType<typeof useCamStore>
  let shell: ReturnType<typeof useShellStore>
  let urls: { created: string[]; revoked: string[] }

  beforeEach(() => {
    setActivePinia(createPinia())
    signIn()
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse()))
    // objectURL 统一桩：每次用例从 blob:cam/1 开始，断言「有没有重复建图」才有意义
    urls = stubObjectUrl()
    cam = useCamStore()
    shell = useShellStore()
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function mountPlayer(): Promise<void> {
    wrapper = mount(CamPlayer)
    await nextTick()
  }

  async function open(id?: string): Promise<void> {
    cam.openCam(id)
    await flushPromises()
    await nextTick()
  }

  /* ---------------- 点位列表 ---------------- */

  it('按设计稿分三组渲染 8 个点位，组头数字是组内点位数', async () => {
    await mountPlayer()
    await open()

    const groups = wrapper.findAll('.cam-chip-group')
    expect(groups.map((g) => g.find('h5').text())).toEqual(['出入口4', '场内2', '塔吊2'])

    const chips = wrapper.findAll('.cam-chip')
    expect(chips.map((c) => c.text())).toEqual([
      '2#门监控1',
      '2#门监控2',
      '4#门监控',
      '4#门外监控',
      '地磅全景',
      '钢筋加工棚',
      '2#塔吊',
      '4#塔吊',
    ])
  })

  it('顶栏标题与芯片高亮都跟着当前点位走', async () => {
    await mountPlayer()
    await open()

    expect(wrapper.find('#camPlayerName').text()).toBe(CAM_POINTS[0].name)
    expect(wrapper.find('.cam-chip.on').text()).toBe(CAM_POINTS[0].name)

    await wrapper.findAll('.cam-chip')[4].trigger('click')
    await flushPromises()

    expect(wrapper.find('#camPlayerName').text()).toBe('地磅全景')
    expect(wrapper.find('.cam-chip.on').text()).toBe('地磅全景')
  })

  /* ---------------- 画面区：控件可以叠，文字标签不行 ---------------- */

  it('画面区不叠时间戳 / 点位名，只有图和三颗控件', async () => {
    await mountPlayer()
    await open()

    const stage = wrapper.find('#camPlayerStage')
    expect(stage.find('#camPlayerFrame').exists()).toBe(true)

    // 文字标签（相机 OSD 已刻在图里，点位名在顶栏）一个都不留
    expect(stage.find('.cam-time').exists()).toBe(false)
    expect(stage.find('.cam-pos-tag').exists()).toBe(false)

    // 控件按设计稿就位：右上「历史抓拍」「全屏」。
    // 中央那颗播放键 2026-11-18 撤掉了（打开自动连、断了无限重连，它只会盖画面，
    // 起播/立即重连改由点击画面承担，点画面不暂停）。这里钉死「不再出现」。
    expect(stage.find('#btnCamPlay').exists()).toBe(false)
    expect(stage.find('#camStageActs #btnCamShots').text()).toBe('历史抓拍')
    expect(stage.find('#camStageActs #btnCamLand').text()).toBe('全屏')
  })

  it('画面在图片下方说明「什么时候取到的」，不写拍摄时间', async () => {
    await mountPlayer()
    await open()
    const stamp = wrapper.find('#camStamp').text()
    expect(stamp).toMatch(/^现场画面 · \d{2}:\d{2} 获取$/)
    // 说明在画面区之外，不压在图上
    expect(wrapper.find('#camPlayerStage #camStamp').exists()).toBe(false)
  })

  /* ---------------- 取图 ---------------- */

  it('打开时按当前 channelId 取图，请求带 X-API-Key 且不把密钥放 URL', async () => {
    await mountPlayer()
    await open()

    const spy = fetch as unknown as ReturnType<typeof vi.fn>
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/video/snapshots')
    expect(url).toContain(`channelId=${A}`)
    expect(url).not.toContain('1c7582231acd998de531f61d6cf1127')
    expect((init.headers as Record<string, string>)['X-API-Key']).toBeTruthy()

    expect(wrapper.find('#camPlayerFrame').attributes('src')).toBe('blob:cam/1')
  })

  it('切点位按需取图；切回已取过的点位不再重复请求', async () => {
    await mountPlayer()
    await open()

    const spy = fetch as unknown as ReturnType<typeof vi.fn>
    await wrapper.findAll('.cam-chip')[1].trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(String(spy.mock.calls[1]?.[0])).toContain(`channelId=${B}`)
    expect(urls.created).toEqual(['blob:cam/1', 'blob:cam/2'])

    // 切回第一个：命中缓存，不再请求
    await wrapper.findAll('.cam-chip')[0].trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(wrapper.find('#camPlayerFrame').attributes('src')).toBe('blob:cam/1')
  })

  /* ---------------- 只有 RTSP（V2 现状） ---------------- */

  it('没有可播地址时：渲染 RTSP 地址行，不造假播放态', async () => {
    await mountPlayer()
    await open()

    const row = wrapper.find('#camRtspRow')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('仅 RTSP')
    // 地址与 V2 清单同构：/rtp/{设备编号}_{通道号}?originTypeStr=rtp_push
    expect(row.text()).toContain(`rtp/42010500441188000001_${A}?originTypeStr=rtp_push`)

    // 播不了就不挂 <video>，画面里也不再有播放键（点画面 = 重新取一张）
    expect(wrapper.find('#camPlayerVideo').exists()).toBe(false)
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
    expect(wrapper.find('#camPlayerFrame').exists()).toBe(true)
  })

  /* ---------------- 历史抓拍入口 ---------------- */

  it('「历史抓拍」按钮：相册语义的文案与无障碍描述，位置在画面右上', async () => {
    await mountPlayer()
    await open()

    const btn = wrapper.find('#btnCamShots')
    expect(btn.text()).toBe('历史抓拍')
    expect(btn.attributes('aria-label')).toBe('查看历史抓拍照片')
    expect(btn.attributes('aria-controls')).toBe('camShotsView')
    expect(btn.attributes('aria-expanded')).toBe('false')
    // 图标是相册，不是刷新箭头
    expect(btn.find('svg').exists()).toBe(true)
  })

  it('点「历史抓拍」切到抓拍视图：画面视图让位，空态说清原因', async () => {
    await mountPlayer()
    await open()

    expect(wrapper.find('#camShotsView').classes()).toContain('hide')

    await wrapper.find('#btnCamShots').trigger('click')
    await flushPromises()
    await nextTick()

    expect(cam.shotsOpen).toBe(true)
    expect(wrapper.find('#camShotsView').classes()).not.toContain('hide')
    expect(wrapper.find('#camLiveView').classes()).toContain('hide')
    expect(wrapper.find('#btnCamShots').attributes('aria-expanded')).toBe('true')

    // 标题条照设计稿
    expect(wrapper.find('.cam-shots-hd strong').text()).toBe('历史抓拍')
    expect(wrapper.find('.cam-shots-hd span').text()).toBe('每天 3 张，点开查看照片')

    // 还没有数据：给空态，不摆示意图、不塞示例照片
    const empty = wrapper.find('[data-empty="cam-shots"]')
    expect(empty.text()).toContain('暂无历史抓拍')
    expect(empty.text()).toContain('接口尚未接入')
    expect(wrapper.findAll('.cam-shot')).toHaveLength(0)
    expect(wrapper.findAll('.cam-day')).toHaveLength(0)
  })

  it('历史抓拍视图里返回键先回画面，再按才关层', async () => {
    await mountPlayer()
    await open()
    await wrapper.find('#btnCamShots').trigger('click')
    await flushPromises()

    await wrapper.find('#btnCamBack').trigger('click')
    await nextTick()
    expect(cam.shotsOpen).toBe(false)
    expect(cam.isOpen).toBe(true)
    expect(wrapper.find('#camLiveView').classes()).not.toContain('hide')

    await wrapper.find('#btnCamBack').trigger('click')
    await flushPromises()
    expect(cam.isOpen).toBe(false)
  })

  it('切点位会退回画面视图（抓拍入口不跨点位停留）', async () => {
    await mountPlayer()
    await open()
    await wrapper.find('#btnCamShots').trigger('click')
    await flushPromises()
    expect(cam.shotsOpen).toBe(true)

    cam.applyCam(CAM_POINTS[1].channelId)
    await flushPromises()
    expect(cam.shotsOpen).toBe(false)
  })

  it('取图失败给明确空态 + 重试，不挂示意图', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failResponse(502)))

    await mountPlayer()
    await open()

    expect(wrapper.find('#camPlayerFrame').exists()).toBe(false)
    const empty = wrapper.find('[data-empty="cam-live"]')
    expect(empty.text()).toContain('画面获取失败')
    expect(empty.text()).toContain('上游视频服务异常')

    // 重试：这次成功，画面换上去
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse()))
    await empty.find('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('#camPlayerFrame').attributes('src')).toBe('blob:cam/1')
  })

  it('切点位时晚到的旧响应不会顶掉新点位', async () => {
    let releaseFirst: (r: Response) => void = () => undefined
    const first = new Promise<Response>((resolve) => {
      releaseFirst = resolve
    })
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        return call === 1 ? first : imgResponse()
      }),
    )

    await mountPlayer()
    cam.openCam()
    await nextTick()

    // 第一个点位还没回来就切到第二个
    await wrapper.findAll('.cam-chip')[1].trigger('click')
    await flushPromises()
    expect(wrapper.find('#camPlayerFrame').attributes('src')).toBe('blob:cam/1')

    // 旧请求现在才回来：不能把画面换成 A
    releaseFirst(imgResponse())
    await flushPromises()
    expect(cam.camId).toBe(B)
    expect(wrapper.find('#camPlayerFrame').attributes('src')).toBe('blob:cam/1')
  })

  it('快照模式下点画面＝重取一帧；取图中连点只发一次请求', async () => {
    let release: (r: Response) => void = () => undefined
    let n = 0
    const fetchSpy = vi.fn(async () => {
      n += 1
      if (n === 1) return imgResponse()
      return new Promise<Response>((res) => {
        release = res
      })
    })
    vi.stubGlobal('fetch', fetchSpy)

    await mountPlayer()
    await open()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // 播放键已撤掉，取帧入口改成点画面
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
    await wrapper.find('#camPlayerStage').trigger('click')
    await nextTick()
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    // 取图中：入口在 busy 上挡着，连点不再堆请求（这就是「重复点击不出异常」）
    await wrapper.find('#camPlayerStage').trigger('click')
    await wrapper.find('#camPlayerStage').trigger('click')
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    release(imgResponse())
    await flushPromises()
    expect(wrapper.find('#camPlayerFrame').attributes('src')).toBe('blob:cam/2')
  })

  /* ---------------- 横屏与返回 ---------------- */

  it('全屏键进横屏，文案随之变成「退出全屏」，再点退出', async () => {
    await mountPlayer()
    await open()

    expect(wrapper.find('#btnCamLand').text()).toBe('全屏')
    await wrapper.find('#btnCamLand').trigger('click')
    await nextTick()

    expect(shell.isLand).toBe(true)
    expect(wrapper.find('#camPlayer').classes()).toContain('is-land')
    expect(wrapper.find('#btnCamLand').text()).toBe('退出全屏')

    await wrapper.find('#btnCamLand').trigger('click')
    await nextTick()
    expect(shell.isLand).toBe(false)
    expect(shell.isLandscape).toBe(false)
    expect(wrapper.find('#btnCamLand').text()).toBe('全屏')
  })

  it('横屏时返回键先退出横屏，再按一次才关层', async () => {
    await mountPlayer()
    await open()
    cam.setCamLand(true)
    await nextTick()

    await wrapper.find('#btnCamBack').trigger('click')
    expect(shell.isLand).toBe(false)
    expect(cam.isOpen).toBe(true)

    await wrapper.find('#btnCamBack').trigger('click')
    await flushPromises()
    expect(cam.isOpen).toBe(false)
  })

  it('关闭后重新打开保持上次选中的点位', async () => {
    await mountPlayer()
    await open()
    await wrapper.findAll('.cam-chip')[5].trigger('click')
    await flushPromises()

    await wrapper.find('#btnCamBack').trigger('click')
    await flushPromises()
    expect(cam.isOpen).toBe(false)

    await open()
    expect(wrapper.find('#camPlayerName').text()).toBe('钢筋加工棚')
    expect(wrapper.find('.cam-chip.on').text()).toBe('钢筋加工棚')
  })

  /* ---------------- 登录守卫 ---------------- */

  it('未登录打开：跳登录页，播放器不打开', async () => {
    useAuthStore().clear()
    await mountPlayer()
    await open()

    expect(useSubpageStore().view).toEqual({ kind: 'login' })
    expect(cam.isOpen).toBe(false)
    expect(wrapper.find('#camPlayer').attributes('hidden')).toBeDefined()
  })

  it('已打开时登录态失效：画面被清掉，不留给下一个人', async () => {
    await mountPlayer()
    await open()
    expect(wrapper.find('#camPlayerFrame').exists()).toBe(true)

    useAuthStore().clear()
    await flushPromises()
    expect(wrapper.find('#camPlayerFrame').exists()).toBe(false)
    expect(cam.state).toBe('idle')
  })
})

/**
 * 播放键 ↔ 视频联动（2026-11-18）
 *
 * 万方媒体服务目前只给定时快照，没有流地址，所以「有流」这条路要靠注入才能测：
 * 第一个点位临时挂一个 `stream`（真实环境走 `VITE_CAM_STREAM_TEMPLATE` 或点位
 * 自带的 `stream`），下面钉住的就是「接上流之后行为必须对」——
 *   · 点一下立刻播当前通道，按钮同步变「暂停」；
 *   · 再点暂停、再点继续，反复点不出错（play() 被打断不是故障）；
 *   · 流打不开就回落快照，不留在黑屏上；
 *   · 切点位把播放态复位，不把上一个通道的「在播」带过来。
 */
describe('components/overlays/CamPlayer · 播放与视频联动', () => {
  const live = CAM_POINTS[0]
  const origPlay = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play')
  const origPause = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause')

  let wrapper: VueWrapper
  let cam: ReturnType<typeof useCamStore>
  let playSpy: ReturnType<typeof vi.fn>
  let pauseSpy: ReturnType<typeof vi.fn>

  /**
   * happy-dom 没有实现 play/pause，这里按真实语义桩掉：改 `paused` + 派发事件。
   * 组件正是听这两个事件来同步按钮的 —— 桩得越像，测的就越接近真机。
   */
  function installMedia(): void {
    playSpy = vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { value: false, configurable: true })
      this.dispatchEvent(new Event('play'))
      return Promise.resolve()
    })
    pauseSpy = vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { value: true, configurable: true })
      this.dispatchEvent(new Event('pause'))
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      value: playSpy,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      value: pauseSpy,
      writable: true,
      configurable: true,
    })
  }

  function restoreMedia(): void {
    if (origPlay) Object.defineProperty(HTMLMediaElement.prototype, 'play', origPlay)
    if (origPause) Object.defineProperty(HTMLMediaElement.prototype, 'pause', origPause)
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    signIn()
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse()))
    stubObjectUrl()
    live.stream = `https://gw.test/live/${live.channelId}.m3u8`
    installMedia()
    cam = useCamStore()
  })

  afterEach(() => {
    wrapper?.unmount()
    restoreMedia()
    delete live.stream
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function open(): Promise<void> {
    wrapper = mount(CamPlayer)
    await nextTick()
    cam.openCam()
    await flushPromises()
    await nextTick()
  }

  it('点画面立刻播当前通道的流，画面里始终没有播放键', async () => {
    await open()

    const video = wrapper.find('#camPlayerVideo')
    expect(video.exists()).toBe(true)
    expect(video.attributes('src')).toBe(live.stream)
    // 有可播地址就不再露 RTSP 行
    expect(wrapper.find('#camRtspRow').exists()).toBe(false)
    // 播放键整颗撤掉：打开自动连、断了无限重连，它只会盖住画面
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)

    await wrapper.find('#camPlayerStage').trigger('click')
    expect(playSpy).toHaveBeenCalledTimes(1)

    await nextTick()
    expect(wrapper.find('#camStamp').text()).toBe('现场画面 · 直播中')
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
  })

  it('被系统暂停后点画面继续播，按钮全程不出现', async () => {
    await open()
    await wrapper.find('#camPlayerStage').trigger('click')
    await nextTick()
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)

    // 系统 / 耳机 / 切后台把播放停了（真实 pause 事件）
    ;(wrapper.find('#camPlayerVideo').element as HTMLVideoElement).pause()
    await nextTick()
    // 暂停态也不摆按钮：再点画面就能继续
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)

    await wrapper.find('#camPlayerStage').trigger('click')
    await nextTick()
    expect(playSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
  })

  it('播放中连点画面不暂停：手机上误触不会把画面停住，也不重复起流', async () => {
    await open()
    const stage = wrapper.find('#camPlayerStage')

    await stage.trigger('click') // 起播
    const video = wrapper.find('#camPlayerVideo').element as HTMLVideoElement
    expect(video.paused).toBe(false)

    // 手机上手指落在画面上最容易来这几下 —— 以前第二下就是 pause，
    // 画面定在最后一帧，看着像卡死
    await stage.trigger('click')
    await stage.trigger('click')
    await nextTick()

    expect(pauseSpy).toHaveBeenCalledTimes(0)
    expect(video.paused).toBe(false)
    expect(cam.playState).toBe('playing')
    // 已经在播就不再叫 play：连点既不暂停，也不重复起流
    expect(playSpy).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1) // 只取过一张 poster，没被点击带出额外请求
    expect(wrapper.find('#camPlayerVideo').attributes('src')).toBe(live.stream)
  })

  it('play() 被紧随的 pause 打断（AbortError）不当作故障', async () => {
    await open()
    playSpy.mockImplementationOnce(() => Promise.reject(
      Object.assign(new Error('The play() request was interrupted'), { name: 'AbortError' }),
    ))

    await wrapper.find('#camPlayerStage').trigger('click')
    await flushPromises()

    // 没有 play 事件 → 状态还是「播放」，没有被误判成出错
    expect(cam.playState).toBe('idle')
    expect(wrapper.find('#camPlayerVideo').exists()).toBe(true)
  })

  it('原生流打不开：先回落快照并说清原因；点画面重连，不自动取快照', async () => {
    await open()

    await wrapper.find('#camPlayerVideo').trigger('error')
    await nextTick()

    // 元素留着、只蒙起来：销毁元素等于丢掉解码管线，重连还得从头建
    expect(wrapper.find('#camPlayerVideo').exists()).toBe(true)
    expect(wrapper.find('#camPlayerVideo').classes()).toContain('is-veiled')
    expect(wrapper.find('#camPlayerFrame').isVisible()).toBe(true)
    expect(wrapper.find('#camPlayerFrame').classes()).not.toContain('is-veiled')
    // 原因说清楚（不再被一句笼统的「不可用」盖掉）
    expect(wrapper.find('#camStamp').text()).toBe('直播流连接失败，已回到定时快照')
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)

    // 再点画面：原生播法换一个 <video> 元素重来，而不是偷偷换成取快照
    const before = wrapper.find('#camPlayerVideo').element
    await wrapper.find('#camPlayerStage').trigger('click')
    await flushPromises()
    expect(wrapper.find('#camPlayerVideo').element).not.toBe(before)
    expect(wrapper.find('#camPlayerVideo').classes()).not.toContain('is-veiled')
    expect(cam.playState).toBe('idle')
  })

  it('切点位把播放态复位，不把「在播」带到新点位', async () => {
    await open()
    await wrapper.find('#camPlayerStage').trigger('click')
    await nextTick()
    expect(cam.playState).toBe('playing')

    await wrapper.findAll('.cam-chip')[1].trigger('click')
    await flushPromises()
    await nextTick()

    expect(cam.playState).toBe('idle')
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
  })
})
