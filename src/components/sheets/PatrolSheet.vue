<script setup lang="ts">
import { computed, watch } from 'vue'

import { useShellStore } from '@/stores/shell'
import { usePatrolStore } from '@/stores/patrol'
import { useAlbumFile } from '@/utils/albumSave'
import { savePhoto } from '@/utils/photoHd'
import { useImageZoom } from '@/utils/zoom'

/**
 * 巡检大图（2026-11 阶段 8：改真实航拍照片）
 *
 * 原先显示的是 `data/config.ts: patrolPhotos` 里写死的 17 张设计稿静态图，
 * 元信息三行（分类 / 来源 / 时间）里的分类也是人工归的。现在照片来自
 * keehang 的真实航拍媒体（见 `stores/patrol.ts`），元信息相应改成
 * 「所属任务 / 拍摄时间 / 文件大小」—— 都是服务端给的字段。
 *
 * 图片是 OSS 签名直链，**单张 5~8MB**：
 *   · 打开弹层即加载原图（用户主动点了大图，流量花在该花的地方）；
 *   · 「原图」按钮因此没有了 —— 本身就是原图，没有更清晰的版本可换。
 *     （原版是「列表压缩图 → img/hd/ 高清版」，那是静态资源的做法。）
 */
const props = defineProps<{ id: string }>()

const shell = useShellStore()
const patrol = usePatrolStore()

const photo = computed(() => patrol.photos.find((p) => p.id === props.id))

/**
 * 大图缩放。
 *
 * 航拍照片的判读点常在小范围，不能放大等于看不了。
 * <img> 上直接挂这些监听与 style（不包容器 —— 包了会改掉
 * .patrol-view 的百分比高度与 flex item 语义）。
 */
const {
  zoomed: imgZoomed,
  label: zoomLabel,
  imgStyle,
  animating: zoomAnim,
  handlers: zoomHandlers,
  reset: zoomReset,
} = useImageZoom()

// 换照片时复原缩放，否则下次打开还停在上一张的倍率
watch(() => photo.value?.url, zoomReset)

/**
 * 存相册的预转 jpg：弹层一打开就在后台备好，点「下载」时才能在同一个
 * 用户手势里调起系统分享面板（见 utils/albumSave.ts）。
 */
const { file: albumFile } = useAlbumFile(
  () => photo.value?.url,
  () => photo.value?.name ?? '',
)

/**
 * 下载 = 存进手机相册。
 *
 * 手机浏览器没有写相册的 Web API，只能借系统分享面板落进相册；
 * 桌面或分享不可用时才退回 a[download] 存文件。
 */
async function onDownload(): Promise<void> {
  const p = photo.value
  if (!p) return
  try {
    const res = await savePhoto(p.url, p.name, albumFile.value)
    if (res === 'album') shell.showToast('已保存到相册', 'success')
    else if (res === 'download') shell.showToast('已开始下载', 'success')
  } catch {
    shell.showToast('保存失败', 'warn')
  }
}

/** 拍摄时间：服务端给的是 'YYYY-MM-DD HH:mm:ss'，截到分钟 */
const timeText = computed(() => {
  const t = photo.value?.time ?? ''
  if (!t) return '—'
  return t.slice(0, 16).replace('T', ' ')
})
</script>

<template>
  <div v-if="photo">
    <figure class="patrol-view">
      <img
        class="zoomable"
        :class="{ 'is-zoomed': imgZoomed, 'is-anim': zoomAnim }"
        :src="photo.url"
        :alt="photo.taskName"
        :style="imgStyle"
        v-on="zoomHandlers"
      />
      <span v-if="imgZoomed" class="zoom-badge">{{ zoomLabel }}</span>
    </figure>

    <div class="patrol-meta">
      <div><span>任务</span><b>{{ photo.taskName }}</b></div>
      <div>
        <span>来源</span>
        <span class="alarm-src alarm-src-drone">无人机</span>
      </div>
      <div><span>时间</span><b>{{ timeText }}</b></div>
      <div><span>大小</span><b>{{ patrol.sizeText(photo.size) }}</b></div>
    </div>

    <div class="photo-actions">
      <button class="photo-btn" type="button" @click="onDownload">下载</button>
    </div>
  </div>
</template>
