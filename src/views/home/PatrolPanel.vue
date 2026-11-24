<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { GATE_SHOTS } from '@/data/cams'
import { PATROL_CATS, catOfTask } from '@/data/config'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { PANO_SHEET_ID, usePatrolStore } from '@/stores/patrol'
import { panoLabel } from '@/utils/pano'
import { useSlowLoading } from '@/utils/slowLoading'
import { useTabRefresh } from '@/utils/tabRefresh'

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
 * 2026-11-24 起这个「第一个有照片的」由首次进入时的逐格探测得出（见下方
 * 「面板级进入 vs 子页切换」），探到就停，不会把六条链一起打一遍。
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
 * ## 面板级进入 vs 子页切换（2026-11-24 重构）
 *
 * 首页切「智巡 / 智眸 / 智控」时面板是真的卸载再挂载（`HomeSheet` 的
 * `.home-panels` 带 `:key="home.homeMod"`），所以**挂载 = 从别的页面切回来**。
 * 两条路径分得很清：
 *
 *   · 面板级进入（这里）→ `patrol.enterPanel()`：
 *       续上上次选中的那一格并刷新它；本会话还没选过时才逐格探，探到第一个
 *       有内容的就停。**不会把六条链一起打一遍。**
 *   · 子页切换（面板内部的分类按钮）→ 下面那个 `watch(activeCat)`：
 *       只取新点中的那一格。
 *
 * 选中状态不放在组件里，放 store 的 `pickedCat` —— 组件会被卸载，
 * 而「上次选了全景航拍，切回来还是全景航拍」正是这次要保住的东西。
 */
onMounted(() => {
  void patrol.enterPanel()
})

/**
 * 切回「首页」tab 时重取当前这一格（2026-11-24）。
 *
 * 面板常驻的只有「当前 homeMod」那一个，所以这里只管自己这一格：
 *   · 已经选过分类 → `loadCat(pickedCat, true)`：**强制**取一次，绕过 15 秒
 *     成功节流 —— 用户切走再回来就是想看新图，命中节流等于没刷；
 *   · 还没选过（首次进入前）→ 走 `enterPanel()` 的探测逻辑。
 *
 * 只取一格，不会把六条链一起打一遍（那正是 `enterPanel` 设计上要避免的）。
 */
useTabRefresh('home', () => {
  if (patrol.pickedCat) void patrol.loadCat(patrol.pickedCat, true)
  else void patrol.enterPanel()
})

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

/**
 * 手动选中的分类 —— 存在 store（`pickedCat`）里，组件被卸载也不会丢。
 *
 * 空串 = 本会话还没点过，跟随 `defaultCat`。
 */
const picked = computed({
  get: () => patrol.pickedCat,
  set: (v: string) => patrol.pickCat(v),
})

/** 默认落点：第一个真有照片的分类，全空时退回设计稿的「项目全景」 */
const defaultCat = computed(() => chips.value.find((c) => c.count > 0)?.id ?? PATROL_CATS[0].id)

/** 当前生效的分类（`picked` 失效时自动回落到默认，刷新后不会停在空分类上） */
const activeCat = computed(() =>
  picked.value && chips.value.some((c) => c.id === picked.value) ? picked.value : defaultCat.value,
)

/**
 * 子页切换：**只在面板内部点另一格时**发生，只取点中的这一格。
 *
 * 面板级进入不走这里 —— 那是 `onMounted` 的 `enterPanel()`，由它决定「续上
 * 上次那一格」还是「首次探测」。两者分开，切回来才不会把六格全刷一遍。
 */
watch(activeCat, (id) => {
  void patrol.loadCat(id)
})

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
 * 当前分类是否**还在等接口响应**（含首次进入的逐格探测）。
 *
 * 六格各自一条链、各自一套状态（见 `stores/patrol.ts` 的 `catStateOf`），
 * 所以判断也只看当前选中的那一格；`entering` 是「首次进入还在探第一格」，
 * 探测期间无论停在哪一格都应当铺骨架。
 *
 * 为什么单独拎这个判断：以前「还在等响应」和「这格真的没照片」共用一句话，
 * 数据还在路上，页面已经写下结论「这个分类下还没有照片」—— 现场的观感就是
 * 「明明有，却先说没有，过一会儿又冒出来」。现在这一段显示「图片刷新」，
 * 响应回来（ok / error）才落回原文案。
 *
 * ⚠️ 必须放在 `activeCat` / `hasContent` 之后：下面的 `useSlowLoading` 会在
 * setup 阶段**立刻**读一次（`watch` 的 immediate），提前定义会命中
 * 「Cannot access before initialization」。
 */
const catLoading = computed(() => patrol.entering || patrol.catStateOf(activeCat.value) === 'loading')

/** 当前分类自己的状态（ok / error / idle），空态文案按它落 */
const catState = computed(() => patrol.catStateOf(activeCat.value))

