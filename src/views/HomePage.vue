<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import MapViewer from '@/components/ui/MapViewer.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useSceneStore } from '@/stores/scene'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import HomeSheet from './home/HomeSheet.vue'

/**
 * 首页
 *
 * 对应原 index.html:185-233 + setSheetUp()（app.js:927-939）
 * + 全屏按钮（app.js:1715）。
 * 抽屉与其内的四个面板交由 HomeSheet 组件。
 *
 * 2026-10 改造新增：.home-map 内嵌 MapViewer —— 静态底图升级为地图层；
 *   2026-11 设计稿（gx2 换底图）起底图上只保留报警撒点，设施/楼栋撒点与
 *   楼栋信息卡整体下线。
 *   2026-11-23：首页这份实例改为 `locked` —— 底图固定在背景位，不响应
 *   拖拽 / 捏合 / 滚轮 / 双击，也不显示缩放控件；要看细节点「全屏」。报警
 *   撒点仍可点击（只禁用平移缩放，不禁用按钮）。
 * ② 抽屉支持跟手拖拽 + 两档吸附（半开/全开），档位状态在
 *    shell.sheetLevel；拖拽中的临时位置走 dragTop 内联样式，
 *    松手吸附后全开交还 CSS 变量、半开常驻内联值。
 *    2026-11-23：原「收起」档下线（用户要求浮窗常驻），最低即半开。
 */
const shell = useShellStore()
const alarm = useAlarmStore()
const subpage = useSubpageStore()
const scene = useSceneStore()

/**
 * 首页背景（三维场景图）改由场景截图接口动态取（2026-11-18）。
 *
 * 这里只发起一次：store 内部按类型去重 + 成功后整个会话复用，
 * 切标签导致首页卸载重挂时不会重复下 3MB。取不到时的落点有三层 ——
 * 本机落盘的本地兜底图（IndexedDB，比打包图新）→ public/img 的
 * site-map.webp（内置兜底），布局与首屏观感不变。
 */
const map3d = computed(() => scene.src('3d'))

/**
 * `.home-map` 那层 CSS 背景也跟着换成接口图。
 *
 * 它平时被 MapViewer 的 `<img>` 完全盖住，只在「图片字节还没到」的空窗期
 * 露出来；换成同一张图能让这段空窗期的画面连续，不必先从旧图跳一下。
 * 内联 url 用双引号包住 —— objectURL 里不会出现引号，但 `blob:` 在部分
 * 浏览器会带括号，包起来更稳。
 */
const mapBgStyle = computed(() =>
  scene.isLive('3d') ? { backgroundImage: `url("${map3d.value}")` } : {},
)

const pageEl = ref<HTMLElement | null>(null)

/**
 * --sheet-up-top 的合理上限（px）。
 *
 * .home-project-row 恒定在首页顶部区域，正常结果约 110~150px，300px 已相当宽松。
 * 这里刻意用绝对值而不是「页面高度的百分比」：真机诊断显示，出问题的那一刻
 * 页面高度本身也会异常（Safari 恢复标签页时先以错误的视口高度渲染一瞬），
 * 百分比阈值会跟着一起放大而失效 —— 实测放行过一个 505px 的坏值。
 */
const SHEET_TOP_MAX = 300

/** 布局稳定后的补测句柄 */
let recalibrateTimer = 0

/**
 * 测量全开档的抽屉顶位置（原 js/app.js:927-939 setSheetUp 的取值部分）。
 * 需要真实测量 .home-project-row 的位置，故直接操作 DOM（这是测量，不是状态）。
 * 测量不合法（布局未就绪/异常视口）时返回 null，由调用方决定回退。
 */
function measureExpandedTop(): number | null {
  const el = pageEl.value
  if (!el) return null
  const prog = el.querySelector('.home-project-row')
  if (!prog) return null
  const pageRect = el.getBoundingClientRect()
  const progRect = prog.getBoundingClientRect()
  const top = Math.round(progRect.bottom - pageRect.top + 12)
  /*
   * 只接受落在合理区间的结果：布局未就绪时 rect 会整体为 0（元素尚未参与
   * 布局，或所在页面正处于 display:none），此时算出的值会把抽屉顶到错误位置。
   */
  if (top <= 24 || top >= SHEET_TOP_MAX) return null
  return top
}

/** 原 setSheetUp() 中写 --sheet-up-top 的那段 */
function applySheetTop(): void {
  const el = pageEl.value
  if (!el) return
  const top = measureExpandedTop()
  /*
   * 测量失败时保留 CSS 里 --sheet-up-top 的默认值（118px）。
   * 该变量一旦被写成坏值，top 声明本身仍合法，不会回退到默认值，
   * 抽屉就永久停在错误位置。
   */
  if (top === null) return
  el.style.setProperty('--sheet-up-top', top + 'px')
}

