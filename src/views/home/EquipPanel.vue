<script setup lang="ts">
import { computed, ref } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import DonutTouch from '@/components/ui/DonutTouch.vue'
import { useHomeStore } from '@/stores/home'
import { useSubpageStore } from '@/stores/subpage'
import type { DeviceKind, Equip } from '@/types'

/**
 * 首页 · 装备管控面板
 *
 * 对应原 js/app.js:568-624 renderEquip() + homePanels 上的 [data-eq] 分支
 * （app.js:954-960）。
 *
 * 2026-10 版本同步：多台设备的下钻从「整块面板换成子视图」改成底部弹层
 * （原 openEquipPop，app.js:689-700）。原做法点开一台设备就把上面的
 * 「设备种类/数量 + 在线离线」总览顶掉了，还多出一个「返回」步骤；
 * 弹层浮在面板上，关掉即回原位。列表本身不再维护 eqNode 状态。
 */
const home = useHomeStore()
const subpage = useSubpageStore()

/**
 * 有独立详情页的设备（2026-10 版本同步 · 第四批）。
 *
 * 塔机与电梯都是多台机组，原来点开是弹层里的一串机组明细；现在它们各自
 * 有一整页（实时概览 / 当日统计 / 历史分析），弹层只留给「没有详情页」的
 * 多机组设备（例如机器人编队）。
 */
const PAGE_OF: Record<string, DeviceKind | 'uav'> = {
  crane: 'crane',
  lift: 'lift',
  drone: 'uav',
}

function pageOf(d: Equip): DeviceKind | 'uav' | undefined {
  return PAGE_OF[d.id]
}

/**
 * 只有「有详情页」的设备可点。
 *
 * 2026-10 版本同步后，塔机 / 电梯 / 无人机各自有一整页；其余设备（机器人）
 * 都只有一台机组，弹层里也就一条数据，点开等于什么也没发生 —— 干脆不做
 * 成可点，卡片上也不画箭头。
 */
function onCard(d: Equip): void {
  const page = pageOf(d)
  if (page === 'uav') subpage.openUav()
  else if (page) subpage.openDevice(page)
}

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

/** 原版仅 units.length > 1 的设备可下钻 */
function canDrill(d: Equip): boolean {
  return d.units.length > 1
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
      class="eq-card"
      :class="{ drill: !!pageOf(d) }"
      type="button"
      :data-page="pageOf(d)"
      :aria-label="pageOf(d) ? `${d.name}，点击进入详情` : undefined"
      @click="onCard(d)"
    >
      <div class="eq-hd">
        <strong>{{ d.name }}</strong>
        <i class="eq-dot" :class="home.equipCount(d).st"></i>
        <em v-if="canDrill(d)">{{ home.equipCount(d).on }}/{{ home.equipCount(d).total }}</em>
      </div>
      <div class="eq-val">
        <b>{{ d.value }}</b>
        <span>{{ d.metric }}</span>
      </div>
      <span v-if="pageOf(d)" class="eq-more" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg></span>
    </button>
  </div>
</template>
