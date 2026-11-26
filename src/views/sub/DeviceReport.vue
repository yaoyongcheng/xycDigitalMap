<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'

import BarChart from '@/components/ui/BarChart.vue'
import ReportPeriod from '@/components/ui/ReportPeriod.vue'
import Skel from '@/components/ui/Skel.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { craneSnOf } from '@/data/craneSn'
import { deviceSet } from '@/data/device'
import { useCraneReportStore } from '@/stores/craneReport'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useShellStore } from '@/stores/shell'
import { camStampBrief } from '@/utils/date'
import { unitNo } from '@/utils/deviceLedger'
import { isWeChatBrowser } from '@/utils/env'
import {
  analyze,
  DASH,
  formatTons,
  minutesOf,
  peakHourText,
  percentText,
  type ReportSpan,
  type UnitStats,
} from '@/utils/craneReport'
import {
  canShareFile,
  downloadReportImage,
  reportImageFile,
  shareReportImage,
  type ReportImageData,
} from '@/utils/reportImage'
import { useSlowLoading } from '@/utils/slowLoading'
import type { DeviceKind } from '@/types'
import type { ReportUnit } from '@/stores/craneReport'

/**
 * 作业报表（「智能塔机 → 作业报表」页签）
 *
 * ## 版式（2026-11-25 对齐标准版）
 *
 *   粒度 pill（周报 / 月报 —— 日报与「全场」聚合视角 2026-11-25 按现场要求去掉）
 *   周期芯片（本周/本月 + 选日期：周列表 / 月网格）
 *   机组切换（每台，默认第一台）
 *   数据统计（6 格）
 *   作业风险分析（高峰 / 夜间 / 超重三卡，**不带「分析建议」那段文字**）
 *   分布可视化（时段 / 载荷 / 时长三张柱状图）
 *   导出分享（= 当前页面的长图，走分享 / 下载）
 *
 * 「机队对比」分台表 2026-11-25 按现场要求下线 —— 机组页签已经能逐台看，
 * 一屏里再摆一张五行表既挤又重复。
 *
 * ## 数据只有一条源
 *
 * 全部来自 `api/towerCrane.ts` 的 `getWorkCycleInfoHis`（V2 的
 * `CraneWorkCycleRequester`），没有第二套接口、没有占位数字：
 *   · 6 格里每一项都由工作循环明细算出（合计 / 均值 / 峰值）；
 *   · 三张分布图按每条循环的开始小时、最大吊重、时长分箱；
 *   · 夜间作业 = 22–5 时的循环数；超重 = 单次吊重 ≥ 额定 5t 的次数。
 *
 * 「平均载荷利用率」= 平均单次吊重 ÷ 额定 5t —— 与实时卡「当前负荷」
 * （`utils/craneLoad.ts`）同一条口径，可逐条核验，不是平台另算的字段。
 *
 * ## 机组切换的语义
 *
 * 一进页面就是第一台车（这台有数就是这台）。6 格、三卡、三张图都只算
 * 当前这一台；换台就看另一台的分布，不需要再滚到下面找表格。
 *
 * ## 导出分享 = 长图
 *
 * 2026-11-25 现场改定：这个按钮不再导 .txt，而是把**当前报表**画成一张
 * 长图（头部 / 6 格 / 三卡 / 三图 / 页脚），绘制见 `utils/reportImage.ts`。
 * 同日补齐两个访问入口（桌面书签 / 手机系统浏览器）与一条微信内的兜底：
 *
 *   1. 支持文件分享 → `navigator.share({files})`，面板里选微信或「存储图像」；
 *   2. 不支持 → 直接落 PNG 文件（桌面进下载目录），并明确提示；
 *   3. 微信内置浏览器 → 没有面板、也不吃 `a[download]`，把图摆到页面上长按保存。
 *
 * 为避开 iOS「分享面板必须在用户手势里调用」的限制，数据一变就预生成一次
 * （debounce），点按钮时同步交付已备好的文件。
 */
const props = defineProps<{ kind: DeviceKind }>()

