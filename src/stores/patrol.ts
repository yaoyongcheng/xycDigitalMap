import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchLatestPano, fetchMediaJobs, fetchTaskRecords, type DroneMedia, type DronePano } from '@/api/drone'
import { ApiError } from '@/api/http'
import { isEquirect } from '@/utils/pano'

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
/** 被限流后的等待（服务端提示 2 秒） */
const THROTTLE_WAIT = 2_200
/** keehang 的限流业务码 */
const THROTTLE_CODE = 42901

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
   * 页面上的「重新获取」走它。
   */
  async function loadPano(force = false): Promise<void> {
    if (!force && (panoState.value === 'loading' || pano.value)) return
    panoState.value = 'loading'
    try {
      const p = await fetchLatestPano()
      pano.value = p
      panoState.value = 'ok'
    } catch {
      panoState.value = 'error'
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
        if (code === THROTTLE_CODE && attempt === 0) {
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

        // 全景走另一条链（一次列表请求），与照片探测并行；自己吞错不拖累这里
        const panoTask = loadPano(true)

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

        await panoTask
        // 全景也算「有内容」：某个项目只飞了全景航线时不该当成整页失败
        if (!photos.value.length && !pano.value && lastErr) throw lastErr

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

  /** 测试接线点：直接灌数据（等价于「刚刚同步完」，不会触发再次拉取） */
  function apply(listIn: PatrolPhotoReal[]): void {
    photos.value = listIn
    flightCount.value = listIn.length
    state.value = 'ok'
    error.value = ''
    lastOkAt = Date.now()
  }

  function reset(): void {
    photos.value = []
    pano.value = null
    panoState.value = 'idle'
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
    flightCount,
    dims,
    state,
    error,
    list,
    sizeText,
    setDims,
    isPano,
    previewOf,
    loadPano,
    apply,
    load,
    refresh,
    reset,
  }
})
