import { computed, nextTick, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  fetchLatestGalleryOf,
  fetchRecentRecords,
  fetchRecordPano,
  fetchStationDay,
  STATION_WINDOW_DAYS,
  toStations,
  type DronePano,
  type DroneStation,
  type DroneTaskRecord,
} from '@/api/drone'
import { hazardKindList } from '@/data/config'
// 与 cam 互相调用 closeXxx（原版 openAir 关 cam，openCam 关 air）。
// 循环 import 安全：两端都只在函数体内惰性调用 useXxxStore()。
import { useCamStore } from './cam'
import { useShellStore } from './shell'
import type { PatrolPhotoReal } from './patrol'
import { addDays, dateKey, formatCamDate, monthStart, startOfDay } from '@/utils/date'

/** 无人机巡检照片（由站点取数派生，全景排第一） */
export interface AirShot {
  /** 时刻 HH:mm（照片是拍摄时刻，全景是成果完成时刻） */
  time: string
  /** 列表与弹层首屏用的图（照片用缩略图，全景用 2:1 预览） */
  img: string
  pos: string
  /** 所属任务名（真实媒体带） */
  taskName?: string
  /** 原图直链（OSS 原签名链；列表用缩略图，点「原图」才换它） */
  full?: string
  /** 是不是球面全景（弹层换 `PanoViewer` 环视） */
  pano?: boolean
  /** 照片 id（照片墙 `photos` 里的 id，取原图时用） */
  photoId?: string
}

/**
 * 航拍列表一屏铺多少张（首屏与每次下滑追加都是这个数）。
 *
 * 为什么是 8：`.air-grid` 是两列，8 张 = 4 行，正好铺满一屏多一点；
 * 再大就失去「首屏少铺」的意义，再小则滑两下就到头。
 */
export const AIR_PAGE_SIZE = 8

/** 隐患上报的提交载荷（接口接入后即为 POST body） */
export interface HazardPayload {
  kind: string
  photos: number
  desc: string
  at: string
}

/** 选图结果：用于把「被拒了、拒了几张、为什么」如实告诉用户 */
export interface AddFilesResult {
  added: number
  /** 因不是图片被拒 */
  rejectedType: number
  /** 因超过 6 张上限被拒 */
  rejectedLimit: number
}

/**
 * 无人机巡检（航拍照片）+ 隐患上报
 *
 * 两者在原版均为单域状态，合并为一个 store 以减少文件数（依据迁移方案）。
 *
 * ## 航拍照片的三次变化
 *
 *   · 原版：`airShots(day)` 按日期偏移派生 8~10 张，图片取自 `airImgs`
 *     两张静态图、时刻取自写死的 `airTimes` —— 整套都是编的；
 *   · 2026-11 阶段 8：改吃 keehang 的真实媒体，但按**拍摄日期**过滤
 *     （「今天没飞」就是一片空白，现场截图里那行 `0 张` 就是这么来的）；
 *   · 2026-11-19：对齐 V2「任务记录」的口径，改成**站点 + 一次采集**
 *     —— 站点下拉取自任务记录的航线名（去重），选中即看这一班的全部照片
 *     加该班最新一张全景（全景排第一，点开球面环视）；
 *   · 2026-11-19 续：**日期控件恢复**（今天 / 昨天 / 选日期 + 月历，仍是
 *     原来那套 `DayPickChips` + `MonthCalendar`）。默认仍给该站点最近一次采集，
 *     日期芯片显示的就是这次采集的日期；用户选历史日期则按「站点 + 日期」查
 *     那一天（同一天飞了两班取后一班），窗口 {@link STATION_WINDOW_DAYS} 天。
 *   · 2026-11-19 续二：**渲染分片**（首屏 {@link AIR_PAGE_SIZE} 张，下滑追加）。
 *     媒体接口一次回整班清单、没有 page/size，所以分页只能落在渲染层 ——
 *     见 {@link airShown} 那段注释。
 */
