<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { GATE_SHOTS } from '@/data/cams'
import { PATROL_CATS, catOfTask } from '@/data/config'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { PANO_SHEET_ID, usePatrolStore } from '@/stores/patrol'
import { panoLabel } from '@/utils/pano'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 首页 · 智眸面板（现场快照・实景核验）
 *
 * 照片来自 keehang 真实航拍媒体（见 `stores/patrol.ts`）。
 *
 * ## 分类：六类固定两行（2026-11-16 用户要求，2026-11-18 改过按钮文案）
 *
 * VR 360环视 / 全景航拍 / 设备设施 / 材料堆场 / 出入口管控 / 安全巡查 —— 3 列 × 2 行，
 * 位置固定（某一类 0 张也占位，否则一有数据就换行错位），不做横向滑动。
 * 文案在 `data/config.ts` 的 `PATROL_CATS` 里；`id` 与归类规则没动过。
 *
 * 其中**六格各有专用链**（2026-11 用户要求，见 store）：
 * 「全景航拍」= 全局定点拍照最近一班的 9 张；「材料堆场」= 分区定点拍照最近
 * 一班的第 1、2、37 张；「设备设施」= 塔吊定点最近一班的第 2、第 7 张
 * **+ 2#/4# 塔吊各一张最新抓拍**（见下）；「安全巡查」= 土方1 最近一班的第 1 张
 * + 分区定点拍照最近一班的第 34 张；「出入口管控」= 5 个门禁点位各一张最新抓拍。
 * 所以它们的计数与内容都从 `patrol.spot / yard / facility / safety / gate` 取，
 * 不按航线名归组 —— 按名字归组会把同类航线的别的照片一起吞进来。
 *
 * ⚠️ 注意分类 `id` 与显示名**早就不对应**了（2026-11-18 只改了文案，没改 id）：
 * 「设备设施」的 id 是 `face`，「材料堆场」的 id 是 `equip`，`pit` 才是「全景航拍」。
 * 下面按 id 分支时别看名字对号。
 *
 * 「设备设施」**4 张**（2026-11-20 定稿）：航拍 2 张 + 视频监控抓拍 2 张。
 * 前两张照旧（`fetchFacilityGallery`）；后两张是 2#塔吊 / 4#塔吊 各自**最新一条
 * 历史抓拍**（`stores/patrol.ts::craneShots`）。服务端只有「最近一帧」，取不到就
 * 退回本机档案里最新那条，两样都没有就少这两张 —— 不编照片。抓拍的卡片写
 * 「抓拍 / 视频监控」，与航拍的「航拍 / 无人机」区分开。
 *
 * 「出入口管控」**5 张**（2026-11-20 定稿）：视频监控A / 2#门监控1 / 2#门监控2 /
 * 4#门监控 / 4#门外监控，各取最新一条历史抓拍（`stores/patrol.ts::loadGate`，
 * 来源表在 `data/cams.ts` 的 `GATE_SHOTS`）。顺序即来源表顺序，不排序、不合并；
 * 少了一路会在网格下方写出是哪一路，不拿别的图顶替。
 *
 * ⚠️ **服务端没有分类字段**（keehang 媒体接口只有文件名/大小/链接/缩略图；
 * 万联后端的 devDroneMedia 表也没有分类列；15 条航线的 taskType 全是 AIRLINE）。
 * 所以归类只能在客户端按**航线名**做，规则写在 `data/config.ts`：
 * 显式登记表 → 关键词 → 兜底类，三者必有结果，因此**没有「未分类」这一项**。
 *
 * 默认选中「第一个真有照片的分类」，而不是设计稿写死的「项目全景」：现场如果
 * 没有全景航线，一进来就是「这个分类下还没有照片」，等于把页面做成空白。
 *
 * ## 缩略图
 *
 * 媒体接口同时返回 `thumbnail`（约 440KB，原图 6MB）。卡片用它 + `loading="lazy"`，
 * 滚动到才加载；点开大图才请求原图。缩略图缺失或加载失败时回退成文字占位，
 * 不留破图。
 */
const sheet = useBottomSheetStore()
const patrol = usePatrolStore()

