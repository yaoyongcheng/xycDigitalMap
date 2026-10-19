import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import TabBar from '@/components/shell/TabBar.vue'
import { useAirHazardStore } from '@/stores/airHazard'
import { useCamStore } from '@/stores/cam'
import { useMsgStore } from '@/stores/msg'
import { useShellStore } from '@/stores/shell'
import MsgPage from '@/views/MsgPage.vue'
import MinePage from '@/views/MinePage.vue'
import ProgressPanel from '@/views/home/ProgressPanel.vue'
import WorkPage from '@/views/WorkPage.vue'

import { expectSvgNamespace } from '../helpers/dom'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const PUBLIC_IMG = join(ROOT, 'public', 'img')

/** 递归收集带指定后缀的文件 */
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, exts, out)
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full)
  }
  return out
}

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** 只取 <template> 块 —— 避免把源码注释里提到的 v-html 也算进来 */
function templateBlock(vueSrc: string): string {
  const start = vueSrc.indexOf('<template>')
  const end = vueSrc.lastIndexOf('</template>')
  return start >= 0 && end > start ? vueSrc.slice(start, end) : ''
}

/** 去掉注释，避免文档里提到的 v-html / 标签名被当成代码 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

/**
 * 结构性回归守卫
 *
 * 这一组不做运行时断言，而是对着源码和发布目录做静态检查 ——
 * 2026-10 的三项改造（图片转 WebP、图标去 v-html、图标表重构）
 * 都属于「改错了不一定报错、但会在真机上出问题」的类型：
 *   - 图片引用改名漏改一处 → 某个页面悄悄 404（背景图 404 不会报错）
 *   - 有人新写一处 v-html → innerHTML 解析面又回来了
 * 因此用清单式断言把它们钉住。
 */
