import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * 监控地址清单（V2 `monitorData.json`）在组件/状态机用例里不打真实网络：
 * 这里返回 null（= 清单没取到），fetcher 的调用次数就只反映「取快照」那一路，
 * 断言才有意义。清单自身的解析见 `tests/unit/cctv.spec.ts`。
 */
vi.mock('@/api/cctv', () => ({
  loadMonitorList: async () => null,
  findMonitorEntry: () => undefined,
  pickStreamUrl: () => '',
}))

/**
 * FLV 引擎在组件用例里不真跑：happy-dom 没有 MSE，真起流会立刻 `isSupported()` false
 * 并把 `playState` 打成 error，把本文件那些「说明条 / 取图」的断言全带歪。
 * 引擎自己的时序与释放见 `flv-stream.spec.ts`，组件与引擎的接线见 `cam-player-flv.spec.ts`。
 */
vi.mock('@/utils/flvStream', () => ({
  FlvStream: class {
    async start(): Promise<void> {}
    async play(): Promise<void> {}
    pause(): void {}
    retry(): void {}
    stop(): void {}
    destroy(): void {}
  },
}))

/**
 * 本文件测的是「快照侧」的行为（取图、空态、切点位缓存、说明条），
 * 所以把「网关拼出的可播地址」压成空串 —— 这样页面停在快照模式，
 * 断言不被 `<video>` 和 mpegts 干扰。
 *
 * 真实拼法（`http://120.26.34.95:9092/rtp/…live.flv?originTypeStr=rtp_push`）
 * 由 `tests/unit/cctv.spec.ts` 钉住，那里才是地址的归属地。
 */
vi.mock('@/data/cctv', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/cctv')>()
  return { ...real, cctvPlayableUrl: () => '' }
})

import CamPlayer from '@/components/overlays/CamPlayer.vue'
import { CAM_POINTS } from '@/data/cams'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { clearShots } from '@/utils/shotArchive'

/**
 * 视频监控层（2026-11-18 设计稿重做）
 *
 * 这一组钉住五件事，都是「改错了页面也不报错、但现场看到的是错的」那类：
 *   ① 点位是设计稿圈定的 9 个，分「设备设施 / 材料堆场 / 出入口管控」三组，
 *      设备设施置顶（2026-11-19 现场要求），顺序照 `CAM_POINTS`；
 *   ② 画面区只有控件（历史抓拍 + 全屏），不叠时间戳 / 点位名那种文字标签；
 *   ③ 画面只来自直播流：打开层 / 切点位都**不再取「最近一帧」快照**（旧接口已下线），
 *      要看这台相机过去的照片走历史抓拍（`/snapshots/history`）；
 *   ④ 没有可播地址就给 RTSP 地址行，既不取图也不造假播放态；
 *   ⑤ 播放键与媒体状态一致：有流时点画面→play；**播放中再点不 pause**（手机误触
 *      不能把直播停住），状态由 `<video>` 的 play / pause / error 事件驱动，
 *      连点不重复起流。
 */

const A = CAM_POINTS[0].channelId // 2#塔吊
const B = CAM_POINTS[1].channelId // 4#塔吊

/** 一张「图片」响应：够 api 层校验 content-type 与体积 */
function imgResponse(size = 512): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    blob: async () => new Blob([new Uint8Array(size)], { type: 'image/jpeg' }),
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response
}

/** 历史列表的一行（今天 12:00，`mark` / 时刻都照服务端字段给） */
function shotItem(at = shotAt()): Record<string, unknown> {
  const d = new Date(at)
  const p = (x: number): string => String(x).padStart(2, '0')
  const mark = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return {
    capturedAt: d.toISOString(),
    fileSize: 512,
    imageUrl: `/api/video/snapshots?channelId=x&mark=${mark}&pid=P000000076`,
    latest: true,
    mark,
    timestamp: at,
  }
}

