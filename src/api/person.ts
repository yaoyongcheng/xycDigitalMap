/**
 * 今日在场人员（`POST /location/personCurLocation/v2`）→ 按工种聚合 + 按区域聚合。
 *
 * 这是首页「今日出勤工种」与「人员分布」卡的共同数据源，也是 V2「今日入场人员」
 * 表格与「人员分布」浮层的同一个源。接口一次返回两块东西：
 *
 *   · `stayPersonPageVos` —— 今日有定位记录的人员清单，每人带 `personTypeWork`
 *     （工种）、`personName`、`enterpriseName`、`personOrgan`、`areaName`、
 *     `gatewayPositionName`、`alive`（此刻是否在线）等；
 *   · `stayPersonCountVos` —— **按区域聚合好的在场/离线人数**
 *     （`areaName` / `onlinePersonNum` / `offlinePersonNum` / `totalPersonNum`），
 *     最后一行 `areaId === '-1'` 是全项目合计。
 *
 * 两个聚合都从**同一次请求**里出，首页因此只多打一个请求而不是两个。
 *
 * 为什么不用另外两条路（都试过，口径不对）：
 *   · `POST /person/page` + `presentStatus=1`：那是花名册的「在场」标记，含好几天
 *     没做出场的人，木工会算成 90 人（实际在场 17 人）；
 *   · `POST /report/attendance/attendanceDay`：日考勤明细，当天的记录要等收工后
 *     才生成（`date=今天` 返回空数组，昨天才有数据），实时看不了。
 *
 * **坑**：必须 POST。`dw.yzw.cn/open` 网关对「路径存在但方法不对」的请求回的是
 * `57007 接口权限未获取`，而不是 405 —— 用 GET 试会看起来像没权限（见 `openPost`）。
 */

import { openPost } from './open'

/** 一个工种的在场人数 */
export interface TradeAtte {
  /** 工种名（与现场人员档案的「工种」同字） */
  name: string
  /** 当前在场人数 */
  count: number
}

/**
 * 场景下的一个「子级」。
 *
 * 两种场景长得不一样，所以名字不叫「管控区」：
 *   · `2#住宅楼` / `地下室` —— 子级是**楼层**（`1F`…`5F` / `-1F`），
 *     一个楼层可能对应多条管控区（如 `2#楼4F管控区`、`2#楼4F管控区_copy`）；
 *   · `场布图` —— 子级就是**管控区**本身（管理区域 / 智能钢筋加工区 / 北侧钢筋加工区）。
 *
 * 页面对两者一视同仁：一行名字 + 一个人数，点开看这行下面的名单。
 */
export interface SceneUnit {
  /** 楼层名（1F / -1F）或管控区名（管理区域 / 智能钢筋加工区） */
  name: string
  /** 当前在场人数（= members.length） */
  count: number
  /** 在场人员（按姓名拼音排序） */
  members: PersonBrief[]
}

/** 人员简要信息（人员分布下钻用；电话/证件等一律不带出来） */
export interface PersonBrief {
  /** 姓名 */
  name: string
  /** 工种（缺省「未填工种」） */
  trade: string
  /** 所属企业（劳务公司 / 班组名称，一行放不下时页面自己截断） */
  company: string
}

/** 一个大场景的人数与其下属子级（楼层 / 管控区） */
export interface SceneAtte {
  /** 场景名：场布图 / 2#住宅楼 / 地下室 */
  name: string
  /** 场景合计（= 下属子级之和） */
  count: number
  /** 下属子级（点开场景后列出，顺序见 `toUnits`） */
  units: SceneUnit[]
}

/** 一次请求的全部产物 */
export interface OnSitePeople {
  /** 工种（人数降序，「其它/未填」沉底） */
  trades: TradeAtte[]
  /** 三个大场景（顺序固定，0 人也保留） */
  scenes: SceneAtte[]
  /** 在场总人数；-1 = 没取到 */
  total: number
}

/** 在场人员行 */
interface StayPerson {
  personTypeWork?: string | null
  /** 姓名 */
  personName?: string | null
  /** 所属区域（离线时为 null / 空） */
  areaName?: string | null
  /** 此刻是否在线：true 才计入「在场」 */
  alive?: boolean | null
  /** 劳务公司 */
  enterpriseName?: string | null
}

