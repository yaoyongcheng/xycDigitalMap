/**
 * HTTP-FLV 播放引擎（mpegts.js → MSE）
 *
 * 监控页的直播画面走这里。写成不依赖 Vue 的纯类，是因为它管的是一串
 * **必须成对出现**的副作用：连流 → 挂到 `<video>` → 出错 → 收掉 → 再连。
 * 这种时序放在组件里，很容易出现「销毁了但定时器还在」「重连后旧回调改歪新状态」
 * 之类的幽灵 bug，而这些恰恰是现场「画面黑着不动」的主因。
 *
 * ## 职责边界
 *
 * 这里只做四件事，**不碰 UI，也不碰业务状态**：
 *   1. **拉流**：动态 import mpegts.js（200KB+，只有真要看画面才下载），
 *      `createPlayer → attachMediaElement → load → play`；
 *   2. **状态**：把「连接中 / 出画面 / 缓冲 / 暂停 / 重连中 / 失败」通过
 *      `onState` 抛给调用方，组件再写进 store —— 状态只有一份，不在两处各记一套；
 *   3. **异常与重试**：见下节；
 *   4. **释放**：`stop()` / `destroy()` 一定 `pause → unload → detach → destroy`，
 *      并清掉定时器、作废旧回调。关掉监控层、切点位、页面进后台都走这里。
 *
 * ## 重试策略（2026-11-18 改：无限重连，打开着就一直连）
 *
 * 现场的流是 ZLMediaKit **按需拉流**：同一通道隔几分钟会在 404 / 200 之间翻转，
 * 网关重启、工地网络抖一下都会断。旧的「3 次之后报错停手」有两个真实代价：
 *   · 人离开一会儿回来，画面永远停在一张旧快照上，必须手动点一下才回来；
 *   · 上游流刚起来那几秒正好撞在退避窗口外，明明能播却显示「不可用」。
 *
 * 现在**不设重试上限**，分两档节奏：
 *   · **快速段**：2s / 4s / 6s 三次退避，说明条带次数与倒计时；
 *   · **持续段**：之后每 10 秒一次，一直试到流回来或用户关掉画面。
 *     连续失败达到快速段次数时，把话说清楚一次（「已连续重试 3 次，正在持续
 *     自动重连」），然后不再每轮刷屏 —— 状态始终是 `reconnecting`，
 *     不是 `error`：这不叫失败，叫「还没连上」。
 *
 * 重连**只重连当前这一路地址**，绝不换源；成功（`playing`）即自动续播。
 * 只有两种「真停」：用户关掉监控层（`stop`/`destroy`），或浏览器根本没有 MSE —
 * 后者重试一万次也没用，如实报 `error`。
 *
 * ## 两条恢复通道（2026-11-19 补）
 *
 * 「画面没在动」有两种，处理方式完全不同；混在一起就是现场那句
 * 「断了得点一下屏幕才回来」：
 *
 * | 现象 | 典型原因 | 走哪条 |
 * | --- | --- | --- |
 * | 连接真的断了 | 网络抖动、网关重启、ZLM 按需拉流 404 | `fail()` → 2/4/6s → 每 10s，**不设上限** |
 * | 连接还在、只是停着 | 来电/锁屏/切后台/低电量把 `<video>` 暂停；自动播放被策略拒绝 | `scheduleResume()` → 只重试 `play()`，1/2/3/4s 封顶 5s |
 *
 * 两条通道的分界只有一句：**「自动播放被拒」不等于「用户不想看」**。
 * 旧实现在 `play()` 被拒时把 `wantPlay` 置 false，`fail()` 随即早退，
 * 此后断流不再重连；而界面上又没有恢复动作 —— 于是只能靠人手点一下。
 * 现在 `wantPlay` 只由 `pause()` / `stop()` 改，策略拒绝只记「暂时受阻」。
 *
 * 恢复通道连续失败 `resumeMaxTries`（默认 4）次会转去重连：那时多半已经不是
 * 「暂停」，而是解码管线废了。重连本身仍然无限，所以整体依然「永不放弃」。
 * 另外 `suspend()` / `resume()` 给页面切换前后台用：暂停播放但保留连接与意图，
 * 回来立刻续上，不重建、不黑屏、不需要手势。
 *
 * ## 三个容易做错的地方
 *
 * 1. **用户意图优先**：`wantPlay` 记住「用户是想看的还是自己按了暂停」。
 *    重连成功后只有想看的才自动播；用户暂停了再断流，就不该偷偷拉起来，
 *    也不该在后台一轮轮重连烧流量。
 * 2. **不并发建实例**：`start / play / retry / 定时重连` 可能同时发生，
 *    `pending` 把并发的 `connect()` 折成同一个 Promise；每次真正建播放器前
 *    都会先 `teardown()` 上一只，保证同一时刻只有一个 mpegts 实例挂在 `<video>` 上。
 *    否则现场表现是「一会儿有画面一会儿黑」，实际是两个播放器在抢同一个元素。
 * 3. **卡死也要判**：网络断在一半时，mpegts 不一定报 ERROR、也不会 LOADING_COMPLETE，
 *    连接就挂在那儿。所以出过画面之后还有一个看门狗：`idleTimeout` 内没有新数据
 *    （`timeupdate` / `progress`）就按断流处理，走同一套重连。
 *
 * ## 为什么不是复用 LivePlayer.vue
 *
 * 无人机那套（`components/ui/LivePlayer.vue`）语义不同：它面对的是「还没起飞」，
 * 需要 `offair` 态 + 点播按钮，而且它把播放器绑在自己的模板里。
 * 监控页需要的是「回落快照 + 由外部统一控制播放/暂停 + 不重复建实例」，
 * 硬套会把两边都拧巴。两者共用的是同一种「mpegts + MSE + 追帧参数」的写法，
 * 这里已经按无人机链路验证过的参数取值。
 *
 * ## V2 对照
 *
 * V2（Unity）里对应的是 `UIPopCCTV.CheckUrlMode` + `PlayFlv` 与
 * `VideoPlayerProgressController`（视频加载中 / 缓冲中 / 加载失败）。
 * 差异在于 V2 跑在桌面端，RTSP 也能播，还有本地 ffmpeg + mediamtx 兜底；
 * 浏览器没有这些能力，所以这里只认 HTTP-FLV，其余交给页面说清楚。
 */

