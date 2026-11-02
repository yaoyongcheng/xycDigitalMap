<script setup lang="ts">
import { computed } from 'vue'

import { deviceSet } from '@/data/device'
import { useShellStore } from '@/stores/shell'
import { addDays, dateKey, protoToday } from '@/utils/date'
import { shareText } from '@/utils/share'
import type { DeviceKind } from '@/types'

/**
 * 设备日报（2026-10 版本同步 · 第四批，原 js/app.js:1828-1932 / 1266-1330）
 *
 * 塔机与电梯的日报结构一致，只换指标名与措辞：
 *   ① 昨日作业总结 —— 日期 + 三个合计 + 三句结论
 *   ② 昨日分台作业 —— 每台一段，带同比涨跌
 *   ③ 导出分享
 *
 * 结论句不是模板填空，而是按数据挑重点：最高吊次与最高载重是不是同一台、
 * 哪台利用率最低。数据变了结论就跟着变，不会出现「三台全部离线，
 * 日报还在夸某台效率高」。
 *
 * 同比口径取「昨日 vs 近 7 日均」：分母是每台设备自己的周均值字段
 * （today.weekXxx），不是所有设备的平均 —— 拿全队均值衡量单台，
 * 大机器永远显示上涨，报表就没意义了。
 */
const props = defineProps<{ kind: DeviceKind }>()

const shell = useShellStore()
const set = computed(() => deviceSet(props.kind))

/** 昨日：历史数据最新一条就是昨天 */
const dateText = computed(() => dateKey(addDays(protoToday(), -1)))

/** 载重/吊重的字段名两套设备不同 */
const weightKey = computed(() => (props.kind === 'crane' ? 'weight' : 'load'))

function deltaOf(value: number, avg: number): { note: string; cls: string } {
  const pct = avg ? Math.round(((value - avg) / avg) * 100) : 0
  if (!pct) return { note: '持平', cls: 'is-flat' }
  return { note: `${pct > 0 ? '↑+' : '↓'}${Math.abs(pct)}%`, cls: pct > 0 ? 'is-over' : 'is-under' }
}

interface ReportRow {
  id: string
  name: string
  alarms?: string
  vals: Record<string, number>
  notes: Record<string, { note: string; cls: string }>
}

const rows = computed<ReportRow[]>(() =>
  set.value.units.map((u) => {
    const vals = u.history[0].vals
    const notes: ReportRow['notes'] = {}
    for (const key of ['trips', weightKey.value, 'time', 'people', 'util']) {
      if (vals[key] == null) continue
      const avgKey = 'week' + key[0].toUpperCase() + key.slice(1)
      const avg =
        u.today[avgKey] ??
        u.history.reduce((s, d) => s + (d.vals[key] ?? 0), 0) / u.history.length
      notes[key] = deltaOf(vals[key], avg)
    }
    return { id: u.id, name: u.name, alarms: u.alarms, vals, notes }
  }),
)

const sum = (key: string): number => rows.value.reduce((s, r) => s + (r.vals[key] ?? 0), 0)

const totals = computed(() => ({
  trips: sum('trips'),
  weight: Math.round(sum(weightKey.value) * 100) / 100,
  util: Math.round(rows.value.reduce((s, r) => s + (r.vals.util ?? 0), 0) / rows.value.length),
}))

const notes = computed<string[]>(() => {
  const n = set.value.units.length
  const byTrips = [...rows.value].sort((a, b) => b.vals.trips - a.vals.trips)
  const byLoad = [...rows.value].sort((a, b) => (b.vals[weightKey.value] ?? 0) - (a.vals[weightKey.value] ?? 0))
  const byUtil = [...rows.value].sort((a, b) => a.vals.util - b.vals.util)
  const top = byTrips[0]
  const heavy = byLoad[0]
  const low = byUtil[0]
  const w = (v: number) => v.toFixed(2)

  const lead =
    heavy.id === top.id
      ? `${top.name}${props.kind === 'crane' ? '吊次和吊重' : '循环次数和载重'}都是${n}台里最高，${props.kind === 'crane' ? `吊次 ${top.vals.trips}次，吊重 ${w(top.vals[weightKey.value])}t` : `循环 ${top.vals.trips}次，载重 ${w(top.vals[weightKey.value])}t`}。`
      : `${top.name}${props.kind === 'crane' ? '累计吊次' : '循环次数'}最高，为 ${top.vals.trips}次；${heavy.name}${props.kind === 'crane' ? '吊重' : '载重'}最高，为 ${w(heavy.vals[weightKey.value])}t。`

  return [
    `昨日 ${n} 台${props.kind === 'crane' ? '塔机' : '电梯'}均有${props.kind === 'crane' ? '作业' : '运行'}，合计${props.kind === 'crane' ? '吊次' : '循环次数'} ${totals.value.trips} 次，合计${props.kind === 'crane' ? '吊重' : '载重'} ${totals.value.weight}t，平均利用率 ${totals.value.util}%。`,
    lead,
    `${low.name}时长利用率最低，为 ${low.vals.util}%，${props.kind === 'crane' ? `有效工作 ${(low.vals.work ?? 0).toFixed(1)}h` : `运行 ${(low.vals.time ?? 0).toFixed(1)}h`}，${props.kind === 'crane' ? `吊重负荷率 ${low.vals.rate ?? 0}%` : `循环 ${low.vals.trips}次`}。`,
  ]
})

