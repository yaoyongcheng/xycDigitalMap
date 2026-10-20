<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import SmartImg from '@/components/ui/SmartImg.vue'
import { ALARM_FEED_SHOW } from '@/data/config'
import { useAlarmStore } from '@/stores/alarm'
import { alarmTone } from '@/utils/alarmTone'

/**
 * 预警竖向轮播
 *
 * 对应原 js/app.js:275-286 renderAlarmFeed() + 288-292 stopAlarmFeed()
 * + 294-316 startAlarmFeed()。
 *
 * 原版的启动时机由外部控制（switchTab 与 renderHomePanel 里的
 * requestAnimationFrame(startAlarmFeed)）。组件化后改为面板挂载即启动、
 * 卸载即停止 —— 因为该轮播只存在于安全管理面板中，两者等价。
 *
 * 滚动靠逐帧写 track.style.transform 驱动，故保留直接 DOM 操作（这是动画，
 * 不是状态）。但**尺寸一律不靠实测**：窗口高度交给 CSS，滚动步长读 CSS
 * 变量 —— 原因见 feedItemHeight() 的注释。
 *
 * 原版缺陷（已修）：回卷用的 setTimeout 句柄未保存，stopAlarmFeed 清不掉
 * （app.js:309）。迁移版在 onUnmounted 里补了 clearTimeout(wrapTimer)。
 */
const alarm = useAlarmStore()

const emit = defineEmits<{ open: [id: string] }>()

/** 原 list.concat(extra)：多余条数时把前 N 条再追加一遍，用于无缝回卷 */
const list = computed(() => alarm.latest)
const extra = computed(() => (list.value.length > ALARM_FEED_SHOW ? list.value.slice(0, ALARM_FEED_SHOW) : []))
const items = computed(() => list.value.concat(extra.value))

const trackEl = ref<HTMLElement | null>(null)

/**
 * 轮播位置（原 js/app.js:261 的顶层 let alarmFeedIdx）。
 * 它只被本组件的动画读写，不跨组件共享，故收为组件本地状态。
 */
const idx = ref(0)

let timer = 0
let wrapTimer = 0

function stop(): void {
  window.clearInterval(timer)
  timer = 0
  idx.value = 0
}

/**
 * 滚动步长 = 单条高度，取自 CSS 变量 --feed-item-h（app.css 的 .alarm-feed 下）。
 *
 * 必须与窗口高度同源：窗口是 calc(var(--feed-item-h) * 3)，步长也必须取同一个
 * 变量。若改成实测 item.offsetHeight，两者基准可能差之毫厘（亚像素、边框、
 * 字体回退），轨道与窗口就会错位 —— 表现为窗口里露出半截条目和底部空行。
 * 所以这里只认变量，读不到就交给调用方重试，不做实测兜底。
 */
function feedItemHeight(): number {
  const track = trackEl.value
  if (!track) return 0
  const n = Number.parseFloat(getComputedStyle(track).getPropertyValue('--feed-item-h'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * @param retry 已重试次数。样式表尚未就绪时变量读不到，此时重试而不是放弃
 *              （放弃会让轮播彻底不动），也不是退回实测（会让轨道错位）。
 */
function start(retry = 0): void {
  stop()
  const track = trackEl.value
  if (!track || list.value.length <= ALARM_FEED_SHOW) return
  const h = feedItemHeight()
  if (!h) {
    if (retry < 20) window.setTimeout(() => start(retry + 1), 100)
    return
  }
  // 窗口高度由 CSS 负责（.alarm-feed-win 的 height），此处不再写内联值
  track.style.transform = 'translateY(0)'
  timer = window.setInterval(() => {
    idx.value += 1
    track.style.transition = 'transform 0.45s ease'
    track.style.transform = `translateY(${-idx.value * h}px)`
    if (idx.value >= list.value.length) {
      wrapTimer = window.setTimeout(() => {
        track.style.transition = 'none'
        track.style.transform = 'translateY(0)'
        idx.value = 0
      }, 460)
    }
  }, 4000)
}

/** 原 homePanels 委托的 [data-alarm] 分支（app.js:976-980）—— 现直达详情 */
function onItemClick(id: string): void {
  emit('open', id)
}

/** 键盘可达（原先是纯 div + role，键盘用户完全无法操作） */
function onKey(e: KeyboardEvent, id: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onItemClick(id)
  }
}

onMounted(() => {
  start()
})

onUnmounted(() => {
  stop()
  window.clearTimeout(wrapTimer)
})
</script>

<template>
  <div class="home-chart-card alarm-feed">
    <div class="alarm-feed-win">
      <div class="alarm-feed-track" id="alarmFeedTrack" ref="trackEl">
        <div
          v-for="(a, i) in items"
          :key="`${a.id}-${i}`"
          class="alarm-feed-item"
          :data-alarm="a.id"
          :data-tone="alarmTone(a.type)"
          role="button"
          tabindex="0"
          @click="onItemClick(a.id)"
          @keydown="onKey($event, a.id)"
        >
          <SmartImg class="alarm-feed-pic" :src="a.img" :alt="a.type" />
          <div class="alarm-feed-meta">
            <strong>{{ a.title }}<i v-if="i === 0" class="feed-live" aria-hidden="true"></i></strong>
            <p>{{ a.desc }}</p>
          </div>
          <span class="alarm-feed-time">{{ a.rel }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
