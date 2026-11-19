<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BackBar from '@/components/ui/BackBar.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { FlvStream, type FlvState } from '@/utils/flvStream'
import { isMobileDevice, stripRetryCount } from '@/utils/env'
import { useSlideOverlay } from '@/utils/slideOverlay'

/**
 * 视频监控层（2026-11-18 按设计稿重做）
 *
 * 对应设计稿「视频监控 / 地磅全景」：上方一块画面，下面一条说明，
 * 再下面按「出入口 / 场内 / 塔吊」三组切换点位。
 *
 * ## 画面区上叠了什么（2026-11-18 再按设计稿补按钮）
 *
 * 设计稿 `#camPlayerStage` 里一共三样叠加物，我们只保留按钮，不保留文字：
 *   · `.cam-time`（每秒跳动的时间戳）—— **不要**。相机自己的 OSD 已经把时间
 *     刻在画面里了，再叠一层就是两块表互相打架，而且它挡画面。
 *   · `.cam-pos-tag`（分组 · 点位名）—— **不要**。顶栏标题已经写着当前点位。
 *   · `.cam-play`（中央播放键）+ `.cam-stage-acts`（右上「历史抓拍」「全屏」）——
 *     要，照设计稿的尺寸/圆角/位置还原。它们是**控件**，不是贴在画面上的标签，
 *     只占一圈按钮那么大，看画面时不会挡人挡设备。
 *
 * ## 画面上的点击（2026-11-18 三改）
 *
 * 中央那颗 `.cam-play` 播放键已经整颗撤掉（打开自动连、断了无限重连，它只会盖画面，
 * 还容易被误读成「要点一下才开始」），它的能力挂到画面区本身：
 *   · 有可播地址 → 只做「起播 / 立即重连」，**绝不暂停**（见 `onPlay`）；
 *   · 只有 RTSP（V2 现状）→ 本页只拿得到定时快照，这一下就是「重新拉一帧」。
 *
 * 特别是「点一下就暂停」必须不存在：手机上手指落在画面上多半是误触，
 * 一停画面就定在最后一帧，看着像卡死。
 *
 * 直播流的整套生命周期在 `utils/flvStream.ts`（连流 / 超时 / 无限重连 / 释放），
 * 这里只负责把引擎状态映射进 store，并在「关层、切点位、进后台」时收掉连接。
 * 重连**只连当前这一路地址，绝不换源**；连上就自动续播，进度写在说明条里
 * （手机端这一句不带次数，见 `stampText`）。
 *
 * ## 横屏
 *
 * 复用全站 `shell.isLand` + `shell.isLandscape`（与全屏地图同一套），CSS 里
 * 横屏隐藏顶栏以外的所有装饰，画面 `contain` 完整显示，不裁切。
 */
const cam = useCamStore()
const shell = useShellStore()
const auth = useAuthStore()
const subpage = useSubpageStore()

/** 全屏层转场（进入左滑入 / 返回右滑出），见 utils/slideOverlay.ts */
const playerEl = ref<HTMLElement | null>(null)
const overlay = useSlideOverlay(() => playerEl.value)
watch(() => cam.isOpen, (open) => overlay.syncOpen(open), { flush: 'post' })

/** 顶栏标题 = 当前点位名（设计稿上写的就是「地磅全景」） */
const barTitle = computed(() => cam.current.name)

/* ---------------- 播放（有流播流 / 没流取帧） ---------------- */

const videoEl = ref<HTMLVideoElement | null>(null)

/**
 * 「这一路暂时不行」。
 *
 * 不是判决：FLV 断流时引擎会一直重连（快速三次后退到每 10 秒一次，不设上限），
 * 这期间把画面让给快照，重连成功（playing）就切回来。所以它只决定**谁在上面**。
 */
const streamBroken = ref(false)

/** 有可播地址（FLV / HLS / 原生都能算，判定见 data/cctv.ts 的 streamModeOf） */
const hasStream = computed(() => cam.isLive)

/**
 * 用户此刻「想不想看」。
 *
 * 存在的理由只有一个：断流重连时**别把用户的意图改掉**。
 * 他正在看 → 恢复后接着播；他自己按了暂停 → 恢复后仍是暂停，也别在后台
 * 一轮轮重连烧流量。这个值在重建引擎时通过 `autoplay` 传进去，
 * 所以「进后台再回来」这种换实例的场景也能带上。
 */