const shell = useShellStore()
const ledger = useDeviceLedgerStore()
const report = useCraneReportStore()

const set = computed(() => deviceSet(props.kind))

/** 台账还没到（或用例里直接给空）时的同步态：先铺骨架，别急着下「没数据」的结论 */
const syncing = computed(() => !set.value.units.length && ledger.state === 'loading')

/**
 * 机组 → 查询参数。
 *
 * sn 不由台账给（`:8084` 没有这个字段），走 V2 场景里登记的编号表；
 * 台号从设备名首段数字取（`2#楼-智能塔机2` → 2；展示名自带楼栋前缀不影响取号）。
 */
const units = computed<ReportUnit[]>(() =>
  set.value.units.map((u) => ({
    id: u.id,
    sn: craneSnOf(unitNo(u.name)),
  })),
)

/**
 * 台账可能比页签晚到（先点「作业报表」再等台账回来），所以盯住机组 id 集合：
 * 一到齐就按当前粒度查一次。`immediate` 负责首次进入页面。
 *
 * ## 两个守卫是 2026-11-26 补的（「点重试后多出塔机请求」）
 *
 * 原来 key 直接取 `units` 的 id 串，不看机种。而 `DevicePage` 是塔机/电梯共用
 * 的同一个实例，页面从塔机切到电梯时：`props.kind` 先变 → `units` 跟着变成
 * **电梯**的机组 → 而 `DeviceReport` 要到同一次 patch 才被卸载。watch 的 pre
 * 回调赶在卸载之前跑，于是拿电梯机组又去调 `report.load()` —— 只要 `craneSnOf`
 * 能从电梯楼栋号里解出编号，就是货真价实的一轮 `getWorkCycleInfoHis`。
 *
 * 现在：
 *   · key 里带机种 —— 非塔机恒为空串，`if (!key)` 直接不放行；
 *   · `alive` —— 卸载之后即使还有排队中的 flush，也不再发请求。
 *
 * 这两条一起，保证「电梯页做任何事（包括点重试）」都不会冒出塔机接口。
 */
let alive = true
onBeforeUnmount(() => {
  alive = false
})

const reportKey = computed(() =>
  props.kind === 'crane' ? units.value.map((u) => u.id).join(',') : '',
)

