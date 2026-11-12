import type { CraneWorkCycle } from '@/types'

/**
 * 塔机工作循环（今日吊次 / 吊重）—— `tciccs` 塔机数据服务
 *
 * ## 为什么要单独一个模块
 *
 * 设计稿首页塔机卡的数值位是「今日吊重 1.87t + 今日吊次 26次」，本地此前
 * 只能放台账里的「最大高度」——根因不是接口没通，而是**台账里没有设备序列号**。
 * 2026-11 第三轮把 V2（Unity）端的塔机取数链路挖出来后落成这一层。
 *
 * ## 契约（2026-11-12 用真实 sn 打通，已验证）
 *
 * V2 端 `CraneWorkCycleRequester.QueryWorkCycleHistoryAsync` 的 IL 指向同一台
 * 主机上的塔机专用服务（不是 tsdb 那条路由，那条在这台主机上是 404）：
 *
 *   POST https://tciccs.cscec3bxjy.cn:30400/api/towercranedataservice/getWorkCycleInfoHis
 *   （无鉴权头）
 *   { "deviceSN": "<sn>", "startTime": "2026-11-12 00:00:00", "endTime": "2026-11-12 24:00:00" }
 *
 *   → { "code": 200, "success": true, "msg": "操作成功",
 *       "data": [ { "deviceSN", "deviceName", "siteName", "name",
 *                   "startTime", "endTime", "duration", "weight", "type",
 *                   "maxTorque", "maxHeight", "minHeight", "maxRange", "minRange",
 *                   "startAngle", "startHeight", "startRange",
 *                   "endHeight", "endRange", "endAngle", … } ] }
 *
 * 三个坑（都踩过）：
 *   ① 字段名是 **`deviceSN`**，写 `sn` 会被回 `400 塔机编号不存在`；
 *   ② 时间是 **`'yyyy-MM-dd HH:mm:ss'` 字符串**，不是 Unix 毫秒；
 *   ③ `weight` 已经是**吨**，`duration` 是秒，都不用换算。
 *
 * **仍然取不到数的原因不是接口，是编号**：`:8084` 台账没有序列号字段
 * （整份 V2 dll 也确认 `/api/data/deviceinfos` 不含 sn），所以
 * `utils/deviceLedger.ts: serialOf` 拿不到就整块跳过。一旦台账补上编号，
 * 这条链路立刻出数。
 *
 * ## 约定
 *
 * 本模块**永不抛错**：拿不到编号、超时、被 WAF 拦、业务报错，一律返回 `null`。
 * 页面的口径是「没有数据就显示 —」，把异常抛到渲染层只会得到一片报错。
 */

/**
 * 请求基址：**必须走同源反代，不能直连**。
 *
 * 直连地址是 `https://tciccs.cscec3bxjy.cn:30400`（HTTPS，不涉及混合内容），
 * 但这个服务**不放行任何跨域来源** —— 带 `Origin` 的预检 `OPTIONS` 一律
 * `403 Invalid CORS request`，正常 POST 的响应里也没有
 * `Access-Control-Allow-Origin`（实测任何 origin 都一样，包括它自己的域名）。
 * 浏览器因此拿不到响应体；Postman / curl 不执行同源策略，才显得
 * 「Postman 能调、页面调不通」。这是服务端的 CORS 白名单，不是我们代码的问题。
 *
 * 所以：
 *   ① `npm run dev` → `/crane-api`（vite.config.ts 的 server.proxy）
 *   ② `npm run deploy:http` 自托管 → `/crane-api`（server/serve.mjs 的同名路由）
 *   ③ 纯静态托管（GitHub Pages）没有反代 → 这个路径 404 → 返回 null → 显示「—」
 *      （与之前被 CORS 拦掉的结果一致，不引入新的假数据）。要在这里出数，
 *      只能请塔机平台把站点 origin 加白名单，再用 `VITE_CRANE_BASE`
 *      指向那个放行跨域的地址（绝对 URL 也行）。
 */
const CRANE_BASE = (
  (import.meta.env.VITE_CRANE_BASE as string | undefined)?.trim() || '/crane-api'
).replace(/\/+$/, '')

/** 工作循环查询路径（拼在基址后面，反代只剥掉 `/crane-api` 前缀） */
const WORK_CYCLE_PATH = '/api/towercranedataservice/getWorkCycleInfoHis'


