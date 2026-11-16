<script setup lang="ts">
import { computed } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { useUavStore } from '@/stores/uav'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 今日任务（2026-11 阶段 8：改真实数据）
 *
 * 只读清单：时间 / 航线 / 状态。状态用颜色区分执行中与已完成 ——
 * 三行文字完全相同、只有两个字不一样时，扫读靠的就是这点颜色。
 *
 * 数据来自 keehang `GET /task/exec/list/record`，**账号口径**（本项目 + 同账号
 * 其它项目逐个项目取完合并），条数与三格 `taskCount` 一致。
 */
const uav = useUavStore()

const syncing = computed(() => uav.state === 'loading' && !uav.records.length)
const showSkel = useSlowLoading(() => syncing.value)
</script>

<template>
  <div class="uav-log">
    <!-- 同步中：按 .uav-log 行的结构铺灰条，数据到了原位回填 -->
    <div v-if="syncing" class="skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
      <div v-for="i in 3" :key="i" class="uav-log-row is-skel">
        <Skel w="44px" h="15px" />
        <Skel class="skel-mt" w="120px" h="13px" />
        <Skel class="skel-mt" w="48px" h="13px" />
      </div>
    </div>

    <div v-for="t in uav.todayTasks" :key="t.key" class="uav-log-row">
      <b>{{ t.time }}</b>
      <span>{{ t.name }}</span>
      <em :class="t.stateClass">{{ t.state }}</em>
    </div>

    <div v-if="!syncing && !uav.todayTasks.length" class="data-empty">
      <p>{{ uav.state === 'error' ? uav.error || '无人机任务加载失败' : '今日暂无无人机任务' }}</p>
    </div>

    <!--
      口径说明：三格「今日任务」是账号级统计（含同账号其它项目），这份明细
      为了跟它对齐也一并列出。只在真有别的项目时才出现，别的时候不占地方。
    -->
    <p v-if="uav.todayHasOthers" class="uav-log-note">含同账号其它项目的任务</p>
  </div>
</template>