const wantPlay = ref(true)

/**
 * 这块屏幕是不是手机 / 平板（判定见 `utils/env.ts` 的 `isMobileDevice`）。
 *
 * 只影响说明条的写法：**手机上不显示「第 N/3 次」「3 秒后」这类计数**，
 * 桌面保留（排查时有用）。与播放、重连无关 —— 两条链路对所有设备完全一致。
 */
const isPhone = isMobileDevice()

/**
 * 画面里那颗播放键还要不要画：**不画**（2026-11-18 三改，按现场要求）。
 *
 * 直播这条链路上它从来没有「非点不可」的时刻：
 *   · 打开就自动连（`startStream` 在挂载/切点位时执行）；
 *   · 断了引擎自己**无限重连**（快速 2/4/6s → 每 10s，直到恢复或关层）；
 *   · 连上自动续播（`wantPlay` 记着用户意图）。
 * 而它一旦出现（尤其 error 态）就会盖住画面中间，还容易被误读成「要点一下才开始」，
 * 所以整颗撤掉。「起播 / 立即重连」这两种能力改由**点击画面**承担
 * （同一个 `onPlay`，见 `onStageClick`）；**暂停不提供** —— 点画面永远不会停掉直播。
 *
 * 保留这个开关而不是把模板那段删掉：万一将来某类设备必须靠一次手势才能起播，
 * 只改这一行就能把按钮放回来。
 */
const showPlayBtn = computed(() => false)

/** 真正把直播画面亮出来：有地址，且当前这一路没被打挂（挂了先看快照） */
const showLive = computed(() => hasStream.value && !streamBroken.value)

/**
 * 「只有 RTSP」：地址拿到了，但浏览器/手机播不了。
 *
 * 这不是错误态 —— V2 桌面端能播（Unity 支持 RTSP，必要时还挂本地 ffmpeg 桥接），
 * 换到浏览器就需要服务端另开 HTTP-FLV 或 HLS。页面把地址原样交出来，
 * 由运维决定怎么开，绝不在这里假装在播。
 */
const onlyRtsp = computed(() => !hasStream.value && cam.playUrl === '' && cam.rtspUrl !== '')

/** 底下的快照还在取 → 播放键转圈（快照模式下这一下发的是取图请求） */
const busy = computed(() => cam.state === 'loading')

/** 播放键是否禁用：只有快照取图中禁用（此时按下去是「重新取一帧」） */
const playDisabled = computed(() => (hasStream.value ? false : busy.value))

/** 播放键此刻的图形：只剩「快照取图中」需要转圈，其余就是三角 */
const playIcon = computed(() => (!hasStream.value && busy.value ? 'is-busy' : ''))

const playLabel = computed(() => {
  if (!hasStream.value) return '重新获取最新画面'
  if (cam.playState === 'paused') return '播放'
  // 走到这里只可能是 error（环境不可恢复）或原生播法还没起播
  return cam.playState === 'error' ? '重新连接直播流' : '播放'
})

/**
 * 切点位：换一条流。
 *
 * 这里只清「这条流挂了」的结论，真正的连接由下面的统一 watcher 收掉旧引擎、
 * 按新地址重起 —— 两处各自起流的话，很容易出现「旧的还在拉、新的也拉」。
 */
watch(
  () => cam.camId,
  () => {
    streamBroken.value = false
    // 换了一台相机就是「我想看这台」：别把上一个点位的暂停意图带过来
    wantPlay.value = true
  },
)

/** 每次打开层都是「我要看」：清掉上次可能留下的暂停意图，重连才有意义 */
watch(
  () => cam.isOpen,
  (open) => {
    if (open) wantPlay.value = true
  },
)

/* ---------------- 直播流：FlvStream 引擎（移动端能播的关键） ---------------- */

/** 当前这一路 FLV 的引擎（HLS / 原生直连不用它，交给 `<video>` 自己） */
let flv: FlvStream | null = null
/** 这个引擎对应的「点位|地址」，以及它挂在哪个 `<video>` 上 —— 幂等判断用 */
let flvKey = ''
let flvEl: HTMLVideoElement | null = null