/** 单次请求超时（现场是公网 + 自签网关，给宽一点） */
const TIMEOUT = 12_000

/* ---------- 内部工具 ---------- */

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (v === undefined || v === null) return ''
  return String(v).trim()
}

/**
 * 收敛数字：'1.87' / 1.87 都收，其余（'--' / '' / null）一律 null。
 *
 * 空串必须单独挡掉 —— `Number('')` 是 **0**，直接透传会把「没有值」变成
 * 「重量 0 吨」，那是最不该出现在这张卡上的数字。
 */
function num(v: unknown): number | null {
  if (typeof v === 'string') {
    const text = v.trim()
    if (!text) return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  if (typeof v !== 'number') return null
  return Number.isFinite(v) ? v : null
}

/**
 * 时刻 → Unix ms。
 *
 * 服务端有两种可能的写法：毫秒时间戳（Go 的 `millis`）或
 * `'yyyy-MM-dd HH:mm:ss'` 字符串。秒级时间戳也一并兼容 ——
 * 判据是「小于 1e11 的多半是秒」（1e11 ms ≈ 1973 年，现场数据不可能更早）。
 */
function toMs(v: unknown): number | null {
  const n = num(v)
  if (n !== null) return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
  const text = str(v)
  if (!text) return null
  // Safari 不接受 'yyyy-MM-dd HH:mm:ss'，换成 'yyyy/MM/dd HH:mm:ss' 再解析
  const ms = Date.parse(text.replace(/-/g, '/'))
  return Number.isFinite(ms) ? ms : null
}

/**
 * 当天的时间窗。
 *
 * **必须是 `'yyyy-MM-dd HH:mm:ss'` 字符串，不是 Unix 毫秒。**
 * 2026-11-12 实测：发 `{sn, startTime:<ms>, endTime:<ms>}` 服务端回
 * `400 {"code":400,"success":false,"msg":"塔机编号不存在"}` —— 注意这个错误
 * 文案会把人往「编号不对」上带，实际是**字段名和格式都不对**。
 *
 * 正确形态与 V2 反编译 `CraneWorkCycleRequester` 的 `FormatStartTime` /
 * `FormatEndTime` 一致：`"{0:yyyy-MM-dd} 00:00:00"` / `"{0:yyyy-MM-dd} 24:00:00"`。
 * `'24:00:00'` 看着像非法时间，但服务端接受（实测与 `'23:59:59'` 返回同一批
 * 数据），照 V2 原样写。
 *
 * 用本地时区构造而不是 UTC —— 现场按北京时间看「今日」。
 */
export function dayRange(date: Date): { startTime: string; endTime: string } {
  return rangeParams(date, date)
}

/**
 * 任意区间的时间窗（作业报表的周报 / 月报用）。
 *
 * 与 V2 `UICraneHistoryPop.GetStartDate/GetEndDate` 同一口径：周报是**自然周**
 * （周一起）、月报是**自然月**（1 号到月末），端点各自取当天 00:00:00 与
 * 24:00:00 —— 与 `CraneWorkCycleRequester.FormatStartTime/FormatEndTime` 一致。
 *
 * 服务端实测接受跨月的大区间：2026-10-14 ~ 11-12 一次回 474 条（235KB）。
 */
export function rangeParams(start: Date, end: Date): { startTime: string; endTime: string } {
  const p = (n: number): string => String(n).padStart(2, '0')
  const key = (d: Date): string => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return { startTime: `${key(start)} 00:00:00`, endTime: `${key(end)} 24:00:00` }
}

/**
 * 从响应里挖出「可能是数组」的那一层（结构未验证，故多处兜底）。
 *
 * 返回 `null` 表示**没认出任何列表结构**，与返回 `[]`（认出列表、但它是空的）
 * 是两件事：前者是「不知道」，后者是「今天确实没吊」。
 */
function pickList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  // 常见信封：{ data: {...} } / { data: [] }
  if (o.data !== undefined && o.data !== null) {
    const inner = pickList(o.data)
    if (inner) return inner
  }
  for (const key of ['list', 'records', 'rows', 'workCycles', 'items', 'result']) {
    const v = o[key]
    if (Array.isArray(v)) return v
  }
  return null
}

