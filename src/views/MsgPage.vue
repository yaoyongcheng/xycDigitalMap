<script setup lang="ts">
import Skel from '@/components/ui/Skel.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useMsgStore, type MsgCategory } from '@/stores/msg'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { useSlowLoading } from '@/utils/slowLoading'
import { useTabRefresh } from '@/utils/tabRefresh'
import { computed, onMounted } from 'vue'
import type { IconName } from '@/data/icons'

/**
 * 消息页（2026-11-20 改为**两类预警**）
 *
 * 设计稿消息页是「分类卡」而不是「一条一条消息」：原本两行是随手拍预警 /
 * 巡检预警。按现场要求（2026-11-20）：
 *   · 去掉随手拍（没接入，也不打算接）；
 *   · 巡检预警拆成 **监控预警** 与 **无人机预警** 两类 ——
 *     前者还是 `:8085` 视频报警（原数据源不动），后者接 keehang 审核中心的
 *     AI 工单（= V2 大屏「工单列表」，见 `stores/droneAlarm.ts`）。
 *
 * 所以这一页只做两件事：把两类的「几条待处理 + 最新时间」摆出来、点开进各自列表。
 * 明细（分页、状态展示、日历）都在子页里，不在这里重复一套。
 *
 * 2026-11-24：数字口径统一为**今日待处理**（监控 `handleStatus !== 1`、
 * 无人机 `UNAUDITED`），两张卡同一标签、同一红色徽标；底栏角标是两者之和。
 * 这一页不提供任何状态变更操作（「一键已读」已下线），状态只读。
 */
const msg = useMsgStore()
const shell = useShellStore()
const auth = useAuthStore()
const subpage = useSubpageStore()
const alarm = useAlarmStore()
const drone = useDroneAlarmStore()

/** 分类卡的图标：监控用摄像机、无人机用无人机（都在 data/icons.ts 里） */
const catIcon: Record<MsgCategory['id'], IconName> = {
  monitor: 'work-cam',
  drone: 'drone',
}

/**
 * 首屏同步慢时在列表原位铺灰条 —— 数据还没回来就断言「暂无预警」是错的。
 *
 * 判据：监控首屏还在转、且无人机那边连「今日几条待处理」都还没拿到。任意一侧
 * 有了结论就先立卡（先看到已知的那一侧，比干等两边一起到好）。
 */
const pendingSkel = computed(
  () => !alarm.hasLive && alarm.liveState === 'loading' && !drone.todayKnown,
)

/**
 * 灰条只在**真的慢**的时候淡入（`useSlowLoading` 280ms）：内网快请求全程
 * 看不到灰条。注意灰条位本身在 `pendingSkel` 期间一直占着（`.skel-fade`
 * 是 opacity 过渡），不是「先出内容再换成灰条」—— 那等于往回退一步。
 */
const showSkel = useSlowLoading(() => pendingSkel.value)

/**
 * 刷新后直接落在消息 tab 时，两边的首屏同步可能都还没跑过。
 * `syncFromVideo` 自带 loading / 失败冷却，`drone.load()` 自带去重 —— 重复调用无副作用。
 */
onMounted(() => {
  if (auth.token && !alarm.hasLive && alarm.liveState !== 'loading') {
    void alarm.syncFromVideo(auth.token)
  }
  if (auth.token) void drone.load()
})

/**
 * 每次切回消息 tab 补一次。
 *
 * 这一页是**常驻挂载**的（用 `.active` 切显隐），`onMounted` 一辈子只跑一次；
 * 而底栏角标读的就是这两份数据 —— 不补的话早上点开的数字会一直挂到晚上。
 *
 * 2026-11-24：改用 `useTabRefresh` + `alarm.refresh()`。原来这里走的是
 * `syncFromVideo` 且带「已有数据就跳过」的判断，等于**从别的 tab 切回来
 * 从不刷新**（首屏已经拿到数据了）—— 「今日待处理」会一直停在旧值上。
 * `refresh()` 是 force 语义（失败冷却仍生效），在途时自动并成同一趟请求；
 * 无人机侧走 `load(true)` 强制重扫 —— 它有 2 分钟保鲜，不 force 的话
 * 「切回消息 tab 一定刷新」就落不了地（工单状态由审核平台推进，需要看到最新值）。
 */
