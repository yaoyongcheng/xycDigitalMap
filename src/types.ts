/**
 * 领域类型定义
 *
 * 全部依据 js/app.js（原版基线）中的数据字面量结构反推，
 * 字段名与顺序保持原样，便于后续接入后端接口时逐字段对齐。
 */

/** 顶部 tab 标识 */
export type TabId = 'home' | 'work' | 'msg' | 'mine'

/**
 * 首页三大模块（2026-10 版本同步 · 第三批：4 → 3）
 *
 * 设计稿把原来的「安全 / 质量 / 进度 / 装备」四个入口收成三个：
 *   safety  智眸（AI 识别 · 报警与人员）
 *   patrol  智巡（无人机 / 监控巡检照片）
 *   equip   智控（设备）
 * 质量管理与进度管理两个面板被整块删掉，连带 qaSteps / milestones 两份数据。
 * 原 data-mod 键沿用了 progress 指代智巡，这里改名为 patrol —— 只是 DOM 属性，
 * 没有对外契约，照抄只会让后来人以为它还是「进度」。
 */
export type HomeMod = 'safety' | 'patrol' | 'equip'

/** 监控分组（2026-11 阶段 5：真实点位只有「视频监控」一组） */
export type CamGroup = '出入口' | '场内' | '塔吊' | '视频监控'

/**
 * 监控点位。
 *
 * 2026-11 阶段 5 起由 `:8085` 视频报警里的 `channelNo` 去重派生，
 * 不再是 18 条写死的点位名。`img` 是「该通道最近一次报警抓拍」，
 * 需要异步从截图接口取，取不到就是空串 —— 不再用同一张示意图顶替。
 */
export interface Camera {
  id: string
  name: string
  group: CamGroup
  /** 服务端通道号；派生点位时带在 id 里也解析得出来，这里留结构化值 */
  channelNo?: number
  img: string
  pos: string
}

/** 预警日归属：当日 / 历史 */
export type AlarmDay = 'today' | 'hist'

/**
 * 预警在地图上的标注坐标（2026-10 版本同步 · 第二批）
 *
 * 相对底图宽高的百分比 [x, y]；第三位 'left' 表示标签翻到点的左侧 ——
 * 靠近右边界时标签会顶出画面，必须反着排。
 * 三维图与二维图是两张比例不同的底图（1024×709 / 1024×747），
 * 同一个预警在两图上各有一组坐标，不能共用。
 */
export type AlarmSpot = [number, number] | [number, number, 'left']

/** 巡检预警（对应原 inspectAlarms 数组，8 条） */
/**
 * 预警采集来源（2026-11 设计稿 gx2 版，原 app.js:255-259）。
 * 来源是中性的元信息，用三色徽标区分采集方式而不是严重程度。
 */
export type AlarmSrc = 'drone' | 'cam' | 'snap'

export interface Alarm {
  id: string
  day: AlarmDay
  /** 采集来源，决定徽标配色与详情页的来源信息 */
  src: AlarmSrc
  type: string
  title: string
  desc: string
  img: string
  /** 相对时间文案，如「1分钟前」 */
  rel: string
  /** 绝对时间，'YYYY-MM-DD HH:mm:ss' */
  at: string
  /** 经纬度，'lng,lat' */
  geo: string
  /**
   * 视频报警的服务端通道号（阶段 5：监控点位按它分组）。
   * 只有 `:8085` 的真实数据带；测试夹具可以不填，消费方要能容忍缺失。
   */
  channelNo?: number
  /**
   * 服务端已读/处理状态（`handleStatus`）：0 = 未读/待处理，1 = 已读/已处理。
   *
   * 这是**唯一权威**的已读来源（参考 Unity 端 `AIAlarmMessage.AlarmStatus` ←
   * 接口 `handleStatus`，消息列表据此显示未读红点，`PATCH .../status` 把它置 1）。
   * 服务端持久化，刷新不丢 —— 早先靠前端本地 Set 记已读，刷新即归零，是错的。
   * 测试夹具可以不填，消费方按「缺省未读」处理。
   */
  handleStatus?: number
  /** 三维地图上的标注（无则不在三维图上撒点） */
  pin?: AlarmSpot
  /** 二维地图上的标注 */
  flat?: AlarmSpot
}

