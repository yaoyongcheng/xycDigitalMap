<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { fetchAlarmPicture } from '@/api/video'
import type { Alarm } from '@/types'
import { alarmSrcOf } from '@/data/config'
import { useAuthStore } from '@/stores/auth'
import { remoteIdOf } from '@/utils/videoAlarm'
import { useImageZoom } from '@/utils/zoom'

/**
 * 预警详情（子页内容）
 *
 * 对应原 js/app.js:780-799 renderAlarmDetail(a)。
 * 注意「项目名称 / 任务名称 / 地址」三项在原版是硬编码常量，
 * 不来自预警数据 —— 1:1 复刻下如实保留。
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

/** 占位文案：分「未登录 / 加载中 / 真的没有」三种，避免让人一直等 */
const shotTip = computed(() => {
  if (shotLoading.value) return '抓拍图加载中…'
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
    <div v-else class="alarm-hero-empty">{{ shotTip }}</div>
    <span v-if="zoomed" class="zoom-badge">{{ label }}</span>
    <div class="alarm-hero-tag">
      <strong>{{ src.name }}</strong>
      <span>{{ src.sub }}</span>
    </div>
  </div>
  <div class="alarm-info">
    <h4>基础信息</h4>
    <div class="alarm-kv"><span>项目名称</span><em>中建三局-向阳村项目</em></div>
    <div class="alarm-kv"><span>任务名称</span><em>向阳村-三维(加密)</em></div>
    <div class="alarm-kv"><span>检测时间</span><em>{{ alarm.at }}</em></div>
    <div class="alarm-kv"><span>预警来源</span><em>{{ src.tag }}</em></div>
    <h4>识别结果</h4>
    <div class="alarm-kv"><span>识别类型</span><em>{{ alarm.type }}</em><b>自动</b><i>0级</i></div>
    <div class="alarm-kv"><span>地址</span><em>湖北省武汉市汉阳区江堤街道江永堤路铉龙城</em></div>
    <div class="alarm-kv"><span>经纬度</span><em class="alarm-geo">{{ alarm.geo || '—' }}</em></div>
  </div>
</template>