/* ---------------- 抽屉两档与跟手拖拽（新增） ---------------- */

/** 拖拽中的临时顶位置（px）；null 表示交还 CSS（class/变量）控制 */
const dragTop = ref<number | null>(null)

/** 拖拽进行中（用于关闭 CSS transition，避免跟手迟滞） */
const dragging = ref(false)

/**
 * 两档吸附位置（px，相对页面顶部）。
 *
 * half 仍按「全开位与 42% 基准位的中点」算。42% 已经不再是可达档位，
 * 但它是半开档唯一的几何参照 —— 保留这条算式，半开停的位置就与三档
 * 时期逐像素一致，用户只会少掉「收起」，不会觉得半开忽然换了高度。
 * 不能直接把 42% 当半开：那原本是最低档（盖住下半屏），比半开矮一截。
 */
function sheetAnchors(): { expanded: number; half: number } {
  const h = pageEl.value?.getBoundingClientRect().height ?? 0
  const expanded = measureExpandedTop() ?? 118
  /*
   * 页面高度还没测出来（首帧、页面被隐藏）时按 42% 算会落到全开位上方，
   * 抽屉反而更靠上。给半开一个下限：至少比全开低 56px，绝不越过全开。
   */
  const ref = Math.round(h * 0.42)
  return { expanded, half: Math.max(expanded + 56, Math.round((expanded + ref) / 2)) }
}

/** 当前档位对应的顶位置（px） */
function currentLevelTop(): number {
  const a = sheetAnchors()
  return shell.sheetLevel === 2 ? a.expanded : a.half
}

let dragStartY = 0
let dragStartTop = 0
let dragMoved = false
let suppressToggleClick = false

/** 拖拽入口：切换按钮的 pointerdown 与 HomeSheet 抓手条的 grab 事件共用 */
function onDragStart(e: PointerEvent): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  dragStartY = e.clientY
  dragStartTop = dragTop.value ?? currentLevelTop()
  dragMoved = false
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
}

function onDragMove(e: PointerEvent): void {
  const dy = e.clientY - dragStartY
  if (!dragMoved && Math.abs(dy) > 4) {
    dragMoved = true
    dragging.value = true
  }
  if (!dragMoved) return
  const a = sheetAnchors()
  // 只在两档之间拖：允许轻微越界（±20px）做弹性，松手后吸附回档位
  dragTop.value = Math.min(a.half + 20, Math.max(a.expanded - 20, dragStartTop + dy))
}

function onDragEnd(): void {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  if (!dragMoved) return
  // 抑制拖拽后合成 click 误触切换按钮的收放
  suppressToggleClick = true
  window.setTimeout(() => {
    suppressToggleClick = false
  }, 50)

  const a = sheetAnchors()
  const t = dragTop.value ?? dragStartTop
  // 吸附到最近档位（只有半开与全开两档）
  const candidates: { level: 1 | 2; top: number }[] = [
    { level: 2, top: a.expanded },
    { level: 1, top: a.half },
  ]
  candidates.sort((x, y) => Math.abs(x.top - t) - Math.abs(y.top - t))
  const target = candidates[0]

  dragging.value = false
  shell.sheetLevel = target.level
  if (target.level === 1) {
    // 半开档无对应 CSS 规则，常驻内联位置
    dragTop.value = target.top
  } else {
    // 全开交还 CSS（is-sheet-up + --sheet-up-top），摘掉内联值后由 transition 完成吸附
    dragTop.value = null
    nextTick(applySheetTop)
  }
}

/** 转屏 / 退出全屏：动画落定后再量一次（与 `utils/orientation.ts` 的 340ms 同源） */
let resizeSettleTimer = 0

function recalibrateSheet(): void {
  // 全开档位置依赖项目名行的测量
  void nextTick(applySheetTop)
  // 半开档位置依赖页面高度，窗口变化时重算内联值
  if (shell.sheetLevel === 1) dragTop.value = sheetAnchors().half
}

function onResize(): void {
  recalibrateSheet()
  /*
   * 转屏 / 全屏进出的动画期间，`getBoundingClientRect` 读到的还是旧高度，
   * 只靠上面这一次会把抽屉定在错的位置（横屏量出的半开位明显偏高）。
   * 等动画（约 300ms）落定后再校准一次 —— 这是「退出全屏后整页/抽屉上移」
   * 的直接来源之一。
   */
  window.clearTimeout(resizeSettleTimer)
  resizeSettleTimer = window.setTimeout(recalibrateSheet, 360)
}

/**
 * 页面重新可见时，确认一次首页背景有没有更新（2026-11-24）。
 *
 * 本次优化后同一会话内不再重复取图（`ok` 直接返回），所以「早上截图、下午
 * 一直开着前台」这种场景需要一次补确认。门槛在 store 里（10 分钟）：没过门槛
 * 直接返回，过了就带 ETag 校验一次 —— 图没变只是一个 304，几十毫秒。
 */
