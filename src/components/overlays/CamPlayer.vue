<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import BackBar from '@/components/ui/BackBar.vue'
import DayPickChips from '@/components/ui/DayPickChips.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { addDays, camStamp, formatCamDate, startOfDay } from '@/utils/date'

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

const stamp = ref(camStamp())
let timer = 0

function refreshStamp(): void {
  stamp.value = camStamp()
}

onMounted(() => {
  // 原 tick()（app.js:1720-1722）在播放器打开时每秒刷新其时间戳
  timer = window.setInterval(() => {
    if (cam.isOpen) refreshStamp()
  }, 1000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})

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
  cam.closeCam()
  // 若本次监控是从全屏地图的撒点进来的，回到全屏地图而非首页
  shell.backToMapLand()
}

/** 原 js/app.js:1251-1256 */
function onShots(): void {
  cam.camShotDate = startOfDay(new Date())
  cam.camCalOpen = false
  cam.showCamMode('shots')
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
</script>

<template>
  <div
    class="cam-player"
    id="camPlayer"
    :class="{ open: cam.isOpen, live: cam.isLive, 'is-land': shell.isLand }"
    :hidden="!cam.isOpen"
    :aria-hidden="!cam.isOpen"
  >
    <BackBar title="视频监控" back-id="btnCamBack" title-id="camPlayerName" @back="onBack">
      <template #right>
        <span class="cam-live" id="camLive">直播中</span>
      </template>
    </BackBar>

    <div class="cam-live-view" id="camLiveView" :class="{ hide: cam.camMode !== 'live' }">
      <div class="cam-player-stage" id="camPlayerStage">
        <img id="camPlayerFrame" :src="cam.currentCam.img" :class="cam.currentCam.pos" alt="" loading="lazy" />
        <span class="cam-time" id="camPlayerTime">{{ stamp }}</span>
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
          <strong>历史抓拍</strong>
          <span>每天 3 张，点开查看照片</span>
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
            <img :class="s.pos" :src="s.img" :alt="`${s.time} 抓拍`" loading="lazy" />
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
      <img id="camShotImg" :src="currentShot?.img" :class="currentShot?.pos" alt="" loading="lazy" />
      <p id="camShotMeta">{{ shotMeta }}</p>
    </div>
  </div>
</template>
