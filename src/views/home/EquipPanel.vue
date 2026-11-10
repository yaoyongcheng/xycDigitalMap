<script setup lang="ts">
import { computed, ref } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import DonutTouch from '@/components/ui/DonutTouch.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { CLIMB_LR_LIMIT, climbSensors } from '@/data/climb'
import { useHomeStore } from '@/stores/home'
import { useSubpageStore } from '@/stores/subpage'
import type { Equip } from '@/types'

/**
 * 首页 · 装备管控面板
 *
 * 2026-11 设计稿 gx2 版同步（原 js/app.js:909-1033 renderEquip + equipPic）：
 * ① 卡片从「上下两行」改成横向结构 —— 左 64px 设备照片（eq-ico）+
 *    中 eq-main（名称行 + 数值行）+ 右圆形箭头，eq-grid 改单列；
 * ② 设备收成 4 条（见 stores/home.ts），四类全部有详情页可下钻，
 *    「机器人只可看不可点」的分支随之消失；
 * ③ 塔机双指标（今日吊重 + 今日吊次）、无人机「作业任务 x/y」、
 *    爬架专属卡（三格正常数 + eq-alert 异常行）。
 */
const home = useHomeStore()
const subpage = useSubpageStore()

/** 详情页路由（原 data-crane/lift/uav/climb） */
function pageOf(d: Equip): string {
  return d.page ?? ''
}

function onCard(d: Equip): void {
  if (d.page === 'uav') subpage.openUav()
  else if (d.page === 'climb') subpage.openClimb()
  else if (d.page) subpage.openDevice(d.page)
}

/** 设备照片：public/img 下的 256px 立绘（原 equipPic，已转 webp） */
const ICO_IMG: Record<string, string> = {
  crane: 'img/eq-crane.webp',
  lift: 'img/eq-lift.webp',
  drone: 'img/eq-drone.webp',
  climb: 'img/eq-climb.webp',
}

/** 图片加载不出来时退回结构化图标（键与 ICO_IMG 对齐） */
const ICO_ICON = {
  crane: 'dev-crane',
  lift: 'dev-lift',
  drone: 'drone',
  climb: 'eq-climb',
} as const

const icoFailed = ref<Record<string, boolean>>({})

function onIcoError(d: Equip): void {
  icoFailed.value[d.id] = true
}

/** 图标兜底名：icoFailed 后才查，id 一定在 ICO_ICON 里 */
function icoIcon(d: Equip) {
  return ICO_ICON[d.id as keyof typeof ICO_ICON]
}

/** 数值行要不要带「在线 x/y」格（原 renderEquip:975 —— 多机组或无人机） */
function showOnline(d: Equip): boolean {
  return d.units.length > 1 || d.id === 'drone'
}

/**
 * 拆分指标值里的单位（原 renderEquip:990-992）：
 * 设计稿把「1.87t / 26次 / 2min」拆成数字 + <i class="eq-stat-unit">单位</i>，
 * 单位用 14px 小字，和 18px 数字形成主次，而不是整串一样大的白字。
 */
function splitStat(value: string): { num: string; unit: string } {
  const m = value.match(/^([\d.]+)(.*)$/)
  return m && m[2] ? { num: m[1], unit: m[2] } : { num: value, unit: '' }
}

function onlineLabel(d: Equip): string {
  return d.id === 'drone' ? '设备状态' : '在线设备'
}

/* ---- 爬架卡（原 renderEquip:992-1016，数据来自 data/climb.ts） ---- */
const climbKnown = climbSensors.length
const climbLrBad = climbSensors.filter((s) => s.bad).length

/** 正常数/总数三格：bad 指左右倾斜，前后倾斜与载荷全正常 */
function climbCell(bad: boolean, label: string): { cls: string; num: number; total: number; label: string } {
  return {
    cls: bad ? 'is-bad' : 'is-ok',
    num: climbKnown - (bad ? climbLrBad : 0),
    total: climbKnown,
    label,
  }
}

const climbCells = [
  climbCell(true, '左右倾斜'),
  climbCell(false, '前后倾斜'),
  climbCell(false, '载荷'),
]

const climbAlerts = climbSensors
  .filter((s) => s.bad)
  .map((s) => `${s.id}#机位 左右倾斜 ${s.lr}，超过 ${CLIMB_LR_LIMIT}`)

/** 列表视图统计 */
const kinds = computed(() => home.siteEquip.length)
const qty = computed(() => home.siteEquip.reduce((s, d) => s + d.units.length, 0))
const onCount = computed(() => home.siteEquip.reduce((s, d) => s + d.units.filter((u) => u.on).length, 0))
const offCount = computed(() => qty.value - onCount.value)
/** 触控版环形图分段（颜色与原 conic-gradient 一致） */
const statusSegs = computed(() => [
  { label: '在线', value: onCount.value, color: '#2EE6A6' },
  { label: '离线', value: offCount.value, color: '#3A4E66' },
])

/** 选中段（扇区点击与图例点击双向联动；null = 未选中） */
const eqSel = ref<number | null>(null)

/** 图例点选：同一段再点一次取消选中 */
function toggleSeg(i: number): void {
  eqSel.value = eqSel.value === i ? null : i
}

/** 键盘等价操作（Enter / Space） */
function onKey(e: KeyboardEvent, i: number): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    toggleSeg(i)
  }
}
</script>