function reloadTab(): void {
  if (!auth.token) return
  void alarm.refresh(auth.token)
  void drone.load(true)
}

useTabRefresh('msg', reloadTab)

function onItemClick(c: MsgCategory): void {
  if (!auth.isLoggedIn) {
    subpage.openLogin('登录后可查看现场预警消息')
    return
  }
  if (c.id === 'drone') {
    subpage.openWorkOrders()
    return
  }
  subpage.openInspectList('today')
}

function onItemKey(e: KeyboardEvent, c: MsgCategory): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onItemClick(c)
  }
}

function goLogin(): void {
  subpage.openLogin('登录后可查看现场预警消息')
}

/** 卡片右侧数字：还没拿到数据时写「—」，不写 0（0 是个结论） */
function badgeOf(c: MsgCategory): string {
  if (!c.count) return ''
  return c.count > 99 ? '99+' : String(c.count)
}
</script>

<template>
  <section
    class="page"
    id="page-msg"
    :class="{ active: shell.activeTab === 'msg' }"
  >
    <!-- 未登录：仍然是明确的一句话 + 去登录，不铺分类卡（点开也是空的） -->
    <div v-if="!auth.isLoggedIn" class="data-empty" data-empty="msg">
      <p>登录后可查看现场预警消息</p>
      <button class="data-empty-btn" type="button" @click="goLogin">去登录</button>
    </div>

    <template v-else-if="pendingSkel">
      <span class="sr-only" role="status">正在同步现场预警消息</span>
      <div
        class="card msg-list skel-fade"
        :class="{ 'is-on': showSkel }"
        data-skel="msg"
        aria-hidden="true"
      >
        <div v-for="i in 2" :key="i" class="msg-item">
          <div class="msg-ico"><Skel w="44px" h="44px" r="var(--r-12)" /></div>
          <div class="meta">
            <Skel w="96px" h="14px" />
            <Skel class="skel-mt-sm" w="72%" h="11px" />
          </div>
          <div class="msg-side"><Skel w="38px" h="10px" /></div>
        </div>
      </div>
    </template>

    <div v-else class="msg-stream">
      <div class="card msg-list" id="msgList">
        <div
          v-for="c in msg.categories"
          :key="c.id"
          class="msg-item is-link"
          :data-kind="c.id"
          role="button"
          tabindex="0"
          @click="onItemClick(c)"
          @keydown="onItemKey($event, c)"
        >
          <div class="msg-ico" :class="c.id === 'monitor' ? 'cam' : 'drone'">
            <SvgIcon :name="catIcon[c.id]" />
          </div>
          <div class="meta">
            <h4>{{ c.title }}</h4>
            <p>{{ c.desc }}</p>
          </div>
          <div class="msg-side">
            <span class="msg-time">{{ c.time }}</span>
            <!-- 两张卡口径一致：数字旁边写「今日待处理」，单摆一个 3 读不出
                 是待处理还是今日总数；都是待处理，都用同一个强调色徽标 -->
            <span class="msg-count">
              <span v-if="c.hint" class="msg-hint">{{ c.hint }}</span>
              <b
                v-if="badgeOf(c)"
                class="msg-badge"
              >{{ badgeOf(c) }}</b>
              <!-- 条数还没拿到：写「—」，不写 0（0 是个结论，这里只是还不知道） -->
              <span v-else-if="!c.known" class="msg-unknown">—</span>
            </span>
          </div>
        </div>
      </div>

      <!--
        两类都为空时才说「暂无预警」。数据没取到时由各自的列表页说明原因
        （监控：同步失败；无人机：接口报错），这里不替它们下结论。
      -->
      <p v-if="msg.isEmpty" class="msg-empty-note">暂无预警消息</p>
    </div>
  </section>
</template>
