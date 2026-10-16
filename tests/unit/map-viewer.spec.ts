import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import MapViewer from '@/components/ui/MapViewer.vue'
import { mapPoints } from '@/data/config'
import type { MapPoint } from '@/types'

import { ResizeObserverMock } from '../helpers/browser'
import { AnimationFrameQueue, expectSvgNamespace, pointerDown, pointerMove, pointerUp } from '../helpers/dom'

const POINTS: MapPoint[] = [
  { id: 'p-cam', kind: 'cam', name: '1#门', x: 10, y: 20, camId: 'g1' },
  { id: 'p-crane', kind: 'crane', name: '2#塔吊', x: 30, y: 40, camId: 'crane2' },
  { id: 'p-bld', kind: 'building', name: '1#楼', x: 50, y: 60 },
]

/**
 * 容器 800×600、底图 1024×735、fit=cover 下的几何常量：
 *   fitScale = max(800/1024, 600/735) = 0.81632653…
 *   canvas   = 835.918…×600    → 画布高度恰好等于容器高度
 *   mx(可平移量) = (835.918…-800)/2 = 17.959…
 *   my = 0                      → 垂直方向完全不可平移
 */
const BOX = { left: 0, top: 0, width: 800, height: 600 }
const CANVAS_W_AT_1X = 835.9183673469388
const PAN_LIMIT_X = (CANVAS_W_AT_1X - BOX.width) / 2
/** tx = 0 时的 left */
const BASE_LEFT = (BOX.width - CANVAS_W_AT_1X) / 2

function makeRect(): DOMRect {
  return {
    ...BOX,
    right: BOX.left + BOX.width,
    bottom: BOX.top + BOX.height,
    x: BOX.left,
    y: BOX.top,
    toJSON: () => ({}),
  } as DOMRect
}

const originalRaf = window.requestAnimationFrame
const originalCaf = window.cancelAnimationFrame

/**
 * 交互地图手势层
 *
 * 这是首页最先被感知到掉帧的地方，2026-10 做过两项优化：
 *   1. 手势开始锁定容器矩形，pointermove 不再逐枚 getBoundingClientRect
 *   2. pointermove 只更新快照，位移结算合并到每帧一次（rAF）
 * 下面把这两条都变成可断言的契约，顺带覆盖钳制、点击抑制、监听摘除
 * 等容易在重构中悄悄失效的细节。
 */