describe('结构性守卫', () => {
  const srcFiles = walk(SRC, ['.ts', '.vue', '.css'])
  const vueFiles = srcFiles.filter((f) => f.endsWith('.vue'))
  const allScanned = [...srcFiles, join(ROOT, 'index.html')]

  describe('图片资源', () => {
    const refs = new Map<string, string[]>()

    for (const file of allScanned) {
      const text = read(file)
      for (const m of text.matchAll(/img\/[A-Za-z0-9._-]+\.(?:webp|jpg|jpeg|png|avif|svg)/g)) {
        const list = refs.get(m[0]) ?? []
        list.push(relative(ROOT, file).replace(/\\/g, '/'))
        refs.set(m[0], list)
      }
    }

    const referenced = [...refs.keys()].sort()

    it('至少引用了全部 8 张业务图', () => {
      expect(referenced).toEqual([
        'img/aerial-a.webp',
        'img/aerial-b.webp',
        'img/alarm-cable.webp',
        'img/alarm-net.webp',
        'img/alarm-soil.webp',
        'img/alarm-trash.webp',
        'img/cam-crane2.webp',
        'img/site-map.webp',
      ])
    })

    it('每一处引用都指向真实存在的文件', () => {
      for (const ref of referenced) {
        const p = join(ROOT, 'public', ref)
        expect(existsSync(p), `${ref} 不存在（引用自 ${refs.get(ref)!.join(', ')}）`).toBe(true)
      }
    })

    it('没有任何 jpg / png 引用残留', () => {
      const raster = referenced.filter((r) => /\.(?:jpe?g|png)$/.test(r))
      expect(raster).toEqual([])
    })

    it('public/img 下没有未被引用的孤儿资源', () => {
      const onDisk = readdirSync(PUBLIC_IMG).sort()
      const referencedNames = referenced.map((r) => r.replace('img/', '')).sort()
      expect(onDisk).toEqual(referencedNames)
    })

    it('public/img 下只剩 WebP', () => {
      for (const name of readdirSync(PUBLIC_IMG)) {
        expect(name).toMatch(/\.webp$/)
      }
    })

    it('原图与两张死重 PNG 已移出发布目录并留档', () => {
      const legacy = join(ROOT, 'legacy', 'img-unused')
      for (const name of [
        'site-map.jpg',
        'cam-crane2.jpg',
        'cam-frame.png',
        'cam-kitchen.png',
      ]) {
        expect(existsSync(join(legacy, name)), `${name} 应留档在 legacy/img-unused/`).toBe(true)
      }
    })

    it('每个图片引用点都被登记（新增引用必须同步更新此清单）', () => {
      const owners = new Set([...refs.values()].flat())
      for (const f of owners) {
        expect(existsSync(join(ROOT, f))).toBe(true)
      }
      // 引用点应在这些文件里：配置、两个 store、地图视图、样式、类型注释
      expect([...owners].sort()).toEqual([
        'src/components/ui/MapViewer.vue',
        'src/data/config.ts',
        'src/stores/alarm.ts',
        'src/stores/cam.ts',
        'src/styles/app.css',
        'src/types.ts',
      ])
    })
  })

  describe('v-html 白名单', () => {
    /** 模板里真正用了 v-html 的文件 */
    const withVhtml = vueFiles
      .filter((f) => templateBlock(read(f)).includes('v-html'))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      .sort()

    it('动态图表只剩 TouchChart 一处在用 v-html', () => {
      // InspectList 的趋势图已改走 TouchChart 触控层（2026-10 交互优化），
      // 退出了 v-html 白名单；唯一剩下的合法消费点就是 TouchChart 底图。
      expect(withVhtml).toEqual(['components/ui/TouchChart.vue'])
    })

    it('绑定的必须是 chart.ts 生成的 SVG 字符串', () => {
      const touchChart = templateBlock(read(join(SRC, 'components/ui/TouchChart.vue')))
      expect(touchChart).toMatch(/v-html="model\.svg"/)
    })

    it('不再有任何直接赋值 innerHTML', () => {
      for (const file of srcFiles) {
        expect(read(file), relative(ROOT, file)).not.toMatch(/\.innerHTML\s*=/)
      }
    })

    it('静态图标全部经由 SvgIcon 组件渲染', () => {
      const users = vueFiles
        .filter((f) => read(f).includes("from '@/components/ui/SvgIcon.vue'"))
        .map((f) => relative(SRC, f).replace(/\\/g, '/'))
        .sort()
      expect(users.length).toBeGreaterThanOrEqual(8)
      expect(users).toEqual(
        expect.arrayContaining([
          'components/shell/TabBar.vue',
          'components/ui/DayPickChips.vue',
          'views/MinePage.vue',
          'views/MsgPage.vue',
          'views/WorkPage.vue',
          'views/home/HomeSheet.vue',
          'views/home/ProgressPanel.vue',
          'views/sub/InspectList.vue',
        ]),
      )
    })

    it('图标表里不再有拼 HTML 字符串的痕迹', () => {
      const code = stripComments(read(join(SRC, 'data/icons.ts')))
      // 只要出现任何一个 SVG 标签字面量，就说明又回到了拼 HTML 的老路
      expect(code).not.toContain('<svg')
      expect(code).not.toContain('<path')
      expect(code).not.toContain('<rect')
      expect(code).not.toContain('<circle')
      expect(code).not.toContain('v-html')
    })
  })

  describe('改造后的组件端到端渲染图标', () => {
    /** 统计组件内所有 SVG 形状节点 */
    function shapes(w: VueWrapper): number {
      return w.findAll('svg path, svg rect, svg circle, svg line, svg ellipse').length
    }

    /** 每个渲染出来的 svg 都必须是 SVG 命名空间下的真实节点，且不含文本 */
    function assertAllSvgReal(w: VueWrapper): void {
      const svgs = w.findAll('svg')
      expect(svgs.length).toBeGreaterThan(0)
      for (const svg of svgs) {
        expectSvgNamespace(svg.element)
        expect(svg.element.textContent).toBe('')
      }
      expect(w.html()).not.toContain('&lt;')
    }

    beforeEach(() => {
      setActivePinia(createPinia())
    })

    it('底部标签栏：4 个 tab，几何与图标表一致', () => {
      const w = mount(TabBar)
      const tabs = w.findAll('.tab')
      expect(tabs).toHaveLength(4)

      // home 1 path / work 4 rect / msg 1 path / mine 1 circle + 1 path
      const counts = tabs.map((t) => ({
        path: t.element.querySelectorAll('path').length,
        rect: t.element.querySelectorAll('rect').length,
        circle: t.element.querySelectorAll('circle').length,
      }))
      expect(counts).toEqual([
        { path: 1, rect: 0, circle: 0 },
        { path: 0, rect: 4, circle: 0 },
        { path: 1, rect: 0, circle: 0 },
        { path: 1, rect: 0, circle: 1 },
      ])
      expect(shapes(w)).toBe(8)
      assertAllSvgReal(w)
    })

    it('底部标签栏：未读角标读消息 store', async () => {
      const w = mount(TabBar)
      expect(w.find('.badge').text()).toBe('2')

      const msg = useMsgStore()
      msg.markRead('inspect')
      msg.markRead('people')
      await nextTick()
      expect(w.find('.badge').exists()).toBe(false)
    })

    it('底部标签栏：点击切换 activeTab', async () => {
      const w = mount(TabBar)
      await w.find('[data-tab="work"]').trigger('click')
      expect(useShellStore().activeTab).toBe('work')
    })

    it('工作台：7 枚图标共 22 条形状', () => {
      const w = mount(WorkPage)
      expect(w.findAll('.work-short')).toHaveLength(4)
      expect(w.findAll('.work-short svg')).toHaveLength(4)
      expect(w.findAll('.tool-ico svg')).toHaveLength(3)
      expect(shapes(w)).toBe(22)
      assertAllSvgReal(w)
    })

    it('工作台：快捷入口分别接到对应 store 动作', async () => {
      const w = mount(WorkPage)
      const cam = useCamStore()
      const air = useAirHazardStore()

      await w.find('[data-work="cam"]').trigger('click')
      expect(cam.isOpen).toBe(true)

      await w.find('[data-work="photo"]').trigger('click')
      expect(air.isOpen).toBe(true)
      expect(cam.isOpen).toBe(false)

      await w.find('[data-work="hazard"]').trigger('click')
      expect(air.hazardOpen).toBe(true)
      expect(air.isOpen).toBe(false)
    })

    it('工作台：待定入口给 Toast 而不是静默', async () => {
      const w = mount(WorkPage)
      await w.find('[data-work="todo2"]').trigger('click')
      expect(useShellStore().toast).toBe('功能待定')
    })

    it('消息页：两类消息的图标形状正确', () => {
      const w = mount(MsgPage)
      const icons = w.findAll('.msg-ico')
      expect(icons).toHaveLength(2)
      // people 1 circle + 1 path；inspect(drone) 4 circle + 1 path + 1 rect
      expect(icons[0].element.querySelectorAll('circle').length).toBe(1)
      expect(icons[1].element.querySelectorAll('circle').length).toBe(4)
      expect(icons[1].element.querySelectorAll('rect').length).toBe(1)
      expect(shapes(w)).toBe(8)
      assertAllSvgReal(w)
    })

    it('我的页：3 个菜单项各一枚图标', () => {
      const w = mount(MinePage)
      expect(w.findAll('.menu-item')).toHaveLength(3)
      expect(w.findAll('.menu-ico svg path')).toHaveLength(3)
      expect(shapes(w)).toBe(3)
      assertAllSvgReal(w)
    })

    it('进度面板：7 个里程碑各一枚旗帜图标', () => {
      const w = mount(ProgressPanel)
      const items = w.findAll('.ms-item')
      expect(items.length).toBeGreaterThanOrEqual(7)
      expect(w.findAll('.ms-ico svg')).toHaveLength(items.length)
      // 旗杆描边 + 旗面填充
      expect(w.findAll('.ms-ico svg path')).toHaveLength(items.length * 2)
      expect(w.find('.ms-ico svg path').attributes('stroke')).toBe('currentColor')
      assertAllSvgReal(w)
    })
  })
})
