<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

import BackBar from '@/components/ui/BackBar.vue'
import DayPickChips from '@/components/ui/DayPickChips.vue'
import MonthCalendar from '@/components/ui/MonthCalendar.vue'
import PanoViewer from '@/components/ui/PanoViewer.vue'
import SmartImg from '@/components/ui/SmartImg.vue'
import { AIR_PAGE_SIZE, useAirHazardStore } from '@/stores/airHazard'
import { useShellStore } from '@/stores/shell'
import { addDays } from '@/utils/date'
import { fetchBlobWithProgress } from '@/utils/blobFetch'
import { useLandscape } from '@/utils/landscape'
import { useSlideOverlay } from '@/utils/slideOverlay'
import { fetchDetailOriginal } from '@/utils/photoOriginal'
import { useImageZoom } from '@/utils/zoom'

/**
 * 航拍照片全屏层
 *
 * 对应原 index.html:123-150 + 事件处理（app.js:1495-1559）
 * + renderAir()（app.js:1361-1372）。
 *
 * ## 2026-11-19：站点下拉 + 原有日期控件
 *
 * 顶部两行筛选，缺一不可：
 *   · **站点名称**下拉 —— 选项 = 任务记录里的航线名（= 站点）去重；
 *   · **今天 / 昨天 / 选日期**（`ui/DayPickChips.vue`）+ 月历
 *     （`ui/MonthCalendar.vue`）—— 与监控抓拍、巡检历史**同一份组件同一份样式**，
 *     没有换成别的控件。
 *
 * 默认进来看该站点**最近一次采集**（日期芯片随之落到那一天）；用户选历史日期
 * 就查「站点 + 日期」那一天（同一天飞了两班取后一班）。全景仍排第一格，
 * 点开是球面环视（`ui/PanoViewer.vue`，与智眸同一套）。
 *
 * 大图弹层：**照片打开即原图**（首帧先铺缩略图，原图字节带进度到位后无声换源，
 * 不再有「原图」按钮 —— 2026-11-23 现场口径）；全景保留「复位 / 看高清 / 全屏」。
 * 2026-11-19 按现场要求去掉下载：OSS 直链在移动端存相册依赖分享面板，
 * 现场这条链不可靠，按钮留着反而误导。
 */
const air = useAirHazardStore()
const shell = useShellStore()

/** 全屏层转场（进入左滑入 / 返回右滑出），见 utils/slideOverlay.ts */
const playerEl = ref<HTMLElement | null>(null)
const overlay = useSlideOverlay(() => playerEl.value)
watch(() => air.isOpen, (open) => overlay.syncOpen(open), { flush: 'post' })

/** 返回：关大图 → 收月历 → 关层（一级一级退，不一步跳到底） */
function onBack(): void {
  if (air.airPopOpen) {
    air.airPopOpen = false
    return
  }
  if (air.airCalOpen) {
    air.toggleAirCal()
    return
  }
  overlay.leave(() => air.closeAir())
}

/** 下拉框换站点（原生 select，手机上走系统选择器，最省事也最无障碍） */
function onStationChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  air.pickStation(v)
}

/* ---------- 日期（原有控件：今天 / 昨天 / 选日期 + 月历） ---------- */

/** 芯片：0 = 今天，1 = 昨天 */
function onAirDay(day: number): void {
  air.setAirDate(addDays(new Date(), -day))
}

function onAirCalToggle(): void {
  air.toggleAirCal()
}

function onAirCalSelect(d: Date): void {
  air.setAirDate(d)
}

function onPhotoClick(i: number): void {
  if (!air.airList[i]) return
  air.airPopIdx = i
  air.airPopOpen = true
}

/* ---------- 网格分片：首屏 8 张，滑到接近底部再追加 8 张 ---------- */

/** 网格本身就是滚动容器（`.air-grid { overflow: auto }`），观察器的 root 用它 */
const gridEl = ref<HTMLElement | null>(null)
/** 底部哨兵：只在「还有没铺出来的」时候存在，铺完被 v-if 摘掉 */
const moreEl = ref<HTMLElement | null>(null)
let moreIO: IntersectionObserver | null = null