/**
 * 原生播法的重连计数（只改 `:key`，逼浏览器重新建元素、重新请求地址）。
 *
 * FLV 有自己的引擎，重连是「同一个元素重新 attach」；HLS / 直连没有这个能力，
 * 元素一旦进入 error 状态就再也拉不起来，只能换一个元素。
 */
const mediaNonce = ref(0)

/**
 * 引擎状态 → store。
 *
 * 页面只认 store 这一份，组件不另记一套 —— 否则按钮图形、说明条、播放态
 * 三处迟早会互相矛盾。重连期间**画面退回快照**：宁可让人看一张旧图，
 * 也别盯着黑屏等；重连成功（playing）再切回直播画面。
 */
function applyStreamState(state: FlvState, note: string): void {
  switch (state) {
    case 'playing':
      streamBroken.value = false
      wantPlay.value = true
      cam.markPlaying()
      break
    case 'connecting':
      streamBroken.value = true
      cam.markConnecting(note)
      break
    // 断流重连：画面让给快照（不黑屏），但**状态是「在恢复」而不是「失败」**。
    // 播放键因而保持转圈 + 「立即重连」，不会退回三角让人误以为没在播。
    case 'reconnecting':
      streamBroken.value = true
      cam.markReconnecting(note)
      break
    case 'buffering':
      // 带上引擎原话：自动播放被策略拒绝时是「等待自动恢复播放」，
      // 光有一个转圈用户不知道在等什么
      cam.markBuffering(note)
      break
    case 'paused':
      /*
       * 画面上已经没有「暂停」这个动作了（点画面不再停播），所以走到这里的只剩
       * 一类：自动播放被浏览器策略拦下（低电量模式、无手势起播）。
       *
       * 这种时候**不能**把 `wantPlay` 置 false：那会让引擎在随后的断流里
       * 认为「用户不想看」，从而不再重连 —— 现场要求是「掉线就一直重连」。
       * 这里只把「暂停」记进 store 让说明条说实话，重连意图保持不变。
       */
      cam.markPaused()
      break
    case 'error':
      streamBroken.value = true
      cam.markPlayError(note)
      break
    default:
      cam.resetPlay()
  }
}

/** 收掉当前这一路（关层 / 切点位 / 进后台 / 卸载） */
function destroyStream(): void {
  flvKey = ''
  flvEl = null
  if (!flv) return
  flv.destroy()
  flv = null
}

/**
 * 起一路流。
 *
 * 只在「层开着 + 停在画面视图 + 当前点位有可播地址 + 是 FLV」时执行；
 * 其余情况（只有 RTSP / 没清单 / 进了抓拍视图）直接收掉，不留后台连接。
 *
 * **幂等**：这一路已经在跑（同点位、同地址、同一个 `<video>`）就直接返回。
 * 重连本身由引擎负责，不需要组件再销毁重建 —— 每次重建都会先 detach 再 attach，
 * 现场表现是画面反复黑一下，而且并发时可能两只播放器抢一个元素。
 */
function startStream(): void {
  if (!cam.isOpen || cam.shotsOpen) {
    // 关层 / 进抓拍视图：引擎和原生播法都要停，否则后台还在拉。
    // 只在「真的在播」时才叫 pause —— 否则每次挂载都会白记一次调用
    destroyStream()
    const v = videoEl.value
    if (v && !v.paused) v.pause()
    return
  }
  // 不是 FLV（直连 / 没有地址）：原生播法归 `<video>` 自己管，
  // 这里只收掉可能残留的 FLV 连接，**不要**去 pause 人家。
  if (cam.playMode !== 'flv' || !cam.playUrl) {
    destroyStream()
    return
  }
  const el = videoEl.value
  if (!el) return
  const key = `${cam.camId}|${cam.playUrl}`
  if (flv && flvKey === key && flvEl === el) return

  destroyStream()
  streamBroken.value = false
  flv = new FlvStream({ video: el, onState: applyStreamState, autoplay: wantPlay.value })
  flvKey = key
  flvEl = el
  void flv.start(cam.playUrl)
}

