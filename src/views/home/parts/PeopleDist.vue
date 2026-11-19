<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import type { SceneAtte } from '@/api/person'
import Skel from '@/components/ui/Skel.vue'
import { useAuthStore } from '@/stores/auth'
import { useOverviewStore } from '@/stores/overview'
import { useSubpageStore } from '@/stores/subpage'
import { useScrollChain } from '@/utils/scrollChain'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 人员区域分布（2026-11-18 对齐 V2「人员分布」浮层）
 *
 * **改造前**：列 `:8084 /api/data/areas` 的区域台账（智能电梯2 / 机器人展示区 /
 * 5G塔机控制室…），那些是**设备标签**不是人员区域，人数一律「—」，卡片下面
 * 还挂着一句「人员实时定位接口未开放」。一整张卡没有一个数字是真的。
 *
 * **现在**：数据来自 `POST /location/personCurLocation/v2` 的
 * `stayPersonCountVos`（与「今日出勤工种」卡同一次请求），按现场管控区归到
 * V2 地图的三个场景：
 *
 *   场布图   ← 管理区域 / 智能钢筋加工区 / 北侧钢筋加工区
 *   2#住宅楼 ← 2#楼 3F/4F/5F 等管控区
 *   地下室   ← B1 管理区域
 *
 * 数字取 `onlinePersonNum`（此刻在线）—— 各管控区之和正好等于「全部」行的
 * 在线数，也就是 V2 那个浮层的口径（见 `api/person.ts` 的 groupScenes）。
 * 点场景可以下钻看它下面的管控区明细；`count` 是真实值，0 就写 0。
 *
 * 取不到就空态，不许出现「0 人」这种假结论：`scenes` 为空 = 接口没给区域口径。
 */
const auth = useAuthStore()
const overview = useOverviewStore()
const subpage = useSubpageStore()

/** 下钻到的场景；null = 三场景列表 */
const drilled = ref<SceneAtte | null>(null)

/**
 * 名单的滚动接力（2026-11-18）
 *
 * 名单限高 320px 自身能滚，外层抽屉也能滚。`useScrollChain` 负责：内层滚到
 * 边界后把滚轮余量交给抽屉（触摸端靠 CSS 的原生滚动链，见那个文件的注释），
 * 顺带给出 `canUp / canDown` 让两侧显示「上面/下面还有」的渐隐。
 */
const listEl = ref<HTMLElement | null>(null)
const { canUp, canDown, reset: resetScroll } = useScrollChain(listEl)

/**
 * 换一层就回到名单顶部。
 *
 * 不重置的话：从「场布图」滚到中间 → 返回 → 点「2#住宅楼」，容器沿用上次的
 * scrollTop，一进去就停在名单中段，看起来像内容跳了一下。
 */
watch(drilled, async () => {
  await nextTick()
  resetScroll()
})

/** 三场景（顺序固定，0 人也列出来，与 V2 一致） */
const scenes = computed(() => overview.scenes)

/** 场景级别的数据到没到；到了就一律显示真实数字（含 0） */
const hasData = computed(() => scenes.value.length > 0)

const showSkel = useSlowLoading(() => !hasData.value && overview.loading)

const emptyText = computed(() => {
  if (!auth.isLoggedIn) return '今日人员分布需登录后查看'
  if (overview.error) return `人员分布加载失败：${overview.error}`
  return '暂无人员区域数据'
})

/**
 * 下钻里有人 / 无人的子级数量，给副标题用。
 *
 * 2#住宅楼 / 地下室的子级是**层**，场布图是**管控区** —— 固定楼层表会让没人的
 * 层也占一行，所以这里要如实数「共 5 层」，而不是「共 5 个管控区」。
 * `isFloor` 同时决定列表排版：楼层是一行一条数据，管控区是带小标题的一段名单。
 */
const areaStats = computed(() => {
  const list = drilled.value?.units ?? []
  const isFloor = Boolean(drilled.value) && drilled.value?.name !== '场布图'
  const live = list.filter((a) => a.count > 0).length
  const all = list.length
  return {
    live,
    all,
    isFloor,
    text: isFloor ? `有人 ${live} 层 · 共${all}层` : `有人 ${live} 个 · 共${all}个管控区`,
  }
})

function onDrill(s: SceneAtte): void {
  if (!s.units.length) return
  drilled.value = s
}

function onBack(): void {
  drilled.value = null
}

function goLogin(): void {
  subpage.openLogin('登录后可查看今日人员分布')
}

function retry(): void {
  void overview.load(true)
}
</script>

<template>
  <!-- 下钻：该场景下的子级（楼层 / 管控区）+ 人员姓名 -->
  <template v-if="drilled">
    <button class="people-back" type="button" data-people="back" @click="onBack">
      <em>‹</em>
      <strong>{{ drilled.name }}</strong>
      <b>{{ drilled.count }}<i>人</i></b>
    </button>
    <div class="people-sub">{{ areaStats.text }}</div>
    <!--
      名单限高内滚：滚到上/下边界后继续滑，滚动会接力给外层抽屉（见 useScrollChain）。
      两侧渐隐只在那个方向「还有东西」时出现，提示手势没被吃掉。
    -->
    <div class="people-scroll" :class="{ 'can-up': canUp, 'can-down': canDown }">
      <div ref="listEl" class="people-groups" data-people="areas">
        <div v-for="a in drilled.units" :key="a.name" class="people-group" :class="{ 'is-floor': areaStats.isFloor }">
          <div class="people-group-hd">
            <span>{{ a.name }}</span>
            <b>{{ a.count }}<em>人</em></b>
          </div>
          <ul v-if="a.members.length" class="people-members">
            <li v-for="(m, i) in a.members" :key="`${m.name}-${i}`">
              <span class="pm-name">{{ m.name }}</span>
              <span class="pm-trade">{{ m.trade }}</span>
            </li>
          </ul>
          <!-- 0 人的楼层不摆「暂无名单」：没人就是没人，那行数字已经说明白了 -->
          <div v-else-if="a.count > 0" class="people-no-member">暂无现场名单</div>
        </div>
      </div>
    </div>
  </template>

  <!-- 顶层：V2 的三个场景 -->
  <template v-else>
    <!--
      慢请求：3 行灰条与 .people-scene 同构（同一行高、同样的左右分栏）。
      `is-on` 之前整层 opacity: 0 —— 先占位撑住版式，快请求看不到灰条，
      也不会在同步中先抛出「暂无人员区域数据」这个错误结论。
    -->
    <template v-if="!hasData && overview.loading">
      <span class="sr-only" role="status">正在同步人员分布</span>
      <div class="people-scenes skel-fade" :class="{ 'is-on': showSkel }" data-skel="people-dist" aria-hidden="true">
        <div v-for="i in 3" :key="i" class="people-scene">
          <Skel w="64px" h="13px" />
          <Skel w="42px" h="17px" r="var(--r-6)" />
        </div>
      </div>
    </template>
    <template v-else-if="hasData">
      <div class="people-scenes" data-people="scenes">
        <button
          v-for="s in scenes"
          :key="s.name"
          class="people-scene"
          :class="{ empty: !s.count, drill: s.units.length > 0 }"
          type="button"
          :disabled="!s.units.length"
          :data-scene="s.name"
          @click="onDrill(s)"
        >
          <span>{{ s.name }}</span>
          <b>{{ s.count }}<em>人</em></b>
        </button>
      </div>
    </template>
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
</template>
