<script setup lang="ts">
import { computed, watch } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import LiftReport from '@/views/sub/LiftReport.vue'
import { craneSnOf } from '@/data/craneSn'
import { deviceSet } from '@/data/device'
import { useCraneReportStore } from '@/stores/craneReport'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useShellStore } from '@/stores/shell'
import { unitNo } from '@/utils/deviceLedger'
import {
  DASH,
  formatTons,
  formatWork,
  share,
  totals,
  workText,
  type ReportSpan,
  type UnitStats,
} from '@/utils/craneReport'
import { shareText } from '@/utils/share'
import { useSlowLoading } from '@/utils/slowLoading'
import type { DeviceKind } from '@/types'
import type { ReportUnit } from '@/stores/craneReport'

/**
 * 作业报表（设计稿 gx2 的「智能塔机 → 作业报表」页签）
 *
 * 结构照设计稿：粒度切换 → 区间 → 三格合计 → 结论 → 机队分台表 → 导出分享。
 * 数字全部来自**真实工作循环**（`api/towerCrane.ts` → `getWorkCycleInfoHis`），
 * 也就是 V2 桌面端报表用的那条链路（`CraneWorkCycleRequester`，取证见
 * docs/api-migration.md 第 13 节）。上一版这里靠 `DeviceUnit.history`（tsdb 实时
 * 接口，现场 404）派生，所以长期是空态。
 *
 * ## 与设计稿的两处刻意偏差（都不能照抄）
 *
 * ① **「平均利用率」「负荷」两格换成「作业时长」「峰值吊重」。**
 *    设计稿那两格是示意图占位；V2 报表界面也没有这两个指标 ——
 *    `UICraneHistoryPop` 只读工作循环，图表是「吊次 / 吊重」，列表行是
 *    「时间 · 时长 · 重量 · 幅度 · 角度 · 力矩」。现场没有任何接口能算出
 *    利用率（要台班排班）与负荷率（只有实时报文的 weightRate）。与其留一个
 *    永远写「—」的格子，不如换两个同样来自工作循环、且能逐条核验的量。
 *
 * ② **周报 / 月报按自然周、自然月，不是「近 7 天 / 近 21 天」。**
 *    照 V2 `UICraneHistoryPop.GetStartDate/GetEndDate`：周报是周一起到周日，
 *    月报是 1 号到月末。桌面端就是这么算的，报表要与它对得上就跟着它。
 *
 * 传统塔机5 没有平台编号（`data/craneSn.ts` 里明确为空），取不到工作循环 ——
 * 它那几格写「—」，并在结论里单列一条「未纳入统计」，不拿台账的功效顶替。
 *
 * ## 电梯不走这里
 *
 * 电梯的报表在 `views/sub/LiftReport.vue`：数据源是 IOT 的 `EVENT_WORKDATA`
 * 事件（V2 电梯历史弹层看的那份），按笼询 `sn`；塔机是 `:30400` 的工作循环
 * REST，按台询 `deviceSN`。两边 KPI 与表格列都不同（电梯没有吊重、也没有
 * 载重与利用率的累计源），硬塞进一个组件只会让它到处 `isCrane` 分叉。
 * 版式（pill → 区间 → 三格 → 结论 → 分台表 → 导出）两页共用同一套
 * `.report-*` 样式，看起来是一个系统。
 */
const props = defineProps<{ kind: DeviceKind }>()

const shell = useShellStore()
const ledger = useDeviceLedgerStore()
const report = useCraneReportStore()

const set = computed(() => deviceSet(props.kind))
const isCrane = computed(() => props.kind === 'crane')

/** 台账还没到（或用例里直接给空）时的同步态：先铺骨架，别急着下「没数据」的结论 */
const syncing = computed(() => !set.value.units.length && ledger.state === 'loading')

/**
 * 机组 → 查询参数。
 *
 * sn 不由台账给（`:8084` 没有这个字段），走 V2 场景里登记的编号表；
 * 台号从设备名首段数字取（智能塔机2 → 2）。传统塔机5 查不到登记 → null。
 */
const units = computed<ReportUnit[]>(() =>
  set.value.units.map((u) => ({
    id: u.id,
    sn: isCrane.value ? craneSnOf(unitNo(u.name)) : null,
  })),
)

/**
 * 台账可能比页签晚到（先点「作业报表」再等台账回来），所以盯住机组 id 集合：
 * 一到齐就按当前粒度查一次。`immediate` 负责首次进入页面。
 */
watch(
  () => units.value.map((u) => u.id).join(','),
  (key) => {
    if (key && isCrane.value) void report.load(units.value, report.span)
  },
  { immediate: true },
)