/** 今天 12:00（本地时间） */
function shotAt(): number {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

/** 本地自然日 'YYYY-MM-DD'（与服务端 `date` 参数同格式） */
function localDay(d = new Date()): string {
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 历史列表信封（`{code,message,data:{items,total}}`，照实测结构）。
 *
 * 按 `date` 参数分日期：只有「今天」有这一条，别的日期空 —— 与服务端按天查、
 * 只留近 30 天的行为一致；否则「点昨天」的用例会拿到今天的图。
 */
function historyResponse(url: string, items: Record<string, unknown>[] = [shotItem()]): Response {
  let list: Record<string, unknown>[] = []
  try {
    list = new URL(url).searchParams.get('date') === localDay() ? items : []
  } catch {
    list = []
  }
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => ({
      code: 200,
      message: 'success',
      data: { items: list, page: 1, pageSize: 100, total: list.length, rangeStart: '', rangeEnd: '' },
    }),
    text: async () => '',
    blob: async () => new Blob([]),
  } as unknown as Response
}

/** 路由式桩：历史列表走 JSON，图片 / 最新一帧走字节 */
function camFetch(items?: Record<string, unknown>[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) =>
    String(url).includes('/snapshots/history')
      ? historyResponse(String(url), items)
      : imgResponse(),
  )
}

function failResponse(status = 500): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    blob: async () => new Blob([]),
  } as unknown as Response
}

function signIn(): void {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.expiresAt = Date.now() + 3_600_000
}

