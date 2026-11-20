<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import SmartImg from '@/components/ui/SmartImg.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import ThumbRing from '@/components/ui/ThumbRing.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import type { WorkOrderStatus } from '@/api/drone'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useSubpageStore } from '@/stores/subpage'
import { alarmTrendLive } from '@/utils/chart'
import { useSlowLoading } from '@/utils/slowLoading'
import { revealThumb } from '@/utils/thumbReveal'

/**
 * 无人机预警列表（子页内容）
 *
 * 数据源是 keehang 审核中心的 AI 工单（= V2 大屏「工单列表」），字段与口径见
 * `api/drone.ts::fetchAuditWorkOrders` 与 `stores/droneAlarm.ts`。
 *
 * ## 版式与「监控预警」子页逐项对齐（2026-11-20 二次对齐）
 *
 * 两个子页是同一层级的入口，观感必须一致，所以这里**不另起一套版式**：
 *   · 页签 —— `.insp-tabs` / `.insp-tab`：**今日预警 / 历史预警**（与监控同名同位）；
 *   · 统计行 —— `.home-stats.alarm-row`：左「今日预警数」（`.home-stat.alert` 红字）、
 *     右「近7日预警趋势」（`TouchChart`，与监控同一套折线 + 触控气泡）；
 *   · 列表 —— `.insp-list` / `.insp-item`：48px 无人机占位图标、标题 + 来源徽标、
 *     副标题一行任务名、右侧相对时间 + 状态徽标；
 *   · 未处理红点 —— `.insp-pic-box` + `.insp-dot`（与监控今日列表同一颗点：
 *     9px 实心 + 2px 白圈，压在图标位右上角）；
 *   · 空态 `.insp-empty`、骨架 `.insp-item.is-skel`、底部 `.msg-more` 全部复用。
 *
 * ## 今日 / 历史的分法
 *
 * 审核中心接口没有时间筛选（见 `stores/droneAlarm.ts` 的文件头），但返回按
 * `businessTime` 倒序，所以「今日」就是数据前缀 —— 首屏扫到 7 日窗口之外，
 * 今日条数就是精确值，历史接着往后翻页。**不摆日期选择器**：点了也没反应
 * 比没有更糟。
 *
 * ## 红点为什么是「状态」而不是「已读」
 *
 * 工单行里没有未读/已读字段（`auditStatusType` 只有 `UNAUDITED` / `AUDITED`），
 * 所以按现场规则用状态代替：今日 + 待处理 → 红点；已完成 → 没有。
 * 历史一律不点、不计数。点开一条只进详情，**不改状态**（那是审核平台的人工动作）。
 *
 * ## 图标位：与「监控预警」同一套取图逻辑（2026-11-20 对齐）
 *
 * 现场要求两个子页的图标「显示条件 / 状态映射 / 样式 / 交互」完全一致，
 * 所以这里照 `components/ui/InspectItem.vue` 的做法逐条搬过来：
 *
 *   ① 滚到视口附近（240px 提前量）才取图，用全站同一个 `revealThumb` 观察器；
 *   ② 拿到了铺 `.insp-pic` 缩略图（48px 圆角 + `object-fit: cover`）；
 *   ③ 没有 / 还没到 → **原样铺那颗灰底无人机占位图标**（`.alarm-tile`），
 *      灰底、内描边、图标 50% 尺寸与改之前一个像素都不差；
 *   ④ 取图过程中在占位图标外圈叠一圈 `ThumbRing`（真实字节进度）；
 *   ⑤ 红点独立于图，仍由 `isUnread` 决定。
 *
 * 工单图是 OSS **预签名**直链：CORS 通、但 `x-oss-process` 会被签名校验打回 403，
 * 所以缩图只能在前端做（`utils/imageThumb.ts`）并落盘（`utils/thumbCache.ts`）。
 * 为什么不直接铺原图：单张 200~300KB、没有 `Cache-Control`，一屏十来条就是几 MB，
 * 而且每次进页面都要重下一遍。
 */
const props = defineProps<{ decorative?: boolean }>()

const drone = useDroneAlarmStore()
const subpage = useSubpageStore()

/** 当前页签（本页自己的状态：监控那页存在 alarm store 里，是因为那边要记日期） */
const tab = ref<'today' | 'hist'>('today')
const onHist = computed(() => tab.value === 'hist')

/** 首屏还没拿到今日数（没有结论就不铺 0） */
const syncing = computed(() => !drone.todayKnown && (drone.state === 'loading' || drone.state === 'idle'))

/** 慢请求才显示骨架：快请求直接出内容，不闪灰条 */
const showSkel = useSlowLoading(() => syncing.value)
const showMoreSkel = useSlowLoading(() => drone.loadingMore)

/**
 * 近 7 日趋势：与首页 / 监控子页同款触控层。
 * fillId 必须错开 —— 三个图可能同时挂在 DOM 里，渐变 id 撞了会互相引用。
 */
const trendModel = computed(() => alarmTrendLive(drone.weekTrend, 'woAlarmFill'))
const hasTrend = computed(() => drone.weekTrend.some((p) => p.value > 0))

