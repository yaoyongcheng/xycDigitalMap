<script setup lang="ts">
import { computed, nextTick, onUnmounted, watch } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import { mineNotes } from '@/data/config'
import { useAlarmStore } from '@/stores/alarm'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { titleOf, useSubpageStore, type SubView } from '@/stores/subpage'
import { takeSilentBack } from '@/utils/backAction'
import AlarmDetail from '@/views/sub/AlarmDetail.vue'
import AlarmHist from '@/views/sub/AlarmHist.vue'
import ClimbPage from '@/views/sub/ClimbPage.vue'
import DevicePage from '@/views/sub/DevicePage.vue'
import InspectList from '@/views/sub/InspectList.vue'
import LoginPage from '@/views/sub/LoginPage.vue'
import UavPage from '@/views/sub/UavPage.vue'
import WorkOrderDetail from '@/views/sub/WorkOrderDetail.vue'
import WorkOrderList from '@/views/sub/WorkOrderList.vue'

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
const droneAlarm = useDroneAlarmStore()

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

/** 无人机预警详情：数据在 droneAlarm store 里，找不到就不渲染（不会出现空白页） */
const workDetail = computed(() =>
  sub.view.kind === 'work-order-detail' ? droneAlarm.byId(sub.view.id) : undefined,
)

const placeholderName = computed(() => (sub.view.kind === 'placeholder' ? sub.view.name : ''))

/** 各「我的」入口的范围说明（见 data/config.ts 的 mineNotes 注释） */
const placeholderNote = computed(() => mineNotes[placeholderName.value] ?? '')

/**
 * 右滑返回 / 点返回滑出时要露出的「上一层」。
 *
 * 子页栈是同一个 .subpage 容器换内容（v-if），不是真正的多页叠加 —— 位移当前层
 * 时，露出来的是容器下面的 .pages（首页 / 消息页）。所以只要「上一层也是子页」，
 * 就必须把那一层只读地垫在下面，否则两段转场都会露出首页：
 *   · 进入：页面从 translateX(100%) 滑入，起点那一瞬整屏都是垫底内容；
 *   · 返回：页面滑出 0.22s，滑出的空当同理。
 * 现场反馈的「报警预警 ↔ 预警详情 切换时闪一下首页」就是这么来的。
 *
 * 这里取 `sub.back` 本身，而不是再写死某一种视图：
 *   · 巡检列表 → 详情：垫巡检列表（2026-10 的实现，只覆盖了这一种）
 *   · 报警预警历史 → 详情：垫历史页（2026-11 gx2 新增入口时漏了，
 *     于是进/出详情时露出首页 —— 本次修复的点）
 *   · 首页轮播 / 消息页 → 详情：back 为 null，不垫 —— 露出 .pages 本就正确
 */
const under = computed<SubView | null>(() => (sub.isOpen ? sub.back : null))

const underTitle = computed(() => (under.value ? titleOf(under.value) : ''))

/**
 * 视图标识：kind / 具体预警 id / 设备类型变化都算「换页」，要播进入动画 */
function keyOf(v: SubView | null): string {
  if (!v || v.kind === 'none') return ''
  if (v.kind === 'alarm-detail') return `detail:${v.id}`
  if (v.kind === 'work-order-detail') return `work:${v.id}`
  if (v.kind === 'device') return `device:${v.device}`
  return v.kind
}

const viewKey = computed(() => keyOf(sub.view))

/**
 * 列表视图当前的页签（2026-11-24）。
 *
 * 三个列表都是「一个容器、两套内容」：今日 / 历史用 `.hide` 切显隐，页签状态
 * 分别存在 `alarm.inspTab` / `alarm.histTab` / `drone.listTab` 里（都在 store，
 * 所以从详情返回时不会掉回默认页签）。
 */
function tabOf(v: SubView | null): string {
  if (!v) return ''
  if (v.kind === 'inspect-list') return alarm.inspTab
  if (v.kind === 'alarm-hist') return alarm.histTab
  if (v.kind === 'work-orders') return droneAlarm.listTab
  return ''
}

/** 滚动记忆的 key：视图 + 页签 */
function scrollKeyOf(v: SubView | null): string {
  const k = keyOf(v)
  if (!k) return ''
  const t = tabOf(v)
  return t ? `${k}:${t}` : k
}

/**
 * 滚动记忆用 scrollKey，**进入动画仍用 viewKey**。
 *
 * 两者必须分开：切页签（今日 ↔ 历史）时容器没换、不该重播滑入动画，
 * 但滚动位置必须分开记 —— 否则「在历史里滚到中段 → 点进详情 → 返回」
 * 会把历史那一页的 scrollTop 落到今日页签上（今日列表没那么长，直接贴底），
 * 现场观感就是「返回后列表跑到别的地方去了」。
 */
const scrollKey = computed(() => scrollKeyOf(sub.view))

/** 这个 key 是不是列表视图（带页签后缀，判基名） */
function isListKey(k: string): boolean {
  return LIST_KEYS.has(k.split(':')[0])
}

