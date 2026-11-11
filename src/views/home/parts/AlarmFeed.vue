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

/** 原 alarmFeedPages()（app.js:342-347）：feed 按 ALARM_FEED_SHOW 切页 */
const pages = computed(() => {
  const list = alarm.feed
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

/** 只停自动轮播定时器，不动 idx（拖动接管时用） */
function pause(): void {
  window.clearInterval(timer)
  window.clearTimeout(wrapTimer)
  timer = 0
  wrapTimer = 0
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

/** 轨道当前单位宽（loop 页数对应的百分比步长） */
function unitPct(): number {
  return 100 / loop.value.length
}

/** 把轨道平移到目标页（animate=false 立即定位；true 走 0.45s 吸附动画） */
function go(target: number, animate = true): void {
  window.clearTimeout(wrapTimer)
  idx.value = target
  const track = trackEl.value
  if (!track) return
  track.style.transition = animate ? 'transform 0.45s var(--ease-std)' : 'none'
  track.style.transform = `translateX(-${target * unitPct()}%)`
}

/** 原 next 的回卷分支：翻过末页后瞬间归零（app.js:391-396） */
function goNext(): void {
  go(idx.value + 1)
  if (idx.value >= pageN.value) {
    wrapTimer = window.setTimeout(() => go(0, false), 460)
  }
}

/** 原 startAlarmFeed（app.js:362-418）：铺排轨道 + 启动 4s 自动轮播 */
function start(): void {
  stop()
  const track = trackEl.value
  if (!track || pageN.value <= 1) return
  layout(track, loop.value.length)
  go(0, false)
  timer = window.setInterval(() => goNext(), 4000)
}

/** 原 restart（app.js:416-419）：只重置 4s 计时，不重铺排、不跳页 */
function restart(): void {
  window.clearInterval(timer)
  window.clearTimeout(wrapTimer)
  timer = 0
  wrapTimer = 0
  if (pageN.value <= 1) return
  timer = window.setInterval(() => goNext(), 4000)
}

/** 圆点跳页（app.js:402-407） */
function onDot(page: number): void {
  if (!trackEl.value) return
  go(page)
  restart()
}

/* ---------------------------------------------------------------------
 * 跟手滑动（2026-11 优化：从「松手才判断」升级为手指拖动即时反馈）
 *
 *   pointerdown 捕获指针并记录起点；pointermove 里实时写 translateX 让
 *   轨道贴着手指走（此时关掉 transition，避免吸附动画拖慢跟手）；松手时
 *   依「位移 + 速度」决定翻页还是回弹，再恢复 transition 做吸附动画。
 *
 *   点击/滑动区分：位移不足 CLICK_SLOP（8px）视作点击，放行子项 click
 *   打开详情；超过则视为滑动，用 dragged 标记吞掉随后的 click，避免
 *   「滑动结束正好停在某条上」误触发详情。
 * ------------------------------------------------------------------- */
const CLICK_SLOP = 8
/** 翻页需要的位移阈值：超半页或速度足够快都翻，否则回弹 */
const SWIPE_RATIO = 0.32

const dragging = ref(false)
/** 拖动中被抑制的 click 标记（拖动结束后短暂置位，吃掉接下来的一次 click） */
let suppressClick = false

let startX = 0
let startIdx = 0
let lastX = 0
let lastT = 0

function onDown(e: PointerEvent): void {
  if (pageN.value <= 1) return
  const win = e.currentTarget as HTMLElement
  win.setPointerCapture(e.pointerId)
  dragging.value = true
  suppressClick = false
  startX = lastX = e.clientX
  lastT = e.timeStamp
  startIdx = idx.value
  // 关 transition + 停在自动轮播，交给手指接管
  pause()
  const track = trackEl.value
  if (track) {
    track.style.transition = 'none'
    track.style.transform = `translateX(-${startIdx * unitPct()}%)`
  }
}

function onMove(e: PointerEvent): void {
  if (!dragging.value) return
  lastX = e.clientX
  lastT = e.timeStamp
  const dx = e.clientX - startX
  // 位移超过点击阈值即进入滑动态，之后不把松手当点击
  if (Math.abs(dx) > CLICK_SLOP) suppressClick = true
  const track = trackEl.value
  if (!track) return
  const unit = unitPct()
  const base = startIdx * unit
  track.style.transform = `translateX(${-base + (dx / (track.clientWidth || 1)) * 100}%)`
}

function onUp(e: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  const win = e.currentTarget as HTMLElement
  if (win.hasPointerCapture(e.pointerId)) win.releasePointerCapture(e.pointerId)
  const track = trackEl.value
  if (!track) {
    restart()
    return
  }
  const dx = lastX - startX
  const dt = Math.max(1, e.timeStamp - lastT)
  const vx = dx / dt // px/ms

  // 位移换算成「页」：正 = 手指右滑（回上一页），负 = 左滑（下一页）
  const pagesMoved = -(dx / (track.clientWidth || 1))
  let target = startIdx

  if (!suppressClick) {
    // 位移太小，当点击处理：吸附回原页即可（详情打开由 click 事件负责）
    target = startIdx
  } else if (pagesMoved > 0) {
    // 想翻下一页：位移过半或甩动速度足够快才翻，否则回弹
    target = pagesMoved >= SWIPE_RATIO || vx < -0.4 ? startIdx + 1 : startIdx
  } else {
    // 想回上一页
    target = -pagesMoved >= SWIPE_RATIO || vx > 0.4 ? startIdx - 1 : startIdx
  }

  // 回卷边界：多页时 loop 末尾有补页，翻到 pageN 后需无感回卷到 0
  if (target >= pageN.value) {
    target = pageN.value
    go(target, true)
    wrapTimer = window.setTimeout(() => go(0, false), 460)
  } else if (target < 0) {
    go(0, true)
  } else {
    go(target, true)
  }

  // 拖动结束后短暂抑制一次 click，防止滑动停在条目上误触发
  // （click 会在 pointerup 之后紧随派发；此处不主动清除，留给 onItemClick
  //   消费一次后复位，避免 setTimeout 与 click 的派发顺序竞争）
  restart()
}

/** 原 homePanels 委托的 [data-alarm] 分支 —— 现直达详情 */
function onItemClick(id: string): void {
  if (suppressClick) {
    suppressClick = false
    return
  }
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
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
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