function onTab(next: 'today' | 'hist'): void {
  if (tab.value === next) return
  tab.value = next
}

function onOpen(id: string): void {
  if (props.decorative) return
  subpage.openWorkOrderDetail(id)
}

/**
 * 图标位：滚到视口附近才去取这一条的缩略图（与 `InspectItem` 共用同一个观察器）。
 *
 * 列表是 v-for 出来的，没有子组件可以挂 `onMounted`，所以用行元素的**函数 ref**
 * 登记。重复登记无害（`revealThumb` 对同一元素以最后一次为准）；已经有图时直接
 * 跳过，不再占一个观察位。
 *
 * `decorative`（右滑时垫在后面那一层）不取图 —— 同一批 id 主层已经在取了，
 * 垫底层再去登记只会让观察器多一份无用回调。
 */
function armThumb(el: unknown, id: string): void {
  if (props.decorative) return
  if (!el || typeof (el as Element).nodeType !== 'number') return
  if (drone.thumbOf(id)) return
  revealThumb(el as Element, () => drone.ensureThumb(id))
}

function onKey(e: KeyboardEvent, id: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onOpen(id)
  }
}

/** 触底阈值：离底 160px 就提前拉（与消息页同一口径） */
const BOTTOM_AHEAD = 160
const bodyEl = ref<HTMLElement | null>(null)

function onScroll(): void {
  const el = bodyEl.value
  if (!el) return
  // 只有历史页需要继续翻：今日那批首屏就齐了
  if (!onHist.value) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_AHEAD) {
    void drone.loadMore()
  }
}

onMounted(() => {
  if (props.decorative) return
  // 刚扫过（2 分钟内）就不重扫；过期了才重来一趟（见 store 的 STALE_MS）
  void drone.load()
  bodyEl.value = document.getElementById('subBody')
  bodyEl.value?.addEventListener('scroll', onScroll, { passive: true })
})

onUnmounted(() => {
  bodyEl.value?.removeEventListener('scroll', onScroll)
})

/** 状态徽标的修饰类（与 `.alarm-src` 基类配套） */
function statusClass(status: WorkOrderStatus | ''): string {
  return status === 'UNAUDITED' ? 'alarm-src-todo' : 'alarm-src-done'
}

/** 空态文案：接口失败写原因，其余按页签给各自的「暂无」 */
const emptyText = computed(() => {
  if (drone.error) return drone.error
  return onHist.value ? '暂无更早的预警' : '今日暂无无人机预警'
})
</script>

