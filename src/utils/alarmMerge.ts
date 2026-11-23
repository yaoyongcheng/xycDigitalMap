import type { DroneWorkOrder } from '@/api/drone'
import type { Alarm } from '@/types'
import type { TrendPoint } from '@/utils/chart'
import { dateKey } from '@/utils/date'

/**
 * 两类预警合并成一条时间线（2026-11-23 现场要求）
 *
 * 报警预警历史页（`views/sub/AlarmHist.vue`）原来只查 `:8085` 的监控预警；
 * 现场要求「这一页也要能看到无人机预警」，于是把消息页那两个入口背后
 * 的两套数据（`stores/alarm.ts` / `stores/droneAlarm.ts`）在这里合成一个列表。
 *
 * ## 为什么单独一层「entry」而不是硬改某一侧的数据结构
 *
 * 两边的行结构差得远（报警有 `type/desc/rel/src`，工单有 `jobName/status/image`），
 * 谁去迁就谁都会让另一个页面跟着变形。所以这里只产出**排序与去重用的信封**：
 * 时间、来源、以及指向原始行的引用。列表仍然用各自的组件渲染
 * （`InspectItem` / `WorkOrderItem`），字段映射一处都不用改。
 *
 * ## 去重
 *
 * 两边 id 是各自的命名空间（报警 `va-<服务端id>`、工单 uuid），物理上不会撞车；
 * 真正的重复来自**同一个数据源被翻页重复拉到**（服务端没有稳定游标，翻页期间
 * 新报警会把整页往后挤）。所以这里按 `key` 兜一层，`key` 对监控就是报警 id、
 * 对无人机是 `wo-` + 工单 id —— 与两侧 store 的去重口径完全一致，不会因为
 * 多合并一次就多出一行。
 */

/** 合并后每一行的来源 */
export type AlarmEntryKind = 'monitor' | 'drone'

/** 时间线上的一行（只做排序 / 去重，渲染仍交给各自的组件） */
export interface AlarmEntry {
  /** 列表 key（两类各带自己的前缀，永不撞车） */
  key: string
  kind: AlarmEntryKind
  /** 绝对时间 'YYYY-MM-DD HH:mm:ss'（两套接口同一种格式，可直接字符串比较） */
  at: string
  /** 监控预警的原始报警（`kind === 'monitor'` 时有） */
  alarm?: Alarm
  /** 无人机预警的原始工单（`kind === 'drone'` 时有） */
  work?: DroneWorkOrder
}

/**
 * 合并并按时间倒序（新的在上）。
 *
 * 时间相同的两行按 key 排一次，避免同一个时间点每次重算都换顺序 ——
 * 列表会因此闪一下（DOM 复用换行），虽然无害但看起来像在刷新。
 */
export function mergeAlarmEntries(
  alarms: readonly Alarm[],
  works: readonly DroneWorkOrder[],
): AlarmEntry[] {
  const out: AlarmEntry[] = []
  const seen = new Set<string>()

  for (const a of alarms) {
    if (!a?.id || seen.has(a.id)) continue
    seen.add(a.id)
    out.push({ key: a.id, kind: 'monitor', at: a.at, alarm: a })
  }
  for (const w of works) {
    const key = `wo-${w.id}`
    if (!w?.id || seen.has(key)) continue
    seen.add(key)
    out.push({ key, kind: 'drone', at: w.at, work: w })
  }

  out.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.key < y.key ? 1 : x.key > y.key ? -1 : 0))
  return out
}

/** 某一批工单里属于指定日期（本地日）的那些 —— 历史页按日筛选用 */
export function worksOn(works: readonly DroneWorkOrder[], d: Date): DroneWorkOrder[] {
  const key = dateKey(d)
  return works.filter((w) => w.at.slice(0, 10) === key)
}

/**
 * 两条近 7 日趋势按日相加（监控 + 无人机）。
 *
 * 两条曲线的横轴是同 7 天、标签同为 `M/D`（见两侧 store 的 `trend/weekTrend`），
 * 所以按标签求和即可，不需要再对日期做一次解析。以 `base` 的顺序与长度为准：
 * 无人机那份即使少一天，也不会把图表画歪。
 */
export function mergeTrend(base: readonly TrendPoint[], extra: readonly TrendPoint[]): TrendPoint[] {
  const sum = new Map<string, number>()
  for (const p of base) sum.set(p.label, (sum.get(p.label) ?? 0) + p.value)
  for (const p of extra) sum.set(p.label, (sum.get(p.label) ?? 0) + p.value)
  return base.map((p) => ({ label: p.label, value: sum.get(p.label) ?? 0 }))
}