/** 播放状态（与组件无关的语义状态） */
export type FlvState =
  /** 没地址 / 已主动停掉 */
  | 'idle'
  /** 刚开始连流、还没出画面 */
  | 'connecting'
  /** 真的出画面了（`<video>` 的 playing 事件，不是 play() 的 resolve） */
  | 'playing'
  /** 出过画面后卡住等数据 */
  | 'buffering'
  /** 暂停（用户点的，或自动播放被策略拦下） */
  | 'paused'
  /** 断了，正在按退避重连（**会一直重试，直到流回来或画面被关掉**） */
  | 'reconnecting'
  /** 环境不支持 / 不可恢复：只有这种情况才停手（例如浏览器没有 MSE） */
  | 'error'

/** mpegts.js 的最小接口，避免把整个 d.ts 拖进类型推导 */
export interface MpegtsPlayerLike {
  attachMediaElement(el: HTMLMediaElement): void
  load(): void
  play(): Promise<void> | void
  pause(): void
  unload(): void
  detachMediaElement(): void
  destroy(): void
  on(ev: string, cb: () => void): void
}

/** mpegts.js 模块的最小接口 */
interface MpegtsLike {
  isSupported(): boolean
  createPlayer(
    media: { type: string; isLive: boolean; url: string },
    config: Record<string, unknown>,
  ): MpegtsPlayerLike
  Events: { ERROR: string; LOADING_COMPLETE: string }
}

