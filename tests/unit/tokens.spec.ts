import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 设计令牌的守卫（2026-10 视觉改造第三批）
 *
 * 第三批做的事是「把已经在用的值收敛成令牌」，本身不改观感。真正有价值的是
 * 这些断言：它防的不是"现在写错"，而是**以后又慢慢长出第二套**。
 *
 * 改造前的具体病症：
 *   · 灰有 #86909C / #8A9BB0 / #6B7E96 三种近似值，同一个「次要文字」在
 *     浅色页和深色页各写一份，谁也不知道哪个才是标准
 *   · 圆角 15 种，同类卡片在 10 / 12 / 14 之间跳
 *   · 缓冲曲线 3 套各写各的，同一屏里页面进场和卡片按压手感不一致
 */

const CSS = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')

/** 令牌定义区之外的部分：守卫只针对正文，令牌自己当然要写原始值 */
function bodyOf(css: string): string {
  const start = css.indexOf(':root {')
  const end = css.indexOf('\n}', start)
  const body = css.slice(end)
  // 注释里会提到历史色值（解释"为什么换掉了"），不能算违规
  return body.replace(/\/\*[\s\S]*?\*\//g, '')
}

const BODY = bodyOf(CSS)

/** 曾经重复出现、现在必须走令牌的色值 */
const LEGACY_HEX = [
  '#86909C',
  '#8A9BB0',
  '#6B7E96',
  '#4E5969',
  '#C0C4CC',
  '#F2F6FB',
  '#E8EEF6',
  '#E8ECF0',
  '#F2F3F5',
  '#0B1626',
  '#132033',
  '#2F7CFF',
  '#4C9FFF',
  '#2EE6A6',
  '#F5C14A',
  '#FF6B6B',
  '#FF9A4D',
]

describe('设计令牌', () => {
  it('令牌本身齐全', () => {
    for (const name of [
      '--ink-1',
      '--ink-1-dark',
      '--ink-4-dark',
      '--bg-1',
      '--bg-2',
      '--bg-3',
      '--surface-2',
      '--line-2',
      '--blue-dark',
      '--ok-dark',
      '--warn-dark',
      '--danger-dark',
      '--r-2',
      '--r-pill',
      '--fs-11',
      '--fs-22',
      '--ease-out',
      '--ease-std',
      '--ease-spring',
    ]) {
      expect(CSS, `缺少令牌 ${name}`).toContain(`${name}:`)
    }
  })

  /*
   * 这一条是整批改动的主目标：同一个灰不要再写第二遍。
   * 如果以后有人为了"这个灰稍微亮一点"直接写 #8A9BB0，就会在这里失败 ——
   * 正确做法是加一个令牌，而不是在正文里埋特例。
   */
  it('正文里不再出现那些重复过的色值', () => {
    const found = LEGACY_HEX.filter((h) => BODY.toLowerCase().includes(h.toLowerCase()))
    expect(found, `这些色值应该走令牌：${found.join(', ')}`).toEqual([])
  })

  it('正文里不再有第二种缓冲曲线', () => {
    // 令牌定义区在 :root，正文里不该再出现字面量
    expect(BODY).not.toContain('cubic-bezier(')
  })

  it('圆角不再绕过阶梯', () => {
    /*
     * 只拦"阶梯里已有的值"被重新写成字面量；
     * 3/5/7/14/20/24 这类一次性值是设计上的特例，允许保留。
     */
    for (const px of [2, 4, 6, 8, 10, 12, 16, 99]) {
      expect(BODY, `border-radius: ${px}px 应写成 var(--r-*)`).not.toContain(
        `border-radius: ${px}px`,
      )
    }
  })

  it('字号不再绕过阶梯', () => {
    for (const px of [10, 11, 12, 13, 14, 16, 18, 20, 22]) {
      expect(BODY, `font-size: ${px}px 应写成 var(--fs-*)`).not.toContain(`font-size: ${px}px`)
    }
  })

  it('替换是等值的：令牌值与原字面量逐字一致', () => {
    // 这批改动声称"渲染不变"，靠的是这条：令牌只是给原值起了名字
    expect(CSS).toContain('--ink-3: #86909C;')
    expect(CSS).toContain('--ink-3-dark: #8A9BB0;')
    expect(CSS).toContain('--ink-4-dark: #6B7E96;')
    expect(CSS).toContain('--bg-2: #0B1626;')
    expect(CSS).toContain('--blue-dark: #4C9FFF;')
    expect(CSS).toContain('--danger-dark: #FF6B6B;')
    expect(CSS).toContain('--ease-out: cubic-bezier(0.22, 0.61, 0.36, 1);')
  })
})
