import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useCamStore } from '@/stores/cam'
import { useSubpageStore } from '@/stores/subpage'
import { resetBackSlot, takeBackSlot } from '@/utils/backAction'
import { useHistoryBack } from '@/utils/historyBack'

/**
 * 浏览器「返回」接管（2026-11）
 *
 * 手机上的边缘侧滑是浏览器级手势，页面拿不到事件也拦不住 —— 用户右滑想返回
 * 上一页，浏览器却直接退出了当前地址。接管模型是「历史条目镜像层数」：
 * 每打开一层压一个条目，条目里记着当时的层数（wbLayer），浏览器退到哪一条
 * 就回落到几层。这组用例钉住：
 *   ① 打开一层压一条，层数写在 state 里（必须同步压，快照才拍在上一页）；
 *   ② 浏览器返回执行应用内的返回按钮，不退出站点；
 *   ③ 页面内关掉层时，多余的条目一并退掉，不留「按了没反应」的空步；
 *   ④ 下钻后再退一级，只关一层、不多压条目（共用一条守卫时这里会退两级）；
 *   ⑤ 一次手势只退一级（手势层与 popstate 同时发生）。
 */

const Host = defineComponent({
  setup() {
    useHistoryBack()
    return () => h('div')
  },
})

type Entry = Record<string, unknown> | null

/** 假历史栈：真实浏览器里 push/replace/go 都在动它，接管逻辑全读 history.state */
let stack: Entry[] = [null]
let cursor = 0

let wrapper: ReturnType<typeof mount> | null = null
let push: ReturnType<typeof vi.spyOn>
let replace: ReturnType<typeof vi.spyOn>
let back: ReturnType<typeof vi.spyOn>
let go: ReturnType<typeof vi.spyOn>

/** 造一个「当前子页层」，返回按钮走真实的三级优先逻辑（subpage.close） */
function setupLayer(): HTMLElement {
  const layer = document.createElement('section')
  layer.className = 'subpage open'
  const btn = document.createElement('button')
  btn.setAttribute('data-back', '')
  btn.addEventListener('click', () => useSubpageStore().close())
  layer.appendChild(btn)
  document.body.appendChild(layer)
  return layer
}

/** 模拟浏览器的历史遍历：光标移动 + 派发 popstate（带目标条目的 state） */
function travel(delta: number): void {
  const next = Math.min(stack.length - 1, Math.max(0, cursor + delta))
  if (next === cursor) return
  cursor = next
  const e = new Event('popstate') as Event & { state: Entry }
  e.state = stack[cursor]
  window.dispatchEvent(e)
}

/** 造一次下钻：depth 由 1 变 2（返回键会退回列表，层本身还开着） */
function drillDown(): void {
  const sub = useSubpageStore()
  sub.back = { kind: 'inspect-list' }
  sub.view = { kind: 'placeholder', name: '帮助' }
}

