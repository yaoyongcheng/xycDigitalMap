import { afterEach, describe, expect, it } from 'vitest'

import { hasMse, isAppleMobile, isMobileDevice, stripRetryCount } from '@/utils/env'

/**
 * 设备判定与「手机端不显示重连计数」（2026-11-18，二次改：不再只认苹果）
 *
 * 播放**不分流**：所有设备都走 FLV（现场要求）。这个文件只管两件事：
 *   ① 认出**所有手机 / 平板**（苹果、安卓、鸿蒙、自报桌面 UA 的移动浏览器），
 *      用来决定说明条要不要裁掉重连次数；
 *   ② 裁计数本身 —— 任何形态的「第几次 / 几秒后」都不许留在界面上。
 *
 * `hasMse` 只是排障探针，不参与分流，所以只断言它不抛错。
 */

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
/** 荣耀 / 华为鸿蒙：UA 里没有 Mobile，但明确是手机 */
const HARMONY =
  'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile'
/** 国产 App 内置 WebView：自报桌面，不带 Mobile */
const DESKTOP_LIKE_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 13; V2196A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Safari/537.36'
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
/** 安卓平板（不带 Mobile，靠 Tablet / Android 认） */
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 12; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ORIGINAL_UA = window.navigator.userAgent

/** 改 UA 用 defineProperty：happy-dom 的 navigator.userAgent 是只读取值器 */
function setUa(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}

afterEach(() => {
  setUa(ORIGINAL_UA)
})

describe('utils/env · 机型判定', () => {
  it('iPhone / iPad 认出来', () => {
    expect(isAppleMobile(IPHONE)).toBe(true)
    expect(isAppleMobile(IPAD)).toBe(true)
  })

  it('iPadOS 桌面版 UA（自报 Macintosh）靠触点数认出来，真 Mac 不误伤', () => {
    expect(isAppleMobile(MAC, 5)).toBe(true)
    expect(isAppleMobile(MAC, 0)).toBe(false)
  })

  it('Android / Windows 不会被当成苹果', () => {
    expect(isAppleMobile(ANDROID, 5)).toBe(false)
    expect(isAppleMobile(WINDOWS, 0)).toBe(false)
  })

  it('读的是 navigator（不传参时跟着当前 UA 走）', () => {
    setUa(IPHONE)
    expect(isAppleMobile()).toBe(true)
    setUa(ANDROID)
    expect(isAppleMobile()).toBe(false)
  })

  it('hasMse 只是排障探针：不抛错、返回布尔，且不影响任何分流', () => {
    expect(typeof hasMse()).toBe('boolean')
  })
})

describe('utils/env · 手机端判定（所有手机，不只是苹果）', () => {
  it('苹果手机 / 平板都算手机', () => {
    expect(isMobileDevice(IPHONE)).toBe(true)
    expect(isMobileDevice(IPAD)).toBe(true)
    // iPadOS 13+ 自报 Macintosh，靠触点数认
    expect(isMobileDevice(MAC, 5)).toBe(true)
  })

  it('安卓手机 / 安卓平板算手机', () => {
    expect(isMobileDevice(ANDROID, 5)).toBe(true)
    expect(isMobileDevice(ANDROID_TABLET, 5)).toBe(true)
  })

  it('鸿蒙与各家自带 WebView 算手机（UA 里没有 Mobile 也算）', () => {
    expect(isMobileDevice(HARMONY, 5)).toBe(true)
    expect(isMobileDevice(DESKTOP_LIKE_WEBVIEW, 5)).toBe(true)
  })

  it('桌面浏览器不算手机（这些设备保留重连原话，排查用）', () => {
    expect(isMobileDevice(WINDOWS, 0)).toBe(false)
    expect(isMobileDevice(MAC, 0)).toBe(false)
  })

  it('读的是 navigator（不传参时跟着当前 UA 走）', () => {
    setUa(ANDROID)
    expect(isMobileDevice()).toBe(true)
    setUa(WINDOWS)
    expect(isMobileDevice()).toBe(false)
  })
})

describe('utils/env · 重连文案去计数', () => {
  const WITH_COUNT = [
    '直播流连接失败，2 秒后自动重连（1/3）',
    '直播流中断，正在重连（第 2/3 次）',
    '画面停住了，3 秒后自动重连（1/3）',
    '直播流连接失败（已连续重试 3 次，每 10 秒继续自动重连；点播放键可立即重试）',
  ]

  it('任何形态的「第几次 / 几秒后」都裁掉，且不留下空话', () => {
    for (const raw of WITH_COUNT) {
      const out = stripRetryCount(raw)
      expect(out).not.toMatch(/\d+\s*(?:次|秒)/)
      expect(out).not.toMatch(/\d+\s*\/\s*\d+/)
      expect(out.length).toBeGreaterThan(0)
      // 原因要留着（用户得知道是断了还是卡住），并把「还在重连」说回来
      expect(out).toContain('正在自动重连')
    }
  })

  it('环境类错误（没有 MSE）原样保留：它不是重连，也没有计数', () => {
    const s = '当前浏览器不支持 MSE，无法播放 FLV 直播'
    expect(stripRetryCount(s)).toBe(s)
  })

  it('空串 / 纯空白的输入安全', () => {
    expect(stripRetryCount('')).toBe('')
    expect(stripRetryCount('   ')).toBe('')
  })

  it('不带计数的普通提示不会被改写', () => {
    const s = '直播流连接失败，正在自动重连'
    expect(stripRetryCount(s)).toBe(s)
  })
})