/**
 * 面板挂载即取一次。
 *
 * 首页切换「智巡 / 智眸 / 智控」标签时面板是真的卸载再挂载（`HomeSheet` 的
 * `.home-panels` 带 `:key="home.homeMod"`），所以这里同时是「切回智眸」的入口。
 * 一分钟内的重复进入由 store 的 `refresh()` 直接复用上一批（媒体接口有限流，
 * 每次刷新都要串行扫十几条请求，见 `stores/patrol.ts` 的 `PROBE_GAP`）。
 */
onMounted(() => {
  void patrol.refresh()
})

/** 慢请求才显示骨架 */
const syncing = computed(
  () =>
    patrol.state === 'loading' &&
    !patrol.photos.length &&
    !patrol.spot.length &&
    !patrol.yard.length &&
    !patrol.facility.length &&
    !patrol.safety.length &&
    !patrol.gate.length,
)
const showSkel = useSlowLoading(() => syncing.value)

/** 每张照片带上归属分类（`patrol.list` 已按时间倒序） */
const tagged = computed(() => patrol.list.map((p) => ({ ...p, cat: catOfTask(p.taskName) })))

/** 分类 id → 该分类下的照片（保持时间倒序） */
const groups = computed(() => {
  const map = new Map<string, typeof tagged.value>()
  for (const p of tagged.value) {
    const arr = map.get(p.cat)
    if (arr) arr.push(p)
    else map.set(p.cat, [p])
  }
  return map
})

/** 六个分类恒定显示（0 张也占位，保住 3×2 的版式） */
const chips = computed(() =>
  PATROL_CATS.map((c) => {
    // 「VR 360环视」下**只放那一张最新全景**（2026-11-16 用户要求）：正射 / 三维
    // 那些俯视照片不再挤进来，这一格就是「点进去环视」的入口，计数恒为 0 或 1。
    if (c.id === 'pano') return { id: c.id, name: c.name, count: patrol.pano ? 1 : 0 }
    // 「全景航拍」= 「向阳村-全局定点拍照」最近一班有照片的飞行里那 9 张
    // （V2「任务记录 → 采集数据 → 采集图片」同一条链，见 api/drone.ts）
    if (c.id === 'pit') return { id: c.id, name: c.name, count: patrol.spot.length }
    // 「材料堆场」= 「向阳村-分区定点拍照」最近一班的第 1、2、37 张（2026-11-18）
    // —— 这一格只认那三张，不再按航线名把塔吊定点那批混进来
    if (c.id === 'equip') return { id: c.id, name: c.name, count: patrol.yard.length }
    // 「设备设施」= 塔吊定点第 2、第 7 张（2026-11-18）+ 2#/4# 塔吊各一张最新抓拍
    // —— id 是 `face`（旧归类语义），别看名字对号
    if (c.id === 'face') return { id: c.id, name: c.name, count: patrol.facility.length }
    // 「安全巡查」= 土方1 第 1 张 + 分区定点拍照第 34 张（两条航线各一张）
    if (c.id === 'layout') return { id: c.id, name: c.name, count: patrol.safety.length }
    // 「出入口管控」= 5 个门禁点位各自最新一条历史抓拍（视频监控）
    if (c.id === 'yard') return { id: c.id, name: c.name, count: patrol.gate.length }
    return { id: c.id, name: c.name, count: (groups.value.get(c.id) ?? []).length }
  }),
)

/** 手动选中的分类（空串 = 还没点过，跟随默认） */
const picked = ref('')

/** 默认落点：第一个真有照片的分类，全空时退回设计稿的「项目全景」 */
const defaultCat = computed(() => chips.value.find((c) => c.count > 0)?.id ?? PATROL_CATS[0].id)

/** 当前生效的分类（`picked` 失效时自动回落到默认，刷新后不会停在空分类上） */
const activeCat = computed(() =>
  picked.value && chips.value.some((c) => c.id === picked.value) ? picked.value : defaultCat.value,
)

