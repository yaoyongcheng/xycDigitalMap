<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 实时画面播放器（HTTP-FLV）
 *
 * 数据源：keehang 的 ZLMediaKit（`/live/stream/list` 的 `flv + https` 地址），
 * 与 V2 桌面端同一路流。用 mpegts.js 把 FLV 解成 MSE 喂给 `<video>`：
 *
 * · **动态 import**：mpegts.js 有 200KB+，只有真要看画面时才加载，
 *   不给首页 / 其它子页增加首屏体积（Vite 会切成独立 chunk）。
 * · **不支持 MSE 时明说**（`unsupported`）：iOS 17 以前的 Safari 没有 MSE，
 *   这类浏览器拿不到画面，说清楚比留一块黑屏强。
 * · **自动播放被拦时不假装在播**（`blocked`）：给一个「点击播放」按钮。
 * · 只做「看」：不接管截图 / 录像，也不写任何假状态。
 *
 * ## 为什么不拿「服务端说在推流」当挂载门禁
 *
 * 平台给的 `online` 是快照（我们 30s 才刷一次）。无人机起飞推流那一瞬间，
 * 快照还是 false —— 页面就不挂播放器，要等下一轮刷新才有画面，
 * 这就是「起飞后空了半分钟」的来源。
 *
 * 所以现在**只要有地址就先连**：ZLM 对未推流的流是「挂着等」的，
 * 推流一开始就在同一根连接上吐数据，画面立刻出来，一帧不丢。
 * 连不上也不吭声是不行的，靠两条收口：
 *
 * ① `loading` 超过 `CONNECT_TIMEOUT_MS` 仍无画面 → `offair`（说明没在推流）；
 * ② `offair` / 首次就 `error` 时每 `AUTO_RETRY_MS` 自动重连一次，
 *    另外给「重试」按钮 —— 起飞不用用户盯着点。
 *
 * `playing` 只由 `<video>` 的 `playing` 事件触发（真开始解码），
 * 不拿 `player.play()` 的 resolve 当在播：点了 play 但没数据时它也会 resolve，
 * 那样 LIVE 角标就是假的。
 */
const props = defineProps<{
  /** FLV 直播地址；null = 没有可播的流 */
  src: string | null
  /** 没开播时补一句为什么（各设备原因不同），可省略 */
  offAirHint?: string
}>()

/** 状态向上抛，父级据此决定要不要挂 LIVE 角标（角标不能说谎） */
const emit = defineEmits<{ state: [PlayerState] }>()

/**
 * idle 无流 / loading 连流中 / playing 已出画面 / blocked 待点击 /
 * unsupported 浏览器放不了 / offair 连上了但没在推流 / error 播着断了
 */
type PlayerState = 'idle' | 'loading' | 'playing' | 'blocked' | 'unsupported' | 'offair' | 'error'

/** 连流多久还没画面就当「没在推流」。比 ZLM 自己的 15s 等待略长，先让它的 404 说话 */
const CONNECT_TIMEOUT_MS = 18000
/** 没开播时多久自动再连一次（起飞瞬间不需要用户点） */
const AUTO_RETRY_MS = 20000

const video = ref<HTMLVideoElement | null>(null)
const state = ref<PlayerState>('idle')

/** 只用到这几个方法，写成本地类型，避免把整个 d.ts 拖进类型推导 */
interface MpegtsPlayer {
  attachMediaElement(el: HTMLMediaElement): void
  load(): void
  play(): Promise<void> | void
  pause(): void
  unload(): void
  detachMediaElement(): void
  destroy(): void
  on(ev: string, cb: () => void): void
}

let player: MpegtsPlayer | null = null
/** 连流的序号：切页签/换源时旧连接的回调要作废，不能把新连接的状态改歪 */
let seq = 0
/** 超时与自动重连共用一个句柄，任何一次状态跳转都要先清掉 */
let timer: ReturnType<typeof setTimeout> | null = null
/** 本次连接有没有真出过画面：区分「没开播」和「播着播着断了」 */
let hasPlayed = false

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function setState(s: PlayerState): void {
  if (state.value === s) return
  state.value = s
  emit('state', s)
}

function teardown(): void {
  const p = player
  player = null
  if (!p) return
  try {
    p.pause()
  } catch {
    /* 已经断开时 pause 会抛，忽略 */
  }
  try {
    p.unload()
    p.detachMediaElement()
    p.destroy()
  } catch {
    /* 释放失败不影响下次连接 */
  }
}

