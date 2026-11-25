<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { axisLabel, axisStep, type Bin } from '@/utils/craneReport'

/**
 * 报表的柱状图（纯 SVG，无第三方库、无 v-html）
 *
 * 几何照标准版报表页的 `craneBarChart`：340×168 的 viewBox、左侧 28px 轴宽、
 * 上下留白 16/26、4 条水平网格线、柱顶标数值。宽高比随卡片宽度自适应
 * （`width:100%; height:auto`），所以一张 375 宽的屏上柱子也不会挤成线。
 *
 * 纵轴上限按峰值向上取整到刻度（峰值 ≤20 用 4 的倍数，≤80 用 10，其余 20）——
 * 现场一天几十次时若固定 20，柱子会整排顶出画布。
 *
 * ## 横轴（2026-11-25 重做）
 *
 * 24 个小时桶原来把 24 个两字标签全画出来：绘图区 304 宽 ÷ 24 = 12.7px 一格，
 * 而 `00` 本身就 12px 宽 —— 于是 `0001020304…2223` 连成一条黑边（现场截图）。
 * 现在两层处理：
 *   ① 标签去前导 0（`utils/craneReport.ts::axisLabel`）；
 *   ② 密桶每 2 格标一个（`axisStep`）→ `0 2 4 … 22` 共 12 个，在 375 宽的屏上
 *      每个标签有 25px 的位置，读得清也不会压到隔壁。
 * 数据、柱数、颜色、与长图的对应关系都没变（`utils/reportImage.ts` 用同一套规则）。
 *
 * ## 点柱子看读数（2026-11-25 追加）
 *
 * 横轴抽稀后只有 12 个刻度，其余 12 个小时没有文字可看 —— 所以每根柱子都能点：
 * 点一下在栏顶弹一个小标签写「9时 · 22次」，同时该柱描一道亮边、其余柱不变暗
 * （变暗会让整张图像被停用）。点同一根再点一下收起，点空白处也收起。
 * 每根柱子从柱顶到基线铺了一块透明命中区（最高 24 单位），所以 0 次的那一列
 * （柱高 0、看不见）同样点得到，读到的是「0次」而不是没反应；柱子上方那片
 * 空白不接管点击，点它只收起读数。
 */
const props = withDefaults(
  defineProps<{
    bins: Bin[]
    /** 蓝色 = 吊次、橙色 = 载荷、绿色 = 时长 */
    tone: 'blue' | 'warn' | 'ok'
    /** 读数标签的单位后缀：时刻写 `时`、载荷写 `t`、时长写 `分` */
    unit?: string
  }>(),
  { unit: '' },
)

const W = 340
const H = 168
const PL = 28
const PR = 8
const PT = 16
const PB = 26

const dense = computed(() => props.bins.length > 16)

const top = computed(() => {
  const maxV = Math.max(1, ...props.bins.map((b) => b.value))
  const step = maxV <= 20 ? 4 : maxV <= 80 ? 10 : 20
  return Math.max(step, Math.ceil(maxV / step) * step)
})

const plotW = W - PL - PR
const plotH = H - PT - PB

function yAt(v: number): number {
  return PT + (1 - v / top.value) * plotH
}

const grid = computed(() =>
  Array.from({ length: 5 }, (_, i) => {
    const value = Math.round((top.value * i) / 4)
    return { value, y: yAt(value) }
  }),
)

const bars = computed(() => {
  const n = props.bins.length
  const gap = dense.value ? 1.5 : 4
  const bw = (plotW - gap * (n - 1)) / n
  const base = yAt(0)
  /** 命中区最小高度：0 次的柱子高度是 0、看不见，也给一块能点到的矮条 */
  const minHit = 24
  return props.bins.map((b, i) => {
    const x = PL + i * (bw + gap)
    const h = b.value ? Math.max(1.5, base - yAt(b.value)) : 0
    const top = base - h
    const hitY = Math.min(top, base - minHit)
    return {
      label: b.label,
      value: b.value,
      x,
      y: top,
      w: Math.max(bw, 1),
      h,
      cx: x + bw / 2,
      // 命中区按整列铺（含左右各半个间隙），纵向从柱顶到基线：
      // 柱子本身与它正下方的空白都能点，柱子上方的大片空白留给「收起」
      hitX: x - gap / 2,
      hitW: bw + gap,
      hitY,
      hitH: base - hitY,
    }
  })
})

/**
 * 横轴刻度：抽稀后只留要标的那些（每根柱的中心仍是它自己的 x）。
 *
 * 柱子一根不少（24 根照画），只是标签隔一个标一个 —— 抽稀动的是刻度文字，
 * 不是数据。
 */
const ticks = computed(() => {
  const step = axisStep(bars.value.length)
  const out: { text: string; cx: number }[] = []
  for (let i = 0; i < bars.value.length; i += step) {
    const b = bars.value[i]
    out.push({ text: axisLabel(b.label), cx: b.cx })
  }
  return out
})

/* ---------------- 点柱子看读数 ---------------- */

/** 选中的柱子下标（null = 没选）。换机组 / 换周期时 bins 是新的，跟着收起 */
const active = ref<number | null>(null)

watch(
  () => props.bins,
  () => {
    active.value = null
  },
)

