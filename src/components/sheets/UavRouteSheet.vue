<script setup lang="ts">
import { computed, ref } from 'vue'

import { uavRoutes } from '@/data/device'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useShellStore } from '@/stores/shell'

/**
 * 选择航线（2026-10 版本同步 · 第四批，原 openUavDispatch）
 *
 * 航线选中态与「下发执行」按钮上的航线名同源 —— 选了哪条、按下去会发哪条，
 * 按钮上直接写出来，不靠用户记。
 */
const sheet = useBottomSheetStore()
const shell = useShellStore()

const route = ref(uavRoutes[0].id)

const cur = computed(() => uavRoutes.find((r) => r.id === route.value) ?? uavRoutes[0])

function send(): void {
  shell.showToast(`已下发航线：${cur.value.name}`, 'success')
  sheet.close()
}
</script>

<template>
  <div>
    <p class="uav-lab">选择既有航线，远程下发执行</p>

    <div class="uav-routes">
      <button
        v-for="r in uavRoutes"
        :key="r.id"
        type="button"
        :class="{ on: route === r.id }"
        :aria-pressed="route === r.id"
        @click="route = r.id"
      >
        <strong>{{ r.name }}</strong>
        <span>{{ r.meta }}</span>
      </button>
    </div>

    <button class="uav-send" type="button" @click="send">下发执行 · {{ cur.name }}</button>
  </div>
</template>
