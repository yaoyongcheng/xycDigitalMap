<script setup lang="ts">
import { computed, ref } from 'vue'

import { deviceSet } from '@/data/device'

/**
 * 设备历史数据（2026-10 版本同步 · 第四批）
 *
 * 原版这里是一个完整月历（histCalendar 手写 31 格）＋日期按钮。但可选的
 * 永远只有「昨天往前 7 天」—— 摆一个月历出来，其余 24 天全是不可点的灰格，
 * 徒增一次点击。改成 7 个日期胶囊：一眼看全可选范围，横排即可点。
 *
 * 内容与设计稿一致：所选日期的五项指标 + 那组利用率仪表。
 */
const props = defineProps<{ device: 'crane' | 'lift'; id: string }>()

const set = computed(() => deviceSet(props.device))
const unit = computed(() => set.value.units.find((u) => u.id === props.id) ?? set.value.units[0])

/** 选中的日期，默认最新一天（昨天） */
const date = ref(unit.value.history[0].date)

const day = computed(() => unit.value.history.find((d) => d.date === date.value) ?? unit.value.history[0])

const rows = computed(() =>
  set.value.metrics.map((m) => ({
    name: m.name,
    text: (day.value.vals[m.key] ?? 0).toFixed(m.dp) + m.unit,
  })),
)

/** 利用率/负荷率单独画条 —— 百分比读数光看数字感受不到差距 */
const bars = computed(() =>
  set.value.metrics
    .filter((m) => m.unit === '%')
    .map((m) => ({ name: m.name, pct: Math.min(100, day.value.vals[m.key] ?? 0) })),
)
</script>

<template>
  <div>
    <!-- 设备名由弹层副标题给，这里只说可选范围 -->
    <p class="uav-lab">近 7 天（不含今日）</p>

    <div class="dev-dates">
      <button
        v-for="d in unit.history"
        :key="d.date"
        type="button"
        :class="{ on: d.date === date }"
        :aria-pressed="d.date === date"
        @click="date = d.date"
      >
        {{ d.date.slice(3) }}日
      </button>
    </div>

    <div class="dev-info">
      <div v-for="r in rows" :key="r.name" class="dev-info-row">
        <span>{{ r.name }}</span><b>{{ r.text }}</b>
      </div>
    </div>

    <div class="dev-meters">
      <div v-for="b in bars" :key="b.name" class="dev-meter">
        <div class="dev-meter-hd">
          <div class="dev-meter-lines">
            <div class="dev-meter-line"><span>{{ b.name }}</span><em>{{ b.pct }}%</em></div>
          </div>
        </div>
        <div class="dev-bar"><i :style="{ width: b.pct + '%' }"></i></div>
      </div>
    </div>
  </div>
</template>
