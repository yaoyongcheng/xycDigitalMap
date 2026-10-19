<script setup lang="ts">
import { computed, ref } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import DonutTouch from '@/components/ui/DonutTouch.vue'
import { useHomeStore } from '@/stores/home'
import type { Equip } from '@/types'

/**
 * 首页 · 装备管控面板
 *
 * 对应原 js/app.js:568-624 renderEquip() + homePanels 上的 [data-eq] 分支
 * （app.js:954-960）。
 *
 * 两个视图：设备列表 与 单台设备下钻（eqNode 非空时）。
 * 下钻用「返回按钮把 eqNode 置空」实现，与原型一致。
 */
const home = useHomeStore()

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
  <!-- 下钻视图 -->
  <template v-if="home.eqNode">
    <button class="eq-back" type="button" data-eq="back" @click="home.eqNode = null">
      <em>‹</em>
      <strong>{{ home.eqNode.name }}</strong>
      <b>{{ home.equipCount(home.eqNode).on }}/{{ home.eqNode.units.length }}</b>
    </button>
    <div class="eq-units">
      <div v-for="u in home.eqNode.units" :key="u.name" class="eq-unit">
        <div class="eq-hd">
          <strong>{{ u.name }}</strong>
          <i class="eq-dot" :class="u.on ? 'on' : 'off'"></i>
        </div>
        <div v-for="r in u.rows" :key="r[0]" class="eq-kv"><span>{{ r[0] }}</span><b>{{ r[1] }}</b></div>
      </div>
    </div>
  </template>

  <!-- 列表视图 -->
  <template v-else>
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
        :class="{ drill: canDrill(d) }"
        type="button"
        :data-eq="canDrill(d) ? d.id : undefined"
        :aria-label="canDrill(d) ? `${d.name}，点击展开明细` : undefined"
        @click="canDrill(d) ? (home.eqNode = d) : undefined"
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
        <span v-if="canDrill(d)" class="eq-more" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg></span>
      </button>
    </div>
  </template>
</template>
