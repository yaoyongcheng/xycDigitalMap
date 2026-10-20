import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import SmartImg from '@/components/ui/SmartImg.vue'
import TabBar from '@/components/shell/TabBar.vue'
import Toast from '@/components/shell/Toast.vue'
import BackBar from '@/components/ui/BackBar.vue'
import SubPage from '@/components/overlays/SubPage.vue'
import { useAirHazardStore } from '@/stores/airHazard'
import { useAlarmStore } from '@/stores/alarm'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import MinePage from '@/views/MinePage.vue'
import SafetyPanel from '@/views/home/SafetyPanel.vue'
import WorkPage from '@/views/WorkPage.vue'

/**
 * 交互优化回归（2026-10）
 *
 * 这一组钉住的是「操作繁琐 / 反馈缺失 / 状态不明确」三类问题的修复结果：
 *   - Toast 语义类型（成功与失败必须长得不一样）
 *   - 预警轮播点击直达详情（不再多走一步列表）
 *   - 隐患上报：选图被拒要给说法、描述要真的进载荷、提交要有 loading 与防连点
 *   - SmartImg 的占位 / 淡入 / 失败兜底
 *   - 退出登录的二次确认
 * 这些都是「改错了不报错、但用户会明显感到别扭」的类型，必须有回归。
 */

/** 够真的 File 替身：happy-dom 的 File 够用，这里只要 type 可控 */
function fakeFile(name: string, type: string): File {
  return new File(['x'], name, { type })
}

