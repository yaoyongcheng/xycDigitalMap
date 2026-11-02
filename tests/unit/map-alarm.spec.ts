import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import MapLand from '@/components/overlays/MapLand.vue'
import MapViewer from '@/components/ui/MapViewer.vue'
import { useAlarmStore } from '@/stores/alarm'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'

/**
 * 报警撒点与二维地图（2026-10 版本同步 · 第二批）
 *
 * 这批的风险不在「画不出来」，而在坐标口径：
 *   三维图（透视渲染 1024×735）与二维图（正射影像 1024×861）取景不同，
 *   同一组百分比坐标搬到另一张图上就是错的。用例把三件事钉住：
 *   1. 两套坐标各自取对（含靠近边界时标签翻边）
 *   2. 切二维时设施撒点必须隐藏、报警点必须换坐标
 *   3. 关闭地图后复位成三维，下次进来不会停在二维
 */

describe('报警撒点', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('只撒当日预警，两套坐标各自独立', () => {
    const alarm = useAlarmStore()

    const pins = alarm.mapAlarms('pin')
    expect(pins.map((p) => p.id)).toEqual(['trash', 'cable', 'net', 'soil'])
    expect(pins[0]).toMatchObject({ x: 32, y: 78 })

    const flats = alarm.mapAlarms('flat')
    expect(flats.map((p) => p.id)).toEqual(['trash', 'cable', 'net', 'soil'])
    // 同一条预警在两张图上的位置不同 —— 这正是不能共用一套坐标的证据
    expect(flats.find((p) => p.id === 'trash')).toMatchObject({ x: 34, y: 86 })
    expect(flats.find((p) => p.id === 'soil')).toMatchObject({ x: 60, y: 26 })
    expect(pins.find((p) => p.id === 'soil')).toMatchObject({ x: 66, y: 62 })
  })

  it('第三条预警靠近右边界，标签要翻到点的左侧', () => {
    const alarm = useAlarmStore()
    expect(alarm.mapAlarms('pin').find((p) => p.id === 'net')?.left).toBe(true)
    expect(alarm.mapAlarms('pin').find((p) => p.id === 'trash')?.left).toBe(false)
  })

  it('MapViewer 按坐标渲染并上抛报警 id', async () => {
    const w = mount(MapViewer, {
      props: {
        points: [],
        alarms: [
          { id: 'trash', title: '环境报警', x: 32, y: 78 },
          { id: 'net', title: '防护报警', x: 22, y: 48, left: true },
        ],
      },
    })

    const pins = w.findAll('.alarm-pin')
    expect(pins).toHaveLength(2)
    expect(pins[0].attributes('style')).toContain('left: 32%')
    expect(pins[0].attributes('style')).toContain('top: 78%')
    expect(pins[0].text()).toBe('环境报警')
    expect(pins[1].classes()).toContain('is-left')

    await pins[0].trigger('click')
    expect(w.emitted('alarm')?.[0]).toEqual(['trash'])
    w.unmount()
  })
})

describe('二维 / 三维地图', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function openMap() {
    const shell = useShellStore()
    shell.openMapLand()
    const w = mount(MapLand)
    await nextTick()
    return w
  }

  it('默认三维：底图是 site-map，设施点与报警点同时在场', async () => {
    const w = await openMap()

    expect(w.find('.map-canvas img').attributes('src')).toContain('site-map.webp')
    expect(w.findAll('.map-pin').length).toBeGreaterThan(0)
    expect(w.findAll('.alarm-pin')).toHaveLength(4)
    expect(w.find('.map-land-flat').text()).toBe('二维地图')
    w.unmount()
  })

  it('切二维：换正射底图、隐藏设施点、报警点换坐标', async () => {
    const w = await openMap()

    await w.find('.map-land-flat').trigger('click')

    expect(w.find('.map-canvas img').attributes('src')).toContain('site-flat.webp')
    // 设施撒点只有三维坐标，硬搬到正射影像上会指错位置 —— 必须隐藏
    expect(w.findAll('.map-pin')).toHaveLength(0)
    expect(w.findAll('.alarm-pin')).toHaveLength(4)
    expect(w.find('.alarm-pin').attributes('style')).toContain('left: 34%')
    expect(w.find('.map-land').classes()).toContain('is-flat')
    // 按钮文案跟着当前态走：写的是「点了我回到三维」
    expect(w.find('.map-land-flat').text()).toBe('三维地图')
    expect(w.find('.map-land-flat').attributes('aria-pressed')).toBe('true')
    w.unmount()
  })

  it('关闭地图后复位成三维', async () => {
    const w = await openMap()
    await w.find('.map-land-flat').trigger('click')

    useShellStore().closeMapLand()
    await nextTick()
    expect(w.find('.map-land').classes()).not.toContain('is-flat')

    useShellStore().openMapLand()
    await nextTick()
    expect(w.find('.map-canvas img').attributes('src')).toContain('site-map.webp')
    w.unmount()
  })

  it('点报警撒点：先退出横屏地图，再进预警详情', async () => {
    const w = await openMap()
    const shell = useShellStore()
    const sub = useSubpageStore()

    await w.find('.alarm-pin').trigger('click')

    expect(shell.mapLandOpen).toBe(false)
    expect(sub.view).toEqual({ kind: 'alarm-detail', id: 'trash' })
    w.unmount()
  })
})
