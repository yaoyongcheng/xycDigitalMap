<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

/**
 * 带加载占位与失败兜底的图片（2026-10 交互优化新增，非原版内容）
 *
 * 改造前全站图片都是裸 `<img :src>`：加载中是一块纯空白，加载失败直接
 * 出破图或空白，两种状态都没有任何说明 —— 首屏与抓拍/航拍网格里尤其
 * 明显（用户看到的是一排说不清是「在加载」还是「没有数据」的空块）。
 *
 * 这里补三件事：
 *   ① 加载中显示占位色块（CSS 呼吸动画，见 .simg）
 *   ② 加载完成淡入，避免图片突然糊上来
 *   ③ 失败时换成一张内联 SVG 占位图，不再是破图
 *
 * 刻意让根元素就是 <img> 本身：既有 CSS 全是 `.air-card img` / `.cam-shot img`
 * 这类后代选择器与元素选择器，若包一层 <span> 会整片失效；同时父组件传的
 * class / id / style 会经 Vue 的 attribute 继承落到这个 <img> 上，
 * 调用点不用改选择器。
 */
const props = withDefaults(
  defineProps<{
    src: string
    alt?: string
    /** 裁切位置类（pos-left / pos-tl …），直接追加到 <img> 上 */
    pos?: string
  }>(),
  { alt: '', pos: '' },
)

/** 内联占位图（灰调、无外链，加载失败时顶上） */
const FALLBACK =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8A97A8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3.5" y="5" width="17" height="14" rx="2"/>' +
      '<path d="M3.5 15.8l4.3-4 3.4 3 2.8-2.4 6.5 5.2"/>' +
      '<circle cx="8.6" cy="9.6" r="1.2"/>' +
      '</svg>',
  )

const loaded = ref(false)
const failed = ref(false)
const el = ref<HTMLImageElement | null>(null)

/** 换图（切换点位 / 切换日期）时重置状态，否则会沿用上一张的「已加载」 */
watch(
  () => props.src,
  () => {
    loaded.value = false
    failed.value = false
    // 命中缓存时 load 可能早于监听器挂载，这里补一次实测
    syncComplete()
  },
)

function syncComplete(): void {
  const img = el.value
  if (!img) return
  // 空 src（如大图弹层还没选中项）按失败处理，免得停在占位态不动
  if (!props.src) {
    failed.value = true
    loaded.value = true
    return
  }
  if (img.complete && img.naturalWidth > 0) loaded.value = true
}

onMounted(syncComplete)

function onLoad(): void {
  loaded.value = true
}

function onError(): void {
  // 兜底图自身若也失败，到此为止，不再触发第二次 error
  if (failed.value) return
  failed.value = true
  loaded.value = true
}
</script>

<template>
  <img
    ref="el"
    class="simg"
    :class="[props.pos, { 'is-loaded': loaded, 'is-failed': failed }]"
    :src="failed ? FALLBACK : props.src"
    :alt="props.alt"
    loading="lazy"
    decoding="async"
    @load="onLoad"
    @error="onError"
  />
</template>
