import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { beginRecordBatch, endRecordBatch, fetchFacilityGallery, fetchLatestPano, fetchMediaJobs, fetchSafetyGallery, fetchSpotGallery, fetchTaskRecords, fetchYardGallery, FACILITY_TASK_NAME, SAFETY_SOIL_TASK_NAME, SPOT_TASK_NAME, YARD_TASK_NAME, type DroneMedia, type DronePano } from '@/api/drone'
import { fetchCamShotHistory } from '@/api/camsnap'
import { ApiError } from '@/api/http'
import { CRANE_SHOTS, GATE_SHOTS } from '@/data/cams'
import { isEquirect } from '@/utils/pano'
import { ensureShot, latestShot, type ShotRecord } from '@/utils/shotArchive'

/**
 * 巡检照片（2026-11 阶段 8：改真实航拍图；2026-11-16 重构取数与分类）
 *
 * ## 数据链（与 V2 / keehang 的结构一致）
 *
 * 平台的组织层级就是「项目 → 任务（航线）→ 执行记录 → 媒体文件」，照片天然挂在
 * 某一次飞行上，所以：
 *
 *   `GET /task/exec/list/record`（本项目 pid + 日期窗口）→ 执行记录
 *   `GET /media/task/job/{执行记录id}` → 该次飞行的照片（OSS 签名直链 + 缩略图）
 *
 * 没有「照片分类」接口，也没有分类字段 —— 数据库设计文档里媒体表只有
 * `LinkId / RecordId / MediaType / Url / LimitUrl / Thumbnail / Name / Size`。
 * 因此**分类 = 所属任务**（`taskId` / `taskName`），不是靠关键词猜画面内容。
 *
 * ⚠️ 早先版本按任务名关键词猜「项目全景 / 基坑区域 / …」六类，现场 15 条航线
 * 里有 9 条一个词都不命中，全掉进「未分类」—— 那 7 个按钮里有 2 个是猜出来的。
 * 2026-11-16 用户要求去掉「未分类」：改成按任务归组后，每张照片必属于某次飞行，
 * 这个兜底分类自然不存在了。
 *
 * ## 三个必须知道的接口行为（实测）
 *
 * 1. **`size` 参数不生效**：带 `start/end` 时返回区间内全部记录（近 30 天约 458 条），
 *    不带日期按开始时间**升序**回全部 1663 条。所以「最新照片」不能靠 `page=1`，
 *    必须自己按 `start` 倒序。
 * 2. **记录里混着未来排班**：`end` 已经排到 11-23，这些记录 `status=2` 但媒体为 0。
 *    必须用 `start <= 现在` 过滤掉，否则一直取到「今天下午 5 点」这种还没飞的班。
 * 3. **媒体只能逐条取**（`/media/task/job/{id}`，`job/list` 之类端点不存在），
 *    所以按倒序最多试 `MAX_PROBE` 条，够 `MAX_JOBS` 个任务就收手。
 *
 * ## 关于图片体积（2026-11-16 用户要求「像微信那样」）
 *
 * 原图单张 4~8MB；媒体接口同时给了 `thumbnail`（约 370~520KB，实测全部有值）。
 * 列表只用缩略图；点开大图先显示**同一张缩略图**（已在缓存里，秒开），
 * 用户点「查看原图」才去拉原图并显示下载进度。`limitUrl` 不是压缩版 ——
 * 实测与 `url` 一模一样的字节数，只是换了 moss 域名，别拿它当低清图。
 *
 * ## 全景（2026-11-16 改吃「拼接成果」）
 *
 * 原片只是原料：一次「向阳村-全景」飞 26 张 4032×3024 的碎片，**平台已经把它们
 * 拼成了等距圆柱图**，存在重建成果里（`/dashboard/recreate/*`，V2 的
 * 「控制 → 成果预览」用的就是这套）。所以这条航线**不进照片墙**、也不自己拼球，
 * 只由 `loadPano()` 取回最近一个成果点（见 `api/drone.ts` 的 `fetchLatestPano`）。
 *
 * 照片墙里那条「2:1 就是全景」的判定（`utils/pano.ts` 的 `isEquirect`）仍然保留：
 * 万一某天媒体里直接出现一张等距圆柱图，大图弹层照样能进环视。
 *
 * ## 全景航拍（2026-11-18：对齐 V2「任务记录 → 采集图片」）
 *
 * 「全景航拍」这一格不再是照片墙的一类，而是**固定 9 张**：
 * `向阳村-全局定点拍照` 最近一班**已完成且有照片**的飞行（`fetchSpotGallery`）。
 * V2 就是在这条航线的执行记录里点「采集数据 → 采集图片」看那 9 张，所以这里
 * 复用同一组接口与筛法：`/task/exec/list/record` → `/media/task/job/{id}`，
 * 只留 `image/*`（每班还有 1 个 `.DAT` 日志），按 DJI 序号升序。
 * 这条航线的照片因此**不进** `photos`（否则会在「安全巡查」里重复一遍）。
 */

