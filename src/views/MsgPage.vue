<script setup lang="ts">
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useMsgStore } from '@/stores/msg'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import type { IconName } from '@/data/icons'
import type { Message } from '@/types'

/**
 * 消息页
 *
 * 对应原 index.html:296-298（空壳）+ renderMsgs()（app.js:641-654）
 * + 列表点击委托（app.js:877-881）。
 *
 * 原版通过 innerHTML 全量重渲染，这里改为 v-for；
 * 图标几何见 data/icons.ts，由 SvgIcon 直出 SVG 元素（不再走 v-html）。
 */
const msg = useMsgStore()
const shell = useShellStore()
const subpage = useSubpageStore()

/** 消息类型 → 图标名（原 msgIco；inspect 与工作台「航拍照片」共用 drone 几何） */
const msgIcon: Record<Message['kind'], IconName> = {
  people: 'msg-people',
  inspect: 'drone',
}

/** 键盘等价操作（Enter / Space）：消息条此前是裸 div + click，键盘不可达 */
function onItemKey(e: KeyboardEvent, kind: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onItemClick(kind)
  }
}

function onItemClick(kind: string): void {
  // 点击即视为已读：无论是否可进详情，该条未读都清掉，
  // tabbar 角标与列表内角标同步减少
  msg.markRead(kind as Message['kind'])
  if (kind === 'inspect') {
    subpage.openInspectList('today')
  } else {
    // 其余类型暂无详情页，给出口提示而非静默
    shell.showToast('该类消息详情接入中，敬请期待', 'info')
  }
}
</script>

<template>
  <section class="page" id="page-msg" :class="{ active: shell.activeTab === 'msg' }">
    <div class="card msg-list" id="msgList">
      <div
        v-for="(m, i) in msg.messages"
        :key="i"
        class="msg-item"
        :class="{ 'is-link': m.kind === 'inspect' }"
        :data-kind="m.kind"
        role="button"
        tabindex="0"
        @click="onItemClick(m.kind)"
        @keydown="onItemKey($event, m.kind)"
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