describe('components/ui/MapViewer', () => {
  let raf: AnimationFrameQueue
  let rectCalls = 0
  let wrapper: VueWrapper

  /** 容器矩形读取次数 —— 性能优化的核心观测量 */
  function rectReads(): number {
    return rectCalls
  }

  /** 推进一帧，并等 Vue 把 tx/ty 落到 DOM 上（响应式更新是微任务） */
  async function flushFrame(): Promise<void> {
    raf.flush()
    await nextTick()
  }

  /**
   * 双击用「普通 Event + 属性注入」派发。
   * happy-dom 的 MouseEvent 把 clientX 定义在原型上，测试工具注入参数时
   * 会被静默忽略，锚点会恒为 (0,0)。
   */
  function dblclick(clientX: number, clientY: number): void {
    wrapper.find('.map-viewer').element.dispatchEvent(
      Object.assign(new Event('dblclick', { bubbles: true }), { clientX, clientY }),
    )
  }

  function wheel(clientX: number, clientY: number, deltaY: number): void {
    wrapper.find('.map-viewer').element.dispatchEvent(
      Object.assign(new Event('wheel', { cancelable: true }), { clientX, clientY, deltaY }),
    )
  }

  function canvasEl(): HTMLElement {
    return wrapper.find('.map-canvas').element as HTMLElement
  }

  function canvasLeft(): number {
    return parseFloat(canvasEl().style.left)
  }

  function canvasTop(): number {
    return parseFloat(canvasEl().style.top)
  }

  function canvasWidth(): number {
    return parseFloat(canvasEl().style.width)
  }

  async function setupMounted(props: Record<string, unknown> = {}): Promise<void> {
    wrapper = mount(MapViewer, { props: { points: POINTS, ...props } })

    const box = wrapper.element as HTMLElement
    rectCalls = 0
    box.getBoundingClientRect = () => {
      rectCalls += 1
      return makeRect()
    }

    // 触发一次 ResizeObserver，让组件拿到容器尺寸
    ResizeObserverMock.latest()?.trigger()
    await nextTick()
    rectCalls = 0
  }

  /** 按下 → 若干次移动（不推进帧） */
  function gesture(moves: { clientX: number; clientY: number }[] = []): void {
    const box = wrapper.element as HTMLElement
    pointerDown(box, { pointerId: 1, clientX: 150, clientY: 300 })
    for (const m of moves) {
      pointerMove(window, { pointerId: 1, clientX: m.clientX, clientY: m.clientY })
    }
  }

  /** 双指按住 */
  function twoFingers(ax: number, bx: number): void {
    const box = wrapper.element as HTMLElement
    pointerDown(box, { pointerId: 1, clientX: ax, clientY: 300 })
    pointerDown(box, { pointerId: 2, clientX: bx, clientY: 300 })
  }

  beforeEach(() => {
    raf = new AnimationFrameQueue()
    window.requestAnimationFrame = raf.request
    window.cancelAnimationFrame = raf.cancel
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRaf
    window.cancelAnimationFrame = originalCaf
    wrapper?.unmount()
  })

  /* ---------------- 基础渲染 ---------------- */

  describe('渲染', () => {
    it('底图默认取 PWA base 下的 site-map.webp', async () => {
      await setupMounted()
      expect(wrapper.find('img').attributes('src')).toBe('/img/site-map.webp')
    })

    it('底图地址可被覆盖', async () => {
      await setupMounted({ src: '/img/custom.webp' })
      expect(wrapper.find('img').attributes('src')).toBe('/img/custom.webp')
    })

    it('每个点位渲染一枚按钮，坐标以百分比落位', async () => {
      await setupMounted()
      const pins = wrapper.findAll('.map-pin')
      expect(pins).toHaveLength(POINTS.length)
      expect(pins[0].attributes('style')).toContain('left: 10%')
      expect(pins[0].attributes('style')).toContain('top: 20%')
      expect(pins[0].attributes('aria-label')).toBe('1#门')
    })

    it.each([
      ['cam', 2],
      ['crane', 4],
      ['building', 3],
    ])('%s 点位图标直出 %i 条 path（不再走 v-html 解析）', async (kind, count) => {
      await setupMounted({ points: POINTS.filter((p) => p.kind === kind) })
      const svg = wrapper.find('.pin-dot svg')
      expectSvgNamespace(svg.element)
      expect(svg.element.querySelectorAll('path')).toHaveLength(count as number)
      expect(svg.element.textContent).toBe('')
    })

    it('全部 12 个演示点位都能渲染出图标', async () => {
      await setupMounted({ points: mapPoints })
      expect(wrapper.findAll('.map-pin')).toHaveLength(12)
      expect(wrapper.findAll('.pin-dot svg path').length).toBeGreaterThan(12)
    })

    it('compact 只挂 class，不改变几何数据', async () => {
      await setupMounted({ compact: true })
      expect(wrapper.classes()).toContain('is-compact')
    })

    it('初始平移为 0，画布居中', async () => {
      await setupMounted()
      expect(canvasLeft()).toBeCloseTo(BASE_LEFT, 6)
      expect(canvasTop()).toBeCloseTo(0, 6)
    })
  })

  /* ---------------- 手势性能契约 ---------------- */

  describe('手势性能契约', () => {
    it('一次 pointerdown 只读一次容器矩形，后续 move 全部复用', async () => {
      await setupMounted()
      gesture([152, 154, 156, 158, 160].map((x) => ({ clientX: x, clientY: 300 })))

      // 按下时的唯一一次读取
      expect(rectReads()).toBe(1)

      await flushFrame()
      // 结算阶段使用锁定矩形，不再读布局
      expect(rectReads()).toBe(1)
    })

    it('一帧内多次 pointermove 只调度一次结算', async () => {
      await setupMounted()
      gesture([152, 154, 156].map((x) => ({ clientX: x, clientY: 300 })))

      expect(raf.scheduled).toBe(1)
      expect(raf.pending).toBe(1)

      // 再加两枚，仍不应新增调度
      pointerMove(window, { pointerId: 1, clientX: 158, clientY: 300 })
      pointerMove(window, { pointerId: 1, clientX: 160, clientY: 300 })
      expect(raf.scheduled).toBe(1)

      await flushFrame()
      expect(raf.pending).toBe(0)

      // 下一帧才允许再次调度
      pointerMove(window, { pointerId: 1, clientX: 162, clientY: 300 })
      expect(raf.scheduled).toBe(2)
    })

    it('帧未推进前画面不动（写入确实被合并）', async () => {
      await setupMounted()
      expect(canvasLeft()).toBeCloseTo(BASE_LEFT, 6)

      gesture([{ clientX: 160, clientY: 300 }])
      expect(canvasLeft()).toBeCloseTo(BASE_LEFT, 6)

      await flushFrame()
      expect(canvasLeft()).toBeCloseTo(BASE_LEFT + 10, 6)
    })

    it('结算用最新快照，一帧内的位移不丢', async () => {
      await setupMounted()
      // 连发 5 枚，只有最后一枚的位置应当生效
      gesture([152, 154, 156, 158, 160].map((x) => ({ clientX: x, clientY: 300 })))
      await flushFrame()
      expect(canvasLeft()).toBeCloseTo(BASE_LEFT + 10, 6)
    })

    it('手势结束后释放锁定矩形，滚轮重新实时读取', async () => {
      await setupMounted()
      gesture([{ clientX: 160, clientY: 300 }])
      await flushFrame()
      pointerUp(window, 1)
      expect(rectReads()).toBe(1)

      wheel(400, 300, -100)
      expect(rectReads()).toBe(2)
    })
  })

  /* ---------------- 平移与钳制 ---------------- */

  describe('平移与钳制', () => {
    it('水平拖动跟随手指位移', async () => {
      await setupMounted()
      gesture([{ clientX: 160, clientY: 300 }])
      await flushFrame()
      expect(canvasLeft()).toBeCloseTo(BASE_LEFT + 10, 6)
    })

    it('拖出左边界时被钳到画布不脱离容器', async () => {
      await setupMounted()
      gesture([{ clientX: -400, clientY: 300 }])
      await flushFrame()
      // tx = -mx → left = 2 * BASE_LEFT
      expect(canvasLeft()).toBeCloseTo(BASE_LEFT - PAN_LIMIT_X, 6)
      expect(canvasLeft()).toBeCloseTo(2 * BASE_LEFT, 6)
    })

    it('拖出右边界时画布右边缘恰好贴住容器', async () => {
      await setupMounted()
      gesture([{ clientX: 900, clientY: 300 }])
      await flushFrame()
      expect(canvasLeft()).toBeCloseTo(0, 6)
    })

    it('cover 下画布高度等于容器高度，垂直拖动被完全钳制', async () => {
      await setupMounted()
      expect(canvasTop()).toBeCloseTo(0, 6)
      gesture([{ clientX: 150, clientY: 100 }])
      await flushFrame()
      expect(canvasTop()).toBeCloseTo(0, 6)
    })

    it('鼠标右键不开启手势', async () => {
      await setupMounted()
      const box = wrapper.element as HTMLElement
      pointerDown(box, { pointerId: 1, clientX: 150, clientY: 300, pointerType: 'mouse', button: 2 })
      pointerMove(window, { pointerId: 1, clientX: 250, clientY: 300, pointerType: 'mouse' })
      expect(raf.scheduled).toBe(0)
      expect(rectReads()).toBe(0)
    })
  })

  /* ---------------- 双指捏合 ---------------- */

  describe('双指捏合', () => {
    it('拉开双指放大，画布尺寸随之增大', async () => {
      await setupMounted()
      twoFingers(300, 500)
      pointerMove(window, { pointerId: 2, clientX: 700, clientY: 300 })
      await flushFrame()
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X * 2, 3)
    })

    it('捏合期间同样不重复读取容器矩形', async () => {
      await setupMounted()
      twoFingers(300, 500)
      const afterDown = rectReads()

      pointerMove(window, { pointerId: 2, clientX: 700, clientY: 300 })
      await flushFrame()
      expect(rectReads()).toBe(afterDown)
    })

    it('缩放不超过上限 4x', async () => {
      await setupMounted()
      twoFingers(300, 500)
      pointerMove(window, { pointerId: 2, clientX: 5000, clientY: 300 })
      await flushFrame()
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X * 4, 3)
    })

    it('缩放不低于下限 1x', async () => {
      await setupMounted()
      twoFingers(300, 700)
      pointerMove(window, { pointerId: 2, clientX: 311, clientY: 300 })
      await flushFrame()
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X, 3)
    })

    it('抬起一指后回到单指拖拽，且不重复读矩形', async () => {
      await setupMounted()
      twoFingers(300, 500)
      pointerMove(window, { pointerId: 2, clientX: 600, clientY: 300 })
      await flushFrame()

      pointerUp(window, 2)
      const afterUp = rectReads()
      const leftAfterPinch = canvasLeft()

      pointerMove(window, { pointerId: 1, clientX: 320, clientY: 300 })
      await flushFrame()
      expect(canvasLeft()).toBeCloseTo(leftAfterPinch + 20, 6)
      expect(rectReads()).toBe(afterUp)
    })
  })

  /* ---------------- 点击抑制 ---------------- */

  describe('点位点击', () => {
    it('直接点击点位会派发 select', async () => {
      await setupMounted()
      await wrapper.findAll('.map-pin')[1].trigger('click')
      expect(wrapper.emitted('select')).toHaveLength(1)
      expect((wrapper.emitted('select')![0][0] as MapPoint).id).toBe('p-crane')
    })

    it('拖拽后的合成 click 被吞掉一次，随后恢复正常', async () => {
      await setupMounted()
      gesture([{ clientX: 150, clientY: 380 }])
      await flushFrame()
      pointerUp(window, 1)

      await wrapper.findAll('.map-pin')[0].trigger('click')
      expect(wrapper.emitted('select')).toBeUndefined()

      // 50ms 兜底后恢复
      await new Promise((r) => setTimeout(r, 70))
      await wrapper.findAll('.map-pin')[0].trigger('click')
      expect(wrapper.emitted('select')).toHaveLength(1)
    })

    it('位移不足阈值不算拖拽，点击照常生效', async () => {
      await setupMounted()
      gesture([{ clientX: 152, clientY: 302 }])
      await flushFrame()
      pointerUp(window, 1)

      await wrapper.findAll('.map-pin')[0].trigger('click')
      expect(wrapper.emitted('select')).toHaveLength(1)
    })
  })

  /* ---------------- 监听与帧的生命周期 ---------------- */

  describe('生命周期', () => {
    it('手势期间挂到 window 上，抬手即全部摘除', async () => {
      await setupMounted()
      const add = vi.spyOn(window, 'addEventListener')
      const remove = vi.spyOn(window, 'removeEventListener')

      const box = wrapper.element as HTMLElement
      pointerDown(box, { pointerId: 1, clientX: 150, clientY: 300 })
      expect(add.mock.calls.map((c) => c[0])).toEqual(['pointermove', 'pointerup', 'pointercancel'])

      pointerUp(window, 1)
      expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual([
        'pointercancel',
        'pointermove',
        'pointerup',
      ])
    })

    it('抬手会取消尚未执行的帧', async () => {
      await setupMounted()
      gesture([{ clientX: 190, clientY: 300 }])
      expect(raf.pending).toBe(1)

      pointerUp(window, 1)
      expect(raf.pending).toBe(0)

      // 手动推进也不应有任何写入
      const before = canvasLeft()
      await flushFrame()
      expect(canvasLeft()).toBe(before)
    })

    it('组件卸载时取消帧并摘除 window 监听', async () => {
      await setupMounted()
      const remove = vi.spyOn(window, 'removeEventListener')
      gesture([{ clientX: 190, clientY: 300 }])
      expect(raf.pending).toBe(1)

      wrapper.unmount()
      expect(raf.pending).toBe(0)
      const removed = remove.mock.calls.map((c) => c[0])
      expect(removed).toContain('pointermove')
      expect(removed).toContain('pointerup')
      expect(removed).toContain('pointercancel')
    })

    it('卸载时断开 ResizeObserver 并摘掉 wheel 监听', async () => {
      await setupMounted()
      const ro = ResizeObserverMock.latest()!
      const box = wrapper.element as HTMLElement
      const removeSpy = vi.spyOn(box, 'removeEventListener')

      wrapper.unmount()
      expect(ro.targets.size).toBe(0)
      expect(removeSpy.mock.calls.map((c) => c[0])).toContain('wheel')
    })
  })

  /* ---------------- 缩放控件 ---------------- */

  describe('控件与双击', () => {
    it('放大按钮按 1.4 倍递进，复位按钮随之出现', async () => {
      await setupMounted()
      expect(wrapper.find('.map-ctrl-reset').exists()).toBe(false)

      await wrapper.find('[aria-label="放大"]').trigger('click')
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X * 1.4, 3)

      await wrapper.find('[aria-label="放大"]').trigger('click')
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X * 1.96, 3)
      expect(wrapper.find('.map-ctrl-reset').text()).toBe('复位')
    })

    it('滚轮缩放同样以指针为锚', async () => {
      await setupMounted()
      wheel(400, 300, -100)
      await nextTick()
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X * 1.16, 3)
    })

    it('复位回到 1x 并清空平移', async () => {
      await setupMounted()
      await wrapper.find('[aria-label="放大"]').trigger('click')
      gesture([{ clientX: 160, clientY: 300 }])
      await flushFrame()
      expect(canvasLeft()).not.toBeCloseTo(BASE_LEFT, 3)

      await wrapper.find('.map-ctrl-reset').trigger('click')
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X, 3)
      expect(canvasLeft()).toBeCloseTo(BASE_LEFT, 6)
      expect(wrapper.find('.map-ctrl-reset').exists()).toBe(false)
    })

    it('缩小按钮同样生效', async () => {
      await setupMounted()
      await wrapper.find('[aria-label="放大"]').trigger('click')
      await wrapper.find('[aria-label="缩小"]').trigger('click')
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X, 3)
    })

    it('双击在 1x / 2.4x 间切换', async () => {
      await setupMounted()

      dblclick(400, 300)
      await nextTick()
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X * 2.4, 3)

      dblclick(400, 300)
      await nextTick()
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X, 3)
    })

    it('allowZoomOut 时提供「总览」按钮，一键缩到整图可见', async () => {
      await setupMounted({ allowZoomOut: true })

      // 初始 1x（cover 铺满，比容器大）→ 只应出现「总览」，而非「复位」
      const btns = wrapper.findAll('.map-ctrl-reset')
      expect(btns).toHaveLength(1)
      expect(btns[0].text()).toBe('总览')

      await btns[0].trigger('click')

      // 落到下限后整图完整可见（画布不再超出容器）
      expect(canvasWidth()).toBeLessThan(BOX.width)
      expect(parseFloat(canvasEl().style.height)).toBeLessThanOrEqual(BOX.height)

      // 此时出现的是「复位」
      const after = wrapper.findAll('.map-ctrl-reset')
      expect(after).toHaveLength(1)
      expect(after[0].text()).toBe('复位')
    })
  })

  /* ---------------- 底图自然尺寸 ---------------- */

  describe('底图自然尺寸校准', () => {
    it('onload 后按真实像素重算画布尺寸', async () => {
      await setupMounted()
      const img = wrapper.find('img').element as HTMLImageElement
      Object.defineProperty(img, 'naturalWidth', { value: 1200, configurable: true })
      Object.defineProperty(img, 'naturalHeight', { value: 800, configurable: true })
      await wrapper.find('img').trigger('load')

      // fitScale = max(800/1200, 600/800) = 0.75 → 画布 900 × 600
      expect(canvasWidth()).toBeCloseTo(900, 6)
    })

    it('naturalWidth 为 0（加载失败）时保留默认尺寸', async () => {
      await setupMounted()
      const img = wrapper.find('img').element as HTMLImageElement
      Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })
      await wrapper.find('img').trigger('load')
      expect(canvasWidth()).toBeCloseTo(CANVAS_W_AT_1X, 6)
    })
  })
})
