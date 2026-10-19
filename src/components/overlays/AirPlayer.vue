<script setup lang="ts">
import { computed } from 'vue'

import BackBar from '@/components/ui/BackBar.vue'
import DayPickChips from '@/components/ui/DayPickChips.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import SmartImg from '@/components/ui/SmartImg.vue'
import { useAirHazardStore } from '@/stores/airHazard'
import { addDays, formatCamDate, startOfDay } from '@/utils/date'

/**
 * 无人机巡检全屏层
 *
 * 对应原 index.html:123-150 + 事件处理（app.js:1495-1559）
 * + renderAir()（app.js:1361-1372）。
 */
const air = useAirHazardStore()

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
  air.closeAir()
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

/** 原 app.js:1552 airPopMeta.textContent */
const popMeta = computed(() => {
  const s = currentShot.value
  if (!s) return ''
  return `定点航拍  ${label.value}  ${s.time}`
})
</script>

<template>
  <div
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

    <div
      class="cam-shot-pop air-pop"
      id="airPop"
      :class="{ open: air.airPopOpen }"
      :hidden="!air.airPopOpen"
      :aria-hidden="!air.airPopOpen"
    >
      <button class="cam-shot-close" id="btnAirClose" type="button" @click="onPopClose">关闭</button>
      <SmartImg id="airPopImg" :pos="currentShot?.pos" :src="currentShot?.img ?? ''" alt="" />
      <p id="airPopMeta">{{ popMeta }}</p>
    </div>
  </div>
</template>
