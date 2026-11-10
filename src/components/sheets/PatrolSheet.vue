<script setup lang="ts">
import { computed, ref } from 'vue'

import { patrolCats, patrolPhotos } from '@/data/config'
import { useShellStore } from '@/stores/shell'
import { useAlbumFile } from '@/utils/albumSave'
import { photoHd, savePhoto } from '@/utils/photoHd'
import { useImageZoom } from '@/utils/zoom'

/**
 * 巡检大图（2026-10 版本同步 · 第三批）
 *
 * 底图在弹层里按原比例完整显示（fit），不裁切 —— 巡检照片的价值在于
 * 「现场到底长什么样」，缩略图可以取局部，看大图时再裁就失去意义了。
 *
 * 元信息三项（分类 / 来源 / 时间）与设计稿一致；来源标签与照片墙共用
 * .alarm-src，后面预警流加来源标签时也走同一套。
 *
 * 2026-11 设计稿 gx2 版：操作区加「原图 / 下载」（原 photo-stage 顶栏，
 * app.js:764-785）—— 列表图是压缩版，判读细节要能切 1024 宽的原图。
 */
const props = defineProps<{ id: string }>()

const shell = useShellStore()

const photo = computed(() => patrolPhotos.find((p) => p.id === props.id))

const catName = computed(() => {
  const id = photo.value?.cat
  return patrolCats.find((c) => c.id === id)?.name ?? ''
})

/** 原图切换是单向的（设计稿同样置灰「已是原图」），且切过去后重置缩放由 zoom 层自愈 */
const hd = ref(false)

/**
 * 双指缩放 / 单指拖动（2026-11 补，对齐设计稿 #photoStage 的
 * 「双指缩放，单指拖动」提示）。与预警详情大图、航拍弹层同款 useImageZoom。
 */
const {
  zoomed: imgZoomed,
  label: zoomLabel,
  imgStyle,
  animating: zoomAnim,
  handlers: zoomHandlers,
  reset: zoomReset,
} = useImageZoom()

/**
 * 存相册的预转 jpg：弹层一打开就在后台备好，点「下载」时才能在同一个
 * 用户手势里调起系统分享面板（见 utils/albumSave.ts）。
 */
const { file: albumFile } = useAlbumFile(
  () => photo.value?.img,
  () => photo.value?.name ?? '',
)

async function onDownload(): Promise<void> {
  if (!photo.value) return
  try {
    const res = await savePhoto(photo.value.img, photo.value.name, albumFile.value)
    if (res === 'album') shell.showToast('已保存到相册', 'success')
    else if (res === 'download') shell.showToast('已开始下载', 'success')
  } catch {
    shell.showToast('保存失败', 'warn')
  }
}

/** 切原图后图源变化，缩放应还原到 1×（与航拍弹层切换一致） */
function onHd(): void {
  hd.value = true
  zoomReset()
}
</script>

<template>
  <div v-if="photo">
    <figure class="patrol-view">
      <img
        :class="[photo.pos, 'zoomable', { 'is-zoomed': imgZoomed, 'is-anim': zoomAnim }]"
        :src="hd ? photoHd(photo.img) : photo.img"
        :alt="photo.name"
        :style="imgStyle"
        v-on="zoomHandlers"
      />
      <span v-if="imgZoomed" class="zoom-badge">{{ zoomLabel }}</span>
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

    <div class="photo-actions">
      <button class="photo-btn" type="button" :disabled="hd" @click="onHd">
        {{ hd ? '已是原图' : '原图' }}
      </button>
      <button class="photo-btn" type="button" @click="onDownload">下载</button>
    </div>
  </div>
</template>
