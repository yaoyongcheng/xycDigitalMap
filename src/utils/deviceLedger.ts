import type { DeviceInfoRow } from '@/api/data'
import type { DeviceUnit, Equip, EquipUnit } from '@/types'

/**
 * 设备台账映射（接口行 → 页面结构）
 *
 * 数据源只有「静态台账」：设备名、在线状态、以及一个 `extra_fields` 字符串
 * （`[{"label":"高度","value":"64"},…]`）。页面需要的东西比这多，但**不能编**：
 *   · 首页四卡：台数与在线数直接数行；数值位只放台账里真有的字段（高度）
 *   · 设备详情卡：名称 / 状态 / 四格全部来自 extra_fields
 *   · 今日吊次、吊重、利用率这些作业指标来自 tsdb 接口，当前部署上 404，
 *     所以 DeviceUnit 的 today / history 留空，页面显示空态
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

/** 首页四卡的定义（id / 名称 / 图标 / 详情页），与设计稿的四类一一对应 */
const CARD_DEFS: readonly {
  id: DeviceCategory
  name: string
  ico: string
  page: 'crane' | 'lift' | 'uav' | 'climb'
}[] = [
  { id: 'crane', name: '智能塔机', ico: 'crane', page: 'crane' },
  { id: 'lift', name: '智能电梯', ico: 'lift', page: 'lift' },
  { id: 'drone', name: '无人机', ico: 'drone', page: 'uav' },
  { id: 'climb', name: '智能爬架', ico: 'climb', page: 'climb' },
]

/**
 * 台账行 → 首页智控四卡。
 *
 * 四张卡**恒定存在**（即使某类 0 台也渲染，卡片显示 0/0 并给空态），
 * 因为它们是入口 —— 卡消失会让用户以为功能没了，而实际只是没设备。
 * 数值位的取值规则：
 *   · 塔机 / 电梯 / 爬架 → 台账里的高度（最大高度，爬架是爬升高度）
 *   · 无人机 → 没有高度概念，数值位留空（模板会跳过）
 */
export function toEquip(rows: DeviceInfoRow[]): Equip[] {
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
      units: units[def.id],
    }
    if (max !== null) {
      card.value = `${max}m`
      card.metric = def.id === 'climb' ? '爬升高度' : '最大高度'
    }
    return card
  })
}
