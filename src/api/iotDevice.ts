import { openGet } from './open'

/**
 * 定位设备台账（B 组大屏 open `/device/*`）
 *
 * 这组接口此前记在「阶段 5 · 授权未开通」里，卡在 CloudWAF 返回 418 拦截页。
 * **2026-11-11 复查：WAF 已恢复**（`personOverall` / `todayTeamsAtteStat` /
 * `organ/list` 都重新返回 200），`/device/*` 三个接口也都通：
 *
 *   `/device/label/page`               → 定位标签，实测 200 条
 *   `/device/gateway/pageByProjectId`  → 项目网关，实测 102 条
 *   `/device/beacon/page`              → 信标，实测 78 条
 *
 * 它们与 `personOverall` 用的是同一套项目级签名（`openGet`），**不需要登录**。
 *
 * ## 用途：人员分布的人数位
 *
 * 之前首页「人员分布」的人数一律显示「—」，理由是 `location/*` 系列
 * （57007 接口权限未获取）拿不到位置。这个判断仍然成立 —— 但**人数**本身
 * 可以从另一个角度算出来：定位标签（`/device/label/page`）每条绑定了
 * `personId`，且有 `isOnline` 在线态。于是：
 *
 *   区域人数 = 该区域下在线的定位标签数（按 `personId` 去重）
 *
 * 标签行本身**没有区域字段**，区域是从网关（`gateway`）的 `areaName` 来的，
 * 两者要靠 `areaId` 关联。这条链路能不能走通取决于标签与网关的关联度，
 * 所以这里把三组原始数据都收回来，关联逻辑放在 `utils/locateDevice.ts` 里做，
 * 关联不上就退回「—」，绝不硬凑数字。
 *
 * 注意 `label/page` 的 `total` 是**全平台**的 200 条（标签是跨项目复用的
 * 个人设备），没有 `project_id` 过滤参数；`gateway/pageByProjectId` 才是
 * 按项目过滤的（实测 102 条，`projectId` 与项目一致）。
 */

/** 定位标签（随身携带的人员定位终端） */
export interface LabelRow {
  /** 标签序列号 */
  labelSn: string
  /** 绑定的人员 id */
  personId: string
  /** 第三方平台人员号 */
  thirdpartyPersonId: string
  /** 1 在线 / 0 离线 */
  isOnline: number
  /** 电量百分比 */
  power: number | null
  /** 是否静止 */
  isMotionless: number
}

/** 网关（基站） */
export interface GatewayRow {
  id: string
  /** 网关序列号 */
  gatewayNo: string
  /** 网关名称，如「2#住宅楼1F-主基站01」 */
  name: string
  /** 1 在线 / 0 离线 */
  isOnline: number
  /** 所属区域 id */
  areaId: string
  /** 所属区域名，如「B1管理区域」 */
  areaName: string
  /** 安装高度（米） */
  height: number | null
  /** 覆盖半径（米） */
  coverRange: number | null
  /** GPS 坐标，'{"lat":..,"lng":..}' 字符串 */
  gpsCoord: string
}

/** 信标（蓝牙信标） */
export interface BeaconRow {
  /**
   * 信标自身的序列号（服务端前缀 `YZPB`）。
   *
   * 字段名叫 `gatewaySn` 但值是**信标自己**的 SN —— `gatewayName`
   * 才是它挂在哪个网关下。别按字面理解成「所属网关 SN」。
   */
  gatewaySn: string
  /** 所属网关名称 */
  gatewayName: string
  /** 1 在线 / 0 离线 */
  isOnline: number
  /** 是否已部署 */
  isDeploy: number
  /** 电量百分比 */
  power: number | null
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (v === undefined || v === null) return ''
  return String(v)
}

/** 分页信封：`{total, rows, curPage, totalPage}` */
interface PageEnvelope<T> {
  total?: number | string
  rows?: T[]
}

/** 单页上限 */
const PAGE_SIZE = 100
const MAX_PAGES = 5

/**
 * 逐页拉全量；`rows` 为空或取满 total 即停。
 *
 * `keyOf` 给每行算一个唯一键并去重 —— 服务端的 `total` 与实际返回的行数
 * 未必一致（实测权限过滤时会出现 total=102 但当页只回 1 行），不去重的话
 * 同一批行会被重复累加，统计出来的在线设备数会虚高。
 */
async function fetchAll<T>(
  path: string,
  params: Record<string, string | number> = {},
  keyOf: (row: T) => string,
): Promise<T[]> {
  const out: T[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await openGet<PageEnvelope<T>>(path, { ...params, page, pageSize: PAGE_SIZE })
    const rows = Array.isArray(data?.rows) ? data.rows : []
    for (const row of rows) {
      const k = keyOf(row)
      if (k && seen.has(k)) continue
      if (k) seen.add(k)
      out.push(row)
    }
    const total = num(data?.total) ?? 0
    if (!rows.length || !total || out.length >= total) break
  }
  return out
}

/**
 * 定位标签清单。
 *
 * 标签是跨项目复用的个人设备，这个接口**没有** `project_id` 过滤参数，
 * 返回的是平台全量（实测 200 条）。数量不小但单条字段很少，
 * 一页 100 条、最多 5 页足够覆盖。
 */
export async function fetchLabels(): Promise<LabelRow[]> {
  const rows = await fetchAll<Record<string, unknown>>('/device/label/page', {}, (r) => str(r.labelSn))
  const out: LabelRow[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const labelSn = str(r.labelSn)
    if (!labelSn) continue
    out.push({
      labelSn,
      personId: str(r.personId),
      thirdpartyPersonId: str(r.thirdpartyPersonId),
      isOnline: num(r.isOnline) ?? 0,
      power: num(r.power),
      isMotionless: num(r.isMotionless) ?? 0,
    })
  }
  return out
}

/** 项目网关清单（按项目过滤，实测 102 条） */
export async function fetchGateways(): Promise<GatewayRow[]> {
  const rows = await fetchAll<Record<string, unknown>>(
    '/device/gateway/pageByProjectId',
    {},
    (r) => str(r.gatewayNo),
  )
  const out: GatewayRow[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const gatewayNo = str(r.gatewayNo)
    if (!gatewayNo) continue
    out.push({
      id: str(r.id),
      gatewayNo,
      name: str(r.name),
      isOnline: num(r.isOnline) ?? 0,
      areaId: str(r.areaId),
      areaName: str(r.areaName),
      height: num(r.height),
      coverRange: num(r.coverRange),
      gpsCoord: str(r.gpsCoord),
    })
  }
  return out
}

/** 信标清单（实测 78 条） */
export async function fetchBeacons(): Promise<BeaconRow[]> {
  const rows = await fetchAll<Record<string, unknown>>(
    '/device/beacon/page',
    {},
    // 信标行的 gatewaySn 其实是**信标自己的 SN**（服务端前缀 YZPB），
    // gatewayName 才是它挂在哪个网关下。用 SN 去重才对。
    (r) => str(r.gatewaySn),
  )
  const out: BeaconRow[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const gatewaySn = str(r.gatewaySn)
    if (!gatewaySn) continue
    out.push({
      gatewaySn,
      gatewayName: str(r.gatewayName),
      isOnline: num(r.isOnline) ?? 0,
      isDeploy: num(r.isDeploy) ?? 0,
      power: num(r.power),
    })
  }
  return out
}
