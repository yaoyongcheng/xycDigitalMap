import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import SmartImg from '@/components/ui/SmartImg.vue'
import TabBar from '@/components/shell/TabBar.vue'
import Toast from '@/components/shell/Toast.vue'
import BackBar from '@/components/ui/BackBar.vue'
import SubPage from '@/components/overlays/SubPage.vue'
import { useAirHazardStore } from '@/stores/airHazard'
import { useAlarmStore } from '@/stores/alarm'
import { alarmFixtures } from '../fixtures/alarms'
import { useAuthStore } from '@/stores/auth'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { markSilentBack, resetBackSlot } from '@/utils/backAction'
import MinePage from '@/views/MinePage.vue'
import SafetyPanel from '@/views/home/SafetyPanel.vue'
import WorkPage from '@/views/WorkPage.vue'

/**
 * 交互优化回归（2026-10）
 *
 * 这一组钉住的是「操作繁琐 / 反馈缺失 / 状态不明确」三类问题的修复结果：
 *   - Toast 语义类型（成功与失败必须长得不一样）
 *   - 预警轮播点击直达详情（不再多走一步列表）
 *   - 隐患上报：选图被拒要给说法、描述要真的进载荷、提交要有 loading 与防连点
 *   - SmartImg 的占位 / 淡入 / 失败兜底
 *   - 退出登录的二次确认
 * 这些都是「改错了不报错、但用户会明显感到别扭」的类型，必须有回归。
 */

/**
 * 让首页面板以「已登录」渲染。
 *
 * 2026-11 起未登录时首页不拉报警、只显示「去登录」引导卡 —— 这是产品行为，
 * 所以涉及报警轮播的用例必须先有会话。`fetch` 一并 stub 掉：syncFromVideo
 * 在挂载时就会打请求，不能让用例真的发网络。
 */
function signIn(): void {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.expiresAt = Date.now() + 3_600_000
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }) as unknown as Response),
  )
}

/** 够真的 File 替身：happy-dom 的 File 够用，这里只要 type 可控 */
function fakeFile(name: string, type: string): File {
  return new File(['x'], name, { type })
}

