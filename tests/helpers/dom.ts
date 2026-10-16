import { expect } from 'vitest'

/**
 * 指针 / 手势测试工具
 *
 * happy-dom 的 PointerEvent 构造器对 clientX / pointerId 等字段支持不完整，
 * 直接 new PointerEvent(...) 常拿到 0 —— 而 MapViewer 的手势结算完全依赖这些
 * 数值。这里改用普通 Event + 属性注入，行为与真实事件对象一致（监听器只做
 * 属性读取），且完全不依赖环境实现。
 */

interface PointerInit {
  pointerId: number
  clientX: number
  clientY: number
  pointerType?: string
  button?: number
}

export function makePointerEvent(type: string, init: PointerInit): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, {
    pointerId: init.pointerId,
    clientX: init.clientX,
    clientY: init.clientY,
    pointerType: init.pointerType ?? 'touch',
    button: init.button ?? 0,
  })
  return e
}

export function pointerDown(target: EventTarget, init: PointerInit): void {
  target.dispatchEvent(makePointerEvent('pointerdown', init))
}

export function pointerMove(target: EventTarget, init: PointerInit): void {
  target.dispatchEvent(makePointerEvent('pointermove', init))
}

/**
 * 抬手 / 取消。这两类事件的处理逻辑只读 pointerId，坐标无意义，
 * 故单独给一个只要 id 的签名，避免调用处写无意义的坐标。
 */
export function pointerUp(target: EventTarget, pointerId: number, type: 'pointerup' | 'pointercancel' = 'pointerup'): void {
  target.dispatchEvent(
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      pointerId,
      clientX: 0,
      clientY: 0,
      pointerType: 'touch',
    }),
  )
}

/**
 * 可控的 requestAnimationFrame。
 *
 * MapViewer 把 pointermove 的结算合并到每帧一次，要验证「合并」就必须能
 * 精确控制帧的推进，因此不让 happy-dom 的真实 rAF 参与。
 */
export class AnimationFrameQueue {
  private queue = new Map<number, FrameRequestCallback>()
  private seq = 0
  /** 已被调度过的回调总次数（含被取消的），用于断言合并效果 */
  scheduled = 0

  request = (cb: FrameRequestCallback): number => {
    this.seq += 1
    this.scheduled += 1
    this.queue.set(this.seq, cb)
    return this.seq
  }

  cancel = (id: number): void => {
    this.queue.delete(id)
  }

  /** 挂起中的帧数 */
  get pending(): number {
    return this.queue.size
  }

  /** 推进一帧：执行并清空当前挂起的回调 */
  flush(): void {
    const cbs = [...this.queue.values()]
    this.queue.clear()
    for (const cb of cbs) cb(0)
  }
}

/** 断言某个元素是 SVG 命名空间下的节点（v-html → 组件重构后最容易出错的地方） */
export function expectSvgNamespace(el: Element | null | undefined): void {
  expect(el).toBeTruthy()
  expect(el!.namespaceURI).toBe('http://www.w3.org/2000/svg')
}
