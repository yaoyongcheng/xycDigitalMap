<script setup lang="ts">
import { computed } from 'vue'

import { useHomeStore } from '@/stores/home'

/**
 * 人员区域分布（两级下钻）
 *
 * 对应原 js/app.js:340-366 renderPeopleDist() + homePanels 上的
 * [data-people] 分支（app.js:961-975）。
 *
 * 顶层是区域列表（.people-zones），点开有 children 的区域后
 * 切到楼层网格（.people-floor-grid），带返回按钮。
 * 原版用 peopleNode 是否为 null 区分两级。
 */
const home = useHomeStore()

/** 当前是否为下钻态（原 peopleNode 有 children） */
const drilled = computed(() => !!(home.peopleNode && home.peopleNode.children))

const floors = computed(() => home.peopleNode?.children ?? [])

/** 原 live = floors.filter(n => n.count).length */
const liveFloors = computed(() => floors.value.filter((n) => n.count).length)

/** 原 peopleChildren()：下钻时取 children，否则取顶层 */
const zones = computed(() => (home.peopleNode?.children ? home.peopleNode.children : home.peopleTree))

function onZone(id: string): void {
  const node = home.peopleTree.find((n) => n.id === id) ?? zones.value.find((n) => n.id === id)
  if (node && node.children) home.peopleNode = node
}

function onBack(): void {
  home.peopleNode = null
}
</script>

<template>
  <!-- 下钻：楼层网格 -->
  <template v-if="drilled">
    <button class="people-back" type="button" data-people="back" @click="onBack">
      <em>‹</em>
      <strong>{{ home.peopleNode?.name }}</strong>
      <b>{{ home.peopleNode?.count }}<i>人</i></b>
    </button>
    <div class="people-sub">有人 {{ liveFloors }}层 · 共{{ floors.length }}层</div>
    <div class="people-floor-grid">
      <div v-for="n in floors" :key="n.id" class="people-floor" :class="{ empty: !n.count }">
        <span>{{ n.name }}</span>
        <b>{{ n.count }}</b>
      </div>
    </div>
  </template>

  <!-- 顶层：区域列表 -->
  <div v-else class="people-zones">
    <button
      v-for="n in home.peopleTree"
      :key="n.id"
      class="people-zone"
      :class="{ drill: !!n.children }"
      type="button"
      :data-people="n.id"
      @click="onZone(n.id)"
    >
      <span>{{ n.name }}</span>
      <b>{{ n.count }}<em>人</em></b>
      <i v-if="n.children">›</i>
    </button>
  </div>
</template>
