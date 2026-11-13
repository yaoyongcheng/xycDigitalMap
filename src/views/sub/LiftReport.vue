<script setup lang="ts">
import { computed, onMounted } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { LIFT_CAGES } from '@/data/liftSn'
import { useLiftReportStore } from '@/stores/liftReport'
import { useLiftStore } from '@/stores/lift'
import { useShellStore } from '@/stores/shell'
import { DASH } from '@/utils/lift'
import { reportRange, type ReportSpan } from '@/utils/craneReport'
import { formatDays, formatSpan, liftTotals, share, spanText } from '@/utils/liftReport'
import { shareText } from '@/utils/share'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 电梯作业报表（设计稿 gx2 的「智能电梯 → 作业报表」页签）
 *
 * ## 版式照设计稿，口径照 V2 与塔机报表
 *
 * 结构与塔机报表（`DeviceReport.vue`）同构：粒度切换 → 区间 → 三格合计 →
 * 结论 → 分台表 → 导出分享，样式全部复用现成的 `.report-*`。两页放在同一
 * 套骨架里，用户从塔机切到电梯不会觉得是两个系统。
 *
 * 数据是 IOT 的 `EVENT_WORKDATA`（每次升降一条），也就是 V2 电梯历史弹层
 * （`UIPopElevatorHistory` / 行项 `UIItemElevatorHistory`）看的那份。
 *
 * ## 与设计稿的偏差（都不能照抄）
 *
 * ① **「合计载重」「平均利用率」换成「在运时段」「覆盖台数」。**
 *    设计稿那两格是示意图占位。载重只有瞬时帧（`EVENT_POST_ATTR` 的
 *    `load`），没有逐次累计；利用率要台班排班表。现场没有任何接口能算。
 *    与其留两格永远写「—」，不如换成同样来自工作循环、能逐条核验的量。
 *
 * ② **分台表只留「循环」这一列，后三列换成「在运时段 / 最长单次 / 在用天数」。**
 *    设计稿是「循环 / 载重 / 利用率 / 运送（人数）」——后三个同①，无源。
 *
 * ③ **日报的在运时段与弹层「今日累计运行时间」是同一个数。**
 *    都走 V2 的首尾跨度口径，按日切片后累加（见 `utils/liftReport.ts` 文件头）。
 *    这样用户在两个页面看到的数不会打架。
 *
 * 用词：这一页统一说「循环」（设计稿用语），它与弹层「今日升降次数」、V2 的
 * `Data.Count` 是同一个量（事件条数）。弹层那边沿用现场叫法「升降」，不跟着改。
 *
 * 一台笼的数据有两种缺失，文案必须分开：网关不认编号（`32251222021` /
 * `32251222023`，实测回 `status:10`）是「永远查不了」，请求失败是「这次没拿到」。
 */

const shell = useShellStore()
const report = useLiftReportStore()
const lift = useLiftStore()

const hasData = computed(() => report.rows.some((r) => r.stats !== null))
const showSkel = useSlowLoading(() => report.state === 'loading' && !hasData.value)

const total = computed(() => liftTotals(report.rows.map((r) => r.stats)))

/** 三格合计：值拆成「数字 + 单位」，与塔机的 `<b>26<em>次</em></b>` 同一套排版 */
const kpis = computed(() => {
  const span = formatSpan(total.value.spanSec)
  return [
    { label: '合计循环', n: String(total.value.trips), u: '次' },
    { label: '在运时段', n: span.n, u: span.u },
    { label: '覆盖台数', n: String(total.value.covered), u: `/${LIFT_CAGES.length}台` },
  ]
})

/** 分台表：五列与塔机报表同宽，直接复用 `.report-line` 的网格 */
const FLEET_HEAD = ['电梯', '循环', '在运时段', '最长单次', '在用天数']

const fleet = computed(() =>
  report.rows.map((r) => ({
    sn: r.sn,
    name: r.name,
    cells: r.stats
      ? [`${r.stats.trips}次`, spanText(r.stats.spanSec), spanText(r.stats.maxRunSec), formatDays(r.stats.days)]
      : [DASH, DASH, DASH, DASH],
  })),
)