/**
 * 消息列表项。
 *
 * 2026-11 阶段 5 起由真实报警派生，一条报警一条消息，`id` 用来做已读与
 * 跳详情（原按 `kind` 标记已读，同类消息会被一次性全清）。
 */
export interface Message {
  id: string
  kind: 'people' | 'inspect' | 'video'
  title: string
  desc: string
  time: string
  unread: number
}

/** 「我的」菜单项 */
export interface MineMenu {
  id: string
  name: string
}

/**
 * 质量类目（对应原 qaCats 数组）
 */
export interface QaCat {
  name: string
  last: number
  now: number
}

/**
 * 巡检照片分类（对应原 patrolCats）
 *
 * 与报警的 type 字段不同，分类是固定枚举：照片按「看哪儿」分，
 * 而不是按「发现了什么问题」分。
 */
export interface PatrolCat {
  id: string
  name: string
}

/** 巡检照片来源：无人机航拍 / 视频监控抓拍 */
export type PatrolSrc = 'drone' | 'cam'

/**
 * 巡检照片（对应原 patrolPhotos，17 张）
 *
 * pos 是取景变体：同一张底图取不同局部当缩略图（fit 为整图完整显示），
 * 取值对应 app.css 里 .p-l / .p-r / .p-t … 的 object-position。
 */
export interface PatrolPhoto {
  id: string
  cat: string
  name: string
  src: PatrolSrc
  img: string
  pos: 'fit' | 'p-l' | 'p-r' | 'p-t' | 'p-b' | 'p-tl' | 'p-tr' | 'p-bl' | 'p-br' | 'p-c'
  /** 'HH:mm'，列表按它倒序 */
  time: string
}

/** 设备下辖单元（对应原 siteEquip[].units[]） */
export interface EquipUnit {
  name: string
  on: boolean
  /** [指标名, 数值] 二元组 */
  rows: [string, string][]
}

/**
 * 设备（对应原 siteEquip 数组。2026-11 设计稿 gx2 版是 9 条：
 * 塔机/电梯/无人机/爬架 + 5 类机器人）
 *
 * 2026-11 第二轮：value/metric 改为可选 —— 首页四卡改由设备台账接口派生，
 * 塔机与电梯除了「在线 x/y」还有一个真实字段（高度）可放，无人机没有数值，
 * 这时不该硬塞一个占位符号进设计稿的数值位。
 *
 * 2026-11 第三轮（对齐 gx2 第九卡）：新增 `linked` 与 `stats` 的真正落地 ——
 * 5 类机器人没有任何台账记录与接口，卡片只能渲染成静态入口（不可点）。
 */
export interface Equip {
  id: string
  name: string
  value?: string
  metric?: string
  ico: string
  /** 有独立详情页的设备（2026-11 设计稿：四类全部可下钻） */
  page?: 'crane' | 'lift' | 'uav' | 'climb'
  /**
   * 卡片是否有真实数据源（台账 / 接口）。
   *
   * `false` = 静态入口卡（见 utils/deviceLedger.ts: ROBOT_CARDS）：
   * 没有台账、也没有任何接口能给出台数与作业次数，所以整卡不可点
   * （用 div 而不是 button，避免误导键盘用户）、不出右侧箭头、
   * 数值位只放「—」。**绝不写 0 次顶替「没有数据」。**
   */
  linked?: boolean
  /**
   * 卡片标题右侧状态点的**显式**取值，优先于由 `units` 派生的
   * `equipCount().st`。
   *
   * 只有静态卡用它：机器人没有台账，`units` 恒为空 → 派生出来是 'off'
   * （灰点「离线」），而现场这几类机器人是常驻在线的。2026-11-12 用户要求
   * 「机器人默认在线，名称旁边加小绿点」，故显式置 'on'。
   */
  dot?: 'on' | 'off' | 'warn'
  /**
   * 卡片数值位的多格指标（塔机：今日吊重 + 今日吊次；电梯：今日运行时长）。
   * `value` 是「数字 + 单位」的合并文本（如 `1.87t`），模板拆出单位套
   * `.eq-stat-unit` 单独排（设计稿 app.js:1013 的做法）。
   */
  stats?: { value: string; metric: string }[]
  /** 无人机专属：作业任务 x/y（真实来源见 stores/uav.ts 的 doneCount / totalCount） */
  jobs?: { done: number; total: number }
  units: EquipUnit[]
}