/** 六格里任何一格手里有东西（首屏骨架只在「一片空白」时才铺） */
const anyData = computed(
  () =>
    Boolean(patrol.pano) ||
    patrol.list.length > 0 ||
    patrol.spot.length > 0 ||
    patrol.yard.length > 0 ||
    patrol.facility.length > 0 ||
    patrol.safety.length > 0 ||
    patrol.gate.length > 0,
)

/**
 * 首屏骨架：当前这一格还在取，而且**哪一格都还没有东西**。
 *
 * 与下面「图片刷新」的区别：这是第一次进来（手里什么都没有），铺的就是
 * 智眸的首屏骨架；已经有别的格子在显示时改成小字提示，不把已有画面盖掉。
 */
const syncing = computed(() => catLoading.value && !anyData.value)
const showSkel = useSlowLoading(() => syncing.value)

/** 当前分类取不到时写哪一句（六格各说各的，不统一成「照片」） */
const catErrorText = computed(() => {
  switch (activeCat.value) {
    case 'pano':
      return 'VR 360环视暂时取不到'
    case 'pit':
      return '全景航拍照片暂时取不到'
    case 'equip':
      return '材料堆场照片暂时取不到'
    case 'face':
      return '设备设施照片暂时取不到'
    case 'layout':
      return '安全巡查照片暂时取不到'
    case 'yard':
      return '出入口管控照片暂时取不到'
    default:
      return '巡检照片暂时取不到'
  }
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
const showRefresh = useSlowLoading(() => catLoading.value && !hasContent.value)

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

/**
 * 空态上的「重试」：只重取**当前这一格**，不惊动别的格。
 *
 * `force` 绕过 store 里 15 秒 / 60 秒那两道闸 —— 用户已经明说要再取一次了。
 * 也不用再按分类写六个函数：取数入口已经收成 `loadCat(id)` 一个。
 */
function retryCurrent(): void {
  void patrol.loadCat(activeCat.value, true)
}
</script>

<template>
  <div class="safe-block">
    <div class="patrol-hd">
      <h4>最新照片</h4>
      <em>{{ chips.find((c) => c.id === activeCat)?.count ?? 0 }} 张</em>
    </div>

    <!--
      分类：3 列 × 2 行固定版式（设计稿 .patrol-cats），0 张的分类照旧占位。

      2026-11-24：这排按钮**恒定显示**，不再等「有数据才出现」。子页改成懒加载后
      计数只有点开过的那一格才知道，按钮如果也藏着，首屏一空就没有任何入口可切；
      而它本来就是六个固定的位置，不依赖数据。
    -->
    <div class="patrol-cats" role="group" aria-label="照片分类">
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
          <!-- 日期那行（2026-11-23）：卡片改成「标题 + 时间」两行，骨架跟着补一条，数据回来不跳高 -->
          <Skel w="45%" h="11px" />
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
            <Skel w="45%" h="11px" />
          </div>
        </div>
      </div>
      <p class="patrol-refreshing-tip" role="status">图片刷新</p>
    </div>

    <!--
      当前分类下没有东西：取不到就写「暂时取不到」+ 重试，取到了但没有照片就写
      设计稿原文「这个分类下还没有照片」。两条都只看**这一格**自己的状态。
    -->
    <div v-else-if="!hasContent" class="patrol-empty">
      <!-- 六格各走自己的链，挂了要说「取不到」而不是「没有照片」 -->
      <p v-if="catState === 'error'">{{ catErrorText }}</p>
      <p v-else>这个分类下还没有照片</p>
      <button v-if="catState === 'error'" class="data-empty-btn" type="button" @click="retryCurrent">
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
        </div>
        <div class="patrol-card-ft">
          <div class="patrol-card-name">
            <!-- 名字前段就是「站点-全景」，一眼能看出是哪片工地（全景不按项目筛，见 api/drone.ts） -->
            <strong>{{ panoLabel(patrol.pano.taskName) }}</strong>
          </div>
          <p class="patrol-card-time">{{ panoTime || '—' }}</p>
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
          <span v-else class="patrol-thumb-hint">点击查看原图</span>
          <span class="patrol-thumb-tag" :class="{ 'is-pano': patrol.isPano(p.id) }">
            {{ patrol.isPano(p.id) ? '全景' : p.snap ? '抓拍' : '航拍' }}
          </span>
        </div>
        <div class="patrol-card-ft">
          <div class="patrol-card-name">
            <!-- 标题是真实航线名（抓拍则是点位名：2#塔吊 / 2#门监控1） -->
            <strong>{{ p.taskName }}</strong>
          </div>
          <!--
            时间单独一行（2026-11-23 现场要求）。原先它和标题挤在同一行、靠
            `margin-left:auto` 顶到右边，把标题压成「向…」；换行后标题拿满宽度，
            时间左对齐与标题起点齐平。
            原来标题下面那行「分类 + 来源」胶囊（全景航拍 / 无人机）已按要求整行删除
            —— 分类在上面那排筛选里已经选着了，来源看角标就够。
          -->
          <p class="patrol-card-time">{{ p.time.slice(0, 16).replace('T', ' ') }}</p>
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
  </div>
</template>
