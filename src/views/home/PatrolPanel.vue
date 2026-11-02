<script setup lang="ts">
import { computed, ref } from 'vue'

import { patrolCats, patrolPhotos } from '@/data/config'
import { useBottomSheetStore } from '@/stores/bottomSheet'

/**
 * 首页 · 智巡面板（2026-10 版本同步 · 第三批）
 *
 * 设计稿把原来的「质量管理」整块换成了巡检照片墙：
 * 六个分类（项目全景 / 基坑区域 / 作业面 / 施工装备 / 材料堆场 / 现场场布），
 * 每类下有 2~4 张无人机或监控抓拍，点开看大图与分类/来源/时间。
 *
 * 两个刻意的取舍：
 *   · 没有「全部」分类 —— 设计稿的 6 个分类是互斥的查看视角，不是筛选标签，
 *     17 张照片平铺反而让人不知道从哪看起；原版接口里留了 patrolCat='all'
 *     的分支，但界面上从来没有这个入口。
 *   · 排序在组件内做（时间倒序）而不是预先排好数组 —— 同一分类的照片
 *     来源不同、时刻不同，让展示顺序跟着 time 走，以后接接口换数据也不会乱。
 */
const sheet = useBottomSheetStore()

/** 当前分类，默认第一个（项目全景） */
const cat = ref(patrolCats[0].id)

const catName = computed(() => patrolCats.find((c) => c.id === cat.value)?.name ?? '')

/** 当前分类下的照片，按拍摄时间倒序 */
const list = computed(() =>
  patrolPhotos
    .filter((p) => p.cat === cat.value)
    .slice()
    .sort((a, b) => b.time.localeCompare(a.time) || a.name.localeCompare(b.name, 'zh')),
)
</script>

<template>
  <div class="safe-block">
    <div class="patrol-hd">
      <h4>最新照片</h4>
      <em>{{ list.length }} 张</em>
    </div>

    <!-- 分类是单选，用 aria-pressed 而不是 tab 角色：它们不是分页容器 -->
    <div class="patrol-cats">
      <button
        v-for="c in patrolCats"
        :key="c.id"
        type="button"
        :class="{ on: cat === c.id }"
        :aria-pressed="cat === c.id"
        @click="cat = c.id"
      >
        {{ c.name }}
      </button>
    </div>

    <div class="patrol-grid">
      <button
        v-for="p in list"
        :key="p.id"
        class="patrol-card"
        type="button"
        :aria-label="`${p.name}，${catName}，${p.time}，查看大图`"
        @click="sheet.openPatrol(p.id)"
      >
        <img :class="p.pos" :src="p.img" :alt="p.name" loading="lazy" />
        <div class="patrol-card-ft">
          <div class="patrol-card-name">
            <strong>{{ p.name }}</strong>
            <em>{{ p.time }}</em>
          </div>
          <div class="patrol-tags">
            <span class="patrol-tag">{{ catName }}</span>
            <span class="alarm-src" :class="`alarm-src-${p.src}`">
              {{ p.src === 'drone' ? '无人机' : '视频监控' }}
            </span>
          </div>
        </div>
      </button>
    </div>

    <div v-if="!list.length" class="patrol-empty">这个分类下还没有照片</div>
  </div>
</template>