function onVisible(): void {
  if (document.visibilityState !== 'visible') return
  void scene.revalidate('3d')
}

onMounted(() => {
  /*
   * 半开档只在「拖/点到达」时写过内联 top，刷新后这个内联值不存在，
   * 只剩 is-sheet-up —— CSS 会按全开位渲染，用户看到的和记住的档位对不上。
   * 这里在首次布局完成后立刻按档位补一次，且同步执行（不等 nextTick），
   * 让它在首帧之前生效，避免刷新后先闪一下全开再跳到中间。
   */
  if (shell.sheetLevel === 1) dragTop.value = sheetAnchors().half
  nextTick(applySheetTop)
  /*
   * 首次测量可能早于布局稳定 —— Safari 恢复标签页时，地址栏的收放会改变
   * 100dvh，页面高度在最初几帧是错的，此时测出的值会被上面的校验拦下，
   * 抽屉停在 CSS 默认位置（视觉正确但不精确）。
   * 下面两处补测让它在布局稳定后自动校准回来。
   */
  recalibrateTimer = window.setTimeout(applySheetTop, 600)

  // 首页背景 = 三维场景图，挂载即取。
  // store 保证：本机有图时先上本地图再带 ETag 校验（没更新就 304，不再下 3.3MB），
  // 同一会话内成功后也不再重复请求。
  void scene.load('3d')

  document.addEventListener('visibilitychange', onVisible)

  window.addEventListener('resize', onResize)
  // Safari 的地址栏收放只改 visualViewport，未必触发 window 的 resize
  window.visualViewport?.addEventListener('resize', onResize)
  // 转屏不一定派发 resize（尤其系统全屏进出 + 方向锁的组合），单独听一次
  window.addEventListener('orientationchange', onResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.visualViewport?.removeEventListener('resize', onResize)
  window.removeEventListener('orientationchange', onResize)
  document.removeEventListener('visibilitychange', onVisible)
  window.clearTimeout(recalibrateTimer)
  window.clearTimeout(resizeSettleTimer)
  onDragEnd()
})

watch(
  () => shell.sheetLevel,
  (v) => {
    if (v === 2) nextTick(applySheetTop)
  },
)

/** 点按抓手条在半开 / 全开之间切换（不再有收起档）。 */
function onSheetToggle(): void {
  if (suppressToggleClick) return
  const next: 1 | 2 = shell.sheetLevel === 2 ? 1 : 2
  shell.sheetLevel = next
  /*
   * 半开档没有对应的 CSS 规则（CSS 只写了全开位），点按到达时必须补上
   * 内联位置，否则抽屉会留在全开位置。拖拽到达的同一分支见 onDragEnd。
   */
  dragTop.value = next === 1 ? sheetAnchors().half : null
}

function onMapFull(): void {
  shell.openMapLand()
}

/** 当日预警撒点（三维图坐标） */
const mapAlarmPins = computed(() => alarm.mapAlarms('pin'))

/**
 * 报警撒点点击 → 预警详情。
 *
 * fromList=false：返回键直接回首页 —— 撒点不是从巡检列表进来的，
 * 没有「上一层列表」可回（与原版轮播、onAlarmPin 的口径一致）。
 */
function onMapAlarm(id: string): void {
  subpage.openAlarmDetail(id, false)
}
</script>

<template>
  <section
    class="page home-page is-sheet-up"
    id="page-home"
    ref="pageEl"
    :class="{
      active: shell.activeTab === 'home',
      'is-sheet-full': shell.sheetLevel === 2,
      'is-dragging': dragging,
    }"
  >
    <div class="home-scene">
      <div class="home-map" :style="mapBgStyle">
        <!--
          全屏地图打开时挂起首页这份实例：两者互斥，任一时刻只有一个在观测
          容器尺寸（MapViewer 的 suspended 说明见组件内注释）。

          locked：首页只是背景图，尺寸与位置不随用户操作变化。全屏那份
          不带 locked，缩放/拖动照旧。
        -->
        <MapViewer
          :alarms="mapAlarmPins"
          :src="map3d"
          fit="cover"
          compact
          locked
          :suspended="shell.mapLandOpen"
          @alarm="onMapAlarm"
        />
      </div>
      <div class="home-top">
        <div class="home-project-row">
          <div class="home-project">向阳村项目智能建造管理平台</div>
          <button class="home-full" id="btnMapFull" type="button" @click="onMapFull">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 5H5v3M16 5h3v3M8 19H5v-3M16 19h3v-3"/></svg>
            全屏
          </button>
        </div>
      </div>
    </div>

    <HomeSheet
      :drag-top="dragTop"
      :level="shell.sheetLevel"
      @grab="onDragStart"
      @toggle="onSheetToggle"
    />
  </section>
</template>
