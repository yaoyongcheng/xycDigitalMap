<script setup lang="ts">
import { computed } from 'vue'

import { ICONS, type IconName, type IconShape } from '@/data/icons'

/**
 * 内联 SVG 图标
 *
 * 把 data/icons.ts 的结构化图标描述渲染成真实 SVG 元素，取代改造前的
 * 「HTML 字符串 + v-html 注入」。
 *
 * 根 <svg> 上的属性（fill / stroke / class / style 等）由调用方以普通
 * attribute 传入 —— 组件是单根节点，Vue 会自动透传到根元素，位置与改造前
 * 「直接写在 <svg ...> 上」完全一致。
 *
 *   <SvgIcon name="tab-home" />
 *   <SvgIcon name="drone" class="msg-svg" />
 *
 * 形状刻意用显式标签 + v-if 而非 <component :is>：显式标签在编译期就落在
 * SVG 命名空间里，不依赖运行时动态组件解析，路径最短也最好排查。
 */
const props = defineProps<{ name: IconName }>()

const def = computed(() => ICONS[props.name])

/** 取形状的属性部分（tag 只用于选标签，不写进 DOM） */
function shapeAttrs(s: IconShape): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {}
  for (const k in s) {
    if (k !== 'tag') out[k] = s[k]
  }
  return out
}
</script>

<template>
  <svg :viewBox="def.viewBox" v-bind="def.attrs ?? {}">
    <template v-for="(s, i) in def.shapes" :key="i">
      <path v-if="s.tag === 'path'" v-bind="shapeAttrs(s)" />
      <circle v-else-if="s.tag === 'circle'" v-bind="shapeAttrs(s)" />
      <rect v-else v-bind="shapeAttrs(s)" />
    </template>
  </svg>
</template>
