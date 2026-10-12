<script setup lang="ts">
import { useHomeStore } from '@/stores/home'
import EquipPanel from './EquipPanel.vue'
import ProgressPanel from './ProgressPanel.vue'
import QualityPanel from './QualityPanel.vue'
import SafetyPanel from './SafetyPanel.vue'
import type { HomeMod } from '@/types'

/**
 * 首页半屏抽屉
 *
 * 对应原 index.html:212-232 + renderHomePanel()（app.js:627-639）
 * + homeMods 切换委托（app.js:941-947）。
 *
 * 面板分发替代原版的 if/else 链：
 *   safety -> SafetyPanel / quality -> QualityPanel
 *   progress -> ProgressPanel / equip -> EquipPanel
 *
 * 原版 renderHomePanel 在切到 safety 时还会 requestAnimationFrame
 * 启动预警轮播、切走时停止 —— 该职责已下沉到 SafetyPanel 自身
 * 的 onMounted/onUnmounted（面板挂载即启动，卸载即停止，语义等价）。
 */
const home = useHomeStore()

const mods: { id: HomeMod; label: string; svg: string }[] = [
  {
    id: 'safety',
    label: '安全管理',
    svg: '<path d="M12 3.5 19 6.2v5.4c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V6.2z"/><path d="M8.8 12.2 11 14.4l4.4-4.6"/>',
  },
  {
    id: 'quality',
    label: '质量管理',
    svg: '<rect x="6.2" y="3.8" width="11.6" height="16.4" rx="2"/><path d="M9 3.8h6v2.6H9z"/><path d="M8.7 12.4 10.8 14.5l4.6-4.8"/>',
  },
  {
    id: 'progress',
    label: '进度管理',
    svg: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.2l3 1.6"/>',
  },
  {
    id: 'equip',
    label: '装备管控',
    svg: '<path d="M4.5 20h15"/><path d="M7 20V7.5h3.2V20"/><path d="M8.6 7.5H20l-3.2 6.2"/><path d="M16.8 13.7V20"/><circle cx="16.8" cy="11.2" r="1.1"/>',
  },
]
</script>

<template>
  <div class="home-sheet">
    <div class="home-mods" id="homeMods">
      <button
        v-for="m in mods"
        :key="m.id"
        class="home-mod"
        :class="{ on: home.homeMod === m.id }"
        :data-mod="m.id"
        type="button"
        @click="home.homeMod = m.id"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" v-html="m.svg" />
        <span>{{ m.label }}</span>
      </button>
    </div>

    <div class="home-panels" id="homePanels">
      <SafetyPanel v-if="home.homeMod === 'safety'" />
      <QualityPanel v-else-if="home.homeMod === 'quality'" />
      <ProgressPanel v-else-if="home.homeMod === 'progress'" />
      <EquipPanel v-else />
    </div>
  </div>
</template>
