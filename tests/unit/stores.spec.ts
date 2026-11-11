import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useAirHazardStore } from '@/stores/airHazard'
import { useAlarmStore } from '@/stores/alarm'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { addDays } from '@/utils/date'

import { blobUrls } from '../helpers/browser'
import { camAlarmFixtures } from '../fixtures/camAlarms'

function pngFile(name = 'shot.png'): File {
  return new File(['x'], name, { type: 'image/png' })
}

function txtFile(name = 'note.txt'): File {
  return new File(['x'], name, { type: 'text/plain' })
}

/**
 * 状态层
 *
 * 三个 store 里塞着原版最容易被改坏的部分：抽屉档位的持久化与旧键迁移、
 * 覆盖层之间的互斥（开监控要关掉航拍/隐患）、以及抓拍/航拍这类
 * 「按日期偏移派生」的计算。这些行为没有 UI 断言可依赖，只能在这一层锁住。
 */
describe('stores', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    // 注意：这里**不能**提前实例化 auth/shell store。auth 会连带创建 shell，
    // 而 shell 的抽屉档位在初始化时就读 localStorage 并把默认值写回去；
    // 下面「抽屉档位持久化」用例随后才 setItem 就再也读不到了。
    // 阶段 5 的报警夹具只放进 cam 自己的 beforeEach。
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /* ============================================================ */

  describe('shell', () => {
    describe('抽屉档位持久化', () => {
      it('默认全开（与原版 sheetUp 初值 true 一致）', () => {
        const shell = useShellStore()
        expect(shell.sheetLevel).toBe(2)
        expect(shell.sheetUp).toBe(true)
      })

      it('优先读新的档位键', () => {
        localStorage.setItem('xyc.sheetLevel', '1')
        expect(useShellStore().sheetLevel).toBe(1)
      })

      it('新键缺失时迁移旧布尔键：0→收起、1→全开', () => {
        localStorage.setItem('xyc.sheetUp', '0')
        expect(useShellStore().sheetLevel).toBe(0)

        setActivePinia(createPinia())
        localStorage.setItem('xyc.sheetUp', '1')
        expect(useShellStore().sheetLevel).toBe(2)
      })

      it('档位值非法时视为缺失，继续走旧键迁移', () => {
        localStorage.setItem('xyc.sheetLevel', 'x')
        localStorage.setItem('xyc.sheetUp', '0')
        expect(useShellStore().sheetLevel).toBe(0)
      })

      it('档位变化同时写新键与旧键（回退旧版本不丢状态）', async () => {
        const shell = useShellStore()
        shell.sheetLevel = 1
        await nextTick()
        expect(localStorage.getItem('xyc.sheetLevel')).toBe('1')
        expect(localStorage.getItem('xyc.sheetUp')).toBe('1')

        shell.sheetLevel = 0
        await nextTick()
        expect(localStorage.getItem('xyc.sheetLevel')).toBe('0')
        expect(localStorage.getItem('xyc.sheetUp')).toBe('0')
      })

      it('存储不可用（隐私模式/配额满）时静默回退，不影响启动', async () => {
        vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
          throw new Error('SecurityError')
        })
        const shell = useShellStore()
        expect(shell.sheetLevel).toBe(2)

        vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
          throw new Error('QuotaExceededError')
        })
        shell.sheetLevel = 1
        await nextTick()
        // 写入失败但内存状态照常更新，本次会话内切换不受影响
        expect(shell.sheetLevel).toBe(1)
      })

      it('sheetUp 布尔访问器与档位双向映射', () => {
        const shell = useShellStore()
        shell.sheetUp = false
        expect(shell.sheetLevel).toBe(0)
        expect(shell.sheetUp).toBe(false)

        shell.sheetUp = true
        expect(shell.sheetLevel).toBe(2)
        expect(shell.sheetUp).toBe(true)

        shell.sheetLevel = 1
        expect(shell.sheetUp).toBe(true)
      })
    })

    describe('导航与 Toast', () => {
      it('标题跟随 tab', () => {
        const shell = useShellStore()
        expect(shell.navTitle).toBe('首页')
        shell.activeTab = 'work'
        expect(shell.navTitle).toBe('工作台')
        shell.activeTab = 'msg'
        expect(shell.navTitle).toBe('消息')
        shell.activeTab = 'mine'
        expect(shell.navTitle).toBe('我的')
      })

      it('Toast 1.6s 后自动隐藏', () => {
        vi.useFakeTimers()
        const shell = useShellStore()
        shell.showToast('已上报')
        expect(shell.toast).toBe('已上报')
        expect(shell.toastVisible).toBe(true)

        vi.advanceTimersByTime(1599)
        expect(shell.toastVisible).toBe(true)

        vi.advanceTimersByTime(1)
        expect(shell.toastVisible).toBe(false)
        // 原版只摘掉 .show，不清空文本 —— 保持一致
        expect(shell.toast).toBe('已上报')
        vi.useRealTimers()
      })

      it('连续调用会取消上一个定时器，不会提前隐藏', () => {
        vi.useFakeTimers()
        const shell = useShellStore()
        shell.showToast('A')
        vi.advanceTimersByTime(1000)
        shell.showToast('B')
        vi.advanceTimersByTime(1000)
        expect(shell.toastVisible).toBe(true)
        expect(shell.toast).toBe('B')

        vi.advanceTimersByTime(600)
        expect(shell.toastVisible).toBe(false)
        vi.useRealTimers()
      })
    })

    describe('全屏地图往返', () => {
      it('openMapLand 同时切横屏与地图层标记', () => {
        const shell = useShellStore()
        shell.openMapLand()
        expect(shell.isLandscape).toBe(true)
        expect(shell.mapLandOpen).toBe(true)
        expect(shell.mapLandReturn).toBe(false)
      })

      it('closeMapLand 清掉全部标记', () => {
        const shell = useShellStore()
        shell.openMapLand()
        shell.closeMapLand()
        expect(shell.isLandscape).toBe(false)
        expect(shell.mapLandOpen).toBe(false)
        expect(shell.mapLandReturn).toBe(false)
      })

      it('无约定时 backToMapLand 是空操作', () => {
        const shell = useShellStore()
        shell.backToMapLand()
        expect(shell.mapLandOpen).toBe(false)
      })

      it('有约定时关闭覆盖层后重新拉起地图，且约定只生效一次', () => {
        const shell = useShellStore()
        shell.mapLandReturn = true
        shell.backToMapLand()
        expect(shell.mapLandOpen).toBe(true)
        expect(shell.mapLandReturn).toBe(false)

        shell.closeMapLand()
        shell.backToMapLand()
        expect(shell.mapLandOpen).toBe(false)
      })
    })
  })

  /* ============================================================ */

  describe('cam（2026-11 阶段 5：真实通道与报警抓拍）', () => {
    beforeEach(() => {
      // 点位/抓拍来自真实报警，openCam 有登录守卫；抓拍图请求用桩挡掉
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })))
      const auth = useAuthStore()
      auth.token = 'test-token'
      auth.expiresAt = Date.now() + 3_600_000
      useAlarmStore().liveAlarms = camAlarmFixtures()
    })

    it('点位来自真实报警通道，不挂演示示意图', () => {
      const cam = useCamStore()
      expect(cam.cameras.map((c) => c.id)).toEqual(['ch-2', 'ch-3'])
      expect(cam.cameras.map((c) => c.name)).toEqual(['2号通道', '3号通道'])
      expect(cam.cameras.every((c) => c.group === '视频监控')).toBe(true)
      expect(cam.cameras.every((c) => c.img === '')).toBe(true)
    })

    it('按 group 分组：真实点位只有一组', () => {
      const cam = useCamStore()
      expect(cam.grouped.map((g) => [g.name, g.items.length])).toEqual([['视频监控', 2]])
    })

    it('没有报警数据时点位为空，currentCam 给兜底对象', () => {
      useAlarmStore().liveAlarms = []
      const cam = useCamStore()
      expect(cam.cameras).toEqual([])
      expect(cam.currentCam.name).toBe('暂无监控点位')
      expect(cam.camShots).toEqual([])
    })

    it('切换点位后 currentCam 跟随', () => {
      const cam = useCamStore()
      cam.camId = 'ch-3'
      expect(cam.currentCam.name).toBe('3号通道')
    })

    it('camId 指向不存在的点位时回退到首个', () => {
      const cam = useCamStore()
      cam.camId = 'nope'
      expect(cam.currentCam.id).toBe('ch-2')
    })

    describe('报警抓拍派生', () => {
      it('今天 2 号通道 3 条，时间取 captureTime，无假裁切位', () => {
        const cam = useCamStore()
        cam.camId = 'ch-2'
        expect(cam.camShots.map((s) => s.time)).toEqual(['08:12:00', '12:36:00', '16:50:00'])
        expect(cam.camShots.map((s) => s.pos)).toEqual(['', '', ''])
        expect(cam.camShots.map((s) => s.remoteId)).toEqual(['101', '102', '103'])
      })

      it('按通道隔离：3 号通道只有 1 条', () => {
        const cam = useCamStore()
        cam.camId = 'ch-3'
        expect(cam.camShots).toHaveLength(1)
        expect(cam.camShots[0].time).toBe('09:05:00')
      })

      it('按日期筛选：昨天 1 条，没记录的日子是空数组', () => {
        const cam = useCamStore()
        expect(cam.shotsFor('ch-2', 1)).toHaveLength(1)
        expect(cam.shotsFor('ch-2', 7)).toEqual([])
      })

      it('日期变更驱动 camShots 重算', async () => {
        const cam = useCamStore()
        cam.camId = 'ch-2'
        cam.camShotDate = addDays(new Date(), -1)
        await nextTick()
        expect(cam.camShots.map((s) => s.time)).toEqual(['10:00:00'])
      })
    })

    describe('applyCam', () => {
      it('默认清掉直播态并复位日期与日历', () => {
        const cam = useCamStore()
        cam.isLive = true
        cam.camCalOpen = true
        cam.camShotDate = new Date(2026, 0, 1)
        cam.applyCam('ch-3')
        expect(cam.camId).toBe('ch-3')
        expect(cam.isLive).toBe(false)
        expect(cam.camCalOpen).toBe(false)
        expect(cam.camShotDate.getDate()).toBe(new Date().getDate())
      })

      it('keepLive 为真时保留直播态', () => {
        const cam = useCamStore()
        cam.isLive = true
        cam.applyCam('ch-3', true)
        expect(cam.isLive).toBe(true)
      })

      it('未知 id 回退到首个真实点位', () => {
        const cam = useCamStore()
        cam.applyCam('unknown')
        expect(cam.camId).toBe('ch-2')
      })
    })

    describe('开合与互斥', () => {
      it('openCam 会关掉航拍与隐患上报，并清掉横屏', () => {
        const shell = useShellStore()
        const cam = useCamStore()
        const air = useAirHazardStore()

        air.isOpen = true
        air.hazardOpen = true
        shell.isLandscape = true

        cam.openCam('ch-3')
        expect(air.isOpen).toBe(false)
        expect(air.hazardOpen).toBe(false)
        expect(shell.isLandscape).toBe(false)
        expect(shell.isLand).toBe(false)
        expect(cam.isOpen).toBe(true)
        expect(cam.camMode).toBe('live')
        expect(cam.isLive).toBe(false)
        expect(cam.camId).toBe('ch-3')
      })

      it('closeCam 复位全部覆盖层状态', () => {
        const shell = useShellStore()
        const cam = useCamStore()
        cam.openCam('g2a')
        cam.isLive = true
        cam.camMode = 'shots'
        cam.shotPopOpen = true
        cam.camCalOpen = true
        shell.isLandscape = true
        shell.isLand = true

        cam.closeCam()
        expect(cam.isOpen).toBe(false)
        expect(cam.isLive).toBe(false)
        expect(cam.camMode).toBe('live')
        expect(cam.shotPopOpen).toBe(false)
        expect(cam.camCalOpen).toBe(false)
        expect(shell.isLandscape).toBe(false)
        expect(shell.isLand).toBe(false)
      })

      it('setCamLand 同时切两个横屏标记', () => {
        const shell = useShellStore()
        const cam = useCamStore()
        cam.setCamLand(true)
        expect(shell.isLandscape).toBe(true)
        expect(shell.isLand).toBe(true)
        cam.setCamLand(false)
        expect(shell.isLandscape).toBe(false)
        expect(shell.isLand).toBe(false)
      })

      it('showCamMode 只切视图，不动直播态', () => {
        const cam = useCamStore()
        cam.isLive = true
        cam.showCamMode('shots')
        expect(cam.camMode).toBe('shots')
        expect(cam.isLive).toBe(true)
      })

      it('抓拍大图开合', () => {
        const cam = useCamStore()
        cam.openShotPop(2)
        expect(cam.shotPopOpen).toBe(true)
        expect(cam.shotPopIdx).toBe(2)
        cam.closeShotPop()
        expect(cam.shotPopOpen).toBe(false)
        expect(cam.shotPopIdx).toBe(2)
      })
    })
  })

  /* ============================================================ */

  describe('airHazard', () => {
    describe('航拍派生', () => {
      it('照片数在 8~10 之间随日期偏移循环', () => {
        const air = useAirHazardStore()
        expect(air.airShots(0)).toHaveLength(8)
        expect(air.airShots(1)).toHaveLength(9)
        expect(air.airShots(2)).toHaveLength(10)
        expect(air.airShots(3)).toHaveLength(8)
        expect(air.airShots(-2)).toHaveLength(10)
      })

      it('时间取自 airTimes 前缀，裁切位循环取 airPos', () => {
        const air = useAirHazardStore()
        const shots = air.airShots(0)
        expect(shots[0].time).toBe('07:22')
        expect(shots.map((s) => s.pos)).toEqual([
          'pos-tl', 'pos-tr', 'pos-c', 'pos-bl', 'pos-br', 'pos-l', 'pos-r', 'pos-t',
        ])
      })

      it('取图在两张航拍图之间轮换且都是 WebP', () => {
        const air = useAirHazardStore()
        for (const s of air.airShots(0)) expect(s.img).toMatch(/^img\/aerial-[ab]\.webp$/)
        expect(air.airShots(0)[0].img).not.toBe(air.airShots(1)[0].img)
      })

      it('airList 按当前选中日期派生', () => {
        const air = useAirHazardStore()
        expect(air.airList).toHaveLength(8)
        air.airDate = new Date(2026, 9, 14)
        expect(air.airList.length).toBeGreaterThanOrEqual(8)
      })
    })

    describe('隐患照片管理', () => {
      it('接受图片文件并创建预览 URL', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile('a.png'), pngFile('b.png')])
        expect(air.hazardImgs).toHaveLength(2)
        expect(blobUrls.created).toHaveLength(2)
        expect(air.hazardImgs[0]).toMatch(/^blob:/)
      })

      it('拒绝非图片文件', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([txtFile(), pngFile()])
        expect(air.hazardImgs).toHaveLength(1)
        expect(blobUrls.created).toHaveLength(1)
      })

      it('上限 6 张，超出的不再创建 URL', () => {
        const air = useAirHazardStore()
        air.addHazardFiles(Array.from({ length: 10 }, (_, i) => pngFile(`${i}.png`)))
        expect(air.hazardImgs).toHaveLength(6)
        expect(blobUrls.created).toHaveLength(6)
      })

      it('已满时再添加不产生任何副作用', () => {
        const air = useAirHazardStore()
        air.addHazardFiles(Array.from({ length: 6 }, (_, i) => pngFile(`${i}.png`)))
        const created = blobUrls.created.length
        air.addHazardFiles([pngFile('extra.png')])
        expect(air.hazardImgs).toHaveLength(6)
        expect(blobUrls.created).toHaveLength(created)
      })

      it('删除单张会释放它自己的 ObjectURL，且不影响其它', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile('a.png'), pngFile('b.png'), pngFile('c.png')])
        const [a, b, c] = [...air.hazardImgs]

        air.removeHazardImg(1)
        expect(air.hazardImgs).toEqual([a, c])
        expect(blobUrls.revoked).toEqual([b])
      })

      it('越界删除是空操作', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile()])
        air.removeHazardImg(9)
        expect(air.hazardImgs).toHaveLength(1)
        expect(blobUrls.revoked).toHaveLength(0)
      })

      it('resetHazard 释放全部 URL 并复位表单', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile('a.png'), pngFile('b.png')])
        air.hazardKind = '用电隐患'
        air.hazardDesc = '描述'
        const created = [...blobUrls.created]

        air.resetHazard()
        expect(air.hazardImgs).toEqual([])
        expect(air.hazardKind).toBe('安全防护')
        expect(air.hazardDesc).toBe('')
        expect(blobUrls.revoked).toEqual(created)
      })

      it('重复 reset 不会重复释放（避免二次 revoke）', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile()])
        air.resetHazard()
        air.resetHazard()
        expect(blobUrls.revoked).toHaveLength(1)
      })
    })

    describe('提交', () => {
      it('没有照片时拒绝并给出提示', () => {
        const air = useAirHazardStore()
        expect(air.submitHazard()).toEqual({ ok: false, message: '请先拍摄或选择现场照片' })
      })

      it('有照片时通过', () => {
        const air = useAirHazardStore()
        air.addHazardFiles([pngFile()])
        expect(air.submitHazard()).toEqual({ ok: true, message: '隐患已上报，待整改' })
      })

      it('只填了描述、没有照片仍不放行（原版行为）', () => {
        const air = useAirHazardStore()
        air.hazardDesc = '现场有裸线'
        expect(air.submitHazard().ok).toBe(false)
      })
    })

    describe('覆盖层互斥', () => {
      it('openAir 关掉监控与隐患上报并复位日期视图', () => {
        const cam = useCamStore()
        const air = useAirHazardStore()
        cam.isOpen = true
        air.hazardOpen = true
        air.airCalOpen = true
        air.airPopOpen = true

        air.openAir()
        expect(cam.isOpen).toBe(false)
        expect(air.hazardOpen).toBe(false)
        expect(air.airCalOpen).toBe(false)
        expect(air.airPopOpen).toBe(false)
        expect(air.isOpen).toBe(true)
      })

      it('openHazard 关掉监控与航拍，并清空上次表单', () => {
        const cam = useCamStore()
        const air = useAirHazardStore()
        cam.isOpen = true
        air.isOpen = true
        air.addHazardFiles([pngFile()])

        air.openHazard()
        expect(cam.isOpen).toBe(false)
        expect(air.isOpen).toBe(false)
        expect(air.hazardOpen).toBe(true)
        expect(air.hazardImgs).toEqual([])
        expect(blobUrls.revoked).toHaveLength(1)
      })

      it('closeAir / closeHazard 复位各自标记', () => {
        const air = useAirHazardStore()
        air.isOpen = true
        air.airCalOpen = true
        air.airPopOpen = true
        air.closeAir()
        expect([air.isOpen, air.airCalOpen, air.airPopOpen]).toEqual([false, false, false])

        air.hazardOpen = true
        air.addHazardFiles([pngFile()])
        air.closeHazard()
        expect(air.hazardOpen).toBe(false)
        expect(air.hazardImgs).toEqual([])
        expect(blobUrls.revoked).toHaveLength(1)
      })
    })
  })
})
