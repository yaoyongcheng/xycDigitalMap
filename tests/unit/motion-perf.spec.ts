import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import MapViewer from '@/components/ui/MapViewer.vue'
import { useShellStore } from '@/stores/shell'
import EquipPanel from '@/views/home/EquipPanel.vue'
import HomeSheet from '@/views/home/HomeSheet.vue'
import QualityPanel from '@/views/home/QualityPanel.vue'
import AlarmFeed from '@/views/home/parts/AlarmFeed.vue'
import InspectItem from '@/components/ui/InspectItem.vue'
import { alarmTone } from '@/utils/alarmTone'
import { mountDiag, unmountDiag } from '@/utils/diag'

import { ResizeObserverMock } from '../helpers/browser'

/**
 * 第二轮体验优化的回归（2026-10）
 *
 * 钉住的是「性能与流程」「观感」两类中能被断言的部分：
 *   - 两个 MapViewer 实例必须互斥挂起（否则隐藏的那个白烧 ResizeObserver）
 *   - CountUp 的 sticky：同一个值不再每次重新从 0 滚一遍
 *   - 页面转场方向：前进与退回必须给出不同的方向
 *   - 诊断浮层：重复挂载不叠加、可卸载、后台标签页不刷新
 *   - 图例类可点元素：键盘与读屏可达（Enter / Space 与点击等价）
 * 观感类（扫光、错峰、玻璃质感）纯 CSS，不在断言范围内，靠浏览器实测。
 */

const originalRaf = window.requestAnimationFrame
const originalCaf = window.cancelAnimationFrame