/**
 * 响应 → 工作循环数组。**纯函数**，单测直接喂各种脏结构。
 *
 * 脏行不丢也不猜：缺时间的行仍保留（时间位为 null），缺重量的行 weight 为
 * null —— 吊次（条数）与吊重（累加）是两个独立指标，一条没有重量的循环
 * 仍然是「吊了一次」。
 */
export function toWorkCycles(raw: unknown): CraneWorkCycle[] {
  const list = pickList(raw)
  if (!list) return []
  const out: CraneWorkCycle[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const start = toMs(o.startTime ?? o.start_time ?? o.beginTime ?? o.start)
    const end = toMs(o.endTime ?? o.end_time ?? o.finishTime ?? o.end)
    // 时长优先取服务端 duration（秒）；没有就用 end-start 推（ms → s）。
    // 两个都没有 → null：作业报表的「作业时长」宁可写「—」，也不能写 0
    const rawDur = num(o.duration ?? o.durationSeconds ?? o.duration_seconds)
    const derived = start !== null && end !== null && end > start ? Math.round((end - start) / 1000) : null
    out.push({
      start,
      end,
      // 最大吊重：V2 报文叫 maxWeight；降到 REST 后有叫 weight / loadWeight
      weight: num(o.maxWeight ?? o.max_weight ?? o.weight ?? o.loadWeight ?? o.load),
      duration: rawDur !== null && rawDur > 0 ? Math.round(rawDur) : derived,
      type: str(o.type ?? o.workType ?? o.work_type),
    })
  }
  return out
}

/**
 * 拉某台塔机某一天的工作循环。
 *
 * @param sn 塔机编号（台账 `extra_fields` 里取，见 utils/deviceLedger.ts: serialOf）
 * @param date 归属日（只取日期部分，时间窗按整天算）
 * @returns 工作循环数组；**没有任何可信结果时返回 null**（不是空数组）
 *
 * 返回 null 与返回 `[]` 的差别很重要：
 *   · `[]` = 接口通了、当天这台塔机确实没吊 → 吊次 0、吊重「—」是结论；
 *   · `null` = 编号缺失 / 请求失败 / **响应结构认不出来** → 吊次与吊重都显示「—」。
 */
export async function fetchCraneWorkCycle(sn: string, date: Date): Promise<CraneWorkCycle[] | null> {
  return fetchCraneWorkCycles(sn, date, date)
}

/**
 * 拉某台塔机某段区间的工作循环（作业报表的日报 / 周报 / 月报共用）。
 *
 * 与 `fetchCraneWorkCycle` 是同一条链路，只是时间窗可控 —— V2 的报表本来就是
 * `QueryAllWorkCycleHistoryAsync(startDate, endDate)` 按区间查，不是按天查。
 *
 * @param start 区间首日（只取日期部分，从 00:00:00 起）
 * @param end 区间末日（含当天，到 24:00:00）
 * @returns 工作循环数组；**没有任何可信结果时返回 null**（不是空数组）
 */
export async function fetchCraneWorkCycles(
  sn: string,
  start: Date,
  end: Date,
): Promise<CraneWorkCycle[] | null> {
  const code = str(sn)
  if (!code) return null

  const { startTime, endTime } = rangeParams(start, end)
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT)

  try {
    const res = await fetch(`${CRANE_BASE}${WORK_CYCLE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // 字段名是 deviceSN（大写 SN），不是 sn —— 写 sn 会被当成「塔机编号不存在」
      body: JSON.stringify({ deviceSN: code, startTime, endTime }),
      signal: ctrl.signal,
    })
    // 400「塔机编号不存在」也走这里：对页面而言都是「拿不到数」
    if (!res.ok) return null

    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // 网关/代理返回 HTML 错误页时会走到这里
      return null
    }
    if (!body || typeof body !== 'object') return null
    // 业务失败：该服务的包体带 success 布尔与 code 数值
    const env = body as Record<string, unknown>
    if (env.success === false) return null
    const codeNum = num(env.code)
    if (codeNum !== null && codeNum !== 0 && codeNum !== 200) return null

    // 「结构没认出来」与「当天没吊」必须分开：前者只能显示「—」，
    // 后者才是「吊次 0」。把它当空数组会让卡片写下一个「0 次」的假结论。
    if (!pickList(body)) return null

    return toWorkCycles(body)
  } catch {
    // 超时 / 断网 / WAF 拦截 —— 一律视为「没有数据」
    return null
  } finally {
    window.clearTimeout(timer)
  }
}
