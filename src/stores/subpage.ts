import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { useAlarmStore } from './alarm'
import type { DeviceKind } from '@/types'

/**
 * 子页栈
 *
 * 对应原 js/app.js 的 paintSub(803) / openSub(824) / openAlarmDetail(816)
 * / openInspectList(809) / closeSub(830) / pageHtml(846) / subBack(801)。
 *
 * 与原版的差异（行为等同，实现更明确）：
 *   原版 subBack 存的是「函数」（openInspectList 的引用），靠参数收到
 *   undefined 时的 if 守卫保持 inspTab 不变。这里改存「目标视图描述符」，
 *   语义相同但不再依赖参数巧合。
 *   原版该参数巧合还导致 closeSub(force) 被 #btnBack 传入事件对象时
 *   恒不等于 true（app.js:875）—— 这里 force 显式声明为 boolean，行为不变。
 */

/** 子页可显示的视图 */
export type SubView =
  | { kind: 'none' }
  | { kind: 'inspect-list' }
  | { kind: 'alarm-detail'; id: string }
  | { kind: 'placeholder'; name: string }
  /** 设备详情（智控里点塔机 / 电梯 / 无人机进入） */
  | { kind: 'device'; device: DeviceKind }
  /** 无人机（智控里点无人机进入） */
  | { kind: 'uav' }
  /** 智能爬架（2026-11 设计稿 gx2 版新增，机位读数列表） */
  | { kind: 'climb' }
  /** 报警预警历史（2026-11 设计稿 gx2 版新增，今日/历史两页签） */
  | { kind: 'alarm-hist' }
  /** 账号登录（2026-11 新增，「我的」入口，真实接口鉴权） */
  | { kind: 'login' }

