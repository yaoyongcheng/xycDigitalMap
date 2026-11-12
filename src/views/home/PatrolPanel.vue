<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { PATROL_CATS, PATROL_CAT_UNKNOWN, catOfTask } from '@/data/config'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { usePatrolStore } from '@/stores/patrol'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 首页 · 智眸面板（现场快照・实景核验）
 *
 * 2026-11 阶段 8 起照片改接 keehang 平台的真实航拍媒体（见 `stores/patrol.ts`）。
 *
 * ## 分类（2026-11 第四轮：按设计稿恢复六个分类）
 *
 * 设计稿 `renderProgress()`（原 app.js:657-684）把「最新照片」分成六个分类：
 * 项目全景 / 基坑区域 / 作业面 / 施工装备 / 材料堆场 / 现场场布。原版把分类
 * 直接写在照片数据上（`patrolPhotos[i].cat`），而**服务端没有这个字段** ——
 * 上一轮因此把分类整组删掉、改成平铺。
 *
 * 现在按设计稿把分类作为展示维度恢复：归属由任务名关键词推导（`catOfTask`，
 * 规则见 `data/config.ts` 的 PATROL_CATS）。推导不出来的照片不会被藏起来 ——
 * 归入「未分类」，且这个分类只在真有照片时才出现在网格里。
 *
 * 默认选中「第一个真有照片的分类」，而不是设计稿写死的「项目全景」：现场如果
 * 没有全景航线，一进来就是「这个分类下还没有照片」，等于把页面做成空白。
 *
 * ## 为什么缩略图不自动加载
 *
 * 真实 DJI 原图单张 5~8MB（实测 5378048 字节）。列表里直接 `<img src>` 会把
 * 流量吃光，手机上更卡。这里只显示任务名与体积摘要，**点开大图时才加载原图**。
 */
const sheet = useBottomSheetStore()
const patrol = usePatrolStore()

onMounted(() => {
  void patrol.load()
})

/** 慢请求才显示骨架 */
const syncing = computed(() => patrol.state === 'loading' && !patrol.photos.length)
const showSkel = useSlowLoading(() => syncing.value)

/** 每张照片带上推导出的分类 id（`patrol.list` 已按时间倒序） */
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

/**
 * 分类按钮：六个分类恒定显示（即使 0 张，位置也要在，否则一有数据就换行错位），
 * 「未分类」只在真有推不出来的照片时追加。
 */
const chips = computed(() => {
  const base = PATROL_CATS.map((c) => ({ id: c.id, name: c.name, count: (groups.value.get(c.id) ?? []).length }))
  const other = groups.value.get(PATROL_CAT_UNKNOWN.id) ?? []
  return other.length ? [...base, { id: PATROL_CAT_UNKNOWN.id, name: PATROL_CAT_UNKNOWN.name, count: other.length }] : base
})

/** 手动选中的分类（空串 = 还没点过，跟随默认） */
const picked = ref('')

/** 默认落点：第一个真有照片的分类，全空时退回设计稿的「项目全景」 */
const defaultCat = computed(() => chips.value.find((c) => c.count > 0)?.id ?? PATROL_CATS[0].id)

/**
 * 当前生效的分类。
 *
 * 这里必须校验 `picked` 还在候选里：刷新后若「未分类」那组变空，它的按钮会消失，
 * 而 `picked` 还停在 `'other'` —— 结果是所有按钮都没有高亮、内容区却写着
 * 「这个分类下还没有照片」，而此刻其实有照片。回落到默认分类即可自愈。
 */
const activeCat = computed(() => {
  if (picked.value && chips.value.some((c) => c.id === picked.value)) return picked.value
  return defaultCat.value
})

const shown = computed(() => groups.value.get(activeCat.value) ?? [])

const activeName = computed(() => chips.value.find((c) => c.id === activeCat.value)?.name ?? '')

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

    <!-- 分类：3 列网格（设计稿 .patrol-cats），0 张的分类照旧显示位置 -->
    <div v-if="patrol.list.length" class="patrol-cats" role="group" aria-label="照片分类">
      <button
        v-for="c in chips"
        :key="c.id"
        type="button"
        :class="{ on: activeCat === c.id }"
        :aria-pressed="activeCat === c.id"
        @click="picked = c.id"
      >
        {{ c.name }}
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
        :aria-label="`${p.taskName}，${p.time}，${activeName}，查看大图`"
        @click="sheet.openPatrol(p.id)"
      >
        <div class="patrol-thumb">
          <span class="patrol-thumb-tag">航拍原图</span>
          <span class="patrol-thumb-hint">点击查看原图 · {{ patrol.sizeText(p.size) }}</span>
        </div>
        <div class="patrol-card-ft">
          <div class="patrol-card-name">
            <strong>{{ p.taskName }}</strong>
            <em>{{ p.time.slice(0, 16).replace('T', ' ') }}</em>
          </div>
          <div class="patrol-tags">
            <!-- 分类徽标与「来源」徽标并排（设计稿 .patrol-card-ft 的两枚 tag） -->
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
