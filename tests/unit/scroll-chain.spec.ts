import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'

import { useScrollChain } from '@/utils/scrollChain'

/**
 * 嵌套滚动接力（2026-11-18）
 *
 * 这块逻辑全是「边界 + 方向」的条件判断，肉眼很难验准：
 * 判宽了会把正常的名单滚动抢给外层（名单自己滚不动，感觉卡）；
 * 判窄了就是原来那个 bug —— 滚到底怎么划都不动。
 *
 * 所以钉住三件事：
 *   ① 内层还能滚时，一个事件都不拦；
 *   ② 内层到边界后，滚轮余量交给外层，且只交一次（不 double）；
 *   ③ 外层也到底时不 preventDefault，让浏览器自己收尾。
 */

/** happy-dom 里 scrollTop/scrollHeight/clientHeight 恒为 0，得自己造 */
function sized(el: HTMLElement, client: number, content: number): void {
  let top = 0
  Object.defineProperty(el, 'clientHeight', { get: () => client, configurable: true })
  Object.defineProperty(el, 'scrollHeight', { get: () => content, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(content - client, Math.trunc(v)))
    },
    configurable: true,
  })
}

/** 每个用例都要还原：happy-dom 的 inline style 未必透传到 getComputedStyle */
const realComputedStyle = window.getComputedStyle

afterEach(() => {
  window.getComputedStyle = realComputedStyle
})

const Host = defineComponent({
  setup() {
    const listEl = ref<HTMLElement | null>(null)
    const chain = useScrollChain(listEl)
    return { listEl, ...chain }
  },
  template: `
    <div class="outer" style="overflow-y: auto">
      <div ref="listEl" class="inner" style="overflow-y: auto"></div>
    </div>
  `,
})

interface Ctx {
  w: ReturnType<typeof mount>
  inner: HTMLElement
  outer: HTMLElement
  canUp: () => boolean
  canDown: () => boolean
}

async function setup(listClient = 100, listContent = 500, sheetClient = 400, sheetContent = 1200): Promise<Ctx> {
  const w = mount(Host, { attachTo: document.body })
  const inner = w.find('.inner').element as HTMLElement
  const outer = w.find('.outer').element as HTMLElement
  sized(inner, listClient, listContent)
  sized(outer, sheetClient, sheetContent)
  // happy-dom 的 inline style 透传到 getComputedStyle 不完整，直接兜住这一处判断
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
    const real = realComputedStyle.call(window, el)
    return el === outer ? ({ ...real, overflowY: 'auto' } as CSSStyleDeclaration) : real
  }) as typeof window.getComputedStyle)
  // watch(inner) 是 pre 队列，挂载后要等一拍才真正绑上监听
  await nextTick()
  inner.dispatchEvent(new Event('scroll'))
  return {
    w,
    inner,
    outer,
    canUp: () => Boolean((w.vm as unknown as { canUp: boolean }).canUp),
    canDown: () => Boolean((w.vm as unknown as { canDown: boolean }).canDown),
  }
}

function wheel(el: HTMLElement, deltaY: number): boolean {
  const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
  el.dispatchEvent(e)
  return e.defaultPrevented
}

describe('useScrollChain：内层滚到边界后接力给外层', () => {
  it('内层还能往下滚时不拦事件（名单自己滚）', async () => {
    const c = await setup()
    expect(c.canDown()).toBe(true)
    expect(wheel(c.inner, 120)).toBe(false)
    expect(c.outer.scrollTop).toBe(0)
    c.w.unmount()
  })

  it('内层滚到底后，继续下滑把滚动量交给外层', async () => {
    const c = await setup()
    c.inner.scrollTop = 400 // max = 500-100
    c.inner.dispatchEvent(new Event('scroll'))
    expect(c.canDown()).toBe(false)

    expect(wheel(c.inner, 120)).toBe(true)
    expect(c.outer.scrollTop).toBe(120)
    c.w.unmount()
  })

  it('内层在顶部继续上滑，把滚动量交给外层（负方向）', async () => {
    const c = await setup()
    c.outer.scrollTop = 300
    expect(c.canUp()).toBe(false)

    expect(wheel(c.inner, -80)).toBe(true)
    expect(c.outer.scrollTop).toBe(220)
    c.w.unmount()
  })

  it('外层也到顶时不 preventDefault，交给浏览器收尾', async () => {
    const c = await setup()
    c.outer.scrollTop = 0
    expect(wheel(c.inner, -80)).toBe(false)
    expect(c.outer.scrollTop).toBe(0)
    c.w.unmount()
  })

  it('横向手势与按行滚动的 deltaMode 都不掺和', async () => {
    const c = await setup()
    c.inner.scrollTop = 400
    c.inner.dispatchEvent(new Event('scroll'))
    expect(wheel(c.inner, 120)).toBe(true)

    const horizontal = new WheelEvent('wheel', { deltaX: 120, deltaY: 4, bubbles: true, cancelable: true })
    c.inner.dispatchEvent(horizontal)
    expect(horizontal.defaultPrevented).toBe(false)
    c.w.unmount()
  })

  it('reset 回到顶部并重新量边界（换下钻层级不留在中段）', async () => {
    const c = await setup()
    c.inner.scrollTop = 260
    c.inner.dispatchEvent(new Event('scroll'))
    expect(c.canUp()).toBe(true)

    ;(c.w.vm as unknown as { reset: () => void }).reset()
    await nextTick()
    expect(c.inner.scrollTop).toBe(0)
    expect(c.canUp()).toBe(false)
    expect(c.canDown()).toBe(true)
    c.w.unmount()
  })
})
