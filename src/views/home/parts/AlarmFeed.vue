<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import SmartImg from '@/components/ui/SmartImg.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import ThumbRing from '@/components/ui/ThumbRing.vue'
import { ALARM_FEED_SHOW, alarmSrcOf } from '@/data/config'
import { FEED_FALLBACK_N, useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { alarmTone } from '@/utils/alarmTone'
import { mergeAlarmEntries, type AlarmEntry } from '@/utils/alarmMerge'
import { revealThumb } from '@/utils/thumbReveal'
import { relTime } from '@/utils/videoAlarm'

/**
 * 预警横滑分页轮播（2026-11 设计稿 gx2 版同步）
 *
 * 对应原 js/app.js:322-437 —— 与旧版（竖向单条步进）的差别：
 *   - 3 条/页横向分页，轨道 translateX；
 *   - **首尾各补一张副本页，左右两个方向都能无缝循环**（2026-11 双向循环改造，
 *     详见 `slides` 的注释）；
 *   - 页圆点（可点击跳页）+ 左右滑动切换（位移过阈值或甩动速度够快）；
 *   - 手动操作后重置 4s 自动轮播计时。
 *
 * 组件化后改为面板挂载即启动、卸载即停止（原版由 switchTab 手动启停，
 * 该轮播只存在于安全管理面板中，两者等价）。
 *
 * 滚动靠逐帧写 track.style.transform 驱动，故保留直接 DOM 操作（这是动画，
 * 不是状态）。轨道位移用百分比（idx * 100/total%），不依赖条目实测尺寸 ——
 * 竖版当年踩过的「实测与 CSS 基准差之毫厘」的坑在横版天然不存在。
 *
 * 下标语义（改这块前必须搞清楚，否则很容易出现「滑到空白页」）：
 *   `idx` 是**轨道下标**，不是页序号。多页时轨道 = [末页副本] + 真实页 + [首页副本]，
 *   真实第 0 页在轨道下标 1 上；下标 0 与 pageN+1 是副本，只能作为过渡终点，
 *   停稳后必须 `normalize()` 归位到等价的真实页。
 */
const alarm = useAlarmStore()
const drone = useDroneAlarmStore()
const auth = useAuthStore()

/** 点一条：带上来源，由面板决定进哪个详情（监控 → 报警详情 / 无人机 → 工单详情） */
const emit = defineEmits<{ open: [kind: 'monitor' | 'drone', id: string] }>()

/** 轮播卡片：两类预警收敛成同一套渲染字段，版式与各自的字段映射都不变 */
interface FeedCard {
  key: string
  kind: 'monitor' | 'drone'
  id: string
  title: string
  /** 来源徽标文案与配色（监控「视频监控」/ 无人机「无人机」） */
  badge: string
  badgeCls: string
  desc: string
  rel: string
  /** 风险分档（只有监控侧有；无人机不设，保持原有属性语义） */
  tone: string
}

/**
 * 卡片列表 = 今日两类预警合并（按时间倒序）。
 *
 * 与统计卡（`SafetyPanel` 的「今日预警数」）走同一个 `mergeAlarmEntries`，
 * 所以「数字写 N、列表 N 行」永远成立。今日一条都没有时才退到两侧最近几条
 * （原 `alarm.feed` 的兜底语义）—— 判断放在合并**之后**：只有两类今日都为空
 * 才退，否则会出现「今日无人机 + 昨日视频」混在一条时间线上。
 */
const cards = computed<FeedCard[]>(() => {
  const today = mergeAlarmEntries(alarm.latest, drone.todayItems)
  const list = today.length
    ? today
    : mergeAlarmEntries(
        alarm.liveAlarms.slice(0, FEED_FALLBACK_N),
        drone.items.slice(0, FEED_FALLBACK_N),
      ).slice(0, FEED_FALLBACK_N)
  return list.map(toCard)
})

/** 一行时间线信封 → 轮播卡片（字段来源见 `utils/alarmMerge.ts` 与两侧 store） */
function toCard(e: AlarmEntry): FeedCard {
  if (e.work) {
    const w = e.work
    return {
      key: e.key,
      kind: 'drone',
      id: w.id,
      title: w.title || '识别预警',
      badge: alarmSrcOf('drone').tag,
      badgeCls: 'alarm-src-drone',
      desc: w.jobName || w.projectName || '—',
      rel: drone.relOf(w),
      tone: '',
    }
  }
  const a = e.alarm!
  return {
    key: e.key,
    kind: 'monitor',
    id: a.id,
    title: a.title,
    badge: alarmSrcOf(a.src).tag,
    badgeCls: `alarm-src-${a.src}`,
    desc: a.desc,
    // 与 `stores/alarm.ts::withRel` 同一口径：兜底那批（最近 6 条）不是今日集合，
    // 存着的 `rel` 是映射时算的，这里重算一次才不会停在一小时前
    rel: relTime(a.at) || a.rel,
    tone: alarmTone(a.type),
  }
}

/** 这一格该铺哪张图：两侧各看各的 store（id 命名空间本来就不同） */
function thumbOf(c: FeedCard): string {
  return c.kind === 'drone' ? drone.thumbOf(c.id) : alarm.thumbOf(c.id)
}

/**
 * 卡片左图：优先用「该条详情页里的同一张抓拍图」缩略图。
 *
 * 轮播每页 3 条 × 多页，一次全量请求太重；`revealThumb` 只给滑到眼前
 * （±240px）的那几张发请求。取不到时铺**统一占位图标**（`.alarm-tile`：
 * 灰底 + 深灰摄像机 / 无人机），不再用 `img/alarm-*.webp` 分类示意图 —— 那张图
 * 长得像真实现场，会被误读成当次抓拍（2026-11-19 现场反馈）。
 * 取图过程中图标外圈有一圈真实下载进度（`ThumbRing`）。
 */
function bindThumb(el: unknown, c: FeedCard): void {
  if (!(el instanceof Element)) return
  // 已经有图（内存命中 / 预取先到）：不必再登记观察器
  if (thumbOf(c)) return
  revealThumb(el, () => {
    if (c.kind === 'drone') drone.ensureThumb(c.id)
    else if (auth.token) alarm.ensureThumb(auth.token, c.id)
  })
}

/** 原 alarmFeedPages()（app.js:342-347）：合并后的列表按 ALARM_FEED_SHOW 切页 */
const pages = computed(() => {
  const list = cards.value
  const n = Math.max(1, Math.ceil(list.length / ALARM_FEED_SHOW))
  return Array.from({ length: n }, (_, p) => list.slice(p * ALARM_FEED_SHOW, (p + 1) * ALARM_FEED_SHOW))
})

const pageN = computed(() => pages.value.length)

/**
 * 轨道页序 = [末页副本] + 真实页 + [首页副本]
 *
 * 旧版（原 app.js 移植）只在**末尾**补一张首页副本：往后翻能绕回开头，但往前翻
 * 到第一页就顶死了 —— 手指右滑轨道没有可露出的内容，`target < 0` 被夹回 0，
 * 表现为「卡在第一页怎么滑都不动」。两侧各补一张副本后，任何一个方向拖到头，
 * 相邻位置都还有一页内容可以跟手；松手停在副本上后 `normalize()` 瞬间归位到
 * 等价的真实页 —— 两页内容完全相同，肉眼看不到跳变。
 *
 * 副本页带 `data-clone`、`aria-hidden` 与 `tabindex="-1"`：它们只做占位与过渡，
 * 不进无障碍树、不占 Tab 焦点位，也不会让同一张抓拍在轮播里多占两次键盘顺序。
 * 数据上仍是同一条报警，因此副本上的点击与真实页等价（打开同一个详情）。
 */
const slides = computed(() => {
  const list = pages.value
  const real = list.map((items, i) => ({ key: `p${i}`, items, clone: false }))
  if (list.length <= 1) return real
  return [
    { key: 'clone-last', items: list[list.length - 1]!, clone: true },
    ...real,
    { key: 'clone-first', items: list[0]!, clone: true },
  ]
})

/** 真实第 0 页在轨道里的下标（单页没有副本，就是 0） */
const homeIdx = computed(() => (pageN.value > 1 ? 1 : 0))

/** 轨道下标是否落在副本页上（0 = 末页副本，pageN+1 = 首页副本） */
function isClone(i: number): boolean {
  return pageN.value > 1 && (i <= 0 || i > pageN.value)
}

/** 轨道下标 → 圆点序号（副本页按等价真实页算，圆点才不会在过渡时"跳一下"） */
function dotOf(i: number): number {
  const n = pageN.value
  if (n <= 1) return 0
  return (((i - 1) % n) + n) % n
}

const trackEl = ref<HTMLElement | null>(null)

/** 原 js/app.js:321 的顶层 let alarmFeedIdx —— 只被本组件读写，收为本地状态 */
const idx = ref(homeIdx.value)

let timer = 0
let wrapTimer = 0

/** 吸附动画 0.45s，回卷留 10ms 余量等它播完 */
const WRAP_DELAY = 460

function stop(): void {
  window.clearInterval(timer)
  window.clearTimeout(wrapTimer)
  timer = 0
  wrapTimer = 0
  idx.value = homeIdx.value
}

/** 只停自动轮播定时器，不动 idx、也不取消回卷（拖动接管时用，回卷由 normalize 收尾） */
function pause(): void {
  window.clearInterval(timer)
  timer = 0
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

/** 轨道当前单位宽（slides 页数对应的百分比步长） */
function unitPct(): number {
  return 100 / slides.value.length
}

/**
 * 停在副本页时瞬间换成等价的真实页。
 *
 * 计时器路径与拖动路径都会调它：前者是吸附动画播完后回卷，后者是手指按下时
 * 先把位置归位 —— 否则从首页副本（下标 pageN+1）继续往前滑会滑到下标
 * pageN+2，那里根本没有页，轨道直接露出空白（「滑不动」的另一种表现）。
 * 因为副本与真实页内容逐像素相同，这一步看不出任何跳变。
 */
function normalize(): void {
  const n = pageN.value
  if (n <= 1) return
  if (idx.value <= 0) go(n, false)
  else if (idx.value > n) go(homeIdx.value, false)
}

/** 吸附动画结束后回卷（等它播完再跳，否则会看到"倒回去"的残影） */
function scheduleWrap(): void {
  window.clearTimeout(wrapTimer)
  wrapTimer = window.setTimeout(() => {
    wrapTimer = 0
    normalize()
  }, WRAP_DELAY)
}

/** 把轨道平移到目标下标（animate=false 立即定位；true 走 0.45s 吸附动画） */
function go(target: number, animate = true): void {
  window.clearTimeout(wrapTimer)
  wrapTimer = 0
  idx.value = target
  const track = trackEl.value
  if (!track) return
  track.style.transition = animate ? 'transform 0.45s var(--ease-std)' : 'none'
  track.style.transform = `translateX(-${target * unitPct()}%)`
  // 停在副本上才需要回卷；真实页之间的正常翻页不排这个计时器
  if (animate && isClone(target)) scheduleWrap()
}

/** 自动轮播下一张：先把可能残留的副本位置归位，再前进一格 */
function goNext(): void {
  normalize()
  go(idx.value + 1)
}

/** 原 startAlarmFeed（app.js:362-418）：铺排轨道 + 启动 4s 自动轮播 */
function start(): void {
  stop()
  const track = trackEl.value
  if (!track) return
  // 单页也要铺一次：feed 从多页缩到一页时，上一轮的 300% 轨道宽会留在行内样式里
  layout(track, slides.value.length)
  go(homeIdx.value, false)
  if (pageN.value <= 1) return
  timer = window.setInterval(() => goNext(), 4000)
}

/**
 * 原 restart（app.js:416-419）：只重置 4s 计时，不重铺排、不跳页。
 *
 * **不能顺手清 wrapTimer** —— 旧实现在这里 `clearTimeout(wrapTimer)`，而调用方
 * （onUp）刚排完回卷就被清掉，轨道永久停在副本页上，下一次滑动直接进空白区。
 */
function restart(): void {
  window.clearInterval(timer)
  timer = 0
  if (pageN.value <= 1) return
  timer = window.setInterval(() => goNext(), 4000)
}

/**
 * 圆点跳页的目标下标。
 *
 * 首末页各有一个等价副本，取路径更短的那个 —— 否则从第 1 页点最后一页，
 * 会一路反着扫过所有中间页，看着像"倒带"。
 */
function nearestIndex(page: number): number {
  const n = pageN.value
  if (n <= 1) return 0
  const cands = [page + 1]
  if (page === 0) cands.push(n + 1)
  if (page === n - 1) cands.push(0)
  return cands.reduce((best, c) => (Math.abs(c - idx.value) < Math.abs(best - idx.value) ? c : best))
}

/** 圆点跳页（app.js:402-407） */
function onDot(page: number): void {
  if (!trackEl.value) return
  go(nearestIndex(page))
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
/** 本帧采样点与上一帧采样点：松手速度取这两点之差，不能用总位移除以总时长 */
let lastX = 0
let lastT = 0
let prevX = 0
let prevT = 0

function onDown(e: PointerEvent): void {
  if (pageN.value <= 1) return
  const win = e.currentTarget as HTMLElement
  win.setPointerCapture(e.pointerId)
  dragging.value = true
  suppressClick = false
  // 停在副本页时先归位：否则从首页副本继续往前滑会滑到不存在的下标
  normalize()
  startX = lastX = prevX = e.clientX
  lastT = prevT = e.timeStamp
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
  const dx = e.clientX - startX
  // 位移超过点击阈值即进入滑动态，之后不把松手当点击
  if (Math.abs(dx) > CLICK_SLOP) suppressClick = true
  // 采样滚动：上一帧变成 prev，本帧记为 last（顺序不能反，vx 全靠它）
  prevX = lastX
  prevT = lastT
  lastX = e.clientX
  lastT = e.timeStamp
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
  /*
   * 甩动速度取「最后两个采样点」之差，不是全程平均：
   *   · 全程平均会把「慢慢拖半屏再松手」算成慢速，判成回弹，跟手感很差；
   *   · 旧实现更糟 —— `lastT` 在 onMove 里每帧刷新，却拿它当起始时刻，
   *     `dt` 恒被 max(1, …) 兜成 1ms，vx 放大成几十 px/ms，于是**任何**
   *     轻微拖动都被判成快速甩动，翻不翻页完全不由位移决定。
   * 按下后一次都没移动时 last 与 prev 是同一个点，vx = 0，自然走回弹分支。
   */
  const vx = (lastX - prevX) / Math.max(1, lastT - prevT) // px/ms

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

  /*
   * 目标下标：首尾各有一张副本页，所以 startIdx ± 1 永远落在有内容的格子上 ——
   * 从真实首页（下标 1）往右滑落到下标 0（末页副本），从真实末页往左滑落到
   * pageN+1（首页副本），再由 go() 里的回卷把它换成等价的真实页。
   * 旧版在这一步把越界目标夹成 0 / pageN，回卷计时器又被 restart() 清掉，
   * 于是往前顶死、往后滑进空白 —— 正是「卡在某一页滑不动」的来源。
   */
  go(target, true)

  // 拖动结束后短暂抑制一次 click，防止滑动停在条目上误触发
  // （click 会在 pointerup 之后紧随派发；此处不主动清除，留给 onItemClick
  //   消费一次后复位，避免 setTimeout 与 click 的派发顺序竞争）
  restart()
}

/** 原 homePanels 委托的 [data-alarm] 分支 —— 现直达详情（无人机走工单详情） */
function onItemClick(c: FeedCard): void {
  if (suppressClick) {
    suppressClick = false
    return
  }
  emit('open', c.kind, c.id)
}

/** 键盘可达 */
function onKey(e: KeyboardEvent, c: FeedCard): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onItemClick(c)
  }
}

onMounted(() => {
  start()
})

/**
 * 页数变化时重铺轨道。
 *
 * feed 会在组件挂载后继续变：登录成功补拉、面板刷新、跨天清空「今天」那一批。
 * 页数一变，轨道总宽与每页的 flex 都得重算，否则内联样式还停在旧页数上 ——
 * 表现是某一页特别宽、滑过去就露空白。`flush: 'post'` 保证量的是新 DOM。
 */
watch(
  () => slides.value.length,
  () => start(),
  { flush: 'post' },
)

onUnmounted(() => {
  stop()
})
</script>

<template>
  <div class="home-chart-card alarm-feed">
    <div v-if="!cards.length" class="chart-empty">暂无报警记录</div>
    <div
      v-else
      class="alarm-feed-win"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <div class="alarm-feed-track" ref="trackEl">
        <div
          v-for="s in slides"
          :key="s.key"
          class="alarm-feed-page"
          :data-clone="s.clone ? 'true' : undefined"
          :aria-hidden="s.clone ? 'true' : undefined"
        >
          <div
            v-for="c in s.items"
            :key="c.key"
            :ref="(el) => bindThumb(el, c)"
            class="alarm-feed-item"
            :data-alarm="c.kind === 'monitor' ? c.id : undefined"
            :data-wo="c.kind === 'drone' ? c.id : undefined"
            :data-tone="c.tone || undefined"
            role="button"
            :tabindex="s.clone ? -1 : 0"
            @click="onItemClick(c)"
            @keydown="onKey($event, c)"
          >
            <SmartImg
              v-if="thumbOf(c)"
              class="alarm-feed-pic"
              :src="thumbOf(c)"
              :alt="c.title"
            />
            <span v-else class="alarm-feed-pic alarm-tile" aria-hidden="true">
              <SvgIcon :name="c.kind === 'drone' ? 'drone' : 'work-cam'" />
              <!-- 无人机侧的进度由它自己的 store 提供；监控侧不传，仍回落到报警 store -->
              <ThumbRing
                v-if="c.kind === 'drone'"
                :id="c.id"
                :busy="drone.thumbBusyOf(c.id)"
                :pct="drone.thumbPctOf(c.id)"
              />
              <ThumbRing v-else :id="c.id" />
            </span>
            <div class="alarm-feed-meta">
              <div class="alarm-feed-hd">
                <strong>{{ c.title }}</strong>
                <span class="alarm-src" :class="c.badgeCls">{{ c.badge }}</span>
              </div>
              <p>{{ c.desc }}</p>
            </div>
            <span class="alarm-feed-time">{{ c.rel }}</span>
          </div>
        </div>
      </div>
    </div>
    <div v-if="pageN > 1" class="alarm-feed-dots">
      <button
        v-for="p in pageN"
        :key="p"
        class="alarm-feed-dot"
        :class="{ on: dotOf(idx) === p - 1 }"
        type="button"
        :data-feed-page="p - 1"
        :aria-label="`第${p}页`"
        @click="onDot(p - 1)"
      ></button>
    </div>
  </div>
</template>
