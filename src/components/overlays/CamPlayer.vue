<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BackBar from '@/components/ui/BackBar.vue'
import DayPickChips from '@/components/ui/DayPickChips.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { FlvStream, type FlvState } from '@/utils/flvStream'
import { isMobileDevice, stripRetryCount } from '@/utils/env'
import { useLandscape } from '@/utils/landscape'
import { useSlideOverlay } from '@/utils/slideOverlay'
import { useImageZoom } from '@/utils/zoom'

/**
 * 视频监控层（2026-11-18 按设计稿重做）
 *
 * 对应设计稿「视频监控 / 地磅全景」：上方一块画面，下面一条说明，
 * 再下面按「设备设施 / 材料堆场 / 出入口管控」三组切换点位
 * （2026-11-19 现场要求：设备设施置顶并合并塔吊/地磅/加工棚，出入口改名
 * 出入口管控，新增材料堆场）。
 *
 * ## 画面区上叠了什么（2026-11-18 再按设计稿补按钮）
 *
 * 设计稿 `#camPlayerStage` 里一共三样叠加物，我们只保留按钮，不保留文字：
 *   · `.cam-time`（每秒跳动的时间戳）—— **不要**。相机自己的 OSD 已经把时间
 *     刻在画面里了，再叠一层就是两块表互相打架，而且它挡画面。
 *   · `.cam-pos-tag`（分组 · 点位名）—— **不要**。顶栏标题已经写着当前点位。
 *   · `.cam-play`（中央播放键）—— **不要**（2026-11-18 撤掉；打开自动连、断了
 *     无限重连，它只会盖画面，还容易被误读成「要点一下才开始」，样式也一并删了）。
 *   · `.cam-stage-acts`（右上「历史抓拍」「全屏」）—— 要，照设计稿的尺寸/圆角/
 *     位置还原。它们是**控件**，不是贴在画面上的标签。
 *
 * ## 画面上的点击（2026-11-18 三改）
 *
 * 中央那颗播放键已经整颗撤掉，它的能力挂到画面区本身：
 *   · 有可播地址 → 只做「起播 / 立即重连」，**绝不暂停**（见 `onPlay`）；
 *   · 只有 RTSP（V2 现状）→ 这一下不做任何事（地址在下方「仅 RTSP」行里给出）。
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
 * 这期间画面蒙起来，重连成功（playing）就亮回来。所以它只决定**画面亮不亮**。
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

/** 真正把直播画面亮出来：有地址，且当前这一路没被打挂（挂了先蒙起来） */
const showLive = computed(() => hasStream.value && !streamBroken.value)

/**
 * 「只有 RTSP」：地址拿到了，但浏览器/手机播不了。
 *
 * 这不是错误态 —— V2 桌面端能播（Unity 支持 RTSP，必要时还挂本地 ffmpeg 桥接），
 * 换到浏览器就需要服务端另开 HTTP-FLV 或 HLS。页面把地址原样交出来，
 * 由运维决定怎么开，绝不在这里假装在播。
 */
const onlyRtsp = computed(() => !hasStream.value && cam.playUrl === '' && cam.rtspUrl !== '')

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
 * 三处迟早会互相矛盾。重连期间**画面蒙起来**（`.is-veiled`，不销毁元素）：
 * 移动端 display:none 会停解码、回来等不到 playing；重连成功再亮回来。
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
    // 断流重连：画面蒙起来，但**状态是「在恢复」而不是「失败」** ——
    // 说明条据它报引擎原话，不会让人误以为彻底没戏了。
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
 *   · 没有可播地址（只有 RTSP / 没清单）→ **什么都不做**（旧版这里会去取一帧
 *     快照，那个接口已下线；地址在下方「仅 RTSP」行里原样给出）；
 *   · 正在重连 / 环境不可恢复（reconnecting / error）→ 立刻重连，不等退避；
 *   · 已暂停（自动播放被策略拦下、被系统停掉）→ 继续播；
 *   · **正在播 → 什么都不做**（以前这里是 `pause()`）。
 *
 * 连点为什么不会出事：重连是单飞（同一时刻只有一条连接）；已经在播则直接返回，
 * 不重复起流。全局也只有一个 `<video>`，`:key` 绑通道，切点位换元素而不是给同一
 * 元素改 src。
 */
