<script setup lang="ts">
import { computed, nextTick, onUnmounted, watch } from 'vue'

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
 *
 * 2026-10 转场（微信式）：
 *   · 进入子页 / 子页之间的下钻 → 整层从右侧滑入（页面向左推进）
 *   · 点返回 / 右滑返回 → 整层向右滑出，露出真实上一页（页面向右退出）
 *   JS 里的 LEAVE_MS 必须与 app.css 的 subLeave 时长一致。
 */
const sub = useSubpageStore()
const alarm = useAlarmStore()

/** 当前层元素。刻意用 id 取而不是模板 ref：本组件是多根（垫底层 + 当前层），
 *  模板 ref 在这种结构下没绑定上（实测 pageEl 恒为 null，导致转场全部走兜底） */
function pageNode(): HTMLElement | null {
  return document.getElementById('subpage')
}

/** 与 app.css 的 subLeave 动画时长保持一致 */
const LEAVE_MS = 220

let leaveTimer = 0
/** 返回造成的视图变化不该再播「进入」动画，否则列表会从右侧重新滑进来 */
let suppressEnter = false
let leaving = false

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

/** 视图标识：kind 或具体预警 id 变化都算「换页」，要播进入动画 */
const viewKey = computed(() => {
  if (!sub.isOpen) return ''
  return sub.view.kind === 'alarm-detail' ? `detail:${sub.view.id}` : sub.view.kind
})

watch(
  viewKey,
  (next, prev) => {
    if (!next || next === prev || suppressEnter) return
    playEnter()
  },
  // DOM 更新后再播：否则元素还是 display:none，动画不启动
  { flush: 'post' },
)

function playEnter(): void {
  const el = pageNode()
  if (!el) return
  el.classList.remove('is-entering', 'is-leaving')
  // 强制重排：连续两次下钻（列表 → 详情 A → 详情 B）也能重新播放
  void el.offsetWidth
  el.classList.add('is-entering')
}

function prefersReduced(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** 改状态前压掉「进入」动画：这是一次返回，不是一次进入 */
function closeNow(): void {
  suppressEnter = true
  sub.close()
  nextTick(() => {
    suppressEnter = false
  })
}

function onBack(): void {
  const el = pageNode()

  // 右滑手势已经把该层移到屏幕外：这里只落状态，动画由手势层负责
  if (el?.style.transform) {
    closeNow()
    return
  }
  // 巡检日历展开时，返回只是「收起日历」，页面不该滑出
  if (alarm.inspCalOpen) {
    sub.close()
    return
  }
  if (leaving) return

  if (!el || prefersReduced()) {
    closeNow()
    return
  }

  // 先滑出再改状态：滑出过程中露出的是真实上一页（垫底层 / .pages），
  // 落点与右滑手势完全一致
  leaving = true
  el.classList.remove('is-entering')
  el.classList.add('is-leaving')
  leaveTimer = window.setTimeout(() => {
    leaving = false
    el.classList.remove('is-leaving')
    closeNow()
  }, LEAVE_MS)
}

// 转场途中被切 tab 打断（dismiss）时，清掉残留的动画类与定时器
watch(
  () => sub.isOpen,
  (open) => {
    if (open) return
    window.clearTimeout(leaveTimer)
    leaving = false
    pageNode()?.classList.remove('is-leaving', 'is-entering')
  },
)

onUnmounted(() => window.clearTimeout(leaveTimer))
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

  <section
    class="subpage"
    id="subpage"
    :class="{ open: sub.isOpen, 'is-alarm': sub.isAlarm }"
  >
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
