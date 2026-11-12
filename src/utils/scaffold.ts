import type { ScaffoldCell, ScaffoldMetric, ScaffoldSensor, ScaffoldSummary } from '@/types'

/**
 * 智能爬架传感器 —— 解析与汇总（纯函数，无网络）
 *
 * ## 数据源
 *
 * CDN 静态 JSON（**不是 REST**）：`{host}/CDN/PC/ScaffoldData.json`。
 * 地址的由来是 Unity V2 端的 `StreamingAssets/CdnConfig.txt`（内容
 * `http://120.26.34.95:9689`）+ `CdnHelper.GetHostServerURL()` 拼
 * `/CDN/PC/{文件名}.json`。免登录、无鉴权、public 读。
 *
 * 报文形如：
 * ```json
 * { "sensors": [ { "itemName": "1#机位", "fbTilt": "3.13mm",
 *                  "lrTilt": "0.25mm", "load": "0.00吨",
 *                  "updateTime": "2026-11-07 14:02:49" }, … ] }
 * ```
 * 三个读数都是**带单位后缀的字符串**，不是数字 —— 直接 `Number()` 会得到
 * NaN，所以统一走 `toNumber` 抓前缀。
 *
 * ## 阈值
 *
 * 服务端报文里**没有**阈值，阈值是 V2 客户端写死的（反编译 IL）：
 *
 * | 方法 | 调用 | 阈值 |
 * |---|---|---|
 * | `ScaffoldDataModel::GetLrTiltStatus` | `Evaluate(lrTilt, 60.0f, "mm")` | 60 mm |
 * | `ScaffoldDataModel::GetFbTiltStatus` | `Evaluate(fbTilt, 60.0f, "mm")` | 60 mm |
 * | `ScaffoldDataModel::GetLoadStatus`   | `Evaluate(load, 5.0f, "吨")`  | 5.0 吨 |
 *
 * `Evaluate` 的实现是：`TryParseValue` 失败 → 返回 `Unknown`；否则
 * `Math.Abs(v) > threshold` ⇒ 异常，否则正常。也就是说**按绝对值判定**，
 * `-179.5mm` 与 `179.5mm` 同等对待。
 *
 * 将来若服务端开始下发阈值，应以服务端为准 —— 这里的常量只是「客户端
 * 那一层」的还原，不是业务真理。
 */

/** 三个指标的阈值（与 V2 客户端硬编码一致） */
export const SCAFFOLD_LIMIT: Readonly<Record<ScaffoldMetric, number>> = {
  lrTilt: 60,
  fbTilt: 60,
  load: 5,
}

/** 三个指标的显示名与单位 */
export const SCAFFOLD_LABEL: Readonly<Record<ScaffoldMetric, { label: string; unit: string }>> = {
  lrTilt: { label: '左右倾斜', unit: 'mm' },
  fbTilt: { label: '前后倾斜', unit: 'mm' },
  load: { label: '载荷', unit: '吨' },
}

/** 指标顺序（卡片三格、详情页三个页签都按这个顺序） */
export const SCAFFOLD_METRICS: readonly ScaffoldMetric[] = ['lrTilt', 'fbTilt', 'load']

/**
 * 带单位后缀的字符串 → 数字。
 *
 * `'3.13mm'` → 3.13、`'0.00吨'` → 0、`'-179.5mm'` → -179.5。
 * 抓不出来（`''` / `'--'` / `null` / `NaN`）一律 `null` —— 绝不回落到 0，
 * 0 在这里是「没有倾斜 / 没有载荷」的结论，不是「不知道」。
 */
export function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * 原始报文 → 机位读数数组。
 *
 * 逐条容错，**脏行丢掉而不是抛错**：
 *   · `itemName` 去空后为空的丢掉（没有机位名，读数无法定位）
 *   · 三个读数全都解析不出来的丢掉（没有任何可判定的信息）
 *
 * 一条有效行都没有时返回 `null` 而不是 `[]`：调用方据此走「数据未取到」
 * 的空态，而不是「38 个机位全都正常」。
 */
