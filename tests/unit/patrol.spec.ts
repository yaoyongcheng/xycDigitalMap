import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

import SheetHost from '@/components/overlays/SheetHost.vue'
import { patrolCats, patrolPhotos } from '@/data/config'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import HomeSheet from '@/views/home/HomeSheet.vue'
import PatrolPanel from '@/views/home/PatrolPanel.vue'

/**
 * 智巡照片墙（2026-10 版本同步 · 第三批）
 *
 * 钉住三件事：
 *   1. 分类切换后列表与张数同步（六个分类、互斥单选）
 *   2. 卡片按拍摄时间倒序 —— 现场最关心「最近一张是什么」
 *   3. 点开的大图走第一批的底部弹层，标题 / 分类 / 来源 / 时间齐备
 */

const Host = defineComponent({
  components: { PatrolPanel, SheetHost },
  setup: () => () => h('div', [h(PatrolPanel), h(SheetHost)]),
})

describe('智巡面板', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('六个分类，默认停在项目全景', () => {
    const w = mount(PatrolPanel)
    const cats = w.findAll('.patrol-cats button')

    expect(cats).toHaveLength(6)
    expect(cats.map((b) => b.text())).toEqual(patrolCats.map((c) => c.name))
    expect(cats[0].classes()).toContain('on')
    expect(cats[0].attributes('aria-pressed')).toBe('true')
    w.unmount()
  })

  it('默认分类只列本类照片，且按时间倒序', () => {
    const w = mount(PatrolPanel)

    const cards = w.findAll('.patrol-card')
    expect(cards).toHaveLength(2)
    // 16:12 在 15:48 之前
    expect(cards[0].text()).toContain('项目全景')
    expect(cards[1].text()).toContain('项目鸟瞰')
    expect(w.find('.patrol-hd em').text()).toBe('2 张')
    w.unmount()
  })

  it('切分类后列表、张数与选中态同步', async () => {
    const w = mount(PatrolPanel)

    const equip = w.findAll('.patrol-cats button').find((b) => b.text() === '施工装备')
    await equip!.trigger('click')

    expect(equip!.classes()).toContain('on')
    expect(w.findAll('.patrol-card')).toHaveLength(3)
    expect(w.find('.patrol-hd em').text()).toBe('3 张')
    w.unmount()
  })

  it('数据里每个分类都有照片，没有空分类', () => {
    for (const c of patrolCats) {
      expect(patrolPhotos.some((p) => p.cat === c.id), `${c.name} 没有照片`).toBe(true)
    }
  })
})

describe('智巡大图弹层', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('点卡片开弹层，标题 / 分类 / 来源 / 时间齐备', async () => {
    const w = mount(Host)

    const equip = w.findAll('.patrol-cats button').find((b) => b.text() === '施工装备')
    await equip!.trigger('click')
    await w.findAll('.patrol-card')[0].trigger('click')
    await nextTick()

    expect(w.find('.pop-title').text()).toBe('塔吊')
    // 分类 / 来源 / 时间三行都在 meta 里，标题行不重复
    expect(w.find('.patrol-meta').text()).toContain('施工装备')
    expect(w.find('.patrol-meta').text()).toContain('无人机')
    // 弹层内大图按 fit 完整显示，不裁切
    expect(w.find('.patrol-view img').attributes('src')).toContain('patrol-crane-2.webp')
    expect(w.find('.patrol-meta').text()).toContain('今天 16:55')
    w.unmount()
  })

  it('监控抓拍的照片标「视频监控」', async () => {
    const w = mount(Host)

    const equip = w.findAll('.patrol-cats button').find((b) => b.text() === '施工装备')
    await equip!.trigger('click')
    // 施工电梯这张来自视频监控（cam）
    await w.findAll('.patrol-card')[2].trigger('click')
    await nextTick()

    const store = useBottomSheetStore()
    expect(store.kind).toBe('patrol')
    expect(w.find('.patrol-meta').text()).toContain('视频监控')
    w.unmount()
  })
})

describe('首页三模块', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('名称与顺序是 智巡 / 智眸 / 智控（含副标题）', () => {
    const w = mount(HomeSheet, { props: { dragTop: null } })
    const mods = w.findAll('.home-mod')

    expect(mods).toHaveLength(3)
    expect(mods.map((b) => b.text())).toEqual([
      '智巡风险预警・人员动态',
      '智眸现场快照・实景核验',
      '智控集群管控・数驱作业',
    ])
    expect(mods.map((b) => b.attributes('data-mod'))).toEqual(['safety', 'patrol', 'equip'])
    w.unmount()
  })

  it('切到智巡会挂载照片墙（面板容器随之重挂载）', async () => {
    const w = mount(HomeSheet, { props: { dragTop: null } })
    const before = w.find('#homePanels').element

    await w.findAll('.home-mod')[1].trigger('click')
    await nextTick()

    expect(w.find('#homePanels').element).not.toBe(before)
    expect(w.find('.patrol-grid').exists()).toBe(true)
    w.unmount()
  })
})
