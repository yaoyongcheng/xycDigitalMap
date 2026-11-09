<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import SmartImg from '@/components/ui/SmartImg.vue'
import { ALARM_FEED_SHOW, alarmSrcOf } from '@/data/config'
import { useAlarmStore } from '@/stores/alarm'
import { alarmTone } from '@/utils/alarmTone'

/**
 * 预警横滑分页轮播（2026-11 设计稿 gx2 版同步）
 *
 * 对应原 js/app.js:322-437 —— 与旧版（竖向单条步进）的差别：
 *   - 3 条/页横向分页，轨道 translateX，末页后补首页实现无缝循环；
 *   - 页圆点（可点击跳页）+ 左右滑动切换（阈值 36px）；
 *   - 手动操作后重置 4s 自动轮播计时。
 *
 * 组件化后改为面板挂载即启动、卸载即停止（原版由 switchTab 手动启停，
 * 该轮播只存在于安全管理面板中，两者等价）。
 *
 * 滚动靠逐帧写 track.style.transform 驱动，故保留直接 DOM 操作（这是动画，
 * 不是状态）。轨道位移用百分比（idx * 100/total%），不依赖条目实测尺寸 ——
 * 竖版当年踩过的「实测与 CSS 基准差之毫厘」的坑在横版天然不存在。
 */
const alarm = useAlarmStore()

const emit = defineEmits<{ open: [id: string] }>()

/** 原 alarmFeedPages()（app.js:342-347）：latest 按 ALARM_FEED_SHOW 切页 */
const pages = computed(() => {
  const list = alarm.latest
  const n = Math.max(1, Math.ceil(list.length / ALARM_FEED_SHOW))
  return Array.from({ length: n }, (_, p) => list.slice(p * ALARM_FEED_SHOW, (p + 1) * ALARM_FEED_SHOW))
})

/** 原 loop = pages.concat([pages[0]])：多页时补首页，翻到末页再平移一页后无感回卷 */
const loop = computed(() => (pages.value.length > 1 ? pages.value.concat([pages.value[0]]) : pages.value))

const pageN = computed(() => pages.value.length)

const trackEl = ref<HTMLElement | null>(null)

/** 原 js/app.js:321 的顶层 let alarmFeedIdx —— 只被本组件读写，收为本地状态 */
const idx = ref(0)

let timer = 0
let wrapTimer = 0

function stop(): void {
  window.clearInterval(timer)
  window.clearTimeout(wrapTimer)
  timer = 0
  wrapTimer = 0
  idx.value = 0
}

/** 轨道宽 = 页数 × 100%，每页占 100/页数 %（原 startAlarmFeed 的宽度铺排） */
function layout(track: HTMLElement, total: number): number {
  const unit = 100 / total
  track.style.width = `${total * 100}%`
  for (const p of Array.from(track.children) as HTMLElement[]) {
    p.style.flex = `0 0 ${unit}%`
    p.style.width = `${unit}%`
  }
  return unit
}

/** 原 paintDots + go 的合并（app.js:377-387） */
function go(unit: number, target: number, animate = true): void {
  window.clearTimeout(wrapTimer)
  idx.value = target
  const track = trackEl.value
  if (!track) return
  track.style.transition = animate ? 'transform 0.45s ease' : 'none'
  track.style.transform = `translateX(-${target * unit}%)`
}

/** 原 next 的回卷分支：翻过末页后瞬间归零（app.js:391-396） */
function goNext(unit: number): void {
  go(unit, idx.value + 1)
  if (idx.value >= pageN.value) {
    wrapTimer = window.setTimeout(() => go(unit, 0, false), 460)
  }
}

/** 原 startAlarmFeed（app.js:362-418）：铺排轨道 + 启动 4s 自动轮播 */
function start(): void {
  stop()
  const track = trackEl.value
  if (!track || pageN.value <= 1) return
  const unit = layout(track, loop.value.length)
  go(unit, 0, false)
  timer = window.setInterval(() => goNext(unit), 4000)
}

/** 圆点跳页（app.js:402-407） */
function onDot(page: number): void {
  const track = trackEl.value
  if (!track) return
  go(100 / loop.value.length, page)
  start()
}

/** 左右滑动切换，阈值 36px（app.js:409-418） */
let sx = 0
function onDown(e: PointerEvent): void {
  sx = e.clientX
}
function onUp(e: PointerEvent): void {
  const dx = e.clientX - sx
  if (Math.abs(dx) < 36) return
  const unit = 100 / loop.value.length
  if (dx < 0) {
    goNext(unit)
  } else {
    go(unit, (idx.value - 1 + pageN.value) % pageN.value)
  }
  start()
}

/** 原 homePanels 委托的 [data-alarm] 分支 —— 现直达详情 */
function onItemClick(id: string): void {
  emit('open', id)
}

/** 键盘可达 */
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
})
</script>

<template>
  <div class="home-chart-card alarm-feed">
    <div
      class="alarm-feed-win"
      @pointerdown="onDown"
      @pointerup="onUp"
    >
      <div class="alarm-feed-track" ref="trackEl">
        <div v-for="(pg, p) in loop" :key="p" class="alarm-feed-page">
          <div
            v-for="a in pg"
            :key="a.id"
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
              <div class="alarm-feed-hd">
                <strong>{{ a.title }}</strong>
                <span class="alarm-src" :class="`alarm-src-${a.src}`">{{ alarmSrcOf(a.src).tag }}</span>
              </div>
              <p>{{ a.desc }}</p>
            </div>
            <span class="alarm-feed-time">{{ a.rel }}</span>
          </div>
        </div>
      </div>
    </div>
    <div v-if="pageN > 1" class="alarm-feed-dots">
      <button
        v-for="p in pageN"
        :key="p"
        class="alarm-feed-dot"
        :class="{ on: idx % pageN === p - 1 }"
        type="button"
        :data-feed-page="p - 1"
        :aria-label="`第${p}页`"
        @click="onDot(p - 1)"
      ></button>
    </div>
  </div>
</template>