export interface FlvStreamOptions {
  /** 承载画面的 `<video>`（muted + playsinline，移动端必需） */
  video: HTMLVideoElement
  /** 状态出口；`note` 是给人看的一句话（页面写在画面下方的说明条里） */
  onState: (state: FlvState, note: string) => void
  /**
   * 快速重连几次（默认 3）。
   *
   * **不是上限** —— 次数用完之后转入 `slowRetryDelay` 的持续重连，一直试下去，
   * 直到流回来或画面被关掉。这个数字只决定「前几次有多拼」。
   */
  fastRetries?: number
  /** 连上后多久没出画面算失败（默认 12s） */
  connectTimeout?: number
  /** 快速段退避基数（默认 2000ms，第 n 次 = base × n） */
  retryDelay?: number
  /** 持续段的间隔（默认 10000ms，快速段用完后的「一直试」） */
  slowRetryDelay?: number
  /** 出过画面后多久没有新数据算卡死（默认 12000ms；0 = 关掉看门狗） */
  idleTimeout?: number
  /**
   * 恢复播放的节拍（默认 1000ms；第 n 次 = 节拍 × n，封顶 {@link RESUME_CEIL}）。
   *
   * 这条路径只处理「连接还在、只是没在播」——例如 iOS 把 `<video>` 暂停了、
   * 或自动播放被策略拒绝。它与重连是两件事：**不 teardown、不新建播放器、不改地址**。
   */
  resumeDelay?: number
  /**
   * 连续恢复播放失败多少次后，判定「不只是暂停，连接也可能废了」，转去重连（默认 4）。
   *
   * 不是上限 —— 转重连之后仍然按 2/4/6s → 每 10s 无限重试，永不放弃。
   */
  resumeMaxTries?: number
  /**
   * 起播时用户是否「想播」（默认 true）。
   * 页面在「用户自己按过暂停」之后重建实例时传 false，别把人暂停的画面又拉起来。
   */
  autoplay?: boolean
}

const DEFAULT_FAST_RETRIES = 3
const DEFAULT_CONNECT_TIMEOUT = 12_000
const DEFAULT_RETRY_DELAY = 2_000
const DEFAULT_SLOW_RETRY_DELAY = 10_000
const DEFAULT_IDLE_TIMEOUT = 12_000
const DEFAULT_RESUME_DELAY = 1_000
/** 恢复播放的退避封顶：再久也不会超过这个间隔，保证断了多久都能在 5s 内试下一次 */
const RESUME_CEIL = 5_000
const DEFAULT_RESUME_MAX_TRIES = 4
/** 看门狗节拍：比 idleTimeout 小一档，卡死判定的误差不超过一个节拍 */
const WATCHDOG_TICK = 2_000

/**
 * 一路 FLV 直播的生命周期。
 *
 * 用法：
 * ```ts
 * const s = new FlvStream({ video, onState })
 * await s.start(url)       // 自动起播
 * s.pause() / s.play()     // 播放键
 * s.retry()                // 手动重连（失败态下点播放键，计数清零立刻连）
 * s.stop()                 // 关层 / 进后台
 * s.destroy()              // 卸载
 * ```
 */
export class FlvStream {
  private readonly video: HTMLVideoElement
  private readonly onState: (state: FlvState, note: string) => void
  private readonly fastRetries: number
  private readonly connectTimeout: number
  private readonly retryDelay: number
  private readonly slowRetryDelay: number
  private readonly idleTimeout: number
  private readonly resumeDelay: number
  private readonly resumeMaxTries: number