/** 一张真实航拍照片 */
export interface PatrolPhotoReal {
  /** 唯一 id：`{jobId}-{文件名}` */
  id: string
  /** 文件名 */
  name: string
  /** OSS 原图直链（带签名，有有效期） */
  url: string
  /** OSS 缩略图直链（约 440KB）；空串表示该文件没有缩略图 */
  thumbnail: string
  /** 所属任务名（同时也是它的分类名） */
  taskName: string
  /** 所属任务 id（同一条航线的每次执行都相同） */
  taskId: number | null
  /** 所属任务的执行记录 id（媒体 job） */
  jobId: number
  /** 拍摄/上传时间 */
  time: string
  /** 文件大小（字节，原图） */
  size: number
  /** MIME 类型 */
  mediaType: string
  /**
   * 来源是**视频监控的抓拍**（不是无人机航拍）。
   *
   * 目前只有「设备设施」里那两张塔吊抓拍带这个标记 —— 卡片与弹层的来源徽标
   * 因此要写「视频监控」（绿标），不能一律写「无人机」（蓝标）。
   * 其余所有照片都不带它就是航拍，判断也只认这个字段，不靠 `taskName` 猜。
   */
  snap?: boolean
}

/** 状态：idle / loading / ok / error */
export type PatrolState = 'idle' | 'loading' | 'ok' | 'error'

/**
 * 取数窗口（天）。先取近 30 天；一条照片都没有再退到近 180 天。
 *
 * 现场每天都在飞，30 天足够；退到 180 天是为了「停飞一段时间后进来看看」这种
 * 场景不至于一片空白 —— 但只多试一次，不做无限回溯。
 */
const WINDOWS = [30, 180] as const

/** 按时间倒序最多试多少条执行记录（每条一次请求，控制首屏时间） */
const MAX_PROBE = 16
/**
 * 最多收多少个任务的照片。
 *
 * 取 10 是因为分类是固定六类：任务数太少时「基坑区域 / 作业面 / 材料堆场」容易
 * 一条航线都轮不到，六格里空一半（实测 8 个任务时基坑区域空着，而昨天刚飞过土方）。
 */
const MAX_JOBS = 10
/**
 * **每个任务**最多收多少张。
 *
 * 不能设成全局总张数：一次「正射」就有 108 张、「三维」几百张，先扫到的任务
 * 会把配额吃光，后面的任务连按钮都出不来（实测全局 120 张时只剩 5 个分类，
 * 正射 / 全景 / 全局定点直接消失）。按任务配额后，8 个任务每个都有代表照片，
 * 想细看某一张点开大图即可。
 */
const MAX_PER_TASK = 24

/**
 * 媒体接口是**串行 + 有间隔**发的。
 *
 * `GET /media/task/job/{id}` 有服务端限流：连续请求会返回
 * `{code: 42901, msg: "查询过于频繁，请2秒后再试！"}`。2026-11-16 实测标定：
 *
 * | 请求间隔 | 结果 |
 * |---|---|
 * | 4 路并发 | 第一轮能过，之后全拒（页面 0 张） |
 * | 600ms | 14 次全被拒 |
 * | 1200ms | 13 / 14 成功 |
 *
 * 所以取 900ms（比 600ms 明显安全、比 1200ms 快），被限流就等 `THROTTLE_WAIT`
 * 重试一次。代价是「扫满 8 个任务要十几秒」—— 因此照片是**边探边上屏**的
 * （见 `probe` 里写入 `photos` 的位置），不是等全部探完才显示。
 */
const PROBE_GAP = 900
/** 被限流后的等待（服务端只提示「稍后再试」，实测 3 秒后成功率明显回升） */
const THROTTLE_WAIT = 3_000
/**
 * keehang 的限流业务码。
 *
 * 2026-11-20 实测：服务端改回 **HTTP 200 + `{code:429, msg:"当前查询较多，请稍后再试！"}`
 * + `data: []`**（12 条记录里 10 条如此），而旧代码只认 `42901` —— 碰上 429
 * 直接 `return null` 不重试，照片墙因此必然空。两个码都算，并与
 * `api/drone.ts` 的 `STATION_THROTTLE_CODES` 保持一致。
 */
const THROTTLE_CODES = new Set([429, 42901])

/**
 * 切回智眸面板的刷新节流。
 *
 * 首页三个标签来回切会反复触发 `refresh()`，每次都扫一遍媒体必然撞限流。
 * 一分钟内的重复进入直接复用上一批照片（现场照片不会秒级变化）。
 */
const REFRESH_GAP = 60_000