export function parseSensors(raw: unknown): ScaffoldSensor[] | null {
  if (!raw || typeof raw !== 'object') return null
  const list = (raw as { sensors?: unknown }).sensors
  if (!Array.isArray(list)) return null

  const out: ScaffoldSensor[] = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    const item = typeof o.itemName === 'string' ? o.itemName.trim() : ''
    if (!item) continue

    const lrTilt = toNumber(o.lrTilt)
    const fbTilt = toNumber(o.fbTilt)
    const load = toNumber(o.load)
    if (lrTilt === null && fbTilt === null && load === null) continue

    out.push({
      item,
      lrTilt,
      fbTilt,
      load,
      time: typeof o.updateTime === 'string' ? o.updateTime.trim() : '',
    })
  }
  return out.length ? out : null
}

/**
 * 单个指标 → 全场最不利机位 + 正常/有读数的机位数。
 *
 * 「最不利」按**绝对值**取（与 V2 的 `Math.Abs` 判定口径一致），平手取先
 * 出现的那个（服务端返回顺序即机位号顺序，稳定且可预期）。
 *
 * `value` 保留原值（`-179.5` 就显示 `-179.5`），不取绝对值 —— 倾斜方向是
 * 现场要看的信息，抹掉符号等于丢信息。
 *
 * 同一趟循环里顺手数出 `normal` / `total`（卡片三格的「37/38」）：
 *   · `total` 只数**有这一项读数**的机位 —— 没上报的机位既不算正常也不算异常
 *   · `normal` = total - 超限台数，所以「37/38」永远读得通
 */
function worstOf(list: ScaffoldSensor[], key: ScaffoldMetric): ScaffoldCell {
  const meta = SCAFFOLD_LABEL[key]
  const limit = SCAFFOLD_LIMIT[key]

  let best: ScaffoldSensor | null = null
  let bestAbs = -1
  let total = 0
  let bad = 0
  for (const s of list) {
    const v = s[key]
    if (v === null) continue
    total += 1
    const abs = Math.abs(v)
    if (abs > limit) bad += 1
    if (abs > bestAbs) {
      bestAbs = abs
      best = s
    }
  }

  const value = best ? (best[key] as number) : null
  return {
    key,
    label: meta.label,
    unit: meta.unit,
    limit,
    value,
    item: best ? best.item : '',
    // 没有读数就不下结论：false 表示「没判出超限」，页面遇到 null 值走空态
    over: value === null ? false : Math.abs(value) > limit,
    normal: total - bad,
    total,
  }
}

/** 全场汇总：三个指标各取最不利机位 + 机位数 + 最新更新时间 */
export function summarize(list: readonly ScaffoldSensor[]): ScaffoldSummary {
  const rows = [...list]

  // updateTime 是定长 'yyyy-MM-dd HH:mm:ss'，字典序即时间序，不必解析成 Date
  let updatedAt = ''
  for (const s of rows) if (s.time && s.time > updatedAt) updatedAt = s.time

  const cells = SCAFFOLD_METRICS.map((k) => worstOf(rows, k))

  const overItems = new Set<string>()
  for (const s of rows) {
    for (const c of cells) {
      const v = s[c.key]
      if (v !== null && Math.abs(v) > c.limit) overItems.add(s.item)
    }
  }

  return { count: rows.length, updatedAt, cells, overCount: overItems.size }
}

/**
 * 生成超限告警文案，句式照设计稿：「30#机位 左右倾斜 179.5mm，超过 60mm」。
 *
 * 数值保留原精度（`179.5` 不补成 `179.50`）：服务端给什么就显示什么，
 * 补零会让现场以为是另一个量级。
 */
export function scaffoldLabel(cell: ScaffoldCell): string {
  if (cell.value === null) return ''
  return `${cell.item} ${cell.label} ${cell.value}${cell.unit}，超过 ${cell.limit}${cell.unit}`
}

/**
 * 从三格里挑出第一条超限文案（没有超限返回空串）。
 *
 * 卡片只有一行告警位，多个指标同时超限时按 `SCAFFOLD_METRICS` 的顺序取
 * 第一条 —— 倾斜排在前（设计稿也是先报倾斜），载荷在后。
 */
export function firstOverLabel(summary: ScaffoldSummary): string {
  for (const key of SCAFFOLD_METRICS) {
    const cell = summary.cells.find((c) => c.key === key)
    if (cell?.over) return scaffoldLabel(cell)
  }
  return ''
}

/** '2026-11-07 14:02:49' → '14:02'（卡片上的更新时间只到分钟） */
export function timeHm(time: string): string {
  const m = /\s(\d{2}):(\d{2})/.exec(time)
  return m ? `${m[1]}:${m[2]}` : ''
}
