<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'

/**
 * 底部弹层外壳（2026-10 版本同步 · 第一批）
 *
 * 对应原版 #peoplePop 的三层结构（index.html:290-297 / app.css:2729-2765）：
 *   遮罩 → 面板（抓手条 + 标题行 + 内容）
 *
 * 与原版的差异：
 *   1. 原版常驻 DOM，靠 .open 切换 display。这里由 SheetHost 用 v-if 控制 ——
 *      弹层内容都是按需取数的，常驻没有意义；而且 v-if 让面板的入场动画
 *      每次都会重播，不需要手动重启动画。
 *   2. 补上 role="dialog" / aria-modal / 标题关联，以及 Esc 关闭与焦点回收：
 *      原版只有点击遮罩和 ×，键盘用户进去就出不来。
 *   3. 层级用 45 而不是原版的 80：本项目的 Toast 是 50，弹层之下才是
 *      子页（40）。取 45 夹在中间，弹层里触发的提示（如「已下发航线」）
 *      才不会被弹层自己盖住。
 *
 * 遮罩铺满整个 .phone-screen（含顶部状态栏那条留白）：本项目的状态栏是
 * 透明的，只在下面留一条不压暗的地图会看着像遮罩没铺满。浅色页上状态栏
 * 自带白底、压在遮罩之上，观感与只铺内容区一致。
 */
defineProps<{
  /** 标题（左）。内容里若已自带标题行，可留空 */
  title: string
  /** 标题下的说明行，如「在线 2 台 · 共 4 台」 */
  subtitle?: string
}>()

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)

/** 打开前焦点落在哪 —— 关闭后要还回去，否则键盘用户被丢回 body */
let restoreTo: HTMLElement | null = null

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  const active = document.activeElement
  restoreTo = active instanceof HTMLElement && active !== document.body ? active : null
  panel.value?.focus()
  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  // 触发按钮可能已随视图卸载（例如从子页打开弹层后又关闭了子页），
  // 那就别再抢焦点 —— 抢到游离节点上等于什么都没做，还会打断转场
  if (restoreTo?.isConnected) restoreTo.focus()
  restoreTo = null
})
</script>

<template>
  <div class="pop-layer">
    <!-- 遮罩用 button：既是点击关闭的命中区，也天然进 tab 序（读屏能读到「关闭」） -->
    <button class="pop-mask" type="button" aria-label="关闭" @click="emit('close')"></button>

    <section
      ref="panel"
      class="pop-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sheetTitle"
      tabindex="-1"
    >
      <div class="pop-grip" aria-hidden="true"></div>

      <header class="pop-hd">
        <h2 id="sheetTitle" class="pop-title">{{ title }}</h2>
        <slot name="meta" />
        <button class="pop-close" type="button" aria-label="关闭" @click="emit('close')">
          <SvgIcon name="close" />
        </button>
      </header>

      <p v-if="subtitle" class="pop-sub">{{ subtitle }}</p>

      <slot />
    </section>
  </div>
</template>
