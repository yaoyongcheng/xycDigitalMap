<script setup lang="ts">
import { computed } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
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
const statusPie = computed(() => {
  const pct = qty.value ? (onCount.value / qty.value) * 100 : 0
  return `conic-gradient(#2EE6A6 0% ${pct}%, #3A4E66 ${pct}% 100%)`
})

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
        <div class="eq-count-item"><b><CountUp :value="kinds" /><em>种</em></b><span>设备种类</span></div>
        <div class="eq-count-item"><b><CountUp :value="qty" /><em>台</em></b><span>设备数量</span></div>
      </div>
      <div class="home-chart-card eq-status">
        <span class="alarm-mini-lab">设备状态</span>
        <div class="eq-status-body">
          <i class="donut eq-status-donut" :style="{ background: statusPie }"></i>
          <div class="eq-status-leg">
            <div><i class="on"></i><span>在线</span><b><CountUp :value="onCount" /></b></div>
            <div><i class="off"></i><span>离线</span><b><CountUp :value="offCount" /></b></div>
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
