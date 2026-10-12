<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { ALARM_FEED_SHOW } from '@/data/config'
import { useAlarmStore } from '@/stores/alarm'

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
 * 动画需要读取 .alarm-feed-item 的真实高度并写 style，故保留直接 DOM 操作
 * （这是测量与逐帧变换，不是状态）。
 *
 * 已保留的原版缺陷：轮播回卷用的 setTimeout 句柄未保存，
 * stopAlarmFeed 清不掉它（app.js:309）。
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

function start(): void {
  stop()
  const track = trackEl.value
  const win = track?.parentElement
  if (!track || !win || list.value.length <= ALARM_FEED_SHOW) return
  const item = track.querySelector('.alarm-feed-item') as HTMLElement | null
  if (!item) return
  const h = item.offsetHeight
  win.style.height = h * ALARM_FEED_SHOW + 'px'
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

/** 原 homePanels 委托的 [data-alarm] 分支（app.js:976-980）跳到巡检列表 */
function onItemClick(id: string): void {
  emit('open', id)
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
          role="button"
          @click="onItemClick(a.id)"
        >
          <img class="alarm-feed-pic" :src="a.img" :alt="a.type" />
          <div class="alarm-feed-meta">
            <strong>{{ a.title }}</strong>
            <p>{{ a.desc }}</p>
          </div>
          <span class="alarm-feed-time">{{ a.rel }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
