import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchMediaJobs, fetchTaskRecords, type DroneMedia } from '@/api/drone'

/**
 * 巡检照片（2026-11 阶段 8：改真实航拍图）
 *
 * 原先这个数据有两份写死的常量：
 *
 *   `data/config.ts: patrolPhotos` —— 17 张设计稿静态图（9 个 WebP 反复复用），
 *     分类靠 `patrolCats` 的六个手工分类（项目全景 / 基坑区域 / 作业面 …）；
 *   `data/config.ts: airImgs / airTimes / airPos` —— 无人机航拍，
 *     10 个固定时刻（07:22 / 08:15 …）轮着配两张图。
 *
 * 两份都是假的，但**看起来像真的**—— 尤其航拍照片，会被当成现场证据看。
 *
 * 现在改接 keehang 平台的真实媒体：
 *   `GET /task/exec/list/record`（本项目 pid）→ 执行记录，每条有 id / 任务名 / 时间；
 *   `GET /media/task/job/{执行记录id}` → 该次飞行的真实照片（OSS 签名直链）。
 *
 * 实测本项目有真实 DJI 航拍图（`DJI_20260715093839_0001_V.jpeg`，约 5.4MB）。
 *
 * ## 关于分类
 *
 * 原版的六个分类是**人工归类的**，服务端不提供分类字段。所以这里不再按分类
 * 过滤 —— 分类是设计稿的展示维度，不是数据维度。真实照片按**拍摄时间倒序**
 * 铺开，页面上标注任务名与时间，让人自己判断。
 *
 * ## 关于图片体积
 *
 * 单张 5~8MB，直接在列表里 `<img src>` 会把流量吃光。这里只展示文件名与
 * 大小摘要，**不自动加载缩略图**；点开大图时才加载原图（用户主动行为，
 * 走 `utils/albumSave.ts` 的预转机制）。
 */

/** 一张真实航拍照片 */
export interface PatrolPhotoReal {
  /** 唯一 id：`{jobId}-{序号}` */
  id: string
  /** 文件名 */
  name: string
  /** OSS 直链 */
  url: string
  /** 所属任务名 */
  taskName: string
  /** 所属任务的执行记录 id（媒体 job） */
  jobId: number
  /** 拍摄/上传时间 */
  time: string
  /** 文件大小（字节） */
  size: number
  /** MIME 类型 */
  mediaType: string
}

/** 状态：idle / loading / ok / error */
export type PatrolState = 'idle' | 'loading' | 'ok' | 'error'

/** 最多拉多少条执行记录（每条都可能带照片，太多会拖慢首屏） */
const MAX_RECORDS = 12
/** 最多取多少个任务的媒体（每个任务一次请求） */
const MAX_JOBS = 8

export const usePatrolStore = defineStore('patrol', () => {
  /** 真实照片 */
  const photos = ref<PatrolPhotoReal[]>([])
  /** 同步到的执行记录条数（页面显示「已同步 N 次飞行」） */
  const flightCount = ref(0)

  const state = ref<PatrolState>('idle')
  const error = ref('')

  let lastFailAt = 0
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

  /**
   * 拉真实航拍照片。
   *
   * 两步：先取执行记录，再对最近几个记录取媒体。
   * 媒体是**按需**的 —— 每个任务一次请求，不可能对 4621 条记录全拉一遍。
   */
  async function load(force = false): Promise<void> {
    if (inflight) return inflight
    if (!force && state.value === 'ok') return
    if (!force && state.value === 'error' && Date.now() - lastFailAt < 60_000) return

    state.value = 'loading'
    inflight = (async () => {
      try {
        const page = await fetchTaskRecords({ page: 1, size: MAX_RECORDS })
        flightCount.value = page.rows.length

        // 最近的记录优先；空数组的任务（无媒体）跳过
        const recent = page.rows.slice(0, MAX_JOBS)
        const collected: PatrolPhotoReal[] = []
        for (const rec of recent) {
          let media: DroneMedia[]
          try {
            media = await fetchMediaJobs(rec.id)
          } catch {
            continue
          }
          for (const m of media) {
            if (!m.mediaType.startsWith('image/')) continue
            collected.push({
              id: `${rec.id}-${m.name}`,
              name: m.name,
              url: m.url,
              taskName: rec.taskName,
              jobId: rec.id,
              time: m.lastModified || rec.start,
              size: m.size,
              mediaType: m.mediaType,
            })
          }
        }

        photos.value = collected
        state.value = 'ok'
        error.value = ''
        lastFailAt = 0
      } catch (e) {
        state.value = 'error'
        error.value = e instanceof Error ? e.message : '巡检照片加载失败'
        photos.value = []
        lastFailAt = Date.now()
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /** 测试接线点：直接灌数据 */
  function apply(list: PatrolPhotoReal[]): void {
    photos.value = list
    flightCount.value = list.length
    state.value = 'ok'
    error.value = ''
  }

  function reset(): void {
    photos.value = []
    flightCount.value = 0
    state.value = 'idle'
    error.value = ''
    lastFailAt = 0
  }

  return {
    photos,
    flightCount,
    state,
    error,
    list,
    sizeText,
    apply,
    load,
    reset,
  }
})