/** 没开播时排队自动重连：无人机起飞的那一刻往往就是下一次尝试 */
function armRetry(): void {
  clearTimer()
  timer = setTimeout(() => {
    timer = null
    void start()
  }, AUTO_RETRY_MS)
}

/** 真实出画面的唯一入口：`<video>` 开始解码 */
function onPlaying(): void {
  hasPlayed = true
  clearTimer()
  setState('playing')
}

async function start(): Promise<void> {
  const my = ++seq
  clearTimer()
  teardown()
  const url = props.src
  if (!url) {
    setState('idle')
    return
  }
  hasPlayed = false
  setState('loading')

  // 兜底收口：没推流时 mpegts 不一定报错（连接就挂在那儿），不能一直转圈
  timer = setTimeout(() => {
    timer = null
    if (my !== seq) return
    setState(hasPlayed ? 'error' : 'offair')
    armRetry()
  }, CONNECT_TIMEOUT_MS)

  let mpegts: typeof import('mpegts.js').default
  try {
    mpegts = (await import('mpegts.js')).default
  } catch {
    if (my === seq) {
      clearTimer()
      setState('error')
    }
    return
  }
  if (my !== seq) return
  if (!mpegts.isSupported()) {
    clearTimer()
    setState('unsupported')
    return
  }
  if (!video.value) return

  const p = mpegts.createPlayer(
    { type: 'flv', isLive: true, url },
    {
      // 直播要「追帧」而不是攒够再播：默认的 stash 缓冲会累积几秒延迟
      enableStashBuffer: false,
      autoCleanupSourceBuffer: true,
      liveBufferLatencyChasing: true,
      lazyLoad: false,
    },
  ) as unknown as MpegtsPlayer
  player = p
  p.on(mpegts.Events.ERROR, () => {
    if (my !== seq) return
    clearTimer()
    // 一次都没出过画面 → 多半是没推流；播过再断 → 真断了
    setState(hasPlayed ? 'error' : 'offair')
    armRetry()
  })
  p.attachMediaElement(video.value)
  p.load()

  try {
    await p.play()
    // play() 成功不代表有画面（数据还没到它也会 resolve），
    // 继续等 video 的 playing 事件；超时兜底已经在上面挂着了
  } catch {
    // 自动播放被策略拦下：等用户点一下，不谎报在播
    if (my === seq) {
      clearTimer()
      setState('blocked')
    }
  }
}

/** 用户手动点：没 play 过就从头连，被拦住的就再叫一次 play */
async function retryPlay(): Promise<void> {
  if (!player) {
    void start()
    return
  }
  try {
    await player.play()
    setState('loading')
  } catch {
    setState('blocked')
  }
}

/** 用户手动点「重试」：重连 + 重新计时，不依赖自动重试的节奏 */
function retry(): void {
  void start()
}

onMounted(() => {
  video.value?.addEventListener('playing', onPlaying)
  void start()
})

watch(
  () => props.src,
  () => {
    void start()
  },
)

onBeforeUnmount(() => {
  seq += 1
  clearTimer()
  video.value?.removeEventListener('playing', onPlaying)
  teardown()
})
</script>

<template>
  <div class="live-player" :class="`is-${state}`">
    <video ref="video" class="live-video" muted playsinline webkit-playsinline />

    <div v-if="state === 'loading'" class="live-mask">
      <span class="uav-spin" aria-hidden="true" />
      <p>正在连接实时画面…</p>
      <p class="uav-stage-sub">未推流时会在开播后自动出画面</p>
    </div>

    <div v-else-if="state === 'blocked'" class="live-mask">
      <button class="live-play" type="button" @click="retryPlay">点击播放</button>
    </div>

    <div v-else-if="state === 'unsupported'" class="live-mask">
      <p>当前浏览器不支持此直播格式</p>
      <p class="uav-stage-sub">需要支持 MSE 的浏览器（iOS 17 起、Chrome / Edge 均可）</p>
    </div>

    <div v-else-if="state === 'offair'" class="live-mask">
      <p>画面未开播</p>
      <p class="uav-stage-sub">{{ offAirHint || '当前没有推流，开播后会自动出画面' }}</p>
      <button class="live-play" type="button" @click="retry">重试</button>
    </div>

    <div v-else-if="state === 'error'" class="live-mask">
      <p>画面中断</p>
      <button class="live-play" type="button" @click="retry">重连</button>
    </div>
  </div>
</template>