  private player: MpegtsPlayerLike | null = null
  private url = ''
  /** 连接序号：每次 connect 递增，旧连接的回调对不上号就自行作废 */
  private seq = 0
  /** 快速段已经重连过几次（出画面后归零） */
  private attempt = 0
  /** 快速段用完 → 转入低频持续重连（这段时间只报错一次，不再刷屏） */
  private slow = false
  /** 是否处于「想播」状态（stop 之后置 false，重连定时器据此自我取消） */
  private started = false
  /**
   * 用户是不是想看着画面。
   *
   * **只有 `pause()` / `stop()` 会把它置 false**。自动播放被策略拒绝、系统把
   * `<video>` 暂停，都不算「用户不想看」—— 那是环境问题，写在这里会让后续
   * 断流彻底不重连（2026-11-19 修的正是这个）。
   */
  private wantPlay: boolean
  private destroyed = false
  /** 这次连接有没有真出过画面 —— 区分「连不上」与「播着断了」 */
  private hasFrame = false
  /** 释放播放器时 `<video>` 会抛 pause / error，别当成用户操作或故障 */
  private releasing = false
  /** 上一次收到媒体数据的时刻（看门狗用） */
  private lastDataAt = 0
  /** 页面主动挂起（进后台）：暂停播放但保留连接，回来能秒续 */
  private suspended = false
  /** 已经做了几次「恢复播放」尝试；`playing` 一到就归零 */
  private resumeTries = 0

  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private resumeTimer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  /** 正在进行的连接：并发调用折成同一个 Promise，避免同时建两只播放器 */
  private pending: Promise<void> | null = null

  constructor(opts: FlvStreamOptions) {
    this.video = opts.video
    this.onState = opts.onState
    this.fastRetries = Math.max(0, opts.fastRetries ?? DEFAULT_FAST_RETRIES)
    this.connectTimeout = opts.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
    this.retryDelay = opts.retryDelay ?? DEFAULT_RETRY_DELAY
    this.slowRetryDelay = opts.slowRetryDelay ?? DEFAULT_SLOW_RETRY_DELAY
    this.idleTimeout = opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
    this.resumeDelay = Math.max(200, opts.resumeDelay ?? DEFAULT_RESUME_DELAY)
    this.resumeMaxTries = Math.max(1, opts.resumeMaxTries ?? DEFAULT_RESUME_MAX_TRIES)
    this.wantPlay = opts.autoplay ?? true

    this.video.addEventListener('playing', this.handlePlaying)
    this.video.addEventListener('error', this.handleMediaError)
    // 被系统 / 浏览器暂停（来电、锁屏、切后台、低电量、耳机拔出）也要能自己回来。
    // 这条以前没接，直接导致「画面定在最后一帧，必须点一下」。
    this.video.addEventListener('pause', this.handlePause)
    // 有数据流过 = 没卡死；这三条覆盖「首帧」「正常播放」「追帧跳时间」
    this.video.addEventListener('timeupdate', this.handleData)
    this.video.addEventListener('progress', this.handleData)
    this.video.addEventListener('loadeddata', this.handleData)
  }

  /* ---------------- 对外 ---------------- */

  /** 起播（换点位 / 首次打开都走这里；内部会先收掉旧连接） */
  async start(url: string): Promise<void> {
    if (this.destroyed) return
    if (!url) {
      this.stop()
      return
    }
    // 同一路已经在跑（没断、没进持续段）：不重建。组件里的 watcher 会因为
    // 清单晚到、前后台切换等原因重复喊 start，每次都重来一遍的话，
    // 现场看到的是画面反复黑一下，而且两只播放器会抢同一个 `<video>`。
    if (url === this.url && this.player && !this.slow) {
      this.wantPlay = true
      this.suspended = false
      try {
        await this.player.play()
      } catch {
        // 自动播放被拦：不是「用户不想看」，交给恢复通道再试（不重建连接）
        this.scheduleResume()
      }
      return
    }

    this.url = url
    this.started = true
    this.attempt = 0
    this.slow = false

    // 用户按过暂停后重建的实例：连都不连，等他点播放键。省流量，也不制造假状态。
    if (!this.wantPlay) {
      this.seq += 1
      this.clearTimers()
      this.teardown()
      this.emit('paused', '点击播放键开始播放')
      return
    }
    await this.connect(true)
  }