/**
 * 子页内的滚动位置记忆（2026-11-20）
 *
 * 现象：报警预警列表滚到中段 → 点某条进详情 → 返回，列表回到顶部。
 *
 * 原因不在列表自己：子页栈是**同一个 `.subpage-body` 换 v-if 内容**
 * （见下方模板），进详情时 `AlarmHist` / `InspectList` 被整棵卸载，滚动容器
 * 的高度瞬间塌成 0，浏览器把 `scrollTop` 归零；返回时列表是新挂载的，
 * 自然从头开始。列表数据、页签、日期都在 store 里，所以「浏览状态」其实
 * 保住了 —— 只有滚动位置没有落脚点。
 *
 * 做法：切换前把**列表类**视图的 `scrollTop` 记在这个按视图 key 索引的表里，
 * 切换后 nextTick 写回。
 *
 *   · 只记列表（{@link LIST_KEYS}）：详情页自己的位置没有意义，而且它的 key
 *     带报警 id，记下去会让这张表随浏览条数无界增长；记的键是「视图 + 页签」
 *     （见 {@link scrollKeyOf}），今日 / 历史各记各的；
 *   · 关闭子页（viewKey → ''）时清空：从首页重新点进来该从头看，而不是回到
 *     上次离开时的中段；
 *   · 垫底层（右滑 / 返回时露出的那一层）同步写回同一位置，否则退出动画的
 *     0.22s 里露出的是列表顶部，落位后再「啪」地跳到记忆位置。
 */
const scrollMemo = new Map<string, number>()
const LIST_KEYS = new Set(['inspect-list', 'alarm-hist', 'work-orders'])

watch(
  scrollKey,
  (next, prev) => {
    // pre：DOM 还是旧视图，读到的就是离场那一刻的真实位置
    const body = document.getElementById('subBody')
    if (prev && isListKey(prev)) scrollMemo.set(prev, body?.scrollTop ?? 0)
    if (!next) scrollMemo.clear()
  },
  { flush: 'pre' },
)

/*
 * 写回用 post 而不是在 pre 里 nextTick：
 *
 *   · post 在本次更新的 DOM patch 之后**同一个 flush 内**执行，写完就是稳定值；
 *   · 在 pre 里 `nextTick(cb)` 会排到这一轮 flush 结束之后，等于多隔一个微任务 ——
 *     列表已经渲染出来、可能已经画过一帧，才跳回记忆位置，肉眼能看到一次跳动。
 *
 * 数据都在 store 里，列表是同步渲染的，post 这一刻新内容的高度已经到位。
 */
watch(
  scrollKey,
  (next) => {
    if (!next) return
    const y = scrollMemo.get(next) ?? 0
    const cur = document.getElementById('subBody')
    if (cur) cur.scrollTop = y
    // 垫底层是这次返回的目标页（见 under 的注释），它得和落地后的位置一致，
    // 否则退出动画的 0.22s 里露出的是列表顶部，落位后再「啪」地跳一下
    const underBody = document.querySelector<HTMLElement>('.subpage-under .subpage-body')
    if (underBody) underBody.scrollTop = scrollMemo.get(scrollKeyOf(under.value)) ?? 0
  },
  { flush: 'post' },
)

watch(
  viewKey,
  (next, prev) => {
    if (!next || next === prev || suppressEnter) return
    playEnter()
  },
  // DOM 更新后再播：否则元素还是 display:none，动画不启动
  { flush: 'post' },
)

/** 清掉手势留下的内联位移（不播动画的那几条路径也要清，否则元素会停在偏移位） */
function resetInline(el: HTMLElement): void {
  el.style.transition = ''
  el.style.transform = ''
}

/**
 * 该层是否已被手势推到屏幕外（右滑松手后交给手势层收尾）。
 *
 * 用实际几何位置判断，而不是 `el.style.transform` 有没有值：手势被浏览器接管时
 * 会留下一份「拖到一半」的内联位移（例如 66px），那不是「已经滑出去了」，
 * 按旧写法会让之后每一次点返回都瞬关、且不进动画。
 */
function isSwipedOut(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.left > (el.clientWidth || 1) / 2
}

function playEnter(): void {
  const el = pageNode()
  if (!el) return
  el.classList.remove('is-entering', 'is-leaving')
  /*
   * 必须清掉内联位移：手势滑到一半被浏览器接管时（只剩 popstate、没有
   * pointerup），这里会残留一份 translate3d(66px…)。animation 优先级高于内联
   * style，所以进入动画播的时候看不出来 —— 动画一结束元素「啪」地跳回 66px，
   * 页面就像卡住不动了。这就是「右滑返回后第二次进详情卡住」的成因。
   */
  resetInline(el)
  // 强制重排：连续两次下钻（列表 → 详情 A → 详情 B）也能重新播放
  void el.offsetWidth
  el.classList.add('is-entering')
}

