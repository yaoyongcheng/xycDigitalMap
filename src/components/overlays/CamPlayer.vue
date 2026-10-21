<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

import BackBar from '@/components/ui/BackBar.vue'
import DayPickChips from '@/components/ui/DayPickChips.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import SmartImg from '@/components/ui/SmartImg.vue'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { addDays, camStampBrief, formatCamDate, startOfDay } from '@/utils/date'
import { useSlideOverlay } from '@/utils/slideOverlay'

/**
 * 监控播放器全屏层
 *
 * 对应原 index.html:68-122 + 全部 cam 事件处理（app.js:1225-1317）。
 *
 * 含两个视图：
 *   #camLiveView  直播（camMode === 'live' 时无 .hide）
 *   #camShotsView 历史抓拍（camMode === 'shots' 时无 .hide）
 * 以及内嵌的抓拍大图弹层 #camShotPop。
 *
 * 注意 applyCam(id, keepLive) 的 keepLive 取自 #camPlayer 是否带 .live
 * （app.js:1264），所以点击点位芯片时是否保持直播态取决于当前 .live。
 */
const cam = useCamStore()
const shell = useShellStore()

/** 全屏层转场（进入左滑入 / 返回右滑出），见 utils/slideOverlay.ts */
const playerEl = ref<HTMLElement | null>(null)
const overlay = useSlideOverlay(() => playerEl.value)
watch(() => cam.isOpen, (open) => overlay.syncOpen(open), { flush: 'post' })

/**
 * 画面时间戳（2026-10 视觉改造·第五批）
 *
 * 原先直接用 camStamp() 的「2026-10-21 星期二 08:39:05 4G」：星期与 4G 是
 * 早期假设备外壳的残留（内置假状态栏早已移除），11px 挤在左上角还压着
 * 顶栏底边。现在只留日期 + 时钟，并拆成两段：日期压暗一档、时钟等宽，
 * 当成一枚画面角标而不是一行 OSD 文本。
 */
const stamp = ref(camStampBrief())
let timer = 0

const stampParts = computed(() => {
  const [date, clock] = stamp.value.split(' ')
  return { date, clock }
})

function refreshStamp(): void {
  stamp.value = camStampBrief()
}

/*
 * 原 tick()（app.js:1720-1722）在播放器打开时每秒刷新其时间戳。
 *
 * 定时器只在播放器可见时存在：本组件常驻 DOM（覆盖层靠 class 切换），
 * 若在 onMounted 就起 1s interval，回调里再判断 cam.isOpen，
 * 等于全天候空转（每次都是一次无意义的闭包调用 + ref 读取）。
 */
function startTick(): void {
  if (timer) return
  timer = window.setInterval(refreshStamp, 1000)
}

function stopTick(): void {
  if (!timer) return
  window.clearInterval(timer)
  timer = 0
}

watch(
  () => cam.isOpen,
  (open) => {
    if (open) {
      // 先立刻对齐一次，避免沿用上一次打开时的旧时间戳整秒
      refreshStamp()
      startTick()
    } else {
      stopTick()
    }
  },
)

onUnmounted(stopTick)

/** 原 js/app.js:1225-1228 —— 点播放按钮进入 .live 并刷新时间戳 */
function onPlay(): void {
  cam.isLive = true
  refreshStamp()
}

/**
 * 原 js/app.js:1230-1249 —— 返回键的四级优先：
 *   ① 关闭抓拍大图 ② 收起日历 ③ 退出抓拍视图 ④ 退出横屏 ⑤ 关闭播放器
 */
function onBack(): void {
  if (cam.shotPopOpen) {
    cam.closeShotPop()
    return
  }
  if (cam.camCalOpen) {
    cam.camCalOpen = false
    return
  }
  if (cam.camMode === 'shots') {
    cam.camCalOpen = false
    cam.camMode = 'live'
    return
  }
  if (shell.isLand) {
    cam.setCamLand(false)
    return
  }
  // ⑤ 真正关闭播放器：先向右滑出，动画结束再落状态
  overlay.leave(() => {
    cam.closeCam()
    // 若本次监控是从全屏地图的撒点进来的，回到全屏地图而非首页
    shell.backToMapLand()
  })
}

