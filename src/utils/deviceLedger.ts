import type { DeviceInfoRow } from '@/api/data'
import type { CraneDayStats, DeviceUnit, Equip, EquipUnit } from '@/types'
import { robotDemoTrips } from '@/data/robotStats'

/**
 * 设备台账映射（接口行 → 页面结构）
 *
 * 数据源只有「静态台账」：设备名、在线状态、以及一个 `extra_fields` 字符串
 * （`[{"label":"高度","value":"64"},…]`）。页面需要的东西比这多，但**不能编**：
 *   · 首页前四卡：台数与在线数直接数行；数值位只放台账里真有的字段（高度）
 *   · 设备详情卡：名称 / 状态 / 四格全部来自 extra_fields
 *   · 今日吊次、吊重来自塔机工作循环接口（api/towerCrane.ts），但它按 **sn** 查，
 *     而台账里连序列号字段都没有（只能从 extra_fields 的 label 里猜，见 serialOf）
 *   · 5 类机器人没有接口与台账，作业次数取 V2 预制体的默认值（见 ROBOT_CARDS）
 *
 * 归类靠设备名关键词而不是 id 或类型码：服务端没有「设备类型」字段，
 * 名字是唯一可靠的分类依据（`智能塔机2` / `传统塔机5` / `2#智能爬架` …）。
 */

export type DeviceCategory = 'crane' | 'lift' | 'climb' | 'drone'

/**
 * 归类规则。顺序有意义：「智能塔机」「传统塔机」都含「塔机」，
 * 而「智能电梯」不含塔机字样，互不冲突；但爬架设备名里可能带「电梯」
 * （2#智能爬架 不带，留个兜底），所以爬架要排在电梯前面判。
 */
const CATEGORY_RULES: readonly (readonly [DeviceCategory, RegExp])[] = [
  ['climb', /爬架|爬升/],
  ['crane', /塔机|塔吊/],
  ['lift', /电梯|升降机/],
  ['drone', /无人机/],
]

/** 设备名 → 类别；认不出来的返回 null（不进任何一张卡，也不静默丢弃统计） */
export function categoryOf(name: string): DeviceCategory | null {
  const text = String(name ?? '')
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat
  return null
}

/**
 * 设备种类数（保留给需要「台账里到底有几种设备」口径的调用方）。
 *
 * 首页统计卡**不用**它：那边按「页面上列出几类设备」报（含 5 类机器人，
 * 与 V2 装备管理页同口径），见 `views/home/EquipPanel.vue` 的 `kinds`。
 * 两者的差别只在「归类不出来的设备」算不算 —— 它们没有卡片承载，
 * 算进首页种类会出现「种类比卡片多」的自相矛盾。
 */
export function kindsOf(rows: readonly { device_name?: string }[]): number {
  const seen = new Set<string>()
  for (const r of rows) seen.add(categoryOf(r?.device_name ?? '') ?? 'other')
  return seen.size
}

/**
 * 解析 `device_info.extra_fields`。
 *
 * 服务端给的是**字符串**，内容是一个 `[{label,value}]` 数组；实测存在两种脏法：
 * 字段缺失（无人机就是空串）与 value 不是字符串（数字/boolean）。
 * 这里一律收敛成 `[label, value]` 二元组数组，脏行丢掉而不是抛错 ——
 * 台账里少一行属性不影响设备本身还该出现在列表里。
 */
export function parseExtraFields(raw?: string): [string, string][] {
  if (!raw) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: [string, string][] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const label = String((item as { label?: unknown }).label ?? '').trim()
    if (!label) continue
    const v = (item as { value?: unknown }).value
    if (v === null || v === undefined || v === '') continue
    out.push([label, String(v)])
  }
  return out
}

/** 在线判定：`online_status === 1`（服务端用 1/0，不是布尔） */
export function isOnline(row: DeviceInfoRow): boolean {
  return Number(row?.online_status) === 1
}

/** 状态文案：优先服务端的 status_text，缺失时按 online_status 兜底 */
export function statusOf(row: DeviceInfoRow): string {
  const text = row?.device_info?.status_text
  return text && String(text).trim() ? String(text).trim() : isOnline(row) ? '在线' : '离线'
}

/** 高度类字段（带 m 后缀展示）—— 只有它们需要拼单位 */
function isHeightLabel(label: string): boolean {
  return /高度$/.test(label)
}

