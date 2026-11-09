<script setup lang="ts">
import { computed, ref } from 'vue'

import { CLIMB_LR_LIMIT, CLIMB_TOTAL, CLIMB_UPDATED, climbSensors, splitUnit } from '@/data/climb'

/**
 * 智能爬架详情页（2026-11 设计稿 gx2 版同步）
 *
 * 对应原 js/app.js:2474-2574 renderClimb + openClimbPage：深色子页，
 * ① climb-sum 两格（传感器数量 38 / 更新时间）→ ② 三个读数页签
 * （左右倾斜 / 前后倾斜 / 载荷）→ ③ climb-board 机位列表（36 行，
 * 左右倾斜页签里超 60mm 的机位整行标红）。页签默认停在左右倾斜，
 * 与首页卡片「异常」态同源 —— 异常行只由 data/climb.ts 的 bad 标记推导。
 */
type ClimbTab = 'lr' | 'fb' | 'load'

const tabs: { id: ClimbTab; name: string }[] = [
  { id: 'lr', name: '左右倾斜' },
  { id: 'fb', name: '前后倾斜' },
  { id: 'load', name: '载荷' },
]

const tab = ref<ClimbTab>('lr')

const known = climbSensors.length
const badRows = computed(() => climbSensors.filter((s) => s.bad))
const normal = computed(() => known - badRows.value.length)

/** 当前页签取的读数字段 */
const field = computed(() => (tab.value === 'fb' ? 'fb' : tab.value === 'load' ? 'load' : 'lr') as 'lr' | 'fb' | 'load')

/** 当前页签是否参与异常标红（设计稿只有左右倾斜页签传 badKey） */
const markBad = computed(() => tab.value === 'lr')

/** 「x/ymm」拆段后的展示行 */
const lines = computed(() =>
  climbSensors.map((s) => ({
    id: s.id,
    value: s[field.value],
    time: s.time,
    bad: markBad.value && !!s.bad,
  })),
)

const issues = computed(() =>
  badRows.value.map((s) => `${s.id}#机位 ${s.lr}，超过 ${CLIMB_LR_LIMIT}`),
)
</script>

<template>
  <div class="climb-page">
    <div class="climb-sum">
      <div>
        <span>传感器数量</span>
        <b>{{ CLIMB_TOTAL }}</b>
      </div>
      <div>
        <span>更新时间</span>
        <b class="is-time">{{ CLIMB_UPDATED }}</b>
      </div>
    </div>

    <div class="dev-tabs climb-view">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        :class="{ on: tab === t.id }"
        :aria-pressed="tab === t.id"
        @click="tab = t.id"
      >
        {{ t.name }}
      </button>
    </div>

    <section class="climb-board">
      <header>
        <b :class="badRows.length ? 'is-bad' : 'is-ok'">
          {{ normal }}<i>/{{ known }}</i>
        </b>
      </header>
      <p v-for="text in issues" :key="text" class="climb-issue">{{ text }}</p>
      <div class="climb-lines">
        <div v-for="line in lines" :key="line.id" class="climb-line" :class="{ 'is-bad': line.bad }">
          <b>{{ line.id }}#</b>
          <span>{{ splitUnit(line.value).num }}<i v-if="splitUnit(line.value).unit" class="eq-stat-unit"> {{ splitUnit(line.value).unit }}</i></span>
          <time>{{ line.time }}</time>
        </div>
      </div>
    </section>
  </div>
</template>
