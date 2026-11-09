<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { deviceSet } from '@/data/device'
import { useShellStore } from '@/stores/shell'
import { addDays, dateKey, protoToday } from '@/utils/date'
import { deviceMonthRows } from '@/utils/deviceChart'
import { shareText } from '@/utils/share'
import type { DeviceKind, DeviceUnit } from '@/types'

/**
 * 作业报表（2026-11 设计稿 gx2 版，原 renderCraneReport 2307-2450 / renderLiftReport）
 *
 * 设备详情页「作业报表」页签的内容：日报/周报/月报三粒度 +
 * 三个合计 KPI + 结论（按数据挑重点）+ 机队分台表 + 导出分享。
 * 与旧版「日报子页」的区别：报表不再是独立子页，而是详情页里的一个页签
 * （设计稿把 nav 的 #btnCraneReport 入口一并移除了）。
 *
 * 口径：
 *   日报   最新一天（= 昨天，历史数据不含今日）
 *   周报   history 7 天合计（原 craneSpanRows(craneHistoryRows)）
 *   月报   近 21 天（不含今日），7 天真数据 + 稳定派生值补齐
 */
const props = defineProps<{ kind: DeviceKind }>()

const shell = useShellStore()
const set = computed(() => deviceSet(props.kind))

type Span = 'day' | 'week' | 'month'
const span = ref<Span>('day')
watch(
  () => props.kind,
  () => {
    span.value = 'day'
  },
)

/** 年份前缀（历史/月度行存的是 'MM-DD'） */
const year = protoToday().getFullYear()

/** 两种设备各自的报表键：机队表与结论都只认这几个键 */
const KEYS: Record<DeviceKind, string[]> = {
  crane: ['trips', 'weight', 'util', 'rate'],
  lift: ['trips', 'load', 'util', 'people'],
}

interface Row {
  id: string
  name: string
  alarm: string
  vals: Record<string, number>
}

/** 汇总一组按日行：次数/载重求和，利用率与负荷取平均（原 craneSpan） */
function spanOf(rows: Record<string, number>[]): Record<string, number> {
  const n = rows.length || 1
  const out: Record<string, number> = {}
  for (const key of ['trips', 'weight', 'load', 'people']) {
    if (rows[0]?.[key] != null) out[key] = rows.reduce((s, r) => s + (r[key] ?? 0), 0)
  }
  for (const key of ['util', 'rate']) {
    if (rows[0]?.[key] != null) out[key] = Math.round(rows.reduce((s, r) => s + (r[key] ?? 0), 0) / n)
  }
  return out
}

function extreme(rows: Row[], key: string, high: boolean): Row {
  return [...rows].sort((a, b) => (high ? b.vals[key] - a.vals[key] : a.vals[key] - b.vals[key]))[0]
}

function share(part: number, total: number): number {
  return total ? Math.round((part / total) * 100) : 0
}

/** 当前粒度下每台的行（含警报文案，day 才带） */
const rows = computed<Row[]>(() => {
  const units: DeviceUnit[] = set.value.units
  if (span.value === 'day') {
    return units.map((u) => ({ id: u.id, name: u.name, alarm: u.alarms ?? '', vals: { ...u.history[0].vals } }))
  }
  return units.map((u) => {
    const src =
      span.value === 'week'
        ? u.history.map((d) => d.vals)
        : deviceMonthRows(u, KEYS[props.kind]).map((r) => r.vals)
    return { id: u.id, name: u.name, alarm: '', vals: spanOf(src) }
  })
})

/** 报表区间文案 */
const rangeText = computed(() => {
  if (span.value === 'day') return dateKey(addDays(protoToday(), -1))
  if (span.value === 'week') {
    const h = set.value.units[0].history
    return `${year}-${h[h.length - 1].date} 至 ${year}-${h[0].date}`
  }
  const m = deviceMonthRows(set.value.units[0], KEYS[props.kind])
  return `${year}-${m[0].date} 至 ${year}-${m[m.length - 1].date}`
})

