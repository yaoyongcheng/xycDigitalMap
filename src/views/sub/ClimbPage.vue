<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { useAuthStore } from '@/stores/auth'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useSubpageStore } from '@/stores/subpage'

/**
 * 智能爬架详情页（2026-11 设计稿 gx2 版同步）
 *
 * 对应原 js/app.js:2474-2574 renderClimb + openClimbPage：深色子页，
 * ① climb-sum 两格（传感器数量 / 更新时间）→ ② 三个读数页签 → ③ 机位列表。
 *
 * **2026-11 第二轮：36 条机位读数全部删除。**
 * 它们原本是 data/climb.ts 里手写的常量（含「30# 机位左右倾斜 179.70mm」这条
 * 唯一异常），四套后端里没有任何爬架传感器接口，台账（`:8084`）只给到
 * 「2#智能爬架 / 在线 / 爬升高度 21」。所以本页只展示台账真有的东西：
 * 设备名、在线状态、爬升高度、更新时间；机位读数区显示空态。
 */
const ledger = useDeviceLedgerStore()
const auth = useAuthStore()
const subpage = useSubpageStore()

onMounted(() => {
  if (auth.token) void ledger.load(auth.token)
})

/** 台账里的爬架（正常只有 1 台） */
const units = computed(() => ledger.categoryUnits('climb'))
const unit = computed(() => units.value[0])

/** 爬升高度这类台账字段（已格式化，如 '21m'） */
const fields = computed(() => unit.value?.cells ?? [])

function retry(): void {
  if (auth.token) void ledger.load(auth.token, true)
}

function goLogin(): void {
  subpage.openLogin('登录后可查看智能爬架状态', { kind: 'climb' })
}
</script>

<template>
  <div class="climb-page">
    <div v-if="!auth.isLoggedIn" class="data-empty" data-empty="climb">
      <p>登录后可查看智能爬架状态</p>
      <button class="data-empty-btn" type="button" @click="goLogin">去登录</button>
    </div>

    <template v-else>
      <div class="climb-sum">
        <div>
          <span>设备数量</span>
          <b>{{ units.length }}</b>
        </div>
        <div>
          <span>设备状态</span>
          <b class="is-time">{{ unit?.status ?? '—' }}</b>
        </div>
      </div>

      <!-- 台账字段（爬升高度等） -->
      <div v-if="fields.length" class="dev-info">
        <div class="dev-info-row"><span>设备名称</span><b>{{ unit?.name }}</b></div>
        <div v-for="[label, value] in fields" :key="label" class="dev-info-row">
          <span>{{ label }}</span><b>{{ value }}</b>
        </div>
      </div>

      <!-- 机位读数：没有接口，明确空态 -->
      <div v-if="ledger.state === 'loading'" class="data-empty" data-empty="climb">
        <p>正在加载设备台账…</p>
      </div>
      <div v-else-if="ledger.state === 'error'" class="data-empty" data-empty="climb">
        <p>{{ ledger.error || '设备台账加载失败' }}</p>
        <button class="data-empty-btn" type="button" @click="retry">重试</button>
      </div>
      <div v-else class="data-empty" data-empty="climb">
        <p>暂无爬架机位读数</p>
        <p class="data-empty-sub">四套后端均未提供爬架传感器接口，当前只能展示台账中的设备属性。</p>
      </div>
    </template>
  </div>
</template>
