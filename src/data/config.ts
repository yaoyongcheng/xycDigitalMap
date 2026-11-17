import type { Alarm, MineMenu, TabId } from '@/types'

/**
 * 纯静态配置常量
 *
 * 这些值不随接口返回而变化，故不进 Pinia store，直接 import 使用。
 * 逐字搬运自 js/app.js（原版基线），仅补类型标注。
 */

/** 原 js/app.js:2 */
export const titles: Record<TabId, string> = {
  home: '首页',
  work: '工作台',
  msg: '消息',
  mine: '我的',
}

/** 原 js/app.js:23 */
export const mineMenus: MineMenu[] = [
  { id: 'sites', name: '我的工地' },
  { id: 'setting', name: '设置' },
  { id: 'about', name: '关于' },
]

/**
 * 「我的」三个菜单的占位说明（2026-10 交互优化新增）。
 *
 * 原先三个入口点进去是同一句通用文案 —— 用户点了「设置」看到的是
 * 「『设置』内页…后续按账号、工地和设置补齐」，等于什么都没说，也不知道
 * 这个入口到底打算干什么。这里给每个入口一句各自的范围说明，让占位页
 * 至少能传达「这里将来放什么」。
 */
export const mineNotes: Record<string, string> = {
  我的工地: '在这里切换当前工地、查看已加入的项目与成员。接入账号体系后按账号权限返回可切换列表。',
  设置: '消息推送、地图图层、离线缓存等偏好设置。当前为演示版，配置项尚未开放。',
  关于: '版本号、更新日志与第三方许可说明。当前为演示版，版本信息由 PWA 更新提示提供。',
}

/*
 * 2026-11 阶段 5 删除：camShotPool（3 项全是同一张 cam-crane2.webp）与
 * camShotTimes（08:12 / 12:36 / 16:50）。监控点位与抓拍已改为 :8085 真实
 * 报警按通道 + 日期派生，见 stores/cam.ts。
 */

/** 原 js/app.js:259 —— 预警轮播可视条数 */
export const ALARM_FEED_SHOW = 3

/**
 * 预警采集来源（2026-11 设计稿 gx2 版，原 app.js:255-259）。
 *
 * tag：列表徽标上的短文案；name / sub：详情页大图角标的主副标题。
 * 同一来源的徽标与角标必须同源取值，否则列表说「随手拍」、
 * 详情页却写「自动巡航无人机」就穿帮了。
 */
export const ALARM_SRC = {
  drone: { tag: '无人机', name: '自动巡航无人机', sub: 'UAV-25638583' },
  // sub 留空：视频监控的角标是「CAM-2#材料堆场」这种**按通道现算**的文案
  // （见 utils/videoAlarm.ts 的 camTagOf）。原来写死「CAM-2#塔吊」，12:39:06
  // 那条通道 2 的报警在地点是材料堆场时就会自相矛盾。
  cam: { tag: '视频监控', name: '视频监控抓拍', sub: '' },
  snap: { tag: '随手拍', name: '管理人员随手拍', sub: '张工 安全员' },
} as const

/**
 * 视频通道号 → 报警地点（点位名）。
 *
 * **与 V2 完全同构：写死在客户端，接口不返回。**（2026-11-17 反编译核实）
 *
 * V2 是 Unity 客户端（`向阳村-万联装备集群作业系统V2`），报警详情由
 * `AIAlarmDetail.Init(AlarmNoticeData, AlarmNoticeItem)` 渲染，模型里只有
 * `channelNo`，地点靠静态字典 `AlarmCatalog.PosDescMap` 翻：
 *
 *   · 类 `AlarmCatalog` 有三个字段：`Unknown` / `TypeDescMap` / `PosDescMap`，
 *     方法 `GetTypeDesc` / `GetPosDesc`；
 *   · 该字典在其 `.cctor`（静态构造）里用 `ldstr` 逐对写入，IL 里就是
 *     `"2" → "材料堆场"`、`"3" → "安全讲台"` —— **只有这两对**，没有更多；
 *   · 同一份 `.cctor` 还写了 49 对报警类型码（5 烟火检测 … 382 手套检测），
 *     就是 `utils/videoAlarm.ts` 的 `ALERT_TYPE_NAME` 的来源。
 *
 * V2 的报警数据也来自同一个接口 `/api/video/alarms?page=…&sceneCode=`
 * （反编译出的常量），而该接口的行里只有 `deviceNo` / `channelNo`，
 * `/api/video/cameras` 对本项目（P000000076）是 0 条 —— 所以 V2 也只能写死。
 *
 * 校对依据（V2 详情页逐条对齐本项目接口里的同一时刻）：
 *   · `2026-11-17 12:39:06` 安全帽检测 → 通道 `2`，V2 显示「报警地点：材料堆场」；
 *   · `2026-11-17 13:58:24` 安全帽检测 → 通道 `3`，V2 显示「报警地点：安全讲台」。
 * 本项目 `:8085 /api/video/alarms` 里出现的通道只有 2 与 3，所以这两条就是全量。
 *
 * ⚠️ 不要拿慧眼（`/alarms/hjhy`）的 `camera_name` 来填：那套的通道编号是另一套
 * （慧眼 ch2 = 现场大门内、ch3 = 宣讲台），与万方这边不同源，混用会张冠李戴。
 * 也不要拿 V2 的 `MonitorData.json`（CDN）来填：那是 20 个摄像头 + RTSP 地址，
 * 里面没有通道号，且顺序与本项目 `channelNo` 对不上。
 *
 * 换项目 / 加摄像头要改这里；没有映射的通道宁可在界面上写「N号通道」，
 * 也不许编一个地名（现场会照着它去现场找人）。
 */
