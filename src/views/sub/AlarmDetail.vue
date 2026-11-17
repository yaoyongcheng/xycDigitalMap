<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { fetchAlarmPicture } from '@/api/video'
import Skel from '@/components/ui/Skel.vue'
import type { Alarm } from '@/types'
import { alarmSrcOf } from '@/data/config'
import { useAuthStore } from '@/stores/auth'
import { camTagOf, placeOf, remoteIdOf } from '@/utils/videoAlarm'
import { useImageZoom } from '@/utils/zoom'

/**
 * 预警详情（子页内容）
 *
 * 对应原 js/app.js:780-799 renderAlarmDetail(a)。
 *
 * 2026-11 字段收口（对齐 V2 的 AI 报警详情）：
 *   · 「项目名称 / 任务名称 / 地址」三项在原版与 V1 都是**写死的常量**，
 *     其中「地址」干脆是一串和本项目无关的市政地址。现在整块换成 V2 的
 *     「报警类型 / 报警地点 / 报警时间」三行 —— 这三样都能从
 *     `:8085 /api/video/alarms` 与通道映射里取到真值。
 *   · 「自动 / 0级」也删了：服务端没有识别方式与等级字段，硬写就是假数据。
 *   · 补上三条真实字段：视频通道（`channelNo`）、设备编号（`deviceNo`）、
 *     处理状态（`handleStatus`）。详情页从此没有一行是编的。
 *
 * 2026-10 新增：现场大图支持双指捏合 / 双击 / 滚轮缩放与拖动平移。
 * 隐患照片的判读点往往在很小的区域，不能放大等于看不了。
 *
 * 2026-11 设计稿 gx2 版同步：大图角标与「预警来源」行按 alarm.src
 * 取值（原 app.js:2735-2756）—— 此前硬编码成无人机，视频监控 /
 * 随手拍进来的预警也显示无人机设备号，属于信息错误。
 */
const props = defineProps<{ alarm: Alarm }>()

const src = computed(() => alarmSrcOf(props.alarm.src))

/**
 * 大图角标副标题。
 *
 * 视频监控是 `CAM-2#材料堆场` 这种**按本条报警的通道现算**的写法；其它来源
 * （无人机 / 随手拍）用配置里的固定编号。原来一律写死「CAM-2#塔吊」，
 * 通道 3 的报警也顶着 2 号机位。
 */
const tagSub = computed(() =>
  props.alarm.src === 'cam' ? camTagOf(props.alarm) : src.value.sub,
)

/** 报警地点：点位名（CAM_PLACE）→ 没有映射就写「N号通道」，都没有写「—」 */
const place = computed(() => placeOf(props.alarm))

/** 视频通道：服务端 channelNo，没有就「—」 */
const channelText = computed(() =>
  props.alarm.channelNo && props.alarm.channelNo > 0 ? `${props.alarm.channelNo}号通道` : '—',
)

/** 处理状态：服务端 handleStatus（0 未处理 / 1 已处理） */
const handleText = computed(() => (props.alarm.handleStatus === 1 ? '已处理' : '未处理'))

const { zoomed, label, imgStyle, animating, handlers, reset } = useImageZoom()

// 从上一条预警切到下一条时，沿用上一张的缩放会让用户莫名其妙
watch(() => props.alarm.img, reset)

/**
 * 真实抓拍图（2026-11 接口迁移 · 阶段 3）。
 *
 * 服务端按报警 Id 单独下发 base64（`/api/video/alarms/{id}/picture`）。
 * 2026-11 收口：拉不到就**明确显示「暂无抓拍图」**，不再退到 `img/alarm-*.webp`
 * 那张分类示意图 —— 示意图长得像真实现场，会被当成当次抓拍看。
 */
const auth = useAuthStore()
const remoteShot = ref('')
const shotError = ref('')
const shotLoading = ref(false)

/**
 * 占位文案：分「未登录 / 真的没有」两种。
 *
 * 加载中不再出文案 —— 抓拍图单张约 1MB，等待是常态，这里铺一条与图片等宽
 * 的灰条（.alarm-hero-skel），让「正在来一张照片」比「一句加载中」更直观。
 */
const shotTip = computed(() => {
  if (!auth.isLoggedIn) return '登录后查看抓拍图'
  return shotError.value || '该报警暂无抓拍图'
})

watch(
  () => props.alarm.id,
  async (id) => {
    remoteShot.value = ''
    shotError.value = ''
    const rid = remoteIdOf(props.alarm)
    if (!rid || !auth.token) return
    shotLoading.value = true
    // 切走之后再回来的旧请求就别写回去了
    try {
      const url = await fetchAlarmPicture(auth.token, rid)
      if (props.alarm.id === id) remoteShot.value = url
    } catch (err) {
      if (props.alarm.id === id) shotError.value = err instanceof Error ? err.message : ''
    } finally {
      if (props.alarm.id === id) shotLoading.value = false
    }
  },
  { immediate: true },
)

const heroSrc = computed(() => remoteShot.value)
</script>

<template>
  <div class="alarm-hero" :class="{ 'is-empty': !heroSrc }">
    <img
      v-if="heroSrc"
      :src="heroSrc"
      :alt="alarm.type"
      class="zoomable"
      :class="{ 'is-zoomed': zoomed, 'is-anim': animating }"
      :style="imgStyle"
      v-on="handlers"
    />
    <!--
      抓拍图还没到：铺一条与图片同宽的灰条。单张约 1MB，这一层几乎一定会
      被看到，比「抓拍图加载中…」更像「照片正在来」。
    -->
    <div v-else-if="shotLoading" class="alarm-hero-skel">
      <Skel w="100%" h="100%" r="0" />
      <span class="sr-only" role="status">抓拍图加载中</span>
    </div>
    <div v-else class="alarm-hero-empty">{{ shotTip }}</div>
    <span v-if="zoomed" class="zoom-badge">{{ label }}</span>
    <div class="alarm-hero-tag">
      <strong>{{ src.name }}</strong>
      <span>{{ tagSub }}</span>
    </div>
  </div>
  <div class="alarm-info">
    <h4>基础信息</h4>
    <div class="alarm-kv"><span>报警类型</span><em>{{ alarm.type }}</em></div>
    <div class="alarm-kv"><span>报警地点</span><em class="alarm-place">{{ place }}</em></div>
    <div class="alarm-kv"><span>报警时间</span><em>{{ alarm.at }}</em></div>
    <h4>设备信息</h4>
    <div class="alarm-kv"><span>视频通道</span><em>{{ channelText }}</em></div>
    <div class="alarm-kv"><span>设备编号</span><em class="alarm-geo">{{ alarm.deviceNo || '—' }}</em></div>
    <div class="alarm-kv"><span>处理状态</span><em>{{ handleText }}</em></div>
  </div>
</template>