/** `YYYY-MM-DD`，offset 为天 */
function dayKey(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 毫秒等待（串行请求之间的间隔 / 被限流后的退避） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 本地当前时刻，格式与服务端 `start` 一致（`YYYY-MM-DDTHH:mm:ss`） */
function nowKey(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 一张照片的分类 key = 它所属的任务。
 *
 * 有任务 id 用 id（任务改名不会把分类拆成两个），拿不到才退回任务名。
 * 页面筛选与 store 的 `cats` 必须用同一个算法，所以放在这里导出。
 */
export function patrolCatKey(p: Pick<PatrolPhotoReal, 'taskId' | 'taskName'>): string {
  return p.taskId === null ? `name:${p.taskName}` : `task:${p.taskId}`
}

/**
 * 这条航线是不是「全景航线」。
 *
 * 现场唯一一条叫「向阳村-全景」，一次飞 3 个全景点（每个 26 张）。
 * 它的**原片不进照片墙** —— 那些碎片是拼接原料，成果由平台拼好（见 `loadPano`）。
 */
export function isPanoTask(taskName: string): boolean {
  return String(taskName ?? '').includes('全景')
}

/**
 * 全景在弹层里的「照片 id」。
 *
 * 大图弹层是按照片 id 打开一张图，而「项目全景」来自重构成果、没有照片 id，
 * 所以给它一个不会与真实媒体名冲突的保留值；`SheetHost` 与 `PatrolSheet`
 * 都认这个常量（别在两处各写一个字符串）。
 */
export const PANO_SHEET_ID = 'pano'

export const usePatrolStore = defineStore('patrol', () => {
  /** 真实照片 */
  const photos = ref<PatrolPhotoReal[]>([])
  /** 本次同步扫过的飞行次数（页面可显示「已同步 N 次飞行」） */
  const flightCount = ref(0)
  /** 最新一个全景点（平台已拼好，没有全景航线时为 null） */
  const pano = ref<DronePano | null>(null)
  /**
   * 全景的加载状态：idle / loading / ok / error
   *
   * 单独一套，不跟 `state` 混：照片墙和全景是两条独立的链（一个扫媒体、
   * 一个查重建成果），全景取不到不该把整页翻回骨架。
   */
  const panoState = ref<PatrolState>('idle')

  /**
   * 「全景航拍」模块的 9 张：`向阳村-全局定点拍照` **最近一班有照片的飞行**。
   *
   * 单独一条链（`fetchSpotGallery`），不混进 `photos`：
   *   · 照片墙按任务分组，这条航线的照片挂到「安全巡查」里会和 V2 对不上；
   *   · 这里要的是**固定 9 张**、顺序与 V2 采集图片那排缩略图一致；
   *   · 弹层按 id 找图，所以 `photoById()` 两个数组都要看。
   */
  const spot = ref<PatrolPhotoReal[]>([])
  /** 9 张图的加载状态（与 `panoState` 同理，单独一套，失败不拖累照片墙） */
  const spotState = ref<PatrolState>('idle')

  /**
   * 「材料堆场」模块的 3 张：`向阳村-分区定点拍照` 最近一班有照片的飞行里
   * **第 1、第 2、第 37 张**（用户按 V2 采集照片网格点出来的固定三格）。
   *
   * 与 `spot` 同构：单独一条链（`fetchYardGallery`）、单独一套加载态，不进 `photos`
   * —— 这一格现在**只认这三张**，不再按航线名把塔吊定点那批照片混进来。
   */
  const yard = ref<PatrolPhotoReal[]>([])
  /** 材料堆场三张的加载状态 */
  const yardState = ref<PatrolState>('idle')

  /**
   * 「设备设施」模块的 **4 张**（2026-11-20 由 2 张扩到 4 张）。
   *
   * 前两张：`向阳村-塔吊定点` 最近一班有照片的飞行里 **第 2、第 7 张**
   * （用户按 V2 采集照片网格点出来的固定两格）—— 单独一条链
   * （`fetchFacilityGallery`）、单独一套加载态，不进 `photos`。
   *
   * 后两张（`snap: true`）：2#塔吊 / 4#塔吊 各自**最新的一条历史抓拍** ——
   * 与工作台同一个接口（`/snapshots/history`）。这两路服务端目前**没有历史索引**
   * （`total=0`），所以实际展示的通常是本机缓存里最新那张（看过监控 / 首页就会留下）；
   * 缓存也没有就少这两张，不编照片。
   *
   * 顺序 = 展示顺序（航拍在前、抓拍在后），所以这里**不做排序**。
   */
  const facility = ref<PatrolPhotoReal[]>([])
  /** 设备设施四张的加载状态 */
  const facilityState = ref<PatrolState>('idle')

  /**
   * 「安全巡查」模块的 2 张：**跨两条航线**，各取最近一班的指定一张
   * （`向阳村-土方1` 第 1 张 + `向阳村-分区定点拍照` 第 34 张，见
   * `api/drone.ts` 的 `SAFETY_SOURCES`）。
   *
   * 与 `yard / facility` 同构：单独一条链（`fetchSafetyGallery`）、单独一套加载态，
   * 不进 `photos` —— 这一格只认那两张，不再按航线名把「配电箱定点」「道路巡检」
   * 那一堆混进来。两张的 `jobId / taskName` 不同，所以是两条记录拼起来的，
   * 卡片标题仍显示各自真实航线名。
   */
  const safety = ref<PatrolPhotoReal[]>([])
  /** 安全巡查两张的加载状态 */
  const safetyState = ref<PatrolState>('idle')

  /**
   * 「出入口管控」模块的 **5 张**（2026-11-20 新增）。
   *
   * 5 个来源见 `data/cams.ts` 的 `GATE_SHOTS`（视频监控A / 2#门监控1 /
   * 2#门监控2 / 4#门监控 / 4#门外监控），每个来源**只取最新的一条历史抓拍**。
   *
   * 与「设备设施」后两张同一套取法（`snapShotOf`）：历史列表最新一条 → 该通道无历史
   * 或接口不可用时退回本机缓存最新那条 → 都没有就不出现，不拿别的图顶替。
   *
   * 这一格**不再走照片墙**（原先 `groups.get('yard')` 按航线名归组，实际常年为空）：
   * 出入口看的是视频监控的实时抓拍，与无人机航线不是一回事。
   * 顺序 = 来源表顺序，不做排序（`snap: true` 让卡片写「抓拍 / 视频监控」）。
   */
  const gate = ref<PatrolPhotoReal[]>([])
  /** 出入口管控五张的加载状态 */
  const gateState = ref<PatrolState>('idle')

  /**
   * 照片 id → 原图尺寸（宽 × 高）。
   *
   * 来源是列表里 `<img>` 的 `naturalWidth/Height` —— 缩略图与原图尺寸一致，
   * 加载缩略图时顺手就拿到了，不用为「判断是不是全景」再发一次请求。
   * 记录后不再覆盖（同一张图的尺寸不会变）。
   */
  const dims = ref<Record<string, { w: number; h: number }>>({})

  const state = ref<PatrolState>('idle')
  const error = ref('')

  let lastFailAt = 0
  let lastOkAt = 0
  let inflight: Promise<void> | null = null
  /**
   * 「设备设施」这一格的取数序号。
   *
   * 连点「重试」会并发两次 `loadFacility`：抓拍那两张要下 300KB×2，慢的那次
   * 回来得晚，落地就会把新的一批盖回旧的（还会把别人正在显示的 objectURL
   * 撤掉）。所以只让最后一次落地，前面的在中途的 await 之后直接退。
   */
  let facilitySeq = 0
  /**
   * 「出入口管控」这一格的取数序号（同 `facilitySeq`）。
   *
   * 5 张是串行取的、要好几秒，连点「重试」会并发两次：只让最后一次落地，
   * 慢的那次回来后直接退（否则会把新的一批盖回旧的，还会撤掉正在显示的 URL）。
   */
  let gateSeq = 0

  /** 照片按时间倒序（最新在前） */
  const list = computed<PatrolPhotoReal[]>(() =>
    photos.value
      .slice()
      .sort((a, b) => b.time.localeCompare(a.time) || a.name.localeCompare(b.name)),
  )

  /** 体积摘要（字节 → 可读） */
  function sizeText(bytes: number): string {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }

  /**
   * 毫秒 → 'YYYY-MM-DD HH:mm:ss'。
   *
   * 与无人机媒体的 `time` 字段**同一种字符串格式**：卡片与弹层都只做
   * `slice(0, 16)`，格式不一致会显示成半截时间（所以不交给 `toISOString`，
   * 它带 `T` 和 `Z`，还要再换时区）。
   */
  function stampOf(ms: number): string {
    const d = new Date(ms)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  /* ---- 抓拍（视频监控）的 objectURL ---- */

  /**
   * 受管的 objectURL 池。
   *
   * 抓拍每次刷新都会重新取字节 → 重新建 objectURL，所以必须自己登记、
   * 下次重取（或登出 reset）时统一 `revoke`；一张 300KB，不撤就是纯泄漏。
   *
   * 不放进 `dims` / `photos` 那些结构里：它们跟着数据走，而 objectURL 的生命
   * 周期是「这次渲染」，混在一起迟早出现「数据还在、图已经撤了」的黑块。
   *
   * 设备设施（2 张塔吊）与出入口管控（5 个门禁）**各持一个池**：两格是两条独立
   * 的链、刷新时机不同，共用一个池会在一边重取时把另一边正在显示的图撤掉。
   */
  function makeUrlPool(): { make: (b: Blob) => string; release: () => void } {
    let urls: string[] = []
    return {
      /** 建一个受管理的 objectURL（环境不支持时返回空串，卡片会退成文字占位） */
      make(b: Blob): string {
        if (typeof URL.createObjectURL !== 'function') return ''
        try {
          const u = URL.createObjectURL(b)
          urls.push(u)
          return u
        } catch {
          return ''
        }
      },
      release(): void {
        for (const u of urls) {
          try {
            URL.revokeObjectURL(u)
          } catch {
            /* 老内核 / 单测环境没有 revoke：忽略 */
          }
        }
        urls = []
      },
    }
  }

  const cranePool = makeUrlPool()
  /** 出入口管控的池（`loadGate` 每轮换一个，见那里的说明） */
  let gatePool = makeUrlPool()

  /* ---- 快照请求的全局串行队列 ---- */

  /**
   * 同一时刻只打一张快照。
   *
   * 监控接口文档明确要求「多通道逐张请求，遇 429 按 `Retry-After` 重试，避免
   * 并发占带宽」，实测同一秒打两路就回 429。设备设施的 2 张与出入口管控的 5 张
   * 是两条并行跑的链，所以队列必须放在**模块级共享**，各排各的等于没排。
   */
  let snapQueue: Promise<unknown> = Promise.resolve()

  function snapSerial<T>(fn: () => Promise<T>): Promise<T> {
    const next = snapQueue.then(fn, fn)
    // 队列本身不能因为一次失败就断掉：吞掉结果，只往下传「轮到你了」
    snapQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 「最新一条」的取法：历史列表第 1 页第 1 条（服务端按抓拍时刻倒序）。
   *
   * 这个请求走调用方的串行队列（`snapSerial`）：文档明确要求多通道逐张取、
   * 别并发占带宽，7 张（塔吊 2 + 出入口 5）并发打过去只会一起等。
   *
   * 该通道没有历史索引时返回 `null`（实测 2#/4# 塔吊、2#门监控等几路 `total=0`），
   * 由调用方退本机缓存 —— 旧的「最近一帧」兜底地址（`…/snapshots?pid&channelId`）
   * 已随旧接口下线，这里不再试第二枪。
   */
  async function latestShotOf(channelId: string): Promise<ShotRecord | null> {
    const page = await fetchCamShotHistory(channelId, { page: 1, pageSize: 1 })
    const top = page.items[0]
    if (!top) return null
    return await ensureShot(channelId, top)
  }

  /**
   * 一个监控点位的「最新一条历史抓拍」。
   *
   * 与工作台「历史抓拍」同一套数据源（`/api/video/snapshots/history`）：
   *
   *   ① 历史列表取第 1 页第 1 条（服务端按抓拍时刻倒序）→ 按行里的 `imageUrl`
   *      取图（缓存优先，见 `utils/shotArchive.ts::ensureShot`）—— 时刻用的是
   *      服务端给的 `capturedAt`，不拿「刚取到的这一刻」冒充拍摄时间；
   *   ② 该通道历史为空（实测 2#/4# 塔吊、2#门监控等几路服务端没有历史索引）
   *      或接口挂了（断网 / 502 / 429）→ 用本机缓存里最新那张，那也是真照片；
   *      缓存也没有 → `null`，调用方少这一张，不编照片。
   *
   * 通道号为空（配置里名字对不上）也返回 `null`：不猜一个通道去拍。
   */
  async function snapShotOf(
    channelId: string,
    name: string,
    pool: { make: (b: Blob) => string },
  ): Promise<PatrolPhotoReal | null> {
    if (!channelId) return null
    let rec: ShotRecord | null = null
    try {
      rec = await snapSerial(() => latestShotOf(channelId))
    } catch {
      // 接口不可用（断网 / 502 / 429）：落到下面本机缓存那条，不报整格错
      rec = null
    }
    // 该通道没有历史记录 / 接口挂了：用本机缓存里最新那张（也是真抓拍），
    // 缓存也没有就不出现 —— 不拿别的图顶替。
    if (!rec) rec = await latestShot(channelId)
    if (!rec) return null
    return {
      // 前缀 `cam-` 与航拍照片的 `${jobId}-${文件名}` 分开，`photoById` 不会撞
      id: `cam-${rec.key}`,
      name: `${name}-${rec.mark}.jpg`,
      // 列表用压缩预览（480 长边，约 20KB），点开大图先看同一张；
      // 「查看原图」拉的是档案里的原始字节（见 `utils/shotArchive.ts`）
      thumbnail: pool.make(rec.thumb),
      url: pool.make(rec.full),
      taskName: name,
      taskId: null,
      jobId: 0,
      time: stampOf(rec.at),
      size: rec.size,
      mediaType: 'image/jpeg',
      snap: true,
    }
  }

  /** 记一张图的原始尺寸（尺寸无效或已记录时不动） */
  function setDims(id: string, w: number, h: number): void {
    if (!(w > 0) || !(h > 0)) return
    if (dims.value[id]) return
    dims.value = { ...dims.value, [id]: { w, h } }
  }

  /** 这张照片是不是球面全景（尺寸未知时一律 false，见 utils/pano.ts） */
  function isPano(id: string): boolean {
    const d = dims.value[id]
    return d ? isEquirect(d.w, d.h) : false
  }

  /**
   * 低清预览源：缩略图优先，没有缩略图才退回原图。
   *
   * 大图弹层首屏用它（缩略图通常已在列表里缓存过，等于零等待），
   * 也用它兜「这张图没有缩略图」的情况 —— 那种情况下原图就是唯一选择。
   */
  function previewOf(p: Pick<PatrolPhotoReal, 'thumbnail' | 'url'>): string {
    return p.thumbnail || p.url
  }

  /**
   * 按 id 找一张照片。
   *
   * 照片墙 / 「全景航拍」9 张 / 「材料堆场」3 张 / 「设备设施」4 张 /
   * 「安全巡查」2 张 / 「出入口管控」5 张分六个数组存（见各 ref 的注释），
   * 而大图弹层只拿到一个 id —— 所以查找必须六处都看。
   */
  function photoById(id: string): PatrolPhotoReal | undefined {
    return (
      photos.value.find((p) => p.id === id) ??
      spot.value.find((p) => p.id === id) ??
      yard.value.find((p) => p.id === id) ??
      facility.value.find((p) => p.id === id) ??
      safety.value.find((p) => p.id === id) ??
      gate.value.find((p) => p.id === id)
    )
  }

  /**
   * 一条执行记录 → 照片。没有图片媒体（视频 / 空目录）时返回空数组。
   *
   * 视频（`mediaType: video/*`，如「环绕视频」航线）不进照片墙 —— 这张墙是
   * 「看现场拍成了什么样」的静态证据，混进视频会让「点击查看原图」变得不可预期。
   */
  function toPhotos(rec: { id: number; taskId: number | null; taskName: string; start: string }, media: DroneMedia[]): PatrolPhotoReal[] {
    const out: PatrolPhotoReal[] = []
    for (const m of media) {
      if (!m.mediaType.startsWith('image/')) continue
      out.push({
        id: `${rec.id}-${m.name}`,
        name: m.name,
        url: m.url,
        thumbnail: m.thumbnail,
        taskName: rec.taskName,
        taskId: rec.taskId,
        jobId: rec.id,
        time: m.lastModified || rec.start,
        size: m.size,
        mediaType: m.mediaType,
      })
    }
    return out
  }

  /**
   * 取最近一个「项目全景」点（**平台拼好的成果，不是原片**）。
   *
   * 与照片墙是两条独立的链：那边逐条扫媒体（慢、有限流），这边一次列表请求
   * （80KB）就够，所以 `load()` 里并行发出，谁先回来谁先上屏。
   *
   * 取不到时**保留旧的全景**（和照片一个道理：网络抖一下就把图撤掉更难受），
   * 只有服务端明确回「一条都没有」才清空。失败**不抛** —— 全景是附加内容。
   *
   * 成果直链是 OSS 预签名（2 小时过期），所以 `force` 重取是常态：
   * **每次打开全景弹层都重取一次**（用户要求「每次看都是最新那张」），
   * 页面上的「重新获取」也走它。
   *
   * 已有图时 `force` 走**静默刷新**：不翻 `loading`，旧图继续显示到新数据回来。
   * 否则每次点开都先闪一下骨架，而这正是「刷新不该改 state」那条老规矩
   * （电梯实时刷新踩过同样的坑）。
   */
  async function loadPano(force = false): Promise<void> {
    if (!force && (panoState.value === 'loading' || pano.value)) return
    const silent = force && Boolean(pano.value)
    if (!silent) panoState.value = 'loading'
    try {
      const p = await fetchLatestPano()
      pano.value = p
      panoState.value = 'ok'
    } catch {
      // 静默刷新失败就继续用旧图（签名过期时弹层会自己报「链接已过期」）
      if (!silent) panoState.value = 'error'
    }
  }

  /**
   * 取「全景航拍」那 9 张（`fetchSpotGallery` 里的规则即 V2 的口径）。
   *
   * 失败**保留上一批**：网络抖一下就把已经能看的 9 张撤掉，比显示旧图难受。
   * 服务端明确回「近期没有照片」（`null`）才清空 —— 那是真的没有。
   */
  async function loadSpot(): Promise<void> {
    spotState.value = 'loading'
    try {
      const g = await fetchSpotGallery()
      spot.value = g
        ? toPhotos({ id: g.jobId, taskId: g.taskId, taskName: g.taskName, start: g.start }, g.media)
        : []
      spotState.value = 'ok'
    } catch {
      spotState.value = 'error'
    }
  }

  /**
   * 取「材料堆场」那 3 张（`向阳村-分区定点拍照` 最近一班的第 1、第 2、第 37 张）。
   *
   * 与 `loadSpot` 同一套失败策略：失败**保留上一批**，只有服务端明确回「近期没有
   * 照片」（`null`）才清空。
   */
  async function loadYard(): Promise<void> {
    yardState.value = 'loading'
    try {
      const g = await fetchYardGallery()
      yard.value = g
        ? toPhotos({ id: g.jobId, taskId: g.taskId, taskName: g.taskName, start: g.start }, g.media)
        : []
      yardState.value = 'ok'
    } catch {
      yardState.value = 'error'
    }
  }

  /**
   * 「设备设施」里那两张**塔吊抓拍**：2# / 4# 各取最新的一条。
   *
   * 取法与失败策略全在 `snapShotOf` 里（历史最新 → 退本机缓存 → 都没有
   * 就不出现）；这里只按 `CRANE_SHOTS` 的顺序逐个取，串行由 `snapSerial` 保证。
   */
  async function craneShots(): Promise<PatrolPhotoReal[]> {
    const out: PatrolPhotoReal[] = []
    for (const c of CRANE_SHOTS) {
      const p = await snapShotOf(c.channelId, c.name, cranePool)
      if (p) out.push(p)
    }
    return out
  }

  /**
   * 取「出入口管控」那一格：**5 张**，5 个来源各最新一张（顺序即来源表顺序）。
   *
   * 两个和「设备设施」不同的地方：
   *
   *   ① 5 张各约 300KB，串行取完要好几秒 —— 所以**首次进入逐张上屏**（第一张
   *      回来就先显示，不等齐 5 张）；
   *   ② 已经有一批在显示时（刷新 / 点重试）反过来**攒齐再换**：逐张替换会让
   *      张数从 5 掉到 1 再涨回来，比多等两秒更晃眼。
   *
   * objectURL 每轮用一个新池，全部落地后才撤旧池 —— 逐张上屏期间已经显示的
   * 那几张不能因为下一张建了新 URL 就被撤成黑块。
   *
   * 一张都取不到才算 `error`（页面写「暂时取不到」+ 重试）；部分取不到保留
   * 能拿到的几张，缺哪几路由面板那行说明点出来（`gateMissing`）。
   */
  async function loadGate(): Promise<void> {
    const my = ++gateSeq
    gateState.value = 'loading'
    const pool = makeUrlPool()
    const had = gate.value.length > 0
    const fresh: PatrolPhotoReal[] = []
    for (const s of GATE_SHOTS) {
      const p = await snapShotOf(s.channelId, s.name, pool)
      if (my !== gateSeq) {
        // 被新的一轮或 reset 顶掉了：这一轮建的 URL 没人会用，当场撤掉
        pool.release()
        return
      }
      if (!p) continue
      fresh.push(p)
      if (!had) gate.value = [...fresh]
    }
    if (had) {
      // 有旧一批在显示：攒齐再整体替换。5 路全挂时这里是空数组 → 一并清空，
      // 由 `gateState = 'error'` 让面板写「暂时取不到」。
      // 不在这种情况下留旧图：这一格看的是「门口现在什么样」，拿几小时前的
      // 画面当最新比空着更糟（与材料堆场「失败保留上一批」不同 —— 那是航拍）
      gate.value = fresh
    }
    gatePool.release()
    gatePool = pool
    gateState.value = fresh.length ? 'ok' : 'error'
  }

  /**
   * 取「设备设施」那一格：**4 张**。
   *
   *   · 前两张 = `向阳村-塔吊定点` 最近一班的第 2、第 7 张（航拍，无人机）；
   *   · 后两张 = 2# / 4# 塔吊各自**最新一条历史抓拍**（视频监控，见 `craneShots`）。
   *
   * 顺序固定：航拍在前、抓拍在后（用户要求「新增照片排在现有照片之后」）。
   *
   * 抓拍取不到不影响前两张 —— 两条链的失败互不牵连，只有航拍那条彻底失败
   * 才把整格标成 `error`（保留上一批，与 `loadYard` 同一套策略）。
   *
   * **航拍两张先上屏、抓拍后补**：抓拍是两张实打实的 JPEG（各约 300KB），
   * 4G 下要 2~4 秒，让前两张陪着一起等没有道理 —— 现场看到的是「先有 2 张、
   * 再变 4 张」，而不是这一格空 4 秒。
   */
  async function loadFacility(): Promise<void> {
    const my = ++facilitySeq
    facilityState.value = 'loading'
    try {
      const g = await fetchFacilityGallery()
      if (my !== facilitySeq) return
      const drone = g
        ? toPhotos({ id: g.jobId, taskId: g.taskId, taskName: g.taskName, start: g.start }, g.media)
        : []
      // 先把航拍两张顶上去（上一轮那两张抓拍的 objectURL 这时可以撤了：
      // 它们已经不在 `facility` 里，不会再被渲染）
      facility.value = drone
      cranePool.release()

      const shots = await craneShots()
      if (my !== facilitySeq) return
      facility.value = [...facility.value, ...shots]
      facilityState.value = 'ok'
    } catch {
      if (my === facilitySeq) facilityState.value = 'error'
    }
  }

  /**
   * 取「安全巡查」那 2 张（两条航线各一张，见 `SAFETY_SOURCES`）。
   *
   * 返回的是**多条**班次，所以逐组 `toPhotos` 再拼起来；顺序保持来源表顺序。
   * 失败策略同 `loadYard`：失败**保留上一批**，只有服务端明确回「近期没有照片」
   * （空数组）才清空。
   */
  async function loadSafety(): Promise<void> {
    safetyState.value = 'loading'
    try {
      const groups = await fetchSafetyGallery()
      safety.value = groups.flatMap((g) =>
        toPhotos({ id: g.jobId, taskId: g.taskId, taskName: g.taskName, start: g.start }, g.media),
      )
      safetyState.value = 'ok'
    } catch {
      safetyState.value = 'error'
    }
  }

  /**
   * 取一次某次飞行的媒体，带限流重试。
   *
   * 失败返回 null（调用方跳过这条记录），**不抛** —— 一条记录取不到不该让整页失败。
   * 但被限流（42901）时要等 2 秒重试一次，否则会白丢照片。
   */
  async function mediaOf(jobId: number): Promise<DroneMedia[] | null> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchMediaJobs(jobId)
      } catch (e) {
        const code = e instanceof ApiError ? e.code : 0
        if (THROTTLE_CODES.has(code) && attempt === 0) {
          await sleep(THROTTLE_WAIT)
          continue
        }
        return null
      }
    }
  }

  /**
   * 在一个窗口内按时间倒序探媒体（**串行**，见 `PROBE_GAP` 上的说明）。
   *
   * 三条规则：
   *   · 同一任务只取**最近一次有照片的飞行** —— 一条航线一天可能飞 20 次，
   *     逐次取会把请求数打爆，而 24 张代表照片已经够看；
   *   · 每个任务最多 `MAX_PER_TASK` 张（一次正射可能 100+ 张）；
   *   · 收满 `MAX_JOBS` 个任务、或探满 `MAX_PROBE` 条记录就停。
   *
   * **边探边上屏**：每拿到一个任务的照片就写进 `photos`，页面立刻多一个分类。
   * 全部探完要十几秒（限流所致），等齐了再显示会让用户对着骨架干等。
   */
  async function probe(rows: { id: number; taskId: number | null; taskName: string; start: string }[]): Promise<PatrolPhotoReal[]> {
    /** 已收过照片的任务（key 见 `patrolCatKey`） */
    const done = new Set<string>()

    for (const rec of rows.slice(0, MAX_PROBE)) {
      if (done.size >= MAX_JOBS) break
      // 全景航线的原片是拼接原料，成果由平台拼好、由 `loadPano()` 单独取。
      // 在**发请求之前**就跳过：这 26 张既不上墙，也没必要拉媒体列表。
      if (isPanoTask(rec.taskName)) continue
      // 「全局定点拍照」同理：它由「全景航拍」模块（`fetchSpotGallery`）单独取，
      // 再进照片墙会在「安全巡查」里重复一遍，还多打一次媒体请求。
      if (rec.taskName.trim() === SPOT_TASK_NAME) continue
      // 「塔吊定点」也一样：由「设备设施」（`fetchFacilityGallery`）单独取第 2、7 张，
      // 整班照片既不上墙，媒体列表也就没必要再拉一次
      if (rec.taskName.trim() === FACILITY_TASK_NAME) continue
      // 「分区定点拍照」由「材料堆场」与「安全巡查」两条链各自取指定张（第 1/2/37
      // 与第 34）；「土方1」由「安全巡查」取第 1 张 —— 整班都不上墙
      if (rec.taskName.trim() === YARD_TASK_NAME) continue
      if (rec.taskName.trim() === SAFETY_SOIL_TASK_NAME) continue

      const key = patrolCatKey(rec)
      if (done.has(key)) continue

      const media = await mediaOf(rec.id)
      if (media) {
        const got = toPhotos(rec, media).slice(0, MAX_PER_TASK)
        if (got.length) {
          done.add(key)
          photos.value = [...photos.value, ...got]
          flightCount.value = done.size
          // 第一批照片一到就把骨架换掉（剩下的继续在后台补）
          if (state.value === 'loading') {
            state.value = 'ok'
            error.value = ''
          }
        }
      }
      // 每次请求之间留间隔，避免撞 42901
      await sleep(PROBE_GAP)
    }

    // 「同步到几个任务」比「扫过多少条记录」对现场有意义
    flightCount.value = done.size
    return photos.value
  }

  /**
   * 拉真实航拍照片。
   *
   * 失败不清空已有照片：网络抖一下就把现场照片墙清空，比显示旧照片难受得多。
   */
  async function load(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && state.value === 'ok') return
    if (!force && state.value === 'error' && Date.now() - lastFailAt < 60_000) return

    state.value = 'loading'
    inflight = (async () => {
      // 这一次刷新里五条链查的是同一个 30 天窗口 —— 开个批次让它们共享同一份
      // 执行记录，否则一次刷新要打 25+ 个 task-record 请求（见 api/drone.ts）。
      beginRecordBatch()
      try {
        const now = nowKey()
        let lastErr: unknown = null
        // 增量写入（`probe` 拿到一个任务就 push 一批），所以先清空
        photos.value = []
        pano.value = null
        panoState.value = 'idle'
        flightCount.value = 0
        // 尺寸缓存跟着换：新一批照片的 id 可能完全不同，旧记录白占内存
        dims.value = {}

        // 全景 / 全景航拍 / 材料堆场 / 设备设施 / 安全巡查 / 出入口管控各走另一条链
        // （一次列表 + 一次媒体 / 5 张快照），与照片探测并行；各自吞错，不拖累照片墙
        const panoTask = loadPano(true)
        const spotTask = loadSpot()
        const yardTask = loadYard()
        const facilityTask = loadFacility()
        const safetyTask = loadSafety()
        const gateTask = loadGate()

        for (const days of WINDOWS) {
          let rows
          try {
            const page = await fetchTaskRecords({ page: 1, size: 100, start: dayKey(-days), end: dayKey(1) })
            rows = page.rows
          } catch (e) {
            lastErr = e
            break
          }
          // 未来排班没有媒体，先剔掉；再按开始时间倒序（接口是升序）
          const started = rows.filter((r) => !r.start || r.start <= now)
          const desc = started.slice().sort((a, b) => b.start.localeCompare(a.start))
          await probe(desc)
          // 有照片就不用再回溯 180 天
          if (photos.value.length) break
        }

        await Promise.all([panoTask, spotTask, yardTask, facilityTask, safetyTask, gateTask])
        // 上面几条专用链也算「有内容」：只飞了这些航线时不该当整页失败
        if (
          !photos.value.length &&
          !pano.value &&
          !spot.value.length &&
          !yard.value.length &&
          !facility.value.length &&
          !safety.value.length &&
          !gate.value.length &&
          lastErr
        ) {
          throw lastErr
        }

        state.value = 'ok'
        error.value = ''
        lastFailAt = 0
        lastOkAt = Date.now()
      } catch (e) {
        state.value = 'error'
        error.value = e instanceof Error ? e.message : '巡检照片加载失败'
        // 已有照片保留（见上，探测阶段可能已经上屏一批）
        lastFailAt = Date.now()
      } finally {
        endRecordBatch()
        inflight = null
      }
    })()
    return inflight
  }

  /**
   * 切回智眸面板时的刷新（首页标签切换会调用）。
   *
   * 两道闸：
   *   · 失败冷却（60 秒）—— 连点标签时不该把注定失败的请求反复打出去
   *     （keehang 那串要两步 CAS 登录，失败一次代价不小）；
   *   · 成功节流（`REFRESH_GAP`）—— 每次刷新要串行扫十几条媒体请求，
   *     来回复用标签会直接撞上服务端限流。一分钟内的重进直接用上一批照片。
   *
   * 页面上的「重试」按钮走 `load(true)`，绕过这两道闸。
   */
  async function refresh(): Promise<void> {
    if (state.value === 'error' && Date.now() - lastFailAt < 60_000) return
    if (state.value === 'ok' && Date.now() - lastOkAt < REFRESH_GAP) return
    return load(true)
  }

  /**
   * 测试接线点：直接灌数据（等价于「刚刚同步完」，不会触发再次拉取）。
   *
   * `target` 指定灌进哪一格：默认照片墙（`photos`），`'gate'` 是「出入口管控」
   * 那 5 张。2026-11-20 起六格各有专用链、照片墙不再上屏，所以「卡片 / 弹层
   * 通用渲染」的用例改灌 `'gate'`（那一格就是 `PatrolPhotoReal[]` 直接铺）。
   */
  function apply(listIn: PatrolPhotoReal[], target: 'photos' | 'gate' = 'photos'): void {
    if (target === 'gate') {
      gate.value = listIn
      gateState.value = 'ok'
    } else {
      photos.value = listIn
      flightCount.value = listIn.length
    }
    state.value = 'ok'
    error.value = ''
    lastOkAt = Date.now()
  }

  function reset(): void {
    // 登出时正在飞的那次 `loadFacility` / `loadGate` 不许再落地
    // （否则会把照片写回已清空的 store）
    facilitySeq += 1
    gateSeq += 1
    photos.value = []
    pano.value = null
    panoState.value = 'idle'
    spot.value = []
    spotState.value = 'idle'
    yard.value = []
    yardState.value = 'idle'
    // 抓拍的 objectURL 也要撤（登出 / 换账号后旧图不该留在内存里）
    cranePool.release()
    facility.value = []
    facilityState.value = 'idle'
    gatePool.release()
    gate.value = []
    gateState.value = 'idle'
    safety.value = []
    safetyState.value = 'idle'
    flightCount.value = 0
    dims.value = {}
    state.value = 'idle'
    error.value = ''
    lastFailAt = 0
    lastOkAt = 0
  }

  return {
    photos,
    pano,
    panoState,
    spot,
    spotState,
    yard,
    yardState,
    facility,
    facilityState,
    safety,
    safetyState,
    gate,
    gateState,
    flightCount,
    dims,
    state,
    error,
    list,
    sizeText,
    setDims,
    isPano,
    previewOf,
    photoById,
    loadPano,
    loadSpot,
    loadYard,
    loadFacility,
    loadSafety,
    loadGate,
    apply,
    load,
    refresh,
    reset,
  }
})
