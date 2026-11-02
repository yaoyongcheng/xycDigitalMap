<script setup lang="ts">
import { computed } from 'vue'

import { patrolCats, patrolPhotos } from '@/data/config'

/**
 * 巡检大图（2026-10 版本同步 · 第三批）
 *
 * 底图在弹层里按原比例完整显示（fit），不裁切 —— 巡检照片的价值在于
 * 「现场到底长什么样」，缩略图可以取局部，看大图时再裁就失去意义了。
 *
 * 元信息三项（分类 / 来源 / 时间）与设计稿一致；来源标签与照片墙共用
 * .alarm-src，后面预警流加来源标签时也走同一套。
 */
const props = defineProps<{ id: string }>()

const photo = computed(() => patrolPhotos.find((p) => p.id === props.id))

const catName = computed(() => {
  const id = photo.value?.cat
  return patrolCats.find((c) => c.id === id)?.name ?? ''
})
</script>

<template>
  <div v-if="photo">
    <figure class="patrol-view">
      <img :class="photo.pos" :src="photo.img" :alt="photo.name" />
    </figure>

    <div class="patrol-meta">
      <div><span>分类</span><b class="patrol-tag is-lg">{{ catName }}</b></div>
      <div>
        <span>来源</span>
        <span class="alarm-src" :class="`alarm-src-${photo.src}`">
          {{ photo.src === 'drone' ? '无人机' : '视频监控' }}
        </span>
      </div>
      <div><span>时间</span><b>今天 {{ photo.time }}</b></div>
    </div>
  </div>
</template>
