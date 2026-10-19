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
import QualityPanel from '@/views/home/QualityPanel.vue'
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
})
