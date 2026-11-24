<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import SmartImg from '@/components/ui/SmartImg.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import ThumbRing from '@/components/ui/ThumbRing.vue'
import type { Alarm } from '@/types'
import { alarmSrcOf } from '@/data/config'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { alarmTone } from '@/utils/alarmTone'
import { revealThumb } from '@/utils/thumbReveal'

/**
 * 巡检预警列表项
 *
 * 对应原 js/app.js:665-675 inspectListItem(a)。
 * 今日与历史两个列表都用同一份结构，故抽为组件（渲染 DOM 相同）。
 *
 * 2026-10 交互优化：图片换成 SmartImg（占位 + 失败兜底，见该组件注释）；
 * 同时补 tabindex / 键盘可达 / 按压态所需的语义 —— 原先是纯 div + role，
 * 键盘用户完全无法操作。
 *
 * 2026-11 设计稿 gx2 版：①标题行加采集来源徽标；②报警历史页的列表
 * 标题显示报警名（histAlarmItem 用 a.title）而不是类型名（inspectListItem
 * 用 a.type），useTitle 切换。
 *
 * 2026-11-19：左侧 48px 图标位改成**与详情页同一张抓拍图**的缩略图。
 *   · 取图时机由 `revealThumb` 决定（滚到视口附近才请求，见该文件注释）；
 *   · 没取到 / 该报警没有抓拍图时铺**统一占位图标**（灰底 + 深灰摄像机，
 *     `.alarm-tile`），不再退到 `img/alarm-*.webp` 那张分类示意图 ——
 *     示意图长得像真实现场，会被当成当次抓拍（2026-11-19 现场反馈）；
 *   · 取图过程中由 `ThumbRing` 在图标外圈叠一圈真实下载进度，图到了自己消失。
 *   · 尺寸、圆角、`object-fit: cover` 全部沿用 `.insp-pic`，等比铺满不拉伸。
 */
const props = defineProps<{
  alarm: Alarm
  useTitle?: boolean
}>()
const emit = defineEmits<{ open: [] }>()

/**
 * 处理状态（2026-11-24 对齐无人机列表）。
 *
 * 服务端 `handleStatus`：1 = 已完成，其余（0 / 缺省）= 待处理。
 * 与 `components/ui/WorkOrderItem.vue` 用同一套徽标样式与文案
 * （`.alarm-src-todo` 橙 / `.alarm-src-done` 灰），两个预警列表因此一眼一致。
 *
 * 这里**只读**：本 App 不提供任何状态变更操作，也不再点「未读红点」——
 * 红点会随着详情页无法清除而变成一颗永远清不掉的装饰。
 */
const statusText = computed(() => (props.alarm.handleStatus === 1 ? '已完成' : '待处理'))
const statusClass = computed(() =>
  props.alarm.handleStatus === 1 ? 'alarm-src-done' : 'alarm-src-todo',
)

const alarmStore = useAlarmStore()
const auth = useAuthStore()

/** 抓拍缩略图（空串 = 还没取到或没有，退回统一占位图标） */
const thumb = computed(() => alarmStore.thumbOf(props.alarm.id))

const rowEl = ref<HTMLElement | null>(null)

function loadThumb(): void {
  if (auth.token) alarmStore.ensureThumb(auth.token, props.alarm.id)
}

/** 已经有图就不必再登记观察器（预取 / 内存命中时最常见） */
function arm(): void {
  if (thumb.value) return
  revealThumb(rowEl.value, loadThumb)
}

onMounted(arm)

// 同一个 DOM 复用给了另一条报警（列表换日期时 key 一般会换，这里兜住）
watch(
  () => props.alarm.id,
  arm,
)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('open')
  }
}
</script>

<template>
  <div
    ref="rowEl"
    class="insp-item"
    :data-alarm="alarm.id"
    :data-tone="alarmTone(alarm.type)"
    role="button"
    tabindex="0"
    @click="emit('open')"
    @keydown="onKey"
  >
    <!-- 图标位：有抓拍图铺图，没有就铺灰底占位图标（尺寸/圆角都由 .insp-pic 定）；
         取图过程中在图标外圈叠一圈真实下载进度，图到了自动消失。
         2026-11-24 起不再点未读红点：状态改在右侧徽标里如实展示（见下） -->
    <span class="insp-pic-box">
      <SmartImg v-if="thumb" class="insp-pic" :src="thumb" :alt="alarm.type" />
      <span v-else class="insp-pic alarm-tile" aria-hidden="true">
        <SvgIcon name="work-cam" />
        <ThumbRing :id="alarm.id" />
      </span>
    </span>
    <div class="insp-meta">
      <div class="insp-hd">
        <strong>{{ useTitle ? alarm.title : alarm.type }}</strong>
        <span class="alarm-src" :class="`alarm-src-${alarm.src}`">{{ alarmSrcOf(alarm.src).tag }}</span>
      </div>
      <p>{{ alarm.desc }}</p>
    </div>
    <!-- 右侧两行：相对时间 + 处理状态（与无人机预警列表的 .wo-side 完全一致） -->
    <div class="wo-side">
      <span class="insp-time">{{ alarm.rel }}</span>
      <span class="alarm-src" :class="statusClass">{{ statusText }}</span>
    </div>
  </div>
</template>