/**
 * 当前分类下要铺的照片。
 *
 * 「VR 360环视」这一格**不铺照片**：它只放那一张最新全景（见模板里的全景卡片）。
 * 正射 / 三维归的是同一个分类，但用户要的是"点进去环视"，不是再看一遍
 * 一堆俯视航拍图 —— 那些照片在 UavPage 的任务记录里本来就能翻。
 *
 * 「全景航拍」则是另一条链的 9 张（`patrol.spot`），不按任务分组 —— 按分组
 * 会把「分区定点拍照」等同类航线混进来，数量就不是 V2 那 9 张了。
 *
 * 「材料堆场」同理走自己的链（`patrol.yard`）：只有「向阳村-分区定点拍照」
 * 最近一班的第 1、第 2、第 37 张，别的照片一张都不进来。
 *
 * 「设备设施」也是（`patrol.facility`）：前两张是「向阳村-塔吊定点」最近一班的
 * 第 2、第 7 张，后两张是 2#/4# 塔吊各自最新一条历史抓拍（顺序固定，见 store）。
 *
 * 「安全巡查」同理（`patrol.safety`）：土方1 第 1 张 + 分区定点拍照第 34 张，
 * 两条航线各一张 —— 卡片标题仍是各自真实航线名。
 *
 * 「出入口管控」也是（`patrol.gate`）：视频监控A / 2#门监控1 / 2#门监控2 /
 * 4#门监控 / 4#门外监控，各取最新一条历史抓拍，固定 5 张（见 `data/cams.ts`
 * 的 `GATE_SHOTS`）。这一格原先走照片墙按航线名归组，实际常年是空的 ——
 * 出入口看的是视频监控的抓拍，跟无人机航线不是一回事。
 *
 * 于是照片墙那套「按航线名归组」（`groups`）现在六格都用不上了，只剩兜底。
 */
const shown = computed(() => {
  if (activeCat.value === 'pano') return []
  if (activeCat.value === 'pit') return patrol.spot
  if (activeCat.value === 'equip') return patrol.yard
  if (activeCat.value === 'face') return patrol.facility
  if (activeCat.value === 'layout') return patrol.safety
  if (activeCat.value === 'yard') return patrol.gate
  return groups.value.get(activeCat.value) ?? []
})

const activeName = computed(() => chips.value.find((c) => c.id === activeCat.value)?.name ?? '')

/**
 * 当前分类下有没有东西可看。
 *
 * 项目全景来自**重建成果接口**，不在照片墙里（`shown` 是空的），所以单独判：
 * 现场如果只飞了全景航线，这个分类里 `shown` 为空但全景卡片要在。
 */
const hasContent = computed(
  () => shown.value.length > 0 || (activeCat.value === 'pano' && Boolean(patrol.pano)),
)

/**
 * 当前分类是否**还在等接口响应**。
 *
 * 六格各自一条链、各自一套状态（见 `stores/patrol.ts`：`panoState / spotState /
 * yardState / facilityState / safetyState`），所以判断也按当前选中的那一格去看
 * 它自己的状态；「出入口管控」走照片墙，看整页的 `state`。
 *
 * 为什么单独拎这个判断：以前「还在等响应」和「这格真的没照片」共用一句话，
 * 数据还在路上，页面已经写下结论「这个分类下还没有照片」—— 现场的观感就是
 * 「明明有，却先说没有，过一会儿又冒出来」。现在这一段显示「图片刷新」，
 * 响应回来（ok / error）才落回原文案。
 *
 * ⚠️ 必须放在 `activeCat` / `hasContent` 之后：下面的 `useSlowLoading` 会在
 * setup 阶段**立刻**读一次 `catLoading`（`watch` 的 immediate），提前定义会
 * 命中「Cannot access before initialization」。
 */
const catLoading = computed(() => {
  if (activeCat.value === 'pano') return patrol.panoState === 'loading'
  if (activeCat.value === 'pit') return patrol.spotState === 'loading'
  if (activeCat.value === 'equip') return patrol.yardState === 'loading'
  if (activeCat.value === 'face') return patrol.facilityState === 'loading'
  if (activeCat.value === 'layout') return patrol.safetyState === 'loading'
  if (activeCat.value === 'yard') return patrol.gateState === 'loading'
  return patrol.state === 'loading'
})

/**
 * 「出入口管控」里**没取到画面**的点位名。
 *
 * 5 个地址一个个取，某路相机离线、本机档案里也没留过图时，那一张就不出现 ——
 * 不拿别的图顶替，但要把「少的是哪一路」说出来：张数从 5 变 4 却不解释，
 * 现场只会以为是漏了。只在取完（`ok`）之后提示，取的过程中不抢先下结论。
 */
const gateMissing = computed(() => {
  if (activeCat.value !== 'yard' || patrol.gateState !== 'ok') return []
  const got = new Set(patrol.gate.map((p) => p.taskName))
  return GATE_SHOTS.filter((s) => !got.has(s.name)).map((s) => s.name)
})

