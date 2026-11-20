<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { DroneWorkOrder } from '@/api/drone'
import Skel from '@/components/ui/Skel.vue'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useImageZoom } from '@/utils/zoom'

/**
 * 无人机预警详情（子页内容）
 *
 * 字段与 V2（Unity 客户端 `AIAlarmDetail` 那套「预警详情」）逐项对齐：
 * 项目名称 / 任务名称 / 检测时间 / 识别结果 / 经纬度 / 现场大图 —— 全部来自
 * 审核中心接口，一行不编（见 `api/drone.ts::fetchAuditWorkOrders`）。
 *
 * 与视频报警详情（`views/sub/AlarmDetail.vue`）**共用同一套 DOM 与样式**
 * （`.alarm-hero` / `.alarm-info` / `.alarm-kv`）：两者都是「一张现场图 +
 * 若干键值行」，另起一套版式只会让两页看起来像两个 App。
 */
const props = defineProps<{ work: DroneWorkOrder }>()

const drone = useDroneAlarmStore()

const { zoomed, label, imgStyle, animating, handlers, reset } = useImageZoom()

/** 换一条预警时清掉上一条的缩放，否则会莫名其妙停在上次放大的位置 */
watch(() => props.work.id, reset)

/** 签名直链 2 小时过期 / 断网 —— 加载失败就明说，不留破图 */
const imgFailed = ref(false)
/** 大图 0.6~1.3MB，等它是常态：铺一条与图片等宽的灰条（同监控详情） */
const imgLoading = ref(true)
watch(
  () => props.work.image,
  () => {
    imgFailed.value = false
    imgLoading.value = true
  },
)

const heroSrc = computed(() => (imgFailed.value ? '' : props.work.image))

/** 识别方式：服务端 `auditType`，只做原样翻译，不猜 */
const auditText = computed(() => {
  const t = props.work.auditType
  if (t === 'MANUAL_AUDIT') return '人工审核'
  if (t === 'AUTO_AUDIT') return '自动审核'
  return t || '—'
})

/** 通知等级：`NOTIFICATION_LEVEN_2` → 2 级；取不到写「—」 */
const levelText = computed(() => {
  const m = /LEVEN_(\d)/i.exec(props.work.level)
  return m ? `${m[1]} 级` : '—'
})

/** 经纬度：两样都有才拼，缺一个就写「—」（半条坐标没有意义） */
const geoText = computed(() =>
  props.work.lng && props.work.lat ? `${props.work.lng}, ${props.work.lat}` : '—',
)

/** 相对高度（服务端给的是米，字符串原样） */
const altText = computed(() => (props.work.alt ? `${props.work.alt} m` : '—'))

/**
 * 图片事件收敛成两个具名方法。
 *
 * 模板里写多行内联语句（`@error="a = true; b = false"`）在 SFC 编译期只认
 * 单表达式，换行分隔会直接报解析错误 —— 具名方法也更好读。
 */
function onImgLoad(): void {
  imgLoading.value = false
}

function onImgError(): void {
  imgFailed.value = true
  imgLoading.value = false
}
</script>

<template>
  <div class="alarm-hero" :class="{ 'is-empty': !heroSrc }">
    <img
      v-if="heroSrc"
      :src="heroSrc"
      :alt="work.title"
      class="zoomable"
      :class="{ 'is-zoomed': zoomed, 'is-anim': animating }"
      :style="imgStyle"
      v-on="handlers"
      @load="onImgLoad"
      @error="onImgError"
    />
    <div v-else-if="imgLoading && work.image" class="alarm-hero-skel">
      <Skel w="100%" h="100%" r="0" />
      <span class="sr-only" role="status">现场图加载中</span>
    </div>
    <div v-else class="alarm-hero-empty">
      {{ work.image ? '现场图加载失败' : '该预警暂无现场图' }}
    </div>
    <span v-if="zoomed" class="zoom-badge">{{ label }}</span>
    <div class="alarm-hero-tag">
      <strong>自动巡航无人机</strong>
      <span>{{ work.jobName || 'AI 识别' }}</span>
    </div>
  </div>

  <div class="alarm-info">
    <h4>基础信息</h4>
    <div class="alarm-kv"><span>项目名称</span><em>{{ work.projectName || '—' }}</em></div>
    <div class="alarm-kv"><span>任务名称</span><em>{{ work.jobName || '—' }}</em></div>
    <div class="alarm-kv"><span>检测时间</span><em>{{ work.at || '—' }}</em></div>
    <div class="alarm-kv"><span>处理状态</span><em>{{ drone.statusText(work) }}</em></div>

    <h4>识别结果</h4>
    <div class="alarm-kv"><span>识别类别</span><em>{{ work.title || work.label || '—' }}</em></div>
    <div class="alarm-kv"><span>识别方式</span><em>{{ auditText }}</em></div>
    <div class="alarm-kv"><span>通知等级</span><em>{{ levelText }}</em></div>

    <h4>位置</h4>
    <div class="alarm-kv"><span>经纬度</span><em class="alarm-geo">{{ geoText }}</em></div>
    <div class="alarm-kv"><span>相对高度</span><em>{{ altText }}</em></div>
  </div>
</template>