/** 原 js/app.js:1251-1256 */
function onShots(): void {
  cam.camShotDate = startOfDay(new Date())
  cam.camCalOpen = false
  cam.showCamMode('shots')
}

/** 抓拍视图 → 直播视图（详情见模板中「返回直播」按钮的注释） */
function onBackLive(): void {
  cam.camCalOpen = false
  cam.closeShotPop()
  cam.showCamMode('live')
}

/** 原 js/app.js:1258-1260 */
function onLandToggle(): void {
  cam.setCamLand(!shell.isLand)
}

/** 原 js/app.js:1262-1265 —— keepLive 取自当前 .live */
function onChip(id: string): void {
  cam.applyCam(id, cam.isLive)
}

/** 原 js/app.js:1267-1279 */
function onDayPick(day: number): void {
  cam.camCalOpen = false
  cam.camShotDate = addDays(new Date(), -day)
}

function onCalToggle(): void {
  if (cam.camCalOpen) {
    cam.camCalOpen = false
    return
  }
  // 原 showCamCal()（app.js:1138-1142）—— 展开时把月份对齐到选中日所在月
  cam.camCalMonth = startOfDay(new Date(cam.camShotDate.getFullYear(), cam.camShotDate.getMonth(), 1))
  cam.camCalOpen = true
}

/** 原 js/app.js:1293-1300 */
function onCalSelect(d: Date): void {
  cam.camShotDate = startOfDay(d)
  cam.camCalOpen = false
}

/** 原 js/app.js:1302-1312 */
function onShotClick(i: number): void {
  const shot = cam.camShots[i]
  if (!shot) return
  cam.openShotPop(i)
}

/** 原 js/app.js:1315-1316 关闭大图只移除 .open */
function onShotClose(): void {
  cam.closeShotPop()
}

const currentShot = computed(() => cam.camShots[cam.shotPopIdx])

/** 原 camShotMeta.textContent = camName + 日期 + 时间 */
const shotMeta = computed(() => {
  const s = currentShot.value
  if (!s) return ''
  return `${cam.currentCam.name}  ${formatCamDate(cam.camShotDate)}  ${s.time}`
})

const shotLabel = computed(() => formatCamDate(cam.camShotDate))

const landText = computed(() => (shell.isLand ? '退出全屏' : '全屏'))

/**
 * 画面左上角的当前点位标识（2026-10 交互优化新增）。
 *
 * 原版把 18 个点位的 img 统一改成了同一张图（见 cam.ts 的 Object.assign），
 * 于是「切换点位」在视觉上完全没有变化 —— 用户点完芯片无法确认到底切没
 * 切成功。这里把点位名与分组直接压在画面上，作为切换结果的显式回执。
 * 接入真实点位流后画面本身会变，这个标识依然有用（点位名比画面更好认）。
 */
const stageTag = computed(() => `${cam.currentCam.group} · ${cam.currentCam.name}`)

/** 顶部标题随视图变化：抓拍视图下不再显示「视频监控」 */
const barTitle = computed(() => (cam.camMode === 'shots' ? '历史抓拍' : '视频监控'))
</script>