/** 机组 + 各自结果（报表状态与台账顺序对齐，缺数的机组也要占一行） */
interface Row {
  id: string
  name: string
  stats: UnitStats | null
}

const rows = computed<Row[]>(() =>
  set.value.units.map((u) => ({
    id: u.id,
    name: u.name,
    stats: report.rows.find((r) => r.id === u.id)?.stats ?? null,
  })),
)

/** 有没有任何一台取到数（0 吊次算取到；null 才是没取到） */
const hasData = computed(() => rows.value.some((r) => r.stats !== null))

/** 慢请求才显灰条：快请求闪一下反而更吵 */
const showSkel = useSlowLoading(() => syncing.value || (isCrane.value && !hasData.value && report.state === 'loading'))

const total = computed(() => totals(rows.value.map((r) => r.stats)))

/** 三格合计：值拆成「数字 + 单位」，与设计稿的 `<b>26<em>次</em></b>` 一致 */
const kpis = computed(() => {
  const work = formatWork(total.value.workSec)
  const weight = total.value.weight
  return [
    { label: '合计吊次', n: String(total.value.trips), u: '次' },
    { label: '合计吊重', n: weight === null ? DASH : weight.toFixed(2), u: weight === null ? '' : 't' },
    { label: '作业时长', n: work.n, u: work.u },
  ]
})

/** 机队表：列比设计稿少两个（利用率/负荷无源），换成峰值与时长 */
const FLEET_HEAD = ['塔机', '吊次', '吊重', '峰值', '时长']

const fleet = computed(() =>
  rows.value.map((r) => ({
    id: r.id,
    name: r.name,
    cells: r.stats
      ? [
          `${r.stats.trips}次`,
          formatTons(r.stats.weight),
          formatTons(r.stats.maxWeight),
          workText(r.stats.workSec),
        ]
      : [DASH, DASH, DASH, DASH],
  })),
)

/**
 * 结论：按数据挑重点。
 *
 * 设计稿的四条是「关注（利用率最低）/ 主力 / 产出 / 负荷」；利用率与负荷都
 * 没有源，这里换成同样可核验的「关注（吊次最少）/ 主力 / 产出 / 峰值」，
 * 另外把没纳入统计的机组单列一条 —— 缺一台车的合计必须说明白，否则
 * 「合计 72 次」会被读成全场的数。
 */
const points = computed<{ tag: string; warn?: boolean; text: string }[]>(() => {
  const has = rows.value.filter((r): r is Row & { stats: UnitStats } => r.stats !== null)
  const snOf = new Map(units.value.map((u) => [u.id, u.sn]))
  // 缺数分两种，文案不能混：没有平台编号是「永远查不了」，查询失败是「这次没拿到」
  const noSn = rows.value.filter((r) => r.stats === null && !snOf.get(r.id)).map((r) => r.name)
  const failed = rows.value.filter((r) => r.stats === null && snOf.get(r.id)).map((r) => r.name)
  const items: { tag: string; warn?: boolean; text: string }[] = []

  if (has.length) {
    const byTrips = [...has].sort((a, b) => b.stats.trips - a.stats.trips)
    const byWeight = [...has].filter((r) => r.stats.weight !== null).sort((a, b) => (b.stats.weight ?? 0) - (a.stats.weight ?? 0))
    const byPeak = [...has].filter((r) => r.stats.maxWeight !== null).sort((a, b) => (b.stats.maxWeight ?? 0) - (a.stats.maxWeight ?? 0))
    const busy = byTrips[0]
    const idle = byTrips[byTrips.length - 1]

    // 只有一台车时「最少的」和「最多的」是同一台，这条会读起来像废话
    if (has.length > 1) {
      items.push({
        tag: '关注',
        warn: true,
        text: `${idle.name} 吊次 ${idle.stats.trips}次，占 ${share(idle.stats.trips, total.value.trips)}%`,
      })
    }
    items.push({ tag: '主力', text: `${busy.name} 吊次 ${busy.stats.trips}次，占 ${share(busy.stats.trips, total.value.trips)}%` })
    if (byWeight.length) {
      const heavy = byWeight[0]
      items.push({
        tag: '产出',
        text: `${heavy.name} 吊重 ${formatTons(heavy.stats.weight)}，占 ${share(heavy.stats.weight ?? 0, total.value.weight ?? 0)}%`,
      })
    }
    if (byPeak.length) {
      items.push({ tag: '峰值', text: `${byPeak[0].name} 单次最重 ${formatTons(byPeak[0].stats.maxWeight)}，${has.length}台中最高` })
    }
  }

  if (noSn.length) items.push({ tag: '缺数', warn: true, text: `${noSn.join('、')} 无平台编号，未纳入统计` })
  if (failed.length) items.push({ tag: '缺数', warn: true, text: `${failed.join('、')} 数据查询失败，未纳入统计` })
  return items
})

