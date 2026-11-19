import type { VideoAlarm } from '@/api/video'
import type { Alarm } from '@/types'
import { CAM_PLACE } from '@/data/config'
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
 *   ③ **分类靠关键词猜**。服务端没有项目这套四分类，而徽标配色与列表标题
 *      是按 `type` 走的。用关键词把报警名归到既有四类上，归不进去的给通用
 *      防护类 —— 分类只决定 `title` 文案，不再挂示意图（2026-11-19 起列表
 *      图标位改为「抓拍图 or 统一占位图标」，见 `types.ts::Alarm`）。
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

/** 四类分类名（`title`），配图在 2026-11-19 整体下线，见 `types.ts::Alarm` */
const STYLE: Record<string, { title: string }> = {
  trash: { title: '环境报警' },
  cable: { title: '用电报警' },
  soil: { title: '扬尘报警' },
  net: { title: '防护报警' },
}

/** 兜底：归不进四类的报警按「防护」展示 */
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

/**
 * 报警地点文案（详情页「报警地点」、列表副标题共用）。
 *
 * 服务端只有通道号，点位名来自 `CAM_PLACE`（与 V2 同源的客户端配置）。
 * 没有映射时退到「N号通道」而不是「—」：通道号是服务端真实下发的，
 * 界面上有个能对得上的编号，比一行空白或者编一个地名都强。
 */
export function placeOf(a: Pick<Alarm, 'place' | 'channelNo'>): string {
  const p = (a.place || '').trim()
  if (p) return p
  return a.channelNo && a.channelNo > 0 ? `${a.channelNo}号通道` : '—'
}

/**
 * 详情页大图角标副标题：`CAM-2#材料堆场`。
 *
 * 与 `ALARM_SRC.cam.sub` 的区别是它**按这条报警自己的通道现算** —— 原来那句
 * 写死的「CAM-2#塔吊」会让通道 3 的报警也顶着 2 号机位。
 */
export function camTagOf(a: Pick<Alarm, 'place' | 'channelNo'>): string {
  if (!a.channelNo || a.channelNo <= 0) return '现场摄像头'
  const p = (a.place || '').trim()
  return p ? `CAM-${a.channelNo}#${p}` : `CAM-${a.channelNo}`
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
  // 点位名（报警地点）来自客户端通道映射，服务端不下发
  const place = CAM_PLACE[v.channelNo] || ''

  return {
    id: `va-${v.id}`,
    day: sameDay(Date.parse(at.replace(' ', 'T')), protoToday()) ? 'today' : 'hist',
    src: 'cam',
    // 具体报警名（详情页「识别类型」用），分类名放在 title
    type: name,
    title: style.title,
    // 轮播卡只给一行高度：具体类型 + 点位（没有点位名时用通道号）
    desc: `${name} · ${place || ch}抓拍`,
    rel: relTime(at, now),
    at,
    // 服务端不下发坐标，宁可不撒点
    geo: '',
    // 阶段 5：监控点位按真实通道号分组；0 视为「没标通道」
    channelNo: v.channelNo > 0 ? v.channelNo : undefined,
    // 详情页「报警地点」与「设备编号」：都是服务端真实字段（点位名见 CAM_PLACE）
    place,
    deviceNo: v.deviceNo,
    // 服务端已读状态透传：消息未读数、未读红点都靠它，不能丢（0=未读，1=已读）
    handleStatus: v.handleStatus,
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
