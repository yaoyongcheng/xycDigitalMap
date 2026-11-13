import { describe, expect, it } from 'vitest'

import { droneStateIsDown, droneStateText } from '@/utils/uavState'

/**
 * 飞机状态文案
 *
 * 对照物是 V2 的 `UIViewDrone`：库里飞机断电时 `status: -1`，
 * V2 显示红字「关机」（不是「待机」也不是「未连接」）。
 */
describe('droneStateText 飞机状态', () => {
  it('status=-1 且 modeCode=14 → 关机（库里断电，与 V2 一致）', () => {
    expect(droneStateText(-1, 14)).toBe('关机')
    expect(droneStateIsDown(-1, 14)).toBe(true)
  })

  it('status=-1 但 modeCode 在飞行态 → 按 modeCode 说，不误报关机', () => {
    // status 没刷新，飞机其实在飞（5 = 航线飞行）
    expect(droneStateText(-1, 5)).toBe('航线飞行')
    expect(droneStateIsDown(-1, 5)).toBe(false)
  })

  it('正常状态码走 DJI 枚举', () => {
    expect(droneStateText(0, 0)).toBe('待机')
    expect(droneStateText(3, 3)).toBe('手动飞行')
    expect(droneStateText(5, 5)).toBe('航线飞行')
    expect(droneStateText(9, 9)).toBe('自动返航')
    expect(droneStateText(14, 14)).toBe('未连接')
    expect(droneStateIsDown(14, 14)).toBe(true)
  })

  it('status 缺失时用 modeCode 兜底；两个都缺 → 「—」', () => {
    expect(droneStateText(null, 5)).toBe('航线飞行')
    expect(droneStateText(null, null)).toBe('—')
  })

  it('modeCode 优先：status 恒为 1 时状态仍跟着飞行模式走（2026-11-13 实测）', () => {
    // 飞机从 69m 自动降落回库、再落定，status 全程 1 不动，modeCode 从 10 到 0。
    // 早先以 status 为主，页面就永远写「起飞准备」，与 V2 的「自动降落 / 待机」对不上。
    expect(droneStateText(1, 10)).toBe('自动降落')
    expect(droneStateText(1, 0)).toBe('待机')
    expect(droneStateText(1, 5)).toBe('航线飞行')
    // 只在 modeCode 缺失时才回落到 status
    expect(droneStateText(5, null)).toBe('航线飞行')
  })

  it('status 缺失但 modeCode 说没连上 → 「未连接」，不误报断电关机', () => {
    expect(droneStateText(null, 14)).toBe('未连接')
    expect(droneStateIsDown(null, 14)).toBe(true)
  })

  it('没见过的码 → 「—」，不猜也不回落「待机」', () => {
    expect(droneStateText(99, 99)).toBe('—')
    expect(droneStateIsDown(99, 99)).toBe(false)
  })
})