/**
 * 什么时候该（重）起流：
 *   · 打开 / 关闭层；
 *   · 切点位（地址换了，旧连接必须收掉）；
 *   · 清单晚到、网关模板生效（playUrl 变了）；
 *   · `<video>` 重新挂载（`v-if` 打开那一瞬间 el 才存在，所以要 flush: 'post'）。
 */
watch(
  () => [cam.isOpen, cam.shotsOpen, cam.camId, cam.playUrl, cam.playMode, videoEl.value] as const,
  () => startStream(),
  { immediate: true, flush: 'post' },
)

/**
 * 进后台后多久真正释放连接。
 *
 * 这 30 秒是刻意留的：iOS 上拉一下控制中心、锁屏、切一下别的 App 都会触发
 * `hidden`，如果一律立刻销毁，回来就得重建 —— 每个来回都会黑一下，还可能
 * 被自动播放策略拦住（于是「必须点一下」）。短暂离开只挂起，回前台秒续；
 * 真的切走久了才释放省流量。
 */
const HIDDEN_RELEASE_DELAY = 30_000
let hiddenTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 页面可见性变化。
 *
 * 旧实现是「hidden 就 destroy，visible 就 startStream」：在手机上过于激进，
 * 一次控制中心下拉就断一次，回来后重建又可能起不来。现在分两档：
 *   · 先 `suspend()` —— 暂停播放但保留连接与播放意图，回前台 `resume()` 直接续；
 *   · 超过 {@link HIDDEN_RELEASE_DELAY} 才真正释放（省流量）。
 * 回前台时若连接已经废了，`resume()` 内部会自己重连，仍然不需要用户点。
 */
function onVisibility(): void {
  if (document.hidden) {
    if (flv) flv.suspend()
    else {
      const v = videoEl.value
      if (v && !v.paused) v.pause()
    }
    if (hiddenTimer) clearTimeout(hiddenTimer)
    hiddenTimer = setTimeout(() => {
      hiddenTimer = null
      // 设置定时器的这段里可能已经回来了：回来了就别销毁
      if (!document.hidden) return
      destroyStream()
    }, HIDDEN_RELEASE_DELAY)
    return
  }
  if (hiddenTimer) {
    clearTimeout(hiddenTimer)
    hiddenTimer = null
  }
  if (flv) {
    // 连接还在 → 直接续播；不在 → resume() 内部会重连（不换源、不新建第二条）
    flv.resume()
    return
  }
  startStream()
}

/**
 * 网络恢复：立刻重连，不等退避。
 *
 * 手机从电梯/地下室出来、工地 4G 回来时，浏览器只给这一个事件。
 * 让它去等 10 秒的低频重连，人会以为「还没好」而反复点播放键。
 */
function onOnline(): void {
  if (!cam.isOpen || cam.shotsOpen) return
  if (flv) {
    if (cam.playState === 'reconnecting' || cam.playState === 'error') {
      wantPlay.value = true
      flv.retry()
    }
    return
  }
  if (hasStream.value && streamBroken.value) {
    // 原生播法：换一个元素重来（等价于「重开一路」）
    cam.resetPlay()
    streamBroken.value = false
    mediaNonce.value += 1
  }
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('online', onOnline)
  if (hiddenTimer) {
    clearTimeout(hiddenTimer)
    hiddenTimer = null
  }
  destroyStream()
})

/**
 * 画面被点了一下之后做什么（原来那颗播放键的能力，挂到了画面区）。
 *
 * **绝不把正在播的直播停掉**（2026-11-18 三改）。这是手机上「点一下画面就暂停」
 * 的唯一原因：手指落在画面上多半只是误触或想看得更清楚，一旦这一下等于暂停，
 * 画面就定在最后一帧，看着像卡死；而监控画面本身也不需要「暂停」这个动作。
 * 所以这里只做「加法」：
 *
 *   · 没有可播地址（只有 RTSP / 没清单）→ 重新取一帧快照；
 *   · 正在重连 / 环境不可恢复（reconnecting / error）→ 立刻重连，不等退避；
 *   · 已暂停（自动播放被策略拦下、被系统停掉）→ 继续播；
 *   · **正在播 → 什么都不做**（以前这里是 `pause()`）。
 *
 * 连点为什么不会出事：取图有 `busy` 挡着不发第二发；重连是单飞
 * （同一时刻只有一条连接）；已经在播则直接返回，不重复起流。
 * 全局也只有一个 `<video>`，`:key` 绑通道，切点位换元素而不是给同一元素改 src。
 */
