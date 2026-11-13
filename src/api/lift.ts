import { fetchEventRows, fetchRealtimeRows, snOfMetric, IotStaleTokenError, iotTokenUnreachable, type IotEventRow } from './iot'
import { ApiError } from './http'
import { LIFT_SNS } from '@/data/liftSn'
import { sumWork, toAttr, type LiftAttr, type LiftToday } from '@/utils/lift'

/**
 * 智能电梯数据源（IOT 网关 `iot.cscec3b-iti.com`）
 *
 * ## 三份数据、三个事件码
 *
 * V2 `ElevatorRequester` 的四个轮询方法（OnlineStatus / RealtimeData /
 * WorkCycle / WorkCycleHistory）分别对应：
 *
 * | 用途 | 接口 | 关键参数 |
 * |---|---|---|
 * | 在线状态 | `queryRealTimeDataV2` | `field:'online'`, `code:'EVENT_ON_OFF'` |
 * | 当前工况（楼层/高度/人数/载重） | `queryEvent` | `eventCode:'EVENT_POST_ATTR'` |
 * | 今日升降次数 + 运行时长 | `queryEvent` | `eventCode:'EVENT_WORKDATA'` |
 *
 * ## productCode 必须用电梯产品码
 *
 * `P000000076` 是项目码（塔机/大屏/报警那套）。电梯在网关里注册成
 * `01724121a94f4893b693f253173d1082`（V2 `ElevatorIotModel.ProductCode` 常量），
 * 拿项目码查会被判 `status:10 非法的产品列表`——看着像没权限，其实是查错产品。
 *
 * ## 全部「永不 throw」
 *
 * 与项目其它网络层同规则：失败返回 null（整体失败）或跳过该条（部分失败），
 * 由页面显示「—」。首页要因为这些数拉不到就白屏，比缺一格糟得多。
 */

/** 电梯产品码（V2 `ElevatorIotModel.ProductCode`） */
export const LIFT_PRODUCT = '01724121a94f4893b693f253173d1082'

/* ---------- 凭证失效的痕迹 ---------- */

/**
 * 「令牌失效，且自动重换后仍然失败」的时刻。
 *
 * 网络层按项目约定永不 throw，401 会被收敛成 null；但这一层必须把两件事分开：
 *   · 这台电梯没数据 → 页面显示「—」就够了；
 *   · 网关不认我们的凭证 → 再显示「—」就是在骗人，用户看到的全是横杠却不知道
 *     该做什么，只能反复下拉。
 *
 * 所以三个取数函数把这类失败记在这里，由 store 读出来驱动「重新登录」提示。
 * 只记时刻不存错误对象：提示条文案不需要网关原文，而时间戳能顺带做冷却。
 */
let authFailedAt = 0

/**
 * 「网关侧尚未恢复」的时刻 —— 重试换回来的还是刚被判无效的那张令牌。
 *
 * 与 `authFailedAt` 的区别只在**下一步该说什么**：前者是「凭证失效，重试一下」，
 * 后者是「重试过了，网关还没轮换，再点也没用」。网络层在这一步就收手了，
 * 12 个数据请求根本没有发出去（见 `api/iot.ts` 的 `ensureToken` 自检）。
 */
let staleAt = 0

/** 是否处于「凭证失效」状态（提示条据此显示） */
export function liftAuthFailed(): boolean {
  return authFailedAt > 0
}

/** 网关还没轮换令牌（重试也没用，文案要说实话） */
export function liftGatewayStale(): boolean {
  return staleAt > 0
}

/**
 * 换令牌这一跳根本没打通（反代缺失 / 域名不可达 / 服务器不出网）。
 *
 * 与 `liftAuthFailed()` 互斥：那条说的是「网关回了 401」，这条说的是
 * 「请求压根没出得去」。两者的处置完全不同 —— 前者点「重试」等网关轮换，
 * 后者要去查部署（nginx 有没有 `/iot-api` 那一层），点一百次也不会好。
 *
 * 之前这种情况页面只显示一排「—」，用户没法把它和「电梯真没数据」分开。
 */
export function liftGatewayUnreachable(): boolean {
  return !liftAuthFailed() && iotTokenUnreachable()
}

/** 清掉痕迹（取数成功 / 重新登录后调用） */
export function clearLiftAuthFailure(): void {
  authFailedAt = 0
  staleAt = 0
}

/** 401 是唯一值得打扰用户的失败：其余（超时、5xx、无数据）都只影响「—」 */
function noteAuth(err: unknown): void {
  if (err instanceof IotStaleTokenError) staleAt = Date.now()
  if (err instanceof ApiError && err.code === 401) authFailedAt = Date.now()
}


const DAY = 24 * 60 * 60 * 1000

