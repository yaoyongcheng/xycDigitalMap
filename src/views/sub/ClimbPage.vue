<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { useAuthStore } from '@/stores/auth'
import { useScaffoldStore } from '@/stores/scaffold'
import { useSubpageStore } from '@/stores/subpage'
import { SCAFFOLD_LABEL, SCAFFOLD_LIMIT, SCAFFOLD_METRICS, scaffoldLabel, timeHm } from '@/utils/scaffold'
import type { ScaffoldMetric } from '@/types'

/**
 * 智能爬架详情页（设计稿 gx2 版同步）
 *
 * 结构：① 三个读数页签（左右倾斜 / 前后倾斜 / 载荷）→ ② 机位读数列表。
 *
 * **2026-11-23：顶部「设备数量 / 设备状态 / 设备名称 / 爬升高度」整块删除**，
 * 连带台账取数（`useDeviceLedgerStore`）、骨架与 `Skel` 依赖一并下线 ——
 * 这四行是台账属性，现场不看，且把真正的读数挤到了折线以下。删掉之后本页
 * 只依赖 CDN 传感器数据，不再等登录态之外的第二个请求。
 *
 * **2026-11 第四轮：机位读数回来了，而且是真数据。**
 * 第二轮曾把 36 条手写机位数据整块删除（那是编的），四套后端也确实没有
 * 爬架传感器接口 —— 但 V2 桌面端根本不走 REST，它定时拉一份 CDN 静态 JSON：
 *
 *   http://120.26.34.95:9689/CDN/PC/ScaffoldData.json
 *
 * 实测 38 个机位、三个读数、带更新时间。阈值不在报文里，是 V2 客户端硬编码的
 * （倾斜 60mm / 载荷 5.0 吨，按绝对值判），见 `utils/scaffold.ts`。
 *
 * 机位区（`.climb-board`）= 表头「正常台数 / 有读数的台数」（与首页卡片三格
 * 同口径；该指标有任意机位越限时分子转红，否则绿）+ 一句超限文案 +
 * **按机位号升序**的逐台读数。
 *
 * 取不到数据时**不编机位**：列表整块换成空态，说明「数据未取到」。
 */
const scaf = useScaffoldStore()
const auth = useAuthStore()
const subpage = useSubpageStore()

onMounted(() => {
  // 传感器走 public CDN，与登录态无关（台账那路已随顶部信息块一起删掉）
  void scaf.load()
})

/* ---------- 机位读数（CDN 真实数据） ---------- */

/** 当前页签 */
const tab = ref<ScaffoldMetric>('lrTilt')

/** 页签定义（顺序与卡片三格一致） */
const tabs = computed(() =>
  SCAFFOLD_METRICS.map((key) => ({ key, label: SCAFFOLD_LABEL[key].label })),
)

const limitOf = (key: ScaffoldMetric): number => SCAFFOLD_LIMIT[key]
const unitOf = (key: ScaffoldMetric): string => SCAFFOLD_LABEL[key].unit

/**
 * 当前页签下的机位行，**按机位号从小到大**（1# → 2# → … → 38#）。
 *
 * 现场按机位号巡检、报修，列表顺序跟物理顺序一致才找得到人；早先是按
 * 「读数绝对值倒序」把最不利的顶在最前，看着像排行榜，核对某一台时反而
 * 要倒着数。异常机位靠三样东西定位，不再靠排序：行的红字、表头的超限台数、
 * 以及上方那句「30#机位 左右倾斜 179.5mm，超过 60mm」。
 *
 * 比较器必须带 `numeric: true`：机位名是 '1#机位' … '38#机位'，纯字典序会把
 * '19#' 排到 '2#' 前面。
 *
 * 没有读数的机位照旧留在列表里（不静默过滤），值显示「—」——
 * 「这台没数据」本身是现场要看的信息。
 */
const lines = computed(() => {
  const key = tab.value
  return scaf.sensors
    .map((s) => {
      const v = s[key]
      return {
        item: s.item,
        value: v === null ? '—' : `${v}${unitOf(key)}`,
        over: v !== null && Math.abs(v) > limitOf(key),
        hm: timeHm(s.time),
      }
    })
    .sort((a, b) => a.item.localeCompare(b.item, 'zh-Hans-CN', { numeric: true }))
})