/** 刷新提示同样「慢才显示」：几十毫秒就回来的请求不该闪一下「图片刷新」 */
const showRefresh = useSlowLoading(() => catLoading.value)

/** 全景的**拼接完成**时间（`endTime`，与 V2 重建成果列表一致，见 `api/drone.ts`） */
const panoTime = computed(() => (patrol.pano?.time ?? '').slice(0, 16).replace('T', ' '))

/**
 * 缩略图加载失败的 id 集合（失败的卡片回退成文字占位，不留破图）。
 *
 * ⚠️ 这份集合以前**从不清空**：服务端偶发 `ECONNRESET`（2026-11-20 实测存在）
 * 或缩略图 5xx 一次，这张卡就永久显示「点击查看原图」，网络恢复了也不重试 ——
 * 只有切走标签让组件重建才恢复，所以现场观感是「重新进一下就好了」。
 * 现在两条自愈路径：当前照片集合一变就整体清空；同一张图失败后延时自动重试一次。
 */
const broken = ref<Record<string, boolean>>({})
/** 自动重试次数上限（连接重置这种偶发失败只值得再试一次） */
const AUTO_RETRY = 1
/** 自动重试的延时：给抖动中的链路一点恢复时间，又不至于让人干等 */
const RETRY_DELAY = 3_000
/** 已自动重试过的 id → 次数，防止反复失败的图无限重试 */
const retried = ref<Record<string, number>>({})

/** 当前铺出来的照片 id 序列（换分类 / 刷新后照片变了就清掉失败记录） */
const shownKey = computed(() => shown.value.map((p) => p.id).join('|'))

watch(shownKey, () => {
  broken.value = {}
  retried.value = {}
})

function markBroken(id: string): void {
  broken.value = { ...broken.value, [id]: true }
  if ((retried.value[id] ?? 0) >= AUTO_RETRY) return
  retried.value = { ...retried.value, [id]: (retried.value[id] ?? 0) + 1 }
  window.setTimeout(() => {
    if (!broken.value[id]) return
    // 删 key 而不是置 false：模板里是 `!broken[p.id]`，重新走 v-if 才会新建 <img> 重新请求
    const next = { ...broken.value }
    delete next[id]
    broken.value = next
  }, RETRY_DELAY)
}

/**
 * 缩略图上屏时顺手记下原图尺寸。
 *
 * 缩略图与原图同尺寸，所以这一次 `naturalWidth/Height` 就是判断「是不是 2:1
 * 全景」的全部依据（平台没有全景字段，见 `utils/pano.ts`）。记在 store 里，
 * 大图弹层打开时直接命中，不用再等一张图加载才知道该用球面还是平面。
 */
function onThumbLoad(id: string, e: Event): void {
  const img = e.target as HTMLImageElement | null
  if (img) patrol.setDims(id, img.naturalWidth, img.naturalHeight)
}

function retry(): void {
  void patrol.load(true)
}

/** 全景单独重试：不重扫照片墙（那串要十几秒且撞限流） */
function retryPano(): void {
  void patrol.loadPano(true)
}

/** 「全景航拍」9 张单独重试：同样不惊动照片墙 */
function retrySpot(): void {
  void patrol.loadSpot()
}

/** 「材料堆场」3 张单独重试 */
function retryYard(): void {
  void patrol.loadYard()
}

/** 「设备设施」4 张（航拍 2 + 塔吊抓拍 2）单独重试 */
function retryFacility(): void {
  void patrol.loadFacility()
}

/** 「安全巡查」2 张单独重试（两条航线各拉一次） */
function retrySafety(): void {
  void patrol.loadSafety()
}

/** 「出入口管控」5 张单独重试（不重扫照片墙：5 张快照串行要几秒） */
function retryGate(): void {
  void patrol.loadGate()
}
</script>