function onPlay(): void {
  if (!hasStream.value) {
    // 取图中再点不出第二发：以前靠按钮 `disabled` 挡，现在按钮撤了，
    // 就在入口挡一道 —— 否则连点画面会堆出一串取图请求。
    if (busy.value) return
    cam.refresh()
    return
  }
  /*
   * 重连 / 恢复中：**什么都不做**（2026-11-19 改）。
   *
   * 引擎正在按 2/4/6s → 每 10s 无限重试，同时还有一条「恢复播放」通道在试
   * `play()`。此时点画面若去调 `retry()`，等于把当前连接拆掉重建一条 ——
   * 既打断正在进行的恢复，也违背「点击不得重建连接」。要停止只有关层。
   */
  if (cam.playState === 'reconnecting') return
  // 环境级不可恢复（没有 MSE 之类）：重试其实也没用，给一个手动兜底
  if (cam.playState === 'error') {
    streamBroken.value = false
    wantPlay.value = true
    if (flv) {
      flv.retry()
    } else {
      cam.resetPlay()
      mediaNonce.value += 1
    }
    return
  }
  const v = videoEl.value
  if (!v) return
  // 正在播：点了也不停。这里必须判 `paused` 而不是 `playState` ——
  // 后者在缓冲 / 追帧时可能还没跟上，而 `paused` 是元素自己的真话。
  if (!v.paused) return
  wantPlay.value = true
  if (flv) {
    void flv.play()
    return
  }
  void v.play().catch(() => {
    /* 被连续的 pause 打断 / 用户还没完成手势：交给 media 事件反映真实状态 */
  })
}

/**
 * 点击画面 = 原来那颗播放键（只是**不能再暂停**，见 `onPlay`）。
 *
 * 右上角两颗控件（历史抓拍 / 全屏）有自己的点击语义，冒泡上来时要放行 ——
 * 否则「没有流时点全屏」会顺带打一发取图请求，「重连中点全屏」会顺带重连一次。
 */
function onStageClick(e: MouseEvent): void {
  const el = e.target as HTMLElement | null
  if (el?.closest('button, a')) return
  onPlay()
}

/** `<video>` 事件 → store 播放态（组件不自己记第二份） */
function onMediaPlay(): void {
  cam.markPlaying()
}

/**
 * `<video>` 被暂停 → store。
 *
 * FLV 走引擎：界面上已经没有「暂停」这个动作（点画面不会停播），所以能暂停的
 * 只剩系统 / 浏览器（来电、锁屏、切后台、低电量、拔耳机）。引擎的恢复通道会
 * 自己把它拉起来，这里**不能**写「已暂停」—— 那既会误导成用户自己停的，
 * 也会把「正在恢复」这个事实盖掉。
 *
 * 原生播法（直连 mp4 之类）没有恢复通道，照旧如实记 paused。
 */
function onMediaPause(): void {
  if (cam.playMode === 'flv') {
    if (cam.playState === 'playing' || cam.playState === 'buffering') {
      cam.markReconnecting('画面恢复中，正在自动重连')
    }
    return
  }
  cam.markPaused()
}

function onMediaBuffering(): void {
  cam.markBuffering()
}

/**
 * 原生 `<video>` 报错。
 *
 * FLV 的失败由引擎统一收口（先按退避重连，重试用完才把 error 抛回来），
 * 这里必须放行 —— 否则一次抖动就被判成「永久不可用」，再也不会自己恢复。
 * 只有原生直连（mp4 之类）才会走到这里，确实没有重连能力，回落快照并说清原因。
 */
function onMediaError(): void {
  if (cam.playMode === 'flv') return
  streamBroken.value = true
  cam.markPlayError()
}

/**
 * 画面是什么时候取到的（HH:mm）。
 *
 * 只说明「这次什么时候拿到的」—— 相机自己的拍摄时间刻在画面里，两者可能差几小时
 * （快照一天只更新几次）。写成「现场画面 · 15:47 获取」，不会被误读成拍摄时间。
 */