<template>
  <div class="home-stats alarm-row">
    <div class="home-chart-card eq-count">
      <!-- sticky：面板是 v-if 切换的，不加则每次切回都从 0 重滚同样的数字 -->
      <div class="eq-count-item"><b><CountUp :value="kinds" sticky /><em>种</em></b><span>设备种类</span></div>
      <div class="eq-count-item"><b><CountUp :value="qty" sticky /><em>台</em></b><span>设备数量</span></div>
    </div>
    <div class="home-chart-card eq-status">
      <span class="alarm-mini-lab">设备状态</span>
      <div class="eq-status-body">
        <DonutTouch
          :segments="statusSegs"
          donut-class="eq-status-donut"
          :selected="eqSel"
          @select="eqSel = $event"
        />
        <!--
          图例是可点的筛选开关，此前是裸 div + click：键盘完全不可达，
          也没有任何「已选中」的语义。补 role/tabindex/aria-pressed 后，
          读屏与键盘用户才能知道它既能操作、又处在开还是关。
        -->
        <div class="eq-status-leg">
          <div
            :class="{ 'leg-on': eqSel === 0 }"
            role="button"
            tabindex="0"
            :aria-pressed="eqSel === 0"
            @click="toggleSeg(0)"
            @keydown="onKey($event, 0)"
          >
            <i class="on"></i><span>在线</span><b><CountUp :value="onCount" sticky /></b>
          </div>
          <div
            :class="{ 'leg-on': eqSel === 1 }"
            role="button"
            tabindex="0"
            :aria-pressed="eqSel === 1"
            @click="toggleSeg(1)"
            @keydown="onKey($event, 1)"
          >
            <i class="off"></i><span>离线</span><b><CountUp :value="offCount" sticky /></b>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="eq-grid">
    <button
      v-for="d in home.siteEquip"
      :key="d.id"
      class="eq-card drill"
      :class="d.id === 'crane' ? 'is-crane' : d.id === 'climb' ? 'is-climb' : ''"
      type="button"
      :data-page="pageOf(d)"
      :aria-label="`${d.name}，点击进入详情`"
      @click="onCard(d)"
    >
      <!-- 爬架卡：上层是「照片 + 名称 + 三格」，下层是异常行 -->
      <template v-if="d.id === 'climb'">
        <span class="eq-climb-top">
          <span class="eq-ico" aria-hidden="true">
            <img v-if="!icoFailed[d.id]" :src="ICO_IMG[d.id]" alt="" @error="onIcoError(d)" />
            <SvgIcon v-else :name="icoIcon(d)" />
          </span>
          <span class="eq-main">
            <span class="eq-hd"><strong>{{ d.name }}</strong><i class="eq-dot warn"></i></span>
            <span class="eq-vals">
              <span v-for="cell in climbCells" :key="cell.label" class="eq-val" :class="cell.cls">
                <b><em>{{ cell.num }}</em><i>/{{ cell.total }}</i></b>
                <span>{{ cell.label }}</span>
              </span>
            </span>
          </span>
          <span class="eq-more" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg></span>
        </span>
        <span v-for="text in climbAlerts" :key="text" class="eq-alert">{{ text }}</span>
      </template>

      <!-- 常规卡（塔机 / 电梯 / 无人机） -->
      <template v-else>
        <span class="eq-ico" aria-hidden="true">
          <img v-if="!icoFailed[d.id]" :src="ICO_IMG[d.id]" alt="" @error="onIcoError(d)" />
          <SvgIcon v-else :name="icoIcon(d)" />
        </span>
        <span class="eq-main">
          <span class="eq-hd">
            <strong>{{ d.name }}</strong>
            <i class="eq-dot" :class="home.equipCount(d).st"></i>
          </span>
          <span class="eq-vals">
            <span
              v-if="showOnline(d)"
              class="eq-val eq-online"
              :class="{ 'is-off': !home.equipCount(d).on }"
            >
              <b><em>{{ home.equipCount(d).on }}<i>/{{ home.equipCount(d).total }}</i></em></b>
              <span>{{ onlineLabel(d) }}</span>
            </span>
            <!-- 无人机：作业任务 x/y（原 d.jobs 分支） -->
            <span v-if="d.jobs" class="eq-val eq-online">
              <b><em>{{ d.jobs.done }}<i>/{{ d.jobs.total }}</i></em></b>
              <span>{{ d.metric }}</span>
            </span>
            <!-- 塔机：双指标（原 d.stats 分支，单位拆小字） -->
            <template v-else-if="d.stats">
              <span v-for="s in d.stats" :key="s.metric" class="eq-val">
                <b>
                  {{ splitStat(s.value).num }}<i v-if="splitStat(s.value).unit" class="eq-stat-unit"> {{ splitStat(s.value).unit }}</i>
                </b>
                <span>{{ s.metric }}</span>
              </span>
            </template>
            <!-- 其余：单指标 -->
            <span v-else class="eq-val">
              <b>{{ splitStat(d.value).num }}<i v-if="splitStat(d.value).unit" class="eq-stat-unit"> {{ splitStat(d.value).unit }}</i></b>
              <span>{{ d.metric }}</span>
            </span>
          </span>
        </span>
        <span class="eq-more" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg></span>
      </template>
    </button>
  </div>
</template>
