<script setup lang="ts">
import { computed } from 'vue'

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

function onBack(): void {
  // 原 js/app.js:875 直接把 closeSub 当回调，事件对象被当作 force 传入，
  // 结果恒不等于 true —— 这里显式传 false，行为一致。
  sub.close()
}
</script>

<template>
  <section class="subpage" id="subpage" :class="{ open: sub.isOpen, 'is-alarm': sub.isAlarm }">
    <nav class="navbar">
      <div class="nav-side">
        <button class="nav-btn" id="btnBack" type="button" @click="onBack">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>
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