function onPlay(): void {
  // 没有可播地址就没有「这一下能做的事」：不取图、不假装连一下
  if (!hasStream.value) return
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
 * 否则「重连中点全屏」会顺带重连一次。
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
 * 只有原生直连（mp4 / m3u8）才会走到这里：画面蒙起来 + 说明原因，
 * 点画面换一个元素重试（不再回落任何快照）。
 */
function onMediaError(): void {
  if (cam.playMode === 'flv') return
  streamBroken.value = true
  cam.markPlayError()
}

/**
 * 说明条这一句：先说「现在到底是什么情况」。
 *
 * 顺序是刻意的 ——
 *   ① 引擎 / 媒体报上来的原因优先：它带「第几次、几秒后、还在后台继续」，
 *      比任何兜底文案都有用；
 *   ② 再到「直播中」（别让人以为画面是截图）；
 *   ③ 最后才是兜底的「现场画面」。
 *
 * 旧版还有「· HH:mm 获取」与「当前为定时快照」两句，都是定时快照时代的产物：
 * 快照接口下线后画面只有直播流，没有「几点取的这一帧」这回事。
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
  return '现场画面'
})

/**
 * 没有画面时的说明（画面区此时是空的，写字不算「叠在画面上」）。
 *
 * 只剩「没登录」一种：登录后画面只来自直播流，连不上由说明条报引擎原话、
 * 「仅 RTSP」行交地址 —— 不再有「取图失败 → 重试」这条路（旧快照接口已下线）。
 */
const stageEmpty = computed(() => {
  if (!auth.isLoggedIn) {
    return { title: '登录后可查看现场监控', sub: '监控画面需要登录后获取', act: 'login' as const }
  }
  return null
})

/** 全屏键的文案与图标跟着横屏状态换（设计稿 .cam-land-enter / .cam-land-exit） */
const landText = computed(() => (shell.isLand ? '退出全屏' : '全屏'))
const landIcon = computed(() => (shell.isLand ? 'cam-collapse' : 'cam-expand'))

/* ---------------- 历史抓拍（2026-11-20：服务端历史列表 + 本机图片缓存） ---------------- */

/** 时刻（HH:mm），详情里写「本机什么时间取得的」 */
function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 详情里的标题：点位 · 日期 抓拍时刻（时刻由服务端给，不再按「档」估） */
const shotTitle = computed(() => {
  const s = cam.shotPop
  if (!s) return ''
  return `${cam.current.name} · ${cam.shotDateLabel} ${s.hm} 抓拍`
})

/** 详情正文那句：服务端抓拍时刻 + 原图体积 */
const shotMeta = computed(() => {
  const s = cam.shotPop
  if (!s) return ''
  const size = s.size >= 1024 * 1024
    ? `${(s.size / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(s.size / 1024))}KB`
  return `抓拍 ${hhmm(s.at)} · 原图 ${size}`
})

/** 详情当前显示哪一版：默认压缩预览，点「查看原图」换原图（与智眸一致） */
const shotSrc = computed(() => {
  const s = cam.shotPop
  if (!s) return ''
  return cam.shotShowFull ? s.url : s.thumb
})

/** 查看原图那颗按钮的文案（原图就在本机档案里，切换是即时的，没有进度条） */
const shotHdLabel = computed(() => (cam.shotShowFull ? '已是原图' : '查看原图'))

function onShotHd(): void {
  cam.showShotFull()
}

/**
 * 大图缩放（智眸那套 `useImageZoom`：双击 / 双指，单指拖动）。
 * 换一张或关弹层时复位，否则下次打开还停在上次的放大倍数上。
 */
const {
  zoomed: shotZoomed,
  label: shotZoomLabel,
  imgStyle: shotImgStyle,
  animating: shotZoomAnim,
  handlers: shotZoomHandlers,
  reset: resetShotZoom,
} = useImageZoom()

watch(
  () => [cam.shotPopId, cam.shotShowFull] as const,
  () => resetShotZoom(),
)

/**
 * 详情大图的横屏（与智眸「横屏」同一套 `useLandscape`）：
 * `land` 为真时画布 Teleport 到 body 铺满视口，并尽力申请系统全屏 + 锁方向；
 * iOS 拿不到那两步就只铺满视口，用户自己转手机照样能看。
 */
const { land: shotLand, setStage: setShotStage, toggle: toggleShotLand, exit: exitShotLand } =
  useLandscape()

/** 关弹层 / 换日期时把横屏收回来，别留一块全屏黑挂在页面上 */
watch(
  () => cam.shotPopId,
  (id) => {
    if (!id && shotLand.value) void exitShotLand()
  },
)

function onShotClick(id: string): void {
  cam.openShot(id)
}

/** 日期芯片：0 = 今天，1 = 昨天 */
function onShotDay(day: number): void {
  const d = new Date()
  d.setDate(d.getDate() - day)
  cam.setShotDate(d)
}

function onShotCalToggle(): void {
  cam.toggleShotCal()
}

function onShotCalSelect(d: Date): void {
  cam.setShotDate(d)
}

/**
 * 进历史抓拍视图。
 *
 * 设计稿里画面视图与抓拍视图互斥（`.cam-live-view.hide` / `.cam-shots-view`），
 * 所以这里只切视图，不动当前点位 —— 退回画面时还是原来那台相机。
 */
function onShots(): void {
  cam.openShots()
}

function onChip(id: string): void {
  cam.applyCam(id)
}

function onLandToggle(): void {
  cam.setCamLand(!shell.isLand)
}

/**
 * 返回：大图 → 日历 → 历史抓拍 → 横屏 → 关层，一级一级退。
 */
function onBack(): void {
  if (cam.shotPopOpen) {
    cam.closeShot()
    return
  }
  if (cam.shotCalOpen) {
    cam.shotCalOpen = false
    return
  }
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
          连流的那一两秒是黑块 —— 旧版用「最近一帧」快照当 poster，那个接口已下线，
          这里不再垫图（点了历史抓拍可以看这台相机过去拍到的画面）。

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

        <div v-if="stageEmpty" class="cam-stage-empty" data-empty="cam-live">
          <strong>{{ stageEmpty.title }}</strong>
          <span v-if="stageEmpty.sub">{{ stageEmpty.sub }}</span>
          <button class="data-empty-btn" type="button" @click="goLogin">去登录</button>
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

      结构照设计稿：标题条 → 日期芯片（今天 / 昨天 / 选日期）→ 三列照片网格；
      「选日期」展开的是全站共用那份月历（`ui/MonthCalendar.vue`，与航拍、巡检
      历史同一个组件，样式一份）。数据来自 `cam.shots`，存取见 store 的
      `loadShots()`（服务端历史列表 + 本机图片缓存），加载 / 空 / 失败三态都在这里。
    -->
    <div class="cam-shots-view" :class="{ hide: !cam.shotsOpen }" id="camShotsView">
      <div class="cam-shots">
        <div class="cam-shots-hd">
          <strong>历史抓拍</strong>
          <span>{{ cam.shotsHint }}</span>
        </div>

        <div class="cam-shot-days" id="camShotDays">
          <DayPickChips
            :selected="cam.shotDate"
            open-attr-name="data-cal-open"
            @pick="onShotDay"
            @open="onShotCalToggle"
          />
        </div>

        <!-- 加载中：不摆灰方块占位（会像已经加载好的图），一句话说明在取 -->
        <div v-if="cam.shotsState === 'loading'" class="cam-shots-tip" data-state="cam-shots-loading">
          <i class="cam-shots-spin" aria-hidden="true"></i>
          <span>正在读取{{ cam.shotDateLabel }}的抓拍…</span>
        </div>

        <div v-else class="cam-shot-grid" id="camShotGrid">
          <button
            v-for="s in cam.shots"
            :key="s.id"
            class="cam-shot"
            :class="{ 'is-loading': s.state === 'loading', 'is-failed': s.state === 'error' }"
            type="button"
            :data-shot="s.id"
            :data-state="s.state"
            :aria-label="`${cam.shotDateLabel} ${s.hm} 抓拍，查看大图`"
            @click="onShotClick(s.id)"
          >
            <!--
              元信息先到、图后到：还没取回时摆一块转圈底（不是灰方块假装有图），
              取失败的给「重试」——点一下重查这一天，本机已缓存的会立刻上屏。
            -->
            <span class="cam-shot-pic">
              <img
                v-if="s.thumb"
                :src="s.thumb"
                :alt="`${cam.current.name} ${cam.shotDateLabel} ${s.hm} 抓拍`"
                loading="lazy"
              />
              <i v-else-if="s.state === 'loading'" class="cam-shots-spin" aria-hidden="true"></i>
              <em v-else>重试</em>
            </span>
            <span class="cam-shot-hm">{{ cam.shotDateLabel }} {{ s.hm }}</span>
          </button>
        </div>

        <!--
          空 / 失败：标题说结论，失败才给原因（服务端 `message` 原样带上）。
          空态**不写长说明**：服务端近 30 天有就列、没有就是没有，每次点进空日期
          都念一遍既占屏又像报错；日期范围的边界交给日历与 toast 去说。
        -->
        <div
          v-if="cam.shotsState === 'empty' || cam.shotsState === 'error'"
          class="cam-shots-empty"
          data-empty="cam-shots"
        >
          <strong>{{ cam.shotsState === 'error' ? '抓拍获取失败' : '这一天没有抓拍记录' }}</strong>
          <span v-if="cam.shotsState === 'error'">{{ cam.shotsNote }}</span>
          <button class="data-empty-btn" type="button" @click="cam.loadShots()">重新获取</button>
        </div>

        <!-- 有图但最新一帧没取到：只在下面提一句，不挡已有的照片 -->
        <p v-if="cam.shotsState === 'ok' && cam.shotsNote" class="cam-shots-note">
          {{ cam.shotsNote }}
        </p>
      </div>

      <!--
        可选区间：今天往前 30 天（`cam.shotMinDate` / `shotMaxDate`）。
        月历这边的禁用只是「点不到」，真正的裁决点仍在 store 的 `setShotDate()`，
        两边同一套边界，改天数只改 `SHOT_RANGE_DAYS` 一处。
      -->
      <MonthCalendar
        :month="cam.shotCalMonth"
        :selected="cam.shotDate"
        :min-day="cam.shotMinDate"
        :max-day="cam.shotMaxDate"
        :hidden="!cam.shotCalOpen"
        @update:month="cam.setShotCalMonth"
        @select="onShotCalSelect"
      />

      <!--
        大图：默认压缩预览（列表那张），右上角「查看原图 / 横屏」与智眸同一套胶囊。
        原图就在本机档案里，切换是即时的；横屏时整块画布 Teleport 到 body 铺满视口
        （`.cam-player` 有 transform，fixed 会被当成包含块，不挪 DOM 就铺不满）。
      -->
      <div
        class="cam-shot-pop"
        id="camShotPop"
        :class="{ open: cam.shotPopOpen }"
        :hidden="!cam.shotPopOpen"
        :aria-hidden="!cam.shotPopOpen"
      >
        <button class="cam-shot-close" id="btnShotClose" type="button" @click="cam.closeShot()">
          关闭
        </button>

        <Teleport to="body" :disabled="!shotLand">
          <figure class="cam-shot-stage" :class="{ 'is-land': shotLand }" :ref="setShotStage">
            <img
              v-if="shotSrc"
              class="zoomable"
              :class="{ 'is-zoomed': shotZoomed, 'is-anim': shotZoomAnim }"
              :src="shotSrc"
              alt=""
              :style="shotImgStyle"
              draggable="false"
              v-on="shotZoomHandlers"
            />
            <p v-else class="cam-shot-wait">
              <i class="cam-shots-spin" aria-hidden="true"></i>
              <span>正在读取原图…</span>
            </p>
            <span v-if="shotZoomed" class="zoom-badge">{{ shotZoomLabel }}</span>
            <span class="patrol-view-tag">{{ cam.shotShowFull ? '原图' : '压缩预览' }}</span>

            <div class="pano-tools">
              <button
                class="pano-tool"
                type="button"
                :disabled="cam.shotShowFull"
                :aria-label="`查看原图，${shotMeta}`"
                @click="onShotHd"
              >
                {{ shotHdLabel }}
              </button>
              <button
                class="pano-tool"
                type="button"
                :aria-pressed="shotLand"
                :aria-label="shotLand ? '退出横屏' : '横屏查看'"
                @click="toggleShotLand"
              >
                {{ shotLand ? '竖屏' : '横屏' }}
              </button>
            </div>
          </figure>
        </Teleport>

        <p class="cam-shot-meta" id="camShotMeta">{{ shotTitle }}</p>
        <p class="cam-shot-sub">{{ shotMeta }} · 双指缩放，单指拖动</p>
      </div>
    </div>
  </div>
</template>
