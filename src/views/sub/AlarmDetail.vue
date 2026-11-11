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
 * `img` 字段是演示配图占位：视频报警的抓拍要按服务端 Id 单独拉一次
 * （`/api/video/alarms/{id}/picture` 返回 base64 纯文本）。拉不到就保持占位图 ——
 * 详情页的核心是这张图，宁可显示一张「示意」，也不能留白或者一直转圈。
 */
const auth = useAuthStore()
const remoteShot = ref('')

watch(
  () => props.alarm.id,
  async (id) => {
    remoteShot.value = ''
    const rid = remoteIdOf(props.alarm)
    if (!rid || !auth.token) return
    // 切走之后再回来的旧请求就别写回去了
    try {
      const url = await fetchAlarmPicture(auth.token, rid)
      if (props.alarm.id === id) remoteShot.value = url
    } catch {
      /* 抓拍图缺失 / 已过期 / 网络不可达：保留占位图 */
    }
  },
  { immediate: true },
)

const heroSrc = computed(() => remoteShot.value || props.alarm.img)
</script>

<template>
  <div class="alarm-hero">
    <img
      :src="heroSrc"
      :alt="alarm.type"
      class="zoomable"
      :class="{ 'is-zoomed': zoomed, 'is-anim': animating }"
      :style="imgStyle"
      v-on="handlers"
    />
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