/**
 * 结论：四段，照设计稿的语汇与优先级（关注 / 主力 / 短板 / 当前）。
 *
 * 设计稿的判据依次是「利用率最低 / 循环占比最高 / 循环最少 / 离线」。利用率
 * 没有数据源（见文件头①），所以「关注」换成同样表达**使用强度最弱**的在用
 * 天数 —— 一台笼只跑了 1 天，和在用时长最短一样，都是该被盯的信号；「短板」
 * 接着按设计稿的循环次数说。
 *
 * 「峰值」（单次最长）不单独占一段：设计稿只有四段，它并进「主力」那句里，
 * 信息不丢，也不多出一段。
 *
 * 「缺数」替代「关注」出现在首位 —— 有台没纳入统计时，这是比「哪台少跑」
 * 更该先说的事：否则「合计 78 次」会被当成全场的数。
 */
const points = computed<{ tag: string; warn?: boolean; text: string }[]>(() => {
  const live = report.rows.filter((r): r is typeof r & { stats: NonNullable<typeof r.stats> } => r.stats !== null)
  const items: { tag: string; warn?: boolean; text: string }[] = []
  const ran = live.filter((r) => r.stats.trips > 0)

  const missing = report.rows.filter((r) => r.stats === null).map((r) => r.name)
  if (missing.length) {
    items.push({ tag: '关注', warn: true, text: `${missing.join('、')} 未纳入统计，合计不含这 ${missing.length} 台` })
  } else if (ran.length > 1) {
    // 天数相同再比次数：两台都只跑 1 天时，次数少的那台更值得先看
    const [fewest] = [...ran].sort((a, b) => a.stats.days - b.stats.days || a.stats.trips - b.stats.trips)
    items.push({ tag: '关注', warn: true, text: `${fewest.name} 仅 ${fewest.stats.days}天有运行，${ran.length}台中最少` })
  } else if (!ran.length && live.length) {
    // 网关应答、每台都是 0 条：不是没取到，是这段真的没跑。
    // 只在没有缺数台时说 —— 缺数那条已经占了「关注」，两段同 tag 会读成重复。
    items.push({ tag: '关注', warn: true, text: `${live.length} 台均无升降记录，可能是停工，或网关未上报` })
  }

  if (ran.length) {
    const byTrips = [...ran].sort((a, b) => b.stats.trips - a.stats.trips)
    const busy = byTrips[0]
    // 只有一台在跑时占比恒为 100%，写出来是废话
    const pct = ran.length > 1 ? `，占 ${share(busy.stats.trips, total.value.trips)}%` : ''
    const peak = busy.stats.maxRunSec !== null ? `，单次最长 ${spanText(busy.stats.maxRunSec)}` : ''
    items.push({ tag: '主力', text: `${busy.name} 循环 ${busy.stats.trips}次${pct}${peak}` })

    if (ran.length > 1) {
      const idle = byTrips[byTrips.length - 1]
      items.push({ tag: '短板', warn: true, text: `${idle.name} 循环 ${idle.stats.trips}次，只占 ${share(idle.stats.trips, total.value.trips)}%` })
    }
  }

  // 只有在线状态确实拿到时才说「离线」，否则「连不上」会被写成「4 台全停」
  if (lift.onlineKnown) {
    const off = LIFT_CAGES.filter((c) => !lift.isOnline(c.sn)).map((c) => c.name)
    if (off.length) items.push({ tag: '当前', warn: true, text: `${off.join('、')} 离线` })
  }

  return items
})

const kindName = computed(() => ({ day: '日报', week: '周报', month: '月报' })[report.span])

function pick(next: ReportSpan): void {
  if (next === report.span && report.state !== 'empty') return
  void report.load(next)
}

/** 纯文本版：分享与下载用（字段顺序与设计稿的导出文案一致） */
const plainText = computed(() => {
  const lines = [
    `电梯${kindName.value} ${report.range.text}`,
    '向阳村项目',
    `合计循环 ${total.value.trips}次，在运时段 ${spanText(total.value.spanSec)}，覆盖 ${total.value.covered}/${LIFT_CAGES.length}台`,
    '结论',
    ...points.value.map((p) => `${p.tag}：${p.text}`),
    '',
  ]
  for (const r of fleet.value) {
    const [trips, span, peak, days] = r.cells
    lines.push(`${r.name} 循环 ${trips}，在运时段 ${span}，最长单次 ${peak}，在用 ${days}`)
  }
  return lines.join('\n')
})

async function onShare(): Promise<void> {
  const title = `电梯${kindName.value} ${report.range.text}`
  const result = await shareText({
    title,
    text: plainText.value,
    fileName: `${title}.txt`,
  })
  if (result === 'shared') shell.showToast(`${kindName.value}已分享`, 'success')
  else if (result === 'downloaded') shell.showToast(`${kindName.value}已导出，并复制到剪贴板`, 'success')
}

