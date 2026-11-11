import type { VideoAlarm } from '@/api/video'
import type { Alarm } from '@/types'
import { formatMD, protoToday, sameDay, startOfDay } from '@/utils/date'

/**
 * 视频报警 → 项目内的 Alarm 结构
 *
 * 首页轮播、巡检列表、预警详情、地图撒点四处都消费 Alarm，所以接口数据必须先
 * 收敛成它，不要在为接口另造一套视图模型 —— 那样四处展示逻辑要各写一遍。
 *
 * 三处必须说清的取舍：
 *   ① **没有经纬度**。视频报警只有通道号（哪台摄像头），服务端不下发坐标。
 *      不给 pin/flat，宁可不在三维图上撒一个假点。
 *   ② **名称要自己拼**。现场 `alertName` 常为空串，必须用 `alertType` 查
 *      `ALERT_TYPE_NAME` 还原；两个都取不到才给中性名（不能空着，详情页
 *      「识别类型」会变成空白行）。
 *   ③ **分类靠关键词猜**。服务端没有项目这套四分类，而徽标配色与详情页配图
 *      是按 `type` 走的。用关键词把报警名归到既有四类图上，归不进去的给通用
 *      防护图 —— 总要有一张图，`AlarmDetail` 是直接拿 `img` 当 src 的，
 *      空串会破图。
 */

/**
 * 报警类型码 → 中文名。
 *
 * 表来自 Unity 端 `AlarmCatalog` 的静态构造（逐个 `ldstr` + 码值成对读出），
 * 不是猜的。**现场 `alertName` 经常是空串**，`alertType` 才是唯一可靠的分类依据：
 * 2026-11-11 实测首行就是 `{alertType: 12, alertName: ""}` → 「反光衣检测」。
 */
export const ALERT_TYPE_NAME: Record<number, string> = {
  5: '烟火检测',
  11: '安全帽检测',
  12: '反光衣检测',
  18: '车辆拥堵检测',
  20: '打电话检测',
  22: '玩手机检测',
  23: '电瓶车逆行检测',
  24: '奔跑检测',
  25: '吸烟检测',
  27: '人员逆行检测',
  29: '老鼠检测',
  30: '摔倒检测',
  31: '室内消防通道占用',
  32: '越界检测',
  33: '区域徘徊检测',
  38: '睡岗检测',
  39: '离岗检测',
  44: '灭火器检测',
  45: '口罩检测',
  46: '监护人员离岗检测',
  48: '摄像头遮挡检测',
  49: '人员打架',
  51: '电瓶车检测',
  53: '车辆逆行检测',
  54: '人员边走玩手机',
  55: '机动车结构化',
  56: '区域入侵检测',
  57: '车辆违停检测',
  58: '周界入侵',
  59: '持械检测',
  64: '区域非机动车统计',
  65: '区域人数统计',
  66: '客流统计',
  67: '区域人数超员',
  68: '区域人数不足',
  69: '区域人数异常',
  74: '地面垃圾检测',
  75: '工服检测',
  79: '摄像头异常位移',
  81: '消防车通道占用',
  85: '消防栓状态检测',
  87: '车流统计',
  90: '工帽检测',
  96: '骑电瓶车未带头盔',
  98: '区域机动车统计',
  112: '排污口水质检测',
  140: '限高检测',
  152: '道路抛洒物检测',
  382: '手套检测',
}

/** 报警名：优先用服务端下发的，空了就查类型码表；都没有给一个中性的名字 */
export function alertLabelOf(name: string, type: number): string {
  const s = (name || '').trim()
  if (s) return s
  return ALERT_TYPE_NAME[type] || 'AI 识别报警'
}

/** 报警名关键词 → 项目既有分类（顺序敏感：先具体后泛化） */
const CLASSIFY: { re: RegExp; kind: 'trash' | 'cable' | 'net' | 'soil' }[] = [
  { re: /垃圾|杂物|堆放|抛洒|排污|水质|未清运|脏乱/, kind: 'trash' },
  { re: /电缆|电线|用电|漏电|私拉|拖地|消防|灭火器|消防栓|通道占用/, kind: 'cable' },
  { re: /裸土|扬尘|覆盖|渣土|洒水|苫盖|堆场/, kind: 'soil' },
  {
    re: /安全帽|工帽|安全网|安全带|反光衣|工服|手套|口罩|临边|防护|护栏|洞口|未佩戴|烟火|火|烟|摔倒|打架|持械|入侵|越界|徘徊|逆行|奔跑|玩手机|打电话|吸烟|离岗|睡岗|遮挡|位移|超员/,
    kind: 'net',
  },
]

/** 四类配图（分类名用 style.title，具体报警名用 alertLabelOf） */
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
  // 现场 alertName 常为空串，必须用类型码还原，否则整页报警会变成「AI 报警」
  const name = alertLabelOf(v.alertName, v.alertType)
  const kind = CLASSIFY.find((c) => c.re.test(name))?.kind
  const style = kind ? STYLE[kind] : FALLBACK
  const ch = v.channelNo > 0 ? `${v.channelNo}号通道` : '现场摄像头'

  return {
    id: `va-${v.id}`,
    day: sameDay(Date.parse(at.replace(' ', 'T')), protoToday()) ? 'today' : 'hist',
    src: 'cam',
    // 具体报警名（详情页「识别类型」用），分类名放在 title
    type: name,
    title: style.title,
    // 轮播卡只给一行高度：具体类型 + 通道，比「AI 视频识别」有信息量
    desc: `${name} · ${ch}抓拍`,
    img: style.img,
    rel: relTime(at, now),
    at,
    // 服务端不下发坐标，宁可不撒点
    geo: '',
    // 阶段 5：监控点位按真实通道号分组；0 视为「没标通道」
    channelNo: v.channelNo > 0 ? v.channelNo : undefined,
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