/** 按区域聚合的人数行（数值是字符串，实测如此） */
interface StayCount {
  areaId?: string | null
  areaName?: string | null
  onlinePersonNum?: string | number | null
}

interface CurLocation {
  /** 在场人员清单；空数组 = 此刻没人刷脸进场 */
  stayPersonPageVos?: StayPerson[]
  /** 按区域聚合的人数；缺这一块 = 该接口没给区域口径 */
  stayPersonCountVos?: StayCount[]
}

/** 工种名缺失时的兜底标签（不丢人，也不编一个工种名） */
const NO_TRADE = '未填工种'

/**
 * 「兜底桶」：不管人数多少都排在最下面。
 *
 * 「其它 / 其他 / 未填工种」不是真实工种，把它们混在木工、钢筋工中间，读起来
 * 像现场多了一支「其它队」；按用户要求固定沉底（2026-11-17）。
 */
const TAIL_TRADES = new Set(['其它', '其他', NO_TRADE])

/**
 * 三个大场景（顺序即页面顺序，与 V2「人员分布」浮层一致）。
 *
 * V2 的地图就是这三块：总平面（场布图）、2# 住宅楼楼层、地下室。接口给的
 * 是更细的「管控区」（2#楼4F管控区、B1管理区域、智能钢筋加工区…），页面上
 * 按下面的规则归到三个场景，点开场景再看管控区明细。
 */
const SCENES = ['场布图', '2#住宅楼', '地下室'] as const

/**
 * 管控区 → 场景。
 *
 * 规则来自现场实际的管控区命名（2026-11-18 实测 8 条）：
 *   · `B1管理区域`            → 地下室
 *   · `2#楼4F管控区` / `2#楼1F管控区` / `2#楼3F管控区` / `2#楼5F管控区_copy` → 2#住宅楼
 *   · `管理区域` / `智能钢筋加工区` / `北侧钢筋加工区` → 场布图
 *
 * 顺序不能反：`B1管理区域` 同时含「管理区域」，先判地下室才不会漏到总平面。
 * 将来现场新增管控区（如「酒店」「A 区」）默认归场布图 —— 它们都在总平面上。
 */