  /** 播放键：没连接就重连，有连接就恢复播放 */
  async play(): Promise<void> {
    if (this.destroyed) return
    this.wantPlay = true
    this.suspended = false
    if (!this.player) {
      this.attempt = 0
      this.slow = false
      this.started = true
      await this.connect()
      return
    }
    try {
      await this.player.play()
    } catch {
      // 自动播放策略拦下 / 被紧随的 pause 打断（AbortError）都不是故障：
      // 真实状态交给 `<video>` 的事件；策略拦下的情况由恢复通道接着试。
      this.scheduleResume()
    }
  }

  /** 暂停（直播流暂停后仍在缓冲，所以要「停播」请用 stop） */
  pause(): void {
    if (this.destroyed) return
    this.wantPlay = false
    this.clearResume()
    if (!this.player) {
      // 正在等退避重连时点了暂停：把重连掐掉，别再一轮轮地试
      this.clearTimers()
      this.emit('paused', '已暂停')
      return
    }
    try {
      this.player.pause()
    } catch {
      /* 已断开时 pause 会抛，忽略 */
    }
  }

  /**
   * 挂起：进后台时用。
   *
   * 与 `pause()` 的区别是**不改播放意图**：连接保留、`wantPlay` 仍是 true，
   * 所以回前台调 `resume()` 能立刻接着播，不需要重建（重建会先黑一下，
   * 还可能被 iOS 的自动播放策略拦住 → 现场就是「回来必须点一下」）。
   */
  suspend(): void {
    if (this.destroyed) return
    this.suspended = true
    this.clearResume()
    try {
      this.player?.pause()
    } catch {
      /* 已断开时 pause 会抛，忽略 */
    }
  }

  /**
   * 取消挂起并恢复播出。
   *
   * 没有播放器（连接被释放 / 断过）时直接重连 —— 重连本身也是无限的，
   * 不需要用户点任何东西。
   */
  resume(): void {
    if (this.destroyed) return
    this.suspended = false
    if (!this.started || !this.wantPlay) return
    if (!this.player) {
      void this.connect()
      return
    }
    void this.play()
  }

  /** 手动重连：失败态下点播放键走这里，计数清零、立刻连（不等退避） */
  retry(): void {
    if (this.destroyed) return
    this.attempt = 0
    this.slow = false
    this.started = true
    this.wantPlay = true
    void this.connect(true)
  }

  /** 主动停止并释放（关层、切到没流的状态） */
  stop(): void {
    this.started = false
    this.wantPlay = false
    this.suspended = false
    this.seq += 1
    this.attempt = 0
    this.slow = false
    this.hasFrame = false
    this.resumeTries = 0
    this.clearTimers()
    this.teardown()
    this.emit('idle')
  }

  /** 彻底销毁：解绑 `<video>` 上的监听，之后这个实例不能再 start */
  destroy(): void {
    this.destroyed = true
    this.stop()
    this.video.removeEventListener('playing', this.handlePlaying)
    this.video.removeEventListener('error', this.handleMediaError)
    this.video.removeEventListener('pause', this.handlePause)
    this.video.removeEventListener('timeupdate', this.handleData)
    this.video.removeEventListener('progress', this.handleData)
    this.video.removeEventListener('loadeddata', this.handleData)
  }

  /* ---------------- 连接 ---------------- */

  /**
   * 单飞：同一时刻只允许一条连接在跑。
   *
   * `force` 是「换地址 / 用户点了重连」—— 必须真的重来，于是把序号推进作废旧的那条，
   * 但新的一条仍然走同一个 `pending` 槽位，不会出现两只播放器同时 attach 到 `<video>`。
   */
  private connect(force = false): Promise<void> {
    if (!force && this.pending) return this.pending
    const p = this.doConnect().finally(() => {
      if (this.pending === p) this.pending = null
    })
    this.pending = p
    return p
  }

