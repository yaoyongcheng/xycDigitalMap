<script setup lang="ts">
import { useMsgStore } from '@/stores/msg'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { msgIco } from '@/data/icons'

/**
 * 消息页
 *
 * 对应原 index.html:296-298（空壳）+ renderMsgs()（app.js:641-654）
 * + 列表点击委托（app.js:877-881）。
 *
 * 原版通过 innerHTML 全量重渲染，这里改为 v-for；
 * 图标字符经 v-html 输出，保证 DOM 逐字节一致。
 */
const msg = useMsgStore()
const shell = useShellStore()
const subpage = useSubpageStore()

function onItemClick(kind: string): void {
  // 原版仅「巡检预警」可点，其余为普通展示项
  if (kind === 'inspect') subpage.openInspectList('today')
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
        @click="onItemClick(m.kind)"
      >
        <div class="msg-ico" :class="m.kind" v-html="msgIco[m.kind]" />
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