const kpis = computed(() => {
  const isCrane = props.kind === 'crane'
  const trips = rows.value.reduce((s, r) => s + r.vals.trips, 0)
  const wKey = isCrane ? 'weight' : 'load'
  const weight = Math.round(rows.value.reduce((s, r) => s + (r.vals[wKey] ?? 0), 0) * 100) / 100
  const util = Math.round(rows.value.reduce((s, r) => s + r.vals.util, 0) / rows.value.length)
  return { isCrane, trips, weight, util }
})

/** 结论条目（原 craneConclusions / liftConclusions，按数据挑重点） */
const points = computed<{ tag: string; warn?: boolean; text: string }[]>(() => {
  const rs = rows.value
  const n = rs.length
  if (props.kind === 'crane') {
    const low = extreme(rs, 'util', false)
    const busy = extreme(rs, 'trips', true)
    const heavy = extreme(rs, 'weight', true)
    const loaded = extreme(rs, 'rate', true)
    const trips = rs.reduce((s, r) => s + r.vals.trips, 0)
    const weight = rs.reduce((s, r) => s + r.vals.weight, 0)
    let focus = `${low.name} 利用率 ${low.vals.util}%`
    if (low.alarm && low.alarm !== '0次') focus += ` · 报警 ${low.alarm}`
    const others = rs.filter((r) => r !== low && r.alarm && r.alarm !== '0次')
    if (others.length) focus += ` · ${others.map((r) => `${r.name}报警 ${r.alarm}`).join('，')}`
    if (!others.length && (!low.alarm || low.alarm === '0次')) focus += `，${n}台最低`
    return [
      { tag: '关注', warn: true, text: focus },
      { tag: '主力', text: `${busy.name} 吊次 ${busy.vals.trips}次，占 ${share(busy.vals.trips, trips)}%` },
      { tag: '产出', text: `${heavy.name} 吊重 ${heavy.vals.weight.toFixed(2)}t，占 ${share(heavy.vals.weight, weight)}%` },
      { tag: '负荷', text: `${loaded.name} ${loaded.vals.rate}%，${n}台最高` },
    ]
  }
  // 电梯（原 liftConclusions）
  const low = extreme(rs, 'util', false)
  const busy = extreme(rs, 'trips', true)
  const riders = extreme(rs, 'people', true)
  const heavy = extreme(rs, 'load', true)
  const trips = rs.reduce((s, r) => s + r.vals.trips, 0)
  const people = rs.reduce((s, r) => s + r.vals.people, 0)
  const load = rs.reduce((s, r) => s + r.vals.load, 0)
  const same = busy.id === riders.id && busy.id === heavy.id
  const offline = set.value.units.filter((u) => u.status === '离线').map((u) => u.tab)
  const items: { tag: string; warn?: boolean; text: string }[] = [
    { tag: '关注', warn: true, text: `${low.name} 利用率 ${low.vals.util}%，${n}台最低` },
    {
      tag: '主力',
      text: same
        ? `${busy.name} 循环占 ${share(busy.vals.trips, trips)}% · 运送占 ${share(riders.vals.people, people)}% · 载重占 ${share(heavy.vals.load, load)}%`
        : `${busy.name} 循环 ${busy.vals.trips}次，占 ${share(busy.vals.trips, trips)}%`,
    },
    { tag: '短板', warn: true, text: `${low.name} 循环 ${low.vals.trips}次，只占 ${share(low.vals.trips, trips)}%` },
  ]
  if (!same && riders.id !== busy.id) {
    items.push({ tag: '运送', text: `${riders.name} ${riders.vals.people}人，占 ${share(riders.vals.people, people)}%` })
  }
  if (offline.length) items.push({ tag: '当前', warn: true, text: `${offline.join('、')} 离线` })
  return items.slice(0, 4)
})

