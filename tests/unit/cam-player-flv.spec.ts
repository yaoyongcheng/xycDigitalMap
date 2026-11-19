import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * 监控层 · 直播流接线（FLV）
 *
 * 引擎自己的时序在 `flv-stream.spec.ts` 里钉；这里只钉**组件怎么用它**：
 *   · 打开层就自动起流（不用先点一下），关层立刻释放；
 *   · 切点位先把旧连接收掉，再按新地址起；
 *   · 重连期间画面退回快照，但 `<video>` 元素不销毁；
 *   · 进后台先挂起、回前台续播，停留过久才释放；
 *
 * 清单在用例里返回 null（= 没取到），地址靠点位自带的 `stream` 注入，
 * 这样既能走到真实的 `playUrl → playMode → 引擎` 这条链，又不打网络。
 */
vi.mock('@/api/cctv', () => ({
  loadMonitorList: async () => null,
  findMonitorEntry: () => undefined,
  pickStreamUrl: () => '',
}))

/**
 * 地址这一层压成空串，让「有没有流」完全由点位 `stream` 字段决定。
 *
 * 为什么：本文件测的是「组件 ↔ 引擎」的接线，需要能精确构造「有流」和「没流」
 * 两种点位。若走默认真实拼法（每个通道都有 9092 的 FLV），就没有「没流」这种
 * 情况可测了。真实拼法由 `cctv.spec` 钉，`playUrl` 的优先级由 `stores.spec` 钉。
 */
vi.mock('@/data/cctv', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/cctv')>()
  return { ...real, cctvPlayableUrl: () => '' }
})

const mock = vi.hoisted(() => {
  interface FakePlayer {
    media: { type: string; isLive: boolean; url: string }
    loaded: number
    played: number
    paused: number
    unloaded: number
    detached: number
    destroyed: number
    handlers: Record<string, Array<() => void>>
    on(ev: string, cb: () => void): void
    emit(ev: string): void
  }

  const state = {
    created: [] as FakePlayer[],
    reset() {
      state.created.length = 0
    },
  }

  function make(media: FakePlayer['media']): FakePlayer {
    const p: FakePlayer = {
      media,
      loaded: 0,
      played: 0,
      paused: 0,
      unloaded: 0,
      detached: 0,
      destroyed: 0,
      handlers: {},
      on(ev, cb) {
        ;(p.handlers[ev] ||= []).push(cb)
      },
      emit(ev) {
        for (const cb of p.handlers[ev] || []) cb()
      },
    }
    return p
  }

  return { state, make }
})

vi.mock('mpegts.js', () => ({
  default: {
    isSupported: () => true,
    createPlayer: (media: { type: string; isLive: boolean; url: string }) => {
      const p = mock.make(media)
      mock.state.created.push(p)
      return {
        ...p,
        on: p.on,
        attachMediaElement: () => undefined,
        play: () => {
          p.played += 1
          return Promise.resolve()
        },
        pause: () => {
          p.paused += 1
        },
        unload: () => {
          p.unloaded += 1
        },
        detachMediaElement: () => {
          p.detached += 1
        },
        destroy: () => {
          p.destroyed += 1
        },
        load: () => {
          p.loaded += 1
        },
        emit: p.emit,
      }
    },
    Events: { ERROR: 'mpegts-error', LOADING_COMPLETE: 'mpegts-loading-complete' },
  },
}))

import CamPlayer from '@/components/overlays/CamPlayer.vue'
import { CAM_POINTS } from '@/data/cams'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'

const LIVE = CAM_POINTS[0]
const FLV = 'http://gw.test/rtp/42010500441188000001_34020000001320000003.live.flv'

function imgResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    blob: async () => new Blob([new Uint8Array(512)], { type: 'image/jpeg' }),
  } as unknown as Response
}

