import { request } from './http'
import { DATA_BASE, SCENE_CODE } from './config'

/**
 * 数据服务接口（`:8084`，需 Bearer）
 *
 * 反编译只给出了路径 `/api/data/*`，没记端口；8081/8085 上都是 `404 page not found`。
 * 扫端口后定位到 **8084**（见 config.ts 的说明）。返回信封与登录域一致：
 * `{ code:200, message, data:{ list, total, page, page_size } }`。
 *
 * 字段上有一处必须注意：`device_info.extra_fields` 是**字符串**，里面是
 * `[{"label":"高度","value":"30"}]` 这样的 JSON 数组 —— 直接当数组用会拿到
 * undefined，`JSON.parse` 又可能因为脏数据抛错，所以统一在 utils/deviceLedger.ts
 * 里解析并容错。
 */

/** 设备台账行（字段名照服务端 camel/snake 混排的原样，不做改名） */
export interface DeviceInfoRow {
  id: number
  project_id: string
  device_name: string
  /** 1 在线 / 0 离线 */
  online_status: number
  device_info?: {
    /** JSON 字符串：[{label,value}] */
    extra_fields?: string
    responsible_person?: string
    status_text?: string
    update_time?: string
  }
}

/** 楼栋进度行（整体进度、当前楼层等都在这里；首页暂无消费点） */
export interface BuildingRow {
  id: number
  project_id: string
  building_name: string
  total_floor: number
  current_construction_floor: number
  construction_step: string
  construction_status: number
  building_area: number
  overall_progress: number
  update_time: string
}

/** 总平区域标签行（地图撒点用；当前无消费点） */
export interface AreaRow {
  id: number
  project_id: string
  area_name: string
  principal: string
  /** 已解析好的对象，键值都是展示文案 */
  area_description?: Record<string, string>
}

interface PageData<T> {
  list?: T[]
  total?: number
}

/** 单页上限（服务端允许 200；台账量级很小，一页就够，留循环兜底） */
const PAGE_SIZE = 200
const MAX_PAGES = 5

/**
 * 逐页拉全量。
 *
 * 台账 / 楼栋 / 区域的量级都是个位数到几十条，这里仍然写循环：服务端
 * `total` 大于当页条数时就继续拉，最多 5 页（1000 条）—— 既有兜底，
 * 又不会因为某个项目设备暴增把首屏拖死。
 */
async function fetchAllPages<T>(path: string, query: Record<string, string>): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({ ...query, page: String(page), page_size: String(PAGE_SIZE) })
    const data = await request<PageData<T>>(`${DATA_BASE}${path}?${qs.toString()}`)
    const list = Array.isArray(data?.list) ? data.list : []
    out.push(...list)
    const total = Number(data?.total ?? 0)
    if (list.length === 0 || !total || out.length >= total) break
  }
  return out
}

/**
 * 设备台账。
 *
 * `project_id` 传空串时服务端会返回**全部项目**的设备（实测 8 条 → 数十条），
 * 所以这里默认带上本项目 sceneCode，避免把别的项目的塔机算进来。
 */
export function fetchDeviceInfos(projectId: string = SCENE_CODE): Promise<DeviceInfoRow[]> {
  return fetchAllPages<DeviceInfoRow>('/api/data/deviceinfos', { project_id: projectId })
}

/** 楼栋进度（服务端不支持 project_id 过滤，返回全部项目，调用方要自己筛） */
export function fetchBuildings(): Promise<BuildingRow[]> {
  return fetchAllPages<BuildingRow>('/api/data/buildings', {})
}

/** 总平区域标签（地图撒点用） */
export function fetchAreas(projectId: string = SCENE_CODE): Promise<AreaRow[]> {
  return fetchAllPages<AreaRow>('/api/data/areas', { project_id: projectId })
}
