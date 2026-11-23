<script setup lang="ts">
import { watch } from 'vue'

import SmartImg from '@/components/ui/SmartImg.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import ThumbRing from '@/components/ui/ThumbRing.vue'
import type { DroneWorkOrder, WorkOrderStatus } from '@/api/drone'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { revealThumb } from '@/utils/thumbReveal'

/**
 * 无人机预警列表项（2026-11-23 从 `WorkOrderList.vue` 抽出）
 *
 * 抽出来的原因只有一个：报警预警历史页要把**监控预警 + 无人机预警**合成
 * 一条时间线（见 `utils/alarmMerge.ts`），同一行工单需要在两处渲染。
 * 版式、取图链路、红点判据全部保持原样，一个像素都没动 ——
 * 无人机预警列表（今日 / 历史）与消息页的取图行为因此不受影响。
 *
 * 字段（照 `api/drone.ts::toWorkOrder` 的映射，不在这里二次猜）：
 *   · 标题 —— `title`，空时写「识别预警」（服务端没给就不假装识别出了什么）；
 *   · 副标题 —— `jobName` → `projectName` → 「—」；
 *   · 右侧 —— 相对时间 + 状态徽标（`UNAUDITED` 待处理 / `AUDITED` 已完成）；
 *   · 图标位 —— 缩略图 or 灰底无人机占位 + 真实字节进度环。
 */
const props = defineProps<{
  wo: DroneWorkOrder
  /** 未处理红点（今日 + 待处理）。历史列表 / 历史页不传即为关闭 */
  dot?: boolean
  /**
   * 垫底层（右滑返回时露出的只读副本）不取图：
   * 同一批 id 主层已经在取了，再登记一遍只是让观察器多一份无用回调。
   */
  decorative?: boolean
}>()

const emit = defineEmits<{ open: [] }>()

const drone = useDroneAlarmStore()

/**
 * 滚到视口附近才取这一条的缩略图（与 `InspectItem` 共用同一个观察器）。
 * 已经有图就直接跳过，不再占一个观察位。
 */
function arm(): void {
  if (props.decorative) return
  if (!props.wo?.id) return
  if (drone.thumbOf(props.wo.id)) return
  const el = rowEl
  if (!el) return
  revealThumb(el, () => drone.ensureThumb(props.wo.id))
}

let rowEl: Element | null = null

/** 行元素是通过函数 ref 拿到的（列表里没有 `mounted` 时机可挂），拿到就登记观察器 */
function setRow(el: unknown): void {
  if (!el || typeof (el as Element).nodeType !== 'number') return
  rowEl = el as Element
  arm()
}

// 同一个 DOM 复用给了另一条工单（列表翻页 / 换日期时 key 一般会换，这里兜住）
watch(
  () => props.wo.id,
  () => {
    arm()
  },
)

/** 状态徽标的修饰类（与 `.alarm-src` 基类配套） */
function statusClass(status: WorkOrderStatus | ''): string {
  return status === 'UNAUDITED' ? 'alarm-src-todo' : 'alarm-src-done'
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('open')
  }
}
</script>

<template>
  <div
    :ref="setRow"
    class="insp-item"
    :data-wo="wo.id"
    :data-status="wo.status"
    role="button"
    tabindex="0"
    @click="emit('open')"
    @keydown="onKey"
  >
    <!-- 图标位：与监控列表同一套 —— 有缩略图铺图，没有就铺灰底占位图标；
         取图过程中在图标外圈叠一圈真实进度，图到了自动消失；
         未处理在右上角压一颗红点（与图无关，状态单独决定） -->
    <span class="insp-pic-box">
      <SmartImg
        v-if="drone.thumbOf(wo.id)"
        class="insp-pic"
        :src="drone.thumbOf(wo.id)"
        :alt="wo.title || '无人机预警'"
      />
      <span v-else class="insp-pic alarm-tile" aria-hidden="true">
        <SvgIcon name="drone" />
        <ThumbRing
          :id="wo.id"
          :busy="drone.thumbBusyOf(wo.id)"
          :pct="drone.thumbPctOf(wo.id)"
        />
      </span>
      <i v-if="dot" class="insp-dot" role="img" aria-label="未处理" />
    </span>
    <div class="insp-meta">
      <div class="insp-hd">
        <strong>{{ wo.title || '识别预警' }}</strong>
        <!-- 来源徽标：与监控列表的「视频监控」同一套尺寸与配色 -->
        <span class="alarm-src alarm-src-drone">无人机</span>
      </div>
      <p>{{ wo.jobName || wo.projectName || '—' }}</p>
    </div>
    <div class="wo-side">
      <span class="insp-time">{{ drone.relOf(wo) }}</span>
      <span class="alarm-src" :class="statusClass(wo.status)">{{ drone.statusText(wo) }}</span>
    </div>
  </div>
</template>