export const useAirHazardStore = defineStore('airHazard', () => {
  /* ---------------- 航拍照片（2026-11-19：按「站点 + 最新一次采集」取数） ---------------- */

  /**
   * 站点清单（V2 任务记录里的站点名去重，按最近一次执行倒序）。
   *
   * 一个站点 = 一条航拍航线。选中它默认看**最近一次采集**；日期控件
   * （`airDate`）可以往回选，选了就查「该站点 + 该日期」那一天。
   */
  const stations = ref<DroneStation[]>([])
  /** 当前选中的站点名（空 = 还没选中，第一次加载会自动选最新的那个） */
  const station = ref('')
  /** 站点数据源的原始记录（窗口内全部，切站点时不再重复请求） */
  const recordings = ref<DroneTaskRecord[]>([])
  /** 选中站点最新一次采集的全部照片（按拍摄顺序） */
  const airPhotos = ref<PatrolPhotoReal[]>([])
  /** 选中站点最新一张全景（没有则为 null，只显示采集照片） */
  const airPano = ref<DronePano | null>(null)
  /** idle / loading / ok / empty / error */
  const airState = ref<'idle' | 'loading' | 'ok' | 'empty' | 'error'>('idle')
  /** 空态 / 失败态的说明（失败时是接口原话） */
  const airNote = ref('')
  /**
   * 这次空态是不是「本班还在回传」。
   *
   * 与「真的没有照片」分开：前者的标题要写「正在回传」，让现场知道等一会儿
   * 再刷新就有；后者才是「这一天这个站点没飞 / 没拍」。
   */
  const airPending = ref(false)
  /** 最近一次采集的开始时间（'YYYY-MM-DDTHH:mm:ss'，页头写「最近采集 …」） */
  const airAt = ref('')

  /* ---------------- 日期（原有控件，2026-11-19 恢复） ---------------- */

  /** 当前展示的是哪一天的采集（打开时由最近一次采集的日期决定） */
  const airDate = ref<Date>(startOfDay(new Date()))
  /** 月历是否展开 */
  const airCalOpen = ref(false)
  /** 月历当前显示的月份 */
  const airCalMonth = ref<Date>(monthStart(new Date()))

  /** 可选上界：今天（未来没有采集） */
  const airMaxDate = computed(() => startOfDay(new Date()))
  /**
   * 可选下界：今天往前 {@link STATION_WINDOW_DAYS} 天。
   *
   * 与站点清单的取数窗口同一个常量 —— 日期比窗口更宽的话，点进去只会是
   * 「站点没在列表里、日期也查不到」的死区间。
   */
  const airMinDate = computed(() => addDays(airMaxDate.value, 1 - STATION_WINDOW_DAYS))
  /** 芯片与空态用的日期文案：今天 / 昨天 / MM/DD */
  const airDateLabel = computed(() => formatCamDate(airDate.value))

  /**
   * 日期是**独立筛选条件**，默认今天，任何自动行为都不改它（2026-11-19 定稿）。
   *
   * 曾经两次在这上面栽跟头：
   *   · 切站点时走「该站点最近一次采集」，日期被数据顶掉；
   *   · 首次打开先按最近一次取，芯片从「今天」跳成「昨天」。
   *
   * 现在所有 UI 入口（首次加载 / 切站点 / 刷新清单 / 重新获取）都显式带上
   * `airDate`：站点换了只换站点，日期换了只换日期，两者互不推导。
   * 唯一会「由数据决定日期」的只剩 `loadStation()` 不带 day 的兜底路径
   * （内部不再调用它，保留给工具调用与单测）。
   */

  /** 切站点 / 刷新时的序号，晚到的响应一律作废 */
  let airSeq = 0

  /**
   * 分页窗口的代数：换站点 / 换日期时 +1，让在途的 `loadMoreAir()` 作废。
   *
   * 与 `airSeq` 分开是因为生命周期不同：`airSeq` 管请求，这个管「铺到第几条」。
   * 两者若共用一个号，一次换日期会把还没回来的图像请求也判成过期。
   */
  let airPageSeq = 0

  /** 'YYYY-MM-DDTHH:mm:ss' → 'MM-DD HH:mm'（页头用） */
  function briefTime(s: string): string {
    if (!s) return ''
    return `${s.slice(5, 10).replace('-', '/')} ${s.slice(11, 16)}`
  }

  /** 时刻（`2026-11-19 08:26:13` 或 ISO）→ HH:mm */
  function hhmm(s: string): string {
    const t = s.includes('T') ? s.slice(11, 16) : s.slice(11, 16)
    return t || ''
  }

  /** 把 ISO 时间往前挪几天，输出 `YYYY-MM-DD HH:mm:ss`（与成果的 createTime 同格式） */
  function shiftDays(iso: string, days: number): string {
    const d = new Date(iso.replace(' ', 'T'))
    if (Number.isNaN(d.getTime())) return ''
    d.setDate(d.getDate() + days)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  /**
   * 页面列表：**全景排第一**，其余照片按拍摄顺序跟在后面。
   *
   * 用户明确要求「有全景图的站点必须取最新全景图，且排在该站点照片列表首位」，
   * 所以这里直接拼成一条列表，页面只负责铺格子。
   *
   * 这是**这一班的全量**（全景 + 全部照片），网格实际渲染的是它的前缀
   * {@link airListShown} —— 分页只分渲染，不动数据。
   */
  const airList = computed<AirShot[]>(() => {
    const out: AirShot[] = []
    const p = airPano.value
    if (p) {
      out.push({
        time: p.time ? briefTime(p.time.replace(' ', 'T')) : '',
        img: p.preview,
        pos: 'fit',
        taskName: station.value,
        pano: true,
      })
    }
    for (const s of airPhotos.value) {
      out.push({
        time: hhmm(s.time),
        img: s.thumbnail || s.url,
        full: s.url,
        pos: 'fit',
        taskName: s.taskName,
        photoId: s.id,
      })
    }
    return out
  })

  /**
   * 已铺进网格的条数（首屏 {@link AIR_PAGE_SIZE}，下滑到底每次再 +8）。
   *
   * 为什么要这一层：`/media/task/job/{recordId}` 一次就返回这一班**全部**媒体
   * —— 裸数组、没有 total、也没有 page/size 参数（2026-11-19 实测），服务端
   * 没有分页可接。正射那种一班上百张时，网格会同时挂上百个 `<img>`，光是
   * 解码排队就够首屏顿一下。所以「分页」放在渲染层：数据一次取回留内存，
   * 但只把前 N 条铺成 DOM，滑到接近底部再追加 N 条。
   *
   * 对用户的效果和「按页请求」一样（首屏 8 张、越滑越多），差别只在
   * JSON 那一次请求没被拆开 —— 这一点绕不过去，见 docs 六点二十一。
   */
  const airShown = ref(AIR_PAGE_SIZE)

  /** 追加一页的进行中标记（挡 IntersectionObserver 同一帧连发导致的重复追加） */
  const airMoreBusy = ref(false)

  /** 网格真正渲染的那一段：永远是 `airList` 的前缀，所以下标与 `airList` 一致 */
  const airListShown = computed<AirShot[]>(() => airList.value.slice(0, airShown.value))

  /** 下面还有没铺出来的（底部按钮 / 哨兵元素据此显隐） */
  const airHasMore = computed(() => airShown.value < airList.value.length)

  /** 还剩多少张（按钮文案用） */
  const airRemain = computed(() => Math.max(0, airList.value.length - airShown.value))

  /**
   * 再铺一页。
   *
   * 数据已在内存里，没有请求可发，所以这里是纯渲染层的追加 —— 但仍然是
   * async：① 底部「正在加载更多」真的会出现一次，不会同步提交直接闪成
   * 「已经到底」；② 同一帧里多次触发（哨兵还在视野内、连点）只加一页。
   *
   * 将来 `/media/task/job` 若支持 page/size，只改这个函数体即可，
   * 组件与 busy / hasMore / remain 一套状态都不用动。
   */
  async function loadMoreAir(): Promise<void> {
    if (airMoreBusy.value || !airHasMore.value) return
    const seq = airPageSeq
    airMoreBusy.value = true
    try {
      await nextTick()
      // 等待这一帧的工夫里换了站点 / 日期：这一页作废，别加在新列表上
      if (seq !== airPageSeq) return
      airShown.value = Math.min(airList.value.length, airShown.value + AIR_PAGE_SIZE)
    } finally {
      if (seq === airPageSeq) airMoreBusy.value = false
    }
  }

  /**
   * 页头那句：这次采集的时刻 + 多少张（含全景）。
   *
   * 具体是哪一天由日期芯片显示（同一行上方），这里不再重复日期；
   * 空态 / 失败态**不重复原因** —— 页面下方那块状态卡已经写了。
   *
   * 张数是**这一班的总数**，不是「已经铺出来的张数」：用户关心这批一共几张，
   * 铺到第几页由网格底部那行说。
   */
  const airHint = computed(() => {
    if (airState.value === 'loading') return '正在读取航拍照片…'
    if (airState.value !== 'ok') return ''
    const at = airAt.value ? briefTime(airAt.value) : ''
    const pano = airPano.value ? ' · 含全景' : ''
    return `采集 ${at} · ${airPhotos.value.length} 张${pano}`
  })

  /**
   * 载入站点清单（并自动选中一个）。
   *
   * 两道闸：
   *   · 正在加载时直接返回（来回点「航拍照片」不该叠请求）；
   *   · 5 分钟内复用上一份清单 —— 站点一天只变几次，但也不能一次会话都不刷新：
   *     现场上午飞完下午再进来，下拉里必须有新架次（否则「最新一次采集」永远停在上午）。
   */
  const STATIONS_TTL = 5 * 60 * 1000
  let stationsAt = 0

  async function loadStations(force = false): Promise<void> {
    if (airState.value === 'loading') return
    if (!force && station.value && Date.now() - stationsAt < STATIONS_TTL) return
    airState.value = 'loading'
    airNote.value = ''
    try {
      const rows = await fetchRecentRecords()
      recordings.value = rows
      stations.value = toStations(rows)
      stationsAt = Date.now()
      if (!stations.value.length) {
        airState.value = 'empty'
        airNote.value = `近 ${STATION_WINDOW_DAYS} 天没有航拍任务记录`
        return
      }
      // 保持当前选择（刷新时别跳回第一个），失效了才回到最新的那个
      const keep = stations.value.some((s) => s.name === station.value)
        ? station.value
        : stations.value[0].name
      // 站点只决定「查谁」，日期始终用当前选中的（首次进入 = 今天）。
      // 关键：不要再「先取最近一次、再把日期回填成那天」—— 那是日期跳昨天的来源。
      await loadStation(keep, airDate.value)
    } catch (e) {
      airState.value = 'error'
      airNote.value = (e as Error)?.message || '航拍任务记录加载失败'
    }
  }

  /**
   * 某站点在窗口内**最近一次已开始**的采集，返回 `MM/DD` 或空串。
   *
   * 只读已加载的 `recordings`（90 天任务记录，零请求）—— 用于「这个站点在那天
   * 没有记录」的空态里补一句「最近一次是哪天」，让用户知道往哪翻，而不是
   * 自己去月历上逐天试。
   */
  function lastStartOf(name: string): string {
    let best = ''
    for (const r of recordings.value) {
      if (r.taskName.trim() !== name) continue
      if (!r.start) continue
      if (r.start > best) best = r.start
    }
    if (!best) return ''
    const d = new Date(best.replace(' ', 'T'))
    return Number.isNaN(d.getTime()) ? '' : formatCamDate(d)
  }

  /**
   * 取某个站点的一次采集：照片上屏，再尽力补该班的全景。
   *
   * `day` 传了就查**那一天**（`fetchStationDay`，同一天飞了两班取后一班）；
   * 不传则查该站点**最近一次采集**，并用回传的 `start` 回填日期 —— **页面所有
   * 入口现在都会显式带日期**（首次加载 / 切站点 / 刷新 / 重试），这条不带 day
   * 的路径只留给工具调用与单测，免得「取最近一次」顺手把用户选的日期改掉。
   *
   * 顺序与失败策略：
   *   ① 照片是主体 —— 先取回来上屏（最新一次只需一次媒体请求）；
   *   ② 全景是加分项 —— 后取，失败只是「没有全景」，绝不让整页变错误态；
   *   ③ 晚到的响应按 `airSeq` 丢弃（快速连点站点 / 连翻日期不会串台）。
   */
  async function loadStation(name: string, day?: Date): Promise<void> {
    if (!name) return
    const my = ++airSeq
    const chosen = day ? startOfDay(day) : null
    const wantDay = chosen ? dateKey(chosen) : ''
    station.value = name
    airState.value = 'loading'
    airNote.value = ''
    airPending.value = false
    airPhotos.value = []
    airPano.value = null
    airAt.value = ''
    airCalOpen.value = false
    airPopOpen.value = false
    airPopIdx.value = 0
    // 换站点 / 换日期一律回到首屏：上一次翻到第 3 页的位置不能带过来，
    // 否则新站点一进来就是十几张图一起下
    airPageSeq += 1
    airShown.value = AIR_PAGE_SIZE
    airMoreBusy.value = false

    try {
      const g = wantDay
        ? await fetchStationDay(name, wantDay)
        : await fetchLatestGalleryOf(name)
      if (my !== airSeq) return
      if (!g) {
        airState.value = 'empty'
        const near = chosen ? lastStartOf(name) : ''
        airNote.value = chosen
          ? `${name} ${formatCamDate(chosen)}没有采集记录${
              near ? `（最近一次 ${near}）` : ''
            }，换个日期或站点看看`
          : '这个站点近期没有采集到照片'
        // 空态不动日期：选了哪天就停在哪天（未指定日期时保持原值，等下一次取值）
        if (chosen) airDate.value = chosen
        return
      }
      // 采到的是哪一天，芯片就显示哪一天 —— 日期与列表必须始终对得上。
      // 但「按某一天查」时日期以调用方为准：用户点了 11/10 就是 11/10，
      // 不拿接口回传的 start 反推（跨零点 / 接口抖动都会把选择悄悄改掉）。
      airAt.value = g.start
      const at = new Date(g.start.replace(' ', 'T'))
      if (chosen) {
        airDate.value = chosen
        airCalMonth.value = monthStart(chosen)
      } else if (!Number.isNaN(at.getTime())) {
        airDate.value = startOfDay(at)
        airCalMonth.value = monthStart(airDate.value)
      }
      // 最新一班还在回传：不给「上一班的旧照片」，也不说「没有照片」，
      // 直接写清进度 —— 现场要的是「等到什么时候」，不是一张更早的图。
      if (!g.media.length && g.pending) {
        airState.value = 'empty'
        airPending.value = true
        const hhmm = g.start.slice(11, 16)
        airNote.value =
          `${name} 本班 ${hhmm} 采集的 ${g.pending.total} 个文件正在回传` +
          `（已传 ${g.pending.uploaded} 个），稍后刷新即可看到最新照片`
        return
      }
      airPhotos.value = g.media.map((m) => ({
        id: `${g.jobId}-${m.name}`,
        name: m.name,
        url: m.url,
        thumbnail: m.thumbnail,
        taskName: g.taskName,
        taskId: g.taskId,
        jobId: g.jobId,
        time: m.lastModified || g.start,
        size: m.size,
        mediaType: m.mediaType,
      }))
      airState.value = 'ok'

      // 只认这一班的全景（传单条 recordId，不会串到该站点的别的架次）；
      // 往前留 3 天余量，覆盖「今天刚飞、全景还在拼」
      const pano = await fetchRecordPano([g.jobId], shiftDays(g.start, -3))
      if (my !== airSeq) return
      airPano.value = pano
    } catch (e) {
      if (my !== airSeq) return
      airState.value = 'error'
      airNote.value = (e as Error)?.message || '航拍照片加载失败'
    }
  }

  /**
   * 下拉框换站点。
   *
   * **日期只由用户决定，不随数据漂移。** 切站点一定是「新站点 + 当前日期」：
   * 之前按「用户有没有显式选过」分流，第一次打开切站点会走「该站点最近一次」，
   * 芯片就从今天跳成昨天 —— 用户看到的是「我什么都没动，日期自己变了」，
   * 这与「不覆盖用户选择」是同一条原则。
   *
   * 新站点当天没飞 → 空态写明「该站点最近一次是哪天」，由用户决定换日期还是换站点。
   */
  function pickStation(name: string): void {
    if (!name || name === station.value) return
    void loadStation(name, airDate.value)
  }

  /* ---------------- 日期控件（原有今天 / 昨天 / 选日期 + 月历） ---------------- */

  /** 展开 / 收起月历（展开时把月份对齐到当前展示的日期） */
  function toggleAirCal(): void {
    airCalOpen.value = !airCalOpen.value
    if (airCalOpen.value) airCalMonth.value = monthStart(airDate.value)
  }

  function setAirCalMonth(d: Date): void {
    // 月份也夹在区间内：组件已禁掉越界的上一月/下一月，这里再兜一层
    const m = monthStart(d)
    const lo = monthStart(airMinDate.value).getTime()
    const hi = monthStart(airMaxDate.value).getTime()
    const t = m.getTime()
    airCalMonth.value = t < lo ? new Date(lo) : t > hi ? new Date(hi) : m
  }

  /**
   * 切日期（今天 / 昨天 / 月历选中的某天）。
   *
   * **日期范围的唯一裁决点**：芯片、月历、以后补的任何入口都走这里。
   * 只接受「今天往前 {@link STATION_WINDOW_DAYS} 天」内的日期，越界拦下并说明
   * 原因；拦下时保持原日期与列表，不闪空态、也不发多余请求。
   */
  function setAirDate(d: Date): boolean {
    const day = startOfDay(d)
    const t = day.getTime()
    if (t > airMaxDate.value.getTime()) {
      useShellStore().showToast('不能查看未来日期的航拍照片', 'warn')
      return false
    }
    if (t < airMinDate.value.getTime()) {
      useShellStore().showToast(
        `只能查看近 ${STATION_WINDOW_DAYS} 天的航拍照片（${formatCamDate(airMinDate.value)} 起）`,
        'info',
      )
      return false
    }
    // 校验通过：日期就此定为用户选的那天，后续切站点 / 刷新都带着它
    if (!station.value) {
      // 站点清单还没回来：只记下日期，等清单到了按**这一天**取
      airDate.value = day
      airCalOpen.value = false
      airCalMonth.value = monthStart(day)
      return true
    }
    airDate.value = day
    airCalOpen.value = false
    airCalMonth.value = monthStart(day)
    airPopOpen.value = false
    void loadStation(station.value, day)
    return true
  }

  /**
   * 「重新获取」：重取**当前站点当前日期**那一班。
   *
   * 不能用 `loadStations(true)` —— 那会重置回最近一次采集，用户明明在翻
   * 11/10 的照片，一点重试就被弹回今天，等于白翻。
   */
  async function refreshAir(): Promise<void> {
    if (!station.value) {
      await loadStations(true)
      return
    }
    // 重试 = 重试「当前这一屏」：站点和日期都照旧，只有数据重取
    await loadStation(station.value, airDate.value)
  }

  /** 原为 #airPlayer 的 .open / hidden */
  const isOpen = ref(false)

  /** 原为 #airPop 的 .open / hidden */
  const airPopOpen = ref(false)

  /** 原通过 data-air 索引定位当前大图 */
  const airPopIdx = ref(0)

  /** 原 js/app.js:1402 —— 隐患类型当前选中 */
  const hazardKind = ref<string>(hazardKindList[0])

  /** 原 js/app.js:1403 —— 已选照片，元素为 URL.createObjectURL 结果 */
  const hazardImgs = ref<string[]>([])

  /**
   * 原为 #hazardDesc 的 value。
   *
   * 原版存在缺陷：resetHazard() 会清空它（app.js:1429），但提交时
   * 完全不读取，即「描述文本实际不会提交」。
   * 2026-10 交互优化已修正：描述随 commitHazard() 进入提交载荷
   * （见 lastSubmit），成功反馈也会回显描述字数 —— 用户填了却毫无
   * 感知属欺骗性交互，不值得为 1:1 保留。
   */
  const hazardDesc = ref('')

  /** 原为 #hazardPage 的 .open / hidden */
  const hazardOpen = ref(false)

  /** 提交中（防连点 + 按钮 loading 文案） */
  const hazardSubmitting = ref(false)

  /**
   * 最近一次成功提交的载荷（2026-10 新增，替代「填了不读」的原版行为）。
   * 目前没有后端，落到这个 ref 上，接入接口后即为 POST 的 body。
   */
  const lastSubmit = ref<HazardPayload | null>(null)

  /** 原 js/app.js:1425-1433 resetHazard() —— 同时释放已创建的 ObjectURL */
  function resetHazard(): void {
    hazardImgs.value.forEach((src) => URL.revokeObjectURL(src))
    hazardImgs.value = []
    hazardKind.value = hazardKindList[0]
    hazardDesc.value = ''
  }

  /** 原 js/app.js:1374-1384 openAir() */
  function openAir(): void {
    const cam = useCamStore()
    cam.closeCam()
    closeHazard()
    airPopOpen.value = false
    airCalOpen.value = false
    isOpen.value = true
    // 首次进入才拉站点清单；之后复用（一天只变几次，来回进出不必每次都打接口）
    void loadStations()
  }

  /**
   * 原 js/app.js:1386-1394 closeAir()
   * 原版对 #airPop 的处理与 #camShotPop 不一致（L1557 只 remove("open")
   * 而不设 hidden）。因 CSS 有 `.cam-shot-pop:not(.open){display:none!important}`，
   * 两者视觉结果相同，这里统一由同一个状态驱动，不复制该不一致。
   */
  function closeAir(): void {
    isOpen.value = false
    airPopOpen.value = false
    airCalOpen.value = false
  }

  /** 原 js/app.js:1435-1442 openHazard() */
  function openHazard(): void {
    const cam = useCamStore()
    cam.closeCam()
    closeAir()
    resetHazard()
    hazardOpen.value = true
  }

  /** 原 js/app.js:1444-1450 closeHazard() */
  function closeHazard(): void {
    hazardOpen.value = false
    resetHazard()
  }

  /**
   * 原 js/app.js:1469-1477 —— 文件选择，上限 6 张且仅 image/*
   *
   * 2026-10 交互优化：原来被拒的文件是静默丢弃（forEach 里直接 return），
   * 用户选了 10 张只进来 6 张、或选了个 PDF，界面上完全没有反应。
   * 现在把拒绝数量回给调用方，由页面明确提示。
   */
  function addHazardFiles(files: FileList | File[]): AddFilesResult {
    const r: AddFilesResult = { added: 0, rejectedType: 0, rejectedLimit: 0 }
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) {
        r.rejectedType += 1
        return
      }
      if (hazardImgs.value.length >= 6) {
        r.rejectedLimit += 1
        return
      }
      hazardImgs.value.push(URL.createObjectURL(file))
      r.added += 1
    })
    return r
  }

  /** 原 js/app.js:1460-1466 —— 删除某张已选照片并释放 ObjectURL */
  function removeHazardImg(i: number): void {
    const src = hazardImgs.value[i]
    if (src) URL.revokeObjectURL(src)
    hazardImgs.value.splice(i, 1)
  }

  /**
   * 原 js/app.js:1486-1493 —— 提交校验（纯规则，不含异步）。
   *
   * 只做「能不能提交」的判断并返回文案，不产生副作用，便于单测直接断言；
   * 真正带 loading 的提交走 commitHazard()。
   */
  function submitHazard(): { ok: boolean; message: string } {
    if (!hazardImgs.value.length) {
      return { ok: false, message: '请先拍摄或选择现场照片' }
    }
    return { ok: true, message: '隐患已上报，待整改' }
  }

  /**
   * 带 loading 的提交（2026-10 新增，非原版内容）。
   *
   * 改造前的 onSubmit 是同步的：点一下立即 Toast + 关闭页面，连点会重复触发，
   * 且没有任何「正在提交」的过程反馈。这里：
   *   - 用 hazardSubmitting 挡住重复提交（按钮同时 disabled，双保险）
   *   - 模拟一次网络往返，让按钮真的走完 loading → 成功 的状态机
   *   - 描述文本进入载荷（原版缺陷：填了不读），成功文案回显描述字数
   *
   * 接入真实接口后，把 sleep 换成请求即可，其余状态机不用动。
   */
  async function commitHazard(): Promise<{ ok: boolean; message: string }> {
    if (hazardSubmitting.value) {
      return { ok: false, message: '正在提交，请勿重复点击' }
    }
    const guard = submitHazard()
    if (!guard.ok) return guard

    hazardSubmitting.value = true
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 600))

      const desc = hazardDesc.value.trim()
      lastSubmit.value = {
        kind: hazardKind.value,
        photos: hazardImgs.value.length,
        desc,
        at: new Date().toISOString(),
      }
      return {
        ok: true,
        message: desc
          ? `隐患已上报，待整改（${hazardKind.value} · ${lastSubmit.value.photos}张 · 描述${desc.length}字）`
          : `隐患已上报，待整改（${hazardKind.value} · ${lastSubmit.value.photos}张）`,
      }
    } finally {
      hazardSubmitting.value = false
    }
  }

  return {
    stations,
    station,
    airPhotos,
    airPano,
    airState,
    airNote,
    airPending,
    airAt,
    airHint,
    airDate,
    airDateLabel,
    airMinDate,
    airMaxDate,
    airCalOpen,
    airCalMonth,
    isOpen,
    airPopOpen,
    airPopIdx,
    hazardKind,
    hazardImgs,
    hazardDesc,
    hazardOpen,
    hazardSubmitting,
    lastSubmit,
    airList,
    airListShown,
    airHasMore,
    airRemain,
    airMoreBusy,
    airShown,
    loadStations,
    loadStation,
    loadMoreAir,
    pickStation,
    toggleAirCal,
    setAirCalMonth,
    setAirDate,
    refreshAir,
    resetHazard,
    openAir,
    closeAir,
    openHazard,
    closeHazard,
    addHazardFiles,
    removeHazardImg,
    submitHazard,
    commitHazard,
  }
})
