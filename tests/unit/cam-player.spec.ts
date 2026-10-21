import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { nextTick } from 'vue'

import CamPlayer from '@/components/overlays/CamPlayer.vue'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'

/**
 * 监控播放器全屏层
 *
 * 覆盖两个评审点：
 *   1. 定时器生命周期 —— 组件常驻 DOM，曾把 1s interval 挂在 onMounted 上，
 *      回调里再判断 isOpen，等于全天候空转。现在改为跟随 isOpen 启停。
 *   2. 打开时立刻对齐时间戳（否则会沿用上一次打开时的旧值整秒）。
 * 另外把返回键的五级优先级锁住 —— 它是原版最容易改错的一处。
 */
describe('components/overlays/CamPlayer', () => {
  let wrapper: VueWrapper
  let cam: ReturnType<typeof useCamStore>
  let shell: ReturnType<typeof useShellStore>
  let intervalSpy: MockInstance
  let clearSpy: MockInstance

  const T0 = new Date(2026, 9, 16, 15, 30, 5)
  const STAMP0 = '2026-10-16 15:30:05'

  async function setOpen(open: boolean): Promise<void> {
    cam.isOpen = open
    await nextTick()
  }

  function stampText(): string {
    return wrapper.find('#camPlayerTime').text()
  }

  async function mountPlayer(): Promise<void> {
    wrapper = mount(CamPlayer)
    await nextTick()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    setActivePinia(createPinia())
    cam = useCamStore()
    shell = useShellStore()
    intervalSpy = vi.spyOn(window, 'setInterval')
    clearSpy = vi.spyOn(window, 'clearInterval')
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /* ---------------- 定时器生命周期 ---------------- */

  describe('每秒时间戳定时器', () => {
    it('关闭状态下挂载不注册任何定时器', async () => {
      await mountPlayer()
      expect(cam.isOpen).toBe(false)
      expect(intervalSpy).not.toHaveBeenCalled()
      expect(stampText()).toBe(STAMP0)
    })

    it('打开时立刻对齐时间戳，并以 1s 周期刷新', async () => {
      await mountPlayer()

      // 时间前进 10 秒后才打开播放器
      vi.setSystemTime(new Date(2026, 9, 16, 15, 30, 15))
      await setOpen(true)

      // 关键：不能沿用挂载时那一刻的旧值
      expect(stampText()).toBe('2026-10-16 15:30:15')
      expect(intervalSpy).toHaveBeenCalledTimes(1)
      expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000)

      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(stampText()).toBe('2026-10-16 15:30:16')

      vi.advanceTimersByTime(3000)
      await nextTick()
      expect(stampText()).toBe('2026-10-16 15:30:19')
    })

    it('关闭时清掉定时器，时间戳随之冻结', async () => {
      await mountPlayer()
      await setOpen(true)
      await setOpen(false)

      expect(clearSpy).toHaveBeenCalledTimes(1)
      const frozen = stampText()

      vi.advanceTimersByTime(10_000)
      expect(stampText()).toBe(frozen)
    })

    it('反复开合不会累积出多个定时器', async () => {
      await mountPlayer()
      for (let i = 0; i < 4; i++) {
        await setOpen(true)
        await setOpen(false)
      }
      expect(intervalSpy).toHaveBeenCalledTimes(4)
      expect(clearSpy).toHaveBeenCalledTimes(4)

      vi.advanceTimersByTime(5000)
      // 没有任何遗留定时器在跑
      expect(vi.getTimerCount()).toBe(0)
    })

    it('重复把 isOpen 置为 true 不会重复注册', async () => {
      await mountPlayer()
      await setOpen(true)
      await setOpen(true)
      await setOpen(true)
      expect(intervalSpy).toHaveBeenCalledTimes(1)
    })

    it('播放器打开时卸载组件会清理定时器', async () => {
      await mountPlayer()
      await setOpen(true)
      expect(vi.getTimerCount()).toBe(1)

      wrapper.unmount()
      expect(clearSpy).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('关闭状态下卸载不会误调 clearInterval', async () => {
      await mountPlayer()
      wrapper.unmount()
      expect(clearSpy).not.toHaveBeenCalled()
    })

    it('整段会话内 24h 空转已被消除（关闭态跑满一小时零定时器）', async () => {
      await mountPlayer()
      await setOpen(true)
      await setOpen(false)
      vi.advanceTimersByTime(60 * 60 * 1000)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  /* ---------------- 打开态与视图 ---------------- */

  describe('打开态渲染', () => {
    it('hidden / aria-hidden 跟随 isOpen', async () => {
      await mountPlayer()
      const root = wrapper.find('#camPlayer')
      expect(root.attributes('hidden')).toBeDefined()
      expect(root.attributes('aria-hidden')).toBe('true')

      await setOpen(true)
      expect(root.attributes('hidden')).toBeUndefined()
      expect(root.attributes('aria-hidden')).toBe('false')
      expect(root.classes()).toContain('open')
    })

    it('live / is-land 由 store 驱动', async () => {
      await mountPlayer()
      await setOpen(true)
      cam.isLive = true
      await nextTick()
      expect(wrapper.find('#camPlayer').classes()).toContain('live')

      cam.setCamLand(true)
      await nextTick()
      expect(wrapper.find('#camPlayer').classes()).toContain('is-land')
      expect(wrapper.find('#camLandText').text()).toBe('退出全屏')

      cam.setCamLand(false)
      await nextTick()
      expect(wrapper.find('#camLandText').text()).toBe('全屏')
    })

    it('直播 / 抓拍两个视图靠 hide 类互斥', async () => {
      await mountPlayer()
      await setOpen(true)
      expect(wrapper.find('#camLiveView').classes()).not.toContain('hide')
      expect(wrapper.find('#camShotsView').classes()).toContain('hide')

      cam.showCamMode('shots')
      await nextTick()
      expect(wrapper.find('#camLiveView').classes()).toContain('hide')
      expect(wrapper.find('#camShotsView').classes()).not.toContain('hide')
    })

    it('18 个点位按 3 个分组渲染芯片', async () => {
      await mountPlayer()
      await setOpen(true)
      const groups = wrapper.findAll('.cam-chip-group')
      expect(groups).toHaveLength(3)
      expect(wrapper.findAll('.cam-chip')).toHaveLength(18)
      expect(groups.map((g) => g.find('h5').text())).toEqual([
        '出入口9', '场内7', '塔吊2',
      ])
    })

    it('当前点位芯片带 on 高亮', async () => {
      await mountPlayer()
      await setOpen(true)
      expect(wrapper.find('.cam-chip.on').text()).toBe('1#门监控')
    })

    it('播放大图取当前点位的 img 与 pos', async () => {
      await mountPlayer()
      await setOpen(true)
      const frame = () => wrapper.find('#camPlayerFrame')
      expect(frame().attributes('src')).toBe(cam.currentCam.img)
      expect(frame().attributes('class') ?? '').toBe(cam.currentCam.pos)

      // 换点位后跟随（18 个点位共用同一张演示图，见 stores 用例）
      cam.camId = 'crane4'
      await nextTick()
      expect(frame().attributes('src')).toBe(cam.currentCam.img)
    })
  })

  /* ---------------- 交互 ---------------- */

  describe('交互', () => {
    it('播放按钮进入直播态并刷新时间戳', async () => {
      await mountPlayer()
      await setOpen(true)
      vi.setSystemTime(new Date(2026, 9, 16, 15, 31, 0))

      await wrapper.find('#btnCamPlay').trigger('click')
      expect(cam.isLive).toBe(true)
      expect(stampText()).toBe('2026-10-16 15:31:00')
    })

    it('切换点位芯片时 keepLive 取决于当前直播态', async () => {
      await mountPlayer()
      await setOpen(true)

      // 直播态下切换：保持直播
      cam.isLive = true
      await nextTick()
      await wrapper.findAll('.cam-chip')[10].trigger('click')
      expect(cam.isLive).toBe(true)
      expect(cam.camId).toBe(cam.cameras[10].id)

      // 非直播态下切换：清掉直播
      cam.isLive = false
      await nextTick()
      await wrapper.findAll('.cam-chip')[0].trigger('click')
      expect(cam.isLive).toBe(false)
    })

    it('历史抓拍按钮复位日期并切视图', async () => {
      await mountPlayer()
      await setOpen(true)
      cam.camShotDate = new Date(2026, 0, 1)
      cam.camCalOpen = true
      await nextTick()

      await wrapper.find('#btnCamShots').trigger('click')
      expect(cam.camMode).toBe('shots')
      expect(cam.camCalOpen).toBe(false)
      expect(cam.camShotDate.getDate()).toBe(16)
    })

    it('全屏按钮在横屏态之间切换', async () => {
      await mountPlayer()
      await setOpen(true)
      await wrapper.find('#btnCamLand').trigger('click')
      expect(shell.isLand).toBe(true)
      await wrapper.find('#btnCamLand').trigger('click')
      expect(shell.isLand).toBe(false)
    })

    it('日期芯片「昨天」把抓拍日期回退一天', async () => {
      await mountPlayer()
      await setOpen(true)
      await wrapper.find('[data-day="1"]').trigger('click')
      expect(cam.camShotDate.getDate()).toBe(15)
      expect(cam.camCalOpen).toBe(false)
    })

    it('日历芯片展开时把月份对齐到选中日所在月', async () => {
      await mountPlayer()
      await setOpen(true)
      cam.camCalOpen = false
      cam.camShotDate = new Date(2026, 6, 20)
      await nextTick()

      await wrapper.find('.cam-day-pick').trigger('click')
      expect(cam.camCalOpen).toBe(true)
      expect(cam.camCalMonth.getMonth()).toBe(6)
      expect(cam.camCalMonth.getDate()).toBe(1)
    })

    it('日历选中某天后收起', async () => {
      await mountPlayer()
      await setOpen(true)
      cam.showCamMode('shots')
      cam.camCalOpen = true
      await nextTick()

      const cells = wrapper.findAll('.cam-cal-day[data-cal]')
      expect(cells.length).toBeGreaterThan(0)
      const target = cells.find((c) => c.attributes('data-cal') === '2026-10-5')
      expect(target).toBeTruthy()

      await target!.trigger('click')
      expect(cam.camShotDate.getDate()).toBe(5)
      expect(cam.camCalOpen).toBe(false)
    })

    it('点击抓拍图打开大图弹层，关闭按钮收起', async () => {
      await mountPlayer()
      await setOpen(true)
      cam.showCamMode('shots')
      await nextTick()

      await wrapper.findAll('.cam-shot')[1].trigger('click')
      expect(cam.shotPopOpen).toBe(true)
      expect(cam.shotPopIdx).toBe(1)
      expect(wrapper.find('#camShotPop').attributes('hidden')).toBeUndefined()

      await wrapper.find('#btnShotClose').trigger('click')
      expect(cam.shotPopOpen).toBe(false)
    })

    it('大图元信息拼接点位名、日期与时间', async () => {
      await mountPlayer()
      await setOpen(true)
      cam.showCamMode('shots')
      cam.openShotPop(0)
      await nextTick()
      expect(wrapper.find('#camShotMeta').text()).toBe('1#门监控  今天  08:12')
    })
  })

  /* ---------------- 返回键优先级 ---------------- */

  describe('返回键的五级优先级', () => {
    it('① 抓拍大图打开时只关大图', async () => {
      await mountPlayer()
      cam.openCam('g1')
      await nextTick()
      cam.shotPopOpen = true
      cam.camCalOpen = true
      await nextTick()

      await wrapper.find('#btnCamBack').trigger('click')
      expect(cam.shotPopOpen).toBe(false)
      expect(cam.camCalOpen).toBe(true)
      expect(cam.isOpen).toBe(true)
    })

    it('② 日历展开时只收日历', async () => {
      await mountPlayer()
      cam.openCam('g1')
      await nextTick()
      cam.camCalOpen = true
      cam.showCamMode('shots')
      await nextTick()

      await wrapper.find('#btnCamBack').trigger('click')
      expect(cam.camCalOpen).toBe(false)
      expect(cam.camMode).toBe('shots')
      expect(cam.isOpen).toBe(true)
    })

    it('③ 抓拍视图下退回直播视图', async () => {
      await mountPlayer()
      cam.openCam('g1')
      cam.showCamMode('shots')
      await nextTick()

      await wrapper.find('#btnCamBack').trigger('click')
      expect(cam.camMode).toBe('live')
      expect(cam.isOpen).toBe(true)
    })

    it('④ 横屏态下先退出横屏', async () => {
      await mountPlayer()
      cam.openCam('g1')
      await nextTick()
      cam.setCamLand(true)
      await nextTick()

      await wrapper.find('#btnCamBack').trigger('click')
      expect(shell.isLand).toBe(false)
      expect(shell.isLandscape).toBe(false)
      expect(cam.isOpen).toBe(true)
    })

    it('⑤ 默认关闭播放器', async () => {
      await mountPlayer()
      cam.openCam('g1')
      cam.isLive = true
      await nextTick()

      await wrapper.find('#btnCamBack').trigger('click')
      expect(cam.isOpen).toBe(false)
      expect(cam.isLive).toBe(false)
      expect(shell.mapLandOpen).toBe(false)
    })

    it('从全屏地图进来时，返回会回到地图而非首页', async () => {
      await mountPlayer()
      shell.mapLandReturn = true
      cam.openCam('camb')
      await nextTick()

      await wrapper.find('#btnCamBack').trigger('click')
      expect(cam.isOpen).toBe(false)
      expect(shell.mapLandOpen).toBe(true)
      expect(shell.isLandscape).toBe(true)
      expect(shell.mapLandReturn).toBe(false)
    })

    it('优先级顺序：大图 > 日历 > 抓拍视图 > 横屏 > 关闭', async () => {
      await mountPlayer()
      cam.openCam('g1')
      await nextTick()
      cam.setCamLand(true)
      cam.showCamMode('shots')
      cam.camCalOpen = true
      cam.shotPopOpen = true
      await nextTick()

      const back = () => wrapper.find('#btnCamBack').trigger('click')

      await back() // ⑤→① 大图
      expect([cam.shotPopOpen, cam.camCalOpen, cam.camMode, shell.isLand, cam.isOpen]).toEqual([
        false, true, 'shots', true, true,
      ])

      await back() // ② 日历
      expect([cam.shotPopOpen, cam.camCalOpen, cam.camMode, shell.isLand, cam.isOpen]).toEqual([
        false, false, 'shots', true, true,
      ])

      await back() // ③ 抓拍视图
      expect([cam.camCalOpen, cam.camMode, shell.isLand, cam.isOpen]).toEqual([
        false, 'live', true, true,
      ])

      await back() // ④ 横屏
      expect([shell.isLand, cam.isOpen]).toEqual([false, true])

      await back() // ⑤ 关闭
      expect(cam.isOpen).toBe(false)
    })
  })
})