describe('交互优化回归', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 16, 15, 30, 0))
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Toast 语义类型', () => {
    it('默认类型是 info，停留时长保持原版 1.6s', () => {
      const shell = useShellStore()
      shell.showToast('功能待定')
      expect(shell.toastType).toBe('info')
      vi.advanceTimersByTime(1599)
      expect(shell.toastVisible).toBe(true)
      vi.advanceTimersByTime(1)
      expect(shell.toastVisible).toBe(false)
    })

    it('可指定类型与时长，长提示不会 1.6s 就被掐掉', () => {
      const shell = useShellStore()
      shell.showToast('已填内容将丢失', 'warn', 2500)
      expect(shell.toastType).toBe('warn')
      vi.advanceTimersByTime(2000)
      expect(shell.toastVisible).toBe(true)
      vi.advanceTimersByTime(500)
      expect(shell.toastVisible).toBe(false)
    })

    it('渲染出对应语义的图标与配色类', async () => {
      const shell = useShellStore()
      const w = mount(Toast)
      shell.showToast('隐患已上报', 'success')
      await nextTick()
      expect(w.find('.toast').classes()).toContain('is-success')
      expect(w.find('svg').exists()).toBe(true)
    })
  })

  describe('预警轮播直达详情', () => {
    it('点击轮播条目直接打开对应预警详情，而不是落到列表', async () => {
      const w = mount(SafetyPanel)
      const sub = useSubpageStore()
      const alarm = useAlarmStore()

      await w.find('.alarm-feed-item').trigger('click')
      expect(sub.view).toEqual({ kind: 'alarm-detail', id: alarm.latest[0].id })
      /*
       * 返回键回首页，不回巡检列表：用户是从首页安全面板点进来的，
       * 上一页就是首页。凭空插一层列表会让人觉得迷路（2026-10 修正）。
       */
      expect(sub.back).toBeNull()
    })

    it('id 失效时退回列表，不让用户卡在空详情页', async () => {
      const w = mount(SafetyPanel)
      const sub = useSubpageStore()
      sub.openAlarmDetail('no-such-id')
      expect(sub.view).toEqual({ kind: 'none' })
      expect(w.exists()).toBe(true)
    })
  })

  /*
   * 返回按钮 2026-10 统一：改造前子页是纯箭头、播放器与全屏地图是
   * 「箭头 + 返回」二字，同一动作三种长相。现在几何全部来自
   * data/icons.ts 的 back（同一份 IconDef），这里钉住渲染结果。
   */
  describe('返回按钮统一为纯左箭头', () => {
    it('播放器返回栏：只有箭头，没有「返回」文字', () => {
      const w = mount(BackBar, { props: { title: '视频监控', backId: 'btnCamBack' } })
      const btn = w.find('#btnCamBack')
      expect(btn.text()).toBe('')
      expect(btn.find('svg path').attributes('d')).toBe('M15 5 8 12l7 7')
      expect(btn.attributes('aria-label')).toBe('返回')
      // 右滑手势靠 data-back 定位该层的返回按钮
      expect(btn.attributes('data-back')).toBeDefined()
    })

    it('子页导航栏：同一套箭头几何，且带 data-back', () => {
      const w = mount(SubPage)
      const btn = w.find('#btnBack')
      expect(btn.text()).toBe('')
      expect(btn.find('svg path').attributes('d')).toBe('M15 5 8 12l7 7')
      expect(btn.attributes('data-back')).toBeDefined()
    })
  })

  /*
   * 子页是盖在 .pages 上的绝对定位层。改造前切 tab 只改 activeTab，
   * 子页不关 —— 底栏高亮变了、画面还停在详情页，用户看到的就是
   * 「点底栏没反应」。
   */
  describe('底栏切换会退出子页', () => {
    it('子页打开时点 tab：子页关闭且切到目标 tab', async () => {
      const sub = useSubpageStore()
      const shell = useShellStore()
      const alarm = useAlarmStore()
      sub.openAlarmDetail(alarm.latest[0].id, false)
      expect(sub.isOpen).toBe(true)

      const w = mount(TabBar)
      await w.find('.tab[data-tab="work"]').trigger('click')
      expect(sub.isOpen).toBe(false)
      expect(shell.activeTab).toBe('work')
    })

    it('巡检日历展开时切 tab，日历也被收起', async () => {
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      sub.openInspectList('hist')
      alarm.inspCalOpen = true

      const w = mount(TabBar)
      await w.find('.tab[data-tab="msg"]').trigger('click')
      expect(alarm.inspCalOpen).toBe(false)
      expect(sub.isOpen).toBe(false)
    })
  })

  describe('隐患上报', () => {
    it('选图被拒时回传拒绝数量与原因（原先是静默丢弃）', () => {
      const air = useAirHazardStore()
      expect(air.addHazardFiles([fakeFile('a.txt', 'text/plain'), fakeFile('b.png', 'image/png')])).toEqual({
        added: 1,
        rejectedType: 1,
        rejectedLimit: 0,
      })
      expect(air.addHazardFiles(Array.from({ length: 8 }, (_, i) => fakeFile(`${i}.png`, 'image/png')))).toEqual({
        added: 5,
        rejectedType: 0,
        rejectedLimit: 3,
      })
      expect(air.hazardImgs).toHaveLength(6)
    })

    it('描述文本进入提交载荷（原版「填了不读」已修正）', async () => {
      const air = useAirHazardStore()
      air.addHazardFiles([fakeFile('a.png', 'image/png')])
      air.hazardDesc = '  电缆拖地未架空  '

      const p = air.commitHazard()
      // 提交中：loading 标志必须立起来，用于按钮禁用 + 防连点
      expect(air.hazardSubmitting).toBe(true)

      await vi.advanceTimersByTimeAsync(600)
      const r = await p
      expect(r.ok).toBe(true)
      expect(air.hazardSubmitting).toBe(false)
      expect(air.lastSubmit).toMatchObject({ photos: 1, desc: '电缆拖地未架空' })
      expect(r.message).toContain('描述')
    })

    it('提交中重复点击不会重复提交', async () => {
      const air = useAirHazardStore()
      air.addHazardFiles([fakeFile('a.png', 'image/png')])
      const first = air.commitHazard()
      const second = await air.commitHazard()
      expect(second).toEqual({ ok: false, message: '正在提交，请勿重复点击' })
      await vi.advanceTimersByTimeAsync(600)
      await first
    })

    it('没有照片时仍然拒绝，且不进入 loading', async () => {
      const air = useAirHazardStore()
      air.hazardDesc = '只写了描述'
      const r = await air.commitHazard()
      expect(r).toEqual({ ok: false, message: '请先拍摄或选择现场照片' })
      expect(air.hazardSubmitting).toBe(false)
      expect(air.lastSubmit).toBeNull()
    })
  })

  describe('SmartImg 占位与兜底', () => {
    it('未加载完成前是占位态，load 后淡入', async () => {
      const w = mount(SmartImg, { props: { src: 'img/alarm-trash.webp', alt: 'x' } })
      const img = w.find('img')
      expect(img.classes()).toContain('simg')
      expect(img.classes()).not.toContain('is-loaded')

      await img.trigger('load')
      expect(w.find('img').classes()).toContain('is-loaded')
    })

    it('加载失败换成内联占位图，不再出破图', async () => {
      const w = mount(SmartImg, { props: { src: 'img/alarm-trash.webp' } })
      const before = w.find('img').attributes('src')
      await w.find('img').trigger('error')
      const after = w.find('img').attributes('src')
      expect(after).not.toBe(before)
      expect(after).toMatch(/^data:image\/svg\+xml/)
      expect(w.find('img').classes()).toContain('is-failed')
    })

    it('换图时重置状态，不沿用上一张的「已加载」', async () => {
      const w = mount(SmartImg, { props: { src: 'a.webp' } })
      await w.find('img').trigger('load')
      expect(w.find('img').classes()).toContain('is-loaded')
      await w.setProps({ src: 'b.webp' })
      expect(w.find('img').classes()).not.toContain('is-loaded')
    })

    it('根元素就是 img，父级传的 class 会落上去（保住 .air-card img 这类选择器）', () => {
      const w = mount(SmartImg, { props: { src: 'a.webp', pos: 'pos-tl' }, attrs: { class: 'insp-pic', id: 'pic1' } })
      const img = w.find('img')
      expect(img.element.tagName).toBe('IMG')
      expect(img.classes()).toEqual(expect.arrayContaining(['simg', 'pos-tl', 'insp-pic']))
      expect(img.attributes('id')).toBe('pic1')
    })
  })

  describe('退出登录二次确认', () => {
    it('首次点击只进入待确认，3s 无操作自动解除', async () => {
      const w = mount(MinePage)
      const shell = useShellStore()
      await w.find('#btnLogout').trigger('click')
      expect(w.find('#btnLogout').text()).toBe('确认退出')
      expect(shell.toastVisible).toBe(false)

      vi.advanceTimersByTime(3000)
      await nextTick()
      expect(w.find('#btnLogout').text()).toBe('退出登录')
    })

    it('确认后才退出，并给出成功反馈与未登录态', async () => {
      const w = mount(MinePage)
      const shell = useShellStore()
      await w.find('#btnLogout').trigger('click')
      await w.find('#btnLogout').trigger('click')
      expect(shell.toast).toBe('已退出登录')
      expect(shell.toastType).toBe('success')
      expect(w.find('.profile-banner').classes()).toContain('is-out')
      expect(w.find('#mineMenu').exists()).toBe(false)
      expect(w.find('#btnRelogin').exists()).toBe(true)
    })
  })

  describe('可点击元素的键盘可达', () => {
    it('工具卡与巡检条目都能用回车触发', async () => {
      const w = mount(WorkPage)
      const shell = useShellStore()
      await w.find('.tool-card').trigger('keydown', { key: 'Enter' })
      expect(shell.toast).toContain('接入中')

      const panel = mount(SafetyPanel)
      const sub = useSubpageStore()
      const alarm = useAlarmStore()
      await panel.find('.alarm-feed-item').trigger('keydown', { key: 'Enter' })
      expect(sub.view).toEqual({ kind: 'alarm-detail', id: alarm.latest[0].id })
    })
  })
})
