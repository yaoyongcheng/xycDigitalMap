<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { useOverviewStore } from '@/stores/overview'

/**
 * 人员分布 · 分类下钻（2026-11-23 改为底部浮窗）
 *
 * 对应界面：首页「人员管理 → 人员分布」的卡片被点开之后。
 * 结构是 V2 那个 #peoplePop 的两段：
 *
 *   一排区域按钮（楼层 1F…5F / 场布图的几个管控区）→ 选中区域的人员姓名
 *
 * 标题（分类名）、副标题（有人几层 / 共几层）与右侧总人数由 SheetHost 统一渲染，
 * 这里只负责按钮行与名单 —— 与其它弹层共用同一套标题排版。
 *
 * 选中项的默认值取「第一个有人的区域」：现场 2#住宅楼常年是 1F 有人、2F~5F 空，
 * 默认停在 1F 才能一进来就看到名单；全空时退到第一个，让按钮行仍是完整的一排。
 */
const props = defineProps<{ name: string }>()

const overview = useOverviewStore()

/** 当前分类（按名字回查，数据刷新后自动跟着变） */
const scene = computed(() => overview.scenes.find((s) => s.name === props.name))

const units = computed(() => scene.value?.units ?? [])

/** 选中的区域名 */
const picked = ref('')

watch(
  units,
  (list) => {
    // 分类变了（或数据首次到）时重挑一次；仍在列表里就保留用户的选择
    if (list.some((u) => u.name === picked.value)) return
    picked.value = (list.find((u) => u.count > 0) ?? list[0])?.name ?? ''
  },
  { immediate: true },
)

const active = computed(() => units.value.find((u) => u.name === picked.value) ?? null)

/**
 * 名单滚到顶部再换区域。
 *
 * 容器是同一个（只换里面的 li），不重置的话：在 33 人的管控区滑到中段、
 * 点下一个只有 4 人的区域，名单会停在原来的 scrollTop 附近 —— 看起来像
 * 「这 4 个人的名单是空的」。
 */
const listEl = ref<HTMLElement | null>(null)

watch(picked, async () => {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = 0
})
</script>

<template>
  <div class="pd">
    <!-- 区域按钮：横排可滑，选中态用蓝底 + 亮描边，未选是中性卡片 -->
    <div v-if="units.length" class="pd-units" data-people="units">
      <button
        v-for="u in units"
        :key="u.name"
        class="pd-unit"
        :class="{ on: u.name === picked, empty: !u.count }"
        type="button"
        :aria-pressed="u.name === picked"
        :data-unit="u.name"
        @click="picked = u.name"
      >
        <span>{{ u.name }}</span>
        <b>{{ u.count }}</b>
      </button>
    </div>

    <div v-else class="pd-empty">该分类暂无区域数据</div>

    <!-- 选中区域的人员姓名（0 人时说「暂无现场名单」，不假装没取到） -->
    <div v-if="active" ref="listEl" class="pd-list" data-people="members">
      <ul v-if="active.members.length" class="people-members">
        <li v-for="(m, i) in active.members" :key="`${m.name}-${i}`">
          <span class="pm-name">{{ m.name }}</span>
          <span class="pm-trade">{{ m.trade }}</span>
        </li>
      </ul>
      <div v-else class="pd-empty">该区域暂无现场名单</div>
    </div>
  </div>
</template>
