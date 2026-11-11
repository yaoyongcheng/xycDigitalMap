<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'

import Skel from '@/components/ui/Skel.vue'
import { useAuthStore } from '@/stores/auth'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useHomeStore } from '@/stores/home'
import { useSubpageStore } from '@/stores/subpage'
import { useSlowLoading } from '@/utils/slowLoading'

/**
 * 人员区域分布（2026-11 阶段 5：改真实区域台账）
 *
 * 原先是 5 个手写区域 + 三栋楼各 5 层人数，全部来自设计稿示意值。
 * 现在顶层列 `:8084 /api/data/areas` 的真实区域；**人数没有任何数据源**
 * （大屏 open 的 `location/*` 是 57007 无权限，`:8084` 的 Swagger 里
 * 20 个路由全是区域/楼栋/设备/房间 CRUD，没有人员定位接口），所以数字位
 * 一律显示「—」，并写明原因 —— 0 是个结论，此刻没资格下。
 *
 * 区域清单和首页常驻，不能等用户先点开智控面板（那才是台账的触发点）：
 * 本组件挂载即单独拉 `loadAreas()`，与设备台账互不牵连。慢请求在卡片位
 * 铺同构灰条，数据到达原位替换；失败才给原因 + 重试，加载中不先说「暂无」。
 *
 * 两级下钻的结构保留：区域台账没有楼层子数据，所以实际不会触发第二级，
 * 将来如果开放楼栋/楼层接口，往 PeopleNode.children 里灌真数据即可。
 */
const home = useHomeStore()
const auth = useAuthStore()
const ledger = useDeviceLedgerStore()
const subpage = useSubpageStore()

/** 面板挂载即拉一次；store 内部按 state 去重，失败不影响设备台账 */
onMounted(() => {
  if (auth.token) void ledger.loadAreas(auth.token)
})

/** 登录态后到（首页常驻，切 tab 只切 class）必须补拉，换账号强制刷新 */
watch(
  () => auth.token,
  (t) => {
    if (t) void ledger.loadAreas(t, true)
  },
)

const showSkel = useSlowLoading(() => !ledger.areas.length && ledger.areasState === 'loading')

const emptyText = computed(() => {
  if (!auth.isLoggedIn) return '登录后可查看项目区域台账'
  if (ledger.areasState === 'error') return `区域台账加载失败${ledger.areasError ? '：' + ledger.areasError : ''}`
  return '暂无项目区域数据'
})

function retry(): void {
  if (auth.token) void ledger.loadAreas(auth.token, true)
}

const drilled = computed(() => !!(home.peopleNode && home.peopleNode.children))
const floors = computed(() => home.peopleNode?.children ?? [])
const liveFloors = computed(() => floors.value.filter((n) => n.count).length)

function onBack(): void {
  home.peopleNode = null
}

function goLogin(): void {
  subpage.openLogin('登录后可查看项目区域台账')
}
</script>

<template>
  <!-- 下钻：楼层网格（真实区域台账目前没有楼层子数据） -->
  <template v-if="drilled">
    <button class="people-back" type="button" data-people="back" @click="onBack">
      <em>‹</em>
      <strong>{{ home.peopleNode?.name }}</strong>
      <b v-if="home.peopleNode?.count !== null">{{ home.peopleNode?.count }}<i>人</i></b>
      <b v-else>—<i>人</i></b>
    </button>
    <div class="people-sub">有人 {{ liveFloors }}层 · 共{{ floors.length }}层</div>
    <div class="people-floor-grid">
      <div v-for="n in floors" :key="n.id" class="people-floor" :class="{ empty: !n.count }">
        <span>{{ n.name }}</span>
        <b>{{ n.count ?? '—' }}</b>
      </div>
    </div>
  </template>

  <!-- 顶层：真实区域清单 -->
  <template v-else>
    <!--
      慢请求：灰条与 .people-zone 同构（同一 grid、同一 76px 卡高）。
      `is-on` 之前整层 opacity: 0 —— 先占位撑住版式，快请求看不到灰条，
      也不会在同步中先抛出「暂无项目区域数据」这个错误结论。
    -->
    <template v-if="!ledger.areas.length && ledger.areasState === 'loading'">
      <span class="sr-only" role="status">正在加载项目区域台账</span>
      <div class="people-zones skel-fade" :class="{ 'is-on': showSkel }" data-skel="people-dist" aria-hidden="true">
        <div v-for="i in 6" :key="i" class="people-zone">
          <Skel w="56px" h="13px" />
          <Skel w="30px" h="17px" r="var(--r-6)" />
        </div>
      </div>
    </template>
    <template v-else-if="home.peopleTree.length">
      <div class="data-note">人员实时定位接口未开放，仅展示项目区域台账</div>
      <div class="people-zones">
        <div v-for="n in home.peopleTree" :key="n.id" class="people-zone" :data-people="n.id">
          <span>{{ n.name }}</span>
          <b>—<em>人</em></b>
        </div>
      </div>
    </template>
    <div v-else class="data-empty" data-empty="people-dist">
      <p>{{ emptyText }}</p>
      <button
        v-if="auth.isLoggedIn && ledger.areasState === 'error'"
        class="data-empty-btn"
        type="button"
        @click="retry"
      >重试</button>
      <button v-else-if="!auth.isLoggedIn" class="data-empty-btn" type="button" @click="goLogin">去登录</button>
    </div>
  </template>
</template>