/**
 * 哨兵进入视野（提前 240px，约两行卡片）就请求下一页。
 *
 * 环境没有 IntersectionObserver（老 WebView / happy-dom）时干脆不装：
 * 底部那颗按钮仍在，点一下同样能加载，功能不依赖观察器。
 */
function bindMoreIO(): void {
  moreIO?.disconnect()
  moreIO = null
  const root = gridEl.value
  const target = moreEl.value
  if (!root || !target || typeof IntersectionObserver === 'undefined') return
  moreIO = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void air.loadMoreAir()
    },
    { root, rootMargin: '0px 0px 240px 0px' },
  )
  moreIO.observe(target)
}

// 网格与哨兵都是 v-if 出来的：进入 ok 态、换站点 / 换日期后都要重新挂
watch([gridEl, moreEl], bindMoreIO, { flush: 'post' })
onUnmounted(() => {
  moreIO?.disconnect()
  releaseImgHd()
})

function onPopClose(): void {
  air.airPopOpen = false
}

const currentShot = computed(() => air.airList[air.airPopIdx])
const isPano = computed(() => Boolean(currentShot.value?.pano))

/** 顶栏标题：照片是「站点 时刻」，全景是「站点 · 全景」 */
const popTitle = computed(() => {
  const s = currentShot.value
  if (!s) return ''
  if (s.pano) return `${air.station} · 全景`
  return `${air.station} ${s.time}`
})

/* ---------- 平面照片：缩放 / 原图（下载带进度，照智眸全景那套） ---------- */

const {
  zoomed: imgZoomed,
  label: zoomLabel,
  imgStyle,
  animating: zoomAnim,
  handlers: zoomHandlers,
  reset: resetZoom,
} = useImageZoom()

/** 已经是原图（画面正在用原图字节） */
const hd = ref(false)
/** 原图那一层：本地 objectURL / 在途请求 / 真实字节进度 / 序号 */
const imgObjUrl = ref('')
const imgHdBusy = ref(false)
const imgHdPct = ref(0)
let imgCtrl: AbortController | null = null
let imgSeq = 0

/** 释放原图字节（关弹层、换张、重来时都要） */
function releaseImgHd(): void {
  imgSeq += 1
  imgCtrl?.abort()
  imgCtrl = null
  if (imgObjUrl.value) URL.revokeObjectURL(imgObjUrl.value)
  imgObjUrl.value = ''
  imgHdBusy.value = false
  imgHdPct.value = 0
  hd.value = false
}

/** 画面左上角状态角标：压缩预览（还在缩略图上）→ 原图 42% → 原图 */
const imgTag = computed(() => {
  if (hd.value) return '原图'
  if (imgHdBusy.value) return imgHdPct.value ? `原图 ${imgHdPct.value}%` : '原图加载中'
  return '压缩预览'
})

// 换照片或关弹层时复位（原图态、在途下载、缩放都别带到下一张）
watch([() => air.airPopOpen, () => air.airPopIdx], ([open]) => {
  releaseImgHd()
  resetZoom()
  releasePanoHd()
  if (!open) return
  // 照片：先铺缩略图，原图马上开始拉（带进度），下完无声换源；
  // 全景：高清贴图（13MB）同样立刻开始拉，视觉上先看预览那张 185KB 的
  if (isPano.value) void loadPanoHd()
  else void loadHd()
})

// 全景数据晚到（当天刚拼好 / 换日期后才拉到）：到手就接着拉高清
watch(
  () => air.airPano?.full ?? '',
  (full) => {
    if (!full || !air.airPopOpen || !isPano.value) return
    void loadPanoHd()
  },
)
watch(() => currentShot.value?.img, resetZoom)