/** 把 extra_fields 里的高度字段转成数字，用于「最大高度」这类聚合 */
export function heightOf(row: DeviceInfoRow): number | null {
  for (const [label, value] of parseExtraFields(row?.device_info?.extra_fields)) {
    if (!isHeightLabel(label)) continue
    const n = Number.parseFloat(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * 序列号类字段的键名（2026-11 第三轮）。
 *
 * tsdb / 塔机工作循环两个接口都按 **sn** 查（见 api/towerCrane.ts 的实测记录），
 * 而 `:8084` 台账没有独立的序列号字段，只能从 `extra_fields` 的 label 里猜。
 * 这里只认这些「明确是编号」的键 —— 不做子串模糊匹配，否则「设备名称」里
 * 出现「编号」两个字就会被当成 sn，那比没有 sn 更糟（等于编了个编号）。
 */
const SERIAL_LABELS: readonly RegExp[] = [/^sn$/i, /序列号/, /设备编号/, /塔机编号/]

/**
 * 台账行 → 设备序列号；台账里没有就返回 null。
 *
 * **取不到即视为没有**：调用方（stores/deviceLedger.ts）据此整块跳过工作循环
 * 查询，而不是拿设备名去凑一个「编号」。空串、占位符（'--' / '无'）同样算没有。
 */
export function serialOf(row: DeviceInfoRow): string | null {
  for (const [label, value] of parseExtraFields(row?.device_info?.extra_fields)) {
    if (!SERIAL_LABELS.some((re) => re.test(label))) continue
    const text = value.trim()
    if (!text || /^[-—/]+$/.test(text) || text === '无') continue
    return text
  }
  return null
}

/** 数值展示：高度补 m，其余原样（'2026-12-10' / '机师' / '正常'） */
function formatValue(label: string, value: string): string {
  return isHeightLabel(label) ? `${value}m` : value
}

/**
 * 每类设备在实时卡上优先展示的字段。
 *
 * 只挑台账里确实会出现的键，顺序即卡片格子的顺序；字段不存在就跳过，
 * 由后续字段补位 —— 不留空格子，也不显示『--』占位。
 */
const CELL_FIELDS: Record<DeviceCategory, readonly string[]> = {
  crane: ['高度', '塔吊司机', '安检有效期', '质检报告状态'],
  lift: ['高度', '安检有效期'],
  climb: ['爬升高度', '安检有效期'],
  drone: ['高度', '安检有效期'],
}

/**
 * 台账行 → 设备卡数据。
 *
 * `cells` 是实时状态卡的四格，`info` 是「设备信息」弹层的明细（全字段 + 责任人 +
 * 更新时间）。名称后面的台号不另算：`name` 直接用服务端的 device_name，
 * 服务端本来就区分了「智能塔机2」「智能塔机3」。
 */
export function toUnit(row: DeviceInfoRow): DeviceUnit {
  const fields = parseExtraFields(row?.device_info?.extra_fields)
  const cat = categoryOf(row?.device_name) ?? 'drone'
  const map = new Map(fields)

  const cells: [string, string][] = []
  for (const label of CELL_FIELDS[cat]) {
    const v = map.get(label)
    if (v !== undefined) cells.push([label, formatValue(label, v)])
  }
  // 偏好字段一个都没命中时退到「前四行」，保证卡片不是空的
  if (cells.length === 0) cells.push(...fields.slice(0, 4).map(([l, v]) => [l, formatValue(l, v)] as [string, string]))

  const info: [string, string][] = fields.map(([l, v]) => [l, formatValue(l, v)] as [string, string])
  const person = row?.device_info?.responsible_person
  if (person && String(person).trim()) info.push(['责任人', String(person).trim()])
  const updated = row?.device_info?.update_time
  if (updated) info.push(['更新时间', String(updated)])

  return {
    id: String(row.id),
    tab: String(row.device_name ?? ''),
    name: String(row.device_name ?? ''),
    status: statusOf(row),
    cells,
    info,
    today: {},
    history: [],
  }
}

/**
 * 机组排序用的台号：取名称里第一段数字。
 *
 * `智能塔机2` → 2、`传统塔机5` → 5、`2#智能爬架` → 2、`智能电梯1` → 1。
 * 取不到数字返回 null（排到最后，不猜）。
 *
 * 为什么按台号而不是按名称排：服务端返回顺序是**倒序**（传统塔机5、智能塔机4…），
 * 而现场口径是从小到大；按名称 `localeCompare` 又会把「传统」排在「智能」前面，
 * 得到 传统塔机5 / 智能塔机2 / 3 / 4 —— 都不是想要的那一列。
 * 台号是唯一既稳定又符合现场读数习惯的键（用户 2026-11-12 明确要求）。
 */
export function unitNo(name: string): number | null {
  const m = String(name ?? '').match(/\d+/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

/** 机组排序：台号升序，无台号的排最后（同号保持服务端原序） */
export function byUnitNo(a: DeviceUnit, b: DeviceUnit): number {
  const na = unitNo(a.name)
  const nb = unitNo(b.name)
  if (na === null && nb === null) return 0
  if (na === null) return 1
  if (nb === null) return -1
  return na - nb
}

/** 首页四张「有数据源」的卡片定义（id / 名称 / 图标 / 详情页），与设计稿前四类一一对应 */
const CARD_DEFS: readonly {
  id: DeviceCategory
  name: string
  ico: string
  page: 'crane' | 'lift' | 'uav' | 'climb'
}[] = [
  // 名称照设计稿 gx2 与桌面端截图：这一类在界面上叫「5G塔机」，
  // 不是「智能塔机」。服务端返回的 *设备名* 仍是「智能塔机2」这类原名，
  // 两者不要混 —— 卡片名是展示口径，设备名是台账事实。
  { id: 'crane', name: '5G塔机', ico: 'crane', page: 'crane' },
  { id: 'lift', name: '智能电梯', ico: 'lift', page: 'lift' },
  { id: 'drone', name: '无人机', ico: 'drone', page: 'uav' },
  { id: 'climb', name: '智能爬架', ico: 'climb', page: 'climb' },
]

/**
 * 5 类机器人的入口卡（设计稿 gx2 版 app.js:886-909 的后五条）。
 *
 * ## 数字从哪来
 *
 * 取自 **V2 客户端预制体的默认文本** —— `UIView 装备管理一张图 / 底部栏 /
 * 施工机器人栏` 下每张卡的 `Value` 就是写死的 `5次 / 9次 / 7次 / 4次 / 3次`
 * （读取方式与逐节点对应关系见 `data/robotStats.ts` 的文件头）。
 *
 * 需要说清的是：V2 自己也没有机器人作业接口，那几个数字同样是模拟值
 * （同栏在线数一律写死 `4/4`、爬架高度写死 `0m`，性质相同）。
 * 本项目照 V2 的做法取同一组值，用户 2026-11-12 明确要求这样做。
 *
 * ## 为什么仍是「静态卡」
 *
 * `linked: false` → 渲染成不可点的 div、不出箭头、不出「在线 x/y」。
 * 机器人在 `:8084` 台账里一行都没有，`0/0` 会被读成「一台都没在线」，
 * 而事实是「一台都不知道」—— 在线格连模拟值都不给。
 *
 * 现场接入机器人平台后，把 `data/robotStats.ts` 换成真实派生即可，
 * 卡片渲染分支（`linked` / `stats`）不用改。
 */
function robotCard(id: string, name: string, ico: string): Equip {
  const trips = robotDemoTrips(id)
  return {
    id,
    name,
    ico,
    linked: false,
    // 现场这几类机器人是常驻在线的，卡片标题给绿点。
    // 必须是显式值：`units` 为空 → equipCount 派生出来是 'off'（灰点=离线），
    // 那是在替它们下一个没依据的结论。
    dot: 'on',
    // 没有登记就退回「—」—— 绝不写「0次」冒充「今天没干活」
    value: trips === null ? '—' : `${trips}次`,
    metric: '今日作业次数',
    units: [],
  }
}

export const ROBOT_CARDS: readonly Equip[] = [
  robotCard('grind', '地坪研磨机器人', 'grind'),
  robotCard('plaster', '抹灰机器人', 'plaster'),
  robotCard('survey', '测量机器人', 'survey'),
  robotCard('spray', '喷涂机器人', 'spray'),
  robotCard('screed', '混凝土整平机器人', 'screed'),
]

/** 数值格式化：重量保留两位（1.87t，与设计稿同位）；没有重量时给它「—」 */
function weightText(weight: number | null): string {
  return weight === null ? '—' : `${weight.toFixed(2)}t`
}

/**
 * 台账行 → 首页智控前四卡（有数据源的那四类）。
 *
 * 四张卡**恒定存在**（即使某类 0 台也渲染，卡片显示 0/0 并给空态），
 * 因为它们是入口 —— 卡消失会让用户以为功能没了，而实际只是没设备。
 * 数值位的取值规则：
 *   · 塔机 → 工作循环汇总的「今日吊重 + 今日吊次」（`craneDay` 为 null 时
 *     退回台账里的最大高度 —— 高度的来源是台账，不是编的）
 *   · 电梯 → 台账高度（「累计运行时间」需要工作循环能力，本机未接，见下）
 *   · 爬架 → 台账里的爬升高度（三格传感器数据无接口，模板给空态文案）
 *   · 无人机 → 没有高度概念，数值位留空（模板会跳过）
 *
 * @param craneDay 塔机当日作业指标；null = 没有 sn 或接口没通（不造数）
 */
export function toEquip(rows: DeviceInfoRow[], craneDay: CraneDayStats | null = null): Equip[] {
  const units: Record<DeviceCategory, EquipUnit[]> = { crane: [], lift: [], climb: [], drone: [] }
  const heights: Record<DeviceCategory, number[]> = { crane: [], lift: [], climb: [], drone: [] }

  for (const row of rows) {
    const cat = categoryOf(row?.device_name)
    if (!cat) continue
    units[cat].push({ name: String(row.device_name ?? ''), on: isOnline(row), rows: [] })
    const h = heightOf(row)
    if (h !== null) heights[cat].push(h)
  }

  return CARD_DEFS.map((def) => {
    const max = heights[def.id].length ? Math.max(...heights[def.id]) : null
    const card: Equip = {
      id: def.id,
      name: def.name,
      ico: def.ico,
      page: def.page,
      linked: true,
      units: units[def.id],
    }
    if (max !== null) {
      card.value = `${max}m`
      card.metric = def.id === 'climb' ? '爬升高度' : '最大高度'
    }
    // 塔机有真实作业指标就优先展示（设计稿的「今日吊重 + 今日吊次」两格）
    if (def.id === 'crane' && craneDay) {
      card.stats = [
        { value: weightText(craneDay.weight), metric: '今日吊重' },
        { value: `${craneDay.trips}次`, metric: '今日吊次' },
      ]
    }
    return card
  })
}
