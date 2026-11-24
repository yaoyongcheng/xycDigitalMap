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
 * ## 清单 = 当天全部排班（条数与三格严格一致）
 *
 * 三格的「今日任务」= 统计的 `taskCount + suspendedCount`（都能对上清单条数）。
 * 两条历史坑都已定位：
 * ① **分页**（2026-11-24 根因）：统计响应里的 `completedTaskList` /
 *    `unfinishedTaskList` 是分页列表，不带 `pageNum/pageSize` 时按默认页长截断
 *    —— 12 条未完成只回 7 条，于是「清单 10 vs 卡上 15」。现在请求统一带
 *    `pageSize=200`（`api/drone.ts::fetchTaskStat`），同时清单主源用
 *    `/dashboard/task/list/execRecord/today`（`fetchTodayTaskList`）一次给全。
 * ② **暂停口径**：当天 15 条排班里 11 条被服务端标 `suspended`，
 *    `taskCount` 不计它们（只算 4 条），所以三格要把 `suspendedCount` 加回来；
 *    清单里这 11 条按用户要求显示「未执行」，不再写「已暂停」。
 * 万一哪天服务端又截断或混进别的项目，底部会多一行说明（双向提示）。
 *
 * ## 「失败」看 result
 *
 * `status` 对已执行记录恒为 2，失败写在 `result: 3`（见 `DroneTaskRecord.result`）。
 * 状态文案与配色由 `stores/uav.ts::stateText/stateClass` 统一给出。
 *
 * 明细只留本项目：全量端点会连「光谷元著」一起回（`pidList` 参数服务端不认），
 * 由 `api/drone.ts::fetchTodayTaskList` 按 `executeInfo.pid` 过滤，
 * 与三格的 `pid` 同一口径。
 */
const uav = useUavStore()

const syncing = computed(() => uav.state === 'loading' && !uav.records.length)
const showSkel = useSlowLoading(() => syncing.value)

/**
 * 清单条数与三格「今日任务」的差。
 *
 * 正常恒为 0（条数必须一致，见 `stores/uav.ts::loadTodayList`）。留着它是
 * 兜底：服务端哪天又把明细截断了，弹层至少写一句「统计 15 条、本清单 10 条」，
 * 而不是让人对着两个数字猜哪个是错的。
 */
const gap = computed(() => {
  const total = uav.taskTotal
  if (total === null) return 0
  // 正数 = 清单少（统计里有、明细没回）；负数 = 清单多（多出未计入的排班）
  return total - uav.todayTasks.length
})
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

    <!-- 条数对不上才出现（正常为 0）：分方向说清，不猜 -->
    <p v-if="gap > 0" class="uav-log-note">
      统计 {{ uav.taskTotal }} 条，本清单 {{ uav.todayTasks.length }} 条（其余排班未回传明细）
    </p>
    <p v-else-if="gap < 0" class="uav-log-note">
      本清单 {{ uav.todayTasks.length }} 条，比统计多 {{ -gap }} 条（有排班未计入今日任务）
    </p>
  </div>
</template>
