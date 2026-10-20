<script setup lang="ts">
import { computed } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import { mineNotes } from '@/data/config'
import { useAlarmStore } from '@/stores/alarm'
import { useSubpageStore } from '@/stores/subpage'
import AlarmDetail from '@/views/sub/AlarmDetail.vue'
import InspectList from '@/views/sub/InspectList.vue'

/**
 * 子页栈
 *
 * 对应原 index.html:313-324 + paintSub/openSub/openAlarmDetail/openInspectList
 * /closeSub（app.js:801-851）+ #btnBack（app.js:875）。
 *
 * 三个视图由 subpage store 的 view 描述符驱动（替代原版的函数引用栈 subBack）：
 *   inspect-list  巡检列表
 *   alarm-detail  预警详情
 *   placeholder   「我的」菜单项的占位文案（原 pageHtml）
 */
const sub = useSubpageStore()
const alarm = useAlarmStore()

const detail = computed(() => (sub.view.kind === 'alarm-detail' ? alarm.byId(sub.view.id) : undefined))

const placeholderName = computed(() => (sub.view.kind === 'placeholder' ? sub.view.name : ''))

/** 各「我的」入口的范围说明（见 data/config.ts 的 mineNotes 注释） */
const placeholderNote = computed(() => mineNotes[placeholderName.value] ?? '')

/**
 * 右滑返回时要露出的「上一层」。
 *
 * 子页栈是同一个 .subpage 容器换内容（v-if），不是真正的多页叠加 ——
 * 所以详情页跟手右移时，露出来的是容器下面的 .pages（消息页 / 首页），
 * 与「点返回键会到巡检列表」的实际行为不一致，看起来就是「闪一下消息页」。
 *
 * 只有「详情页且上一层是巡检列表」这一种情况需要垫底图：
 *   · 从巡检列表进详情 → 上一层是列表，需要垫
 *   · 从首页轮播进详情 → 上一层是首页，露出 .pages 本就正确
 *   · 列表页 / 占位页 → 上一层就是 tab 页，同理
 */
const underKind = computed(() =>
  sub.view.kind === 'alarm-detail' && sub.back?.kind === 'inspect-list' ? 'inspect-list' : null,
)

const underTitle = computed(() => (underKind.value === 'inspect-list' ? '巡检预警' : ''))

function onBack(): void {
  // 原 js/app.js:875 直接把 closeSub 当回调，事件对象被当作 force 传入，
  // 结果恒不等于 true —— 这里显式传 false，行为一致。
  sub.close()
}
</script>

<template>
  <!--
    上一层（只读垫底）。刻意复用 .subpage 的布局类，保证右滑露出时
    导航栏 / 内边距与真实返回目标完全一致；pointer-events 已由 CSS 关掉，
    返回箭头用 <span> 而不是 <button>，不参与键盘与点击。
  -->
  <section v-if="underKind" class="subpage subpage-under open" aria-hidden="true">
    <nav class="navbar">
      <div class="nav-side">
        <span class="nav-btn"><SvgIcon name="back" /></span>
      </div>
      <h1 class="nav-title">{{ underTitle }}</h1>
      <div class="nav-side right"></div>
    </nav>
    <div class="subpage-body">
      <InspectList v-if="underKind === 'inspect-list'" />
    </div>
  </section>

  <section class="subpage" id="subpage" :class="{ open: sub.isOpen, 'is-alarm': sub.isAlarm }">
    <nav class="navbar">
      <div class="nav-side">
        <button
          class="nav-btn"
          id="btnBack"
          type="button"
          aria-label="返回"
          data-back
          @click="onBack"
        >
          <SvgIcon name="back" />
        </button>
      </div>
      <h1 class="nav-title" id="subTitle">{{ sub.title }}</h1>
      <div class="nav-side right"></div>
    </nav>

    <div class="subpage-body" id="subBody">
      <InspectList v-if="sub.view.kind === 'inspect-list'" />
      <AlarmDetail v-else-if="sub.view.kind === 'alarm-detail' && detail" :alarm="detail" />
      <div v-else-if="sub.view.kind === 'placeholder'" class="card">
        <h4 class="sub-ph-title">{{ placeholderName }}</h4>
        <p class="empty-note">{{ placeholderNote }}</p>
      </div>
    </div>
  </section>
</template>