  private async doConnect(): Promise<void> {
    const my = ++this.seq
    this.clearTimers()
    this.teardown()

    if (this.destroyed || !this.started || !this.url) {
      this.emit('idle')
      return
    }

    this.hasFrame = false
    // 持续段只连不说：说明条已经写着「已重连 N 次，正在后台继续」，每 10 秒
    // 再刷一次只会闪。成功时 `playing` 自然会把它盖掉。
    if (!this.slow) {
      this.emit(
        this.attempt > 0 ? 'reconnecting' : 'connecting',
        this.attempt > 0
          ? `直播流中断，正在重连（第 ${this.attempt}/${this.fastRetries} 次）`
          : '正在连接现场画面…',
      )
    }

    // 兜底收口：地址通了但上游没推流时，mpegts 不一定会报错，连接就挂在那儿。
    // 没有这个定时器，页面会永远停在「连接中」。
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (my !== this.seq || this.destroyed || !this.started) return
      this.fail('连接超时，未收到画面数据')
    }, this.connectTimeout)

    let mpegts: MpegtsLike
    try {
      mpegts = (await import('mpegts.js')).default as unknown as MpegtsLike
    } catch {
      if (my !== this.seq) return
      this.fail('播放器模块加载失败')
      return
    }
    if (my !== this.seq || this.destroyed || !this.started) return

    if (!mpegts.isSupported()) {
      // 老 iOS（17 以前）没有 MSE，这不是网络问题，重试也没用
      this.clearTimers()
      this.started = false
      this.emit('error', '当前浏览器不支持 MSE，无法播放 FLV 直播')
      return
    }

    const p = mpegts.createPlayer(
      { type: 'flv', isLive: true, url: this.url },
      {
        // 直播要「追帧」而不是攒够再播：默认的 stash 缓冲会累积几秒延迟
        enableStashBuffer: false,
        autoCleanupSourceBuffer: true,
        liveBufferLatencyChasing: true,
        /*
         * 追帧必须有边界（2026-11-19）。
         *
         * 只开 `liveBufferLatencyChasing` 而不给上下限时，网络一抖动它就会为了
         * 「追到最新」反复 seek：画面跳一下、花一下、声音断续 —— 现场反馈的
         * 「播放不连续」有很大一部分来自这里，而不是真的断流。
         * 超过 3s 才追，追到剩 0.5s 停手，避免追过头又回退。
         */
        liveBufferLatencyMaxLatency: 3.0,
        liveBufferLatencyMinRemain: 0.5,
        lazyLoad: false,
      },
    )
    this.player = p

    p.on(mpegts.Events.ERROR, () => {
      if (my !== this.seq || !this.started) return
      this.fail('直播流连接失败')
    })
    p.on(mpegts.Events.LOADING_COMPLETE, () => {
      if (my !== this.seq || !this.started) return
      this.fail('直播流已结束')
    })

    p.attachMediaElement(this.video)
    p.load()

    this.lastDataAt = Date.now()
    this.startWatchdog()

    try {
      await p.play()
      // play() resolve 不代表有画面（数据还没到它也会 resolve），
      // 真出画面以 `<video>` 的 playing 事件为准
    } catch {
      if (my !== this.seq || this.destroyed || !this.started) return
      if (!this.hasFrame) {
        /*
         * 自动播放被策略拒绝（iOS 上元素一旦被系统暂停过，之后无手势必然如此）。
         *
         * **不能**在这里把 `wantPlay` 置 false —— 那等于把「环境拒绝了」记成
         * 「用户不想看」，`fail()` 随后会早退，整条链路从此不再重连。现场症状
         * 就是「画面定住，点一下才回来」。
         *
         * 现在只报「在等恢复」，播放器保持不动（mpegts 仍在缓冲），由 resume
         * 通道自己把它拉起来。
         */
        this.emit('buffering', '等待自动恢复播放')
        this.scheduleResume()
      }
    }
  }

  /**
   * 失败收口：所有异常都从这里出去，只在一处决定「怎么重连」。
   *
   * 先 `seq += 1` 再释放 —— 释放过程中 mpegts / `<video>` 还会抛一串回调，
   * 不先作废序号就会「自己把自己的重连打断」。
   */
  private fail(reason: string): void {
    if (this.destroyed || !this.started) return
    this.seq += 1
    this.clearTimers()
    this.teardown()
    this.hasFrame = false

    // 用户自己按了暂停：他要的是停下来，不是「恢复画面」。别再占带宽。
    if (!this.wantPlay) {
      this.emit('paused', '已暂停')
      return
    }

    if (this.attempt < this.fastRetries) {
      this.attempt += 1
      const delay = this.retryDelay * this.attempt
      this.emit(
        'reconnecting',
        `${reason}，${Math.max(1, Math.round(delay / 1000))} 秒后自动重连（${this.attempt}/${this.fastRetries}）`,
      )
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        if (this.destroyed || !this.started) return
        void this.connect()
      }, delay)
      return
    }

    // 快速段用完：**不停止、不换源**，说清情况一次（不刷屏），转持续重连。
    // 现场是按需拉流，断电/网关重启后没人守着就永远不回来；每 2 秒撞一次也没意义
    // —— 每 10 秒一次，一直试到流回来或画面被关掉。
    // 状态仍是 `reconnecting`（不是 error）：按钮保持隐藏，用户不用去点，
    // 点了也没有额外效果，反而会以为必须靠手点。
    this.slow = true
    const wait = Math.max(1, Math.round(this.slowRetryDelay / 1000))
    this.emit(
      'reconnecting',
      `${reason}（已连续重试 ${this.fastRetries} 次，正在持续自动重连，每 ${wait} 秒一次）`,
    )
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.destroyed || !this.started) return
      void this.connect()
    }, this.slowRetryDelay)
  }

  /* ---------------- 媒体事件 ---------------- */

  /** 真出画面：清超时、重试计数归零、状态交给调用方 */
  private readonly handlePlaying = (): void => {
    if (this.releasing) return
    this.hasFrame = true
    this.attempt = 0
    this.slow = false
    // 恢复成功：清掉恢复节拍与尝试计数，下次真断流重新从 1s 起步
    this.resumeTries = 0
    this.clearResume()
    this.lastDataAt = Date.now()
    this.clearConnectTimer()
    this.emit('playing')
  }

  /**
   * `<video>` 被暂停。
   *
   * 界面上已经没有「暂停」这个动作（点画面不会停播），所以能走到这里的基本只有
   * 系统 / 浏览器干的：来电、锁屏、切后台、低电量模式、拔出耳机、控制中心。
   *
   * 旧实现对此**完全没有反应** —— 画面就定在最后一帧，直到用户点一下才回来。
   * 现在只要还想看就排一次恢复，而且不重建连接（连接多半仍然完好）。
   * `suspended` 是页面自己挂起（进后台），那条路径由 `resume()` 负责，不在这里抢。
   */
  private readonly handlePause = (): void => {
    if (this.releasing || this.destroyed || !this.started) return
    if (this.suspended || !this.wantPlay) return
    if (!this.player || !this.hasFrame) return
    this.scheduleResume()
  }

  /** 有数据流过（看门狗的心跳） */
  private readonly handleData = (): void => {
    this.lastDataAt = Date.now()
  }

  /**
   * `<video>` 自身报错（blob 被撤、解码失败）。
   *
   * 只在已经有 player 时才算数：释放播放器会清 src，此时抛的 error 是我们自己
   * 造成的，不能当成流断了 —— 否则每关一次页面就多一轮「重连」。
   */
  private readonly handleMediaError = (): void => {
    if (this.releasing || !this.started || !this.player) return
    this.fail('视频解码失败')
  }

  /**
   * 卡死看门狗：出过画面之后，`idleTimeout` 内没有新数据就按断流处理。
   *
   * 这是「网络断在一半」的唯一兜底 —— 那种情况下 mpegts 既不报 ERROR
   * 也不 LOADING_COMPLETE，`<video>` 就停在那儿，页面看起来是「画面冻住了」。
   *
   * 两种「暂停」必须分开（2026-11-19 修）：
   *   · 用户主动暂停（`wantPlay === false`）→ 不判、不试，他要的就是停；
   *   · 被系统暂停（`wantPlay === true`）→ **主动恢复播放**。
   *     旧实现在这里直接 return，等于默认「它自己会好」，而实际上永远不会好：
   *     画面定住、看门狗不判、只有用户点一下才动 —— 现场那句
   *     「点屏幕后才重新连接并继续播放」就是从这里来的。
   */
  private readonly checkIdle = (): void => {
    if (this.destroyed || !this.started || !this.player) return
    if (!this.wantPlay || this.suspended) {
      this.lastDataAt = Date.now()
      return
    }
    if (!this.hasFrame) return
    if (this.video.paused) {
      this.scheduleResume()
      this.lastDataAt = Date.now()
      return
    }
    if (Date.now() - this.lastDataAt < this.idleTimeout) return
    this.fail('画面停住了，未收到新画面数据')
  }

  /**
   * 安排一次「恢复播放」。
   *
   * 与重连的本质区别：**不 teardown、不新建播放器、不改 url、不重置重连计数**。
   * 它只做一件事 —— 把已经暂停的 `<video>` 再 `play()` 一次。
   *
   * 这条通道是「点击才恢复」的替代品：被系统暂停的元素、自动播放被策略拒绝的
   * 元素，都靠它自己爬起来。节拍 1s → 2s → 3s → 4s，封顶 5s，不设次数上限
   * （超出 `resumeMaxTries` 只是换一条路：交给 `fail()` 真正重连）。
   */
  private scheduleResume(): void {
    if (this.destroyed || !this.started || !this.wantPlay || this.suspended) return
    if (this.resumeTimer !== null) return
    // 已经在播了（playing 事件可能比这里晚到）：不必排，顺手把计数清掉
    if (!this.video.paused) {
      this.resumeTries = 0
      return
    }
    const delay = Math.min(this.resumeDelay * (this.resumeTries + 1), RESUME_CEIL)
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      if (this.destroyed || !this.started || !this.wantPlay || this.suspended) return
      if (!this.video.paused) {
        this.resumeTries = 0
        return
      }
      const p = this.player
      if (!p) {
        // 播放器已经没了：这不是「暂停」，走真正的重连
        this.fail('直播流中断')
        return
      }
      this.resumeTries += 1
      try {
        void Promise.resolve(p.play()).catch(() => undefined)
      } catch {
        /* 同步抛出也忽略：下一拍继续 */
      }
      if (this.resumeTries >= this.resumeMaxTries) {
        // 连着几次都起不来：解码管线可能已废，交给重连（仍然是无限次）
        this.fail('画面无法恢复播放')
        return
      }
      this.scheduleResume()
    }, delay)
  }

  private clearResume(): void {
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
  }

  /* ---------------- 定时器 / 释放 ---------------- */

  private startWatchdog(): void {
    this.clearWatchdog()
    if (this.idleTimeout <= 0) return
    this.watchdog = setInterval(this.checkIdle, WATCHDOG_TICK)
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private clearTimers(): void {
    this.clearConnectTimer()
    this.clearWatchdog()
    this.clearResume()
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /**
   * 释放 mpegts 播放器。
   *
   * 四步都不能省：`pause` 停掉拉流，`unload` 断开 HTTP 连接，`detachMediaElement`
   * 解除与 `<video>` 的绑定，`destroy` 回收 MSE 的 SourceBuffer。
   * 只做前两步的话，手机上的连接会一直挂着（切一次点位多一根）。
   */
  private teardown(): void {
    const p = this.player
    this.player = null
    if (!p) return
    this.releasing = true
    try {
      p.pause()
    } catch {
      /* 已断开时 pause 会抛，忽略 */
    }
    try {
      p.unload()
      p.detachMediaElement()
      p.destroy()
    } catch {
      /* 释放失败不影响下一次连接 */
    }
    this.releasing = false
  }

  private emit(state: FlvState, note = ''): void {
    this.onState(state, note)
  }
}
