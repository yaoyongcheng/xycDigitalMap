import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mountDiag } from '@/utils/diag'

/**
 * 真机诊断浮层
 *
 * 这个文件守的是评审里的 S1：挂载判据曾是 `location.search.includes('diag')`
 * —— 子串匹配，`?dialog=1` / `?x=diag` / `?diagfoo` 全都能把浮层拉起来，
 * 等于把「元素计数 + 布局数值 + CSS 变量」开放给任意 URL，并顺带白烧
 * 移动端 CPU（600ms 一次重排）。现在必须精确匹配名为 diag 的参数。
 */

/** 切换当前 URL（happy-dom 不提供 history 之外的直接改写入口） */
function setUrl(url: string): void {
  ;(window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url)
}

/** 浮层是本模块自建并 append 到 body 的，用 z-index 认领 */
function overlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('div[style*="99999"]')
}

describe('utils/diag', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  describe('挂载判据', () => {
    it.each(['?diag', '?diag=1', '?diag=', '?a=1&diag&b=2', '?other=x&diag'])(
      '%s 会挂载浮层',
      (search) => {
        setUrl(`http://localhost/${search}`)
        mountDiag()
        expect(overlay()).not.toBeNull()
      },
    )

    it.each([
      '?dialog=1',
      '?x=diag',
      '?diagfoo',
      '?diagnostic',
      '?mydiag',
      '?dialog',
      '?',
      '',
      '?dd',
    ])('%s 不会挂载浮层', (search) => {
      setUrl(`http://localhost/${search}`)
      mountDiag()
      expect(overlay()).toBeNull()
    })

    it('不带查询参数时不挂载，也不注册定时器', () => {
      const spy = vi.spyOn(window, 'setInterval')
      setUrl('http://localhost/xycDigitalMap/')
      mountDiag()
      expect(overlay()).toBeNull()
      expect(spy).not.toHaveBeenCalled()
    })

    it('不挂载时不产生任何 DOM 变更', () => {
      document.body.appendChild(document.createElement('main'))
      const before = document.body.innerHTML
      setUrl('http://localhost/?dialog=1')
      mountDiag()
      expect(document.body.innerHTML).toBe(before)
    })
  })

  describe('浮层形态', () => {
    beforeEach(() => {
      setUrl('http://localhost/?diag')
      mountDiag()
    })

    it('固定在页面顶部且不可被页面内容遮挡', () => {
      const el = overlay()!
      expect(el.style.position).toBe('fixed')
      expect(el.style.zIndex).toBe('99999')
      expect(el.style.top).toBe('0px')
      expect(el.style.maxHeight).toBe('70vh')
    })

    it('只追加一个节点', () => {
      expect(document.querySelectorAll('div[style*="99999"]')).toHaveLength(1)
    })

    it('渲染出关键诊断字段', () => {
      const text = overlay()!.textContent ?? ''
      expect(text).toContain('innerH=')
      expect(text).toContain('dpr=')
      expect(text).toContain('iOS=')
      expect(text).toContain('sheetUp=')
      expect(text).toContain('--sheet-up-top=')
      expect(text).toContain('来源=')
      expect(text).toContain('计数 #page-home=')
      expect(text).toContain('预警=')
    })

    it('每 600ms 重新采集一次', () => {
      const spy = vi.spyOn(window, 'setInterval')
      document.body.innerHTML = ''
      setUrl('http://localhost/?diag')
      mountDiag()
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 600)
    })

    it('定时器回调会把最新的 DOM 状态写回浮层', () => {
      const pg = document.createElement('div')
      pg.id = 'page-home'
      const sheet = document.createElement('div')
      sheet.className = 'home-sheet'
      pg.appendChild(sheet)
      document.body.appendChild(pg)

      // 重新挂载，让首帧就采到新的结构
      document.body.querySelector('div[style*="99999"]')?.remove()
      setUrl('http://localhost/?diag')
      mountDiag()
      expect(overlay()!.textContent).toContain('计数 #page-home=1')
      expect(overlay()!.textContent).toContain('.home-sheet=1')

      // 模拟又插入了一份重复节点（原版踩过的坑）
      const dup = sheet.cloneNode()
      pg.appendChild(dup)
      vi.advanceTimersByTime(600)
      expect(overlay()!.textContent).toContain('.home-sheet=2')

      // 未到 600ms 时不重采
      const snapshot = overlay()!.textContent
      vi.advanceTimersByTime(599)
      expect(overlay()!.textContent).toBe(snapshot)
    })

    it('预警未挂载时给出明确标记而非报错', () => {
      expect(overlay()!.textContent).toContain('预警=未挂载')
    })
  })

  /**
   * 预警轮播的对齐诊断。
   *
   * 轮播窗口高度由 CSS 的 calc(--feed-item-h * 3) 决定，轨道位移由 JS 按
   * 同一个变量算 —— 两者一旦不同源，窗口里就会露出半截条目和一条空行。
   * 这段诊断就是为排查该问题写的，必须能在真实结构上跑出数值。
   */
  describe('预警轮播诊断', () => {
    /** 搭一份与首页一致的最小结构 */
    function buildFeed(options: { items?: number; transform?: string; transition?: string } = {}): void {
      document.body.innerHTML = ''
      const pg = document.createElement('div')
      pg.id = 'page-home'

      const win = document.createElement('div')
      win.className = 'alarm-feed-win'

      const track = document.createElement('div')
      track.className = 'alarm-feed-track'
      if (options.transform) track.style.transform = options.transform
      if (options.transition) track.style.transition = options.transition

      for (let i = 0; i < (options.items ?? 3); i++) {
        const item = document.createElement('div')
        item.className = 'alarm-feed-item'
        track.appendChild(item)
      }

      win.appendChild(track)
      pg.appendChild(win)
      document.body.appendChild(pg)
    }

    beforeEach(() => {
      buildFeed({ transform: 'translateY(-72px)', transition: 'transform .3s' })
      setUrl('http://localhost/?diag')
      mountDiag()
    })

    /** 换掉结构后重新挂载：先摘掉上一轮的浮层，保证读到的是最新快照 */
    function remount(): void {
      document.body.querySelectorAll('div[style*="99999"]').forEach((el) => el.remove())
      mountDiag()
    }

    function text(): string {
      return overlay()!.textContent ?? ''
    }

    it('打出变量、窗口高与首条尺寸', () => {
      expect(text()).toContain('预警 变量=')
      expect(text()).toContain('窗口高=0')
      expect(text()).toContain('首条rect高=0.0')
      expect(text()).toContain('首条offsetH=0')
    })

    it('打出轨道的 transform 与 transition', () => {
      expect(text()).toContain('预警 transform=translateY(-72px)')
      expect(text()).toContain('过渡=transform .3s')
    })

    it('统计可见条目与底部空行', () => {
      // happy-dom 里所有 rect 都是 0，故可见条为 0、空行也为 0 —— 结构能被算出来即可
      expect(text()).toContain('预警 可见条=0')
      expect(text()).toContain('各条可见=[]')
      expect(text()).toContain('底部空行=0')
    })

    it('计数行能反映真实节点数', () => {
      expect(text()).toContain('计数 #page-home=1')
      expect(text()).toContain('.home-sheet=0')
      expect(text()).toContain('.home-progress=0')
    })

    it('缺少 transform / transition 时回落到 (none)', () => {
      buildFeed({})
      remount()
      expect(text()).toContain('预警 transform=(none)')
      expect(text()).toContain('过渡=(none)')
    })

    it('窗口与轨道存在但没有条目时标记未挂载', () => {
      buildFeed({ items: 0 })
      remount()
      expect(text()).toContain('预警=未挂载')
    })

    it('只有窗口没有轨道时标记未挂载', () => {
      document.body.innerHTML = ''
      const pg = document.createElement('div')
      pg.id = 'page-home'
      const win = document.createElement('div')
      win.className = 'alarm-feed-win'
      pg.appendChild(win)
      document.body.appendChild(pg)

      remount()
      expect(text()).toContain('预警=未挂载')
    })
  })
})