/** 点同一根收起，点另一根换过去 */
function tapBar(i: number): void {
  active.value = active.value === i ? null : i
}

/**
 * 估算文本宽度。
 *
 * SVG 里没有 `measureText`，而标签是固定的几类字符（数字 / `时` `t` `分` / `·`），
 * 按码位分两档估就够了：中日韩与全角按 1 个字宽，其余按 0.56。
 * 宁可估宽一点（圆角框略长于文字），估窄会把字顶出框外。
 */
function textWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x2e80) w += size
    else if (ch === ' ') w += size * 0.3
    else w += size * 0.56
  }
  return w
}

const TIP_H = 20
/**
 * 标签与柱顶的净距。
 *
 * 柱顶的次数文字是 `--fs-9`（11px），基线在柱顶上方 3 单位、字身高约 11 单位，
 * 也就是那条文字实际占 `柱顶-14 … 柱顶-3`。间距取 16 才能让标签底边正好落在
 * 文字上方 —— 取 6 时标签会盖住字的上半截，剩半截露在下面，比全盖住更难看。
 */
const TIP_GAP = 16

/**
 * 读数标签的位置与层级（2026-11-25 二次调整）。
 *
 * ## 位置
 *
 * 以前固定贴在绘图区顶部 —— 高柱子顶到顶时，标签正好压在那根柱的柱顶数值上，
 * 现场看到的就是「数字被标签吃掉」。现在跟着选中柱走：
 *   ① 优先贴**柱顶上方**（柱顶再往上 `TIP_GAP` = 16 单位，正好让开柱顶的次数
 *      文字），不会被盖；
 *   ② 顶部放不下（柱顶已经贴近绘图区上沿）就改贴**柱顶下方**，压在柱身上 ——
 *      柱身是纯色块，盖住不丢信息，柱顶那个次数文字仍在标签上方露着；
 *   ③ 纵向再夹一次，保证整块不越过基线、不压到横轴标签。
 *
 * 横向不变：以柱心居中，再夹进绘图区，最左（0 时）最右（23 时）都不会越界。
 *
 * ## 层级
 *
 * 标签在柱子、柱顶数值、横轴标签之后绘制（画在最上层），底色也从 12% 的
 * 透明白换成实底 `--bg-4` + 描边 + 投影 —— 以前柱子会从标签里透出来，
 * 文字与柱色混成一片看不清。
 */
const tip = computed(() => {
  const i = active.value
  if (i === null) return null
  const b = bars.value[i]
  if (!b) return null
  const text = `${axisLabel(b.label)}${props.unit} · ${b.value}次`
  const w = Math.min(plotW, Math.max(52, textWidth(text, 11) + 16))
  const x = Math.min(Math.max(b.cx - w / 2, PL), W - PR - w)
  const base = yAt(0)
  const above = b.y - TIP_GAP - TIP_H
  const y = above >= PT + 2 ? above : Math.max(PT + 2, Math.min(b.y + 6, base - TIP_H - 2))
  return { i, text, x, y, w, h: TIP_H }
})
</script>

<template>
  <svg
    class="crane-bars"
    :class="[`is-${tone}`, { 'is-hours': dense }]"
    :viewBox="`0 0 ${W} ${H}`"
    role="img"
  >
    <!-- 空白处：点一下收起读数（在柱子下面一层，不会抢柱子的点击） -->
    <rect class="crane-bar-void" :x="PL" :y="PT" :width="plotW" :height="plotH" @click="active = null" />
    <g class="alarm-grid">
      <template v-for="g in grid" :key="g.value">
        <line :x1="PL" :x2="W - PR" :y1="g.y" :y2="g.y" />
        <text :x="PL - 4" :y="g.y + 3" text-anchor="end">{{ g.value }}</text>
      </template>
    </g>
    <g class="crane-bar-shapes">
      <template v-for="(b, i) in bars" :key="b.label">
        <rect :x="b.x" :y="b.y" :width="b.w" :height="b.h" rx="1.2" :class="{ 'is-on': active === i }" />
        <text v-if="b.value" class="crane-chart-val" :x="b.cx" :y="b.y - 3" text-anchor="middle">{{ b.value }}</text>
      </template>
    </g>
    <!-- 读数：区间 + 次数。画在柱子/数值/横轴之后（最上层），实底不透明 -->
    <g v-if="tip" class="crane-tip">
      <rect class="crane-tip-bg" :x="tip.x" :y="tip.y" :width="tip.w" :height="tip.h" rx="4" />
      <text class="crane-tip-text" :x="tip.x + tip.w / 2" :y="tip.y + 14" text-anchor="middle">{{ tip.text }}</text>
    </g>
    <g class="alarm-x">
      <text v-for="t in ticks" :key="`x-${t.text}`" :x="t.cx" :y="H - 8" text-anchor="middle">{{ t.text }}</text>
    </g>
    <g class="crane-hits">
      <rect
        v-for="(b, i) in bars"
        :key="`hit-${b.label}`"
        class="crane-bar-hit"
        :x="b.hitX"
        :y="b.hitY"
        :width="b.hitW"
        :height="b.hitH"
        @click="tapBar(i)"
      />
    </g>
  </svg>
</template>