/**
 * 拉这张照片的原图（2026-11-23 现场口径：打开即原图，不再点按钮）。
 *
 * 之前是「点原图才下载」，现在把触发时机提前到打开弹层那一下，其余一条没改：
 *   · 进度是已收字节 / `Content-Length`（压在图底边那条），不是估算动画；
 *   · 下完先解码再换源，切过去不闪白；
 *   · 关弹层 / 换张 / 卸载直接 abort，4~8MB 不留在后台白烧；
 *   · 拉不到就退回直链（浏览器自己加载，慢但能看；角标仍写「原图」）。
 *
 * 同一张再打开时命中 `utils/photoOriginal.ts` 的内存缓存，直接就是原图。
 */
async function loadHd(): Promise<void> {
  const s = currentShot.value
  if (!s || isPano.value) return
  // 没有原图直链（理论上不会）：缩略图就是能拿到的最高清版本
  if (!s.full) {
    hd.value = true
    return
  }
  const key = ++imgSeq
  imgHdBusy.value = true
  imgHdPct.value = 0
  imgCtrl = new AbortController()
  try {
    const blob = await fetchDetailOriginal(s.full, {
      signal: imgCtrl.signal,
      onProgress: (loaded, total) => {
        if (key !== imgSeq) return
        imgHdPct.value = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0
      },
    })
    const url = URL.createObjectURL(blob)
    await preload(url)
    if (key !== imgSeq) {
      URL.revokeObjectURL(url)
      return
    }
    if (imgObjUrl.value) URL.revokeObjectURL(imgObjUrl.value)
    imgObjUrl.value = url
  } catch {
    // 拉不到（CORS / 断网 / 被取消）：交给浏览器直接加载直链
  } finally {
    if (key === imgSeq) {
      imgCtrl = null
      imgHdBusy.value = false
      imgHdPct.value = 0
      hd.value = true
      resetZoom()
    }
  }
}

/**
 * 现在该显示哪张：**原图（含直链兜底）→ 缩略图**。
 *
 * 两种都是 objectURL / 直链，换源不重开弹层；原图到位时画面只会从糊变清。
 * 不能用 `photoHd()` 那套：它映射的是站内 `img/hd/` 的静态资源清单，
 * 真实媒体的原图在 OSS 上，路径规则完全不同。
 */
const shownSrc = computed(() => {
  const s = currentShot.value
  if (!s) return ''
  if (hd.value) return imgObjUrl.value || s.full || s.img
  return s.img
})

/* ---------- 全景：球面环视 + 看高清 + 全屏（与智眸同一套） ---------- */

const panoRef = ref<InstanceType<typeof PanoViewer> | null>(null)

/** 全景环境不支持 WebGL（退成平面图，拖不动但仍能看） */
const panoUnsupported = ref(false)
/** 拉不开（多半是 OSS 签名过期） */
const panoBroken = ref(false)

/** 高清那一层：本地 objectURL / 在途请求 / 序号 */
const panoHd = ref(false)
const panoHdWait = ref(false)
const panoHdUrl = ref('')
const panoHdPct = ref(0)
const panoHdBusy = ref(false)
let panoObjUrl = ''
let panoCtrl: AbortController | null = null
let panoSeq = 0

/** 现在贴哪张：默认预览图（3162×1581，约 185KB），点「看高清」才换原图 */
const panoSrc = computed(() => {
  const p = air.airPano
  if (!p) return ''
  if (panoHd.value) return panoHdUrl.value || p.full || p.preview
  return p.preview
})

function releasePanoHd(): void {
  panoSeq += 1
  panoCtrl?.abort()
  panoCtrl = null
  if (panoObjUrl) URL.revokeObjectURL(panoObjUrl)
  panoObjUrl = ''
  panoHdUrl.value = ''
  panoHd.value = false
  panoHdWait.value = false
  panoHdBusy.value = false
  panoHdPct.value = 0
}

/** 解码完再换源，避免切过去那一瞬间空一帧（上万像素的图解码要几百毫秒） */
function preload(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    const done = (): void => {
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(done, 1200)
    img.onload = done
    img.onerror = done
    img.src = url
  })
}

