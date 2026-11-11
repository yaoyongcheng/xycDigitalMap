<script setup lang="ts">
import { computed, onMounted } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { usePatrolStore } from '@/stores/patrol'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 首页 · 智巡面板（2026-11 阶段 8：改真实航拍照片）
 *
 * 原先是 17 张写死的静态图（`data/config.ts: patrolPhotos`）配六个手工分类
 * （项目全景 / 基坑区域 / 作业面 / 施工装备 / 材料堆场 / 现场场布）。
 * 现在改接 keehang 平台的真实航拍照片（见 `stores/patrol.ts`）。
 *
 * ## 为什么没有分类标签了
 *
 * 那六个分类是**人工归类的**，服务端不提供分类字段 —— 照片一到就不知道该归哪类。
 * 与其用假分类框住真照片，不如按拍摄时间倒序铺开，并标出「所属任务 + 时间」，
 * 让看的人自己判断这是什么。
 *
 * ## 为什么缩略图不自动加载
 *
 * 真实 DJI 原图单张 5~8MB（实测 5378048 字节）。列表里直接 `<img src>` 会把
 * 流量吃光，手机上更卡。这里只显示文件名与体积摘要，**点开大图时才加载原图**。
 */
const sheet = useBottomSheetStore()
const patrol = usePatrolStore()

onMounted(() => {
  void patrol.load()
})

/** 慢请求才显示骨架 */
const syncing = computed(() => patrol.state === 'loading' && !patrol.photos.length)
const showSkel = useSlowLoading(() => syncing.value)

function retry(): void {
  void patrol.load(true)
}
</script>

<template>
  <div class="safe-block">
    <div class="patrol-hd">
      <h4>最新照片</h4>
      <em>{{ patrol.list.length }} 张</em>
    </div>

    <!-- 同步中：与 .patrol-card 同构铺灰条，数据到了原位回填 -->
    <div
      v-if="syncing"
      class="patrol-grid skel-fade"
      :class="{ 'is-on': showSkel }"
      aria-hidden="true"
    >
      <div v-for="i in 4" :key="i" class="patrol-card is-skel">
        <Skel w="100%" h="96px" r="var(--r-8)" />
        <div class="patrol-card-ft">
          <Skel w="70%" h="13px" />
        </div>
      </div>
    </div>

    <div v-else-if="patrol.list.length" class="patrol-grid">
      <button
        v-for="p in patrol.list"
        :key="p.id"
        class="patrol-card"
        type="button"
        :aria-label="`${p.taskName}，${p.time}，查看大图`"
        @click="sheet.openPatrol(p.id)"
      >
        <div class="patrol-thumb">
          <span class="patrol-thumb-tag">航拍原图</span>
        </div>
        <div class="patrol-card-ft">
          <div class="patrol-card-name">
            <strong>{{ p.taskName }}</strong>
            <em>{{ p.time.slice(0, 16).replace('T', ' ') }}</em>
          </div>
          <div class="patrol-tags">
            <span class="patrol-tag">无人机</span>
            <span class="patrol-size">{{ patrol.sizeText(p.size) }}</span>
          </div>
        </div>
      </button>
    </div>

    <div v-else class="data-empty" data-empty="patrol">
      <p>{{ patrol.state === 'error' ? patrol.error || '巡检照片加载失败' : '暂无航拍照片' }}</p>
      <button v-if="patrol.state === 'error'" class="data-empty-btn" type="button" @click="retry">
        重试
      </button>
    </div>
  </div>
</template>