const kindName = computed(() => ({ day: '日报', week: '周报', month: '月报' })[report.span])

function pick(next: ReportSpan): void {
  if (next === report.span && report.state !== 'empty') return
  if (!isCrane.value || !units.value.length) return
  void report.load(units.value, next)
}

/** 纯文本版：分享与下载用 */
const plainText = computed(() => {
  const lines = [
    `塔机${kindName.value} ${report.range.text}`,
    '向阳村项目',
    `合计吊次 ${total.value.trips}次，合计吊重 ${formatTons(total.value.weight)}，作业时长 ${workText(total.value.workSec)}`,
    '结论',
    ...points.value.map((p) => `${p.tag}：${p.text}`),
    '',
  ]
  for (const r of fleet.value) {
    const [trips, weight, peak, work] = r.cells
    lines.push(`${r.name} 吊次 ${trips}，吊重 ${weight}，峰值 ${peak}，时长 ${work}`)
  }
  return lines.join('\n')
})

async function onShare(): Promise<void> {
  const title = `${set.value.noun}${kindName.value} ${report.range.text}`
  const result = await shareText({
    title,
    text: plainText.value,
    fileName: `${set.value.noun}${kindName.value}-${report.range.text}.txt`,
  })
  if (result === 'shared') shell.showToast(`${kindName.value}已分享`, 'success')
  else if (result === 'downloaded') shell.showToast(`${kindName.value}已导出，并复制到剪贴板`, 'success')
}
</script>

<template>
  <!--
    台账 / 工作循环同步中：按报表的真实结构铺灰条（三格 KPI + 机队表行），
    结果到手后再决定出报表还是出下面的空态。
  -->
  <section
    v-if="isCrane && (syncing || (!hasData && report.state === 'loading'))"
    class="dev-block skel-fade"
    :class="{ 'is-on': showSkel }"
    aria-busy="true"
  >
    <span class="sr-only" role="status">正在加载{{ set.noun }}作业报表</span>
    <div aria-hidden="true">
      <div class="report-kpis">
        <div v-for="i in 3" :key="i" class="report-kpi">
          <Skel w="44px" h="10px" />
          <Skel w="52px" h="18px" r="var(--r-4)" />
        </div>
      </div>
      <div class="report-fleet">
        <div v-for="i in 5" :key="i" class="report-line">
          <Skel w="46px" h="13px" />
          <Skel w="30px" h="13px" />
          <Skel w="30px" h="13px" />
          <Skel w="30px" h="13px" />
          <Skel w="30px" h="13px" />
        </div>
      </div>
    </div>
  </section>

  <!-- 电梯是另一条数据源（IOT 事件 vs 塔机平台的工作循环 REST），字段也不同，单独一个组件 -->
  <LiftReport v-else-if="!isCrane" />

  <!-- 塔机一台车都没取到（接口不通 / 全部无编号）→ 明确空态 -->
  <section v-else-if="!hasData" class="dev-block">
    <div class="data-empty" data-empty="device-report">
      <p>暂无作业报表数据</p>
      <p class="data-empty-sub">未取到塔机工作循环数据：需要塔机平台接口可达，且设备有平台编号。</p>
    </div>
  </section>

  <section v-else class="dev-block fill-in">
    <div class="uav-tabs report-span">
      <button type="button" :class="{ on: report.span === 'day' }" :aria-pressed="report.span === 'day'" @click="pick('day')">日报</button>
      <button type="button" :class="{ on: report.span === 'week' }" :aria-pressed="report.span === 'week'" @click="pick('week')">周报</button>
      <button type="button" :class="{ on: report.span === 'month' }" :aria-pressed="report.span === 'month'" @click="pick('month')">月报</button>
    </div>

    <p class="report-date">{{ report.range.text }}</p>
    <div class="report-kpis">
      <div v-for="k in kpis" :key="k.label" class="report-kpi">
        <span>{{ k.label }}</span>
        <b :class="{ 'is-dash': k.n === DASH }">{{ k.n }}<em v-if="k.u">{{ k.u }}</em></b>
      </div>
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
        <b>{{ FLEET_HEAD[0] }}</b><span v-for="h in FLEET_HEAD.slice(1)" :key="h">{{ h }}</span>
      </div>
      <div v-for="r in fleet" :key="r.id" class="report-line">
        <b>{{ r.name }}</b>
        <span v-for="(c, i) in r.cells" :key="i" :class="{ 'is-dash': c === DASH }">{{ c }}</span>
      </div>
    </div>

    <button class="report-share" type="button" @click="onShare">导出分享</button>
  </section>
</template>