describe('components/overlays/CamPlayer · 直播流接线', () => {
  let wrapper: VueWrapper
  let cam: ReturnType<typeof useCamStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.expiresAt = Date.now() + 3_600_000
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse()))
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:cam/1')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    mock.state.reset()
    LIVE.stream = FLV
    cam = useCamStore()
  })

  afterEach(() => {
    wrapper?.unmount()
    delete LIVE.stream
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function open(): Promise<void> {
    wrapper = mount(CamPlayer)
    await nextTick()
    cam.openCam()
    await flushPromises()
    await nextTick()
    await nextTick()
  }

  const player = () => mock.state.created[mock.state.created.length - 1]

  it('打开层自动起流：地址取自清单解析结果，并先挂快照当 poster', async () => {
    await open()

    expect(mock.state.created).toHaveLength(1)
    expect(player().media).toEqual({ type: 'flv', isLive: true, url: FLV })
    expect(player().loaded).toBe(1)

    // 连流中：先看快照，说明条写清在干什么（不是「不可用」）
    expect(wrapper.find('#camPlayerFrame').classes()).not.toContain('is-veiled')
    expect(wrapper.find('#camStamp').text()).toBe('正在连接现场画面…')
    // 有可播地址就不该再露 RTSP 行
    expect(wrapper.find('#camRtspRow').exists()).toBe(false)
    // 连流中不画播放键：引擎正在起流，摆一颗只会挡画面、招连点
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
  })

  it('出画面后切到直播画面，说明条写「直播中」', async () => {
    await open()

    wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
    await nextTick()

    expect(wrapper.find('#camPlayerVideo').classes()).not.toContain('is-veiled')
    expect(wrapper.find('#camPlayerFrame').classes()).toContain('is-veiled')
    expect(wrapper.find('#camStamp').text()).toBe('现场画面 · 直播中')
    // 播放中同样不画（不遮画面，也不让人以为是暂停键）
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
  })

  it('断流先回落快照并自动重连，<video> 元素不销毁（保住解码管线）', async () => {
    await open()
    wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
    await nextTick()

    player().emit('mpegts-error')
    await nextTick()

    expect(player().destroyed).toBe(1) // 旧连接收掉了
    expect(wrapper.find('#camPlayerVideo').exists()).toBe(true)
    expect(wrapper.find('#camPlayerVideo').classes()).toContain('is-veiled')
    expect(wrapper.find('#camPlayerFrame').classes()).not.toContain('is-veiled')
    expect(wrapper.find('#camStamp').text()).toContain('重连')
  })

  it('播放中与重连中都不出现播放键（不遮画面，也不招人反复点）', async () => {
    await open()
    wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
    await nextTick()
    expect(cam.playState).toBe('playing')
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)

    player().emit('mpegts-error')
    await nextTick()
    expect(cam.playState).toBe('reconnecting')
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
    expect(wrapper.find('#camStamp').text()).toContain('重连')
  })

  /* ---------------- 点画面：只加不减（2026-11-18 三改） ---------------- */

  it('播放中点画面不会暂停直播（引擎的 pause 一次都不调）', async () => {
    await open()
    wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
    await nextTick()
    expect(cam.playState).toBe('playing')

    // 手机上手指落在画面上，很容易连来几下 —— 这一下以前是「暂停」
    await wrapper.find('#camPlayerStage').trigger('click')
    await wrapper.find('#camPlayerStage').trigger('click')
    await nextTick()

    // 关键：一次 pause 都没发生（这就是「点画面不再暂停」）
    expect(player().paused).toBe(0)
    expect(cam.playState).toBe('playing')
    // 也不重复起流：连接数不变，仍是同一只播放器
    expect(mock.state.created).toHaveLength(1)
    expect(wrapper.find('#camStamp').text()).toBe('现场画面 · 直播中')
  })

  it('重连中点画面什么都不做：不拆连接、不建新连接、不打断重连', async () => {
    await open()
    wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
    await nextTick()

    player().emit('mpegts-error')
    await nextTick()
    expect(cam.playState).toBe('reconnecting')
    const el = wrapper.find('#camPlayerVideo').element
    const before = mock.state.created.length

    // 旧实现在这里会调 retry()：拆掉当前连接再建一条。
    // 那正是「点一下屏幕就重新连接」的来源，现在必须什么都不发生。
    await wrapper.find('#camPlayerStage').trigger('click')
    await flushPromises()
    await nextTick()

    expect(cam.playUrl).toBe(FLV)
    expect(wrapper.find('#camPlayerVideo').element).toBe(el)
    expect(mock.state.created).toHaveLength(before)
    expect(cam.playState).toBe('reconnecting')
  })

  it('被系统暂停：说明条说「恢复中」，引擎原地接着播（不写「已暂停」）', async () => {
    await open()
    const video = wrapper.find('#camPlayerVideo').element as HTMLVideoElement
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    video.dispatchEvent(new Event('playing'))
    await nextTick()
    expect(cam.playState).toBe('playing')

    // 来电 / 锁屏 / 下拉控制中心：元素真的停了
    Object.defineProperty(video, 'paused', { value: true, configurable: true })
    video.dispatchEvent(new Event('pause'))
    await nextTick()

    // 不能写「已暂停」—— 那既误导成用户自己停的，也盖掉「正在恢复」这个事实
    expect(cam.playState).toBe('reconnecting')
    expect(wrapper.find('#camStamp').text()).toContain('恢复')
    // 连接原地保留，等引擎自己 play() 起来
    expect(mock.state.created).toHaveLength(1)
    expect(player().destroyed).toBe(0)
  })

  /* ---------------- 说明条上的重连计数（按机型区分） ---------------- */

  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  /** 安卓手机：和苹果一样不许出现次数 */
  const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
  /** 桌面：保留引擎原话（排查要看第几次、几秒后） */
  const WINDOWS_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

  function withUa<T>(ua: string, fn: () => Promise<T>): Promise<T> {
    const original = window.navigator.userAgent
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
    return fn().finally(() => {
      Object.defineProperty(window.navigator, 'userAgent', {
        value: original,
        configurable: true,
      })
    })
  }

  it('苹果手机：说明条只说「正在自动重连」，不出现次数 / 倒计时', async () => {
    await withUa(IPHONE_UA, async () => {
      await open()
      wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
      await nextTick()

      player().emit('mpegts-error')
      await nextTick()

      const text = wrapper.find('#camStamp').text()
      // 原因留着（断流了），但在重连这件事也要说
      expect(text).toContain('自动重连')
      expect(text).not.toMatch(/\d+\s*(?:次|秒)/)
      expect(text).not.toMatch(/\d+\s*\/\s*\d+/)
      // 状态与画面处理不变：仍是重连中、仍回落快照
      expect(cam.playState).toBe('reconnecting')
      expect(wrapper.find('#camPlayerVideo').classes()).toContain('is-veiled')
    })
  })

  it('安卓手机：同样不出现次数 / 倒计时（不是只对苹果特判）', async () => {
    await withUa(ANDROID_UA, async () => {
      await open()
      wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
      await nextTick()

      player().emit('mpegts-error')
      await nextTick()

      const text = wrapper.find('#camStamp').text()
      expect(text).toContain('自动重连')
      expect(text).not.toMatch(/\d+\s*(?:次|秒)/)
      expect(text).not.toMatch(/\d+\s*\/\s*\d+/)
      expect(cam.playState).toBe('reconnecting')
    })
  })

  it('桌面：说明条保留引擎原话（能看见第几次、几秒后，排查要用）', async () => {
    await withUa(WINDOWS_UA, async () => {
      await open()
      wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
      await nextTick()

      player().emit('mpegts-error')
      await nextTick()

      const text = wrapper.find('#camStamp').text()
      expect(text).toMatch(/\d+\s*秒后自动重连/)
      expect(text).toMatch(/（1\/3）/)
    })
  })

  it('重连成功自动续播，地址始终是同一路（不换源）', async () => {
    await open()
    wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
    await nextTick()

    vi.useFakeTimers()
    try {
      player().emit('mpegts-error')
      await vi.advanceTimersByTimeAsync(2_000) // 第一次退避 2s 到点
      expect(mock.state.created).toHaveLength(2)
      expect(player().media.url).toBe(FLV)
      expect(player().played).toBe(1) // 连上就自动播，不用人等
    } finally {
      vi.useRealTimers()
    }

    wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
    await nextTick()
    expect(cam.playState).toBe('playing')
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
  })

  it('关层立刻释放连接，不在后台继续拉流', async () => {
    await open()
    const p = player()

    cam.closeCam()
    await flushPromises()
    await nextTick()

    expect(p.destroyed).toBe(1)
    expect(p.unloaded).toBe(1)
    expect(cam.playState).toBe('idle')
  })

  it('切到没有流的点位：旧连接收掉，不再新建', async () => {
    await open()
    const p = player()

    cam.applyCam(CAM_POINTS[1].channelId)
    await flushPromises()
    await nextTick()

    expect(p.destroyed).toBe(1)
    expect(mock.state.created).toHaveLength(1)
    // 没流就回到「只有 RTSP」的说明
    expect(wrapper.find('#camRtspRow').exists()).toBe(true)
  })

  it('进后台先挂起（不销毁连接），回前台同一只播放器续播', async () => {
    await open()
    wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
    await nextTick()
    const p = player()
    const playedBefore = p.played

    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await nextTick()
    // 短暂离开（下拉控制中心 / 锁屏）只暂停：连接还在，回来不用重建
    expect(p.paused).toBe(1)
    expect(p.destroyed).toBe(0)

    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    await nextTick()

    expect(mock.state.created).toHaveLength(1)
    expect(p.played).toBeGreaterThan(playedBefore)
    expect(player().media.url).toBe(FLV)
  })

  it('后台停留超过 30s 才真正释放连接（省流量），回前台再重连', async () => {
    await open()
    wrapper.find('#camPlayerVideo').element.dispatchEvent(new Event('playing'))
    await nextTick()
    const p = player()

    vi.useFakeTimers()
    try {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await nextTick()
      expect(p.destroyed).toBe(0)

      await vi.advanceTimersByTimeAsync(31_000)
      expect(p.destroyed).toBe(1)
      expect(cam.playState).toBe('idle')
    } finally {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      vi.useRealTimers()
    }
  })
})