/**
 * 工况帧的回看窗口：设备静止时不发包，窗口太窄会一条都拿不到。
 *
 * V2 用的是 **60 秒**（`<FetchRealtimeDataAsync>d__7`：`now - 60000 ~ now`），
 * 但它每 5 秒轮询一次，窗口只要覆盖两轮间隔就够。我们首轮只拉一次，
 * 照抄 60 秒会让静止的电梯永远没有读数 —— 实测停着的轿厢几小时才发一帧。
 * 所以首轮放宽到 6 小时，仍然只取每台的最后一帧。
 */
const ATTR_WINDOW = 6 * 60 * 60 * 1000

/**
 * 轮询时的回看窗口（`stores/lift.ts` 每 10 秒一轮）。
 *
 * 窗口越宽，每轮返回的帧越多 —— 到下午一台活跃电梯在 6 小时里可能攒下几千条，
 * 每 10 秒重拉一遍纯属浪费。这里取 3 分钟：足以覆盖轮询间隔与网关落库延迟，
 * 又不会随当天时间线性膨胀。窗口内没有新帧时上层**保留上一次的读数**，
 * 不会因为「这台停了 5 分钟」就把「5F」清成「—」。
 */
export const LIVE_ATTR_WINDOW = 3 * 60 * 1000

/**
 * 逐台请求 —— 照 V2 `foreach (sn in DeviceSnList)` 的做法。
 *
 * 三个取数接口在 V2 里都是**一台一个请求**（`GetEnumerator` + `get_Current`，
 * `eventItems` / `queryList` 只装一个 sn）。原来我们塞成一批，实测虽然也能
 * 拿回有效那台的数据，但有两个隐患：
 *
 *   ① 网关对「不归我们的编号」单独查会回 `status:10 所选设备您无权操作`
 *      （`32251222021` / `32251222023` 就是），混批时它被静默跳过 ——
 *      一旦哪天改成整批拒绝，四台会一起变「—」；
 *   ② 混批只有一个总结果，出了事不知道是哪一台。
 *
 * 代价是请求数从 3 个变 12 个，所以这里**并发**发而不是像 V2 那样串行 await
 * （V2 串行是因为它每 5 秒轮询一次，不差那几百毫秒）。
 *
 * 单台失败不影响别台；**全部失败**才抛给调用方（由它 catch 成 null）。
 */
async function perSn<T>(sns: readonly string[], run: (sn: string) => Promise<T>): Promise<T[]> {
  const results = await Promise.allSettled(sns.map((sn) => run(sn)))
  const out: T[] = []
  let firstErr: unknown = null
  for (const r of results) {
    if (r.status === 'fulfilled') {
      out.push(r.value)
      continue
    }
    if (firstErr === null) firstErr = r.reason
    // 部分成功时也要留 401 的痕：那说明是凭证问题，不是这台设备没数据
    noteAuth(r.reason)
  }
  if (!out.length && firstErr !== null) throw firstErr
  return out
}

/** 当天 00:00:00 ~ 23:59:59.999 的毫秒区间（本机时区，与现场口径一致） */
function dayRange(now: Date): { start: number; end: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return { start, end: start + DAY - 1 }
}

/**
 * 在线状态：`{ sn → true/false }`。
 *
 * 只包含网关**真的返回了**的编号 —— 没有任何记录时那个 sn 不出现在表里，
 * 上层据此区分「明确离线」与「压根没上报过」。整体失败返回 null。
 */
export async function fetchLiftOnline(): Promise<Record<string, boolean> | null> {
  if (!LIFT_SNS.length) return null
  try {
    const groups = await perSn(LIFT_SNS, (sn) =>
      fetchRealtimeRows([
        { productCode: LIFT_PRODUCT, sn, field: 'online', code: 'EVENT_ON_OFF' },
      ]),
    )
    const out: Record<string, boolean> = {}
    for (const rows of groups) {
      for (const r of rows) {
        const sn = snOfMetric(r.metricIndex)
        if (!sn) continue
        out[sn] = r.value.toLowerCase() === 'true'
      }
    }
    clearLiftAuthFailure()
    return out
  } catch (err) {
    noteAuth(err)
    return null
  }
}

/**
 * 今日作业：`{ sn → { trips, seconds } }`。
 *
 * 没有事件的台次不出现在表里（而不是给 `{0,0}`）——
 * 「今天没跑」和「今天没数据」在页面上是两句话，只能在数据层先分开。
 */
export async function fetchLiftToday(now = new Date()): Promise<Record<string, LiftToday> | null> {
  if (!LIFT_SNS.length) return null
  const { start, end } = dayRange(now)
  try {
    const groups = await perSn(LIFT_SNS, (sn) =>
      fetchEventRows(
        [{ productCode: LIFT_PRODUCT, sn, eventCode: 'EVENT_WORKDATA' }],
        start,
        end,
      ),
    )
    const out: Record<string, LiftToday> = {}
    for (const rows of groups) {
      const grouped: Record<string, typeof rows> = {}
      for (const r of rows) {
        const sn = snOfMetric(r.metricIndex)
        if (!sn) continue
        ;(grouped[sn] ??= []).push(r)
      }
      for (const [sn, list] of Object.entries(grouped)) out[sn] = sumWork(list)
    }
    clearLiftAuthFailure()
    return out
  } catch (err) {
    noteAuth(err)
    return null
  }
}