describe('浏览器返回接管', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 返回动作去抖是模块级记账，用例之间要清，否则上一例刚放行过会挡这一例
    resetBackSlot()
    setupLayer()
    stack = [null]
    cursor = 0

    push = vi.spyOn(window.history, 'pushState').mockImplementation((s: unknown) => {
      stack = stack.slice(0, cursor + 1)
      stack.push((s ?? null) as Entry)
      cursor = stack.length - 1
    })
    replace = vi.spyOn(window.history, 'replaceState').mockImplementation((s: unknown) => {
      stack[cursor] = (s ?? null) as Entry
    })
    back = vi.spyOn(window.history, 'back').mockImplementation(() => travel(-1))
    go = vi.spyOn(window.history, 'go').mockImplementation((delta = 0) => travel(delta))
    vi.spyOn(window.history, 'state', 'get').mockImplementation(() => stack[cursor])
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /*
   * 快照时序（2026-11，iOS Safari 现场）：WebKit 给历史条目拍快照，拍的是
   * pushState 那一刻屏幕上的画面。压得越晚，上一条条目的快照越接近新页 ——
   * 于是右滑到一半画面纹丝不动（滑走的和露出的都是详情页），popstate 到了才
   * 凭空跳成报警预警。所以打开层时必须**同步**压：DOM 还没重新渲染。
   */
  it('打开一层时同步压条目（不等定时器，屏幕还是上一页）', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    wrapper = mount(Host)
    await nextTick()
    expect(push).not.toHaveBeenCalled()

    sub.openInspectList('today')
    // 一格定时器都没推进：pushState 已经落地
    expect(push).toHaveBeenCalledTimes(1)
    expect(stack[cursor]).toMatchObject({ wbLayer: 1 })

    // 下钻同理：压这一条时，屏幕上还是列表页
    drillDown()
    expect(push).toHaveBeenCalledTimes(2)
    expect(stack[cursor]).toMatchObject({ wbLayer: 2 })
  })

  it('挂载前就开着的层，挂载后再补条目', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    sub.openInspectList('today')
    wrapper = mount(Host)
    await nextTick()

    // 这一刻 onMounted 还没把上一轮残留的层数改写掉，不能同步压
    expect(push).not.toHaveBeenCalled()

    vi.advanceTimersByTime(400)
    expect(push).toHaveBeenCalledTimes(1)
    expect(stack[cursor]).toMatchObject({ wbLayer: 1 })
  })

  it('浏览器返回执行应用内返回，而不是退出站点', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    sub.openInspectList('today')
    wrapper = mount(Host)
    await nextTick()
    vi.advanceTimersByTime(400)

    travel(-1)
    await nextTick()
    expect(sub.isOpen).toBe(false)
    // 已经落在根条目上，不需要再往后退历史
    expect(back).not.toHaveBeenCalled()
    expect(go).not.toHaveBeenCalled()
  })

  it('页面内点返回关掉层后，多余的条目一并退掉', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    sub.openInspectList('today')
    wrapper = mount(Host)
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(cursor).toBe(1)

    sub.close()
    await nextTick()
    vi.advanceTimersByTime(400)

    // 历史里那条条目已经没用了，留着会让用户下次按返回「什么都没发生」
    expect(go).toHaveBeenCalledTimes(1)
    expect(cursor).toBe(0)
  })

  /*
   * 共用一条「守卫」条目时的现场事故：从报警预警点进详情后右滑，退到的其实是
   * 那条守卫，而守卫是在「列表刚打开、还没画出来」时压的 —— 快照记着首页，
   * 于是先闪一次首页，再靠改状态把内容换回来。条目一一对应就不存在这个问题：
   * 退一级落在「列表」那条条目上，它的快照就是列表。
   */
  it('下钻后再返一级：只关一层，且不多压条目', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    sub.openInspectList('today')
    wrapper = mount(Host)
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(cursor).toBe(1)

    drillDown()
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(cursor).toBe(2)
    expect(stack[2]).toMatchObject({ wbLayer: 2 })

    // 浏览器返回 → 落到「列表」那条（wbLayer 1），只该关一层
    travel(-1)
    await nextTick()
    expect(sub.view.kind).toBe('inspect-list')
    expect(sub.isOpen).toBe(true)

    vi.advanceTimersByTime(400)
    // 条目已经一一对应，不需要再压新的
    expect(push).toHaveBeenCalledTimes(2)
    expect(cursor).toBe(1)
  })

  it('连滑两下：每一级各退一次，最后停在根条目上', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    sub.openInspectList('today')
    wrapper = mount(Host)
    await nextTick()
    vi.advanceTimersByTime(400)
    drillDown()
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(cursor).toBe(2)

    travel(-1)
    await nextTick()
    expect(sub.view.kind).toBe('inspect-list')

    travel(-1)
    await nextTick()
    expect(sub.isOpen).toBe(false)
    expect(cursor).toBe(0)
  })

  it('没有覆盖层时按浏览器返回不拦截', async () => {
    wrapper = mount(Host)
    expect(push).not.toHaveBeenCalled()

    travel(-1)
    await nextTick()
    expect(back).not.toHaveBeenCalled()
    expect(go).not.toHaveBeenCalled()
  })

  it('弹层打开时，返回先关弹层', async () => {
    vi.useFakeTimers()
    const sheet = useBottomSheetStore()
    sheet.openPatrol('p-1')
    wrapper = mount(Host)
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(push).toHaveBeenCalledTimes(1)

    travel(-1)
    await nextTick()
    expect(sheet.isOpen).toBe(false)
  })

  /*
   * 真机事故（2026-11，iOS Safari）：右滑从「预警详情」直接退到了**首页**，
   * 跳过了「报警预警」。原因是这一次右滑被两条路各执行了一遍返回 ——
   * 手势层点了一次返回按钮，浏览器又把 popstate 送进来。
   */
  it('一次右滑只退一级：手势层已关掉一层，紧随的 popstate 不再退一级', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    sub.openInspectList('today')
    wrapper = mount(Host)
    await nextTick()
    vi.advanceTimersByTime(400)
    drillDown()
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(cursor).toBe(2)

    // 手势层先落地（swipeBack.finish 里会先申请名额再点按钮）
    expect(takeBackSlot()).toBe(true)
    sub.close()
    await nextTick()
    expect(sub.view.kind).toBe('inspect-list')

    // 浏览器紧接着也送来 popstate：目标条目记着 1 层，而当前正好 1 层
    travel(-1)
    await nextTick()

    // 不能再退一级：否则列表也没了，落回首页
    expect(sub.view.kind).toBe('inspect-list')
    expect(sub.isOpen).toBe(true)
  })

  /*
   * 刷新时当前条目还带着上一轮的层数（刷新后覆盖层都没了）。这时**不能**
   * 用 history.go 退 —— 那会退到上一轮的条目上去，手机上表现为「一刷新就
   * 跳走甚至重新加载」。只能就地改写成 0。
   */
  it('挂载时当前条目带着旧层数：就地改写，不用 go 回退', async () => {
    stack = [{ wbLayer: 2 }]
    cursor = 0
    wrapper = mount(Host)
    await nextTick()
    vi.useFakeTimers()
    vi.advanceTimersByTime(400)

    expect(replace).toHaveBeenCalled()
    expect(go).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
    expect(stack[0]?.wbLayer).toBeUndefined()
  })

  /*
   * 2026-11-24 现场事故：「在任意页面左滑一下，页面先闪出首页，一两秒后又自己
   * 回到左滑前那一页」。
   *
   * 左滑在浏览器那边是**前进**。而页面内点返回 / 点底栏切 tab 时，`sync()` 会用
   * `history.go(-1)` 把多余的条目退掉 —— 条目本身还在，只是跑到光标前面（前向栈），
   * 它的快照拍在「那一层打开之前」，也就是首页。
   *
   * 旧逻辑只按层数判断（`depth <= target` 就走 settle），80ms 后 `sync()` 又发现
   * 「条目比层数多」，再补一次 `history.go(-1)` —— 于是浏览器先演一遍「前进到
   * 首页」，再演一遍「退回来」。现在前进方向一个 go 都不许发：落到旧条目上就地
   * 把层数改回真实值（replaceState 不产生遍历），画面与状态一动不动。
   */
  it('前进落到被裁掉的旧条目：不关层、不回弹，就地把层数改回来', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    sub.openInspectList('today')
    wrapper = mount(Host)
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(cursor).toBe(1)

    // 页面内关掉这一层：条目被裁到光标前面（前向栈里还留着它）
    sub.close()
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(cursor).toBe(0)
    expect(go).toHaveBeenCalledTimes(1)

    // 用户左滑 → 前进到那条旧条目（wbLayer 1，而真实层数是 0）
    travel(1)
    await nextTick()

    // 不许关层（否则会把用户已经关掉的页面再关一次），也不许再发 go 弹回去
    expect(sub.isOpen).toBe(false)
    expect(go).toHaveBeenCalledTimes(1)
    expect(cursor).toBe(1)
    // 层数就地改写：条目与真实层数重新自洽，下一次返回按真实栈算
    expect(stack[1]?.wbLayer).toBeUndefined()

    // 迟到的对齐也不许把它弹走（旧实现的 80ms 定时器就是在这里发 go 的）
    vi.advanceTimersByTime(1000)
    expect(go).toHaveBeenCalledTimes(1)
    expect(cursor).toBe(1)
  })

  it('逐条裁剪改成一次退到位（少演几段转场）', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    sub.openInspectList('today')
    wrapper = mount(Host)
    await nextTick()
    vi.advanceTimersByTime(400)
    drillDown()
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(cursor).toBe(2)

    // 底栏切 tab：dismiss() 一次关掉两层
    sub.dismiss()
    await nextTick()
    vi.advanceTimersByTime(400)

    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(cursor).toBe(0)
  })

  /*
   * Safari 会节流 / 丢弃转场期间的 history.go（现场已验证过）。裁剪发出去却没
   * 生效时不能一直重试，也不能留下「条目比层数多」这个状态 —— 那会让下一位
   * 用户按返回算不出要关哪一层。重试一次后直接就地改写层数。
   */
  it('裁剪的 go 被吞掉：重试一次后就地改写层数，不死循环', async () => {
    vi.useFakeTimers()
    const sub = useSubpageStore()
    sub.openInspectList('today')
    wrapper = mount(Host)
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(cursor).toBe(1)

    // 从这一刻起，go 失效（模拟被浏览器节流）
    go.mockImplementation(() => {})

    sub.close()
    await nextTick()
    vi.advanceTimersByTime(2000)

    // 两次尝试 + 一次兜底改写；条目还在，但层数已经和真实状态一致
    expect(go.mock.calls.length).toBeLessThanOrEqual(2)
    expect(cursor).toBe(1)
    expect(stack[1]?.wbLayer).toBeUndefined()
  })

  /*
   * 首次打开「点工作台 → 点视频监控 → 跳回首页」的现场（2026-11-27）。
   *
   * 本站地址会被 302 到带尾斜杠的版本、从外链进来也一样 —— 历史里应用条目
   * **之前**还躺着一条不属于本文档的条目。旧版裁剪只看「条目比层数多」就
   * `go(-delta)`，没有任何下限；退过挂载条目就是一次**文档级返回**，整页重载，
   * `shell.activeTab` 回到 `'home'`。下面三例分别钉住这次加的三道闸。
   */
  describe('首次打开不会退成文档级返回', () => {
    /** 应用条目之前还有一条不属于本文档的条目（302 / 外链进站的形态） */
    function seedForeignEntry(): void {
      stack = [{}, null]
      cursor = 1
    }

    it('挂载条目是下限：层数被写大也只退到它为止', async () => {
      vi.useFakeTimers()
      seedForeignEntry()
      const sub = useSubpageStore()
      wrapper = mount(Host)
      await nextTick()

      sub.openInspectList('today')
      expect(cursor).toBe(2)

      // 模拟「条目层数被写大了」（旧版 fireBack 兜底留下的那种残留）
      stack[cursor] = { wbLayer: 9 }

      sub.close()
      await nextTick()
      vi.advanceTimersByTime(1200)

      // 真实只有 1 条可退：只退 1 步，停在挂载条目上，不碰它前面那条
      expect(go).toHaveBeenCalledWith(-1)
      expect(cursor).toBe(1)
    })

    it('返回按钮还没画出来时，不把层数写进条目', async () => {
      vi.useFakeTimers()
      seedForeignEntry()
      const cam = useCamStore()
      wrapper = mount(Host)
      await nextTick()

      cam.isOpen = true
      await nextTick()
      expect(cursor).toBe(2)

      // 层开着但 DOM 还没提交（`.cam-player.open` 不存在）
      travel(-1)
      await nextTick()
      vi.advanceTimersByTime(1200)

      // 旧版在这里 setLayer(depth) 把层数写进条目，后面按它算 delta 就越界
      expect(go).not.toHaveBeenCalled()
      expect(stack[1]?.wbLayer).toBeUndefined()
    })

    it('pushState 被浏览器丢掉时账不虚高：关层不会多退一步', async () => {
      vi.useFakeTimers()
      seedForeignEntry()
      const sub = useSubpageStore()
      wrapper = mount(Host)
      await nextTick()

      // Safari 转场 / 后台 / 限流时会直接吞掉 pushState（本文件注释里记过）
      push.mockImplementationOnce(() => {})
      sub.openInspectList('today')
      await nextTick()
      expect(cursor).toBe(1)

      // 再下钻一层：被吞掉的那条要重建成两条（层数 1 和 2），而不是只有一条
      drillDown()
      await nextTick()
      expect(cursor).toBe(3)

      // 底栏 dismiss：条目比层数多，要退 —— 但只能退到挂载条目，不能退穿
      sub.dismiss()
      await nextTick()
      vi.advanceTimersByTime(1200)

      expect(go).toHaveBeenCalledWith(-2)
      expect(cursor).toBe(1)
    })

    it('未登录 → 工作台 → 视频监控 → 返回一次再关监控：不产生文档级返回', async () => {
      vi.useFakeTimers()
      seedForeignEntry()
      const sub = useSubpageStore()
      const cam = useCamStore()
      wrapper = mount(Host)
      await nextTick()

      // 挂载即弹登录页（0 → 1）
      sub.openLogin('登录后可查看现场监控')
      await nextTick()
      expect(cursor).toBe(2)

      // 点「工作台」（1 → 0），紧接着点「视频监控」（0 → 1）
      sub.dismiss()
      cam.isOpen = true
      await nextTick()
      vi.advanceTimersByTime(1200)

      expect(cursor).toBeGreaterThanOrEqual(1)
      expect(cam.isOpen).toBe(true)
      expect(stack[cursor]).toMatchObject({ wbLayer: 1 })

      // 用户按浏览器返回，此时监控层还没画完（`.cam-player.open` 不存在）
      travel(-1)
      await nextTick()
      vi.advanceTimersByTime(1200)

      // 监控被关掉：条目对齐时**不许退过挂载条目**（旧版这里会退到 0 = 重载回首页）
      cam.isOpen = false
      await nextTick()
      vi.advanceTimersByTime(1200)

      expect(cursor).toBe(1)
      expect(stack[1]?.wbLayer).toBeUndefined()
    })
  })
})
