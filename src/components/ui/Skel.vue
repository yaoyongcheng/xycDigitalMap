<script setup lang="ts">
/**
 * 骨架灰条（2026-11 慢加载改造）
 *
 * 只做一件事：占住一块「数据将来会出现在这里」的位置。
 *
 * 尺寸必须由调用方按**它所替换的真实元素**传进来（宽高都用 CSS 长度），
 * 不接受「自己撑开多少算多少」：骨架与内容共用同一套布局，数据到达时
 * 原位替换，容器高度不变，下面的内容不跳。这也是它不接受 children 的原因 ——
 * 里面不需要任何内容。
 *
 * 颜色不在这里定：`.skel` 有浅底/深底两套（见 app.css 的 --skel*），
 * 由所在页面的主题决定，组件本身不关心。
 */
withDefaults(
  defineProps<{
    /** 宽度（CSS 长度），默认占满 */
    w?: string
    /** 高度（CSS 长度），默认一行文字高 */
    h?: string
    /** 圆角，默认 --r-4 */
    r?: string
    /** 圆形占位（头像 / 环形图） */
    circle?: boolean
  }>(),
  { w: '100%', h: '12px', r: 'var(--r-4)', circle: false },
)
</script>

<template>
  <i
    class="skel"
    :class="{ 'is-circle': circle }"
    :style="{ width: w, height: h, borderRadius: circle ? '50%' : r }"
    aria-hidden="true"
  />
</template>
