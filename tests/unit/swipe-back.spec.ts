import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import { useSubpageStore } from '@/stores/subpage'
import { resetBackSlot } from '@/utils/backAction'
import { useSwipeBack } from '@/utils/swipeBack'
import { makePointerEvent } from '../helpers/dom'

/**
 * 右滑返回手势（2026-10 新增）
 *
 * 判定逻辑全是数值条件（起手区、方向、阈值、速度），肉眼很难验准，
 * 必须用用例钉住：误判成返回会把用户正在滚的列表「弹走」，
 * 漏判则手势形同不存在。
 */

const Host = defineComponent({
  setup() {
    useSwipeBack()
    return () => h('div')
  },
})

let wrapper: ReturnType<typeof mount> | null = null
let layer: HTMLElement
let backSpy: ReturnType<typeof vi.fn>

function setupLayer(): void {
  layer = document.createElement('div')
  layer.className = 'subpage open'
  const btn = document.createElement('button')
  btn.setAttribute('data-back', '')
  btn.addEventListener('click', backSpy)
  layer.appendChild(btn)
  document.body.appendChild(layer)
}

function down(x: number, y = 300): void {
  window.dispatchEvent(makePointerEvent('pointerdown', { pointerId: 1, clientX: x, clientY: y }))
}

function move(x: number, y = 300, id = 1): void {
  window.dispatchEvent(makePointerEvent('pointermove', { pointerId: id, clientX: x, clientY: y }))
}

function up(x: number, y = 300): void {
  window.dispatchEvent(makePointerEvent('pointerup', { pointerId: 1, clientX: x, clientY: y }))
}

/** 一次完整拖拽（按下 → 单次移动到终点 → 抬起） */
function drag(fromX: number, toX: number, fromY = 300, toY = 300): void {
  down(fromX, fromY)
  move(toX, toY)
  up(toX, toY)
}

