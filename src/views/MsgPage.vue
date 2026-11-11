<script setup lang="ts">
import Skel from '@/components/ui/Skel.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useMsgStore } from '@/stores/msg'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { useSlowLoading } from '@/utils/slowLoading'
import type { IconName } from '@/data/icons'
import type { Message } from '@/types'

/**
 * 消息页（2026-11 阶段 5：改真实报警派生）
 *
 * 原先渲染 2 条写死消息，点「巡检预警」跳巡检列表。现在一条真实报警一条
 * 消息，点开跳对应报警详情；没有报警数据时给明确空态（未登录给去登录），
 * 不再用「人员预警」这种编造条目把页面填满。
 */
const msg = useMsgStore()
const shell = useShellStore()
const auth = useAuthStore()
const subpage = useSubpageStore()
const alarm = useAlarmStore()

/**
 * 消息来自 `:8085` 报警同步。首屏同步慢时在列表原位铺灰条，
 * 不能在数据还没回来时就断言「暂无消息」（0 是结论，不是加载态）。
 */
const showSkel = useSlowLoading(() => !alarm.hasLive && alarm.liveState === 'loading')

/** 消息类型 → 图标名；video 是现场视频报警，用工作台那套监控图标 */
const msgIcon: Record<Message['kind'], IconName> = {
  people: 'msg-people',
  inspect: 'drone',
  video: 'work-cam',
}

/** 键盘等价操作（Enter / Space）：消息条此前是裸 div + click，键盘不可达 */
function onItemKey(e: KeyboardEvent, m: Message): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onItemClick(m)
  }
}

function onItemClick(m: Message): void {
  // 点击即视为已读：tabbar 角标与列表内角标同步减少
  msg.markRead(m.id)
  if (m.kind === 'video') {
    subpage.openAlarmDetail(m.id, true)
  } else if (m.kind === 'inspect') {
    subpage.openInspectList('today')
  } else {
    shell.showToast('该类消息详情接入中，敬请期待', 'info')
  }
}

function goLogin(): void {
  subpage.openLogin('登录后可查看现场报警消息')
}
</script>

<template>
  <section class="page" id="page-msg" :class="{ active: shell.activeTab === 'msg' }">
    <template v-if="!alarm.hasLive && alarm.liveState === 'loading'">
      <span class="sr-only" role="status">正在同步现场报警消息</span>
      <div class="card msg-list skel-fade" :class="{ 'is-on': showSkel }" data-skel="msg" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="msg-item">
          <div class="msg-ico"><Skel w="36px" h="36px" circle /></div>
          <div class="meta">
            <Skel w="116px" h="14px" />
            <Skel class="skel-mt-sm" w="78%" h="11px" />
          </div>
          <div class="msg-side"><Skel w="38px" h="10px" /></div>
        </div>
      </div>
    </template>
    <div v-else-if="!msg.messages.length" class="data-empty" data-empty="msg">
      <p>{{ auth.isLoggedIn ? '暂无消息' : '登录后可查看现场报警消息' }}</p>
      <p v-if="auth.isLoggedIn" class="data-empty-sub">消息来自现场视频报警，有新的报警时会出现在这里。</p>
      <button v-if="!auth.isLoggedIn" class="data-empty-btn" type="button" @click="goLogin">去登录</button>
    </div>
    <div v-else class="card msg-list" id="msgList">
      <div
        v-for="m in msg.messages"
        :key="m.id"
        class="msg-item"
        :class="{ 'is-link': m.kind !== 'people' }"
        :data-kind="m.kind"
        :data-msg-id="m.id"
        role="button"
        tabindex="0"
        @click="onItemClick(m)"
        @keydown="onItemKey($event, m)"
      >
        <div class="msg-ico" :class="m.kind"><SvgIcon :name="msgIcon[m.kind]" /></div>
        <div class="meta">
          <h4>{{ m.title }}</h4>
          <p>{{ m.desc }}</p>
        </div>
        <div class="msg-side">
          <span class="msg-time">{{ m.time }}</span>
          <b v-if="m.unread" class="msg-badge">{{ m.unread }}</b>
        </div>
      </div>
    </div>
  </section>
</template>
