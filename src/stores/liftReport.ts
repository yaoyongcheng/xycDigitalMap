/**
 * 电梯作业报表的数据层（日报 / 周报 / 月报）
 *
 * ## 与塔机报表 store 的关系
 *
 * 结构照抄 `stores/craneReport.ts`（区间、粒度、请求序号、45s 缓存都是同一套
 * 问题），但数据源完全不同，不能合并：
 *   · 塔机走 `:30400` 的工作循环 REST，按台询 `deviceSN`；
 *   · 电梯走 IOT 的 `queryEvent`，按笼询 `sn`，一次区间拿全部台。
 *
 * 合并会导致这个 store 里一半字段只对一种设备有意义，比两份各 100 行更难读。
 *
 * ## 为什么留在 store 而不是组件里
 *
 * 用户在「设备实时状态 ↔ 作业报表」之间来回切时组件会卸载。取数状态若放在
 * 组件里，每切一次就重打一遍 —— 月报四台合计约 2.6MB（实测单台 30 天 656KB），
 * 现场是手机流量。所以结果与粒度留在 store，同区间 45 秒内复用。
 *
 * ## 缓存键只有区间，不含 sn
 *
 * 电梯的机组是 `LIFT_CAGES` 这份静态登记表，不会随台账变化；一次请求就是
 * 全部 4 笼，所以键用区间即可。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

import { fetchLiftWorkRange, liftAuthFailed, liftGatewayStale } from '@/api/lift'
import { clearToken } from '@/api/iot'
import { LIFT_CAGES } from '@/data/liftSn'
import { reportRange, type ReportRange, type ReportSpan } from '@/utils/craneReport'
import { summarizeRange, type LiftUnitStats } from '@/utils/liftReport'
import type { IotEventRow } from '@/api/iot'

/** 同一区间的结果复用时长：够应付来回切页签，又不至于让数据陈旧过久 */
const TTL = 45_000

/** 取数状态：idle 未请求 / loading 请求中 / ready 有数 / empty 一台都没取到 */
export type LiftReportState = 'idle' | 'loading' | 'ready' | 'empty'

/** 一台笼的结果；`stats` 为 null = 网关不认这个编号 / 这台请求失败 */
export interface LiftReportRow {
  sn: string
  name: string
  stats: LiftUnitStats | null
}

export const useLiftReportStore = defineStore('liftReport', () => {
  const span = ref<ReportSpan>('day')
  const range = ref<ReportRange>(reportRange('day', new Date()))
  const rows = ref<LiftReportRow[]>([])
  const state = ref<LiftReportState>('idle')

  /**
   * 这一轮是不是因为**凭证**失败的。
   *
   * 报表页的空态有两种完全不同的原因，文案必须分开：网关令牌失效 / 尚未轮换
   * 时，用户「换个粒度看看」只会白等（周报月报照样空），该给的是「重试」；
   * 真没跑才是「换个区间看看」。
   *
   * 读的是 `api/lift.ts` 的模块级痕迹（取数成功时它已被清掉），这里只做一份
   * 快照给页面用 —— 页面不该直接 import api 层的状态函数。
   */
  const authLost = ref(false)
  const gatewayStale = ref(false)

  /** 区间缓存 */
  const cache = new Map<string, { at: number; value: Record<string, IotEventRow[]> }>()

  /**
   * 请求序号：用户快速连点三档时只认最后一次的结果，
   * 避免「月报的数字闪回日报」。
   */
  let seq = 0

  /**
   * 拉一次报表。永不 throw —— `fetchLiftWorkRange` 的失败已收敛成 null，
   * 对应的台 `stats` 就是 null，页面据此出「—」与「未纳入统计」。
   */
  async function load(next: ReportSpan = span.value): Promise<void> {
    const token = ++seq
    span.value = next
    range.value = reportRange(next, new Date())
    state.value = 'loading'
    // 清掉上一档的结果：区间文案已换成新档，留着旧数字会让人把日报的 78 次
    // 读成月报的数。缓存命中时下一个微任务就回填，看不到闪。
    rows.value = []

    const { start, end, key } = range.value
    // 区间末日 00:00 → 当日 23:59:59.999，否则「今天的记录」会被截掉
    const from = start.getTime()
    const to = end.getTime() + 86_400_000 - 1

    let data: Record<string, IotEventRow[]> | null
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL) {
      data = hit.value
    } else {
      data = await fetchLiftWorkRange(from, to)
      // 失败不进缓存：让下次重进页面时还能再试一次
      if (data) cache.set(key, { at: Date.now(), value: data })
    }

    // 过期结果直接丢：它对应的粒度已经被用户换掉了
    if (token !== seq) return

    // 凭证痕迹：`fetchLiftWorkRange` 成功时已经清掉，失败时留着。
    // `gatewayStale` 也算「凭证失效」的一种（重试过、网关没轮换）：它单独为真时
    // `authFailedAt` 可能还没被记上（自检在 `ensureToken` 里就收手了，没有 401）。
    gatewayStale.value = liftGatewayStale()
    authLost.value = liftAuthFailed() || gatewayStale.value

    rows.value = LIFT_CAGES.map((c) => ({
      sn: c.sn,
      name: c.name,
      // 键不存在 = 网关不认这个编号 / 请求失败；键存在但是空数组 = 区间内没跑
      stats: data && c.sn in data ? summarizeRange(data[c.sn]) : null,
    }))
    state.value = rows.value.some((r) => r.stats !== null) ? 'ready' : 'empty'
  }

  /**
   * 「重试」：丢掉缓存的 IOT 令牌，重查当前粒度。
   *
   * `clearToken()` 只清令牌、**不清**「上次被拒的那张值」—— 那正是自检要用的：
   * 网关没轮换时换回来还是同一张，`ensureToken()` 直接判 stale 收手，不再把
   * 四个请求打出去（文案随之换成「未恢复」）。
   */
  async function retry(): Promise<void> {
    clearToken()
    await load(span.value)
  }

  /** 登出 / 换项目时清空（缓存里的数字属于上一个会话） */
  function reset(): void {
    seq += 1
    cache.clear()
    rows.value = []
    state.value = 'idle'
    span.value = 'day'
    range.value = reportRange('day', new Date())
    authLost.value = false
    gatewayStale.value = false
  }

  return { span, range, rows, state, authLost, gatewayStale, load, retry, reset }
})