describe('右滑返回手势', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    setActivePinia(createPinia())
    // 返回动作去抖是模块级记账，用例之间要清（每条用例都从 t=0 重新开始计时）
    resetBackSlot()
    backSpy = vi.fn()
    setupLayer()
    wrapper = mount(Host)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    document.body.style.userSelect = ''
    vi.useRealTimers()
  })

  function openSubpage(): void {
    useSubpageStore().view = { kind: 'inspect-list' }
  }

  it('左边缘起手、右滑超过阈值 → 触发该层的返回按钮', () => {
    openSubpage()
    drag(10, 200)
    vi.advanceTimersByTime(400)
    expect(backSpy).toHaveBeenCalledTimes(1)
  })

  it('滑动过程中页面跟手位移（带阻尼）', () => {
    openSubpage()
    down(10)
    move(110, 302)
    // 阻尼 0.55：手指走 100px，页面走 55px（值可能带浮点尾数）
    expect(layer.style.transform).toMatch(/^translate3d\(55(\.\d+)?px, 0, 0\)$/)
  })

  it('位移不足阈值 → 回弹，不返回', () => {
    openSubpage()
    drag(10, 40)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
    expect(layer.style.transform).toBe('')
  })

  it('快速轻扫（位移不大但速度够）也触发返回', () => {
    openSubpage()
    down(10)
    vi.advanceTimersByTime(20)
    move(60)
    up(60)
    vi.advanceTimersByTime(400)
    expect(backSpy).toHaveBeenCalledTimes(1)
  })

  it('纵向为主的滑动不接管（否则列表滚不动）', () => {
    openSubpage()
    drag(10, 12, 300, 430)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
    expect(layer.style.transform).toBe('')
  })

  it('非左边缘起手不接管（页面中间横向拖拽不应触发返回）', () => {
    openSubpage()
    drag(100, 320)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
  })

  /*
   * 向左滑不是返回手势 —— 浏览器 / 系统把它当成「前进」（iOS 右边缘左滑、
   * 桌面触控板左滑），那一趟由 utils/historyBack.ts 的方向判定处理。
   *
   * 应用内这一侧必须彻底撒手：一像素都不位移、不点返回，并且把起手记录
   * （layer / pid）整条丢掉。只置 tracking=false 会留下一个悬空的「正在跟手」
   * 的层引用，下一次 pointerdown 先撞上 abortGesture 的补偿路径 —— 左滑本来
   * 什么都没发生，却像被硬中断过一次手势。
   */
  it('向左滑完全撒手：不位移、不返回，也不污染下一次右滑的基准', () => {
    openSubpage()
    down(10)
    move(-40) // 负向且超过 SLOP
    expect(layer.style.transform).toBe('')
    up(-40)

    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
    expect(document.body.style.userSelect).toBe('')

    // 紧接着一次正常右滑：基准来自这一次的 pointerdown（20 → 120 = 100 × 0.55）
    down(20)
    move(120)
    expect(layer.style.transform).toMatch(/^translate3d\(55(\.\d+)?px, 0, 0\)$/)
  })

  it('只点左边缘不滑动 → 什么也不发生', () => {
    openSubpage()
    down(10)
    up(10)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
  })

  it('没有覆盖层时不接管（一级页面右滑无副作用）', () => {
    useSubpageStore().view = { kind: 'none' }
    drag(10, 300)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
  })

  it('滑出动画期间不重复触发', () => {
    openSubpage()
    drag(10, 200)
    // 第一次已在滑出（busy），紧接着再滑一次应被忽略
    drag(10, 200)
    vi.advanceTimersByTime(400)
    expect(backSpy).toHaveBeenCalledTimes(1)
  })

  /*
   * 2026-11 现场要求：**右滑返回的效果必须和点返回按钮一致**。
   *
   * SubPage.onBack 播的是同一段 0.22s `is-leaving`。手势层若自己先推一段
   * translate3d(100%)、等 200ms 才去点按钮，就会多出一段动画（而且浏览器侧滑
   * 还会再补一段），用户看到的是「手松了画面还在动，过一会儿才换页」。
   * 所以手势只清位移、立刻点按钮 —— 与手指去点返回箭头完全同一条路。
   */
  it('松手立即触发返回，不自己播第二段滑出动画', () => {
    openSubpage()
    down(10)
    move(200)
    up(200)

    // 不用等任何定时器：点按钮是同步的
    expect(backSpy).toHaveBeenCalledTimes(1)
    // 跟手位移必须归零 —— 否则 0.22s 动画的起点不是 0，与点返回不一致
    expect(layer.style.transform).toBe('')
  })

  /*
   * 真机上浏览器抢走指针（侧滑导航）后，紧接着才派发 popstate。若指针一被取消
   * 就回弹，现场会看到「滑出去 → 弹回来 → 再滑出去」三段。这里先冻结位移，
   * 等 popstate 清掉。
   */
  it('指针被抢走（pointercancel）后冻结位移，等 popstate 再清', () => {
    openSubpage()
    down(10)
    move(110)
    const dragged = layer.style.transform
    expect(dragged).not.toBe('')

    window.dispatchEvent(makePointerEvent('pointercancel', { pointerId: 1, clientX: 110, clientY: 300 }))
    // 冻结：既不继续滑出，也不弹回去
    expect(layer.style.transform).toBe(dragged)

    window.dispatchEvent(new Event('popstate'))
    expect(layer.style.transform).toBe('')
    expect(backSpy).not.toHaveBeenCalled()
  })

  it('指针被抢走但没有 popstate（普通中断）→ 窗口过后回弹归位', () => {
    openSubpage()
    down(10)
    move(110)
    window.dispatchEvent(makePointerEvent('pointercancel', { pointerId: 1, clientX: 110, clientY: 300 }))

    vi.advanceTimersByTime(500)
    expect(layer.style.transform).toBe('')
    expect(backSpy).not.toHaveBeenCalled()
  })

  /*
   * 2026-11 现场问题（真机）：「右滑返回之后，第二次进入报警详情页会卡住」。
   *
   * 手机的边缘侧滑是浏览器级手势，浏览器认领后只发 popstate，往往不再补
   * pointerup / pointercancel。若不处理，应用内手势会留着内联位移与悬空的
   * tracking/active，下一次进详情时进入动画结束就跳回偏移位（看起来卡死），
   * 再摸屏还会被陈旧手势接着拖。
   */
  it('手势中被浏览器接管（popstate）→ 立即归位，且不会二次触发返回', () => {
    openSubpage()
    down(10)
    move(110)
    expect(layer.style.transform).not.toBe('')

    window.dispatchEvent(new Event('popstate'))

    // 位移与跟手态都要清掉，否则残留到下一次进入
    expect(layer.style.transform).toBe('')
    expect(document.body.style.userSelect).toBe('')
    // 上一层是首页（back 为 null），跟手时会把外壳切形态；接管后必须收回
    expect(useSubpageStore().leaving).toBe(false)

    // 浏览器接管后才抬起手指：不能再点一次返回，否则一次右滑退两级
    up(240)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
  })

  it('上一次手势没收到 pointerup 时，下一次起手先清掉陈旧位移与基准', () => {
    openSubpage()
    down(10)
    move(110) // 拖到一半，浏览器接管 → 没有 up
    expect(layer.style.transform).not.toBe('')

    // 下一次起手（仍在边缘区）应当先归零，再以新的起点为准
    down(20)
    expect(layer.style.transform).toBe('')
    move(70)
    // 新基准 20 → 50px × 阻尼 0.55 = 27.5px；若沿用旧基准 10 会算成 33px
    expect(layer.style.transform).toMatch(/^translate3d\(27\.5\d*px, 0, 0\)$/)

    up(70)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
  })

  it('多指：换一根手指的 move/up 不参与本次手势', () => {
    openSubpage()
    down(10)
    move(200, 300, 2) // 另一根手指
    expect(layer.style.transform).toBe('')
    up(200)
    vi.advanceTimersByTime(400)
    expect(backSpy).not.toHaveBeenCalled()
  })

  /*
   * 2026-11 现场问题（iPhone）：「详情页右滑到一半，看到的还是详情页，闪一下
   * 才变成报警预警」。
   *
   * 根因是这里曾经按 UA 让位：iOS Safari（非独立窗口）上整个手势直接 return，
   * 页面纹丝不动，返回全靠浏览器自己的转场 + popstate。现在所有平台都跟手 ——
   * 手指一动就能看到下面的上一页，Safari 真接管时它会把页面冻成快照，我们的
   * 位移随之不可见，不会打架。
   */
  it('iOS 浏览器环境同样跟手、同样触发返回', () => {
    const ua = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      )
    openSubpage()
    down(10)
    move(110)
    expect(layer.style.transform).toMatch(/^translate3d\(55(\.\d+)?px, 0, 0\)$/)
    up(200)
    expect(backSpy).toHaveBeenCalledTimes(1)
    ua.mockRestore()
  })

  /*
   * 子页栈不是真叠加，详情页右滑时下面是 .pages（消息页）。SubPage 会垫一层
   * 只读的 .subpage-under 作为真实上一页 —— 手势必须只位移/只点当前层，
   * 否则要么露出错页面，要么点错按钮。
   */
  it('存在垫底上一层时，只位移当前层、只点当前层的返回键', () => {
    openSubpage()

    const underSpy = vi.fn()
    const under = document.createElement('div')
    under.className = 'subpage subpage-under open'
    const underBtn = document.createElement('button')
    underBtn.setAttribute('data-back', '')
    underBtn.addEventListener('click', underSpy)
    under.appendChild(underBtn)
    // 插到最前面：under 会成为 querySelector 的第一个匹配，专挑「没排除干净」的实现
    document.body.insertBefore(under, layer)

    down(10)
    move(110)
    expect(layer.style.transform).not.toBe('')
    expect(under.style.transform).toBe('')

    up(200)
    vi.advanceTimersByTime(400)
    expect(backSpy).toHaveBeenCalledTimes(1)
    expect(underSpy).not.toHaveBeenCalled()
  })

  /*
   * 揭示态（`sub.leaving` / `.is-swipe-back`）不能在手势松手那一刻撤。
   *
   * 被点的返回按钮刚把 0.22s 滑出挂上，子页还盖着大半个屏幕；这时撤掉，
   * 状态栏的「揭示态透明」规则就失效、退回白底 —— 右滑返回会在顶部再闪
   * 一条白条，而点返回箭头那边是整个滑出播完才撤（两条路径就不一致了）。
   */
  it('松手返回后不立刻撤揭示态，交给滑出收尾', () => {
    const sub = useSubpageStore()
    openSubpage()
    drag(10, 200)
    expect(sub.leaving).toBe(true)

    // 滑出动画还在播（0.22s）：这会儿撤，状态栏就白回来了
    vi.advanceTimersByTime(200)
    expect(sub.leaving).toBe(true)

    // 兜底：返回没被真正执行（滑出被打断）时也要收尾
    vi.advanceTimersByTime(400)
    expect(sub.leaving).toBe(false)
  })
})