/** 机队表头与行（原 craneFleetLines / liftFleetLines） */
const fleet = computed(() => {
  const isCrane = props.kind === 'crane'
  const head = isCrane ? ['塔机', '吊次', '吊重', '利用率', '负荷'] : ['电梯', '循环', '载重', '利用率', '运送']
  const body = rows.value.map((r) => ({
    id: r.id,
    name: r.name,
    alarm: span.value === 'day' && r.alarm && r.alarm !== '0次' ? r.alarm : '',
    cells: isCrane
      ? [`${r.vals.trips}次`, `${r.vals.weight.toFixed(2)}t`, `${r.vals.util}%`, `${r.vals.rate}%`]
      : [`${r.vals.trips}次`, `${r.vals.load.toFixed(2)}t`, `${r.vals.util}%`, `${Math.round(r.vals.people)}人`],
  }))
  return { head, body }
})

const kindName = computed(() => ({ day: '日报', week: '周报', month: '月报' })[span.value])

/** 纯文本版：分享与下载用（原 craneReportPlain/liftReportPlain 的结构） */
const plainText = computed(() => {
  const lines = [
    `${set.value.noun}${kindName.value} ${rangeText.value}`,
    '向阳村项目',
    `${kpis.value.isCrane ? '合计吊次' : '合计循环'} ${kpis.value.trips}次，${kpis.value.isCrane ? '合计吊重' : '合计载重'} ${kpis.value.weight}t，平均利用率 ${kpis.value.util}%`,
    '结论',
    ...points.value.map((p) => `${p.tag}：${p.text}`),
    '',
  ]
  for (const r of fleet.value.body) {
    const labels = fleet.value.head.slice(1)
    lines.push(`${r.name} ${r.cells.map((c, i) => `${labels[i]} ${c}`).join('，')}`)
  }
  return lines.join('\n')
})

async function onShare(): Promise<void> {
  const title = `${set.value.noun}${kindName.value} ${rangeText.value}`
  const result = await shareText({
    title,
    text: plainText.value,
    fileName: `${set.value.noun}${kindName.value}-${rangeText.value}.txt`,
  })
  if (result === 'shared') shell.showToast(`${kindName.value}已分享`, 'success')
  else if (result === 'downloaded') shell.showToast(`${kindName.value}已导出，并复制到剪贴板`, 'success')
}
</script>

<template>
  <section class="dev-block">
    <div class="uav-tabs report-span">
      <button type="button" :class="{ on: span === 'day' }" :aria-pressed="span === 'day'" @click="span = 'day'">日报</button>
      <button type="button" :class="{ on: span === 'week' }" :aria-pressed="span === 'week'" @click="span = 'week'">周报</button>
      <button type="button" :class="{ on: span === 'month' }" :aria-pressed="span === 'month'" @click="span = 'month'">月报</button>
    </div>

    <p class="report-date">{{ rangeText }}</p>
    <div class="report-kpis">
      <div class="report-kpi"><span>{{ kpis.isCrane ? '合计吊次' : '合计循环' }}</span><b>{{ kpis.trips }}<em>次</em></b></div>
      <div class="report-kpi"><span>{{ kpis.isCrane ? '合计吊重' : '合计载重' }}</span><b>{{ kpis.weight }}<em>t</em></b></div>
      <div class="report-kpi"><span>平均利用率</span><b>{{ kpis.util }}<em>%</em></b></div>
    </div>

    <div class="report-judge">
      <p>结论</p>
      <ul class="report-points">
        <li v-for="p in points" :key="p.tag" :class="{ 'is-warn': p.warn }">
          <b>{{ p.tag }}</b><span>{{ p.text }}</span>
        </li>
      </ul>
    </div>

    <div class="report-fleet">
      <div class="report-line is-hd">
        <b>{{ fleet.head[0] }}</b><span v-for="h in fleet.head.slice(1)" :key="h">{{ h }}</span>
      </div>
      <div v-for="r in fleet.body" :key="r.id" class="report-line">
        <b>{{ r.name }}<em v-if="r.alarm">报警 {{ r.alarm }}</em></b>
        <span v-for="(c, i) in r.cells" :key="i">{{ c }}</span>
      </div>
    </div>

    <button class="report-share" type="button" @click="onShare">导出分享</button>
  </section>
</template>
