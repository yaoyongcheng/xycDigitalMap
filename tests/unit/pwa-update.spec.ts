/**
 * PWA 换代时的「是否自动刷新」策略（2026-11-27）
 *
 * 背景见 src/utils/pwa.ts 文件头 ③：线上「首次点工作台 → 视频监控跳回首页」的
 * 载体是**旧壳**（旧 SW 预缓存的 index.html 被 navigateFallback 返回），修复代码
 * 早已上线但跑不到。这里的策略决定旧壳能在一条会话里活多久。
 *
 * 两个方向都要守住：
 *   · 该刷的时候要刷（不可见 / 无进行中操作）—— 否则旧壳继续跑旧 JS；
 *   · 不该刷的时候绝不能刷（开着监控、子页、正在输入）—— 刷掉用户填了一半的
 *     隐患单，比多跑一会儿旧代码严重得多。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { canSilentReload, registerServiceWorker, setReloadBlockers } from '@/utils/pwa'

/** 没有任何阻断项的基线快照 */
const SAFE = {
  offHome: false,
  subpage: false,
  cam: false,
  air: false,
  hazard: false,
  sheet: false,
  land: false,
  typing: false,
}

describe('canSilentReload', () => {
  it('全部阻断项为假时才允许刷新', () => {
    expect(canSilentReload(SAFE)).toBe(true)
  })

  it.each(Object.keys(SAFE) as Array<keyof typeof SAFE>)('任一阻断项为真（%s）就拒绝刷新', (key) => {
    expect(canSilentReload({ ...SAFE, [key]: true })).toBe(false)
  })
})

describe('registerServiceWorker：换代时的换版策略', () => {
  /** controllerchange 的回调，由假 serviceWorker.addEventListener 收集 */
  let onChange: (() => void) | null
  let reload: ReturnType<typeof vi.fn>
  let registerSpy: ReturnType<typeof vi.fn>
  let hasController: boolean

  /** 走完注册链（load → register → then 里的挂载） */
  async function boot(): Promise<void> {
    registerServiceWorker()
    window.dispatchEvent(new Event('load'))
    await vi.waitFor(() => expect(registerSpy).toHaveBeenCalled())
    // 让 register() 的 .then 回调跑完 —— 挂 controllerchange 监听就在里面
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    // 注册逻辑只在生产构建下执行（dev 不装 SW），测试里要显式打开这道门
    vi.stubEnv('PROD', true)
    onChange = null
    reload = vi.fn()
    hasController = true

    const registration = { update: vi.fn(async () => undefined) }
    registerSpy = vi.fn(async () => registration)
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        get controller() {
          return hasController ? {} : null
        },
        register: registerSpy,
        addEventListener: (type: string, fn: () => void) => {
          if (type === 'controllerchange') onChange = fn
        },
      },
    })

    // happy-dom 的 location.reload 不可 spy，直接换实现
    Object.defineProperty(window.location, 'reload', { configurable: true, value: reload })

    setReloadBlockers(() => SAFE)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    // 清掉 register 里挂的 visibilitychange / 定时器，避免串到下一次
    vi.restoreAllMocks()
  })

  it('页面不可见：直接刷新（用户看不到，零打断）', async () => {
    await boot()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })

    onChange?.()

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('可见且无进行中的操作：直接刷新', async () => {
    await boot()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })

    onChange?.()

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('有进行中的操作：不刷新，只广播给 UpdateBanner', async () => {
    setReloadBlockers(() => ({ ...SAFE, cam: true }))
    await boot()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    const onBanner = vi.fn()
    window.addEventListener('xyc:sw-updated', onBanner)

    onChange?.()

    expect(reload).not.toHaveBeenCalled()
    expect(onBanner).toHaveBeenCalledTimes(1)
    window.removeEventListener('xyc:sw-updated', onBanner)
  })

  it('首次安装（注册时没有 controller）：既不刷新也不提示', async () => {
    hasController = false
    await boot()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    const onBanner = vi.fn()
    window.addEventListener('xyc:sw-updated', onBanner)

    // 首次安装没有「旧壳」可换，压根不该挂监听
    expect(onChange).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    expect(onBanner).not.toHaveBeenCalled()
    window.removeEventListener('xyc:sw-updated', onBanner)
  })

  it('同一次会话里重复触发只处理一次', async () => {
    await boot()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })

    onChange?.()
    onChange?.()

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('有进行中的操作时也只提示一次（不重复弹条）', async () => {
    setReloadBlockers(() => ({ ...SAFE, hazard: true }))
    await boot()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    const onBanner = vi.fn()
    window.addEventListener('xyc:sw-updated', onBanner)

    onChange?.()
    onChange?.()

    expect(reload).not.toHaveBeenCalled()
    expect(onBanner).toHaveBeenCalledTimes(1)
    window.removeEventListener('xyc:sw-updated', onBanner)
  })
})