<template>
  <div class="safe-block">
    <div class="patrol-hd">
      <h4>最新照片</h4>
      <em>{{ chips.find((c) => c.id === activeCat)?.count ?? 0 }} 张</em>
    </div>

    <!-- 分类：3 列 × 2 行固定版式（设计稿 .patrol-cats），0 张的分类照旧占位 -->
    <div
      v-if="
        patrol.list.length ||
        patrol.pano ||
        patrol.spot.length ||
        patrol.yard.length ||
        patrol.facility.length ||
        patrol.safety.length ||
        patrol.gate.length
      "
      class="patrol-cats"
      role="group"
      aria-label="照片分类"
    >
      <button
        v-for="c in chips"
        :key="c.id"
        type="button"
        :class="{ on: activeCat === c.id }"
        :aria-pressed="activeCat === c.id"
        @click="picked = c.id"
      >
        {{ c.name }}<i v-if="c.count">{{ c.count }}</i>
      </button>
    </div>

    <!-- 同步中：与 .patrol-card 同构铺灰条，数据到了原位回填 -->
    <div
      v-if="syncing"
      class="patrol-grid skel-fade"
      :class="{ 'is-on': showSkel }"
      aria-hidden="true"
    >
      <div v-for="i in 4" :key="i" class="patrol-card is-skel">
        <Skel w="100%" h="96px" r="var(--r-8)" />
        <div class="patrol-card-ft">
          <Skel w="70%" h="13px" />
        </div>
      </div>
    </div>

    <!--
      当前分类还在等接口响应：说明文字写「图片刷新」，视觉沿用上面那套骨架
      （= 智眸首次加载图片时的样子），不先下「这个分类下还没有照片」的结论。

      两个条件缺一不可：
        · `catLoading` —— 这一格自己的链还在请求（等响应）；
        · `!hasContent` —— 手里还没有可看的图。已经有图时**不铺骨架**：刷新
          期间旧图继续显示，中途拿掉会让画面闪一下（与「刷新不改 state」同一条）。
      响应回来（ok / error）立刻落回下面的原文案与重试按钮。
    -->
    <div
      v-else-if="catLoading && !hasContent"
      class="patrol-refreshing skel-fade"
      :class="{ 'is-on': showRefresh }"
      data-state="patrol-refreshing"
    >
      <div class="patrol-grid" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="patrol-card is-skel">
          <Skel w="100%" h="96px" r="var(--r-8)" />
          <div class="patrol-card-ft">
            <Skel w="70%" h="13px" />
          </div>
        </div>
      </div>
      <p class="patrol-refreshing-tip" role="status">图片刷新</p>
    </div>

    <!-- 有内容，但当前分类下没有：设计稿原文「这个分类下还没有照片」 -->
    <div
      v-else-if="
        !hasContent &&
        (patrol.list.length ||
          patrol.pano ||
          patrol.spot.length ||
          patrol.yard.length ||
          patrol.facility.length ||
          patrol.safety.length ||
          patrol.gate.length)
      "
      class="patrol-empty"
    >
      <!-- 全景 / 全景航拍 / 材料堆场 / 设备设施走的是另外几条接口，挂了要说「取不到」而不是「没有照片」 -->
      <p v-if="activeCat === 'pano' && patrol.panoState === 'error'">VR 360环视暂时取不到</p>
      <p v-else-if="activeCat === 'pit' && patrol.spotState === 'error'">全景航拍照片暂时取不到</p>
      <p v-else-if="activeCat === 'equip' && patrol.yardState === 'error'">材料堆场照片暂时取不到</p>
      <p v-else-if="activeCat === 'face' && patrol.facilityState === 'error'">设备设施照片暂时取不到</p>
      <p v-else-if="activeCat === 'layout' && patrol.safetyState === 'error'">安全巡查照片暂时取不到</p>
      <p v-else-if="activeCat === 'yard' && patrol.gateState === 'error'">出入口管控照片暂时取不到</p>
      <p v-else>这个分类下还没有照片</p>
      <button
        v-if="activeCat === 'pano' && patrol.panoState === 'error'"
        class="data-empty-btn"
        type="button"
        @click="retryPano"
      >
        重试
      </button>
      <button
        v-else-if="activeCat === 'pit' && patrol.spotState === 'error'"
        class="data-empty-btn"
        type="button"
        @click="retrySpot"
      >
        重试
      </button>
      <button
        v-else-if="activeCat === 'equip' && patrol.yardState === 'error'"
        class="data-empty-btn"
        type="button"
        @click="retryYard"
      >
        重试
      </button>
      <button
        v-else-if="activeCat === 'face' && patrol.facilityState === 'error'"
        class="data-empty-btn"
        type="button"
        @click="retryFacility"
      >
        重试
      </button>
      <button
        v-else-if="activeCat === 'layout' && patrol.safetyState === 'error'"
        class="data-empty-btn"
        type="button"
        @click="retrySafety"
      >
        重试
      </button>
      <button
        v-else-if="activeCat === 'yard' && patrol.gateState === 'error'"
        class="data-empty-btn"
        type="button"
        @click="retryGate"
      >
        重试
      </button>
    </div>

    <div v-else-if="hasContent" class="patrol-grid">
      <!--
        项目全景：只放**最新的一张**（平台拼好的等距圆柱成果），点开可环视。
        用保留 id `pano` 打开弹层 —— 全景来自重建成果，没有照片 id 可用。
      -->
      <button
        v-if="activeCat === 'pano' && patrol.pano"
        class="patrol-card is-pano"
        type="button"
        :aria-label="`${patrol.pano.taskName}，${panoTime}，项目全景，查看球面全景`"
        @click="sheet.openPatrol(PANO_SHEET_ID)"
      >
        <div class="patrol-thumb">
          <!-- 预览图就是弹层里那张等距圆柱图（185KB）：卡片加载过，点开即出 -->
          <img
            :src="patrol.pano.preview"
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
          />
          <span class="patrol-thumb-tag is-pano">全景</span>
          <span class="patrol-thumb-size">{{ patrol.sizeText(patrol.pano.size) }}</span>
        </div>
        <div class="patrol-card-ft">
          <div class="patrol-card-name">
            <!-- 名字前段就是「站点-全景」，一眼能看出是哪片工地（全景不按项目筛，见 api/drone.ts） -->
            <strong>{{ panoLabel(patrol.pano.taskName) }}</strong>
            <em>{{ panoTime || '—' }}</em>
          </div>
          <div class="patrol-tags">
            <span class="patrol-tag">可环视</span>
            <span class="alarm-src alarm-src-drone">无人机</span>
          </div>
        </div>
      </button>

      <button
        v-for="p in shown"
        :key="p.id"
        class="patrol-card"
        type="button"
        :aria-label="`${p.taskName}，${p.time.slice(0, 16).replace('T', ' ')}，${activeName}，${patrol.isPano(p.id) ? '查看全景' : '查看大图'}`"
        @click="sheet.openPatrol(p.id)"
      >
        <div class="patrol-thumb">
          <img
            v-if="p.thumbnail && !broken[p.id]"
            :src="p.thumbnail"
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            @load="onThumbLoad(p.id, $event)"
            @error="markBroken(p.id)"
          />
          <span v-else class="patrol-thumb-hint">点击查看原图 · {{ patrol.sizeText(p.size) }}</span>
          <span class="patrol-thumb-tag" :class="{ 'is-pano': patrol.isPano(p.id) }">
            {{ patrol.isPano(p.id) ? '全景' : p.snap ? '抓拍' : '航拍' }}
          </span>
          <span v-if="p.thumbnail && !broken[p.id]" class="patrol-thumb-size">
            {{ patrol.sizeText(p.size) }}
          </span>
        </div>
        <div class="patrol-card-ft">
          <div class="patrol-card-name">
            <!-- 标题是真实航线名（抓拍则是点位名：2#塔吊 / 2#门监控1），徽标是归类 -->
            <strong>{{ p.taskName }}</strong>
            <em>{{ p.time.slice(0, 16).replace('T', ' ') }}</em>
          </div>
          <div class="patrol-tags">
            <span class="patrol-tag">{{ activeName }}</span>
            <!-- 来源按照片本身写：设备设施 / 出入口管控的抓拍是视频监控拍的，不能标成无人机 -->
            <span class="alarm-src" :class="p.snap ? 'alarm-src-cam' : 'alarm-src-drone'">
              {{ p.snap ? '视频监控' : '无人机' }}
            </span>
          </div>
        </div>
      </button>

      <!--
        出入口管控少了几路：张数从 5 变少时把缺的点位名写出来（不拿别的图顶替，
        也不假装是「还没更新」）。`grid-column: 1 / -1` 让它跨满两列，落在卡片下方。
      -->
      <p v-if="gateMissing.length" class="patrol-gate-note" role="status">
        {{ gateMissing.join('、') }} 暂时没有画面
      </p>
    </div>

    <div v-else class="data-empty" data-empty="patrol">
      <p>{{ patrol.state === 'error' ? patrol.error || '巡检照片加载失败' : '暂无航拍照片' }}</p>
      <button v-if="patrol.state === 'error'" class="data-empty-btn" type="button" @click="retry">
        重试
      </button>
    </div>
  </div>
</template>
