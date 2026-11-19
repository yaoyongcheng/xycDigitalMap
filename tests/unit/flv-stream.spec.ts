import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * HTTP-FLV 引擎（`utils/flvStream.ts`）
 *
 * 这一组钉的是**时序**，不是画面 —— 现场「黑屏不动」几乎都出在这里：
 *   · 连上但上游没推流时，必须靠超时自己收口，不能永远转圈；
 *   · 断了要按退避重连，而且**不设上限**（2/4/6s → 每 10s，直到流回来）；
 *   · 只是被暂停（系统暂停 / 自动播放被拒）时走「恢复播放」，**不重建连接**；
 *   · `stop` / `destroy` 必须把 `pause → unload → detach → destroy` 走全，
 *     并且清掉定时器、作废旧回调；
 *   · 释放过程中 `<video>` 还会抛 error，不能当成「又断了」再重连一轮。
 *
 * mpegts.js 用桩替掉：它的真实行为是「连 HTTP + 解 FLV + 喂 MSE」，
 * 单测里没法也不该真连；这里只验证我们怎么用它。
 */
const mock = vi.hoisted(() => {
  interface FakePlayer {
    media: { type: string; isLive: boolean; url: string }
    attached: HTMLMediaElement | null
    loaded: number
    played: number
    paused: number
    unloaded: number
    detached: number
    destroyed: number
    handlers: Record<string, Array<() => void>>
    on(ev: string, cb: () => void): void
    emit(ev: string): void
    attachMediaElement(el: HTMLMediaElement): void
    load(): void
    play(): Promise<void>
    pause(): void
    unload(): void
    detachMediaElement(): void
    destroy(): void
  }

  function makePlayer(media: FakePlayer['media']): FakePlayer {
    const p: FakePlayer = {
      media,
      attached: null,
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
      attachMediaElement(el) {
        p.attached = el
      },
      load() {
        p.loaded += 1
      },
      play() {
        p.played += 1
        return mock.state.playRejects ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve()
      },
      pause() {
        p.paused += 1
      },
      unload() {
        p.unloaded += 1
      },
      detachMediaElement() {
        p.detached += 1
      },
      destroy() {
        p.destroyed += 1
      },
    }
    return p
  }

  const state = {
    supported: true,
    playRejects: false,
    created: [] as FakePlayer[],
    configs: [] as Array<{ media: unknown; config: Record<string, unknown> }>,
    reset() {
      state.supported = true
      state.playRejects = false
      state.created.length = 0
      state.configs.length = 0
    },
  }

  return { state, makePlayer }
})

vi.mock('mpegts.js', () => ({
  default: {
    isSupported: () => mock.state.supported,
    createPlayer: (media: { type: string; isLive: boolean; url: string }, config: Record<string, unknown>) => {
      mock.state.configs.push({ media, config })
      const p = mock.makePlayer(media)
      mock.state.created.push(p)
      return p
    },
    Events: { ERROR: 'mpegts-error', LOADING_COMPLETE: 'mpegts-loading-complete' },
  },
}))

import { FlvStream, type FlvState } from '@/utils/flvStream'