function stubObjectUrl(): { created: string[]; revoked: string[] } {
  const created: string[] = []
  const revoked: string[] = []
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:cam/${++n}`
    created.push(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
    revoked.push(u)
  })
  return { created, revoked }
}

describe('components/overlays/CamPlayer', () => {
  let wrapper: VueWrapper
  let cam: ReturnType<typeof useCamStore>
  let shell: ReturnType<typeof useShellStore>
  let urls: { created: string[]; revoked: string[] }

  beforeEach(async () => {
    setActivePinia(createPinia())
    signIn()
    // 历史列表回 1 条今天的抓拍，其余（取帧 / 取图）回图片字节
    vi.stubGlobal('fetch', camFetch())
    // objectURL 统一桩：每次用例从 blob:cam/1 开始，断言「有没有重复建图」才有意义
    urls = stubObjectUrl()
    cam = useCamStore()
    shell = useShellStore()
    // 抓拍档案是进程级的（单测里是内存兜底），不清就会把上一例的照片带过来
    await clearShots()
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function mountPlayer(): Promise<void> {
    wrapper = mount(CamPlayer)
    await nextTick()
  }

  async function open(id?: string): Promise<void> {
    cam.openCam(id)
    await flushPromises()
    await nextTick()
  }

  /* ---------------- 点位列表 ---------------- */

  it('按设计稿分三组渲染 9 个点位，设备设施置顶，组头数字是组内点位数', async () => {
    await mountPlayer()
    await open()

    const groups = wrapper.findAll('.cam-chip-group')
    expect(groups.map((g) => g.find('h5').text())).toEqual([
      '设备设施4',
      '材料堆场1',
      '出入口管控4',
    ])

    const chips = wrapper.findAll('.cam-chip')
    expect(chips.map((c) => c.text())).toEqual([
      '2#塔吊',
      '4#塔吊',
      '地磅全景',
      '钢筋加工棚',
      '材料堆场',
      '2#门监控1',
      '2#门监控2',
      '4#门监控',
      '4#门外监控',
    ])
  })

  it('顶栏标题与芯片高亮都跟着当前点位走', async () => {
    await mountPlayer()
    await open()

    expect(wrapper.find('#camPlayerName').text()).toBe(CAM_POINTS[0].name)
    expect(wrapper.find('.cam-chip.on').text()).toBe(CAM_POINTS[0].name)

    await wrapper.findAll('.cam-chip')[2].trigger('click')
    await flushPromises()

    expect(wrapper.find('#camPlayerName').text()).toBe('地磅全景')
    expect(wrapper.find('.cam-chip.on').text()).toBe('地磅全景')
  })

  /* ---------------- 画面区：控件可以叠，文字标签不行 ---------------- */

  it('画面区不叠时间戳 / 点位名，也没有任何静态图兜底', async () => {
    await mountPlayer()
    await open()

    const stage = wrapper.find('#camPlayerStage')
    // 旧「最近一帧」快照当 poster / 断流兜底的那张 <img> 已随接口一起删掉
    expect(stage.find('#camPlayerFrame').exists()).toBe(false)

    // 文字标签（相机 OSD 已刻在图里，点位名在顶栏）一个都不留
    expect(stage.find('.cam-time').exists()).toBe(false)
    expect(stage.find('.cam-pos-tag').exists()).toBe(false)

    // 控件按设计稿就位：右上「历史抓拍」「全屏」。
    // 中央那颗播放键 2026-11-18 撤掉了（打开自动连、断了无限重连，它只会盖画面，
    // 起播/立即重连改由点击画面承担，点画面不暂停）。这里钉死「不再出现」。
    expect(stage.find('#btnCamPlay').exists()).toBe(false)
    expect(stage.find('#camStageActs #btnCamShots').text()).toBe('历史抓拍')
    expect(stage.find('#camStageActs #btnCamLand').text()).toBe('全屏')
  })

  it('说明条只写当下的状态，不写「几点取的」', async () => {
    await mountPlayer()
    await open()
    // 没有流地址、也没点过画面：就是一句中性的「现场画面」
    expect(wrapper.find('#camStamp').text()).toBe('现场画面')
    // 说明在画面区之外，不压在图上
    expect(wrapper.find('#camPlayerStage #camStamp').exists()).toBe(false)
  })

  /* ---------------- 取图 ---------------- */

  it('打开层不再请求「最近一帧」快照（该接口已下线）', async () => {
    await mountPlayer()
    await open()

    // 画面只来自直播流；旧 `…/snapshots?pid&channelId` 那一路一次都不许再打
    const spy = fetch as unknown as ReturnType<typeof vi.fn>
    expect(spy).not.toHaveBeenCalled()
    expect(wrapper.find('#camPlayerFrame').exists()).toBe(false)
  })

  it('切点位只换当前点位与流地址，不再取图', async () => {
    await mountPlayer()
    await open()

    const spy = fetch as unknown as ReturnType<typeof vi.fn>
    await wrapper.findAll('.cam-chip')[1].trigger('click')
    await flushPromises()

    expect(cam.camId).toBe(B)
    expect(wrapper.find('.cam-chip.on').text()).toBe(CAM_POINTS[1].name)
    expect(spy).not.toHaveBeenCalled()
  })

  /* ---------------- 只有 RTSP（V2 现状） ---------------- */

  it('没有可播地址时：渲染 RTSP 地址行，不造假播放态', async () => {
    await mountPlayer()
    await open()

    const row = wrapper.find('#camRtspRow')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('仅 RTSP')
    // 地址与 V2 清单同构：/rtp/{设备编号}_{通道号}?originTypeStr=rtp_push
    expect(row.text()).toContain(`rtp/42010500441188000001_${A}?originTypeStr=rtp_push`)

    // 播不了就不挂 <video>；也没有静态兜底图，更不会有播放键
    expect(wrapper.find('#camPlayerVideo').exists()).toBe(false)
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
    expect(wrapper.find('#camPlayerFrame').exists()).toBe(false)
  })

  /* ---------------- 历史抓拍入口 ---------------- */

  it('「历史抓拍」按钮：相册语义的文案与无障碍描述，位置在画面右上', async () => {
    await mountPlayer()
    await open()

    const btn = wrapper.find('#btnCamShots')
    expect(btn.text()).toBe('历史抓拍')
    expect(btn.attributes('aria-label')).toBe('查看历史抓拍照片')
    expect(btn.attributes('aria-controls')).toBe('camShotsView')
    expect(btn.attributes('aria-expanded')).toBe('false')
    // 图标是相册，不是刷新箭头
    expect(btn.find('svg').exists()).toBe(true)
  })

  it('点「历史抓拍」切到抓拍视图：真实快照落进网格，日期芯片齐全', async () => {
    await mountPlayer()
    await open()

    expect(wrapper.find('#camShotsView').classes()).toContain('hide')

    await wrapper.find('#btnCamShots').trigger('click')
    await flushPromises()
    await nextTick()
    await flushPromises()

    expect(cam.shotsOpen).toBe(true)
    expect(wrapper.find('#camShotsView').classes()).not.toContain('hide')
    expect(wrapper.find('#camLiveView').classes()).toContain('hide')
    expect(wrapper.find('#btnCamShots').attributes('aria-expanded')).toBe('true')

    // 标题条照设计稿；右侧说明按真实更新节奏写（08 / 12 / 18 点各一次）
    expect(wrapper.find('.cam-shots-hd strong').text()).toBe('历史抓拍')
    expect(wrapper.find('.cam-shots-hd span').text()).toContain('18 点更新')
    expect(wrapper.find('.cam-shots-hd span').text()).toContain('当天 1 张')

    // 三颗日期芯片：今天 / 昨天 / 选日期（第三个带日历图标）
    const days = wrapper.findAll('.cam-day')
    expect(days.map((d) => d.text().trim())).toEqual(['今天', '昨天', '选日期'])
    expect(days[0].classes()).toContain('on')
    expect(days[2].find('svg').exists()).toBe(true)

    // 今天真取到的一帧：一张缩略图，不是示意图
    const shots = wrapper.findAll('.cam-shot')
    expect(shots).toHaveLength(1)
    expect(shots[0].find('img').attributes('src')).toMatch(/^blob:cam\//)
    expect(shots[0].text()).toContain('今天')
    // 一张抓拍两份 objectURL：列表用缩略图、详情用原图
    expect(urls.created).toHaveLength(2)
  })

  it('点开抓拍进详情：默认压缩预览，右上角有「查看原图」「全屏」', async () => {
    await mountPlayer()
    await open()
    await wrapper.find('#btnCamShots').trigger('click')
    await flushPromises()
    await nextTick()
    await flushPromises()

    await wrapper.find('.cam-shot').trigger('click')
    await nextTick()

    expect(cam.shotPopOpen).toBe(true)
    const pop = wrapper.find('#camShotPop')
    expect(pop.classes()).toContain('open')
    expect(pop.find('.cam-shot-stage img').attributes('src')).toMatch(/^blob:cam\//)
    expect(pop.find('.patrol-view-tag').text()).toBe('压缩预览')

    // 工具条在图片右上角，两颗胶囊：查看原图 / 全屏（2026-11-23 由「横屏」改名）
    const tools = pop.findAll('.pano-tools .pano-tool')
    expect(tools.map((t) => t.text())).toEqual(['查看原图', '全屏'])
    expect(tools[1].attributes('aria-pressed')).toBe('false')

    await tools[0].trigger('click')
    await nextTick()
    expect(cam.shotShowFull).toBe(true)
    expect(pop.find('.patrol-view-tag').text()).toBe('原图')

    // 返回键先关大图，再退回抓拍列表
    await wrapper.find('#btnCamBack').trigger('click')
    await nextTick()
    expect(cam.shotPopOpen).toBe(false)
    expect(cam.shotsOpen).toBe(true)
  })

  it('历史抓拍：取图失败且本机无留存 → 失败态 + 重试按钮', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failResponse(502)))

    await mountPlayer()
    await open()
    await wrapper.find('#btnCamShots').trigger('click')
    await flushPromises()
    await nextTick()

    const empty = wrapper.find('[data-empty="cam-shots"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('抓拍获取失败')
    expect(empty.text()).toContain('上游视频服务或索引异常')

    // 重试：这次通了，网格里就有图
    // 历史列表回 1 条今天的抓拍，其余（取帧 / 取图）回图片字节
    vi.stubGlobal('fetch', camFetch())
    await empty.find('button').trigger('click')
    await flushPromises()
    await nextTick()
    await flushPromises()

    expect(cam.shotsState).toBe('ok')
    expect(wrapper.findAll('.cam-shot')).toHaveLength(1)
  })

  it('历史抓拍：这一天服务端没有记录就给空态，不用今天的图顶替', async () => {
    await mountPlayer()
    await open()
    await wrapper.find('#btnCamShots').trigger('click')
    await flushPromises()
    await nextTick()
    await flushPromises()

    // 点「昨天」芯片
    await wrapper.findAll('.cam-day')[1].trigger('click')
    await flushPromises()
    await nextTick()

    expect(wrapper.findAll('.cam-shot')).toHaveLength(0)
    const empty = wrapper.find('[data-empty="cam-shots"]')
    expect(empty.text()).toContain('这一天没有抓拍记录')
    // 空态只留结论 + 「重新获取」，不念长说明
    expect(empty.text()).not.toContain('本机也没有留存记录')
    expect(empty.find('span').exists()).toBe(false)
  })

  it('历史抓拍视图里返回键先回画面，再按才关层', async () => {
    await mountPlayer()
    await open()
    await wrapper.find('#btnCamShots').trigger('click')
    await flushPromises()

    await wrapper.find('#btnCamBack').trigger('click')
    await nextTick()
    expect(cam.shotsOpen).toBe(false)
    expect(cam.isOpen).toBe(true)
    expect(wrapper.find('#camLiveView').classes()).not.toContain('hide')

    await wrapper.find('#btnCamBack').trigger('click')
    await flushPromises()
    expect(cam.isOpen).toBe(false)
  })

  it('切点位会退回画面视图（抓拍入口不跨点位停留）', async () => {
    await mountPlayer()
    await open()
    await wrapper.find('#btnCamShots').trigger('click')
    await flushPromises()
    expect(cam.shotsOpen).toBe(true)

    cam.applyCam(CAM_POINTS[1].channelId)
    await flushPromises()
    expect(cam.shotsOpen).toBe(false)
  })

  it('没有可播地址时点画面什么都不做：不取图、不假装连一下', async () => {
    await mountPlayer()
    await open()

    const spy = fetch as unknown as ReturnType<typeof vi.fn>
    await wrapper.find('#camPlayerStage').trigger('click')
    await wrapper.find('#camPlayerStage').trigger('click')
    await flushPromises()

    expect(spy).not.toHaveBeenCalled()
    expect(wrapper.find('#camPlayerFrame').exists()).toBe(false)
    // 同一个点位再点一次芯片也不发请求
    await wrapper.findAll('.cam-chip')[0].trigger('click')
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
  })

  /* ---------------- 横屏与返回 ---------------- */

  it('全屏键进横屏，文案随之变成「退出全屏」，再点退出', async () => {
    await mountPlayer()
    await open()

    expect(wrapper.find('#btnCamLand').text()).toBe('全屏')
    await wrapper.find('#btnCamLand').trigger('click')
    await nextTick()

    expect(shell.isLand).toBe(true)
    expect(wrapper.find('#camPlayer').classes()).toContain('is-land')
    expect(wrapper.find('#btnCamLand').text()).toBe('退出全屏')

    await wrapper.find('#btnCamLand').trigger('click')
    await nextTick()
    expect(shell.isLand).toBe(false)
    expect(shell.isLandscape).toBe(false)
    expect(wrapper.find('#btnCamLand').text()).toBe('全屏')
  })

  it('横屏时返回键先退出横屏，再按一次才关层', async () => {
    await mountPlayer()
    await open()
    cam.setCamLand(true)
    await nextTick()

    await wrapper.find('#btnCamBack').trigger('click')
    expect(shell.isLand).toBe(false)
    expect(cam.isOpen).toBe(true)

    await wrapper.find('#btnCamBack').trigger('click')
    await flushPromises()
    expect(cam.isOpen).toBe(false)
  })

  it('关闭后重新打开保持上次选中的点位', async () => {
    await mountPlayer()
    await open()
    await wrapper.findAll('.cam-chip')[3].trigger('click')
    await flushPromises()

    await wrapper.find('#btnCamBack').trigger('click')
    await flushPromises()
    expect(cam.isOpen).toBe(false)

    await open()
    expect(wrapper.find('#camPlayerName').text()).toBe('钢筋加工棚')
    expect(wrapper.find('.cam-chip.on').text()).toBe('钢筋加工棚')
  })

  /* ---------------- 登录守卫 ---------------- */

  it('未登录打开：跳登录页，播放器不打开', async () => {
    useAuthStore().clear()
    await mountPlayer()
    await open()

    expect(useSubpageStore().view).toEqual({ kind: 'login' })
    expect(cam.isOpen).toBe(false)
    expect(wrapper.find('#camPlayer').attributes('hidden')).toBeDefined()
  })

  it('已打开时登录态失效：播放态复位、抓拍清空，不留给下一个人', async () => {
    await mountPlayer()
    await open()
    cam.openShots()
    await flushPromises()
    expect(cam.shots.length).toBeGreaterThan(0)

    useAuthStore().clear()
    await flushPromises()
    expect(cam.shots).toEqual([])
    expect(cam.playState).toBe('idle')
  })
})

/**
 * 播放键 ↔ 视频联动（2026-11-18）
 *
 * 组件用例里默认把「网关拼出的可播地址」压成空串（见文件头的 mock），
 * 「有流」这条路因此要靠注入一个点位 `stream` 才能测：
 * 第一个点位临时挂一个 `stream`（真实环境走 `VITE_CAM_STREAM_TEMPLATE` 或点位
 * 自带的 `stream`），下面钉住的就是「接上流之后行为必须对」——
 *   · 点一下立刻播当前通道，按钮同步变「暂停」；
 *   · 再点暂停、再点继续，反复点不出错（play() 被打断不是故障）；
 *   · 流打不开就回落快照，不留在黑屏上；
 *   · 切点位把播放态复位，不把上一个通道的「在播」带过来。
 */
describe('components/overlays/CamPlayer · 播放与视频联动', () => {
  const live = CAM_POINTS[0]
  const origPlay = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play')
  const origPause = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause')

  let wrapper: VueWrapper
  let cam: ReturnType<typeof useCamStore>
  let playSpy: ReturnType<typeof vi.fn>
  let pauseSpy: ReturnType<typeof vi.fn>

  /**
   * happy-dom 没有实现 play/pause，这里按真实语义桩掉：改 `paused` + 派发事件。
   * 组件正是听这两个事件来同步按钮的 —— 桩得越像，测的就越接近真机。
   */
  function installMedia(): void {
    playSpy = vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { value: false, configurable: true })
      this.dispatchEvent(new Event('play'))
      return Promise.resolve()
    })
    pauseSpy = vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { value: true, configurable: true })
      this.dispatchEvent(new Event('pause'))
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      value: playSpy,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      value: pauseSpy,
      writable: true,
      configurable: true,
    })
  }

  function restoreMedia(): void {
    if (origPlay) Object.defineProperty(HTMLMediaElement.prototype, 'play', origPlay)
    if (origPause) Object.defineProperty(HTMLMediaElement.prototype, 'pause', origPause)
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    signIn()
    // 历史列表回 1 条今天的抓拍，其余（取帧 / 取图）回图片字节
    vi.stubGlobal('fetch', camFetch())
    stubObjectUrl()
    live.stream = `https://gw.test/live/${live.channelId}.m3u8`
    installMedia()
    cam = useCamStore()
  })

  afterEach(() => {
    wrapper?.unmount()
    restoreMedia()
    delete live.stream
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function open(): Promise<void> {
    wrapper = mount(CamPlayer)
    await nextTick()
    cam.openCam()
    await flushPromises()
    await nextTick()
  }

  it('点画面立刻播当前通道的流，画面里始终没有播放键', async () => {
    await open()

    const video = wrapper.find('#camPlayerVideo')
    expect(video.exists()).toBe(true)
    expect(video.attributes('src')).toBe(live.stream)
    // 有可播地址就不再露 RTSP 行
    expect(wrapper.find('#camRtspRow').exists()).toBe(false)
    // 播放键整颗撤掉：打开自动连、断了无限重连，它只会盖住画面
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)

    await wrapper.find('#camPlayerStage').trigger('click')
    expect(playSpy).toHaveBeenCalledTimes(1)

    await nextTick()
    expect(wrapper.find('#camStamp').text()).toBe('现场画面 · 直播中')
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
  })

  it('被系统暂停后点画面继续播，按钮全程不出现', async () => {
    await open()
    await wrapper.find('#camPlayerStage').trigger('click')
    await nextTick()
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)

    // 系统 / 耳机 / 切后台把播放停了（真实 pause 事件）
    ;(wrapper.find('#camPlayerVideo').element as HTMLVideoElement).pause()
    await nextTick()
    // 暂停态也不摆按钮：再点画面就能继续
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)

    await wrapper.find('#camPlayerStage').trigger('click')
    await nextTick()
    expect(playSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
  })

  it('播放中连点画面不暂停：手机上误触不会把画面停住，也不重复起流', async () => {
    await open()
    const stage = wrapper.find('#camPlayerStage')

    await stage.trigger('click') // 起播
    const video = wrapper.find('#camPlayerVideo').element as HTMLVideoElement
    expect(video.paused).toBe(false)

    // 手机上手指落在画面上最容易来这几下 —— 以前第二下就是 pause，
    // 画面定在最后一帧，看着像卡死
    await stage.trigger('click')
    await stage.trigger('click')
    await nextTick()

    expect(pauseSpy).toHaveBeenCalledTimes(0)
    expect(video.paused).toBe(false)
    expect(cam.playState).toBe('playing')
    // 已经在播就不再叫 play：连点既不暂停，也不重复起流
    expect(playSpy).toHaveBeenCalledTimes(1)
    // 点画面不会带出任何取图请求（没有快照兜底这条路了）
    expect(fetch).not.toHaveBeenCalled()
    expect(wrapper.find('#camPlayerVideo').attributes('src')).toBe(live.stream)
  })

  it('play() 被紧随的 pause 打断（AbortError）不当作故障', async () => {
    await open()
    playSpy.mockImplementationOnce(() => Promise.reject(
      Object.assign(new Error('The play() request was interrupted'), { name: 'AbortError' }),
    ))

    await wrapper.find('#camPlayerStage').trigger('click')
    await flushPromises()

    // 没有 play 事件 → 状态还是「播放」，没有被误判成出错
    expect(cam.playState).toBe('idle')
    expect(wrapper.find('#camPlayerVideo').exists()).toBe(true)
  })

  it('原生流打不开：只把画面蒙起来并说清原因；点画面换元素重连', async () => {
    await open()

    await wrapper.find('#camPlayerVideo').trigger('error')
    await nextTick()

    // 元素留着、只蒙起来：销毁元素等于丢掉解码管线，重连还得从头建
    expect(wrapper.find('#camPlayerVideo').exists()).toBe(true)
    expect(wrapper.find('#camPlayerVideo').classes()).toContain('is-veiled')
    // 不再回落任何静态图
    expect(wrapper.find('#camPlayerFrame').exists()).toBe(false)
    // 原因说清楚（不再被一句笼统的「不可用」盖掉）
    expect(wrapper.find('#camStamp').text()).toBe('直播流连接失败，正在自动重连')
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)

    // 再点画面：原生播法换一个 <video> 元素重来，而不是偷偷换成取快照
    const before = wrapper.find('#camPlayerVideo').element
    await wrapper.find('#camPlayerStage').trigger('click')
    await flushPromises()
    expect(wrapper.find('#camPlayerVideo').element).not.toBe(before)
    expect(wrapper.find('#camPlayerVideo').classes()).not.toContain('is-veiled')
    expect(cam.playState).toBe('idle')
  })

  it('切点位把播放态复位，不把「在播」带到新点位', async () => {
    await open()
    await wrapper.find('#camPlayerStage').trigger('click')
    await nextTick()
    expect(cam.playState).toBe('playing')

    await wrapper.findAll('.cam-chip')[1].trigger('click')
    await flushPromises()
    await nextTick()

    expect(cam.playState).toBe('idle')
    expect(wrapper.find('#btnCamPlay').exists()).toBe(false)
  })
})