export const useSubpageStore = defineStore('subpage', () => {
  const alarm = useAlarmStore()

  const view = ref<SubView>({ kind: 'none' })

  /** 上一级视图，对应原 subBack */
  const back = ref<SubView | null>(null)

  /**
   * 是否正在播放「退出」过渡（点返回 / 右滑返回）。
   *
   * App.vue 的 theme-color 用它提前切到目标页面的底色：iPhone 的系统状态栏
   * 区域不属于网页内容，只认 theme-color，等动画结束再切就会让顶部白一条。
   */
  const leaving = ref(false)

  /**
   * 打开登录页的原因文案（2026-11 新增）。
   *
   * 之前登录页只能从「我的」手动进入，未登录 / 会话过期时首页只剩一片空数字，
   * 用户不知道要去哪。现在空态里的「去登录」与 401 回调都会带一句原因进来，
   * 登录页顶部据此显示提示条（例如「登录已过期，请重新登录」）。
   */
  const loginNotice = ref('')

  /**
   * 登录成功后要恢复到的页面（支付宝式「登录后继续原操作」）。
   *
   * 用户点「历史」/「巡检列表」而没登录时，不是简单弹个登录页把他留在这里，
   * 而是记住目标视图：登录成功后就落到他本来想看的页面，不用再点一遍。
   * 用户主动取消登录时清空（不会在下次登录时莫名其妙跳页）。
   */
  const loginNext = ref<SubView | null>(null)

  /**
   * .subpage.is-alarm —— 控制深色导航栏与通栏 hero（CSS app.css:2357-2369）。
   *
   * 原版把 is-alarm 当作独立状态在 openAlarmDetail 加、在 openInspectList/
   * openSub/closeSub 里移除。实测它完全由当前视图决定，故这里改为派生：
   * 若照原版做成独立 ref，close() 回退到列表时就会忘记移除，导致列表页
   * 仍带深色导航栏与零 padding（实测确实复现过该 bug）。
   */
  const isAlarm = computed(() => view.value.kind === 'alarm-detail')

  /** .subpage.open */
  const isOpen = computed(() => view.value.kind !== 'none')

  /** 原 subTitle.textContent */
  const title = computed(() => {
    switch (view.value.kind) {
      case 'inspect-list':
        return '巡检预警'
      case 'alarm-detail':
        return '预警详情'
      case 'placeholder':
        return view.value.name
      case 'device':
        return view.value.device === 'crane' ? '5G塔机' : '智能电梯'
      case 'uav':
        return '无人机'
      case 'climb':
        return '智能爬架'
      case 'alarm-hist':
        return '报警预警'
      case 'login':
        return '账号登录'
      default:
        return ''
    }
  })

  /**
   * 深色子页（.subpage.is-dark）。
   *
   * 三个设备页与日报整页深色（设计稿的意图：设备数据是「监控台」，
   * 浅色底会让满屏指标反光）。与 isAlarm 一样做成派生而不是独立状态 ——
   * 原版在 openXxx 里加类、在 closeSub 里忘删过，回退时就会剩下一个
   * 深底浅字的列表页。
   */
  const isDark = computed(
    () =>
      view.value.kind === 'device' ||
      view.value.kind === 'uav' ||
      view.value.kind === 'climb',
  )

  /**
   * 原 openInspectList(tab)
   * 不传参时保持当前 inspTab（对应原版 tab 收到 undefined 时的守卫分支）
   */
  function openInspectList(tab?: 'today' | 'hist'): void {
    if (tab === 'today' || tab === 'hist') alarm.inspTab = tab
    back.value = null
    alarm.inspCalOpen = false
    view.value = { kind: 'inspect-list' }
  }

  /**
   * 原 openAlarmDetail(id, fromList)
   * fromList=true 时返回键回到巡检列表；也可显式指定返回目标
   * （报警历史页 / 按日 drill-in 页，原版收的是回跳函数）
   */
  function openAlarmDetail(id: string, from: boolean | SubView = true): void {
    if (!alarm.byId(id)) return
    back.value = from === false ? null : from === true ? { kind: 'inspect-list' } : from
    view.value = { kind: 'alarm-detail', id }
  }

  /** 打开报警预警历史（原 openAlarmHist，2026-11 设计稿 gx2 版） */
  function openAlarmHist(tab?: 'today' | 'hist'): void {
    if (tab === 'today' || tab === 'hist') alarm.histTab = tab
    alarm.histCalOpen = false
    back.value = null
    view.value = { kind: 'alarm-hist' }
  }

  /** 打开设备详情（原 openCranePage / openLiftPage / openUavPage） */
  function openDevice(device: DeviceKind): void {
    back.value = null
    view.value = { kind: 'device', device }
  }

  /** 打开无人机页 */
  function openUav(): void {
    back.value = null
    view.value = { kind: 'uav' }
  }

  /** 打开智能爬架页（原 openClimbPage，2026-11 设计稿 gx2 版） */
  function openClimb(): void {
    back.value = null
    view.value = { kind: 'climb' }
  }

  /** 原 openSub(title, html) —— 「我的」菜单入口，内容为占位文案 */
  function openSub(name: string): void {
    back.value = null
    view.value = { kind: 'placeholder', name }
  }

  /**
   * 打开账号登录页（2026-11 新增）。
   *
   * `notice` 是「为什么打开登录页」的一句话（未登录 / 登录已过期），
   * `next` 是登录成功后要恢复到的视图（例如用户点「历史」时被拦下来）。
   * 登录成功后由 `resumeAfterLogin()` 落到目标页，用户不用再点一遍。
   */
  function openLogin(notice = '', next: SubView | null = null): void {
    loginNotice.value = notice
    // 登录页本身、空视图都不作为「登录后恢复」的目标
    loginNext.value = next && next.kind !== 'none' && next.kind !== 'login' ? next : null
    back.value = null
    view.value = { kind: 'login' }
  }

  /**
   * 登录成功：恢复到被拦截的那个页面（没有目标就关掉登录页回到原 tab）。
   *
   * 由登录页在 `auth.login()` 成功后调用。刻意不在这里判断登录态 ——
   * 调用方（登录页）已经拿到了成功结果，多判断一次只会掩盖时序问题。
   */
  function resumeAfterLogin(): void {
    const next = loginNext.value
    loginNotice.value = ''
    loginNext.value = null
    // 恢复目标时保留 back=null：它是「用户想去的地方」，不是一次下钻
    back.value = null
    view.value = next ?? { kind: 'none' }
  }

  /**
   * 原 closeSub(force) —— 三级优先返回：
   *   ① 巡检日历展开时先收日历
   *   ② 有上一级则回退一级
   *   ③ 否则关闭子页
   */
  function close(force = false): void {
    if (!force && alarm.inspCalOpen) {
      alarm.inspCalOpen = false
      return
    }
    if (!force && alarm.histCalOpen) {
      alarm.histCalOpen = false
      return
    }
    if (!force && back.value) {
      view.value = back.value
      back.value = null
      return
    }
    back.value = null
    view.value = { kind: 'none' }
    loginNotice.value = ''
    loginNext.value = null
  }

  /**
   * 直接退出到根（2026-10 新增）。
   *
   * 与 close() 的区别是没有分级语义：底栏是根级导航，用户点 tab 就是想
   * 去另一个一级页面，不该先「收日历 → 回列表 → 再关闭」地倒退三步。
   *
   * 之前缺这一步，点 tab 后 .subpage 仍 open、盖在 .pages 上，activeTab
   * 其实已经变了 —— 表现就是「点底栏没反应」。
   */
  function dismiss(): void {
    // 本来就在根上就别再写一遍，免得每次点 tab 都触发一次无意义更新
    if (view.value.kind === 'none' && !back.value && !alarm.inspCalOpen && !alarm.histCalOpen) return
    alarm.inspCalOpen = false
    alarm.histCalOpen = false
    back.value = null
    view.value = { kind: 'none' }
    loginNotice.value = ''
    loginNext.value = null
  }

  return {
    view,
    back,
    leaving,
    loginNotice,
    loginNext,
    resumeAfterLogin,
    isAlarm,
    isDark,
    isOpen,
    title,
    openInspectList,
    openAlarmDetail,
    openAlarmHist,
    openDevice,
    openUav,
    openClimb,
    openSub,
    openLogin,
    close,
    dismiss,
  }
})
