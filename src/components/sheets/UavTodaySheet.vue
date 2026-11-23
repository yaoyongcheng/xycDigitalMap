<script setup lang="ts">
import { computed } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { useUavStore } from '@/stores/uav'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 今日任务（2026-11 阶段 8：改真实数据）
 *
 * 只读清单：时间 / 航线 / 状态。状态用颜色区分执行中、已完成、已失败 ——
 * 三行文字相近时，扫读靠的就是这点颜色。
 *
 * ## 清单 = 已执行的记录 + 还没飞的计划项
 *
 * 三格的「今日任务」是**计划口径**（`taskCount` = 成功 + 失败 + 还没飞）。
 * 执行记录接口只返回「已产生记录」的项，所以早先 15 与 13 对不上 ——
 * 差的正是当天剩下那两条排班。2026-11-23 用户要求「查看今日任务里也要包含
 * 未执行的任务」，于是 `stores/uav.ts::todayPending` 把统计接口
 * `unfinishedTaskList` 里的计划项补进同一个清单，条数与三格一致，
 * 未起飞的显示「未执行」。
 *
 * ## 「失败」看 result
 *
 * `status` 对已执行记录恒为 2，失败写在 `result: 3`（见 `DroneTaskRecord.result`）。
 * 状态文案与配色由 `stores/uav.ts::stateText/stateClass` 统一给出。
 *
 * 明细已按本项目过滤（`pids: [本项目]`，与三格的 `pid` 同一口径）。
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
      口径提示：明细已按本项目过滤（见文件头），正常情况下**不会出现**。
      保留这一行是兜底 —— 万一服务端将来又给回别的项目的记录，
      至少能说清「这一条不是本项目的」，而不是让人以为向阳村多了一条航线。
    -->
    <p v-if="uav.todayHasOthers" class="uav-log-note">含同账号其它项目的任务</p>
  </div>
</template>