/**
 * 塔机一次工作循环（= 一次吊次）。
 *
 * 三个字段都可能为 `null`：现场报文里时间/重量存在空串与缺字段，
 * 解析层不猜值 —— 调用方据此决定「合计里跳过」还是「整格显示 —」。
 */
export interface CraneWorkCycle {
  /** 起吊开始时刻（ms）；解析不出来为 null */
  start: number | null
  /** 卸吊结束时刻（ms）；解析不出来为 null */
  end: number | null
  /** 本次循环最大吊重（t）；解析不出来为 null */
  weight: number | null
  /**
   * 循环时长（秒）。
   *
   * 服务端直接给 `duration`（实测就是秒，如 655）；缺字段时用
   * `end - start` 兜底。两样都没有为 null —— 不要让作业报表把
   * 「没时长」算成「0 秒的活」。
   */
  duration: number | null
  /** 作业类型（服务端 `type`：`上料` / `下料`）；空串 = 服务端没给 */
  type: string
}

/**
 * 塔机当日作业指标（由工作循环汇总而来）。
 *
 * `trips` 为 0 是**有效结论**（接口通了、当天确实没吊）；
 * `weight` 为 null 表示「一次循环都没拿到重量」→ 卡片显示「—」，
 * 不能用 0.00t 冒充。
 */
export interface CraneDayStats {
  /** 今日吊次（工作循环条数） */
  trips: number
  /** 今日吊重合计（t）；没有任何有效重量时为 null */
  weight: number | null
}

/** 人员分布节点（对应原 peopleTree） */
export interface PeopleNode {
  id: string
  name: string
  /** 人数；`null` = 没有定位数据源（不许拿 0 冒充「没人」） */
  count: number | null
  children?: PeopleNode[]
}

/** 日历单元格 */
export interface CalCell {
  /** 日号，空串表示补位空格 */
  day: string
  /** 是否为当前选中日 */
  on: boolean
  /** 是否禁用（超出可选范围） */
  off: boolean
}

/* ---------------- 设备详情（2026-10 版本同步 · 第四批） ---------------- */

/** 设备类型：智能塔机 / 智能电梯。两者的页面结构完全相同，差异在数据与指标 */
export type DeviceKind = 'crane' | 'lift'

/** 设备指标定义：五张趋势图与仪表共用（key 同时是 data 里的字段名） */
export interface DeviceMetric {
  key: string
  name: string
  unit: string
  /** 小数位：0 / 1 / 2 */
  dp: number
}

/** 设备某一天的数据 */
export interface DeviceDay {
  /** 'MM-DD' */
  date: string
  vals: Record<string, number>
}

/** 一台设备（塔机与电梯归一化后的结构） */
export interface DeviceUnit {
  id: string
  /** 页签短标签：1#塔机 / 1-1 */
  tab: string
  name: string
  status: string
  /** 卡片上四个格子（已格式化的文本） */
  cells: [string, string][]
  /** 设备信息明细（已格式化的文本） */
  info: [string, string][]
  /** 工作中的塔机才有：当前吊重 + 负荷百分比 */
  live?: { value: string; pct: number }
  /** 昨日报警次数（塔机有，电梯没有）；日报里的报警角标用它 */
  alarms?: string
  /**
   * 当日指标与近 7 日历史。
   *
   * 2026-11 第二轮起这两个字段**可能是空对象 / 空数组**：作业指标来自 tsdb
   * 实时数据接口，而该接口在当前部署上 404（详见 docs/api-migration.md），
   * 台账接口只有设备的静态属性。页面在空数据时显示空态，不再用编造的曲线填充。
   */
  today: Record<string, number>
  history: DeviceDay[]
}

