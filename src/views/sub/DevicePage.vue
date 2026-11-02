<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import TouchChart from '@/components/ui/TouchChart.vue'
import { deviceSet } from '@/data/device'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { deviceTrendModel } from '@/utils/deviceChart'
import type { DeviceKind, DeviceMetric, DeviceUnit } from '@/types'

/**
 * 设备详情页（2026-10 版本同步 · 第四批）
 *
 * 智能塔机与智能电梯在设计稿里是两套几乎逐字相同的页面（原 renderCrane /
 * renderLift 各 300 行，差异只有指标名与几处措辞）。这里写成一份：
 * 数据由 data/device.ts 的 deviceSet(kind) 提供，页面只认结构。
 *
 * 三块内容与设计稿一致：
 *   ① 设备实时概览 —— 全部机组的卡片（状态、四个实时格、工作中的负荷条）
 *   ② 当日作业统计 —— 页签切机组；3~4 个「今日 vs 近7日均」对比条 + 1~2 组仪表
 *   ③ 历史作业分析 —— 近 7 / 30 日切换 × 机组页签 × 五张趋势图
 */
const props = defineProps<{ kind: DeviceKind }>()

const sheet = useBottomSheetStore()

const set = computed(() => deviceSet(props.kind))

/** 当前选中的机组（当日统计用） */
const tab = ref(set.value.units[0].id)
/** 趋势图选中的机组（与统计页签分开，设计稿也是两套页签） */
const chartTab = ref(set.value.units[0].id)
const range = ref<7 | 30>(7)

/** 切塔机 ↔ 电梯时回到第一台，否则会停在上一种设备的 id 上查不到数据 */
watch(
  () => props.kind,
  () => {
    tab.value = set.value.units[0].id
    chartTab.value = set.value.units[0].id
    range.value = 7
  },
)

const cur = computed(() => set.value.units.find((u) => u.id === tab.value) ?? set.value.units[0])
const chartUnit = computed(() => set.value.units.find((u) => u.id === chartTab.value) ?? set.value.units[0])

/** 状态色调：工作中/在线 → ok，待机/停止 → wait，离线 → off */
function tone(status: string): string {
  if (status === '工作中' || status === '在线') return 'is-ok'
  if (status === '待机' || status === '停止') return 'is-wait'
  return 'is-off'
}

/** 当日对比：今日值 vs 均值，涨跌百分比 */
function compareRows(u: DeviceUnit) {
  return set.value.compare.map((row) => {
    const today = u.today[row.key] ?? 0
    const avg = u.today[row.avgKey] ?? 0
    const delta = avg ? Math.round(((today - avg) / avg) * 100) : 0
    return {
      ...row,
      today,
      avg,
      delta,
      note: delta > 0 ? `↑+${delta}%` : delta < 0 ? `↓${delta}%` : '持平',
      /** 今日低于均值时进度条要按「今日/均值」缩，高于时用双色切分 */
      pct: delta > 0 ? 100 : avg ? Math.min(100, Math.round((today / avg) * 100)) : 0,
      cut: avg ? (avg / today) * 100 : 0,
    }
  })
}

/** 仪表里的数值单位：时长 h / 重量 t / 比例 %，按 key 推 */
function unitOf(key: string): string {
  if (key === 'util' || key === 'rate') return '%'
  if (key === 'avgWeight' || key === 'maxWeight') return 't'
  return 'h'
}

/** 仪表组：三行「标签 + 数值」+ 一条进度条 */
function meterRows(u: DeviceUnit) {
  return set.value.meters.map((g) => ({
    rows: g.rows.map((r) => {
      const v = u.today[r.key] ?? 0
      return {
        label: r.label,
        em: r.em,
        text: r.em ? `${Math.round(v)}%` : `${v.toFixed(1)}${unitOf(r.key)}`,
      }
    }),
    pct: Math.min(100, u.today[g.pctKey] ?? 0),
  }))
}

/** 五张趋势图 */
const charts = computed(() =>
  set.value.metrics.map((m: DeviceMetric) => ({
    metric: m,
    model: deviceTrendModel(chartUnit.value, m, range.value, `dev-${props.kind}-${m.key}`),
  })),
)
</script>