/**
 * 区间工作循环（作业报表用）：`{ sn → 该台在区间内的全部事件 }`。
 *
 * 与 `fetchLiftToday` 查的是同一个事件码，只是把区间从「当天」换成任意一段
 * —— 对应 V2 的 `QueryWorkCycleHistoryAsync(sn, date, token)`，那边一天一次，
 * 这里一次拿整段（周报 / 月报不重复请求 7 / 30 次）。
 *
 * 为什么不在这里直接聚合：报表要按**日切片**算在运时段（见 `utils/liftReport.ts`），
 * 那需要保留每条的时间，聚合交给纯函数做才测得准。
 *
 * ## 键的语义（报表要靠它区分两件事）
 *
 * · 键**存在** = 网关认得这个编号（值为空数组说明区间内没跑过）；
 * · 键**缺失** = 网关不认这个编号（`status:10`）或这一台请求失败。
 *
 * 所以这里不复用 `perSn`（它会把失败的 reject 过滤掉、丢失「哪台失败」的
 * 对应关系），改为 `allSettled` 保序配对 —— 报表的结论区要能说出「哪几台
 * 未纳入统计」，而不是笼统地少几行。
 *
 * 量级实测（2026-11-13，单台 `3225122202`）：当天 27KB / 7 天 213KB /
 * 30 天 656KB，耗时 0.2s / 0.4s / 0.7s。四台并发约 1~2 秒，所以报表只在
 * 用户真正切到某个粒度时查一次，不做预取。
 */
export async function fetchLiftWorkRange(
  start: number,
  end: number,
): Promise<Record<string, IotEventRow[]> | null> {
  if (!LIFT_SNS.length) return null
  try {
    const results = await Promise.allSettled(
      LIFT_SNS.map((sn) =>
        fetchEventRows([{ productCode: LIFT_PRODUCT, sn, eventCode: 'EVENT_WORKDATA' }], start, end),
      ),
    )

    const out: Record<string, IotEventRow[]> = {}
    let ok = 0
    let firstErr: unknown = null
    LIFT_SNS.forEach((sn, i) => {
      const r = results[i]
      if (r.status === 'fulfilled') {
        ok += 1
        out[sn] = r.value
        return
      }
      if (firstErr === null) firstErr = r.reason
      // 部分失败时也要留 401 的痕：那是凭证问题，不是这台没数据
      noteAuth(r.reason)
    })

    // 一台都没应答 = 整体失败（令牌 / 网络），交给上层显示提示条
    if (!ok && firstErr !== null) throw firstErr
    clearLiftAuthFailure()
    return out
  } catch (err) {
    noteAuth(err)
    return null
  }
}

/**
 * 最新工况：`{ sn → LiftAttr }`。
 *
 * 逐台查回窗口内的全部帧，只取每台的**最后一条**。比 V2 的「1 分钟窗口 +
 * 5s 轮询」省得多，而这一格（当前楼层/载重）本来就不需要秒级刷新 ——
 * 帧自带时间，页面会把「几点几分」一并显示出来。
 *
 * `windowMs` 由调用方定：首轮用 6 小时（保证静止的轿厢也有读数），
 * 轮询用 `LIVE_ATTR_WINDOW`（窄窗口，避免同一批帧被反复拉第 N 遍）。
 */
export async function fetchLiftAttr(now = Date.now(), windowMs = ATTR_WINDOW): Promise<Record<string, LiftAttr> | null> {
  if (!LIFT_SNS.length) return null
  try {
    const groups = await perSn(LIFT_SNS, (sn) =>
      fetchEventRows(
        [{ productCode: LIFT_PRODUCT, sn, eventCode: 'EVENT_POST_ATTR' }],
        now - windowMs,
        now,
      ),
    )
    const out: Record<string, LiftAttr> = {}
    for (const rows of groups) {
      let bestAt = -Infinity
      let bestSn = ''
      let best: LiftAttr | null = null
      for (const r of rows) {
        const sn = snOfMetric(r.metricIndex)
        if (!sn) continue
        const at = r.timestamp ?? 0
        if (at <= bestAt) continue
        bestAt = at
        bestSn = sn
        best = toAttr(r.resultMap, r.timestamp)
      }
      if (best && bestSn) out[bestSn] = best
    }
    clearLiftAuthFailure()
    return out
  } catch (err) {
    noteAuth(err)
    return null
  }
}