watch(
  reportKey,
  (key) => {
    if (!alive || !key) return
    void report.load(units.value, report.span, report.anchor)
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

/* ---------------- 机组切换 ---------------- */

/**
 * 页签文案：`2#楼-智能塔机2` → `2#楼-塔机2`。
 *
 * 现场按「几号楼 + 几号塔机」叫设备，页签位置只放得下这个长度；
 * 台账与设备卡仍用完整名（`2#楼-智能塔机2`），这里只做展示层缩写，
 * 与 `utils/deviceLedger.ts::DISPLAY_NAMES` 是同一层的文案处理。
 */
function tabLabel(name: string): string {
  return name.replace('智能塔机', '塔机')
}

const picked = ref<string>('')

const devices = computed(() =>
  set.value.units.map((u) => ({ id: u.id, name: tabLabel(u.name) })),
)

/** 默认第一台；台账刷新后选中的那台不在了就落到新的第一台（不留空页签） */
watch(
  () => (props.kind === 'crane' ? units.value.map((u) => u.id).join(',') : ''),
  () => {
    // 切到电梯的那一帧 key 会变空，此时 units 已是别家的机组 —— 不能拿它覆盖选中态
    if (props.kind !== 'crane') return
    if (!units.value.some((u) => u.id === picked.value)) picked.value = units.value[0]?.id ?? ''
  },
  { immediate: true },
)

const pickedName = computed(() => set.value.units.find((u) => u.id === picked.value)?.name ?? '')

/** 当前机组的原始明细 */
const focusCycles = computed(() => report.series.find((s) => s.id === picked.value)?.cycles ?? [])

const analysis = computed(() => analyze(focusCycles.value))

/** 当前机组的汇总（不再有「全场相加」这一档） */
const stats = computed<UnitStats | null>(
  () => rows.value.find((r) => r.id === picked.value)?.stats ?? null,
)

/**
 * 选中单台、而这台没取到数（无编号 / 请求失败）。
 *
 * 这时 6 格全是「—」，但风险卡与分布图如果不拦，会显示「本期无吊次 0次」
 * —— 那是「确实没吊」的结论，与「没取到」完全是两件事。整块换成一句说明。
 */
const focusEmpty = computed(() => stats.value === null)

/** 慢请求才显灰条：快请求闪一下反而更吵 */
const showSkel = useSlowLoading(() => syncing.value || (!hasData.value && report.state === 'loading'))

/* ---------------- 数据统计（6 格） ---------------- */

const kpis = computed(() => {
  const s = stats.value
  const a = analysis.value
  const tons = (v: number | null): { n: string; u: string } =>
    v === null ? { n: DASH, u: '' } : { n: v.toFixed(2), u: 't' }
  const weight = tons(s?.weight ?? null)
  const peak = tons(s?.maxWeight ?? null)
  const avg = tons(a.avgWeight)
  return [
    { label: '累计吊次', n: s ? String(s.trips) : DASH, u: s ? '次' : '' },
    { label: '累计吊重', ...weight },
    { label: '峰值载荷', ...peak },
    { label: '平均载荷', ...avg },
    { label: '平均作业时长', n: minutesOf(a.avgDurSec), u: a.avgDurSec === null ? '' : '分' },
    { label: '平均载荷利用率', n: a.utilPct === null ? DASH : a.utilPct.toFixed(1), u: a.utilPct === null ? '' : '%' },
  ]
})

/* ---------------- 作业风险分析（三卡，无「分析建议」） ---------------- */

const risks = computed(() => {
  const a = analysis.value
  const peak = peakHourText(a.peakHours)
  const maxTon = formatTons(a.overMax)
  return [
    {
      key: 'peak',
      tone: 'is-peak',
      icon: 'report-peak' as const,
      label: '作业高峰时段',
      text: peak ? `${peak} 共 ${a.peakCount} 次` : '本期无吊次',
      value: `${a.peakCount}次`,
      alert: false,
    },
    {
      key: 'night',
      tone: 'is-night',
      icon: 'report-night' as const,
      label: '夜间作业',
      text: `22–5时 ${a.night}次占 ${percentText(a.nightPct)}`,
      value: `${a.night}次`,
      alert: false,
    },
    {
      key: 'over',
      tone: 'is-over',
      icon: 'report-over' as const,
      label: '超重情况',
      text: a.over ? `超过额定 5t，最高 ${maxTon}` : `未超过额定 5t，最大 ${maxTon}`,
      value: `${a.over}次`,
      alert: a.over > 0,
    },
  ]
})

/* ---------------- 分布可视化（三图） ---------------- */

/**
 * 长图是静态图片，「（点击图表查看详情）」在图上没有任何可点的东西 ——
 * 导出时把这句后缀剥掉，页面上的文案保持原样。
 */
const NOTE_HINT = '（点击图表查看详情）'

/**
 * 标题与说明（2026-11-25 现场定稿，一字不改）：
 *   吊次时段分布 / 按吊次起始时间分时统计，单位：小时（点击图表查看详情）
 *   吊重区间分布 / 按单次吊重分段统计，单位：吨（点击图表查看详情）
 *   作业时长分布 / 按单次作业时长分段统计，单位：分钟（点击图表查看详情）
 *
 * `unit` 不进文案，只用于点柱读数标签（`5 时` / `3.5 t` / `12 分`），
 * 所以说明里写「小时 / 吨 / 分钟」、tip 里仍是简写，两处并不冲突。
 */
const charts = computed(() => {
  const a = analysis.value
  return [
    {
      key: 'hours',
      title: '吊次时段分布',
      note: '按吊次起始时间分时统计，单位：小时（点击图表查看详情）',
      unit: '时',
      bins: a.hours,
      tone: 'blue' as const,
    },
    {
      key: 'loads',
      title: '吊重区间分布',
      note: '按单次吊重分段统计，单位：吨（点击图表查看详情）',
      unit: 't',
      bins: a.loads,
      tone: 'warn' as const,
    },
    {
      key: 'durs',
      title: '作业时长分布',
      note: '按单次作业时长分段统计，单位：分钟（点击图表查看详情）',
      unit: '分',
      bins: a.durs,
      tone: 'ok' as const,
    },
  ]
})

const kindName = computed(() => ({ day: '日报', week: '周报', month: '月报' })[report.span])

/* ---------------- 交互 ---------------- */

function pick(next: ReportSpan): void {
  if (next === report.span && report.state !== 'empty') return
  if (!units.value.length) return
  void report.load(units.value, next, report.anchor)
}

/** 选日期（周期锚点）：日报是某天、周报是某周的周一、月报是某月 1 号 */
function onPickPeriod(d: Date): void {
  if (!units.value.length) return
  void report.load(units.value, report.span, d)
}

/* ---------------- 导出分享 = 长图 ---------------- */

const imageName = computed(() => `${set.value.noun}${kindName.value}-${report.range.key}`)

const imageData = computed<ReportImageData>(() => ({
  title: `${set.value.noun}${kindName.value}`,
  range: report.range.text,
  scope: pickedName.value,
  kpis: kpis.value.map((k) => ({ label: k.label, value: k.u ? `${k.n}${k.u}` : k.n })),
  risks: risks.value.map((r) => ({ label: r.label, text: r.text, value: r.value, alert: r.alert })),
  charts: charts.value.map((c) => ({
    title: c.title,
    note: c.note.replace(NOTE_HINT, ''),
    bins: c.bins,
    tone: c.tone,
  })),
  stamp: `生成时间 ${camStampBrief()}`,
}))

/** 指纹：数据真变了才重画（computed 的引用每次都是新对象，不能直接 watch） */
const imageKey = computed(() => JSON.stringify(imageData.value))

const readyImage = shallowRef<File | null>(null)

/**
 * 三个阶段（也是按钮的三种样子）：
 *   idle      可点
 *   preparing 正在画长图（数据刚到 / 预生成还没落地时点的那一下）
 *   sharing   系统分享面板已弹出，等用户选「微信 / 存储图像 / 取消」
 */
const phase = ref<'idle' | 'preparing' | 'sharing'>('idle')
const busy = computed(() => phase.value !== 'idle')
const busyText = computed(() => (phase.value === 'sharing' ? '正在分享…' : '正在生成长图…'))

/** 微信内置浏览器的降级面板：把长图摆到页面上长按保存 */
const shotUrl = ref('')
const shotHint = ref('')

let imgSeq = 0
let imgTimer = 0
/**
 * 上一次交付结束的时刻。`busy` 只护住「正在生成 / 面板开着」这两段；
 * 下载路径是瞬时的，双击会连落两个同名文件（`xx(1).png`），所以再压一道 600ms。
 */
let lastDone = 0

function clearShot(): void {
  if (!shotUrl.value) return
  URL.revokeObjectURL(shotUrl.value)
  shotUrl.value = ''
}

/**
 * 预生成长图。
 *
 * 不预生成也能导出（点按钮时现画），但 iOS 上 `canvas.toBlob` 跨了几个 task，
 * 用户手势会过期、系统分享面板不弹 —— 那就退回文件下载，相册里就没有。
 * 数据一变就延迟 500ms 画一次，既不打断切页签，又能在用户看完数据点导出时
 * 手里已经有文件。
 */
watch(
  imageKey,
  () => {
    imgSeq += 1
    const key = imgSeq
    readyImage.value = null
    // 数据变了，上一张图不能再让用户存 —— 那会把旧数字传出去
    clearShot()
    window.clearTimeout(imgTimer)
    if (!hasData.value) return
    imgTimer = window.setTimeout(() => {
      void reportImageFile(imageData.value, imageName.value)
        .then((f) => {
          if (key === imgSeq) readyImage.value = f
        })
        .catch(() => {
          // 画布不可用（老 WebView / 内存不足）：点导出时再试一次，失败会提示
        })
    }, 500)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  imgSeq += 1
  window.clearTimeout(imgTimer)
  clearShot()
})

/**
 * 点「导出分享」。
 *
 * 已经备好文件时**同步**交付（`deliver` 里的 `share()` 在第一个 await 之前发出，
 * 用户手势还在）；还没备好才进 preparing 现画，画完再试 —— 那时手势多半已过期，
 * 面板可能不弹，`failed` 会自己退到下载。
 */
function onShare(): void {
  if (busy.value || !hasData.value) return
  if (Date.now() - lastDone < 600) return
  const file = readyImage.value
  if (file) {
    deliver(file)
    return
  }
  void prepareThenDeliver()
}

async function prepareThenDeliver(): Promise<void> {
  phase.value = 'preparing'
  const key = imgSeq
  try {
    const file = await reportImageFile(imageData.value, imageName.value)
    if (key === imgSeq) readyImage.value = file
    phase.value = 'idle'
    deliver(file)
  } catch {
    phase.value = 'idle'
    shell.showToast('长图生成失败，请重试', 'error')
  }
}

/** 交付：能弹系统面板就弹，不能就降级（下载 / 长按保存） */
function deliver(file: File): void {
  clearShot()
  if (canShareFile(file)) {
    phase.value = 'sharing'
    void shareReportImage(file, imageName.value).then((out) => {
      phase.value = 'idle'
      lastDone = Date.now()
      if (out === 'shared') {
        // 不说「已保存到相册」：用户可能选的是微信，图根本没进相册
        shell.showToast('长图已生成，在分享面板里选微信发送', 'success')
      } else if (out !== 'cancel') {
        // `failed`（丢手势 / 系统拒绝）与 `unsupported`（能力中途变了）
        // 都换一条路，别让按钮白点
        fallback(file)
      }
    })
    return
  }
  fallback(file)
}

function fallback(file: File): void {
  lastDone = Date.now()
  // 微信内置浏览器：没有分享面板，也不吃 a[download]，唯一的路是长按这张图
  if (isWeChatBrowser()) {
    shotUrl.value = URL.createObjectURL(file)
    shotHint.value = '长按上方图片：保存图片，或发送给微信好友'
    shell.showToast('长图已生成，长按图片可保存或转发', 'success')
    return
  }
  downloadReportImage(file, imageName.value)
  shell.showToast('长图已下载到本机', 'success')
}
</script>

<template>
  <!--
    台账 / 工作循环同步中：按报表的真实结构铺灰条（6 格 KPI + 风险卡 + 图表），
    结果到手后再决定出报表还是出下面的空态。
  -->
  <section
    v-if="syncing || (!hasData && report.state === 'loading')"
    class="dev-block skel-fade"
    :class="{ 'is-on': showSkel }"
    aria-busy="true"
  >
    <span class="sr-only" role="status">正在加载{{ set.noun }}作业报表</span>
    <div aria-hidden="true">
      <div class="report-kpis is-six">
        <div v-for="i in 6" :key="i" class="report-kpi">
          <Skel w="44px" h="10px" />
          <Skel w="52px" h="18px" r="var(--r-4)" />
        </div>
      </div>
      <div class="report-analysis">
        <div v-for="i in 3" :key="i" class="report-insight">
          <Skel w="36px" h="36px" r="var(--r-10)" />
          <div>
            <Skel w="96px" h="13px" />
            <Skel class="skel-mt-sm" w="150px" h="13px" />
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 塔机一台车都没取到（接口不通 / 全部无编号）→ 明确空态 -->
  <section v-else-if="!hasData" class="dev-block">
    <div class="data-empty" data-empty="device-report">
      <p>暂无作业报表数据</p>
      <p class="data-empty-sub">未取到塔机工作循环数据：需要塔机平台接口可达，且设备有平台编号。</p>
    </div>
  </section>

  <section v-else class="dev-block fill-in crane-report">
    <!-- 粒度 -->
    <div class="uav-tabs report-span">
      <button type="button" :class="{ on: report.span === 'week' }" :aria-pressed="report.span === 'week'" @click="pick('week')">周报</button>
      <button type="button" :class="{ on: report.span === 'month' }" :aria-pressed="report.span === 'month'" @click="pick('month')">月报</button>
    </div>

    <!-- 周期：预设 + 选日期（月历 / 周列表 / 月网格） -->
    <ReportPeriod :span="report.span" :anchor="report.anchor" @pick="onPickPeriod" />
    <p class="report-period-range">{{ report.range.text }}</p>

    <!-- 机组切换：每台（默认第一台） -->
    <div class="report-devs" role="tablist" aria-label="机组">
      <button
        v-for="d in devices"
        :key="d.id"
        class="report-dev"
        :class="{ on: picked === d.id }"
        type="button"
        role="tab"
        :aria-selected="picked === d.id"
        @click="picked = d.id"
      >
        <SvgIcon name="dev-crane" />
        <span>{{ d.name }}</span>
      </button>
    </div>

    <h3 class="report-part is-stat">数据统计</h3>
    <div class="report-kpis is-six">
      <div v-for="k in kpis" :key="k.label" class="report-kpi">
        <span>{{ k.label }}</span>
        <b :class="{ 'is-dash': k.n === DASH }">{{ k.n }}<em v-if="k.u">{{ k.u }}</em></b>
      </div>
    </div>

    <h3 class="report-part is-risk">作业风险分析</h3>
    <p v-if="focusEmpty" class="report-none">这台机组未取到工作循环数据，本次无法分析</p>
    <section v-else class="report-analysis">
      <article v-for="r in risks" :key="r.key" class="report-insight" :class="[r.tone, { 'is-alert': r.alert }]">
        <i :class="[r.tone, { 'is-alert': r.alert }]"><SvgIcon :name="r.icon" /></i>
        <div>
          <strong>{{ r.label }}</strong>
          <p>{{ r.text }}</p>
        </div>
        <b>{{ r.value }}</b>
      </article>
    </section>

    <h3 class="report-part is-chart">分布可视化</h3>
    <p v-if="focusEmpty" class="report-none">这台机组未取到工作循环数据，暂无分布</p>
    <template v-else>
      <div v-for="c in charts" :key="c.key" class="crane-chart">
        <div class="crane-chart-hd"><span>{{ c.title }}</span></div>
        <p class="report-chart-note">{{ c.note }}</p>
        <BarChart :bins="c.bins" :tone="c.tone" :unit="c.unit" />
      </div>
    </template>

    <!--
      「导出分享」悬浮条（2026-11-25 现场要求）：贴在视口底部常驻。
      报表三张图一长，滚到下面就看不到按钮了 —— 现在它脱离文档流浮在底部，
      按钮自身（44 高 / 圆角 / 蓝底 / 文案 / busy 态 / disabled 态）一个字没改，
      只是被这条底栏托住。底部占位加在 `.crane-report` 的 padding-bottom 上，
      滚到底时最后一张图（以及微信里的降级大图）不会被压住。
    -->
    <div class="report-share-bar">
      <button
        class="report-share"
        type="button"
        :disabled="busy"
        :aria-busy="busy"
        @click="onShare"
      >
        {{ busy ? busyText : '导出分享' }}
      </button>
    </div>

    <!--
      微信内置浏览器的降级面板：那里没有分享面板、a[download] 也不生效，
      唯一能用的是系统「长按图片」菜单（保存图片 / 发送给朋友）。
      iOS 的 callout 被 body 全局关掉了，这里必须在样式里单独开回来。
    -->
    <figure v-if="shotUrl" class="report-shot">
      <img :src="shotUrl" :alt="`${imageName}长图`" />
      <figcaption>{{ shotHint }}</figcaption>
    </figure>
  </section>
</template>
