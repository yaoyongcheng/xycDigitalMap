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
 * 数据来自 keehang `GET /task/exec/list/record`（本项目 pid 过滤），
 * 不再有写死的三条演示任务。
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
  </div>
</template>