/**
 * 表头那组数字：**正常机位数 / 有该指标读数的机位数**。
 *
 * 与首页卡片三格同一口径（都取 `summary.cells` 的 `normal` / `total`），
 * 页签切换时跟着换 —— 三个指标永远是同一句话：「多少台是好的、一共多少台有数」。
 *
 * 为什么不再写「超限台数」：那块数字在深色底上被当成页面主指标读，
 * 报「1/38」等于一进来先看见「一台坏的」，而现场更关心「37 台是好的」。
 * 具体的坏机位由下面那行红字（`issue`）点名，信息一点没少。
 */
const cellNow = computed(() => scaf.summary.cells.find((c) => c.key === tab.value))
const normalCount = computed(() => cellNow.value?.normal ?? 0)
const totalCount = computed(() => cellNow.value?.total ?? 0)

/**
 * 当前页签这个指标是否有**任意一个机位**越限 —— 表头数字的颜色靠它（2026-11-23）。
 *
 * 与首页智控面板的卡片三格同一条判据：`utils/scaffold.ts::worstOf` 里
 * `normal = total - 超限台数`，所以「正常数少于总数」就等于「这个指标下
 * 有 ≥1 个机位越限」；`total = 0`（表头显示「—」）不算异常。
 *
 * 加这一支是因为两处不一致：面板里那一格已经按「有越限就转红」显示，
 * 点进来同一个 37 却还是绿的 —— 同一份数据两个结论，现场只会互相打听哪个是真的。
 */
const cellBad = computed(() => totalCount.value > 0 && normalCount.value < totalCount.value)

/** 最不利机位的那条超限文案（没有超限为空串） */
const issue = computed(() => {
  const cell = cellNow.value
  return cell && cell.over ? scaffoldLabel(cell) : ''
})

const updatedHm = computed(() => timeHm(scaf.summary.updatedAt))

/**
 * 数据时间说明。
 *
 * CDN 是纯 HTTP，线上站点是 HTTPS（GitHub Pages 强制），浏览器会拦掉混合内容 ——
 * 那种情况下退回项目内置快照。两种情况都只报读数时间，不标注数据来源。
 */
const sourceNote = computed(() => (updatedHm.value ? `${updatedHm.value} 更新` : ''))

function retry(): void {
  // 台账那路已随顶部信息块删除，重试只针对传感器
  void scaf.load(true)
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
      <!-- 三个读数页签 -->
      <div class="dev-tabs climb-view" role="tablist">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          role="tab"
          :aria-selected="tab === t.key"
          :class="{ on: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- 机位读数：真实 CDN 数据 -->
      <div v-if="scaf.hasData" class="climb-board">
        <header>
          <!--
            正常台数 / 有读数的台数；一个读数都没有时给「—」，不写 0/0。
            `is-bad`：该指标下有任意机位越限时分子转红（与首页卡片三格同色）。
          -->
          <b :class="{ 'is-bad': cellBad }">
            <template v-if="totalCount > 0">
              <em>{{ normalCount }}</em><i>/{{ totalCount }}</i>
            </template>
            <template v-else>—</template>
          </b>
          <span>正常机位<span v-if="sourceNote"> · {{ sourceNote }}</span></span>
        </header>
        <p v-if="issue" class="climb-issue">{{ issue }}</p>
        <div class="climb-lines">
          <div v-for="r in lines" :key="r.item" class="climb-line" :class="{ 'is-bad': r.over }">
            <b>{{ r.item }}</b>
            <span>{{ r.value }}</span>
            <time>{{ r.hm }}</time>
          </div>
        </div>
      </div>

      <div v-else-if="scaf.state === 'loading'" class="data-empty" data-empty="climb">
        <p>正在读取爬架传感器…</p>
      </div>
      <div v-else class="data-empty" data-empty="climb">
        <p>暂无爬架机位读数</p>
        <p class="data-empty-sub">{{ scaf.error || '爬架传感器数据未取到' }}</p>
        <button class="data-empty-btn" type="button" @click="retry">重试</button>
      </div>
    </template>
  </div>
</template>
