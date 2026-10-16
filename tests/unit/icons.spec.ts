import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SvgIcon from '@/components/ui/SvgIcon.vue'
import { ICONS, type IconName } from '@/data/icons'

import { expectSvgNamespace } from '../helpers/dom'

const ALL_NAMES = Object.keys(ICONS) as IconName[]

/** 把渲染出的形状收敛成「标签 + 属性」的可比对象 */
function fingerprints(root: Element): { tag: string; attrs: Record<string, string> }[] {
  return [...root.children].map((el) => {
    const attrs: Record<string, string> = {}
    for (const a of [...el.attributes]) attrs[a.name] = a.value
    return { tag: el.tagName.toLowerCase(), attrs }
  })
}

/**
 * 图标体系
 *
 * 2026-10 把「HTML 字符串 + v-html」重构为「结构化数据 + SvgIcon 组件」，
 * 全站 9 处静态图标都受影响。这组用例守住两件事：
 *   1. 数据本身合法（几何缺失、标签名写错都会在这里拦下）
 *   2. 组件把数据**一比一**渲染成真实 SVG 元素 —— 属性名、数值、顺序都不能漂移
 */
describe('data/icons + SvgIcon', () => {
  describe('图标数据完整性', () => {
    it('至少包含重构前的全部图标', () => {
      expect(ALL_NAMES.length).toBeGreaterThanOrEqual(20)
      expect(ALL_NAMES).toEqual(
        expect.arrayContaining([
          'tab-home', 'tab-work', 'tab-msg', 'tab-mine',
          'mod-safety', 'mod-quality', 'mod-progress', 'mod-equip',
          'menu-sites', 'menu-setting', 'menu-about',
          'msg-people', 'drone', 'ms-flag', 'cal',
          'work-cam', 'work-hazard', 'work-todo',
          'tool-vertical', 'tool-horizontal', 'tool-nav',
        ]),
      )
    })

    it.each(ALL_NAMES)('%s：viewBox 合法且形状非空', (name) => {
      const def = ICONS[name]
      expect(def.viewBox).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/)
      expect(Array.isArray(def.shapes)).toBe(true)
      expect(def.shapes.length).toBeGreaterThan(0)
    })

    it.each(ALL_NAMES)('%s：每个形状的标签与必填属性齐备', (name) => {
      for (const s of ICONS[name].shapes) {
        expect(['path', 'circle', 'rect']).toContain(s.tag)

        if (s.tag === 'path') {
          expect(typeof s.d).toBe('string')
          expect(String(s.d).trim()).not.toBe('')
        } else if (s.tag === 'circle') {
          for (const k of ['cx', 'cy', 'r']) {
            expect(typeof s[k], `${name} 缺少 ${k}`).toBe('number')
          }
        } else {
          for (const k of ['x', 'y', 'width', 'height']) {
            expect(typeof s[k], `${name} 缺少 ${k}`).toBe('number')
          }
        }
      }
    })

    it.each(ALL_NAMES)('%s：根属性只有字符串或数字', (name) => {
      for (const [k, v] of Object.entries(ICONS[name].attrs ?? {})) {
        expect(['string', 'number'], `${name}.${k}`).toContain(typeof v)
      }
    })

    it('共用根属性的图标都带描边配置（否则会渲染成实心黑块）', () => {
      for (const name of ALL_NAMES) {
        const attrs = ICONS[name].attrs
        if (attrs && attrs['stroke-width'] != null) {
          expect(attrs.stroke, `${name} 有描边宽度却没有描边色`).toBeTruthy()
        }
      }
    })
  })

  describe('SvgIcon 渲染', () => {
    it('根节点落在 SVG 命名空间（组件重构后最容易踩的坑）', () => {
      const w = mount(SvgIcon, { props: { name: 'tab-home' } })
      expectSvgNamespace(w.element)
      expect(w.element.tagName.toLowerCase()).toBe('svg')
    })

    it.each(ALL_NAMES)('%s：形状标签、属性与顺序与数据一比一对齐', (name) => {
      const w = mount(SvgIcon, { props: { name } })
      const def = ICONS[name]

      expect(w.element.getAttribute('viewBox')).toBe(def.viewBox)

      const got = fingerprints(w.element)
      expect(got).toHaveLength(def.shapes.length)

      def.shapes.forEach((s, i) => {
        expect(got[i].tag).toBe(s.tag)
        for (const [k, v] of Object.entries(s)) {
          if (k === 'tag') continue
          expect(got[i].attrs[k], `${name} shape[${i}].${k}`).toBe(String(v))
        }
        // tag 本身不应被写进 DOM
        expect(got[i].attrs.tag).toBeUndefined()
      })
    })

    it('根属性写在 <svg> 上，形状不继承', () => {
      const w = mount(SvgIcon, { props: { name: 'drone' } })
      expect(w.element.getAttribute('fill')).toBe('none')
      expect(w.element.getAttribute('stroke')).toBe('#fff')
      expect(w.element.getAttribute('stroke-width')).toBe('1.8')
      expect(w.element.getAttribute('stroke-linecap')).toBe('round')
      for (const el of [...w.element.children]) {
        expect(el.getAttribute('stroke')).toBeNull()
      }
    })

    it('无根属性的图标不写出多余属性', () => {
      const w = mount(SvgIcon, { props: { name: 'tab-home' } })
      // SVG 属性名大小写敏感，必须是驼峰 viewBox
      expect([...w.element.attributes].map((a) => a.name)).toEqual(['viewBox'])
    })

    it('每条形状都是 SVG 命名空间下的真实节点', () => {
      const w = mount(SvgIcon, { props: { name: 'tab-work' } })
      for (const el of [...w.element.children]) {
        expectSvgNamespace(el)
      }
    })

    it('class 等外部属性透传到根节点', () => {
      const w = mount(SvgIcon, {
        props: { name: 'cal' },
        attrs: { class: 'msg-svg', 'aria-hidden': 'true' },
      })
      expect(w.element.classList.contains('msg-svg')).toBe(true)
      expect(w.element.getAttribute('aria-hidden')).toBe('true')
      // 组件自身的根属性没被挤掉
      expect(w.element.getAttribute('stroke-width')).toBe('1.8')
    })

    it('同名属性可被调用方覆盖', () => {
      const w = mount(SvgIcon, {
        props: { name: 'cal' },
        attrs: { 'stroke-width': '2' },
      })
      expect(w.element.getAttribute('stroke-width')).toBe('2')
    })

    it('不产生任何文本节点（回归：v-html 时代若转义失败会漏出 "<path"）', () => {
      for (const name of ALL_NAMES) {
        const w = mount(SvgIcon, { props: { name } })
        expect(w.element.textContent).toBe('')
        expect(w.html()).not.toContain('&lt;')
      }
    })

    it('关键图标几何逐字保留（重构不允许改画法）', () => {
      const home = mount(SvgIcon, { props: { name: 'tab-home' } })
      expect(home.element.querySelector('path')?.getAttribute('d')).toBe(
        'M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z',
      )

      const work = mount(SvgIcon, { props: { name: 'tab-work' } })
      const rects = work.element.querySelectorAll('rect')
      expect(rects).toHaveLength(4)
      expect([...rects].map((r) => [r.getAttribute('x'), r.getAttribute('y')])).toEqual([
        ['4', '4'], ['13', '4'], ['4', '13'], ['13', '13'],
      ])

      const flag = mount(SvgIcon, { props: { name: 'ms-flag' } })
      const paths = flag.element.querySelectorAll('path')
      expect(paths).toHaveLength(2)
      expect(paths[0].getAttribute('stroke')).toBe('currentColor')
      expect(paths[1].getAttribute('fill')).toBe('currentColor')
    })

    it('同名图标重复渲染结果一致', () => {
      const a = mount(SvgIcon, { props: { name: 'mod-equip' } })
      const b = mount(SvgIcon, { props: { name: 'mod-equip' } })
      expect(a.html()).toBe(b.html())
    })
  })
})
