<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { PATROL_CATS, catOfTask } from '@/data/config'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { usePatrolStore } from '@/stores/patrol'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 首页 · 智眸面板（现场快照・实景核验）
 *
 * 照片来自 keehang 真实航拍媒体（见 `stores/patrol.ts`）。
 *
 * ## 分类：设计稿的六类，固定两行（2026-11-16 用户要求）
 *
 * 项目全景 / 基坑区域 / 作业面 / 施工装备 / 材料堆场 / 现场场布 —— 3 列 × 2 行，
 * 位置固定（某一类 0 张也占位，否则一有数据就换行错位），不做横向滑动。
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
const syncing = computed(() => patrol.state === 'loading' && !patrol.photos.length)
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
  PATROL_CATS.map((c) => ({ id: c.id, name: c.name, count: (groups.value.get(c.id) ?? []).length })),
)

/** 手动选中的分类（空串 = 还没点过，跟随默认） */
const picked = ref('')

/** 默认落点：第一个真有照片的分类，全空时退回设计稿的「项目全景」 */
const defaultCat = computed(() => chips.value.find((c) => c.count > 0)?.id ?? PATROL_CATS[0].id)

/** 当前生效的分类（`picked` 失效时自动回落到默认，刷新后不会停在空分类上） */
const activeCat = computed(() =>
  picked.value && chips.value.some((c) => c.id === picked.value) ? picked.value : defaultCat.value,
)

const shown = computed(() => groups.value.get(activeCat.value) ?? [])

const activeName = computed(() => chips.value.find((c) => c.id === activeCat.value)?.name ?? '')

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
</script>

<template>
  <div class="safe-block">
    <div class="patrol-hd">
      <h4>最新照片</h4>
      <em>{{ shown.length }} 张</em>
    </div>

    <!-- 分类：3 列 × 2 行固定版式（设计稿 .patrol-cats），0 张的分类照旧占位 -->
    <div v-if="patrol.list.length" class="patrol-cats" role="group" aria-label="照片分类">
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

    <!-- 有照片，但当前分类下没有：设计稿原文「这个分类下还没有照片」 -->
    <div v-else-if="patrol.list.length && !shown.length" class="patrol-empty">
      这个分类下还没有照片
    </div>

    <div v-else-if="shown.length" class="patrol-grid">
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