<template>
  <div
    ref="playerEl"
    class="cam-player"
    id="camPlayer"
    :class="{ open: cam.isOpen, live: cam.isLive, 'is-land': shell.isLand }"
    :hidden="!cam.isOpen"
    :aria-hidden="!cam.isOpen"
  >
    <BackBar :title="barTitle" back-id="btnCamBack" title-id="camPlayerName" @back="onBack">
      <template #right>
        <span class="cam-live" id="camLive">直播中</span>
      </template>
    </BackBar>

    <div class="cam-live-view" id="camLiveView" :class="{ hide: cam.camMode !== 'live' }">
      <div class="cam-player-stage" id="camPlayerStage">
        <img id="camPlayerFrame" :src="cam.currentCam.img" :class="cam.currentCam.pos" alt="" loading="lazy" />
        <span class="cam-pos-tag" id="camPosTag">{{ stageTag }}</span>
        <span class="cam-time" id="camPlayerTime"><em>{{ stampParts.date }}</em> {{ stampParts.clock }}</span>
        <button class="cam-play" id="btnCamPlay" type="button" aria-label="播放" @click="onPlay"></button>
        <div class="cam-stage-acts">
          <button class="cam-stage-btn" id="btnCamShots" type="button" @click="onShots">历史抓拍</button>
          <button class="home-full" id="btnCamLand" type="button" @click="onLandToggle">
            <svg class="cam-land-enter" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 5H5v3M16 5h3v3M8 19H5v-3M16 19h3v-3"/></svg>
            <svg class="cam-land-exit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 5v4H5M15 5v4h4M9 19v-4H5M15 19v-4h4"/></svg>
            <span id="camLandText">{{ landText }}</span>
          </button>
        </div>
      </div>
      <div class="cam-player-switch">
        <p>切换点位</p>
        <div class="cam-player-chips" id="camPlayerChips">
          <div v-for="g in cam.grouped" :key="g.name" class="cam-chip-group">
            <h5>{{ g.name }}<em>{{ g.items.length }}</em></h5>
            <div class="cam-chip-grid">
              <button
                v-for="c in g.items"
                :key="c.id"
                class="cam-chip"
                :class="{ on: c.id === cam.camId }"
                type="button"
                :data-cam="c.id"
                @click="onChip(c.id)"
              >
                {{ c.name }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="cam-shots-view" id="camShotsView" :class="{ hide: cam.camMode !== 'shots' }">
      <div class="cam-shots">
        <div class="cam-shots-hd">
          <strong>历史抓拍 · {{ cam.currentCam.name }}</strong>
          <span>每天 3 张，点开查看照片</span>
          <!--
            返回直播的显式出口（2026-10 交互优化新增）。
            原先从直播进抓拍后，唯一的回去方式是顶部返回键 —— 而返回键
            在这层还压着「关大图 / 收日历」两级优先，用户常常按了没反应，
            以为卡住了。这里给一条直达的路。
          -->
          <button class="cam-shots-back" id="btnCamBackLive" type="button" @click="onBackLive">返回直播</button>
        </div>
        <div class="cam-shot-days" id="camShotDays">
          <DayPickChips
            :selected="cam.camShotDate"
            open-attr-name="data-cal-open"
            @pick="onDayPick"
            @open="onCalToggle"
          />
        </div>
        <div class="cam-shot-grid" id="camShotGrid">
          <button
            v-for="(s, i) in cam.camShots"
            :key="i"
            class="cam-shot"
            type="button"
            :data-shot="i"
            @click="onShotClick(i)"
          >
            <SmartImg :pos="s.pos" :src="s.img" :alt="`${s.time} 抓拍`" />
            <span>{{ shotLabel }} {{ s.time }}</span>
          </button>
        </div>
      </div>

      <MonthCalendar
        v-model:month="cam.camCalMonth"
        :selected="cam.camShotDate"
        :hidden="!cam.camCalOpen"
        @select="onCalSelect"
      />
    </div>

    <div
      class="cam-shot-pop"
      id="camShotPop"
      :class="{ open: cam.shotPopOpen }"
      :hidden="!cam.shotPopOpen"
      :aria-hidden="!cam.shotPopOpen"
    >
      <button class="cam-shot-close" id="btnShotClose" type="button" @click="onShotClose">关闭</button>
      <SmartImg id="camShotImg" :pos="currentShot?.pos" :src="currentShot?.img ?? ''" alt="" />
      <p id="camShotMeta">{{ shotMeta }}</p>
    </div>
  </div>
</template>