onMounted(() => {
  // 只在「从没查过 / 上一轮空手 / 跨天了」时重查；否则复用 store 里刚拿到的结果，
  // 切页签回来不会闪一下骨架
  const today = reportRange(report.span, new Date())
  if (report.state === 'idle' || report.state === 'empty' || report.range.key !== today.key) {
    void report.load(report.span)
  }
  // 结论里的「当前离线」需要在线状态；首页通常已经拉过，没有就补一次
  if (lift.state === 'idle') void lift.refresh()
})
</script>

<template>
  <!-- 取数中：按报表真实结构铺灰条，别先摆一个「正在加载…」的空态 -->
  <section v-if="report.state === 'loading' && !hasData" class="dev-block skel-fade" :class="{ 'is-on': showSkel }" aria-busy="true">
    <span class="sr-only" role="status">正在加载电梯作业报表</span>
    <div aria-hidden="true">
      <div class="report-kpis">
        <div v-for="i in 3" :key="i" class="report-kpi">
          <Skel w="52px" h="10px" />
          <Skel w="52px" h="18px" r="var(--r-4)" />
        </div>
      </div>
      <div class="report-fleet">
        <div v-for="i in LIFT_CAGES.length + 1" :key="i" class="report-line">
          <Skel w="62px" h="13px" />
          <Skel w="30px" h="13px" />
          <Skel w="30px" h="13px" />
          <Skel w="30px" h="13px" />
          <Skel w="30px" h="13px" />
        </div>
      </div>
    </div>
  </section>

  <!--
    空态也保留上面的粒度切换：电梯的空手很可能是「这个区间恰好没跑」——
    日报空、周报有，是现场常见的形态（周末、雨天停工）。不像塔机那边空态
    意味着接口不通，换哪个区间都一样。
  -->
  <section v-else class="dev-block fill-in">
    <div class="uav-tabs report-span">
      <button type="button" :class="{ on: report.span === 'day' }" :aria-pressed="report.span === 'day'" @click="pick('day')">日报</button>
      <button type="button" :class="{ on: report.span === 'week' }" :aria-pressed="report.span === 'week'" @click="pick('week')">周报</button>
      <button type="button" :class="{ on: report.span === 'month' }" :aria-pressed="report.span === 'month'" @click="pick('month')">月报</button>
    </div>

    <!--
      空态有两种原因，必须分开说。

      凭证失效时「换个粒度看看」是假建议：周报月报走同一个网关、同一张令牌，
      换了照样空，用户只会白点三档再回来。这时该给的是「重试」（丢令牌重换）。

      真没跑（网关应答、区间内 0 条）才轮到「换个粒度看看」—— 现场周末、
      雨天停工是常态，日报空而月报有数的情形很常见。
    -->
    <div v-if="!hasData" class="data-empty" data-empty="lift-report">
      <template v-if="report.authLost">
        <p>{{ report.gatewayStale ? '电梯物联网网关未恢复，请稍后再试' : '电梯物联网网关凭证失效，请稍后重试' }}</p>
        <p class="data-empty-sub">报表与实时状态走同一套网关凭证，凭证没恢复前换任何粒度都取不到数。</p>
        <button class="data-empty-btn" type="button" @click="report.retry()">重试</button>
      </template>
      <template v-else>
        <p>暂无作业报表数据</p>
        <p class="data-empty-sub">这个区间未取到电梯工作循环：可以换个粒度看看，也可能是网关不可达、或轿厢编号未在网关侧登记。</p>
      </template>
    </div>

    <template v-else>
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
          <li v-for="p in points" :key="p.tag + p.text" :class="{ 'is-warn': p.warn }">
            <b>{{ p.tag }}</b><span>{{ p.text }}</span>
          </li>
        </ul>
      </div>

      <div class="report-fleet">
        <div class="report-line is-hd">
          <b>{{ FLEET_HEAD[0] }}</b><span v-for="h in FLEET_HEAD.slice(1)" :key="h">{{ h }}</span>
        </div>
        <div v-for="r in fleet" :key="r.sn" class="report-line">
          <b>{{ r.name }}</b>
          <span v-for="(c, i) in r.cells" :key="i" :class="{ 'is-dash': c === DASH }">{{ c }}</span>
        </div>
      </div>

      <button class="report-share" type="button" @click="onShare">导出分享</button>
    </template>
  </section>
</template>
