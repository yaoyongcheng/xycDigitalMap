<script setup lang="ts">
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAirHazardStore } from '@/stores/airHazard'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import type { IconName } from '@/data/icons'

/**
 * 工作台
 *
 * 对应原 index.html:235-294 + 快捷入口委托（app.js:997-1005）。
 * .work-short ×4 与 .tool-card ×3 均为逐字重复结构，改 v-for（渲染 DOM 相同）。
 *
 * 注：原版 3 个 .tool-card 在 JS 中无任何事件绑定（纯展示）；
 * 2026-10 改造补了「接入中」Toast 反馈作为点击出口（见 onToolClick）。
 * 图标几何见 data/icons.ts，由 SvgIcon 直出 SVG 元素（不再走 v-html）。
 *
 * ## 隐患上报暂缓（2026-11-19）
 *
 * 隐患上报的表单（拍照 / 类型 / 描述 / 提交）整套都做好了，但后端没有上报接口，
 * 提交只能「假装成功」—— 这比不提供更糟：用户以为报上去了，实际上没人能看到。
 * 现在按需求把它标成「功能待定」，点击只给一句说明，不再打开表单；
 * 表单本身（`HazardPage.vue` + `stores/airHazard.ts`）原样保留，二期接了接口
 * 把 `pending` 去掉、恢复 `air.openHazard()` 即可。
 */
const shell = useShellStore()
const cam = useCamStore()
const air = useAirHazardStore()
/*
 * 关于「切到工作台要不要刷新数据」：这一页**没有任何接口数据** ——
 * 四个快捷入口与两张工具卡都是 `data/config` 里的静态常量，页面上没有
 * 会过期的数字。所以这里不挂 `useTabRefresh`（挂了也只是空转一次）。
 * 等哪天这一页接了台账 / 待办计数，再把刷新接到对应 store 上。
 */

interface Shortcut {
  work: string
  color: string
  label: string
  icon: IconName
  /** 未上线标记；有值就只提示、不开功能 */
  pending?: string
}

const shorts: Shortcut[] = [
  { work: 'cam', color: 'blue', label: '视频监控', icon: 'work-cam' },
  { work: 'photo', color: 'green', label: '航拍照片', icon: 'drone' },
  { work: 'hazard', color: 'orange', label: '隐患上报', icon: 'work-hazard', pending: '功能待定' },
  { work: 'todo2', color: 'gray', label: '待定', icon: 'work-todo' },
]

const tools: { color: string; title: string; desc: string; icon: IconName }[] = [
  {
    color: 'blue',
    title: '垂直运输调度系统',
    desc: '施工电梯/塔机垂直运输调度',
    icon: 'tool-vertical',
  },
  {
    color: 'green',
    title: '水平调度系统',
    desc: '车辆出入场调度管理',
    icon: 'tool-horizontal',
  },
]

function onShortClick(work: string): void {
  // 原 app.js:997-1005 —— cam 打开首个点位，photo 开航拍，hazard 开隐患，其余提示待定
  // 监控点位现在是写死的白名单（data/cams.ts），不再依赖报警是否已同步；
  // 登录守卫仍在 openCam 里（未登录先去登录页）
  const s = shorts.find((x) => x.work === work)
  // 标了「待定」的入口一律只提示，不碰任何业务逻辑（不打开表单、
  // 不复位草稿、不发请求）—— 二期上线时把 pending 去掉即可
  if (s?.pending) {
    shell.showToast(`${s.label}${s.pending}，留待二期开发`, 'info', 2600)
    return
  }
  if (work === 'cam') cam.openCam()
  else if (work === 'photo') air.openAir()
  else shell.showToast('功能待定', 'info')
}

/** 键盘可达（工具卡是 div + role，补 tabindex 与回车/空格触发） */
function onToolKey(e: KeyboardEvent, title: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onToolClick(title)
  }
}

/**
 * 工具卡点击反馈（2026-10 改造新增）。
 * 原版 3 个 .tool-card 无任何事件绑定（纯展示），点击静默无反馈，
 * 现补「接入中」提示作为明确出口；接入后端后替换为真实跳转。
 */
function onToolClick(title: string): void {
  shell.showToast(`「${title}」接入中，敬请期待`, 'info')
}
</script>

<template>
  <section class="page work-page" id="page-work" :class="{ active: shell.activeTab === 'work' }">
    <div class="work-shorts" id="workShorts">
      <button
        v-for="s in shorts"
        :key="s.work"
        class="work-short"
        :class="{ 'is-pending': !!s.pending }"
        type="button"
        :data-work="s.work"
        :aria-label="s.pending ? `${s.label}（${s.pending}）` : undefined"
        @click="onShortClick(s.work)"
      >
        <i :class="s.color">
          <SvgIcon :name="s.icon" />
        </i>
        <span>{{ s.label }}</span>
      </button>
    </div>

    <div class="tool-list">
      <div
        v-for="t in tools"
        :key="t.title"
        class="tool-card"
        role="button"
        tabindex="0"
        @click="onToolClick(t.title)"
        @keydown="onToolKey($event, t.title)"
      >
        <div class="tool-ico" :class="t.color">
          <SvgIcon :name="t.icon" />
        </div>
        <div class="tool-meta">
          <strong>{{ t.title }}</strong>
          <p>{{ t.desc }}</p>
        </div>
        <span class="tool-arrow">›</span>
      </div>
    </div>
  </section>
</template>