function sceneOf(areaName: string): string {
  // B1/B2/负一层 都算地下室（现场目前只有 B1，B2 出现了也要能归对）
  if (/B\s*\d|地下|地库|负\s*[一二三四\d]/i.test(areaName)) return '地下室'
  if (/2\s*#|住宅楼/.test(areaName)) return '2#住宅楼'
  return '场布图'
}

/**
 * 固定楼层表（数组顺序 = 页面顺序），对齐 V2「人员分布」浮层的楼层列表。
 *
 * V2 里 `2#住宅楼` 永远是 1F~5F 五行，一个人都没有也照列；`地下室` 现场只有
 * 一条 `B1管理区域` 管控区 —— 也就是负一层，所以固定 `-1F`（用户确认）。
 *
 * 为什么固定枚举、不按数据里出现过的楼层列：现场 2# 楼的管控区只有
 * 1F / 3F / 4F / 5F 四条，2F 没有对应的管控区。按数据列会少一行，
 * 看起来像「2 层凭空没了」，而 V2 里它就是一行 0 人。
 *
 * 表里没有的楼层不会丢：`toUnits` 会按层数把它们追加在后面。所以将来现场
 * 真出现 `B2管理区域`，地下室会自动变成「-1F、-2F」两行。
 */
const FLOORS: Record<string, string[]> = {
  '2#住宅楼': ['1F', '2F', '3F', '4F', '5F'],
  '地下室': ['-1F'],
}

/** `2#楼4F管控区` → 4F；`B1管理区域` → -1F；认不出返回 null */
const FLOOR_RE = /(\d+)\s*F/i
const BASEMENT_FLOOR_RE = /(?:B|负)\s*(\d+)/i

/**
 * 管控区名 → 楼层名。
 *
 * 注意 `2#楼4F管控区` 里的 `2#` 不是楼层：正则要求数字后面紧跟 `F`，
 * 「2」后面是「#」，所以只会命中 4F。
 */
export function floorOf(areaName: string, scene: string): string | null {
  if (scene === '地下室') {
    const b = BASEMENT_FLOOR_RE.exec(areaName)
    if (b) return `-${b[1]}F`
    const f = FLOOR_RE.exec(areaName)
    return f ? `-${f[1]}F` : null
  }
  const f = FLOOR_RE.exec(areaName)
  return f ? `${f[1]}F` : null
}

/**
 * 楼层名的排序键：正层按层数升序（1F < 6F），负层按离地面由近到远
 * （-1F 在 -2F 前面 —— 直接比数值会把 -2F 排到 -1F 之上）。
 */
function floorOrder(name: string): number {
  const m = /^(-?\d+)\s*F$/i.exec(name.trim())
  if (!m) return Number.MAX_SAFE_INTEGER
  const n = Number(m[1])
  return n >= 0 ? n : 1000 + Math.abs(n)
}

/** 收到 `toUnits` 里的一条原始行（一个管控区的人数 + 名单） */
interface UnitSeed {
  name: string
  count: number
  members: PersonBrief[]
}

/**
 * 管控区行 → 场景下的子级。
 *
 * · `场布图`：原样保留管控区，人数降序 —— 现场就是几块料场/加工区，没有楼层。
 * · `2#住宅楼` / `地下室`：按楼层归并，再按 `FLOORS` 补齐没人楼层（0 人也占位），
 *   顺序与 V2 那个列表一致。表外的楼层（将来多出 6F、-2F）排在后面并保持层数有序。
 */
function toUnits(scene: string, rows: UnitSeed[]): SceneUnit[] {
  const fixed = FLOORS[scene]
  if (!fixed) {
    return [...rows].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
  }

  const buckets = new Map<string, SceneUnit>()
  for (const name of fixed) buckets.set(name, { name, count: 0, members: [] })

  for (const row of rows) {
    const key = floorOf(row.name, scene) ?? row.name
    const u = buckets.get(key) ?? { name: key, count: 0, members: [] }
    u.count += row.count
    u.members.push(...row.members)
    buckets.set(key, u)
  }

  const extras = [...buckets.values()]
    .filter((u) => !fixed.includes(u.name))
    .sort((a, b) => floorOrder(a.name) - floorOrder(b.name))

  const out = [...fixed.map((name) => buckets.get(name) as SceneUnit), ...extras]
  for (const u of out) u.members.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return out
}

/** 工种清单 → 按人数降序，「其它/未填」沉底 */
export function groupTrades(list: StayPerson[]): TradeAtte[] {
  const counts = new Map<string, number>()
  for (const p of list) {
    const name = String(p?.personTypeWork ?? '').trim() || NO_TRADE
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const tail = (t: TradeAtte): number => (TAIL_TRADES.has(t.name) ? 1 : 0)
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => tail(a) - tail(b) || b.count - a.count || a.name.localeCompare(b.name, 'zh'))
}

/**
 * 这个人此刻是否在场。
 *
 * 实测是布尔 `alive`，但同一套接口里 `onlinePersonNum` 之类的数值是字符串，
 * 所以这里对 1 / "1" / "true" 一并认 —— 判定错了会让整张卡变成「0 人」，
 * 不值得为「类型洁癖」冒这个险。
 */
function isAlive(p: StayPerson): boolean {
  const v = p?.alive as unknown
  return v === true || v === 1 || v === 'true' || v === '1'
}

/**
 * 在场人员 → 三个大场景（含每个人的姓名）。
 *
 * **只算 `alive === true` 的人**，这和接口的 `onlinePersonNum` 完全对得上
 * （2026-11-18 实测：管理区域 33 / 智能钢筋 2 / 北侧钢筋 3 = 38，与
 * `stayPersonCountVos` 的在线数逐个相同）。所以人数直接取名单条数，不再
 * 单独读 `stayPersonCountVos` —— 名单和数字永远一致，不会出现「38人」但
 * 点开只有 30 个名字。
 *
 * 注意「今日出勤工种」卡是**另一套口径**：那边用全天在场清单（含已离场的人），
 * 因为 V2 的「今日入场人员」表格也是这个范围。两张卡数字不同不是 bug。
 *
 * `counts` 只作兜底：万一某天接口不再下发 `alive`（全为 false/undefined），
 * 就退回用 `onlinePersonNum` 的合计，名单为空、页面提示「暂无现场名单」。
 */
export function buildScenes(people: StayPerson[], counts: StayCount[]): { scenes: SceneAtte[]; total: number } {
  /** 管控区名 → 人员名单 */
  const byArea = new Map<string, PersonBrief[]>()

  for (const p of people) {
    if (!isAlive(p)) continue
    const area = String(p?.areaName ?? '').trim()
    if (!area) continue
    const list = byArea.get(area) ?? []
    list.push({
      name: String(p?.personName ?? '').trim() || '未填姓名',
      trade: String(p?.personTypeWork ?? '').trim() || NO_TRADE,
      company: String(p?.enterpriseName ?? '').trim(),
    })
    byArea.set(area, list)
  }

  const scenes: SceneAtte[] = SCENES.map((name) => {
    const rows: UnitSeed[] = []
    for (const [areaName, members] of byArea) {
      if (sceneOf(areaName) !== name) continue
      rows.push({
        name: areaName,
        count: members.length,
        members: [...members].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
      })
    }
    const units = toUnits(name, rows)
    return { name, count: units.reduce((s, u) => s + u.count, 0), units }
  })

  const live = scenes.reduce((s, x) => s + x.count, 0)
  if (live > 0) return { scenes, total: live }

  // 兜底：名单里没人（接口没给 alive），退回按管控区的在线数，名单留空
  return groupScenes(counts)
}

/**
 * 区域人数行 → 三个大场景（**没有名单的兜底路径**）。
 *
 * `totalPersonNum` 在各管控区之间会重复计人（同一个人今日去过多个区域），
 * 加起来远超总人数；`onlinePersonNum` 才是此刻人数。「全部」（areaId -1）
 * 不参与归类，只用来取总人数。
 */
export function groupScenes(rows: StayCount[]): { scenes: SceneAtte[]; total: number } {
  const buckets = new Map<string, UnitSeed[]>()
  let total = -1

  for (const r of rows) {
    const name = String(r?.areaName ?? '').trim()
    const count = Number(r?.onlinePersonNum ?? 0)
    const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
    if (String(r?.areaId ?? '') === '-1' || name === '全部') {
      total = n
      continue
    }
    if (!name) continue
    const key = sceneOf(name)
    const arr = buckets.get(key) ?? []
    arr.push({ name, count: n, members: [] })
    buckets.set(key, arr)
  }

  const scenes: SceneAtte[] = SCENES.map((name) => {
    const units = toUnits(name, buckets.get(name) ?? [])
    return { name, count: units.reduce((s, u) => s + u.count, 0), units }
  })

  if (total < 0) total = scenes.reduce((s, x) => s + x.count, 0)
  return { scenes, total }
}

/**
 * 今日在场人员：工种 + 三场景（含人员姓名），一次请求。
 *
 * 两个聚合都来自同一次响应 —— 首页同时要工种卡和人员分布卡，分开请求等于
 * 把同一份清单拉两遍。
 *
 * **接口没给区域口径时 `scenes` 返回空数组、`total` 返回 -1**，而不是三个
 * 0 人场景：那样页面会显示「场布图 0人 / 2#住宅楼 0人 / 地下室 0人」，
 * 把「没有这个口径」说成「一个人都没有」——0 是个结论，此刻没资格下。
 */
export async function fetchOnSitePeople(): Promise<OnSitePeople> {
  const data = await openPost<CurLocation>('/location/personCurLocation/v2', {})
  const people = Array.isArray(data?.stayPersonPageVos) ? data.stayPersonPageVos : []
  const counts = Array.isArray(data?.stayPersonCountVos) ? data.stayPersonCountVos : []
  const trades = groupTrades(people)
  if (!people.length && !counts.length) return { trades, scenes: [], total: -1 }
  const { scenes, total } = buildScenes(people, counts)
  // 名单没给（接口不再下发 alive）且连区域人数也没有 → 空态，别报三个 0
  if (!scenes.some((s) => s.count > 0) && !counts.length) return { trades, scenes: [], total: -1 }
  return { trades, scenes, total }
}

/** 今日在场工种，按人数降序（保留给只关心工种的调用方与单测） */
export async function fetchTradeAtte(): Promise<TradeAtte[]> {
  return (await fetchOnSitePeople()).trades
}
