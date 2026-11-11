<script setup lang="ts">
import Skel from '@/components/ui/Skel.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useMsgStore } from '@/stores/msg'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { useSlowLoading } from '@/utils/slowLoading'
import { onMounted } from 'vue'
import type { IconName } from '@/data/icons'
import type { Message } from '@/types'

/**
 * 消息页（2026-11 阶段 5：改真实报警派生；阶段 6：下滑加载更多）
 *
 * 原先渲染 2 条写死消息，点「巡检预警」跳巡检列表。现在一条真实报警一条
 * 消息，点开跳对应报警详情；没有报警数据时给明确空态（未登录给去登录），
 * 不再用「人员预警」这种编造条目把页面填满。
 *
 * 报警首屏同步 400 条、现场全量 1800+，列表按 20 条一屏展开：滚到底自动
 * 追加一屏，本机数据见底了再让 alarm store 去拉下一页。列表不足一屏时，
 * 底部「还有 N 条」按钮也是可点的入口（键盘 / 无滚动场景）。
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

/** 翻下一页同样按支付宝口径：快请求不闪，慢请求才在列表末尾铺同构灰条 */
const showMoreSkel = useSlowLoading(() => msg.loadingMore)

/** 消息类型 → 图标名；video 是现场视频报警，用工作台那套监控图标 */
const msgIcon: Record<Message['kind'], IconName> = {
  people: 'msg-people',
  inspect: 'drone',
  video: 'work-cam',
}

/** 触底阈值：离底 160px 就提前拉，别等用户滑到卡住才转圈 */
const BOTTOM_AHEAD = 160

/**
 * 刷新后直接落在消息 tab 时，报警首屏同步可能还没跑过（它原先挂在首页面板上）。
 * 这里补一次，否则列表会停在「暂无消息」，而服务端其实有上千条。
 * `syncFromVideo` 自带 loading / 60s 失败冷却，重复调用无副作用。
 */
onMounted(() => {
  if (auth.token && !alarm.hasLive && alarm.liveState !== 'loading') {
    void alarm.syncFromVideo(auth.token)
  }
})

function requestMore(): void {
  // token 显式传入：未登录时 loadMore 会在 store 里直接返回，不打带空 Bearer 的请求
  void msg.loadMore(auth.token)
}

function onScroll(e: Event): void {
  const el = e.currentTarget as HTMLElement | null
  if (!el) return
  // 列表变高后 scrollHeight 会跟着涨，一次触底只追加一屏，不会连锁拉完全量
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_AHEAD) requestMore()
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
  <section
    class="page"
    id="page-msg"
    :class="{ active: shell.activeTab === 'msg' }"
    @scroll.passive="onScroll"
  >
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
    <div v-else class="msg-stream">
      <div class="card msg-list" id="msgList">
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

      <!-- 下滑加载的四态：加载中 / 失败可重试 / 还有更多 / 已到底 -->
      <div v-if="msg.loadingMore" class="msg-more" data-more="loading">
        <span role="status">正在加载更多消息…</span>
        <div
          v-if="showMoreSkel"
          class="card msg-list msg-more-skel"
          data-skel="msg-more"
          aria-hidden="true"
        >
          <div v-for="i in 2" :key="i" class="msg-item">
            <div class="msg-ico"><Skel w="36px" h="36px" circle /></div>
            <div class="meta">
              <Skel w="116px" h="14px" />
              <Skel class="skel-mt-sm" w="78%" h="11px" />
            </div>
            <div class="msg-side"><Skel w="38px" h="10px" /></div>
          </div>
        </div>
      </div>
      <div v-else-if="msg.loadError" class="msg-more" data-more="error">
        <span>{{ msg.loadError }}</span>
        <button class="msg-more-btn" type="button" @click="requestMore">重试</button>
      </div>
      <div v-else-if="msg.hasMore" class="msg-more" data-more="more">
        <button class="msg-more-btn" type="button" @click="requestMore">
          还有 {{ msg.hiddenCount }} 条，点击或下滑加载
        </button>
      </div>
      <div v-else class="msg-more is-end" data-more="end">
        已显示全部 {{ msg.messages.length }} 条消息
      </div>
    </div>
  </section>
</template>
