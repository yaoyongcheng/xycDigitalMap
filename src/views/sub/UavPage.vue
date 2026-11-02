<script setup lang="ts">
import { computed, ref } from 'vue'

import { uavChecks, uavLive, uavTodayTasks } from '@/data/device'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useShellStore } from '@/stores/shell'

/**
 * 无人机页（2026-10 版本同步 · 第四批，原 js/app.js:755-955）
 *
 * 四块：实时监控（无人机 / 机库两路画面 + 抓拍录像）、任务管理、
 * 设备参数、任务下发（起飞条件校验 + 航线）。
 *
 * 起飞条件是硬门槛：五项里任何一项不过，下发按钮直接 disabled 并列出
 * 未通过的原因 —— 不做「点了才弹错」的二次拦截，用户在第一眼就知道
 * 现在飞不了、为什么飞不了。
 */
const shell = useShellStore()
const sheet = useBottomSheetStore()

/**
 * 实时画面用的静帧。
 *
 * 必须走绑定而不是写死 src="img/..."：模板里的静态 src 会被 Vite 当模块
 * 解析（相对 src/ 找文件），图片实际在 public/ 下，构建直接失败。
 */
const PANO = 'img/patrol-pano.webp'

/** 画面来源：无人机实拍 / 机库（机库还没接流，显示加载态） */
const tab = ref<'fly' | 'dock'>('fly')
const rec = ref(false)

const running = computed(() => uavTodayTasks.find((t) => t.state === '执行中'))
const doneCount = computed(() => uavTodayTasks.filter((t) => t.state === '已完成').length)

const risks = computed(() => uavChecks.filter((c) => !c.ok))
const canDispatch = computed(() => risks.value.length === 0)
const allowNote = computed(() => {
  if (canDispatch.value) return '起飞条件校验通过：风速、电量、网络、电池温度、雨量符合要求'
  const met = uavChecks.filter((c) => c.ok).map((c) => c.name)
  return met.length ? `已满足${met.join('、')}` : '当前条件不支持手动下发'
})

/** 设备参数八格（网络质量单独渲染成信号格） */
const stats = computed(() => [
  { v: '作业中', k: '状态' },
  { v: `${uavLive.battery}%`, k: '电量' },
  { v: '126m', k: '距机库' },
  { v: '22min', k: '续航' },
  { v: `${uavLive.wind}m/s`, k: '风速' },
  { v: '', k: '网络质量' },
  { v: `${uavLive.netKbps} kbps`, k: '网络速率' },
  { v: `${uavLive.temp}℃`, k: '电池温度' },
])

/** 阈值告警着色：告警值本身要看得出来（原 uavStatTone） */
function toneOf(v: string, k: string): string {
  const n = Number.parseFloat(v)
  if (Number.isNaN(n)) return ''
  if (k === '电量' && n < 30) return 'is-low'
  if (k === '风速' && n > 8) return 'is-low'
  if (k === '电池温度' && (n > 45 || n < 0)) return 'is-low'
  if (k === '网络速率' && n < 500) return 'is-low'
  return ''
}

function onShoot(): void {
  shell.showToast('已抓拍', 'success')
}

function onRec(): void {
  rec.value = !rec.value
  shell.showToast(rec.value ? '开始录像' : '录像已保存', rec.value ? 'info' : 'success')
}
</script>

<template>
  <div class="dev-page">
    <!-- 实时监控 -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>实时监控</h4>
        <div class="dev-tabs is-compact">
          <button type="button" :class="{ on: tab === 'fly' }" :aria-pressed="tab === 'fly'" @click="tab = 'fly'">无人机</button>
          <button type="button" :class="{ on: tab === 'dock' }" :aria-pressed="tab === 'dock'" @click="tab = 'dock'">机库</button>
        </div>
      </div>

      <div class="uav-stage" :class="{ 'is-wait': tab === 'dock' }">
        <img v-if="tab === 'fly'" :src="PANO" alt="无人机实时画面" />
        <template v-else>
          <span class="uav-spin" aria-hidden="true"></span>
          <p>视频加载中...</p>
        </template>

        <span class="uav-live" aria-hidden="true"><i></i>LIVE</span>

        <div class="uav-tools">
          <button type="button" aria-label="抓拍" @click="onShoot">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2h6l2 2h3v11H4z" /><circle cx="12" cy="13" r="3.2" /></svg>
            <span>抓拍</span>
          </button>
          <button type="button" :class="{ 'is-on': rec }" aria-label="录像" :aria-pressed="rec" @click="onRec">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>
            <span>录像</span>
          </button>
        </div>
      </div>

      <div class="uav-fly">
        <div><span>状态</span><b class="is-ok">作业中</b></div>
        <div><span>海拔</span><b>86.20m</b></div>
        <div><span>飞行距离</span><b>2.16km</b></div>
        <div><span>水平速度</span><b>4.2 m/s</b></div>
        <div><span>垂直速度</span><b>0.3 m/s</b></div>
      </div>
    </section>

    <!-- 任务管理 -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>任务管理</h4>
        <button class="dev-link" type="button" @click="sheet.openUavToday()">查看今日任务</button>
      </div>

      <div class="uav-stats">
        <div><b>{{ uavTodayTasks.length }}</b><span>今日任务</span></div>
        <div><b>{{ doneCount }}</b><span>已完成任务</span></div>
        <div><b>0</b><span>失败次数</span></div>
      </div>

      <div v-if="running" class="uav-mission">
        <div class="uav-mission-hd"><strong>当前巡检 · {{ running.name }}</strong><em>{{ running.pct }}%</em></div>
        <div class="dev-bar"><i :style="{ width: (running.pct ?? 0) + '%' }"></i></div>
        <p>08:30 起飞 · 已飞 8.4 分钟 · 预计 18 分钟</p>
      </div>
    </section>

    <!-- 设备参数 -->
    <section class="dev-block">
      <h4>设备参数</h4>
      <div class="uav-stats">
        <div v-for="s in stats" :key="s.k">
          <b v-if="s.k === '网络质量'" class="uav-sig" aria-label="网络质量良好"><i></i><i></i><i></i><i></i></b>
          <b v-else :class="toneOf(s.v, s.k)">{{ s.v }}</b>
          <span>{{ s.k }}</span>
        </div>
      </div>
    </section>

    <!-- 任务下发 -->
    <section class="dev-block">
      <div class="dev-hd">
        <h4>任务下发</h4>
        <em class="uav-gate" :class="{ 'is-bad': !canDispatch }">{{ canDispatch ? '可下发' : '不可下发' }}</em>
      </div>

      <p class="uav-allow">{{ allowNote }}</p>

      <ul v-if="risks.length" class="uav-risks">
        <li v-for="r in risks" :key="r.name">{{ r.risk }}</li>
      </ul>

      <button class="uav-send" type="button" :disabled="!canDispatch" @click="sheet.openUavRoute()">
        选择航线
      </button>
    </section>
  </div>
</template>
