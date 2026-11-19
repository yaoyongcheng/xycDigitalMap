<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import Skel from '@/components/ui/Skel.vue'
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
 * 其中四格**不走照片墙的分类**（2026-11 用户要求，各自一条专用链，见 store）：
 * 「全景航拍」= 全局定点拍照最近一班的 9 张；「材料堆场」= 分区定点拍照最近
 * 一班的第 1、2、37 张；「设备设施」= 塔吊定点最近一班的第 2、第 7 张；
 * 「安全巡查」= 土方1 最近一班的第 1 张 + 分区定点拍照最近一班的第 34 张。
 * 所以它们的计数与内容都从 `patrol.spot / yard / facility / safety` 取，
 * 不按航线名归组 —— 按名字归组会把同类航线的别的照片一起吞进来。
 *
 * ⚠️ 注意分类 `id` 与显示名**早就不对应**了（2026-11-18 只改了文案，没改 id）：
 * 「设备设施」的 id 是 `face`，「材料堆场」的 id 是 `equip`，`pit` 才是「全景航拍」。
 * 下面按 id 分支时别看名字对号。
 *
 * 「设备设施」按用户要求本该有 4 张（塔吊定点 2 张 + 视频监控 2#/4# 塔吊各 1 张），
 * 但监控侧没有照片查询接口，2026-11-18 明确「本轮先保持现状」，所以现在稳定 2 张。
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
    !patrol.safety.length,
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
    // 「设备设施」= 「向阳村-塔吊定点」最近一班的第 2、第 7 张（2026-11-18）
    // —— id 是 `face`（旧归类语义），别看名字对号
    if (c.id === 'face') return { id: c.id, name: c.name, count: patrol.facility.length }
    // 「安全巡查」= 土方1 第 1 张 + 分区定点拍照第 34 张（两条航线各一张）
    if (c.id === 'layout') return { id: c.id, name: c.name, count: patrol.safety.length }
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
 * 「设备设施」也是（`patrol.facility`）：只有「向阳村-塔吊定点」最近一班的
 * 第 2、第 7 张。
 *
 * 「安全巡查」同理（`patrol.safety`）：土方1 第 1 张 + 分区定点拍照第 34 张，
 * 两条航线各一张 —— 卡片标题仍是各自真实航线名。
 *
 * 于是照片墙那套「按航线名归组」（`groups`）现在只服务「出入口管控」一格。
 */
const shown = computed(() => {
  if (activeCat.value === 'pano') return []
  if (activeCat.value === 'pit') return patrol.spot
  if (activeCat.value === 'equip') return patrol.yard
  if (activeCat.value === 'face') return patrol.facility
  if (activeCat.value === 'layout') return patrol.safety
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

/** 全景的**拼接完成**时间（`endTime`，与 V2 重建成果列表一致，见 `api/drone.ts`） */
const panoTime = computed(() => (patrol.pano?.time ?? '').slice(0, 16).replace('T', ' '))

/** 缩略图加载失败的 id 集合（失败的卡片回退成文字占位，不留破图） */
const broken = ref<Record<string, boolean>>({})

function markBroken(id: string): void {
  broken.value = { ...broken.value, [id]: true }
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

/** 「设备设施」2 张单独重试 */
function retryFacility(): void {
  void patrol.loadFacility()
}

/** 「安全巡查」2 张单独重试（两条航线各拉一次） */
function retrySafety(): void {
  void patrol.loadSafety()
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
        patrol.safety.length
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

    <!-- 有内容，但当前分类下没有：设计稿原文「这个分类下还没有照片」 -->
    <div
      v-else-if="
        !hasContent &&
        (patrol.list.length ||
          patrol.pano ||
          patrol.spot.length ||
          patrol.yard.length ||
          patrol.facility.length ||
          patrol.safety.length)
      "
      class="patrol-empty"
    >
      <!-- 全景 / 全景航拍 / 材料堆场 / 设备设施走的是另外几条接口，挂了要说「取不到」而不是「没有照片」 -->
      <p v-if="activeCat === 'pano' && patrol.panoState === 'error'">VR 360环视暂时取不到</p>
      <p v-else-if="activeCat === 'pit' && patrol.spotState === 'error'">全景航拍照片暂时取不到</p>
      <p v-else-if="activeCat === 'equip' && patrol.yardState === 'error'">材料堆场照片暂时取不到</p>
      <p v-else-if="activeCat === 'face' && patrol.facilityState === 'error'">设备设施照片暂时取不到</p>
      <p v-else-if="activeCat === 'layout' && patrol.safetyState === 'error'">安全巡查照片暂时取不到</p>
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
            {{ patrol.isPano(p.id) ? '全景' : '航拍' }}
          </span>
          <span v-if="p.thumbnail && !broken[p.id]" class="patrol-thumb-size">
            {{ patrol.sizeText(p.size) }}
          </span>
        </div>
        <div class="patrol-card-ft">
          <div class="patrol-card-name">
            <!-- 标题是真实航线名，徽标是归类 —— 两个都留着，归错类时一眼能看出是哪条航线 -->
            <strong>{{ p.taskName }}</strong>
            <em>{{ p.time.slice(0, 16).replace('T', ' ') }}</em>
          </div>
          <div class="patrol-tags">
            <span class="patrol-tag">{{ activeName }}</span>
            <span class="alarm-src alarm-src-drone">无人机</span>
          </div>
        </div>
      </button>
    </div>

    <div v-else class="data-empty" data-empty="patrol">
      <p>{{ patrol.state === 'error' ? patrol.error || '巡检照片加载失败' : '暂无航拍照片' }}</p>
      <button v-if="patrol.state === 'error'" class="data-empty-btn" type="button" @click="retry">
        重试
      </button>
    </div>
  </div>
</template>
