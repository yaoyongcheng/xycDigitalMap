<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import BackBar from '@/components/ui/BackBar.vue'
import DayPickChips from '@/components/ui/DayPickChips.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import SmartImg from '@/components/ui/SmartImg.vue'
import { useAirHazardStore } from '@/stores/airHazard'
import { useShellStore } from '@/stores/shell'
import { addDays, formatCamDate, startOfDay } from '@/utils/date'
import { downloadPhoto, photoHd } from '@/utils/photoHd'
import { useSlideOverlay } from '@/utils/slideOverlay'
import { useImageZoom } from '@/utils/zoom'

/**
 * 无人机巡检全屏层
 *
 * 对应原 index.html:123-150 + 事件处理（app.js:1495-1559）
 * + renderAir()（app.js:1361-1372）。
 */
const air = useAirHazardStore()

/** 全屏层转场（进入左滑入 / 返回右滑出），见 utils/slideOverlay.ts */
const playerEl = ref<HTMLElement | null>(null)
const overlay = useSlideOverlay(() => playerEl.value)
watch(() => air.isOpen, (open) => overlay.syncOpen(open), { flush: 'post' })

const label = computed(() => formatCamDate(air.airDate))

/** 原 app.js:1366 airHint.textContent */
const hint = computed(() => `${label.value}  无人机定点拍摄  ${air.airList.length} 张`)

/** 原 js/app.js:1495-1506 —— 三级优先：关大图 → 收日历 → 关播放器 */
function onBack(): void {
  if (air.airPopOpen) {
    air.airPopOpen = false
    return
  }
  if (air.airCalOpen) {
    air.airCalOpen = false
    return
  }
  overlay.leave(() => air.closeAir())
}

/** 原 js/app.js:1508-1521 */
function onDayPick(day: number): void {
  air.airCalOpen = false
  air.airDate = addDays(new Date(), -day)
  air.airPopOpen = false
}

function onCalToggle(): void {
  if (air.airCalOpen) {
    air.airCalOpen = false
    return
  }
  // 原 showAirCal()（app.js:1355-1359）—— 展开时对齐月份到选中日
  air.airCalMonth = startOfDay(new Date(air.airDate.getFullYear(), air.airDate.getMonth(), 1))
  air.airCalOpen = true
}

/** 原 js/app.js:1535-1543 */
function onCalSelect(d: Date): void {
  air.airDate = startOfDay(d)
  air.airCalOpen = false
  air.airPopOpen = false
}

/** 原 js/app.js:1545-1555 */
function onPhotoClick(i: number): void {
  if (!air.airList[i]) return
  air.airPopIdx = i
  air.airPopOpen = true
}

/** 原 js/app.js:1557-1559 —— 注意原版此处只移除 .open，未设 hidden */
function onPopClose(): void {
  air.airPopOpen = false
}

const currentShot = computed(() => air.airList[air.airPopIdx])

/**
 * 大图缩放（2026-10 新增，非原版内容）
 * 航拍照片的判读点常在小范围，不能放大等于看不了。
 * SmartImg 的根元素就是 <img>，这些监听与 style 会经 attribute 继承落上去。
 */
const {
  zoomed: imgZoomed,
  label: zoomLabel,
  imgStyle,
  animating: zoomAnim,
  handlers: zoomHandlers,
  reset: resetZoom,
} = useImageZoom()

// 换照片或关闭弹层时复原，否则下次打开还停在上一张的缩放位置
watch([() => air.airPopOpen, () => air.airPopIdx], () => {
  if (!air.airPopOpen) resetZoom()
})
watch(() => currentShot.value?.img, resetZoom)

/* ---------- 原图 / 下载（2026-11 设计稿 gx2 版，原 photo-stage 顶栏 app.js:764-785） ---------- */

const shell = useShellStore()
const hd = ref(false)

// 换照片或关弹层时，原图态跟着复位
watch([() => air.airPopOpen, () => air.airPopIdx], () => {
  hd.value = false
})

