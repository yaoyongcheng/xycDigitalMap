import type { VideoAlarm } from '@/api/video'
import type { Alarm } from '@/types'
import { formatMD, protoToday, sameDay, startOfDay } from '@/utils/date'

/**
 * 视频报警 → 项目内的 Alarm 结构
 *
 * 首页轮播、巡检列表、预警详情、地图撒点四处都消费 Alarm，所以接口数据必须先
 * 收敛成它，不要在为接口另造一套视图模型 —— 那样四处展示逻辑要各写一遍。
 *
 * 两处必须说清的取舍：
 *   ① **没有经纬度**。视频报警只有通道号（哪台摄像头），服务端不下发坐标。
 *      不给 pin/flat，宁可不在三维图上撒一个假点。
 *   ② **没有分类字段**。服务端只给 `alertName`（如「未戴安全帽」），而项目的
 *      徽标配色与详情页配图是按 `type` 走的。这里用关键词把常见报警名归到
 *      既有的四类图上，归不进去的给通用防护图 —— 总要有一张图，
 *      `AlarmDetail` 是直接拿 `img` 当 src 的，空串会破图。
 */

/** 报警名关键词 → 项目既有分类（顺序敏感：先具体后泛化） */
const CLASSIFY: { re: RegExp; kind: 'trash' | 'cable' | 'net' | 'soil' }[] = [
  { re: /垃圾|杂物|堆放|未清运|脏乱/, kind: 'trash' },
  { re: /电缆|电线|用电|漏电|拖地|私拉/, kind: 'cable' },
  { re: /裸土|扬尘|覆盖|渣土|洒水|未苫盖/, kind: 'soil' },
  { re: /安全帽|安全带|安全网|临边|防护|护栏|防护栏|洞口|未佩戴/, kind: 'net' },
]

const STYLE: Record<string, { title: string; img: string }> = {
  trash: { title: '环境报警', img: 'img/alarm-trash.webp' },
  cable: { title: '用电报警', img: 'img/alarm-cable.webp' },
  soil: { title: '扬尘报警', img: 'img/alarm-soil.webp' },
  net: { title: '防护报警', img: 'img/alarm-net.webp' },
}

/** 兜底：归不进四类的报警按「防护」展示，配图不能为空 */
const FALLBACK = STYLE.net

/**
 * 抓拍时间统一成 'YYYY-MM-DD HH:mm:ss'。
 *
 * 服务端给的是 `2026-11-11 08:30:00`；也见过 ISO 带 T 与时区的写法。
 * 解析不出日期就返回空串，调用方据此丢弃这条 —— 没有时间的报警在按日筛选中
 * 无处安放，留着只会出现在错误的日子里。
 */
export function normalizeTime(v: string): string {
  const s = (v || '').trim()
  if (!s) return ''
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return ''
  const [, y, mo, d, hh, mm, ss] = m
  return `${y}-${mo}-${d} ${hh}:${mm}:${ss ?? '00'}`
}

/** 相对时间文案，与演示数据的口径一致（今天 / 昨天 / MM/DD） */
export function relTime(at: string, now: Date = new Date()): string {
  const t = Date.parse(at.replace(' ', 'T'))
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`

  const day = startOfDay(t)
  const today = startOfDay(now)
  const off = Math.round((today.getTime() - day.getTime()) / 86400000)
  const hm = at.slice(11, 16)
  if (off === 0) return `今天 ${hm}`
  if (off === 1) return `昨天 ${hm}`
  return `${formatMD(day)} ${hm}`
}

/** 一条视频报警 → Alarm（时间为空时返回 null，由调用方丢弃） */
export function toAlarm(v: VideoAlarm, now: Date = new Date()): Alarm | null {
  const at = normalizeTime(v.captureTime)
  if (!at) return null
  const kind = CLASSIFY.find((c) => c.re.test(v.alertName))?.kind
  const style = kind ? STYLE[kind] : FALLBACK
  const ch = v.channelNo > 0 ? `${v.channelNo}号通道` : '现场摄像头'

  return {
    id: `va-${v.id}`,
    day: sameDay(Date.parse(at.replace(' ', 'T')), protoToday()) ? 'today' : 'hist',
    src: 'cam',
    // 报警名本身就是最准确的分类，不用归类名兜掉它（详情页标题要用）
    type: v.alertName,
    title: style.title,
    // 轮播卡只给一行高度，太长会被省略号切掉，所以这里只放「来源 + 通道」
    desc: `AI 视频识别 · ${ch}抓拍`,
    img: style.img,
    rel: relTime(at, now),
    at,
    // 服务端不下发坐标，宁可不撒点
    geo: '',
  }
}

/**
 * 整页视频报警 → 按时间倒序的 Alarm 列表。
 *
 * 已处理（handleStatus=1）的也保留：现场更关心「今天报了多少」，而且归档动作
 * 发生在业务系统里，客户端不该因为看到已处理就把它藏起来。
 *
 * 比较函数必须对「时间完全相同」返回 0：同一秒抓拍多条在路上很常见，
 * 写成 `a.at < b.at ? 1 : -1` 会让相等元素互相判定为「更小」，
 * 排序结果整体反转、顺序每次都可能变。
 */
export function toAlarms(rows: VideoAlarm[], now: Date = new Date()): Alarm[] {
  const out: Alarm[] = []
  for (const r of rows) {
    const a = toAlarm(r, now)
    if (a) out.push(a)
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** 取报警的远程主键（截图接口要的是服务端 Id，不是本地的 va- 前缀 id） */
export function remoteIdOf(alarm: Alarm): string {
  return alarm.id.startsWith('va-') ? alarm.id.slice(3) : ''
}