export const CAM_PLACE: Record<number, string> = {
  2: '材料堆场',
  3: '安全讲台',
}

/** 原 alarmSrc(a)（app.js:261-263）—— 未知来源回退到无人机 */
export function alarmSrcOf(src: Alarm['src']): (typeof ALARM_SRC)[Alarm['src']] {
  return ALARM_SRC[src] ?? ALARM_SRC.drone
}

/*
 * 2026-11 阶段 5 删除：b1/b2/b3Occupied 与 b2FloorCount（三栋楼各层人数）。
 * 人员分布改列 :8084 真实区域台账，人数位显示「—」—— 没有定位接口，
 * 不许拿设计稿的稀疏表顶数字。见 stores/home.ts。
 */

/*
 * 原 qaSteps（验收工序环形图）与 milestones（里程碑时间轴）随 2026-10 版本
 * 同步删除：设计稿把「质量管理」与「进度管理」两个首页模块整块拿掉，
 * 这两个数组再没有消费方。
 */

/**
 * 巡检照片分类（2026-10 版本同步 · 第三批，原 js/app.js:547-554）
 *
 * ⚠️ **2026-11 阶段 8 已删除**。
 *
 * 原先是六个手工分类（项目全景 / 基坑区域 / 作业面 / 施工装备 / 材料堆场 /
 * 现场场布），用来给 17 张写死的静态图分组。那六类是**人工归类**的 ——
 * 服务端不提供分类字段，真实航拍照片进来后无法归类。
 *
 * 现在巡检照片改接 keehang 真实航拍媒体（见 `stores/patrol.ts`），
 * 按拍摄时间倒序铺开，元信息用服务端给的「所属任务 / 拍摄时间 / 文件大小」。
 */

/*
 * 2026-11 阶段 8 删除：patrolCats（六个手工分类）、patrolPhotos（17 张写死的
 * 静态图）、PATROL_SRC（9 个 WebP 路径映射）。
 * 照片墙与航拍层都改接真实媒体，这些常量留着只会被当成兜底数据误用。
 */

/** 原 js/app.js:1401 */
export const hazardKindList = ['安全防护', '文明施工', '用电隐患', '消防通道', '其他']

/**
 * 人员概况四指标 —— **已删除演示值**（2026-11）。
 *
 * 原先这里放 `[160, 40, 76, 47.5]` 四个数字，接口失败时顶上去避免首页出现空数字。
 * 但现场分不清哪个数是接口来的：拿着「项目人数 160」去对账，服务端其实是 352。
 * 现在数值只来自 `GET /bigScreen/BigsHome/personOverall`，取不到显示「—」；
 * 指标的**标签与单位**（不含数值）移到 `stores/overview.ts` 的 `KPI_META`。
 */

/**
 * 今日出勤工种（2026-11 对齐设计稿 gx2 新增，原 app.js renderTradeChart）
 *
 * ⚠️ **没有接口来源，当前页面也不再消费它**：
 * 四套后端（:8081 / 大屏 open / IOT 网关 / 第三方）都没有「按工种统计人数」的
 * 端点，Unity 端也只有客户端枚举 `WorkTypeToEnum`（管理/普工/其它/木工），
 * 没有取数接口。首页这张卡在接入真实数据时换成了「今日分时人数」
 * （`todayPersonHourStat`，真数据）。这份数据留作设计稿参考，不要再当兜底用 ——
 * 它和真实人数对不上，混在一起会误导现场。
 */
/*
 * 2026-11 阶段 5 删除：tradeRows 的 10 行数字。零消费点、无接口来源，
 * 留着只会被后来人误当成兜底数据。
 */

/**
 * 今日班组出勤 —— **已删除演示值**（2026-11）。
 *
 * 原先是 9 个班组的写死数据。真实数据来自 `todayTeamsAtteStat`（现场 3 个班组），
 * 现在接口没数据就显示「暂无班组出勤数据」，不再拿这 9 行顶替 ——
 * 班组名和人数全都不对，比空着更容易被当真。
 */


/* ---------------- 智眸 · 照片分类 ---------------- */

