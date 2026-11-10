/**
 * 首页「人员总览」的只读接口（大屏 open API）。
 *
 * 字段含义按现场平台大屏的口径，与项目里原来的演示数字一一对应：
 *
 *   managedNum  项目人数（在册在管）
 *   workingNum  正在上班
 *   atteNum     今日出勤
 *   atteRate    出勤率（百分比数值，30.0000 表示 30%）
 *   presenceNum 在场人数 / leaveNum 请假人数（暂未上屏，留给人员分布卡）
 *
 * 只做查询。大屏 open 下的写操作（报警删除、状态变更、登出等）一律不接 ——
 * 它们会改动现场系统里的原始数据。
 */

import { openGet } from './open'

/** 人员总览（原 PersonOverallRequester → /bigScreen/BigsHome/personOverall） */
export interface PersonOverall {
  /** 在册在管人数 */
  managedNum: number
  /** 正在上班 */
  workingNum: number
  /** 今日出勤 */
  atteNum: number
  /** 出勤率（百分数） */
  atteRate: number
  /** 在场 */
  presenceNum: number
  /** 请假 */
  leaveNum: number
  /** 企业数 */
  enterpriseNum: number
  /** 班组数 */
  teamNum: number
  /** 人员率 */
  personRate: number
}

/** 把接口里可能是字符串的数字收敛成 number，拿不到就返回 undefined（交由上层回落） */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : undefined
}

/** 拉取人员总览 */
export async function fetchPersonOverall(): Promise<Partial<PersonOverall>> {
  const raw = await openGet<Record<string, unknown>>('/bigScreen/BigsHome/personOverall')
  return {
    managedNum: num(raw.managedNum),
    workingNum: num(raw.workingNum),
    atteNum: num(raw.atteNum),
    atteRate: num(raw.atteRate),
    presenceNum: num(raw.presenceNum),
    leaveNum: num(raw.leaveNum),
    enterpriseNum: num(raw.enterpriseNum),
    teamNum: num(raw.teamNum),
    personRate: num(raw.personRate),
  }
}