<template>
  <div class="dev-page">
    <!-- ① 设备实时概览 -->
    <section class="dev-block">
      <h4>设备实时概览</h4>
      <div class="dev-board">
        <article v-for="u in set.units" :key="u.id" class="dev-card">
          <div class="dev-card-hd">
            <strong>
              <SvgIcon :name="kind === 'crane' ? 'dev-crane' : 'dev-lift'" class="dev-mark" />
              <span>{{ u.name }}</span>
              <b class="dev-status" :class="tone(u.status)">{{ u.status }}</b>
            </strong>
            <button class="dev-link" type="button" @click="sheet.openDeviceInfo(kind, u.id)">
              设备信息
            </button>
          </div>

          <div class="dev-card-grid">
            <div v-for="[label, value] in u.cells" :key="label">
              <span>{{ label }}</span>
              <b :class="{ 'is-alarm': label === '报警次数' && value !== '0次' }">{{ value }}</b>
            </div>
          </div>

          <div v-if="u.live" class="dev-load">
            <div class="dev-load-hd">
              <span>当前吊重</span><b>{{ u.live.value }}</b>
              <span class="dev-load-rate">当前负荷</span><em>{{ u.live.pct }}%</em>
            </div>
            <div class="dev-bar"><i :style="{ width: u.live.pct + '%' }"></i></div>
          </div>
        </article>
      </div>
    </section>

    <!-- ② 当日作业统计 -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>当日作业统计</h4>
        <button class="dev-link" type="button" @click="sheet.openDeviceHistory(kind, cur.id)">
          历史数据
        </button>
      </div>

      <div class="dev-tabs">
        <button
          v-for="u in set.units"
          :key="u.id"
          type="button"
          :class="{ on: u.id === cur.id }"
          :aria-pressed="u.id === cur.id"
          @click="tab = u.id"
        >
          {{ u.tab }}
        </button>
      </div>

      <div class="dev-meters">
        <!-- 今日 vs 近 7 日均：条上分两色，超出均值的部分用橙色标出来 -->
        <div v-for="row in compareRows(cur)" :key="row.label" class="dev-meter">
          <div class="dev-meter-hd">
            <div class="dev-meter-lines">
              <div class="dev-meter-line"><span>{{ row.label }}</span><b>{{ row.today.toFixed(row.dp) }}</b><span>{{ row.unit }}</span></div>
              <div class="dev-meter-line"><span>近7日均</span><b>{{ row.avg.toFixed(row.dp) }}</b><span>{{ row.unit }}</span></div>
            </div>
            <em :class="row.delta > 0 ? 'is-over' : 'is-under'">{{ row.note }}</em>
          </div>
          <div class="dev-bar">
            <i
              :style="row.delta > 0
                ? { width: '100%', background: `linear-gradient(90deg, #2F7CFF 0 ${row.cut}%, #FF9A3C ${row.cut}% 100%)` }
                : { width: row.pct + '%' }"
            ></i>
          </div>
        </div>

        <!-- 组合仪表：三行数值 + 一条利用率/负荷率 -->
        <div v-for="(g, gi) in meterRows(cur)" :key="gi" class="dev-meter">
          <div class="dev-meter-hd">
            <div class="dev-meter-lines">
              <div v-for="r in g.rows" :key="r.label" class="dev-meter-line">
                <span>{{ r.label }}</span>
                <em v-if="r.em">{{ r.text }}</em>
                <b v-else>{{ r.text }}</b>
              </div>
            </div>
          </div>
          <div class="dev-bar"><i :style="{ width: g.pct + '%' }"></i></div>
        </div>
      </div>
    </section>

    <!-- ③ 历史作业分析 -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>历史作业分析</h4>
        <div class="dev-tabs is-compact">
          <button type="button" :class="{ on: range === 7 }" :aria-pressed="range === 7" @click="range = 7">近7日</button>
          <button type="button" :class="{ on: range === 30 }" :aria-pressed="range === 30" @click="range = 30">近30日</button>
        </div>
      </div>

      <div class="dev-tabs">
        <button
          v-for="u in set.units"
          :key="u.id"
          type="button"
          :class="{ on: u.id === chartUnit.id }"
          :aria-pressed="u.id === chartUnit.id"
          @click="chartTab = u.id"
        >
          {{ u.tab }}
        </button>
      </div>

      <div class="dev-charts">
        <div v-for="c in charts" :key="c.metric.key" class="dev-chart">
          <div class="dev-chart-hd">
            <span>{{ c.metric.name }}</span>
            <em class="dev-chart-unit">{{ c.metric.unit }}</em>
            <div class="dev-chart-leg">
              <span><i class="g"></i>每日</span>
              <span><i class="avg"></i>均值</span>
            </div>
          </div>
          <TouchChart :model="c.model" />
        </div>
      </div>
    </section>
  </div>
</template>