describe('utils/flvStream', () => {
  let video: HTMLVideoElement
  let states: Array<[FlvState, string]>

  const last = (): [FlvState, string] => states[states.length - 1]
  const latest = () => mock.state.created[mock.state.created.length - 1]

  function make(opts: Partial<ConstructorParameters<typeof FlvStream>[0]> = {}): FlvStream {
    return new FlvStream({
      video,
      onState: (s, n) => states.push([s, n]),
      ...opts,
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mock.state.reset()
    video = document.createElement('video')
    document.body.appendChild(video)
    states = []
  })

  afterEach(() => {
    video.remove()
    vi.useRealTimers()
  })

  it('起播：按 flv/live 配置连接、挂到同一个 video、自动播放', async () => {
    const s = make()
    await s.start('http://gw.test/rtp/a.live.flv')

    expect(mock.state.configs[0].media).toEqual({
      type: 'flv',
      isLive: true,
      url: 'http://gw.test/rtp/a.live.flv',
    })
    // 直播追帧：不能开 stash 缓冲，否则手机上是「延迟十几秒的直播」
    expect(mock.state.configs[0].config).toMatchObject({
      enableStashBuffer: false,
      liveBufferLatencyChasing: true,
    })

    const p = mock.state.created[0]
    expect(p.attached).toBe(video)
    expect(p.loaded).toBe(1)
    expect(p.played).toBe(1)
    expect(states[0][0]).toBe('connecting')

    // play() resolve 不算「在播」，真出画面是 playing 事件
    video.dispatchEvent(new Event('playing'))
    expect(last()).toEqual(['playing', ''])
  })

  it('连上但没数据：超时算失败并进入重连，不会永远转圈', async () => {
    const s = make({ connectTimeout: 12_000, retryDelay: 2_000 })
    await s.start('u')

    await vi.advanceTimersByTimeAsync(11_999)
    expect(last()[0]).toBe('connecting')

    await vi.advanceTimersByTimeAsync(1)
    expect(last()[0]).toBe('reconnecting')
    expect(last()[1]).toContain('连接超时')
  })

  it('mpegts 报错：收掉旧连接，按 2s 退避重连', async () => {
    const s = make({ retryDelay: 2_000 })
    await s.start('u')
    const first = mock.state.created[0]

    first.emit('mpegts-error')
    expect(first.destroyed).toBe(1)
    expect(first.unloaded).toBe(1)
    expect(last()[0]).toBe('reconnecting')
    expect(last()[1]).toContain('1/3')

    await vi.advanceTimersByTimeAsync(1_999)
    expect(mock.state.created).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mock.state.created).toHaveLength(2)
    expect(latest().loaded).toBe(1)
  })

  it('出过画面后计数归零：偶发一断只算第一次重连', async () => {
    const s = make({ retryDelay: 1_000 })
    await s.start('u')

    // 连断两轮，攒到第 2 次
    mock.state.created[0].emit('mpegts-error')
    await vi.advanceTimersByTimeAsync(1_000)
    mock.state.created[1].emit('mpegts-error')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mock.state.created).toHaveLength(3)

    // 这一轮真出画面了
    video.dispatchEvent(new Event('playing'))
    expect(last()[0]).toBe('playing')

    // 再断：计数从 0 重新开始，提示仍是 1/3
    latest().emit('mpegts-error')
    expect(last()[1]).toContain('1/3')
  })

  it('快速重试用完不停：说清情况后持续重连（不设上限），流回来自动续播', async () => {
    const s = make({ retryDelay: 100, slowRetryDelay: 5_000, connectTimeout: 300 })
    await s.start('u')

    for (let i = 0; i < 20 && !last()[1].includes('已连续重试'); i += 1) {
      latest().emit('mpegts-error')
      await vi.advanceTimersByTimeAsync(400)
    }

    // ① 明确提示：几次、还在连、什么节奏（这是「多次失败后的交代」）
    expect(last()[0]).toBe('reconnecting')
    expect(last()[1]).toContain('已连续重试 3 次')
    expect(last()[1]).toContain('持续自动重连')

    // ② 不停止也不换源：同一个地址一轮轮继续连
    const n = mock.state.created.length
    await vi.advanceTimersByTimeAsync(5_300)
    expect(mock.state.created.length).toBeGreaterThan(n)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mock.state.created.length).toBeGreaterThan(n + 2)
    expect(mock.state.created.every((p) => p.media.url === 'u')).toBe(true)

    // ③ 流回来了就自动恢复播出（不需要用户点任何东西）
    video.dispatchEvent(new Event('playing'))
    expect(last()).toEqual(['playing', ''])
  })

  it('用户自己暂停后断流：不再重连，也不偷偷拉起来', async () => {
    const s = make({ retryDelay: 1_000 })
    await s.start('u')
    video.dispatchEvent(new Event('playing'))

    s.pause()
    latest().emit('mpegts-error')

    expect(last()[0]).toBe('paused')
    await vi.advanceTimersByTimeAsync(120_000)
    // 一条新连接都没建：暂停是他要的，占带宽没意义
    expect(mock.state.created).toHaveLength(1)
  })

  it('暂停中点的重连被掐掉：不会留一颗定时器在后台连', async () => {
    const s = make({ retryDelay: 5_000 })
    await s.start('u')
    latest().emit('mpegts-error')
    expect(last()[0]).toBe('reconnecting')

    s.pause()
    expect(last()[0]).toBe('paused')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mock.state.created).toHaveLength(1)
  })

  it('卡死看门狗：出过画面后长时间没有新数据，按断流重连', async () => {
    const s = make({ idleTimeout: 12_000, retryDelay: 1_000 })
    await s.start('u')
    // 假 DOM 的 video 默认是 paused，这里装成真在播
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    video.dispatchEvent(new Event('playing'))

    await vi.advanceTimersByTimeAsync(6_000)
    expect(last()[0]).toBe('playing')

    // 有数据流过就重新计时（追帧会不断 timeupdate）
    video.dispatchEvent(new Event('timeupdate'))
    await vi.advanceTimersByTimeAsync(6_000)
    expect(last()[0]).toBe('playing')

    // 连续 12s 没有新数据 → 判卡死，走同一套重连
    await vi.advanceTimersByTimeAsync(6_000)
    expect(last()[0]).toBe('reconnecting')
    expect(last()[1]).toContain('画面停住了')
  })

  it('重复 start / 重连与退避撞车，都只保留一只播放器（不会两只抢同一个 <video>）', async () => {
    const s = make({ retryDelay: 1_000 })
    await s.start('u')
    expect(mock.state.created).toHaveLength(1)

    // 已经在正常播，再一次 start 同一地址：什么都不做。
    // （组件的 watcher 会因为清单晚到、前后台切换等原因重复喊 start）
    await s.start('u')
    expect(mock.state.created).toHaveLength(1)

    // 断了之后：用户点重连 + 原来那颗退避定时器都在路上，不能各建一只
    latest().emit('mpegts-error')
    s.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.state.created).toHaveLength(2)

    // 旧定时器已经作废，不会多出第三只
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mock.state.created).toHaveLength(2)

    // 不管后面失败多少轮，任何时刻未释放的播放器最多一只
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mock.state.created.filter((p) => p.destroyed === 0).length).toBeLessThanOrEqual(1)
  })

  it('浏览器没有 MSE：直接报错，既不建播放器也不重试', async () => {
    mock.state.supported = false
    const s = make()
    await s.start('u')

    expect(mock.state.created).toHaveLength(0)
    expect(last()[0]).toBe('error')
    expect(last()[1]).toContain('MSE')
  })

  it('自动播放被拦：自己反复恢复播放，不判成「待点击」也不重建连接', async () => {
    mock.state.playRejects = true
    const s = make({ resumeDelay: 100, resumeMaxTries: 10 })
    await s.start('u')

    // 旧实现这里会 emit('paused') 并把 wantPlay 置 false，从此再也不重连
    expect(last()[0]).toBe('buffering')
    expect(last()[1]).toContain('恢复')

    // 过几拍：一直在试 play，但连接还是原来那一条（不 teardown、不新建）
    const created = mock.state.created.length
    const p = latest()
    await vi.advanceTimersByTimeAsync(700)
    expect(p.played).toBeGreaterThan(1)
    expect(mock.state.created).toHaveLength(created)
    expect(p.destroyed).toBe(0)

    // 策略放行（用户点了一下 / 系统解除限制）后自己就播了
    mock.state.playRejects = false
    await vi.advanceTimersByTimeAsync(600)
    video.dispatchEvent(new Event('playing'))
    expect(last()[0]).toBe('playing')
  })

  it('被系统暂停后自己恢复：不重建连接、不换源，也不显示成「已暂停」', async () => {
    const s = make({ resumeDelay: 100, resumeMaxTries: 10 })
    await s.start('u')
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    video.dispatchEvent(new Event('playing'))

    const p = latest()
    const playedBefore = p.played

    // 来电 / 锁屏 / 控制中心：<video> 抛 pause，元素真的停了
    Object.defineProperty(video, 'paused', { value: true, configurable: true })
    video.dispatchEvent(new Event('pause'))

    await vi.advanceTimersByTimeAsync(300)
    expect(p.played).toBeGreaterThan(playedBefore) // 主动 play 了一次
    expect(mock.state.created).toHaveLength(1) // 没有重建连接
    expect(p.unloaded).toBe(0)
    expect(last()[0]).toBe('playing') // 状态没退化成 paused

    // 恢复后清掉恢复计数：下一次真断流仍从 1s 起步
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    video.dispatchEvent(new Event('playing'))
    expect(last()[0]).toBe('playing')
  })

  it('恢复播放连续失败：转去重连，仍然不设上限', async () => {
    mock.state.playRejects = true
    const s = make({ resumeDelay: 100, resumeMaxTries: 2, retryDelay: 100 })
    await s.start('u')

    await vi.advanceTimersByTimeAsync(900)
    // 中途一定经过「无法恢复播放 → 转重连」这个判定（之后可能已经在下一条连接的
    // 缓冲里，所以不能只断言最后一帧）
    expect(states.some(([st, n]) => st === 'reconnecting' && n.includes('无法恢复播放'))).toBe(true)

    // 转重连之后照旧一直试（这里只验还有新连接被建出来）
    const n = mock.state.created.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mock.state.created.length).toBeGreaterThan(n)
  })

  it('挂起再恢复：连接保持原样，回前台直接续播', async () => {
    const s = make({ resumeDelay: 100 })
    await s.start('u')
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    video.dispatchEvent(new Event('playing'))
    const p = latest()

    s.suspend()
    expect(p.paused).toBe(1)

    // 挂起期间看门狗不该折腾：过了 idleTimeout 也不重连
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mock.state.created).toHaveLength(1)
    expect(p.destroyed).toBe(0)

    s.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(p.played).toBeGreaterThan(1)
    expect(mock.state.created).toHaveLength(1)
  })

  it('stop：四步释放并清定时器，之后不再重连', async () => {
    const s = make({ retryDelay: 1_000 })
    await s.start('u')
    const p = mock.state.created[0]

    s.stop()

    expect([p.paused, p.unloaded, p.detached, p.destroyed]).toEqual([1, 1, 1, 1])
    expect(last()[0]).toBe('idle')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mock.state.created).toHaveLength(1)
  })

  it('destroy：解绑 <video> 监听，之后的 error 与 start 都不再起作用', async () => {
    const s = make()
    await s.start('u')
    s.destroy()

    const n = states.length
    video.dispatchEvent(new Event('error'))
    expect(states.length).toBe(n)

    await s.start('u')
    expect(mock.state.created).toHaveLength(1)
  })

  it('重连期间用户手动重试：计数清零，立刻重连而不是等退避', async () => {
    const s = make({ retryDelay: 5_000 })
    await s.start('u')
    latest().emit('mpegts-error')
    expect(last()[0]).toBe('reconnecting')

    s.retry()
    await vi.advanceTimersByTimeAsync(0)

    expect(mock.state.created).toHaveLength(2)
    expect(last()[0]).toBe('connecting')

    // 原来那颗「5 秒后重连」的定时器已经作废，不会再多起一路
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mock.state.created).toHaveLength(2)
  })
})
