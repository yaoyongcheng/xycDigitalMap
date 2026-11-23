<script setup lang="ts">
import { computed } from 'vue'

import type { SceneAtte } from '@/api/person'
import Skel from '@/components/ui/Skel.vue'
import { useAuthStore } from '@/stores/auth'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useOverviewStore } from '@/stores/overview'
import { useSubpageStore } from '@/stores/subpage'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 人员分布（2026-11-23 改回「分类卡片 + 底部浮窗」）
 *
 * **改版前**是在卡片里内联下钻：点一行场景，同一块地方换成子级列表 + 姓名。
 * 现在改成参考稿的样子 —— 三个场景各一张方格卡，点卡片从底部弹浮窗
 * （`SheetHost` 的 `people-dist`），区域按钮与姓名都在浮窗里。
 *
 * 数据一个字没动：仍然是 `POST /location/personCurLocation/v2` 的
 * `stayPersonCountVos` / `stayPersonPageVos`，按现场管控区归到
 * 场布图 / 2#住宅楼 / 地下室（见 `api/person.ts` 的 buildScenes）。
 *   场布图   ← 管理区域 / 智能钢筋加工区 / 北侧钢筋加工区
 *   2#住宅楼 ← 2#楼 1F~5F 管控区
 *   地下室   ← B1 管理区域
 *
 * 数字取 `onlinePersonNum`（此刻在线），各场景之和等于「全部」行的在线数。
 * 没有下级的场景（units 为空）卡片不可点、也不画箭头 —— 点开一个空浮窗
 * 比不给入口更糟。取不到就空态，不许出现「0 人」这种假结论。
 */
const auth = useAuthStore()
const overview = useOverviewStore()
const subpage = useSubpageStore()
const sheet = useBottomSheetStore()

/** 三个场景（顺序固定，0 人也列出来，与 V2 一致） */
const scenes = computed(() => overview.scenes)

/** 场景级别的数据到没到；到了就一律显示真实数字（含 0） */
const hasData = computed(() => scenes.value.length > 0)

const showSkel = useSlowLoading(() => !hasData.value && overview.loading)

const emptyText = computed(() => {
  if (!auth.isLoggedIn) return '今日人员分布需登录后查看'
  if (overview.error) return `人员分布加载失败：${overview.error}`
  return '暂无人员区域数据'
})

/** 点分类卡片：有下级就开浮窗；没有下级（units 为空）时什么都不做 */
function onOpen(s: SceneAtte): void {
  if (!s.units.length) return
  sheet.openPeopleDist(s.name)
}

function goLogin(): void {
  subpage.openLogin('登录后可查看今日人员分布')
}

function retry(): void {
  void overview.load(true)
}
</script>

<template>
  <!--
    慢请求：3 张灰卡与 .people-scene 同构（同样的高度与内边距）。
    `is-on` 之前整层 opacity: 0 —— 先占位撑住版式，快请求看不到灰条，
    也不会在同步中先抛出「暂无人员区域数据」这个错误结论。
  -->
  <template v-if="!hasData && overview.loading">
    <span class="sr-only" role="status">正在同步人员分布</span>
    <div class="people-scenes skel-fade" :class="{ 'is-on': showSkel }" data-skel="people-dist" aria-hidden="true">
      <div v-for="i in 3" :key="i" class="people-scene">
        <Skel w="48px" h="13px" />
        <Skel class="skel-mt" w="40px" h="21px" />
      </div>
    </div>
  </template>

  <div v-else-if="hasData" class="people-scenes" data-people="scenes">
    <button
      v-for="s in scenes"
      :key="s.name"
      class="people-scene"
      :class="{ empty: !s.count, drill: s.units.length > 0 }"
      type="button"
      :disabled="!s.units.length"
      :data-scene="s.name"
      @click="onOpen(s)"
    >
      <span>{{ s.name }}</span>
      <b>{{ s.count }}<em>人</em></b>
    </button>
  </div>

  <div v-else class="data-empty" data-empty="people-dist">
    <p>{{ emptyText }}</p>
    <button
      v-if="auth.isLoggedIn && overview.error"
      class="data-empty-btn"
      type="button"
      @click="retry"
    >重试</button>
    <button v-else-if="!auth.isLoggedIn" class="data-empty-btn" type="button" @click="goLogin">去登录</button>
  </div>
</template>