/**
 * 顶栏标题（原 openPhotoStage 传的 photo.name：`定点航拍 今天 08:15`）。
 * 原版是单独一行的居中原信息（双空格留气口），这里进了顶栏 ——
 * 单空格排版 + 省略号截断，日期再长也不会把「原图 / 下载」挤出去。
 */
const popTitle = computed(() => {
  const s = currentShot.value
  if (!s) return ''
  return `定点航拍 ${label.value} ${s.time}`
})

/**
 * 切原图：列表/大图首屏加载的是压缩图（几百 KB），点了这里才换成
 * img/hd/ 下的高清原图 —— 现场判读要细节，但没必要为每次打开付那份流量。
 * 换源后当前缩放得复位，否则 4× 停在旧图上，新图一进来直接糊出边界。
 */
function onHd(): void {
  if (hd.value) return
  hd.value = true
  resetZoom()
}

async function onDownload(): Promise<void> {
  const s = currentShot.value
  if (!s) return
  try {
    // 文件名与顶栏标题一致（原 app.js:770 用 photo.name，落盘 photo.name + ".jpg"）
    await downloadPhoto(s.img, popTitle.value)
    shell.showToast('已开始下载', 'success')
  } catch {
    shell.showToast('下载失败', 'warn')
  }
}
</script>

<template>
  <div
    ref="playerEl"
    class="air-player"
    id="airPlayer"
    :class="{ open: air.isOpen }"
    :hidden="!air.isOpen"
    :aria-hidden="!air.isOpen"
  >
    <BackBar title="航拍照片" back-id="btnAirBack" @back="onBack" />

    <div class="air-days" id="airDays">
      <DayPickChips
        :selected="air.airDate"
        open-attr-name="data-air-cal-open"
        @pick="onDayPick"
        @open="onCalToggle"
      />
    </div>

    <MonthCalendar
      v-model:month="air.airCalMonth"
      :selected="air.airDate"
      :hidden="!air.airCalOpen"
      @select="onCalSelect"
    />

    <p class="air-hint" id="airHint">{{ hint }}</p>

    <div class="air-grid" id="airGrid">
      <button
        v-for="(s, i) in air.airList"
        :key="i"
        class="air-card"
        type="button"
        :data-air="i"
        @click="onPhotoClick(i)"
      >
        <SmartImg :pos="s.pos" :src="s.img" :alt="`${label} ${s.time} 航拍`" />
        <span>{{ label }} {{ s.time }}</span>
      </button>
    </div>

    <!--
      航拍大图：设计稿的全屏 photo-stage（原 index.html:318-333 + app.css:3557-3630）。
      三段式 —— 顶栏「关闭 / 标题 / 原图 · 下载」、弹性图片区、底部手势提示。
      图片先给压缩图，点「原图」才换 img/hd/ 下的高清版。
    -->
    <div
      class="cam-shot-pop air-pop"
      id="airPop"
      :class="{ open: air.airPopOpen }"
      :hidden="!air.airPopOpen"
      :aria-hidden="!air.airPopOpen"
    >
      <div class="photo-bar">
        <button class="photo-bar-btn" id="btnAirClose" type="button" @click="onPopClose">
          关闭
        </button>
        <strong>{{ popTitle }}</strong>
        <div class="photo-bar-acts">
          <button class="photo-bar-btn" type="button" :disabled="hd" @click="onHd">
            {{ hd ? '已是原图' : '原图' }}
          </button>
          <button class="photo-bar-btn" type="button" @click="onDownload">下载</button>
        </div>
      </div>

      <div class="photo-view">
        <SmartImg
          id="airPopImg"
          :pos="currentShot?.pos"
          :src="currentShot ? (hd ? photoHd(currentShot.img) : currentShot.img) : ''"
          alt=""
          class="zoomable"
          :class="{ 'is-zoomed': imgZoomed, 'is-anim': zoomAnim }"
          :style="imgStyle"
          v-on="zoomHandlers"
        />
        <span v-if="imgZoomed" class="zoom-badge">{{ zoomLabel }}</span>
      </div>

      <p class="photo-tip">双指缩放，单指拖动</p>
    </div>
  </div>
</template>
