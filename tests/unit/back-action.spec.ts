import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetBackSlot, takeBackSlot } from '@/utils/backAction'

/**
 * 返回动作去抖（2026-11）
 *
 * 它解决的是真机上的一个具体事故：iOS 右滑返回时，应用内手势与浏览器返回
 * 会各点一次返回按钮，一次右滑从「预警详情」直接退到首页（跳过报警预警），
 * 之后的交互还会卡住。窗口期必须够挡住这种重复，又不能长到吞掉用户主动的
 * 连点两下返回 —— 这两条都要用用例钉住。
 */
describe('返回动作去抖', () => {
  let now = 0

  /** 手动时钟：performance.now 由用例控制，避免依赖 fake timers 的实现细节 */
  function clock(): void {
    now = 0
    resetBackSlot()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('窗口内只放行一次，窗口过后再放行', () => {
    clock()

    expect(takeBackSlot()).toBe(true)
    expect(takeBackSlot()).toBe(false)

    now = 200
    expect(takeBackSlot()).toBe(false)

    now = 401
    expect(takeBackSlot()).toBe(true)
  })

  it('页面刚加载（performance.now 接近 0）时第一次返回不会被自己挡住', () => {
    clock()
    expect(takeBackSlot()).toBe(true)
  })

  it('隔了半秒的第二次返回不被吞（用户主动连点两级）', () => {
    clock()
    expect(takeBackSlot()).toBe(true)
    now = 500
    expect(takeBackSlot()).toBe(true)
  })
})