/** 退出过渡期间让底栏与状态栏提前切到「目标页面」的形态，避免上下白条 */
function markSwipeBack(on: boolean): void {
  document.querySelector<HTMLElement>('.app')?.classList.toggle('is-swipe-back', on)
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

  /*
   * 浏览器返回（popstate）引起的关闭：**当场落状态，不再补一段滑出**。
   *
   * 这时浏览器已经把整页推走过一遍（Safari / 微信内置浏览器的边缘侧滑都有
   * 自己的转场），再播 0.22s 的结果是「页面还停在详情，闪一下才变成报警预警」。
   * 应用内手势与返回箭头不走这里，仍然播同一段动画。
   */
  if (takeSilentBack()) {
    window.clearTimeout(leaveTimer)
    leaving = false
    sub.leaving = false
    if (el) resetInline(el)
    closeNow()
    nextTick(() => markSwipeBack(false))
    return
  }

  // 兜底：该层已经停在屏幕外（浏览器接管后残留的位移），再滑出一次只会看到
  // 一片空白，直接落状态。正常路径下手势层会先清掉位移，走不到这里。
  if (el && isSwipedOut(el)) {
    resetInline(el)
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
    if (el) resetInline(el)
    closeNow()
    return
  }

  // 先滑出再改状态：滑出过程中露出的是真实上一页（垫底层 / .pages），
  // 落点与右滑手势完全一致
  leaving = true
  /*
   * 只有「返回一级页面」才提前把外壳切成目标形态（状态栏透明、底栏露出来、
   * theme-color 转首页深色）。上一层仍是子页时不能切：
   *
   *   目标页面的顶部是白色导航栏，提前把 theme-color 切成首页深色后，
   *   手机浏览器会把地址栏 / 系统状态栏刷成一条黑带；同时 is-swipe-back 会
   *   放出首页底栏（home-mode 下是深蓝 #0B1626），底部露出一块灰面。
   *   这两处都不是页面内容，转场结束又瞬间变回白色 —— 现场看到的就是
   *   「返回时顶上黑一条、底下灰一块」。子页 → 子页本就是白顶浅底，形态不变。
   */
  if (!sub.back) {
    sub.leaving = true
    markSwipeBack(true)
  }
  // 手势残留的位移先清掉，滑出动画才会从 0 起播（否则起点是被拖到的位置）
  resetInline(el)
  el.classList.remove('is-entering')
  el.classList.add('is-leaving')
  leaveTimer = window.setTimeout(() => {
    leaving = false
    sub.leaving = false
    el.classList.remove('is-leaving')
    closeNow()
    // 等 Vue 把新视图 patch 完再撤类，否则底栏会先缩回去一帧
    nextTick(() => markSwipeBack(false))
  }, LEAVE_MS)
}

// 转场途中被切 tab 打断（dismiss）时，清掉残留的动画类与定时器
watch(
  () => sub.isOpen,
  (open) => {
    if (open) return
    window.clearTimeout(leaveTimer)
    leaving = false
    sub.leaving = false
    markSwipeBack(false)
    const node = pageNode()
    node?.classList.remove('is-leaving', 'is-entering')
    if (node) resetInline(node)
  },
)

onUnmounted(() => {
  window.clearTimeout(leaveTimer)
  markSwipeBack(false)
})
</script>

<template>
  <!--
    上一层（只读垫底）。刻意复用 .subpage 的布局类，保证右滑露出时
    导航栏 / 内边距与真实返回目标完全一致；pointer-events 已由 CSS 关掉，
    返回箭头用 <span> 而不是 <button>，不参与键盘与点击。

    新增「可被下钻的页面」时，记得在这里补一条 decorative 分支：漏了不会报错，
    只会在这个页面的转场空当里露出一片空白（比露首页好认，但一样是 bug）。
  -->
  <section v-if="under" class="subpage subpage-under open" aria-hidden="true">
    <nav class="navbar">
      <div class="nav-side">
        <span class="nav-btn"><SvgIcon name="back" /></span>
      </div>
      <h1 class="nav-title">{{ underTitle }}</h1>
      <div class="nav-side right"></div>
    </nav>
    <div class="subpage-body">
      <InspectList v-if="under.kind === 'inspect-list'" decorative />
      <AlarmHist v-else-if="under.kind === 'alarm-hist'" decorative />
      <WorkOrderList v-else-if="under.kind === 'work-orders'" decorative />
    </div>
  </section>

  <section
    class="subpage"
    id="subpage"
    :class="{ open: sub.isOpen, 'is-alarm': sub.isAlarm, 'is-dark': sub.isDark }"
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
      <DevicePage v-else-if="sub.view.kind === 'device'" :kind="sub.view.device" />
      <UavPage v-else-if="sub.view.kind === 'uav'" />
      <ClimbPage v-else-if="sub.view.kind === 'climb'" />
      <AlarmHist v-else-if="sub.view.kind === 'alarm-hist'" />
      <WorkOrderList v-else-if="sub.view.kind === 'work-orders'" />
      <WorkOrderDetail
        v-else-if="sub.view.kind === 'work-order-detail' && workDetail"
        :work="workDetail"
      />
      <LoginPage v-else-if="sub.view.kind === 'login'" />
      <div v-else-if="sub.view.kind === 'placeholder'" class="card">
        <h4 class="sub-ph-title">{{ placeholderName }}</h4>
        <p class="empty-note">{{ placeholderNote }}</p>
      </div>
    </div>
  </section>
</template>
