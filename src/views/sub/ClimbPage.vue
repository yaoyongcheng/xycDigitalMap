<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { useAuthStore } from '@/stores/auth'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useScaffoldStore } from '@/stores/scaffold'
import { useSubpageStore } from '@/stores/subpage'
import { SCAFFOLD_LABEL, SCAFFOLD_LIMIT, SCAFFOLD_METRICS, scaffoldLabel, timeHm } from '@/utils/scaffold'
import { useSlowLoading } from '@/utils/slowLoading'
import type { ScaffoldMetric } from '@/types'

/**
 * 智能爬架详情页（设计稿 gx2 版同步）
 *
 * 结构：① climb-sum 两格（设备数量 / 设备状态）→ ② 台账字段 →
 * ③ 三个读数页签（左右倾斜 / 前后倾斜 / 载荷）→ ④ 机位读数列表。
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
 * 同口径，分子绿）+ 一句超限文案 + **按机位号升序**的逐台读数。
 *
 * 取不到数据时**不编机位**：列表整块换成空态，说明「数据未取到」。
 */
const ledger = useDeviceLedgerStore()
const scaf = useScaffoldStore()
const auth = useAuthStore()
const subpage = useSubpageStore()

onMounted(() => {
  if (auth.token) void ledger.load(auth.token)
  // 传感器走 public CDN，与登录态无关
  void scaf.load()
})

/** 台账里的爬架（正常只有 1 台） */
const units = computed(() => ledger.categoryUnits('climb'))
const unit = computed(() => units.value[0])

/** 爬升高度这类台账字段（已格式化，如 '21m'） */
const fields = computed(() => unit.value?.cells ?? [])

/** 慢请求才显示骨架（快请求直接出内容，不闪灰条） */
const showSkel = useSlowLoading(() => !units.value.length && ledger.state === 'loading')

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
  if (auth.token) void ledger.load(auth.token, true)
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
      <!--
        同步中：灰条铺在汇总两格与台账字段行的位置，结构同真实内容
        （同样的 .climb-sum / .dev-info-row），台账到手后原位回填。
      -->
      <template v-if="ledger.state === 'loading'">
        <span class="sr-only" role="status">正在加载设备台账</span>
        <div class="climb-sum skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
          <div>
            <Skel w="52px" h="12px" />
            <Skel class="skel-mt-sm" w="34px" h="24px" r="var(--r-6)" />
          </div>
          <div>
            <Skel w="52px" h="12px" />
            <Skel class="skel-mt-sm" w="42px" h="24px" r="var(--r-6)" />
          </div>
        </div>
        <div class="dev-info skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
          <div v-for="i in 4" :key="i" class="dev-info-row">
            <Skel w="54px" h="12px" /><Skel w="72px" h="13px" />
          </div>
        </div>
      </template>

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
            <!-- 正常台数（绿） / 有读数的台数；一个读数都没有时给「—」，不写 0/0 -->
            <b>
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
          <p class="data-empty-sub">{{ scaf.error || '爬架传感器数据未取到' }}，当前只展示台账中的设备属性。</p>
          <button class="data-empty-btn" type="button" @click="retry">重试</button>
        </div>
      </template>
    </template>
  </div>
</template>