<template>
  <div class="insp-page">
    <!-- 页签：与监控预警同名同位（今日在前、历史在后） -->
    <div class="insp-tabs">
      <button
        class="insp-tab"
        :class="{ on: !onHist }"
        type="button"
        data-wo-tab="today"
        @click="onTab('today')"
      >
        今日预警
      </button>
      <button
        class="insp-tab"
        :class="{ on: onHist }"
        type="button"
        data-wo-tab="hist"
        @click="onTab('hist')"
      >
        历史预警
      </button>
    </div>

    <!-- 今日：今日预警数 + 近 7 日趋势 + 今日列表（未处理带红点） -->
    <div class="insp-pane" :class="{ hide: onHist }">
      <div class="home-stats alarm-row">
        <div class="home-stat alert">
          <b v-if="drone.todayKnown">{{ drone.todayCount }}</b>
          <!-- 扫描没完成：数字位换成灰条，不回填 0（0 是个结论，这里还不知道） -->
          <Skel v-else w="54px" h="31px" r="var(--r-6)" />
          <span>今日预警数</span>
        </div>
        <div class="home-chart-card alarm-mini">
          <span class="alarm-mini-lab">近7日预警趋势</span>
          <TouchChart v-if="hasTrend" :model="trendModel" />
          <Skel v-else-if="syncing" class="skel-mt" w="100%" h="48px" r="var(--r-6)" />
          <div v-else class="chart-empty">近 7 日暂无预警</div>
        </div>
      </div>

      <div v-if="drone.todayItems.length" class="insp-list">
        <div
          v-for="w in drone.todayItems"
          :key="w.id"
          :ref="(el) => armThumb(el, w.id)"
          class="insp-item"
          :data-wo="w.id"
          :data-status="w.status"
          role="button"
          tabindex="0"
          @click="onOpen(w.id)"
          @keydown="onKey($event, w.id)"
        >
          <!-- 图标位：与监控列表同一套 —— 有缩略图铺图，没有就铺灰底占位图标；
               取图过程中在图标外圈叠一圈真实进度，图到了自动消失；
               未处理在右上角压一颗红点（与图无关，状态单独决定） -->
          <span class="insp-pic-box">
            <SmartImg
              v-if="drone.thumbOf(w.id)"
              class="insp-pic"
              :src="drone.thumbOf(w.id)"
              :alt="w.title || '无人机预警'"
            />
            <span v-else class="insp-pic alarm-tile" aria-hidden="true">
              <SvgIcon name="drone" />
              <ThumbRing
                :id="w.id"
                :busy="drone.thumbBusyOf(w.id)"
                :pct="drone.thumbPctOf(w.id)"
              />
            </span>
            <i v-if="drone.isUnread(w)" class="insp-dot" role="img" aria-label="未处理" />
          </span>
          <div class="insp-meta">
            <div class="insp-hd">
              <strong>{{ w.title || '识别预警' }}</strong>
              <!-- 来源徽标：与监控列表的「视频监控」同一套尺寸与配色 -->
              <span class="alarm-src alarm-src-drone">无人机</span>
            </div>
            <p>{{ w.jobName || w.projectName || '—' }}</p>
          </div>
          <div class="wo-side">
            <span class="insp-time">{{ drone.relOf(w) }}</span>
            <span class="alarm-src" :class="statusClass(w.status)">{{ drone.statusText(w) }}</span>
          </div>
        </div>
      </div>

      <!-- 首屏加载：与 .insp-item 同构的灰条 -->
      <div v-else-if="syncing" class="insp-list skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="insp-item is-skel">
          <Skel w="48px" h="48px" r="var(--r-8)" />
          <div class="insp-meta">
            <Skel w="52%" h="14px" />
            <Skel class="skel-mt" w="78%" h="11px" />
          </div>
        </div>
      </div>

      <div v-else class="insp-empty" data-wo-empty>
        <span>{{ emptyText }}</span>
        <button v-if="drone.error" class="data-empty-btn" type="button" @click="drone.load(true)">
          重试
        </button>
      </div>
    </div>

    <!-- 历史：今天之前的预警，继续往后翻页；不带红点、不参与未处理计数 -->
    <div class="insp-pane insp-hist" :class="{ hide: !onHist }">
      <div class="insp-hist-hd">
        <div>
          <strong>更早的预警</strong>
          <span>{{ drone.histCount }}条</span>
        </div>
      </div>

      <div v-if="drone.histItems.length" class="insp-list">
        <div
          v-for="w in drone.histItems"
          :key="w.id"
          :ref="(el) => armThumb(el, w.id)"
          class="insp-item"
          :data-wo="w.id"
          :data-status="w.status"
          role="button"
          tabindex="0"
          @click="onOpen(w.id)"
          @keydown="onKey($event, w.id)"
        >
          <!-- 历史同样铺缩略图（与监控历史一致）；只是不带红点 -->
          <span class="insp-pic-box">
            <SmartImg
              v-if="drone.thumbOf(w.id)"
              class="insp-pic"
              :src="drone.thumbOf(w.id)"
              :alt="w.title || '无人机预警'"
            />
            <span v-else class="insp-pic alarm-tile" aria-hidden="true">
              <SvgIcon name="drone" />
              <ThumbRing
                :id="w.id"
                :busy="drone.thumbBusyOf(w.id)"
                :pct="drone.thumbPctOf(w.id)"
              />
            </span>
          </span>
          <div class="insp-meta">
            <div class="insp-hd">
              <strong>{{ w.title || '识别预警' }}</strong>
              <span class="alarm-src alarm-src-drone">无人机</span>
            </div>
            <p>{{ w.jobName || w.projectName || '—' }}</p>
          </div>
          <div class="wo-side">
            <span class="insp-time">{{ drone.relOf(w) }}</span>
            <span class="alarm-src" :class="statusClass(w.status)">{{ drone.statusText(w) }}</span>
          </div>
        </div>
      </div>

      <div v-else-if="syncing" class="insp-list skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="insp-item is-skel">
          <Skel w="48px" h="48px" r="var(--r-8)" />
          <div class="insp-meta">
            <Skel w="52%" h="14px" />
            <Skel class="skel-mt" w="78%" h="11px" />
          </div>
        </div>
      </div>

      <div v-else class="insp-empty">{{ emptyText }}</div>

      <!-- 分页三态：加载中 / 失败可重试 / 还有更多（与消息页同一套 .msg-more） -->
      <div v-if="drone.histItems.length">
        <div v-if="drone.loadingMore" class="msg-more" data-more="loading">
          <span role="status">正在加载更多…</span>
          <div v-if="showMoreSkel" class="card msg-list msg-more-skel" aria-hidden="true">
            <div v-for="i in 2" :key="i" class="msg-item">
              <div class="msg-ico"><Skel w="36px" h="36px" circle /></div>
              <div class="meta">
                <Skel w="116px" h="14px" />
                <Skel class="skel-mt-sm" w="78%" h="11px" />
              </div>
              <div class="msg-side"><Skel w="38px" h="10px" /></div>
            </div>
          </div>
        </div>
        <div v-else-if="drone.loadError" class="msg-more" data-more="error">
          <span>{{ drone.loadError }}</span>
          <button class="msg-more-btn" type="button" @click="drone.loadMore()">重试</button>
        </div>
        <div v-else-if="drone.hasMore" class="msg-more" data-more="more">
          <button class="msg-more-btn" type="button" @click="drone.loadMore()">
            还有 {{ drone.hiddenCount }} 条，点击或下滑加载
          </button>
        </div>
        <div v-else class="msg-more is-end" data-more="end">
          已显示全部 {{ drone.histCount }} 条历史预警
        </div>
      </div>
    </div>
  </div>
</template>