describe('第二轮体验优化回归', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    window.requestAnimationFrame = originalRaf
    window.cancelAnimationFrame = originalCaf
  })

  describe('MapViewer 双实例挂起', () => {
    let wrapper: VueWrapper

    function ro(): ResizeObserverMock | undefined {
      return ResizeObserverMock.latest()
    }

    it('挂起态挂载时不观察容器', () => {
      wrapper = mount(MapViewer, { props: { points: [], suspended: true } })
      expect(ro()?.targets.size ?? 0).toBe(0)
      wrapper.unmount()
    })

    it('恢复后开始观察，再次挂起则断开', async () => {
      wrapper = mount(MapViewer, { props: { points: [], suspended: true } })
      const obs = ro()
      expect(obs).toBeDefined()

      await wrapper.setProps({ suspended: false })
      expect(obs?.targets.size).toBe(1)

      // 挂起必须真的 disconnect —— 只置标记而不摘观察等于没省下任何开销
      await wrapper.setProps({ suspended: true })
      expect(obs?.targets.size).toBe(0)
      wrapper.unmount()
    })

    it('默认（未挂起）挂载即观察', () => {
      wrapper = mount(MapViewer, { props: { points: [] } })
      expect(ro()?.targets.size).toBe(1)
      wrapper.unmount()
    })

    it('挂起时不响应手势', async () => {
      wrapper = mount(MapViewer, { props: { points: [], suspended: true } })
      const box = wrapper.element as HTMLElement
      box.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

      const canvas = wrapper.find('.map-canvas').element as HTMLElement
      const before = canvas.style.left

      const down = new Event('pointerdown', { bubbles: true })
      Object.assign(down, { pointerId: 1, clientX: 150, clientY: 300, pointerType: 'touch', button: 0 })
      box.dispatchEvent(down)

      const move = new Event('pointermove', { bubbles: true })
      Object.assign(move, { pointerId: 1, clientX: 260, clientY: 320, pointerType: 'touch', button: 0 })
      window.dispatchEvent(move)

      // 挂起期间既没有 tx 也没有平移，画布位置一动不动
      await nextTick()
      expect(canvas.style.left).toBe(before)
      wrapper.unmount()
    })
  })

  describe('CountUp 不重复播报同一个值', () => {
    /*
     * 数字滚动是靠 rAF + performance.now() 计时的，必须让假定时器同时接管
     * 这两者：只 fake setTimeout 的话，帧回调永远不推进，动画停在半路，
     * 也就永远写不进 sticky 的记忆（表现为「明明显示 42 却仍会重播」）。
     */
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
          'performance',
          'requestAnimationFrame',
          'cancelAnimationFrame',
        ],
      })
    })

    it('sticky 模式：重挂载同一个值直接给终值，不再从 0 滚', async () => {
      const first = mount(CountUp, { props: { value: 42, sticky: true } })
      expect(first.text()).toBe('0')
      vi.advanceTimersByTime(1200)
      await nextTick()
      expect(first.text()).toBe('42')

      first.unmount()
      const second = mount(CountUp, { props: { value: 42, sticky: true } })
      // 响应式落 DOM 是微任务，同步读会拿到初始值 '0'
      await nextTick()
      expect(second.text()).toBe('42')
      second.unmount()
    })

    it('sticky 模式：值真的变了仍然滚动', async () => {
      const a = mount(CountUp, { props: { value: 77, sticky: true } })
      vi.advanceTimersByTime(1200)
      await nextTick()
      expect(a.text()).toBe('77')

      await a.setProps({ value: 88 })
      expect(a.text()).not.toBe('88')
      vi.advanceTimersByTime(1200)
      await nextTick()
      expect(a.text()).toBe('88')
      a.unmount()
    })

    it('非 sticky 保持原行为：重挂载仍然从 0 滚', async () => {
      const first = mount(CountUp, { props: { value: 101 } })
      vi.advanceTimersByTime(1200)
      await nextTick()
      expect(first.text()).toBe('101')
      first.unmount()

      const second = mount(CountUp, { props: { value: 101 } })
      await nextTick()
      expect(second.text()).toBe('0')
      second.unmount()
    })
  })

  describe('页面转场方向', () => {
    it('向右推进是 fwd，向左退回是 back', async () => {
      const shell = useShellStore()
      expect(shell.navDir).toBe('fwd')

      shell.activeTab = 'work'
      await nextTick()
      expect(shell.navDir).toBe('fwd')

      shell.activeTab = 'home'
      await nextTick()
      expect(shell.navDir).toBe('back')
    })

    it('跳到更靠右的 tab 仍是 fwd', async () => {
      const shell = useShellStore()
      shell.activeTab = 'mine'
      await nextTick()
      expect(shell.navDir).toBe('fwd')
    })
  })

  describe('诊断浮层', () => {
    function overlay(): HTMLElement | null {
      return document.body.querySelector<HTMLElement>('div[style*="99999"]')
    }

    beforeEach(() => {
      document.body.innerHTML = ''
      ;(window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(
        'http://localhost/?diag',
      )
    })

    afterEach(() => {
      unmountDiag()
      document.body.innerHTML = ''
    })

    it('重复挂载不叠加浮层（HMR 场景）', () => {
      mountDiag()
      mountDiag()
      expect(document.body.querySelectorAll('div[style*="99999"]').length).toBe(1)
    })

    it('卸载后定时器不再刷新，DOM 也被摘掉', () => {
      mountDiag()
      expect(overlay()).not.toBeNull()
      unmountDiag()
      expect(overlay()).toBeNull()

      // 卸载后即使时间过去很久，也不该重新冒出浮层
      vi.advanceTimersByTime(5000)
      expect(overlay()).toBeNull()
    })

    it('后台标签页不刷新读数', () => {
      mountDiag()
      const el = overlay()
      expect(el).not.toBeNull()
      el!.textContent = 'SENTINEL'

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })
      vi.advanceTimersByTime(2000)
      expect(el!.textContent).toBe('SENTINEL')

      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      })
    })
  })

  describe('按压反馈的样式契约', () => {
    /*
     * 这是一条真实事故改出来的守卫：统一按压反馈最初写成
     * `button:active { transform: scale(.975) }`，而抽屉切换按钮靠
     * `transform: translate(-50%,-50%)` 居中 —— :active 顶掉定位位移，
     * 按下瞬间按钮跳走半个身位、指针落空、click 收不到，
     * 表现就是「按钮偏移 + 点了没反应」。全局规则从此只允许改透明度。
     */
    it('全局 :active 规则不碰 transform', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      const block = css.match(/button:active,\s*\[role="button"\]:active\s*\{([^}]*)\}/)
      expect(block).not.toBeNull()
      expect(block![1]).not.toMatch(/transform/)
    })

    it('需要缩放的元素仍然单独拿到 transform 反馈', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      const block = css.match(/\.tool-card:active[\s\S]*?\{([^}]*)\}/)
      expect(block).not.toBeNull()
      expect(block![1]).toMatch(/transform:\s*scale/)
    })
  })

  describe('二级页面（子页）的底栏契约', () => {
    /*
     * 微信式交互：只有一级页面才有底栏。子页打开时底栏让位。
     *
     * 这里有一条真实事故改出来的反向断言：起初用 display:none 隐藏底栏，
     * .stack 会从 786 撑到 844，一级页面整体变高 58px（首页抽屉 674→732）。
     * 点返回键时子页瞬间消失、看不出问题；但右滑跟手会先露出「加高版」
     * 页面，松手后才缩回 —— 用户看到的就是「返回时页面往上跳一下」。
     * 所以底栏必须「不可见但仍占位」。
     */
    it('子页打开时底栏不可见但仍占位（不能是 display:none）', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      const tabbar = css.match(/\.app:has\(\.subpage\.open\)\s+\.tabbar\s*\{([^}]*)\}/)
      expect(tabbar).not.toBeNull()
      expect(tabbar![1]).toMatch(/visibility:\s*hidden/)
      expect(tabbar![1]).not.toMatch(/display:\s*none/)

      const banner = css.match(/\.app:has\(\.subpage\.open\)\s+\.upd-banner\s*\{([^}]*)\}/)
      expect(banner).not.toBeNull()
      expect(banner![1]).toMatch(/var\(--safe-bot\)/)
    })

    it('右滑跟手时底栏整条露出来（特异性要压过隐藏规则）', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      const swipe = css.match(
        /\.app:has\(\.subpage\.open\)\.is-swipe-back\s+\.tabbar\s*\{([^}]*)\}/,
      )
      expect(swipe).not.toBeNull()
      expect(swipe![1]).toMatch(/visibility:\s*visible/)
    })

    it('子页向下延伸一个底栏高度，盖到屏幕最底部', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      const sub = css.match(/\.subpage\s*\{([^}]*)\}/)
      expect(sub).not.toBeNull()
      expect(sub![1]).toMatch(/inset:[^;]*var\(--tabbar-h\)/)
    })

    it('子页内容底部留出安全区（底栏不在，不能被 Home Indicator 咬住）', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      const body = css.match(/\.subpage-body\s*\{([^}]*)\}/)
      expect(body).not.toBeNull()
      expect(body![1]).toMatch(/var\(--safe-bot\)/)
    })
  })

  describe('图例类可点元素的键盘可达', () => {
    it('装备图例：Enter 与点击等价', async () => {
      const wrapper = mount(EquipPanel)
      const items = wrapper.findAll('.eq-status-leg > div')
      expect(items.length).toBe(2)

      await items[0].trigger('keydown', { key: 'Enter' })
      expect(items[0].classes()).toContain('leg-on')
      expect(items[0].attributes('aria-pressed')).toBe('true')

      await items[0].trigger('keydown', { key: ' ' })
      expect(items[0].classes()).not.toContain('leg-on')
      wrapper.unmount()
    })

    it('验收工序图例：Space 与点击等价', async () => {
      const wrapper = mount(QualityPanel)
      const items = wrapper.findAll('.qa-legend-item')
      expect(items.length).toBeGreaterThan(0)

      await items[0].trigger('keydown', { key: ' ' })
      expect(items[0].classes()).toContain('leg-on')
      wrapper.unmount()
    })
  })
  describe('视觉改造第一批：数字排印 / 焦点 / 面板转场', () => {
    /*
     * 这三条钉的是「看一眼就知道不够专业」的三处：
     *   · 数字没有等级：四个同级指标和主指标一样大，读的人不知道先看哪个
     *   · 焦点不可见：有 tabindex 却没有 :focus-visible，键盘用起来像盲操作
     *   · 面板直切：v-if 换内容没有任何过程，切换像卡了一下
     */

    it('数字阶梯令牌存在，且 body 开启等宽数字', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      for (const token of ['--num-hero', '--num-lg', '--num-md', '--num-unit']) {
        expect(css).toContain(token)
      }
      /*
       * 等宽数字必须落在 body 上：此前只有 2 处写了 tabular-nums，而数字
       * 展示位有 27 处。比例数字下 CountUp 从 0 滚到 160 时宽度一直在变，
       * 整排 KPI 会左右微抖 —— 这是最常被感知为「不精致」的细节。
       */
      const body = css.match(/\nbody \{([^}]*)\}/)
      expect(body).not.toBeNull()
      expect(body![1]).toContain('font-variant-numeric: tabular-nums')
    })

    it('hero 数字比辅助数字大，且不再靠手写字号', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      expect(css).toContain('font-size: var(--num-hero)')
      expect(css).toContain('font-size: var(--num-md)')
      // 人员条首个是总量，单独升到 lg
      expect(css).toContain('.crew-overview > .crew-kpi:first-child b { font-size: var(--num-lg); }')
    })

    it(':focus-visible 存在，且深色底用更亮的蓝', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      expect(css).toContain(':focus-visible {')
      expect(css).toContain('outline: 2px solid var(--blue)')
      // 触屏点击不该出圈
      expect(css).toContain(':focus { outline: none; }')
      // #2F7CFF 在 #0B1626 上只有约 3:1，深色容器提亮一档
      expect(css).toContain('#page-home :focus-visible')
      expect(css).toContain('outline-color: var(--blue-2)')
    })

    it('面板切换会重挂载容器，入场动画才重播', async () => {
      const wrapper = mount(HomeSheet, { props: { dragTop: null } })
      const before = wrapper.find('#homePanels').element

      const quality = wrapper.findAll('.home-mod').find((b) => b.attributes('data-mod') === 'quality')
      await quality!.trigger('click')
      await nextTick()

      // 换 key 后是新节点 —— 不是同一个元素换了内容
      expect(wrapper.find('#homePanels').element).not.toBe(before)
      expect(wrapper.find('.qa-pass').exists()).toBe(true)
      wrapper.unmount()
    })

    it('指示条是一条共用滑块，位移用列宽推导', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      // 旧实现：每个按钮各自的 ::after，切换是这条灭那条亮
      expect(css).not.toContain('.home-mod.on::after')
      // 新实现：一条绝对定位轨道，4 列 + 3 个 4px gap
      expect(css).toContain('width: calc(25% - 3px)')
      // translateX 的百分比基准是元素自身宽度（列宽），步长要再加 gap
      expect(css).toContain('translateX(calc(var(--i, 0) * (100% + 4px)))')
    })
  })

  describe('视觉改造第二批：风险编码 / 区块标题 / 趋势图', () => {
    const alarm = {
      id: 'cable',
      day: 'today' as const,
      type: '电缆拖地',
      title: '用电报警',
      desc: '作业面电缆拖地未架空',
      img: 'img/alarm-cable.webp',
      rel: '3分钟前',
      at: '2026-10-20 15:19:00',
      geo: '114.24738810244102,30.53290155210933',
    }

    /*
     * 4 类预警原先长得一模一样，只有文案不同：一条「电缆拖地」和一条
     * 「道路垃圾」视觉重量相等，扫一眼分不出哪条该先处理。
     * 分档依据是现场后果，不是类型名称的字面分类。
     */
    it('按后果分档：防护最重、扬尘中等、环境最低', () => {
      expect(alarmTone('安全网缺失')).toBe('guard')
      expect(alarmTone('电缆拖地')).toBe('power')
      expect(alarmTone('裸土未覆盖')).toBe('dust')
      expect(alarmTone('道路垃圾')).toBe('env')
      // 未知类型按最低档：宁可弱化，也不给不认识的预警染上最高警报色
      expect(alarmTone('未知类型')).toBe('env')
    })

    it('首页预警流与子页列表都带上了 data-tone', () => {
      const feed = mount(AlarmFeed)
      const feedItem = feed.find('.alarm-feed-item')
      expect(feedItem.exists()).toBe(true)
      expect(feedItem.attributes('data-tone')).toBeTruthy()
      feed.unmount()

      const item = mount(InspectItem, { props: { alarm } })
      expect(item.find('.insp-item').attributes('data-tone')).toBe('power')
      item.unmount()
    })

    it('色标与编号的样式契约', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
      // 深色与浅色两套语义各自成组
      for (const tone of ['guard', 'power', 'dust', 'env']) {
        expect(css).toContain(`.alarm-feed-item[data-tone="${tone}"]`)
        expect(css).toContain(`.insp-item[data-tone="${tone}"]`)
      }
      // 色标是 2px 短条而不是整行染色：整行染色会让密集列表变成色块阵列
      expect(css).toContain('background: var(--tone, transparent)')

      // 区块标题：编号 + 延伸细线
      expect(css).toContain('#homePanels { counter-reset: block; }')
      expect(css).toContain('counter-increment: block;')
      expect(css).toContain('content: "0" counter(block);')
    })
  })
})