/** 地图点位类别：摄像头 / 塔吊 / 楼栋 */
export type MapPointKind = 'cam' | 'crane' | 'building'

/**
 * 地图撒点（交互地图层新增）
 *
 * x/y 为相对底图宽高的百分比（0-100），与底图内容绑定，
 * 与容器尺寸、缩放级别无关 —— 缩放/平移由 MapViewer 统一处理。
 */
export interface MapPoint {
  id: string
  kind: MapPointKind
  name: string
  x: number
  y: number
  /** cam / crane 点位关联的监控 id（cameras 中的点位） */
  camId?: string
}

/**
 * 报警撒点（2026-10 版本同步 · 第二批）
 *
 * 与 MapPoint 分开建模而不是再加一个 kind：两者的视觉（红色脉冲点 + 标题
 * 药丸）、点击去向（预警详情 vs 监控/楼栋卡）都不同，混在一个联合类型里
 * 会让 MapViewer 的渲染与事件分支挤成一团。
 */
export interface MapAlarm {
  /** 对应 Alarm.id */
  id: string
  /** 药丸上显示的文字（取 Alarm.title） */
  title: string
  x: number
  y: number
  /** 标签翻到点的左侧（靠近右边界时用） */
  left?: boolean
}

/* ========== 智能爬架传感器（2026-11 第四轮） ========== */

/**
 * 爬架传感器读数（一个机位一行）。
 *
 * 数据源是 CDN 静态 JSON（`{host}/CDN/PC/ScaffoldData.json`），三个读数是
 * **带单位后缀的字符串**（`'3.13mm'` / `'0.00吨'`），解析在 utils/scaffold.ts。
 */
export interface ScaffoldSensor {
  /** 机位名，服务端形如 '1#机位' */
  item: string
  /** 左右倾斜 mm；解析不出来为 null */
  lrTilt: number | null
  /** 前后倾斜 mm；解析不出来为 null */
  fbTilt: number | null
  /** 载荷 吨；解析不出来为 null */
  load: number | null
  /** 服务端更新时间原文 '2026-11-07 14:02:49' */
  time: string
}

/** 爬架的三个读数指标 */
export type ScaffoldMetric = 'lrTilt' | 'fbTilt' | 'load'

/**
 * 单个指标的汇总（全场最不利机位）。
 *
 * `value === null` 表示一个可用读数都没有 —— 此时 `over` 必须是 `false`：
 * 「不知道」不能表达成「正常」，也不能表达成「超限」。
 */
export interface ScaffoldCell {
  key: ScaffoldMetric
  /** '左右倾斜' | '前后倾斜' | '载荷' */
  label: string
  /** 'mm' | '吨' */
  unit: string
  /** 阈值（mm 或 吨），来自 V2 客户端硬编码 */
  limit: number
  /** 最不利读数（绝对值最大）；没有可用读数时为 null */
  value: number | null
  /** 最不利读数落在哪个机位；value 为 null 时是空串 */
  item: string
  /** 是否超限（Math.abs(value) > limit）；value 为 null 时为 false */
  over: boolean
  /**
   * 该指标**在阈值内**的机位数（卡片三格的分子，绿色）。
   *
   * 与 `total` 一起构成「正常 / 有读数」的计数口径，取代早先「只报最不利
   * 读数」的写法 —— 现场看卡片第一眼要的是「有多少台正常」，具体哪台不对
   * 由说明行（`firstOverLabel`）报。
   */
  normal: number
  /**
   * 该指标**有读数**的机位数（分母）。
   *
   * 不是机位总数：某台机位这一项没上报时，它既不算正常也不算异常，
   * 让它留在分母里会把「没数据」读成「不正常」。
   */
  total: number
}

/** 爬架全场汇总 */
export interface ScaffoldSummary {
  /** 有效机位数 */
  count: number
  /** 最新更新时间原文；没有则为空串 */
  updatedAt: string
  cells: ScaffoldCell[]
  /** 至少一个指标超限的机位数（按机位去重，不是指标数） */
  overCount: number
}