describe('交互优化回归', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 16, 15, 30, 0))
    setActivePinia(createPinia())
    // 报警只存接口数据，用例注入夹具（生产代码里没有演示种子）
    useAlarmStore().liveAlarms = alarmFixtures()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    // 转场用例用 attachTo 挂到 body 上（SubPage 靠 #subpage 定位当前层）。
    // 不清会残留多个 #subpage，getElementById 取到上一个用例的旧节点。
    document.body.innerHTML = ''
  })

  describe('Toast 语义类型', () => {
    it('默认类型是 info，停留时长保持原版 1.6s', () => {
      const shell = useShellStore()
      shell.showToast('功能待定')
      expect(shell.toastType).toBe('info')
      vi.advanceTimersByTime(1599)
      expect(shell.toastVisible).toBe(true)
      vi.advanceTimersByTime(1)
      expect(shell.toastVisible).toBe(false)
    })

    it('可指定类型与时长，长提示不会 1.6s 就被掐掉', () => {
      const shell = useShellStore()
      shell.showToast('已填内容将丢失', 'warn', 2500)
      expect(shell.toastType).toBe('warn')
      vi.advanceTimersByTime(2000)
      expect(shell.toastVisible).toBe(true)
      vi.advanceTimersByTime(500)
      expect(shell.toastVisible).toBe(false)
    })

    it('渲染出对应语义的图标与配色类', async () => {
      const shell = useShellStore()
      const w = mount(Toast)
      shell.showToast('隐患已上报', 'success')
      await nextTick()
      expect(w.find('.toast').classes()).toContain('is-success')
      expect(w.find('svg').exists()).toBe(true)
    })
  })

  describe('预警轮播直达详情', () => {
    it('点击轮播条目直接打开对应预警详情，而不是落到列表', async () => {
      signIn()
      const w = mount(SafetyPanel)
      await nextTick()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()

      /*
       * 选择器排除 `[data-clone]`：轮播首尾各有一张副本页做无缝循环
       * （见 AlarmFeed.vue 的 `slides` 注释），DOM 里第一张 `.alarm-feed-page`
       * 是**末页副本**，拿它当"第一页"会选到末页的条目。
       * 断言的是「点第一条报警进它的详情」，所以这里必须锁定真实第一页。
       */
      await w.find('.alarm-feed-page:not([data-clone]) .alarm-feed-item').trigger('click')
      expect(sub.view).toEqual({ kind: 'alarm-detail', id: alarm.latest[0].id })
      /*
       * 返回键回首页，不回巡检列表：用户是从首页安全面板点进来的，
       * 上一页就是首页。凭空插一层列表会让人觉得迷路（2026-10 修正）。
       */
      expect(sub.back).toBeNull()
    })

    it('id 失效时退回列表，不让用户卡在空详情页', async () => {
      const w = mount(SafetyPanel)
      const sub = useSubpageStore()
      sub.openAlarmDetail('no-such-id')
      expect(sub.view).toEqual({ kind: 'none' })
      expect(w.exists()).toBe(true)
    })
  })

  /**
   * 预警轮播的双向循环（2026-11 修复）
   *
   * 旧实现只在轨道末尾补了一张首页副本：往后翻能绕回开头，往前翻到第一页就
   * 被 `target < 0 → go(0)` 夹住，手指继续右滑毫无反应 —— 这就是现场反馈的
   * 「卡在某一页滑不动」。这组用例按「手指在屏幕上真实滑动」的顺序派发指针事件，
   * 断言圆点与轨道位置在**两个方向上都能一直滑下去且不跑偏**。
   */
  describe('预警轮播双向循环', () => {
    /** happy-dom 没有指针捕获实现，桩掉（组件只拿它兜住"手指划出边界"） */
    function stubCapture(): void {
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>
      proto.setPointerCapture ??= () => {}
      proto.releasePointerCapture ??= () => {}
      proto.hasPointerCapture ??= () => true
    }

    /**
     * 一次完整的滑动手势：按下 → 移动 → 抬起（dx 为正 = 手指右滑 = 回上一页）。
     *
     * 末尾 `await nextTick()`：翻页只改 `idx` 与轨道内联样式，圆点是模板里
     * 按 `dotOf(idx)` 算出来的，不等 Vue 刷新就读 DOM 会读到上一帧。
     */
    async function swipe(win: Element, from: number, to: number): Promise<void> {
      for (const [type, x] of [
        ['pointerdown', from],
        ['pointermove', to],
        ['pointerup', to],
      ] as const) {
        const e = new Event(type, { bubbles: true })
        Object.assign(e, { clientX: x, clientY: 200, pointerId: 1 })
        win.dispatchEvent(e)
      }
      await nextTick()
    }

    /** 当前激活的圆点序号（-1 = 一个都没亮，即状态失配） */
    function activeDot(w: ReturnType<typeof mount>): number {
      return w.findAll('.alarm-feed-dot').findIndex((d) => d.classes().includes('on'))
    }

    function trackStyle(w: ReturnType<typeof mount>): string {
      return w.find('.alarm-feed-track').attributes('style') ?? ''
    }

    beforeEach(() => {
      stubCapture()
    })

    it('第一页继续右滑会接上最后一页，而不是顶死不动', async () => {
      signIn()
      const w = mount(SafetyPanel)
      await nextTick()
      // 夹具 4 条今日报警 ÷ 3 条一页 = 2 页，起始停在真实第 1 页
      expect(w.findAll('.alarm-feed-page').length).toBe(4) // 2 真实 + 2 副本
      expect(activeDot(w)).toBe(0)

      const win = w.find('.alarm-feed-win').element
      await swipe(win, 200, 300)
      // 右滑一页 → 落到「末页副本」上，圆点换算成最后一页
      expect(activeDot(w)).toBe(1)

      // 吸附动画播完 + 回卷到等价的真实末页：圆点不变，轨道落在真实下标 2 上
      vi.advanceTimersByTime(500)
      await nextTick()
      expect(activeDot(w)).toBe(1)
      expect(trackStyle(w)).toContain('translateX(-50%)') // 2 / 4 页

      // 再右滑一页回到第一页 —— 证明「往回滑」这条路是通的
      await swipe(win, 200, 300)
      expect(activeDot(w)).toBe(0)
      expect(trackStyle(w)).toContain('translateX(-25%)') // 1 / 4 页
    })

    it('最后一页继续左滑会绕回第一页，并且不会滑进空白', async () => {
      signIn()
      const w = mount(SafetyPanel)
      await nextTick()

      const win = w.find('.alarm-feed-win').element
      await swipe(win, 300, 200)
      expect(activeDot(w)).toBe(1) // 第 2 页
      vi.advanceTimersByTime(500)
      await nextTick()

      // 末页再左滑 → 停在「首页副本」，圆点已换算成第 1 页
      await swipe(win, 300, 200)
      expect(activeDot(w)).toBe(0)
      vi.advanceTimersByTime(500)
      await nextTick()
      // 关键：回卷后必须停在真实首页（下标 1），而不是留在副本（下标 3）
      expect(trackStyle(w)).toContain('translateX(-25%)')

      // 回卷后继续左滑仍然正常翻页 —— 旧实现正是在这一步滑进不存在的下标
      await swipe(win, 300, 200)
      expect(activeDot(w)).toBe(1)
    })

    it('位移不足阈值时回弹，不翻页也不改变轨道位置', async () => {
      signIn()
      const w = mount(SafetyPanel)
      await nextTick()

      const win = w.find('.alarm-feed-win').element
      await swipe(win, 200, 205) // 5px < CLICK_SLOP，按点击处理
      expect(activeDot(w)).toBe(0)
      expect(trackStyle(w)).toContain('translateX(-25%)')
    })
  })

  /*
   * 返回按钮 2026-10 统一：改造前子页是纯箭头、播放器与全屏地图是
   * 「箭头 + 返回」二字，同一动作三种长相。现在几何全部来自
   * data/icons.ts 的 back（同一份 IconDef），这里钉住渲染结果。
   */
  describe('返回按钮统一为纯左箭头', () => {
    it('播放器返回栏：只有箭头，没有「返回」文字', () => {
      const w = mount(BackBar, { props: { title: '视频监控', backId: 'btnCamBack' } })
      const btn = w.find('#btnCamBack')
      expect(btn.text()).toBe('')
      expect(btn.find('svg path').attributes('d')).toBe('M15 5 8 12l7 7')
      expect(btn.attributes('aria-label')).toBe('返回')
      // 右滑手势靠 data-back 定位该层的返回按钮
      expect(btn.attributes('data-back')).toBeDefined()
    })

    it('子页导航栏：同一套箭头几何，且带 data-back', () => {
      const w = mount(SubPage)
      const btn = w.find('#btnBack')
      expect(btn.text()).toBe('')
      expect(btn.find('svg path').attributes('d')).toBe('M15 5 8 12l7 7')
      expect(btn.attributes('data-back')).toBeDefined()
    })
  })

  /*
   * 子页栈是同一个容器换内容，详情页右滑时露出的是 .pages（消息页）。
   * 「详情且上一层是列表」时 SubPage 会垫一层只读列表，保证右滑露出的
   * 页面与点返回键一致；其它情况（上一层是首页 / 列表页本身）不垫。
   */
  describe('右滑露出的上一层', () => {
    it('详情页 + 上一层是巡检列表 → 垫一层只读列表', () => {
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openInspectList('today')
      sub.openAlarmDetail(alarm.latest[0].id, true)

      const w = mount(SubPage)
      const under = w.find('.subpage-under')
      expect(under.exists()).toBe(true)
      expect(under.find('.nav-title').text()).toBe('巡检预警')
      // 垫底层不可交互，也不能被手势当成当前层
      expect(under.find('[data-back]').exists()).toBe(false)
    })

    it('从首页直进详情（上一层是首页）→ 不垫列表', () => {
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openAlarmDetail(alarm.latest[0].id, false)

      const w = mount(SubPage)
      expect(w.find('.subpage-under').exists()).toBe(false)
    })

    /*
     * 2026-11：报警预警历史页也能进详情（AlarmHist.vue 的 onItemOpen）。
     * 垫底层当时只认 inspect-list，这条路径的上一层没垫 —— 转场途中露出的是
     * .pages（首页），现场看到的就是「列表 ↔ 详情 切换闪一下首页」。
     */
    it('详情页 + 上一层是报警预警历史 → 也要垫一层只读历史页', () => {
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openAlarmHist('today')
      sub.openAlarmDetail(alarm.latest[0].id, { kind: 'alarm-hist' })

      const w = mount(SubPage)
      const under = w.find('.subpage-under')
      expect(under.exists()).toBe(true)
      expect(under.find('.nav-title').text()).toBe('报警预警')
      // 垫的确实是历史页本身，不只是个空壳
      expect(under.find('.alarm-hist-page').exists()).toBe(true)
      // 只读副本：没有返回按钮，也不参与键盘
      expect(under.find('[data-back]').exists()).toBe(false)
      expect(under.attributes('aria-hidden')).toBe('true')
    })

    it('未登录时垫底层不触发登录守卫（只有当前层能导航）', () => {
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openAlarmHist('today')
      sub.openAlarmDetail(alarm.latest[0].id, { kind: 'alarm-hist' })

      mount(SubPage)
      // AlarmHist 的 onMounted 守卫若在垫底层里生效，会把视图改成 login
      expect(sub.view.kind).toBe('alarm-detail')
    })
  })

  /*
   * 子页转场（微信式）：进入从右侧滑入，返回先滑出再切状态。
   * 「先动画后改状态」很容易被后续改动破坏成瞬切，必须钉住时序。
   * 注意 SubPage 用 #subpage 定位当前层，mount 需要 attachTo 才能命中。
   */
  describe('子页转场', () => {
    it('进入子页时播放从右滑入', async () => {
      const w = mount(SubPage, { attachTo: document.body })
      useSubpageStore().openInspectList('today')
      await nextTick()
      await nextTick()
      expect(w.find('#subpage').classes()).toContain('is-entering')
    })

    it('点返回先播滑出动画，动画结束才切回上一级', async () => {
      // 报警页要求登录（未登录会先跳登录页），转场用例需要在会话下跑
      signIn()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openInspectList('today')
      sub.openAlarmDetail(alarm.latest[0].id, true)
      const w = mount(SubPage, { attachTo: document.body })
      await nextTick()

      await w.find('#btnBack').trigger('click')
      expect(w.find('#subpage').classes()).toContain('is-leaving')
      // 滑出过程中仍是详情页（露出垫底的列表）
      expect(sub.view.kind).toBe('alarm-detail')
      /*
       * 详情 → 列表是「子页 → 子页」：目标页面顶部仍是白色导航栏，外壳不能
       * 提前切到一级页面形态，否则 theme-color 转深、首页底栏被放出来，
       * 手机上就是顶上一条黑、底下一块灰（2026-11 现场反馈）。
       */
      expect(sub.leaving).toBe(false)

      vi.advanceTimersByTime(220)
      await nextTick()
      expect(sub.view.kind).toBe('inspect-list')
      expect(w.find('#subpage').classes()).not.toContain('is-leaving')
      expect(sub.leaving).toBe(false)
    })

    it('浏览器返回（popstate）引起时立即落状态，不再补一段滑出', async () => {
      /*
       * 真机现场：详情页右滑 → 浏览器自己先演一遍转场 → 我们再把详情页滑出
       * 一次，看起来就是「页面还停在详情，闪一下才变成报警预警」。
       * 所以这条来源不补动画，其余（返回箭头 / 应用内手势）照旧。
       */
      signIn()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openInspectList('today')
      sub.openAlarmDetail(alarm.latest[0].id, true)
      const w = mount(SubPage, { attachTo: document.body })
      await nextTick()

      resetBackSlot()
      markSilentBack()
      await w.find('#btnBack').trigger('click')
      expect(w.find('#subpage').classes()).not.toContain('is-leaving')
      await nextTick()
      expect(sub.view.kind).toBe('inspect-list')
    })

    it('详情返回一级页面（上一级是首页）时才提前切外壳形态', async () => {
      signIn()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      // from=false：从首页轮播直进详情，返回目标是一级页面
      sub.openAlarmDetail(alarm.latest[0].id, false)
      const w = mount(SubPage, { attachTo: document.body })
      await nextTick()

      await w.find('#btnBack').trigger('click')
      expect(w.find('#subpage').classes()).toContain('is-leaving')
      // 这套形态由 App.vue 的 theme-color 与 app.css 的 is-swipe-back 规则消费
      expect(sub.leaving).toBe(true)

      vi.advanceTimersByTime(220)
      await nextTick()
      expect(sub.isOpen).toBe(false)
      expect(sub.leaving).toBe(false)
    })

    it('巡检日历展开时，返回只收日历、页面不滑出', async () => {
      signIn()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openInspectList('hist')
      alarm.inspCalOpen = true
      const w = mount(SubPage, { attachTo: document.body })
      await nextTick()

      await w.find('#btnBack').trigger('click')
      expect(alarm.inspCalOpen).toBe(false)
      expect(w.find('#subpage').classes()).not.toContain('is-leaving')
      expect(sub.isOpen).toBe(true)
    })

    /*
     * 返回一级页面时，滑出期间必须提前把底栏与状态栏切到「目标页面」形态，
     * 否则首页会看到上下白条闪一下（底部是 tabbar 隐藏后露出的浅色底、
     * 顶部是子页白色状态栏）。
     */
    it('返回一级页面期间给 .app 加 is-swipe-back，结束后撤掉', async () => {
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      // from=false：上一层是首页，返回目标是一级页面
      sub.openAlarmDetail(alarm.latest[0].id, false)

      const app = document.createElement('div')
      app.className = 'app home-mode'
      document.body.appendChild(app)

      const w = mount(SubPage, { attachTo: document.body })
      await nextTick()

      await w.find('#btnBack').trigger('click')
      expect(app.classList.contains('is-swipe-back')).toBe(true)

      vi.advanceTimersByTime(220)
      await nextTick()
      await nextTick()
      expect(app.classList.contains('is-swipe-back')).toBe(false)
    })

    /*
     * 子页 → 子页（详情回列表 / 回报警预警）不能切这套形态：目标页顶部仍是
     * 白色导航栏，切了 theme-color 变深、首页底栏放出来，手机上就是
     * 「顶上一条黑、底下一块灰」闪一下（2026-11 现场反馈）。
     */
    it('详情返回列表（上一层仍是子页）不加 is-swipe-back', async () => {
      signIn()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openInspectList('today')
      sub.openAlarmDetail(alarm.latest[0].id, true)

      const app = document.createElement('div')
      app.className = 'app home-mode'
      document.body.appendChild(app)

      const w = mount(SubPage, { attachTo: document.body })
      await nextTick()

      await w.find('#btnBack').trigger('click')
      expect(app.classList.contains('is-swipe-back')).toBe(false)
      expect(sub.leaving).toBe(false)
    })

    /*
     * 2026-11 现场问题：「右滑返回之后，第二次进入报警详情页会卡住」。
     *
     * 手机边缘侧滑被浏览器认领时只来一个 popstate，没有 pointerup —— 应用内
     * 手势已经把层位移过了，那份内联 transform 就永远留在 .subpage 上。
     * animation 优先级高于内联样式，所以进入动画播的时候看不出异常；动画一
     * 结束元素「啪」地跳回偏移位置，页面看起来就卡住不动了。
     */
    it('进入下一层时清掉手势残留的内联位移（否则动画结束会跳回偏移位）', async () => {
      signIn()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openAlarmHist('today')
      const w = mount(SubPage, { attachTo: document.body })
      await nextTick()

      const el = w.find('#subpage').element as HTMLElement
      // 模拟「手势被浏览器接管后」留下的半截位移
      el.style.transition = 'none'
      el.style.transform = 'translate3d(66px, 0, 0)'

      sub.openAlarmDetail(alarm.latest[0].id, { kind: 'alarm-hist' })
      await nextTick()
      await nextTick()

      expect(el.style.transform).toBe('')
      expect(el.style.transition).toBe('')
      // 进入动画照样要播
      expect(el.classList.contains('is-entering')).toBe(true)
    })

    /*
     * 同一场景的返回方向：位移只有 66px（没过半屏）时，那只是「拖到一半被
     * 打断」，不能当成「已经滑出去」直接瞬关 —— 否则这条路径上点返回永远没动画。
     */
    it('层只被拖到一半就点返回：仍播滑出动画，并清掉残留位移', async () => {
      signIn()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openAlarmHist('today')
      sub.openAlarmDetail(alarm.latest[0].id, { kind: 'alarm-hist' })
      const w = mount(SubPage, { attachTo: document.body })
      await nextTick()

      const el = w.find('#subpage').element as HTMLElement
      el.style.transition = 'none'
      el.style.transform = 'translate3d(66px, 0, 0)'

      await w.find('#btnBack').trigger('click')
      expect(el.classList.contains('is-leaving')).toBe(true)
      expect(el.style.transform).toBe('')
      expect(sub.view.kind).toBe('alarm-detail')
    })

    it('层已被手势推到屏幕外时，返回只落状态、不重复播动画', async () => {
      signIn()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openAlarmHist('today')
      sub.openAlarmDetail(alarm.latest[0].id, { kind: 'alarm-hist' })
      const w = mount(SubPage, { attachTo: document.body })
      await nextTick()

      const el = w.find('#subpage').element as HTMLElement
      // happy-dom 不做布局：把「已滑出」的几何位置补上，判断才走得通
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 390 })
      el.getBoundingClientRect = () =>
        ({ left: 390, top: 0, right: 780, bottom: 844, width: 390, height: 844, x: 390, y: 0 }) as DOMRect
      // 手势层滑出后置的是 100%（整层已在屏幕外）
      el.style.transition = 'none'
      el.style.transform = 'translate3d(100%, 0, 0)'

      await w.find('#btnBack').trigger('click')
      expect(el.classList.contains('is-leaving')).toBe(false)
      expect(el.style.transform).toBe('')
      expect(sub.view.kind).toBe('alarm-hist')
    })
  })

  /*
   * 子页是盖在 .pages 上的绝对定位层。改造前切 tab 只改 activeTab，
   * 子页不关 —— 底栏高亮变了、画面还停在详情页，用户看到的就是
   * 「点底栏没反应」。
   */
  describe('底栏切换会退出子页', () => {
    it('子页打开时点 tab：子页关闭且切到目标 tab', async () => {
      const sub = useSubpageStore()
      const shell = useShellStore()
      const alarm = useAlarmStore()
      sub.openAlarmDetail(alarm.latest[0].id, false)
      expect(sub.isOpen).toBe(true)

      const w = mount(TabBar)
      await w.find('.tab[data-tab="work"]').trigger('click')
      expect(sub.isOpen).toBe(false)
      expect(shell.activeTab).toBe('work')
    })

    it('巡检日历展开时切 tab，日历也被收起', async () => {
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openInspectList('hist')
      alarm.inspCalOpen = true

      const w = mount(TabBar)
      await w.find('.tab[data-tab="msg"]').trigger('click')
      expect(alarm.inspCalOpen).toBe(false)
      expect(sub.isOpen).toBe(false)
    })
  })

  describe('隐患上报', () => {
    it('选图被拒时回传拒绝数量与原因（原先是静默丢弃）', () => {
      const air = useAirHazardStore()
      expect(air.addHazardFiles([fakeFile('a.txt', 'text/plain'), fakeFile('b.png', 'image/png')])).toEqual({
        added: 1,
        rejectedType: 1,
        rejectedLimit: 0,
      })
      expect(air.addHazardFiles(Array.from({ length: 8 }, (_, i) => fakeFile(`${i}.png`, 'image/png')))).toEqual({
        added: 5,
        rejectedType: 0,
        rejectedLimit: 3,
      })
      expect(air.hazardImgs).toHaveLength(6)
    })

    it('描述文本进入提交载荷（原版「填了不读」已修正）', async () => {
      const air = useAirHazardStore()
      air.addHazardFiles([fakeFile('a.png', 'image/png')])
      air.hazardDesc = '  电缆拖地未架空  '

      const p = air.commitHazard()
      // 提交中：loading 标志必须立起来，用于按钮禁用 + 防连点
      expect(air.hazardSubmitting).toBe(true)

      await vi.advanceTimersByTimeAsync(600)
      const r = await p
      expect(r.ok).toBe(true)
      expect(air.hazardSubmitting).toBe(false)
      expect(air.lastSubmit).toMatchObject({ photos: 1, desc: '电缆拖地未架空' })
      expect(r.message).toContain('描述')
    })

    it('提交中重复点击不会重复提交', async () => {
      const air = useAirHazardStore()
      air.addHazardFiles([fakeFile('a.png', 'image/png')])
      const first = air.commitHazard()
      const second = await air.commitHazard()
      expect(second).toEqual({ ok: false, message: '正在提交，请勿重复点击' })
      await vi.advanceTimersByTimeAsync(600)
      await first
    })

    it('没有照片时仍然拒绝，且不进入 loading', async () => {
      const air = useAirHazardStore()
      air.hazardDesc = '只写了描述'
      const r = await air.commitHazard()
      expect(r).toEqual({ ok: false, message: '请先拍摄或选择现场照片' })
      expect(air.hazardSubmitting).toBe(false)
      expect(air.lastSubmit).toBeNull()
    })
  })

  describe('SmartImg 占位与兜底', () => {
    it('未加载完成前是占位态，load 后淡入', async () => {
      const w = mount(SmartImg, { props: { src: 'img/site-map.webp', alt: 'x' } })
      const img = w.find('img')
      expect(img.classes()).toContain('simg')
      expect(img.classes()).not.toContain('is-loaded')

      await img.trigger('load')
      expect(w.find('img').classes()).toContain('is-loaded')
    })

    it('加载失败换成内联占位图，不再出破图', async () => {
      const w = mount(SmartImg, { props: { src: 'img/site-map.webp' } })
      const before = w.find('img').attributes('src')
      await w.find('img').trigger('error')
      const after = w.find('img').attributes('src')
      expect(after).not.toBe(before)
      expect(after).toMatch(/^data:image\/svg\+xml/)
      expect(w.find('img').classes()).toContain('is-failed')
    })

    it('换图时重置状态，不沿用上一张的「已加载」', async () => {
      const w = mount(SmartImg, { props: { src: 'a.webp' } })
      await w.find('img').trigger('load')
      expect(w.find('img').classes()).toContain('is-loaded')
      await w.setProps({ src: 'b.webp' })
      expect(w.find('img').classes()).not.toContain('is-loaded')
    })

    it('根元素就是 img，父级传的 class 会落上去（保住 .air-card img 这类选择器）', () => {
      const w = mount(SmartImg, { props: { src: 'a.webp', pos: 'pos-tl' }, attrs: { class: 'insp-pic', id: 'pic1' } })
      const img = w.find('img')
      expect(img.element.tagName).toBe('IMG')
      expect(img.classes()).toEqual(expect.arrayContaining(['simg', 'pos-tl', 'insp-pic']))
      expect(img.attributes('id')).toBe('pic1')
    })
  })

  describe('退出登录二次确认', () => {
    /** 2026-11：菜单 / 退出按钮只在登录态出现，先播一个会话 */
    beforeEach(() => {
      const auth = useAuthStore()
      auth.token = 'test-token'
      auth.username = '13800000000'
      auth.displayName = '张工'
      auth.role = '安全员'
    })

    it('首次点击只进入待确认，3s 无操作自动解除', async () => {
      const w = mount(MinePage)
      const shell = useShellStore()
      await w.find('#btnLogout').trigger('click')
      expect(w.find('#btnLogout').text()).toBe('确认退出')
      expect(shell.toastVisible).toBe(false)

      vi.advanceTimersByTime(3000)
      await nextTick()
      expect(w.find('#btnLogout').text()).toBe('退出登录')
    })

    it('确认后才退出，并给出成功反馈与未登录态', async () => {
      const w = mount(MinePage)
      const shell = useShellStore()
      await w.find('#btnLogout').trigger('click')
      await w.find('#btnLogout').trigger('click')
      expect(shell.toast).toBe('已退出登录')
      expect(shell.toastType).toBe('success')
      expect(w.find('.profile-banner').classes()).toContain('is-out')
      expect(w.find('#mineMenu').exists()).toBe(false)
      expect(w.find('#btnLogin').exists()).toBe(true)
    })
  })

  describe('可点击元素的键盘可达', () => {
    it('工具卡与巡检条目都能用回车触发', async () => {
      const w = mount(WorkPage)
      const shell = useShellStore()
      await w.find('.tool-card').trigger('keydown', { key: 'Enter' })
      expect(shell.toast).toContain('接入中')

      signIn()
      const panel = mount(SafetyPanel)
      await nextTick()
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      // 排除 `[data-clone]` 的原因同上：副本页排在真实页之前
      await panel.find('.alarm-feed-page:not([data-clone]) .alarm-feed-item').trigger('keydown', { key: 'Enter' })
      expect(sub.view).toEqual({ kind: 'alarm-detail', id: alarm.latest[0].id })
    })
  })
})
