<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import DonutTouch from '@/components/ui/DonutTouch.vue'
import Skel from '@/components/ui/Skel.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAuthStore } from '@/stores/auth'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useHomeStore } from '@/stores/home'
import { useSubpageStore } from '@/stores/subpage'
import { useSlowLoading } from '@/utils/slowLoading'
import type { Equip } from '@/types'

/**
 * 首页 · 装备管控面板
 *
 * 2026-11 设计稿 gx2 版同步（原 js/app.js:909-1033 renderEquip + equipPic）：
 * ① 卡片从「上下两行」改成横向结构 —— 左 64px 设备照片（eq-ico）+
 *    中 eq-main（名称行 + 数值行）+ 右圆形箭头，eq-grid 改单列；
 * ② 设备收成 4 条（见 stores/home.ts），四类全部有详情页可下钻。
 *
 * **2026-11 第二轮：数字与卡片全部改由设备台账接口驱动。**
 * 四张卡的台数、在线数、数值位都来自 `:8084 /api/data/deviceinfos`；
 * 台账要 Bearer，所以未登录时整块替换为登录引导（同报警区的处理）。
 * 原先爬架卡的「35/36 正常 + 30# 机位超限」来自 data/climb.ts 的 36 条
 * 编造读数 —— 传感器没有任何接口，一并删除，卡片退回与其它三类同构。
 */
const home = useHomeStore()
const ledger = useDeviceLedgerStore()
const auth = useAuthStore()
const subpage = useSubpageStore()

/** 面板挂载即取一次；store 内部有并发去重与失败冷却 */
onMounted(() => {
  if (auth.token) void ledger.load(auth.token)
})

/** 首页面板常驻（切 tab 只切 class），登录态后到时必须补拉 */
watch(
  () => auth.token,
  (t) => {
    if (t) void ledger.load(t, true)
  },
)

/** 详情页路由（原 data-crane/lift/uav/climb） */
function pageOf(d: Equip): string {
  return d.page ?? ''
}

/**
 * 慢请求才显示骨架（对齐支付宝的加载观感）。
 *
 * 台账是本页唯一的取数点，接口在局域网里通常 100~200ms 就回来了 —— 那种情况
 * 骨架连一帧都不该出现，否则就是「闪一下灰条又变内容」。超过 SKEL_DELAY 才
 * 把灰条淡入，数据一到立刻撤。
 */
const showSkel = useSlowLoading(() => !ledger.hasData && ledger.state === 'loading')

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

/** 数值行那一格的标签：无人机按「设备状态」，其余按「在线设备」 */
function onlineLabel(d: Equip): string {
  return d.id === 'drone' ? '设备状态' : '在线设备'
}

/* ---- 顶部两块统计（真实台账） ---- */

/** 设备种类：有设备的类别才算一种（0 台的那类不虚报一种） */
const kinds = computed(() => home.siteEquip.filter((d) => d.units.length > 0).length)
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

function retry(): void {
  if (auth.token) void ledger.load(auth.token, true)
}

/** 去登录：登录完回首页，智控面板会自动补拉（watch token） */
function goLogin(): void {
  subpage.openLogin('登录后可查看设备台账与运行状态')
}
</script>

<template>
  <!-- 未登录：台账接口要 Bearer，先引导登录 -->
  <div v-if="!auth.isLoggedIn" class="data-empty" data-empty="equip">
    <p>登录后可查看设备台账与运行状态</p>
    <button class="data-empty-btn" type="button" @click="goLogin">去登录</button>
  </div>

  <!-- 已登录但台账没到手：区分同步中 / 失败 / 确实没有 -->
  <template v-else-if="!ledger.hasData">
    <!--
      慢请求：在数据将要出现的位置铺灰条（统计卡 + 4 张设备卡），
      结构与下面真实内容一一对应，台账到手后原位回填、高度不变。
      `is-on` 之前整层是 opacity: 0 —— 占位先撑住版式，但灰条要等
      SKEL_DELAY 之后才淡入，快请求就完全看不到这一层。
    -->
    <template v-if="ledger.state === 'loading'">
      <span class="sr-only" role="status">正在加载设备台账</span>
      <div class="home-stats alarm-row skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <div class="home-chart-card eq-count">
          <!-- 尺寸照真实元素量的（b 22px / span 11px），回填时高度一像素不跳 -->
          <div class="eq-count-item"><Skel w="56px" h="22px" r="var(--r-6)" /><Skel w="44px" h="11px" /></div>
          <div class="eq-count-item"><Skel w="56px" h="22px" r="var(--r-6)" /><Skel w="44px" h="11px" /></div>
        </div>
        <div class="home-chart-card eq-status">
          <Skel w="46px" h="14px" />
          <div class="eq-status-body">
            <Skel w="40px" h="40px" circle />
            <div class="eq-status-leg">
              <div class="skel-leg-row"><Skel w="8px" h="8px" circle /><Skel w="24px" h="10px" /><Skel w="14px" h="12px" /></div>
              <div class="skel-leg-row"><Skel w="8px" h="8px" circle /><Skel w="24px" h="10px" /><Skel w="14px" h="12px" /></div>
            </div>
          </div>
        </div>
      </div>
      <div class="eq-grid skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="eq-card">
          <span class="eq-ico"><Skel w="36px" h="36px" r="var(--r-8)" /></span>
          <span class="eq-main">
            <span class="eq-hd"><Skel w="78px" h="17px" /></span>
            <!-- 两列数值格与真实卡同构（数字 28 + 间距 4 + 标签 16 = 48px） -->
            <span class="eq-vals">
              <span class="eq-val"><Skel w="46px" h="28px" r="var(--r-6)" /><Skel class="skel-mt-sm" w="40px" h="16px" /></span>
              <span class="eq-val"><Skel w="46px" h="28px" r="var(--r-6)" /><Skel class="skel-mt-sm" w="40px" h="16px" /></span>
            </span>
          </span>
        </div>
      </div>
    </template>
    <div v-else-if="ledger.state === 'error'" class="data-empty" data-empty="equip">
      <p>{{ ledger.error || '设备台账加载失败' }}</p>
      <button class="data-empty-btn" type="button" @click="retry">重试</button>
    </div>
    <div v-else class="data-empty" data-empty="equip">
      <p>暂无设备台账数据</p>
    </div>
  </template>

  <template v-else>
    <div class="home-stats alarm-row fill-in">
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

    <div class="eq-grid fill-in">
      <button
        v-for="d in home.siteEquip"
        :key="d.id"
        class="eq-card drill"
        :class="d.id === 'crane' ? 'is-crane' : ''"
        type="button"
        :data-page="pageOf(d)"
        :aria-label="`${d.name}，点击进入详情`"
        @click="onCard(d)"
      >
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
            <span class="eq-val eq-online" :class="{ 'is-off': !home.equipCount(d).on }">
              <b><em>{{ home.equipCount(d).on }}<i>/{{ home.equipCount(d).total }}</i></em></b>
              <span>{{ onlineLabel(d) }}</span>
            </span>
            <!-- 数值位只放台账里真有的字段（高度）；没有就整格不渲染，不塞占位符 -->
            <span v-if="d.value" class="eq-val">
              <b>{{ d.value }}</b>
              <span>{{ d.metric }}</span>
            </span>
          </span>
        </span>
        <span class="eq-more" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg></span>
      </button>
    </div>
  </template>
</template>
