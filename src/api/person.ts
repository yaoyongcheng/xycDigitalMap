/**
 * 今日在场人员（`POST /location/personCurLocation/v2`）→ 按工种聚合。
 *
 * 这是首页「今日出勤工种」卡的数据源，也是 V2「今日入场人员」表格的同一个源：
 * 接口一次返回当前在场人员清单 `stayPersonPageVos`，每人带
 * `personTypeWork`（工种）、`personName`、`enterpriseName`、`personOrgan`、
 * `totalStayTime` 等，**工种直接躺在行里**，按它分组就是工种人数。
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

/** 在场人员行里我们只用到工种（其余字段留给将来的人员下钻） */
interface StayPerson {
  personTypeWork?: string | null
}

interface CurLocation {
  /** 在场人员清单；空数组 = 此刻没人刷脸进场 */
  stayPersonPageVos?: StayPerson[]
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
 * 今日在场工种，按人数降序。
 *
 * 一次请求拿全量清单再分组 —— 接口没有「按工种计数」的聚合能力，但清单本身
 * 只有几十条，端上分组比分几十次请求准得多（那边还取不到当天数据）。
 */
export async function fetchTradeAtte(): Promise<TradeAtte[]> {
  const data = await openPost<CurLocation>('/location/personCurLocation/v2', {})
  const list = Array.isArray(data?.stayPersonPageVos) ? data.stayPersonPageVos : []

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