const fetchedAt = computed(() => {
  if (!cam.frameAt) return ''
  const d = new Date(cam.frameAt)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

/**
 * 说明条这一句：先说「现在到底是什么情况」。
 *
 * 顺序是刻意的 ——
 *   ① 引擎 / 媒体报上来的原因优先：它带「第几次、几秒后、还在后台继续」，
 *      比任何兜底文案都有用。旧版把 `streamBroken` 那句挡在前面，
 *      等于把具体原因吞掉，只剩一句「不可用」，没法判断是断网还是上游没推流；
 *   ② 再到「直播中」（别让人以为是定时快照）；
 *   ③ 再是兜底的「已回落快照」；
 *   ④ 最后才是「几点取的这一帧」。
 */
const stampText = computed(() => {
  /*
   * 手机端一律不带计数：引擎原话里的「第 2/3 次」「3 秒后」「已连续重试 3 次」
   * 全部裁掉，只留「出什么事了 + 正在自动重连」。
   *
   * 判定用 `isMobileDevice()`（苹果 / 安卓 / 鸿蒙 / 自报桌面 UA 的移动浏览器都算），
   * 不是只认苹果 —— 手机上换一台设备就不该又冒出计数来。
   * 桌面保留原话：排查时「第几次、几秒后」正是要看的东西。
   */
  const note = cam.playNote
    ? isPhone
      ? stripRetryCount(cam.playNote)
      : cam.playNote
    : ''
  if (cam.playState === 'reconnecting') return note || '正在自动重连'
  if (cam.playState === 'error' && note) return note
  if (cam.playState === 'buffering' && note) return note
  if (showLive.value && cam.playState === 'playing') return '现场画面 · 直播中'
  if (streamBroken.value) return '直播流不可用 · 当前为定时快照'
  return fetchedAt.value ? `现场画面 · ${fetchedAt.value} 获取` : '现场画面'
})

/** 没有画面时的说明（画面区此时是空的，写字不算「叠在画面上」） */
const stageEmpty = computed(() => {
  if (!auth.isLoggedIn) {
    return { title: '登录后可查看现场监控', sub: '监控画面需要登录后获取', act: 'login' as const }
  }
  if (cam.state === 'error') {
    return { title: '画面获取失败', sub: cam.note || '请稍后重试', act: 'retry' as const }
  }
  return { title: '正在获取监控画面…', sub: '', act: null }
})

/** 全屏键的文案与图标跟着横屏状态换（设计稿 .cam-land-enter / .cam-land-exit） */
const landText = computed(() => (shell.isLand ? '退出全屏' : '全屏'))
const landIcon = computed(() => (shell.isLand ? 'cam-collapse' : 'cam-expand'))

function onRefresh(): void {
  cam.refresh()
}

/* ---------------- 历史抓拍（入口 + 展示骨架，数据待接入） ---------------- */

/** 选中的日期（空 = 用最新一天）；数据进来后芯片点击切分组 */
const activeDay = ref('')

/** 当前要展示的照片：按选中日期过滤，没有数据就是空数组 */
const shotList = computed(() => {
  if (!cam.shotDays.length) return []
  const key = activeDay.value || cam.shotDays[0].key
  return cam.shotDays.find((d) => d.key === key)?.items ?? []
})

function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 进历史抓拍视图。
 *
 * 设计稿里画面视图与抓拍视图互斥（`.cam-live-view.hide` / `.cam-shots-view`），
 * 所以这里只切视图，不动当前点位 —— 退回画面时还是原来那台相机。
 */
function onShots(): void {
  activeDay.value = ''
  cam.openShots()
}

function onChip(id: string): void {
  cam.applyCam(id)
}

function onLandToggle(): void {
  cam.setCamLand(!shell.isLand)
}

/**
 * 返回：历史抓拍 → 横屏 → 关层，一级一级退。
 *
 * 旧版还有「关大图 / 收日历」两级 —— 大图弹层与日历随本次重做下线（抓拍视图
 * 现在是入口 + 空态，等数据接入后再补）。
 */
function onBack(): void {
  if (cam.shotsOpen) {
    cam.closeShots()
    return
  }
  if (shell.isLand) {
    cam.setCamLand(false)
    return
  }
  overlay.leave(() => {
    cam.closeCam()
    // 若本次监控是从全屏地图进来的，回到全屏地图而非首页
    shell.backToMapLand()
  })
}

function goLogin(): void {
  cam.closeCam()
  subpage.openLogin('登录后可查看现场监控')
}
</script>

<template>
  <div
    ref="playerEl"
    class="cam-player"
    id="camPlayer"
    :class="{ open: cam.isOpen, 'is-land': shell.isLand }"
    :hidden="!cam.isOpen"
    :aria-hidden="!cam.isOpen"
  >
    <BackBar :title="barTitle" back-id="btnCamBack" title-id="camPlayerName" @back="onBack" />

    <div class="cam-live-view" id="camLiveView" :class="{ hide: cam.shotsOpen }">
      <!--
        画面区：图 + 设计稿里的三颗控件（中央播放键、右上「刷新」「全屏」）。
        不放时间戳、不放点位名 —— 相机 OSD 与顶栏标题已经各说了一遍。
        contain 保证整幅画面完整可见，宁可两侧留黑也不裁掉边角。
      -->
      <div class="cam-player-stage" id="camPlayerStage" @click="onStageClick">
        <!--
          有可播地址就挂 <video>（FLV 由引擎喂 MSE，直连走原生）。
          poster 放最近一帧快照：连流的那一两秒看到的是现场图，不是黑块。

          `:key` 绑通道 —— 切点位直接换元素，而不是给同一个元素改 src：
          后者会把上一个通道的缓冲/播放态带过来，也是「连点就卡住」的老根因。

          重连期间只把画面「蒙起来」（is-veiled），**不销毁元素**：
          display:none 的 <video> 在部分移动浏览器里会停掉解码，回来就永远等不到
          playing 事件；用 opacity 藏着，管线照跑，恢复时无缝切回来。
        -->
        <video
          v-if="hasStream"
          :key="`${cam.camId}-${mediaNonce}`"
          ref="videoEl"
          id="camPlayerVideo"
          class="cam-frame"
          :class="{ 'is-veiled': !showLive }"
          :src="cam.playMode === 'flv' ? undefined : cam.playUrl"
          :poster="cam.frameUrl || undefined"
          muted
          playsinline
          webkit-playsinline
          preload="none"
          @play="onMediaPlay"
          @playing="onMediaPlay"
          @pause="onMediaPause"
          @waiting="onMediaBuffering"
          @error="onMediaError"
        ></video>

        <img
          v-if="cam.frameUrl"
          id="camPlayerFrame"
          class="cam-frame"
          :class="{ 'is-veiled': showLive }"
          :src="cam.frameUrl"
          alt=""
          draggable="false"
        />

        <!--
          中央播放键：**已撤掉**（2026-11-18 三改）。
          打开自动连、断了无限重连、连上自动续播 —— 它没有「非点不可」的时刻，
          留着只会盖住画面中间。「起播 / 立即重连」改由点击画面承担
          （`onStageClick` → 同一个 `onPlay`），点画面**不会暂停**。
          `showPlayBtn` 恒为 false，
          这段保留成开关：将来某类设备必须点一下才能起播时，改一行就能放回来。
        -->
        <button
          v-if="showPlayBtn"
          class="cam-play"
          :class="playIcon"
          id="btnCamPlay"
          type="button"
          :aria-label="playLabel"
          :title="playLabel"
          :aria-pressed="showLive ? cam.isPlaying : undefined"
          :disabled="playDisabled"
          @click="onPlay"
        ></button>

        <!-- 右上角操作（设计稿 #camPlayerStage > .cam-stage-acts） -->
        <div class="cam-stage-acts" id="camStageActs">
          <!--
            历史抓拍（原「刷新」，2026-11-18 改）。语义是「看这台相机过去的照片」，
            所以文案、图标、无障碍名一起换成相册语义；位置/尺寸/层级/圆角不变。
            入口先通、数据待接入：视图见下方 #camShotsView，数据接在 store 的 loadShots()。
          -->
          <button
            class="cam-stage-btn"
            id="btnCamShots"
            type="button"
            aria-label="查看历史抓拍照片"
            :aria-expanded="cam.shotsOpen"
            aria-controls="camShotsView"
            @click="onShots"
          >
            <SvgIcon name="gallery" />
            历史抓拍
          </button>
          <button
            class="home-full"
            id="btnCamLand"
            type="button"
            :aria-pressed="shell.isLand"
            @click="onLandToggle"
          >
            <SvgIcon :name="landIcon" />
            {{ landText }}
          </button>
        </div>

        <div v-if="!cam.frameUrl && !hasStream" class="cam-stage-empty" data-empty="cam-live">
          <strong>{{ stageEmpty.title }}</strong>
          <span v-if="stageEmpty.sub">{{ stageEmpty.sub }}</span>
          <button
            v-if="stageEmpty.act === 'retry'"
            class="data-empty-btn"
            type="button"
            @click="onRefresh"
          >
            重试
          </button>
          <button
            v-else-if="stageEmpty.act === 'login'"
            class="data-empty-btn"
            type="button"
            @click="goLogin"
          >
            去登录
          </button>
        </div>
      </div>

      <!-- 说明条：在画面下方，不遮画面。重连进度会变，读屏也跟着念一句 -->
      <div class="cam-stage-bar" id="camStageBar">
        <span class="cam-stamp" id="camStamp" aria-live="polite">{{ stampText }}</span>
      </div>

      <!--
        只有 RTSP 时把地址原样交出来：手机播不了它，但运维/客户端可以直接用。
        这一行是可选中复制的（user-select: text），不是装饰。
      -->
      <div
        v-if="onlyRtsp"
        class="cam-rtsp-row"
        id="camRtspRow"
        title="该地址是 RTSP，浏览器与手机不能直连；需要服务端另开 HTTP-FLV 或 HLS"
      >
        <span>仅 RTSP</span>
        <code>{{ cam.rtspUrl }}</code>
      </div>

      <div class="cam-player-switch">
        <p>切换点位</p>
        <div class="cam-player-chips" id="camPlayerChips">
          <div v-for="g in cam.grouped" :key="g.name" class="cam-chip-group">
            <h5>{{ g.name }}<em>{{ g.items.length }}</em></h5>
            <div class="cam-chip-grid">
              <button
                v-for="c in g.items"
                :key="c.channelId"
                class="cam-chip"
                :class="{ on: c.channelId === cam.camId }"
                type="button"
                :data-cam="c.channelId"
                @click="onChip(c.channelId)"
              >
                {{ c.name }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!--
      历史抓拍视图（设计稿 .cam-shots-view，与画面视图互斥）。

      结构照设计稿：标题条 → 日期芯片 → 三列照片网格。数据全部来自
      `cam.shots`（store 的 `loadShots()` 是唯一接入点），所以现在没有数据时
      走空态，数据一进来这三块自动就位，这里不需要改。
    -->
    <div class="cam-shots-view" :class="{ hide: !cam.shotsOpen }" id="camShotsView">
      <div class="cam-shots">
        <div class="cam-shots-hd">
          <strong>历史抓拍</strong>
          <span>每天 3 张，点开查看照片</span>
        </div>

        <div class="cam-shot-days" id="camShotDays">
          <button
            v-for="d in cam.shotDays"
            :key="d.key"
            class="cam-day"
            :class="{ on: d.key === activeDay }"
            type="button"
            :data-day="d.key"
            :aria-pressed="d.key === activeDay"
            @click="activeDay = d.key"
          >
            {{ d.label }}
          </button>
        </div>

        <div class="cam-shot-grid" id="camShotGrid">
          <!--
            照片网格：现在没有数据所以是空的。接入后每张自动渲染成
            缩略图 + 时刻；点开看大图的弹层在此处扩展（把 figure 换成 button
            并绑一个 openShot id 即可）。
          -->
          <figure v-for="s in shotList" :key="s.id" class="cam-shot" :data-shot="s.id">
            <img :src="s.thumb" :alt="`${cam.current.name} 抓拍`" loading="lazy" />
            <figcaption>{{ hhmm(s.at) }}</figcaption>
          </figure>
        </div>

        <div v-if="!shotList.length" class="cam-shots-empty" data-empty="cam-shots">
          <strong>暂无历史抓拍</strong>
          <span>{{ cam.shotsNote }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