/**
 * 智眸「最新照片」的六个分类（设计稿 app.js:613-619 的 patrolCats）。
 *
 * ## 服务端有没有这个分类？
 *
 * **没有。** 两处都查过：
 *   · keehang 媒体接口 `GET /media/task/job/{id}` 只返回
 *     `name / path / mediaType / url / limitUrl / thumbnail / size / lastModified`；
 *   · 万联后端《数据库设计文档》的媒体文件表（devDroneMedia）字段是
 *     `LinkId / CreatedTime / RecordId / MediaType / Url / LimitUrl / Thumbnail / Name / Size`
 *     —— 没有分类列；
 *   · 航线接口 `/task/list` 里 15 条任务的 `taskType` 全是 `AIRLINE`、
 *     `resourceType` 全是 `AIR_LINE`，也没有「正射 / 三维 / 巡检」这类可用维度。
 *
 * 所以 V2 也拿不到这六类 —— 设计稿那 17 张图是**人工归类**的。要在真实照片上
 * 显示这六类，只能在客户端按**航线名**映射。下面这张表就是这么来的：把现场
 * 真有的 15 条航线逐条登记到六类里（2026-11-16 用 `/task/list` 核对过）。
 *
 * ## 为什么不会再有「未分类」
 *
 * 每张照片必属于某次飞行，只要每条航线都有归属，就不存在落不进六类的照片。
 * 未登记的**新**航线依次走：显式表 → 关键词 → 兜底类。三者必有结果，
 * 所以页面上不需要「未分类」这个按钮。
 */
export interface PatrolCat {
  id: string
  name: string
  /** 未登记的航线按名字兜底（自上而下先命中先得） */
  pattern: RegExp
}

export const PATROL_CATS: readonly PatrolCat[] = [
  // `全场|场区` 曾被写进 pano 规则，但它们描述的是「范围」不是「拍的什么」：
  // 「场区道路巡检」「场区材料堆场」「场区基坑支护」会全部被第一类吃掉。
  { id: 'pano', name: '项目全景', pattern: /全景|鸟瞰|正射|三维|倾斜/ },
  { id: 'pit', name: '基坑区域', pattern: /基坑|坑边|边坡|支护|土方/ },
  { id: 'face', name: '作业面', pattern: /作业面|主体|楼面|外架|悬挑|楼层/ },
  { id: 'equip', name: '施工装备', pattern: /塔机|塔吊|电梯|装备|机械|环绕/ },
  { id: 'yard', name: '材料堆场', pattern: /堆场|材料|钢筋|模板|加工棚/ },
  { id: 'layout', name: '现场场布', pattern: /场布|道路|围挡|配电|大门|临建|巡检|拍照|定点/ },
]

/**
 * 现场真实航线 → 分类的**显式登记表**（2026-11-16 按 `/task/list` 的 15 条航线逐条对过）。
 *
 * 名字必须与航线名完全一致。现场新开航线时在这里加一行即可，不用改别的代码；
 * 忘了加也不会丢照片 —— 会走关键词兜底。
 */
export const PATROL_TASK_CAT: Readonly<Record<string, string>> = {
  // 俯视全场：全景 / 正射 / 三维建模，画面都是整片场地
  测试: 'pano',
  测试全景: 'pano',
  '向阳村-全景': 'pano',
  '向阳村-正射': 'pano',
  '向阳村-三维（飞前请检查）': 'pano',
  '向阳村-三维（新）': 'pano',
  '向阳村-三维（加密）': 'pano',
  // 土方开挖 → 基坑
  '向阳村-土方1': 'pit',
  // 塔吊巡查
  '向阳村-塔吊定点': 'equip',
  // 现场布设与巡检：道路 / 配电箱 / 各区定点 / 安全巡检
  '向阳村-道路垃圾和杂草生长': 'layout',
  '向阳村-配电箱定点拍照': 'layout',
  '向阳村-全局定点拍照': 'layout',
  '向阳村-分区定点拍照': 'layout',
  '向阳村-安全巡检': 'layout',
  // 视频航线（媒体是 mp4，不进照片墙；登记着以免哪天截图进来掉到兜底）
  '向阳村-环绕视频': 'equip',
}

/**
 * 兜底分类：显式表和关键词都没命中的新航线归这里。
 *
 * 选「现场场布」是因为它语义最宽（现场各处的定点拍摄都算）。卡片上仍然写
 * **真实航线名**，所以归类只是筛选维度，不会让人误以为这条航线叫「现场场布」。
 */
const PATROL_CAT_FALLBACK = 'layout'

/** 航线名 → 六个分类 id 之一（一定命中，所以没有「未分类」） */
export function catOfTask(taskName: string): string {
  const name = String(taskName ?? '').trim()
  const fixed = PATROL_TASK_CAT[name]
  if (fixed) return fixed
  for (const c of PATROL_CATS) if (c.pattern.test(name)) return c.id
  return PATROL_CAT_FALLBACK
}
