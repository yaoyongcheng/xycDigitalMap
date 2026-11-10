/**
 * 首页人员块的只读接口（大屏 open API，B 组）。
 *
 * 三个接口都在 `/bigScreen/BigsHome/` 下，与 `personOverall` 同一套签名鉴权，
 * 无需登录。实测返回（2026-11，向阳村现场）：
 *
 *   todayTeamsAtteStat      → [{organId, organName, personNum, atteNum, presenceNum, atteRate}]
 *   todayPersonHourStat     → {manager:[{hours,num}], worker:[{hours,num}]}
 *   weekEnterpriseAtteStat  → [{date:"11-10", enterpriseList:[{enterpriseId, enterpriseName, ...}]}]
 *
 * 注意字段名 `hours` 是**整点小时数**（0..17），不是「人数」—— Unity 端
 * `PersonHourData` 同名字段，容易看反。
 *
 * 本模块只做「取数 + 收敛成前端类型」，不做任何回落：回落是 store 的事
 * （接口失败时首页必须还能显示演示数据，不能空着）。
 */

import { openGet } from './open'

/** 班组出勤（Unity 端 `WorkTeamData`） */
export interface TeamAtte {
  organId: string
  organName: string
  /** 在册人数 */
  personNum: number
  /** 出勤人数 */
  atteNum: number
  /** 出勤率（百分数，30.1 表示 30.1%） */
  atteRate: number
}

/** 分时人数的一个整点 */
export interface HourPoint {
  /** 整点小时数 0..23 */
  hour: number
  /** 该小时在场人数 */
  num: number
}

/** 今日分时人数：管理 / 工人两条曲线 */
export interface PersonHour {
  manager: HourPoint[]
  worker: HourPoint[]
}

/** 企业在某日的出勤 */
export interface EnterpriseAtte {
  enterpriseId: string
  enterpriseName: string
  personNum: number
  atteNum: number
  atteRate: number
}

/** 近 7 日企业出勤：一天一条 */
export interface DayEnterprise {
  /** MM-DD */
  date: string
  list: EnterpriseAtte[]
}

/** 接口里的数字可能是字符串，收敛成 number；非数字返回 undefined 交给上层丢弃 */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function asArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return []
  // 接口偶发返回 [null] 或混入字符串，直接当行用会在读字段时炸掉整条链路
  return v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
}

/**
 * 班组出勤收敛：丢掉没有名字 / 没有出勤数的脏行，按出勤率降序。
 *
 * 排序在接口侧没有保证，而首页这张卡是按「出勤率从高到低」的视觉预期排的
 * （设计稿的演示数据也是降序），所以在前端定死。
 */
export function toTeams(raw: unknown): TeamAtte[] {
  const out: TeamAtte[] = []
  for (const r of asArray(raw)) {
    const organName = str(r.organName)
    const atteNum = num(r.atteNum)
    if (!organName || atteNum === undefined) continue
    out.push({
      organId: str(r.organId),
      organName,
      personNum: num(r.personNum) ?? 0,
      atteNum,
      atteRate: num(r.atteRate) ?? 0,
    })
  }
  return out.sort((a, b) => b.atteRate - a.atteRate || b.atteNum - a.atteNum)
}

/** 把一组 {hours,num} 收敛成按小时升序、去掉非法项的数组 */
function toHourPoints(raw: unknown): HourPoint[] {
  const out: HourPoint[] = []
  for (const r of asArray(raw)) {
    const hour = num(r.hours) ?? num(r.hour)
    const n = num(r.num)
    if (hour === undefined || n === undefined) continue
    if (hour < 0 || hour > 23) continue
    out.push({ hour, num: n })
  }
  return out.sort((a, b) => a.hour - b.hour)
}

/** 今日分时人数收敛 */
export function toPersonHour(raw: unknown): PersonHour {
  const o = (raw ?? {}) as Record<string, unknown>
  return { manager: toHourPoints(o.manager), worker: toHourPoints(o.worker) }
}

/** 近 7 日企业出勤收敛 */
export function toWeekEnterprise(raw: unknown): DayEnterprise[] {
  return asArray(raw)
    .map((d) => ({
      date: str(d.date),
      list: asArray(d.enterpriseList)
        .map((e) => ({
          enterpriseId: str(e.enterpriseId),
          enterpriseName: str(e.enterpriseName),
          personNum: num(e.personNum) ?? 0,
          atteNum: num(e.atteNum) ?? 0,
          atteRate: num(e.atteRate) ?? 0,
        }))
        .filter((e) => e.enterpriseName),
    }))
    .filter((d) => d.date)
}

/** 今日班组出勤 */
export async function fetchTeamsAtte(): Promise<TeamAtte[]> {
  return toTeams(await openGet<unknown>('/bigScreen/BigsHome/todayTeamsAtteStat'))
}

/** 今日分时人数 */
export async function fetchPersonHour(): Promise<PersonHour> {
  return toPersonHour(await openGet<unknown>('/bigScreen/BigsHome/todayPersonHourStat'))
}

/** 近 7 日企业出勤（首页暂未上屏，留给考勤/企业下钻用） */
export async function fetchWeekEnterprise(): Promise<DayEnterprise[]> {
  return toWeekEnterprise(await openGet<unknown>('/bigScreen/BigsHome/weekEnterpriseAtteStat'))
}