/** 分台卡片的行：两种设备的指标不同 */
const cardRows = computed(() => {
  const keys: { key: string; label: string; dp: number; unit: string }[] =
    props.kind === 'crane'
      ? [
          { key: 'trips', label: '累计吊次', dp: 0, unit: '次' },
          { key: 'weight', label: '累计吊重', dp: 2, unit: 't' },
          { key: 'util', label: '时长利用率', dp: 0, unit: '%' },
          { key: 'rate', label: '吊重负荷率', dp: 0, unit: '%' },
          { key: 'work', label: '有效工作', dp: 1, unit: 'h' },
        ]
      : [
          { key: 'trips', label: '循环次数', dp: 0, unit: '次' },
          { key: 'load', label: '累计载重', dp: 2, unit: 't' },
          { key: 'people', label: '运送人数', dp: 0, unit: '人' },
          { key: 'util', label: '时长利用率', dp: 0, unit: '%' },
          { key: 'time', label: '运行时长', dp: 1, unit: 'h' },
        ]

  return rows.value.map((r) => ({
    id: r.id,
    name: r.name,
    alarms: r.alarms,
    cells: keys
      .filter((k) => r.vals[k.key] != null)
      .map((k) => ({
        label: k.label,
        text: (r.vals[k.key] ?? 0).toFixed(k.dp) + k.unit,
        note: r.notes[k.key]?.note ?? '',
        cls: r.notes[k.key]?.cls ?? '',
      })),
  }))
})

/** 纯文本版：分享与下载用，结构跟着页面走（总结 → 分台） */
const plainText = computed(() => {
  const lines = [
    `${set.value.reportTitle} ${dateText.value}`,
    '向阳村项目',
    '',
    '昨日作业总结',
    ...notes.value,
    '',
    '昨日分台作业',
  ]
  for (const row of cardRows.value) {
    const body = row.cells.map((c) => `${c.label} ${c.text}${c.note ? `（${c.note}）` : ''}`).join('，')
    lines.push(`${row.name}：${body}。`)
  }
  return lines.join('\n')
})

async function onShare(): Promise<void> {
  const title = `${set.value.reportTitle} ${dateText.value}`
  const result = await shareText({
    title,
    text: plainText.value,
    fileName: `${set.value.reportTitle}-${dateText.value}.txt`,
  })
  if (result === 'shared') shell.showToast('日报已分享', 'success')
  else if (result === 'downloaded') shell.showToast('日报已导出，并复制到剪贴板', 'success')
  // cancelled：用户自己关掉了分享面板，不提示
}
</script>

<template>
  <div class="dev-page">
    <section class="dev-block">
      <h4>昨日作业总结</h4>
      <p class="report-date">{{ dateText }} · 向阳村项目</p>

      <div class="report-kpis">
        <div class="report-kpi"><span>{{ kind === 'crane' ? '合计吊次' : '合计循环' }}</span><b>{{ totals.trips }}<em>次</em></b></div>
        <div class="report-kpi"><span>{{ kind === 'crane' ? '合计吊重' : '合计载重' }}</span><b>{{ totals.weight }}<em>t</em></b></div>
        <div class="report-kpi"><span>平均利用率</span><b>{{ totals.util }}<em>%</em></b></div>
      </div>

      <p v-for="(text, i) in notes" :key="i" class="report-note">{{ text }}</p>
    </section>

    <section class="dev-block">
      <h4>昨日分台作业</h4>
      <article v-for="row in cardRows" :key="row.id" class="report-card">
        <div class="report-card-hd">
          <strong>{{ row.name }}</strong>
          <em v-if="row.alarms && row.alarms !== '0次'" class="is-alarm">报警 {{ row.alarms }}</em>
        </div>
        <div class="report-rows">
          <div v-for="c in row.cells" :key="c.label">
            <span>{{ c.label }}</span>
            <b>{{ c.text }}<i v-if="c.note" :class="c.cls">{{ c.note }}</i></b>
          </div>
        </div>
      </article>
    </section>

    <section class="dev-block report-actions">
      <button class="report-share" type="button" @click="onShare">导出分享</button>
    </section>
  </div>
</template>