/**
 * 拉全景高清（约 13MB 的贴图集）：**打开详情就拉**，不再点按钮
 * （2026-11-23 现场口径，那颗「看高清」已下线）。
 *
 * 先带真实字节进度把原图拉下来再换源；拉不到就退回直链（慢，但图还是会出来），
 * 与智眸里的处理一致。
 */
async function loadPanoHd(): Promise<void> {
  const p = air.airPano
  if (!p?.full || panoHd.value || panoHdBusy.value) return
  const key = panoSeq
  panoHdBusy.value = true
  panoHdPct.value = 0
  panoCtrl = new AbortController()
  try {
    const blob = await fetchBlobWithProgress(
      p.full,
      (loaded, total) => {
        if (key !== panoSeq) return
        panoHdPct.value = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0
      },
      panoCtrl.signal,
    )
    const url = URL.createObjectURL(blob)
    await preload(url)
    if (key !== panoSeq) {
      URL.revokeObjectURL(url)
      return
    }
    if (panoObjUrl) URL.revokeObjectURL(panoObjUrl)
    panoObjUrl = url
    panoHdUrl.value = url
  } catch {
    if (key === panoSeq) panoHdUrl.value = ''
  } finally {
    if (key === panoSeq) {
      panoCtrl = null
      panoHdBusy.value = false
      panoHdPct.value = 0
      panoHdWait.value = true
      panoHd.value = true
    }
  }
}

/** 角标：全景 · 可环视 → 全景 · 高清 42% → 全景 · 高清 */
const panoTag = computed(() => {
  if (panoHd.value) return panoHdWait.value ? '全景 · 高清加载中' : '全景 · 高清'
  if (panoHdBusy.value) {
    return panoHdPct.value ? `全景 · 高清 ${panoHdPct.value}%` : '全景 · 高清加载中'
  }
  return '全景 · 可环视'
})

function onPanoError(): void {
  if (panoHd.value) {
    releasePanoHd()
    shell.showToast('高清全景加载失败，已退回预览', 'warn')
    return
  }
  panoBroken.value = true
}

function onPanoReady(): void {
  panoHdWait.value = false
  panoBroken.value = false
}

const {
  land: panoLand,
  setStage: setPanoStage,
  toggle: togglePanoLand,
  exit: exitPanoLand,
} = useLandscape({ page: true, hint: true })

/** 关弹层 / 换站点时把全屏收回来 */
watch(
  () => [air.airPopOpen, air.station] as const,
  ([open]) => {
    if (!open && panoLand.value) void exitPanoLand()
  },
)
</script>

