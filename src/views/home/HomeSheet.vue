<script setup lang="ts">
import { computed } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useHomeStore } from '@/stores/home'
import EquipPanel from './EquipPanel.vue'
import ProgressPanel from './ProgressPanel.vue'
import QualityPanel from './QualityPanel.vue'
import SafetyPanel from './SafetyPanel.vue'
import type { IconName } from '@/data/icons'
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

/**
 * 抽屉跟手拖拽（2026-10 改造新增）
 * dragTop 非空时以 inline top 覆盖 CSS 档位定位（拖拽中/半开档）；
 * grab 事件由顶部抓手条上抛，拖拽逻辑在 HomePage 统一处理。
 *
 * 2026-10 视觉改造·第五批：抓手条从「一根装饰条」升级成唯一的手柄 ——
 * 原先它被浮在抽屉边缘的「半开」药丸整个盖住，等于不存在；而那颗药丸
 * 又骑在抽屉上沿，滚动内容会从它下面穿过去（实测「01 预警」标题被压掉
 * 半行）。现在药丸撤掉，抓手条常驻吸顶，既是拖拽入口也是点击入口。
 */
/** level 有默认值：抽屉默认全开（与 store 初值一致），单测里可以只传 dragTop */
const props = withDefaults(defineProps<{ dragTop: number | null; level?: 0 | 1 | 2 }>(), {
  level: 2,
})
const emit = defineEmits<{ grab: [e: PointerEvent]; toggle: [] }>()

function onGrab(e: PointerEvent): void {
  emit('grab', e)
}

/** 点击抓手条要去的档位（与 HomePage 的循环一致：收起 → 全开 → 半开 → 收起） */
const grabLabel = computed(() => ['展开面板', '收起面板', '半开面板'][props.level])

const mods: { id: HomeMod; label: string; icon: IconName }[] = [
  { id: 'safety', label: '安全管理', icon: 'mod-safety' },
  { id: 'quality', label: '质量管理', icon: 'mod-quality' },
  { id: 'progress', label: '进度管理', icon: 'mod-progress' },
  { id: 'equip', label: '装备管控', icon: 'mod-equip' },
]

/**
 * 共用指示条的下标。
 *
 * 改造前 4 个按钮各画一条自己的 ::after 下划线，切换时是「这条灭、那条亮」
 * 的瞬移；改成一条绝对定位的滑块后，切换有了方向感 —— 从旧位置滑过去。
 * 位移量由 CSS 用 --i 算（列宽 = 25% - 3px，gap 4px，见 app.css 的 .home-mod-ind）。
 */
const modIndex = computed(() => Math.max(0, mods.findIndex((m) => m.id === home.homeMod)))
</script>

<template>
  <div class="home-sheet" :style="dragTop !== null ? { top: dragTop + 'px' } : undefined">
    <!--
      抓手条：拖拽 + 点击同一个人体工学入口。
      吸顶（position: sticky）是为了滚动时它不被内容顶走 —— 抽屉里内容很长，
      滑到一半想收回面板时，手柄必须还在原地。
    -->
    <button
      class="sheet-grab"
      type="button"
      :aria-label="grabLabel"
      @pointerdown="onGrab"
      @click="emit('toggle')"
    >
      <i aria-hidden="true"></i>
      <svg
        class="grab-chev"
        :class="{ up: props.level === 0 }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
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
        <SvgIcon :name="m.icon" />
        <span>{{ m.label }}</span>
      </button>
      <!-- 共用滑块：绝对定位不参与 grid 排版，靠 --i 决定滑到第几列 -->
      <span class="home-mod-ind" :style="{ '--i': modIndex }" aria-hidden="true"><i></i></span>
    </div>

    <!--
      key 换掉整个面板容器，让面板下方的入场动画（app.css 的 homePanelIn）
      每次切换都重播一遍。
      为什么不做 <Transition>：四个面板组件都是多根节点（SafetyPanel 两个
      .safe-block、EquipPanel 是 v-if + v-else 两个 template），
      <Transition> 要求单一根元素，硬套会直接报错；包一层 div 又会破坏
      #homePanels 的 flex gap 节奏。
    -->
    <div class="home-panels" id="homePanels" :key="home.homeMod">
      <SafetyPanel v-if="home.homeMod === 'safety'" />
      <QualityPanel v-else-if="home.homeMod === 'quality'" />
      <ProgressPanel v-else-if="home.homeMod === 'progress'" />
      <EquipPanel v-else />
    </div>
  </div>
</template>