<template>
  <div
    ref="playerEl"
    class="air-player"
    id="airPlayer"
    :class="{ open: air.isOpen }"
    :hidden="!air.isOpen"
    :aria-hidden="!air.isOpen"
  >
    <BackBar title="航拍照片" back-id="btnAirBack" @back="onBack" />

    <!--
      筛选区：站点下拉 + 日期芯片，同一块里排。

      为什么不硬塞成一行：窄屏（375 宽）下两颗控件加起来要 400+ px，
      站点名会被压到只剩三四个字，比换行更难认。所以用 flex-wrap ——
      手机竖屏自动两行，横屏 / 平板（≥ 420 宽）并成一行，布局代码只有一套。

      站点名称选项来自 V2 任务记录里的航线（= 站点）去重后的清单，
      顺序按最近一次采集时间倒序 —— 第一个就是「最近飞过的」。
    -->
    <div class="air-filter" id="airFilter">
      <div class="air-pick">
        <label class="air-pick-label" for="airStation">站点</label>
        <div class="air-pick-sel">
          <select
            id="airStation"
            class="air-select"
            :value="air.station"
            :title="air.station || undefined"
            :disabled="!air.stations.length"
            :aria-label="`站点名称，共 ${air.stations.length} 个`"
            @change="onStationChange"
          >
            <option v-if="!air.stations.length" value="">暂无站点</option>
            <option v-for="s in air.stations" :key="s.name" :value="s.name">{{ s.name }}</option>
          </select>
          <!-- 箭头由 CSS 画（见 .air-pick-arrow）：字符 ▾ 在各系统字体里大小不一 -->
          <span class="air-pick-arrow" aria-hidden="true"></span>
        </div>
      </div>

      <!--
        日期：原有控件（今天 / 昨天 / 选日期 + 月历），与监控抓拍、巡检历史
        同一份组件与样式。默认显示该站点最近一次采集的日期，选历史日期即按
        「站点 + 日期」查那一天。
      -->
      <div class="air-days" id="airDays">
        <DayPickChips
          :selected="air.airDate"
          open-attr-name="data-air-cal-open"
          @pick="onAirDay"
          @open="onAirCalToggle"
        />
      </div>

      <!--
        月历：与监控抓拍、巡检历史同一个组件（样式只有一份 .cam-cal）。
        放在筛选区里是为了让它的定位跟着这块走 —— 窄屏两行、宽屏一行时
        都紧贴筛选区下沿，不用为两种布局各写一个 top。
      -->
      <MonthCalendar
        :month="air.airCalMonth"
        :selected="air.airDate"
        :min-day="air.airMinDate"
        :max-day="air.airMaxDate"
        :hidden="!air.airCalOpen"
        @update:month="air.setAirCalMonth"
        @select="onAirCalSelect"
      />
    </div>

    <p class="air-hint" id="airHint">{{ air.airHint }}</p>

    <!-- 加载中：一句话，不摆灰格子（灰格子看着像「有图但坏了」） -->
    <div v-if="air.airState === 'loading'" class="air-state" data-state="air-loading">
      <i class="cam-shots-spin" aria-hidden="true"></i>
      <span>正在读取航拍照片…</span>
    </div>

    <!-- 空 / 失败：说清结论，给一个能重试的动作（重试当前站点当前日期） -->
    <div v-else-if="air.airState === 'empty' || air.airState === 'error'" class="air-state">
      <strong>{{
        air.airState === 'error'
          ? '航拍照片加载失败'
          : air.airPending
            ? '本班照片正在回传'
            : `${air.airDateLabel}没有航拍照片`
      }}</strong>
      <span>{{ air.airNote }}</span>
      <button class="data-empty-btn" type="button" @click="air.refreshAir()">重新获取</button>
    </div>

    <div v-else class="air-grid" id="airGrid" ref="gridEl">
      <!--
        只铺 air.airListShown（airList 的前缀），key 用内容 id 而不是下标：
        追加下一页时前 8 张 identity 不变，不会重挂重下；换站点时整块网格
        本来就会因为 loading 态被卸载，也不会有跨站点的旧图串进来。
      -->
      <button
        v-for="(s, i) in air.airListShown"
        :key="s.pano ? 'pano' : s.photoId || `${s.time}-${i}`"
        class="air-card"
        :class="{ 'is-pano': s.pano }"
        type="button"
        :data-air="i"
        :aria-label="s.pano ? `${air.station} 全景，点开环视` : `${air.station} ${s.time} 航拍`"
        @click="onPhotoClick(i)"
      >
        <SmartImg :pos="s.pos" :src="s.img" :alt="`${air.station} ${s.pano ? '全景' : s.time}`" />
        <span v-if="s.pano" class="air-card-tag">全景 · 可环视</span>
        <span class="air-card-time">{{ s.pano ? '全景' : s.time }}</span>
      </button>

      <!--
        底部一栏：还有 → 哨兵（滚到这里自动追加）+ 一颗可点的按钮
        （没有 IntersectionObserver 的 WebView、以及键盘用户靠它）；
        没有 → 一行「已显示全部」。
      -->
      <div v-if="air.airHasMore" ref="moreEl" class="air-more" id="airMore">
        <button
          class="air-more-btn"
          type="button"
          :aria-disabled="air.airMoreBusy ? 'true' : undefined"
          :aria-label="`加载更多，还有 ${air.airRemain} 张`"
          @click="air.loadMoreAir()"
        >
          <i v-if="air.airMoreBusy" class="cam-shots-spin" aria-hidden="true"></i>
          <span>{{ air.airMoreBusy ? '正在加载更多…' : `加载更多（还有 ${air.airRemain} 张）` }}</span>
        </button>
      </div>
      <!-- 只有真的分过页才写「已显示全部」，一两张时不必多一行 -->
      <p
        v-else-if="air.airList.length > AIR_PAGE_SIZE"
        class="air-more is-end"
        id="airMoreEnd"
      >
        已显示全部 {{ air.airList.length }} 张
      </p>
    </div>

    <!--
      大图弹层：照片走平面看（缩放 / 原图 / 下载），全景走球面环视
      （拖动转头、双指或滚轮改视场角，与智眸 VR360 完全同一套组件）。
    -->
    <div
      class="cam-shot-pop air-pop"
      id="airPop"
      :class="{ open: air.airPopOpen }"
      :hidden="!air.airPopOpen"
      :aria-hidden="!air.airPopOpen"
    >
      <!-- 顶栏只剩「关闭 + 标题」：照片打开即原图，不再有「原图」按钮 -->
      <div class="photo-bar">
        <button class="photo-bar-btn" id="btnAirClose" type="button" @click="onPopClose">
          关闭
        </button>
        <strong>{{ popTitle }}</strong>
      </div>

      <Teleport to="body" :disabled="!panoLand">
        <figure
          v-if="isPano"
          :ref="setPanoStage"
          class="pano-stage"
          :class="{ 'is-land': panoLand }"
        >
          <PanoViewer
            ref="panoRef"
            :src="panoSrc"
            :alt="`${air.station} 全景`"
            @unsupported="panoUnsupported = true"
            @error="onPanoError"
            @ready="onPanoReady"
          />
          <span class="patrol-view-tag is-pano">{{ panoTag }}</span>

          <!-- 工具条只剩复位 / 全屏：「看高清」下线，高清贴图打开就自动拉 -->
          <div class="pano-tools">
            <button
              v-if="!panoUnsupported"
              class="pano-tool"
              type="button"
              aria-label="复位视角"
              @click="panoRef?.reset()"
            >
              复位
            </button>
            <button
              class="pano-tool"
              type="button"
              :aria-pressed="panoLand"
              :aria-label="panoLand ? '退出全屏，回到竖屏' : '全屏查看'"
              @click="togglePanoLand"
            >
              {{ panoLand ? '退出' : '全屏' }}
            </button>
          </div>

          <!-- 高清字节进度：压在画布底边，不占版面 -->
          <div v-if="panoHdBusy" class="hd-progress is-in-stage">
            <i :style="{ width: `${panoHdPct}%` }"></i>
          </div>

          <p v-if="panoBroken" class="pano-hint is-broken">全景图加载失败，请退出重进</p>
          <p v-else class="pano-hint">
            {{ panoUnsupported ? '当前环境不支持全景渲染，已切换为平面查看' : '拖动环视 · 双指或滚轮缩放' }}
          </p>
        </figure>
      </Teleport>

      <div v-if="!isPano" class="photo-view">
        <SmartImg
          id="airPopImg"
          :pos="currentShot?.pos"
          :src="shownSrc"
          alt=""
          class="zoomable"
          :class="{ 'is-zoomed': imgZoomed, 'is-anim': zoomAnim }"
          :style="imgStyle"
          v-on="zoomHandlers"
        />
        <span v-if="imgZoomed" class="zoom-badge">{{ zoomLabel }}</span>
        <!-- 角标：压缩预览（还在缩略图上）→ 原图 42% → 原图 -->
        <span class="patrol-view-tag">{{ imgTag }}</span>

        <!-- 原图加载的真实字节进度：压在图底边，不占版面、不挡操作 -->
        <div
          v-if="imgHdBusy"
          class="hd-progress is-in-stage"
          data-state="air-hd-progress"
          role="progressbar"
          :aria-valuenow="imgHdPct"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`原图加载 ${imgHdPct}%`"
        >
          <i :style="{ width: `${imgHdPct}%` }"></i>
        </div>
      </div>

      <p v-if="!isPano" class="photo-tip">双指缩放，单指拖动</p>
    </div>
  </div>
</template>
