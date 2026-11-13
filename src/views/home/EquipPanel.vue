<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import CountUp from '@/components/ui/CountUp.vue'
import DonutTouch from '@/components/ui/DonutTouch.vue'
import Skel from '@/components/ui/Skel.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import type { IconName } from '@/data/icons'
import { craneSnOf } from '@/data/craneSn'
import { LIFT_CAGES } from '@/data/liftSn'
import { useAuthStore } from '@/stores/auth'
import { useCraneRealtimeStore } from '@/stores/craneRealtime'
import { useDeviceLedgerStore } from '@/stores/deviceLedger'
import { useHomeStore } from '@/stores/home'
import { useLiftStore } from '@/stores/lift'
import { useScaffoldStore } from '@/stores/scaffold'
import { useSubpageStore } from '@/stores/subpage'
import { useUavStore } from '@/stores/uav'
import { firstOverLabel, timeHm } from '@/utils/scaffold'
import { ROBOT_CARDS, unitNo } from '@/utils/deviceLedger'
import { DASH, formatRuntime } from '@/utils/lift'
import { useSlowLoading } from '@/utils/slowLoading'
import type { Equip } from '@/types'

/**
 * 首页 · 装备管控面板（设计稿 gx2 版 app.js:845-1064 renderEquip 的落地）
 *
 * ## 卡片结构（设计稿）
 *
 * 横向三段：左 64px 设备立绘（eq-ico）+ 中 eq-main（名称行 eq-hd + 数值行
 * eq-vals）+ 右圆形箭头（eq-more）。四种形态：
 *   ① 塔机（is-crane）：在线 x/y + 今日吊重 + 今日吊次（三格，gap 16）
 *   ② 电梯：在线 x/y + 今日运行时长；**无人机：只有一格「今日作业次数」**
 *      （用户 2026-11-13 要求，不再并排念「设备状态 0/1」——那是台账登记态，
 *      与「今天飞了几架次」无关，两格并排还会被读成「1 架里 0 架在线」）。
 *      电梯那格**常驻**：取不到 IOT 数据就是「—」占位（设计稿是两列，
 *      撤列会让卡宽跳动），不拿台账字段冒充。
 *   ③ 爬架（is-climb）：纵向两段 —— 上段是普通卡+三格传感器，下段可挂超限警示
 *   ④ 机器人（无 page）：静态卡，**不是 button**，一格「今日作业次数」
 *      （值取 V2 预制体预置的模拟值，见 `data/robotStats.ts`）
 *
 * ## 三轮数据收口的结论（决定了哪些格子有数、哪些只能空着）
 *
 * · 台数与在线数：`:8084` 台账（`stores/deviceLedger.ts`）
 * · 塔机「今日吊重 / 今日吊次」：塔机工作循环接口（`api/towerCrane.ts`），
 *   前提是台账能给出 sn —— 现场没有，所以塔机卡当前退回「最大高度」一格；
 *   等 sn 补上，`ledger.craneDay` 有值就自动换成两格，模板不用改。
 * · 电梯「在线 x/y」与「今日运行时长」：IOT 网关（`api/lift.ts`）。
 *   在线走 `EVENT_ON_OFF`，时长来自 `EVENT_WORKDATA` 的**首尾跨度**——
 *   与 V2 `FetchWorkCycleAsync` 同口径（含停机，理由见 `utils/lift.ts`）。
 *   网关没数据的台次出「—」，不再拿台账里的「最大高度」顶替作业量。
 * · 无人机「今日作业次数」：keehang `/dashboard/task/list/record` 的
 *   `finishedCount`（已完成），与子页「任务管理」那格同值同源 —— 用户
 *   2026-11-13 15:24 明确 V2 卡片展示的就是「已完成」。
 *   首页在挂载 800ms 后补拉一次（`uav.loadStat()`，不抢首屏带宽；失败静默 +
 *   60s 冷却）。取不到写「—」，不写 0 —— 那会替它宣布「今天一架次都没飞」。
 * · 爬架三格传感器（左右倾斜 / 前后倾斜 / 载荷）：四套后端都没有接口，
 *   三格显示「—」并给「数据未接入」说明；超限警示行（eq-alert）没有数据
 *   可判，整行不渲染 —— 编一个「35/36 正常」比空着更危险。
 *
 * 5 类机器人是静态入口卡：没有台账、没有接口，卡片用 `div` 渲染
 * （`button` 会向键盘用户承诺「按下去有事发生」）。作业次数取 V2 装备管理
 * 预制体里预置的那组值（模拟值，`data/robotStats.ts` 有逐节点取证记录），
 * 但没有「在线 x/y」格 —— 台账里没有这些设备，任何 x/y 都是编的。
 * 取不到值时才退回「—」。
 *
 * ## 页面边界
 *
 * 整页只有「统计两卡 + 9 张设备卡」两段，与设计稿 `renderEquip` 一致。
 * 2026-11 曾在此追加过「全部设备运行状态」逐台清单，已按用户要求移除 ——
 * 逐台状态归各设备详情页，首页不再把台账重复一遍；`ledger.allUnits` 随之删除，
 * 不要为了复用再把它加回来。
 *
 * ## 无障碍
 *
 * 设计稿每张卡都有逐格报读的 aria-label（app.js:982-990）。这里按**真实**
 * 数据拼：没有的格子不报。机器人卡的作业次数取自 V2 预制体的预置值（模拟值），
 * 所以念的时候必须带「示意值」—— 读屏用户看不到「不可点、无在线格」这些线索，
 * 只念一个「今日作业次数 5 次」等于报了个假数。
 */
const home = useHomeStore()
const ledger = useDeviceLedgerStore()
const scaf = useScaffoldStore()
const auth = useAuthStore()
const subpage = useSubpageStore()
const uav = useUavStore()
const crane = useCraneRealtimeStore()
const lift = useLiftStore()

/**
 * 面板挂载即取一次 —— 也是「切回智控」的刷新入口。
 *
 * 首页切换三个模块标签时面板是真的卸载再挂载（`HomeSheet` 的 `.home-panels`
 * 带 `:key="home.homeMod"`），所以这里必须走 `refresh()`：在线状态、塔机今日
 * 吊次/吊重、爬架读数都会变，切回来看到的得是此刻的数，而不是上次进首页那一批。
 * （`load()` 有「已 ok 就跳过」的缓存，只适合首次进入。）
 *
 * 传感器走 public CDN（免登录），**不等登录态**：台账要 Bearer，传感器不要，
 * 所以两条取数互不牵制 —— 台账接口挂了，爬架读数照样能出来。
 * 失败冷却由各自的 `refresh` 内部控制（弱网下连点标签不反复打请求）。
 */
/** 无人机统计的延后取数句柄（卸载时清掉，别让定时器在别的页面里跑） */
let statTimer: number | null = null

onMounted(() => {
  if (auth.token) void ledger.refresh(auth.token)
  void scaf.refresh()
  // 电梯走 IOT（项目级 ak/sk，与用户登录态无关），所以不等 token
  void lift.refresh()
  // 电梯卡上的「累计运行时间 / 在线设备」要跟着变 —— 按名字登记，离开面板即停
  lift.startLive('equip')
  /**
   * 无人机卡只有一格「今日作业次数」，要一次 keehang 统计请求（CAS 两步 + 1 个 GET）。
   *
   * **延后 800ms**：别与台账/塔机/爬架那几路抢首屏带宽（现场是手机 4G）。
   * 失败静默 + 60s 冷却由 `loadStat` 内部管；取不到时卡片就是「—」，
   * 不写 0（那会替它宣布「今天一架次都没飞」）。
   */
  statTimer = window.setTimeout(() => void uav.loadStat(), 800)
})

/** 登录成功后补拉（登录页盖在首页上，面板不卸载，onMounted 不会重跑） */
watch(
  () => auth.token,
  (t) => {
    if (t) void ledger.load(t, true)
  },
)

/**
 * 塔机实时通道订阅 —— 只为把塔机卡的「在线设备」对齐子页面的口径。
 *
 * 子页面（`views/sub/DevicePage.vue`）的塔机状态走 V2 `GetTowerState` 四态
 * （离线 / 待机 / 工作中 / 正在吊装），卡片上写「离线」才算不在线；而台账的
 * `online_status` 只说这台设备在平台登记为在线 —— 传统塔机5 台账是在线的，
 * 但它没有平台编号、也就没有实时工况，子页面里它显示的是「离线」。
 *
 * 两处用两套口径就会出现「首页 4/4、点进去只有 3 台非离线」，用户 2026-11-13
 * 明确要求首页按子页面读。所以这里开一条与详情页同一个 store 的通道，
 * 引用计数由 store 管（详情页也开着时不会重复连）。
 *
 * 未登录时卡片整块是登录引导，没有数字要显示 → 不订阅，省现场流量。
 * 通道没通（线上 HTTPS 没有 WS 反代）时 `stateOf` 返回 null，由 `countOf`
 * 回落到台账状态 —— 不把「我们看不到」写成「设备离线」。
 */
const wantRealtime = computed(() => auth.isLoggedIn)
let subscribed = false
watch(
  wantRealtime,
  (want) => {
    if (want === subscribed) return
    subscribed = want
    if (want) crane.open()
    else crane.close()
  },
  { immediate: true },
)
onUnmounted(() => {
  // 放最前面：下面那条 `if (!subscribed) return` 会提前返回，清理不能它带走
  if (statTimer !== null) window.clearTimeout(statTimer)
  lift.stopLive('equip')
  if (!subscribed) return
  subscribed = false
  crane.close()
})

/**
 * 某类设备的「在线 x / 共 y」。
 *
 * 三类三种口径：
 * · **塔机**（台账 4 台）：状态不是「离线」就算在线（待机 / 工作中 / 正在吊装
 *   都是活的）。`stateOf` 返回 null = 通道判断不了，这一台回落台账 `online_status`。
 * · **电梯**（IOT 4 个轿厢）：逐笼判在线，查不到记录按离线（V2 `IsOnline` 口径）。
 *   **连不上也按离线**：网关没应答时不去翻台账的登记态 —— 那是平台登记信息、
 *   不随设备实时变化，拿它顶替会画出「4/4 在线」而每一格都是「—」。用户
 *   2026-11-13 明确要求「电梯连不上就默认离线」。
 *   分母是**轿厢数**，不是台账行数 —— 台账 2 行是「楼」，V2 与现场都是按笼看。
 * · **其余**（爬架 / 无人机）：台账 `online_status`。
 *
 * 塔机与电梯的分母都不写死：台账多一台 / 场景多一个笼，数字跟着变。
 */
function countOf(d: Equip): { on: number; total: number; st: 'off' | 'warn' | 'on' } {
  if (d.id === 'lift') {
    const total = LIFT_CAGES.length
    // 没有在线数据 = 连不上 → 全部离线（`isOnline` 查不到即 false，V2 口径）
    const on = LIFT_CAGES.filter((c) => lift.isOnline(c.sn)).length
    return { on, total, st: on <= 0 ? 'off' : on < total ? 'warn' : 'on' }
  }
  if (d.id !== 'crane') return home.equipCount(d)
  const total = d.units.length
  let on = 0
  for (const u of d.units) {
    const st = crane.stateOf(craneSnOf(unitNo(u.name)))
    if (st === null ? u.on : st !== '离线') on += 1
  }
  return { on, total, st: on <= 0 ? 'off' : on < total ? 'warn' : 'on' }
}

/** 详情页路由（原 data-crane/lift/uav/climb） */
function pageOf(d: Equip): string | undefined {
  // 返回 undefined 而不是空串：空串会照样写出 data-page="" ，
  // 让「有详情页的卡片」这条选择器把 5 张机器人卡也数进去
  return d.page ?? undefined
}

/**
 * 慢请求才显示骨架（对齐支付宝的加载观感）。
 *
 * 台账是本页唯一的取数点，接口在局域网里通常 100~200ms 就回来了 —— 那种情况
 * 骨架连一帧都不该出现，否则就是「闪一下灰条又变内容」。超过 SKEL_DELAY 才
 * 把灰条淡入，数据一到立刻撤。
 */
const showSkel = useSlowLoading(() => !ledger.hasData && ledger.state === 'loading')

function onCard(d: Equip): void {
  if (d.page === 'uav') subpage.openUav()
  else if (d.page === 'climb') subpage.openClimb()
  else if (d.page) subpage.openDevice(d.page)
}

/**
 * 设备立绘：public/img 下的 256px 原图（原 equipPic，已转 webp）。
 *
 * 五类机器人的立绘取自设计稿 `img/eq-{grind,plaster,survey,spray,screed}.jpg`
 * （原 1024×1024，按既有 4 张立绘的规格缩到 256×256、q86 转 webp，5~7 KB/张），
 * 不再用 `robot` 通用剪影 —— 五台设备长得完全不同，一张剪影分不出来。
 */
const ICO_IMG: Record<string, string> = {
  crane: 'img/eq-crane.webp',
  lift: 'img/eq-lift.webp',
  drone: 'img/eq-drone.webp',
  climb: 'img/eq-climb.webp',
  grind: 'img/eq-grind.webp',
  plaster: 'img/eq-plaster.webp',
  survey: 'img/eq-survey.webp',
  spray: 'img/eq-spray.webp',
  screed: 'img/eq-screed.webp',
}

/** 立绘加载不出来时的结构化图标兜底（键与 ICO_IMG 对齐） */
const ICO_ICON: Record<string, IconName> = {
  crane: 'dev-crane',
  lift: 'dev-lift',
  drone: 'drone',
  climb: 'eq-climb',
  grind: 'robot',
  plaster: 'robot',
  survey: 'robot',
  spray: 'robot',
  screed: 'robot',
}

const icoFailed = ref<Record<string, boolean>>({})

/** 键用 d.ico（'crane' / 'robot' …），不按 id —— 5 类机器人共用一个图片槽位 */
function icoImg(d: Equip): string | undefined {
  return ICO_IMG[d.ico]
}

function icoIcon(d: Equip): IconName {
  // 'drone' 图标在图标表里是白描边版（深色卡片用），这里同样吃 currentColor
  return ICO_ICON[d.ico] ?? 'robot'
}

function onIcoError(d: Equip): void {
  icoFailed.value[d.ico] = true
}

/** 是否爬架形态（纵向两段 + 三格传感器） */
function isClimb(d: Equip): boolean {
  return d.id === 'climb'
}

/** 数值行的格子：串行拼装「在线 x/y」+ `stats`（没有 stats 就退回 value/metric） */
interface CardCell {
  /** 数值文本（已格式化，单位另拆） */
  value: string
  /** 数字后的单位（'t' / '次' / 'm'），没有单位就是空串 */
  unit: string
  metric: string
  /** 是否是「在线 x/y」这一格（绿色数字 + 斜杠总数） */
  online?: boolean
  /** 在线格的分子分母 */
  on?: number
  total?: number
}

/** '1.87t' / '26次' / '—' → { value:'1.87', unit:'t' }（设计稿 app.js:1010 的正则） */
function splitUnit(text: string): { value: string; unit: string } {
  const m = /^([\d.]+)(.*)$/.exec(text)
  if (!m || !m[2]) return { value: text, unit: '' }
  return { value: m[1], unit: m[2].trim() }
}

/**
 * 一张卡的数值格。
 *
 * 爬架走专门的三格（见 climbCells），这里只处理另外三类 + 机器人：
 *   · linked：先放「在线 x/y」，再放 stats（塔机的两格）或 value/metric（高度）
 *   · 无人机：作业任务 x/y —— 只有 uav store 真的取过数（total > 0）才给这一格
 *   · 机器人（!linked）：一格「今日作业次数」，值取自 V2 预制体的预置文本，
 *     没有在线格（0/0 会被读成「一台都没有」）。取不到时退回「—」
 */
function cellsOf(d: Equip): CardCell[] {
  const c = countOf(d)
  const out: CardCell[] = []

  if (!d.linked) {
    // 机器人卡：`value` 是「5次」这种「数字 + 单位」的合体文本，与塔机卡同法拆单位，
    // 「次」走 .eq-stat-unit 排小字（V2 预制体里也是 `<size=24>5</size></text>` 这种大小搭配）
    const { value, unit } = splitUnit(d.value ?? '—')
    return [{ value, unit, metric: d.metric ?? '' }]
  }

  /**
   * 无人机：只有一格「今日作业次数」（用户 2026-11-13 要求）。
   *
   * 值取统计接口的 **`finishedCount`（已完成）** —— 用户 15:24 明确：V2 卡片
   * 展示的就是子页「任务管理」里那格「已完成」（截图 15 / **11** / 0 圈的是 11），
   * 不是「今日任务」15。两者差的是「已排班但还没飞」的 4 条，那是计划不是作业。
   *
   * 不再念「设备状态 0/1」——那是台账登记态，与「今天飞了几架次」无关，
   * 两格并排还会被读成「1 架里 0 架在线」。在线与否由标题旁的状态点表达。
   *
   * 取不到就是「—」：`taskDone` 为 null 表示统计接口没回来，
   * 写 0 等于替它宣布「今天一架次都没飞」。
   */
  if (d.id === 'drone') {
    const n = uav.taskDone
    return [{ value: n === null ? DASH : String(n), unit: n === null ? '' : '次', metric: '今日作业次数' }]
  }

  out.push({
    value: '',
    unit: '',
    metric: '在线设备',
    online: true,
    on: c.on,
    total: c.total,
  })

  if (d.stats?.length) {
    for (const s of d.stats) {
      const { value, unit } = splitUnit(s.value)
      out.push({ value, unit, metric: s.metric })
    }
    return out
  }

  // 无人机在上面已经单独返回，走不到这里

  // 电梯：那一格是「今日运行时长」（IOT 今日工作循环，**V2 口径：首尾跨度**）。
  // **整格常驻**：设计稿的卡是「在线 x/y + 时长」两列，取不到时用「—」占位而不是
  // 把列撤掉 —— 少一列会让卡片宽度跳变，而且「这一格本来有内容、只是现在没数」
  // 这个信息也丢了。绝不拿台账的「最大高度」冒充作业量。
  //
  // 标签比设计稿多两个字（稿上是「累计运行时间」）：那是**今日**的量，写「累计」
  // 不带日期任谁都会读成「出厂至今一共跑了多久」，而值只有一天 —— 标签在骗人。
  // 字数与原来相同，不撑格、不折行（折行会顶高卡片，刷新时整页跟着跳）。
  // 卡片与弹层都不标口径（含停机）：与 V2 对照时多一句反而显得两边不一样。
  if (d.id === 'lift') {
    const sec = lift.totalSeconds
    const { value, unit } = splitUnit(sec === null ? DASH : formatRuntime(sec))
    out.push({ value, unit, metric: '今日运行时长' })
    return out
  }

  // 其余（爬架的兜底）：台账里真有那个字段才渲染
  if (d.value) {
    const { value, unit } = splitUnit(d.value)
    out.push({ value, unit, metric: d.metric ?? '' })
  }
  return out
}

/**
 * 爬架三格（设计稿 `.eq-card.is-climb .eq-vals`）
 *
 * 读数来自 `stores/scaffold.ts` → CDN `ScaffoldData.json`（38 个机位真实读数），
 * 每格按 V2 `Evaluate` 的口径（`Math.Abs(v) > 阈值`，倾斜 60mm / 载荷 5.0 吨）
 * 数出**正常机位数 / 有读数的机位数**，形状与设计稿一致：`37/38`。
 *
 * 为什么格子只放计数、不放读数：卡片一眼要回答的是「有多少台正常」，
 * 具体哪台越了多少，由下面那行说明（`climbNote` → `firstOverLabel`）报，
 * 两处不重复。计数为 0（一个读数都没取到）时整格显示「—」，
 * **不写 0/0** —— 「没数据」不是「一台都不正常」。
 */
interface ClimbCell {
  metric: string
  /** 阈值内的机位数（绿色） */
  normal: number
  /** 有该指标读数的机位数（分母） */
  total: number
}

const climbCells = computed<ClimbCell[]>(() =>
  scaf.summary.cells.map((c) => ({ metric: c.label, normal: c.normal, total: c.total })),
)

/** 爬架在线数（在线信息仍然是真的，放进说明行而不是挤第四格） */
const climbOnline = computed(() => {
  const d = home.siteEquip.find((x) => x.id === 'climb')
  return d ? countOf(d) : { on: 0, total: 0, st: 'off' as const }
})

/**
 * 爬架说明行（设计稿这里是超限警示 `.eq-alert`，现在有真数据了）。
 *
 * 四种情形，全都不编：
 *   · 数据没取到 → 如实说「未取到」，并保住真实的在线数
 *   · 有机位超限 → 报最不利的那一条（句式照设计稿）
 *   · 部分指标无读数 → 说清「部分指标无读数」，不整体判「正常」
 *   · 其余 → 「N 个机位 · HH:mm 更新 · 全部在阈值内」+ 阈值（可核验）
 */
const climbNote = computed<{ text: string; bad: boolean }>(() => {
  const s = scaf.summary
  const on = `${climbOnline.value.on}/${climbOnline.value.total}`
  if (!scaf.hasData) return { text: `倾斜与载荷传感器数据未取到（在线 ${on}）`, bad: false }

  // 数据来源不额外标注（实时 / 内置快照一视同仁），只带读数时间戳 ——
  // 时间本身就是「这几个数是什么时候的」最直接的交代。
  const hm = timeHm(s.updatedAt)
  const stamp = hm ? `${hm} 更新` : ''

  const over = firstOverLabel(s)
  if (over) return { text: over, bad: true }

  const tail = stamp ? ` · ${stamp}` : ''
  if (s.cells.some((c) => c.value === null)) {
    return { text: `${s.count} 个机位${tail} · 部分指标无读数`, bad: false }
  }
  const limits = s.cells.map((c) => `${c.label} ≤${c.limit}${c.unit}`).join('，')
  return { text: `${s.count} 个机位${tail} · 全部在阈值内（${limits}）`, bad: false }
})

/**
 * 卡片无障碍文案：按设计稿的句式（app.js:982-990），但只念真实存在的格子。
 *
 * 可下钻卡不念「设备状态 0/0」（那是假的），机器人卡不念在线数
 * （台账里没有这些设备，任何 x/y 都是编的）。
 *
 * 机器人卡的数值是 V2 预制体的预置模拟值，念的时候必须带上「示意值」——
 * 读屏用户听不到「卡片不可点、没有在线格」这些视觉线索，
 * 只念一个「今日作业次数 5 次」等于报了个假数。
 */
function ariaOf(d: Equip): string {
  if (!d.linked) {
    const v = d.value ?? '—'
    if (v === '—') return `${d.name}，暂无接入数据`
    // 视觉上有绿点，读屏也要听见「在线」，否则两边信息不一致
    const live = d.dot === 'on' ? '在线，' : ''
    return `${d.name}，${live}${d.metric ?? ''}${v}，示意值`
  }

  const c = countOf(d)
  const parts: string[] = [d.name]

  if (d.id === 'climb') {
    if (scaf.hasData) {
      // 与可视的三格同口径：先念「正常几台/共几台」，再补一句超限机位数
      for (const cell of scaf.summary.cells) {
        parts.push(cell.total > 0 ? `${cell.label}正常${cell.normal}/${cell.total}` : `${cell.label}无读数`)
      }
      if (scaf.summary.overCount > 0) parts.push(`${scaf.summary.overCount}个机位超限`)
    } else {
      parts.push('传感器数据未取到')
    }
    parts.push(`在线 ${c.on}/${c.total}`)
    return `${parts.join('，')}，点击查看点位`
  }

  // 无人机只有一格「今日作业次数」，与可视格同口径（= 子页的「已完成」）
  if (d.id === 'drone') {
    const n = uav.taskDone
    parts.push(n === null ? '今日作业次数未取到' : `今日作业次数${n}次`)
    return `${parts.join('，')}，点击进入控制`
  }

  parts.push(`在线设备${c.on}/${c.total}`)
  if (d.stats?.length) {
    for (const s of d.stats) parts.push(`${s.metric}${s.value}`)
  } else if (d.id === 'lift') {
    // 与可视格同口径：那一格常驻，没数就念「—」，不念台账里的高度
    const sec = lift.totalSeconds
    parts.push(`今日运行时长${sec === null ? DASH : formatRuntime(sec)}`)
  } else if (d.value) {
    parts.push(`${d.metric ?? ''}${d.value}`)
  }

  return `${parts.join('，')}，点击${d.id === 'climb' ? '查看点位' : '查看明细'}`
}

/* ---- 顶部两块统计（真实台账） ---- */

/**
 * 设备种类：页面上实际列出的设备类别数（4 类台账设备 + 5 类机器人 = 9）。
 *
 * 口径照 V2 的装备管理页：那边的「设备种类」同样按「几类设备」报
 * （预制体 `设备统计栏 / 设备种类Text` 预置 9，与它底部 9 张设备卡一一对应；
 * 该节点上只有 Image 组件，运行时不更新，所以它本身就是静态占位）。
 *
 * 这里不数「归类不出来」的台账设备（现场见过「测距监控」）：它们没有任何
 * 卡片承载，算进种类会出现「10 种 / 8 台」这种与页面自相矛盾的数。
 *
 * 台账未到位时给 0 —— 先报一个 9 会让人以为数据已经加载完了。
 */
const kinds = computed(() => (ledger.rows.length ? home.siteEquip.length : 0))

/**
 * 台账台数：4 类卡片分母之和 —— 也就是**页面上实际列出的台数**。
 *
 * 电梯这项是 4 而不是台账的 2 行：实时数据与 V2 都是按轿厢看（`data/liftSn.ts`），
 * 卡片上写「x/4」，这里若还按台账行数数 2，就会出现「数量 13 台、在线 15 台」
 * 这种自相矛盾的统计。塔机 / 爬架 / 无人机仍与台账行数一致。
 */
const wiredQty = computed(() => home.siteEquip.reduce((s, d) => s + countOf(d).total, 0))

/**
 * 设备数量：卡片分母之和 + 5 类机器人（每类按 1 台计）。
 *
 * 口径照 V2 装备管理页：那边「设备数量」报 9，与它底部 9 张设备卡（4 类台账
 * 设备 + 5 类机器人）一一对应，即「每类 1 台」。用户 2026-11-12 要求
 * 「台数要把这 5 台算进去」，故同样把 5 类机器人各计 1 台。
 */
const qty = computed(() => wiredQty.value + ROBOT_CARDS.length)

/**
 * 在线台数：每张可下钻卡按 `countOf` 数（塔机走实时四态，其余走台账）；
 * 5 类机器人各计 1 台在线。
 *
 * 机器人没有台账、也没有在线接口，但现场它们是常驻在线的
 * （用户 2026-11-12 确认）。这与作业次数是同一套授权：模拟值，
 * 只在 `data/robotStats.ts` / `ROBOT_CARDS` 里，不混进台账统计。
 */
const onCount = computed(() =>
  home.siteEquip.reduce((s, d) => s + (d.linked ? countOf(d).on : 1), 0),
)

/** 离线 = 设备数量 - 在线（本轮恒为 0，机器人也算在线） */
const offCount = computed(() => qty.value - onCount.value)

/** 触控版环形图分段（颜色与原 conic-gradient 一致） */
const statusSegs = computed(() => [
  { label: '在线', value: onCount.value, color: '#2EE6A6' },
  { label: '离线', value: offCount.value, color: '#3A4E66' },
])

/** 选中段（扇区点击与图例点击双向联动；null = 未选中） */
const eqSel = ref<number | null>(null)

/** 图例点选：同一段再点一次取消选中 */
function toggleSeg(i: number): void {
  eqSel.value = eqSel.value === i ? null : i
}

/** 键盘等价操作（Enter / Space） */
function onKey(e: KeyboardEvent, i: number): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    toggleSeg(i)
  }
}

function retry(): void {
  if (auth.token) void ledger.load(auth.token, true)
}

/** 去登录：登录完回首页，智控面板会自动补拉（watch token） */
function goLogin(): void {
  subpage.openLogin('登录后可查看设备台账与运行状态')
}

/**
 * 电梯数据凭证失效 —— 台账是好的（走 `:8084`），所以九张卡都在，
 * 只是电梯那几张每一格都是「—」。不说清楚用户只会反复下拉。
 *
 * 与设备详情页同一条提示、同一个出口，两处不该有两种说法。
 */
const needsRetry = computed(() => lift.authLost)

/**
 * 「重试」—— **不是**「重新登录」。
 *
 * 电梯走 IOT 云网关的项目级 ak/sk，跟登录页那套 `:8081` 业务账号（`xiangyangcun`）
 * 是两套凭证，登录换不到 IOT 令牌。之前这里写成「重新登录」，用户登完回来提示
 * 还在，看着像没生效。真正有效的是丢掉 IOT 旧令牌重换一张。
 */
function goRetry(): void {
  void lift.relogin()
}
</script>

<template>
  <!-- 未登录：台账接口要 Bearer，先引导登录 -->
  <div v-if="!auth.isLoggedIn" class="data-empty" data-empty="equip">
    <p>登录后可查看设备台账与运行状态</p>
    <button class="data-empty-btn" type="button" @click="goLogin">去登录</button>
  </div>

  <!-- 已登录但台账没到手：区分同步中 / 失败 / 确实没有 -->
  <template v-else-if="!ledger.hasData">
    <!--
      慢请求：在数据将要出现的位置铺灰条（统计卡 + 9 张设备卡），
      结构与下面真实内容一一对应，台账到手后原位回填、高度不变。
      `is-on` 之前整层是 opacity: 0 —— 占位先撑住版式，但灰条要等
      SKEL_DELAY 之后才淡入，快请求就完全看不到这一层。
    -->
    <template v-if="ledger.state === 'loading'">
      <span class="sr-only" role="status">正在加载设备台账</span>
      <div class="home-stats alarm-row skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <div class="home-chart-card eq-count">
          <!-- 尺寸照真实元素量的（b 22px / span 11px），回填时高度一像素不跳 -->
          <div class="eq-count-item"><Skel w="56px" h="22px" r="var(--r-6)" /><Skel w="44px" h="11px" /></div>
          <div class="eq-count-item"><Skel w="56px" h="22px" r="var(--r-6)" /><Skel w="44px" h="11px" /></div>
        </div>
        <div class="home-chart-card eq-status">
          <Skel w="46px" h="14px" />
          <div class="eq-status-body">
            <Skel w="40px" h="40px" circle />
            <div class="eq-status-leg">
              <div class="skel-leg-row"><Skel w="8px" h="8px" circle /><Skel w="24px" h="10px" /><Skel w="14px" h="12px" /></div>
              <div class="skel-leg-row"><Skel w="8px" h="8px" circle /><Skel w="24px" h="10px" /><Skel w="14px" h="12px" /></div>
            </div>
          </div>
        </div>
      </div>
      <div class="eq-grid skel-fade" :class="{ 'is-on': showSkel }" aria-hidden="true">
        <!-- 9 张：与真实列表同数量，回填时下面的内容不会整体上移 -->
        <div v-for="i in 9" :key="i" class="eq-card">
          <span class="eq-ico"><Skel w="36px" h="36px" r="var(--r-8)" /></span>
          <span class="eq-main">
            <span class="eq-hd"><Skel w="78px" h="17px" /></span>
            <!-- 两列数值格与真实卡同构（数字 28 + 间距 4 + 标签 16 = 48px） -->
            <span class="eq-vals">
              <span class="eq-val"><Skel w="46px" h="28px" r="var(--r-6)" /><Skel class="skel-mt-sm" w="40px" h="16px" /></span>
              <span class="eq-val"><Skel w="46px" h="28px" r="var(--r-6)" /><Skel class="skel-mt-sm" w="40px" h="16px" /></span>
            </span>
          </span>
        </div>
      </div>
    </template>
    <div v-else-if="ledger.state === 'error'" class="data-empty" data-empty="equip">
      <p>{{ ledger.error || '设备台账加载失败' }}</p>
      <button class="data-empty-btn" type="button" @click="retry">重试</button>
    </div>
    <div v-else class="data-empty" data-empty="equip">
      <p>暂无设备台账数据</p>
    </div>
  </template>

  <template v-else>
    <div class="home-stats alarm-row fill-in">
      <div class="home-chart-card eq-count">
        <!-- sticky：面板是 v-if 切换的，不加则每次切回都从 0 重滚同样的数字 -->
        <div class="eq-count-item"><b><CountUp :value="kinds" sticky /><em>种</em></b><span>设备种类</span></div>
        <div class="eq-count-item"><b><CountUp :value="qty" sticky /><em>台</em></b><span>设备数量</span></div>
      </div>
      <div class="home-chart-card eq-status">
        <span class="alarm-mini-lab">设备状态</span>
        <div class="eq-status-body">
          <DonutTouch
            :segments="statusSegs"
            donut-class="eq-status-donut"
            :selected="eqSel"
            @select="eqSel = $event"
          />
          <!--
            图例是可点的筛选开关，此前是裸 div + click：键盘完全不可达，
            也没有任何「已选中」的语义。补 role/tabindex/aria-pressed 后，
            读屏与键盘用户才能知道它既能操作、又处在开还是关。
          -->
          <div class="eq-status-leg">
            <div
              :class="{ 'leg-on': eqSel === 0 }"
              role="button"
              tabindex="0"
              :aria-pressed="eqSel === 0"
              @click="toggleSeg(0)"
              @keydown="onKey($event, 0)"
            >
              <i class="on"></i><span>在线</span><b><CountUp :value="onCount" sticky /></b>
            </div>
            <div
              :class="{ 'leg-on': eqSel === 1 }"
              role="button"
              tabindex="0"
              :aria-pressed="eqSel === 1"
              @click="toggleSeg(1)"
              @keydown="onKey($event, 1)"
            >
              <i class="off"></i><span>离线</span><b><CountUp :value="offCount" sticky /></b>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 电梯数据凭证失效：九张卡都在，只有电梯那几张是「—」。得说清是为什么 -->
    <section v-if="needsRetry" class="dev-auth" role="alert">
      <!-- 与设备详情页同一条提示、同一个出口，两处不该有两种说法 -->
      <p>{{ lift.gatewayStale ? '电梯物联网网关未恢复，请稍后再试' : '电梯物联网网关凭证失效，请稍后重试' }}</p>
      <button class="dev-auth-btn" type="button" @click="goRetry">重试</button>
    </section>

    <div class="eq-grid fill-in">
      <!--
        有 page 的才是可点卡片（原生 button：键盘 / 读屏天然可达）；
        机器人没有详情页，用 div —— 给 button 等于向键盘用户承诺「按下去有事」。
      -->
      <component
        :is="d.page ? 'button' : 'div'"
        v-for="d in home.siteEquip"
        :key="d.id"
        class="eq-card"
        :class="{ drill: !!d.page, 'is-crane': d.id === 'crane', 'is-climb': isClimb(d) }"
        :type="d.page ? 'button' : undefined"
        :role="d.page ? undefined : 'group'"
        :data-page="pageOf(d)"
        :aria-label="ariaOf(d)"
        @click="onCard(d)"
      >
        <!--
          这一层在设计稿里叫 .eq-climb-top（只有爬架卡需要：等宽两段的第一段）。
          非爬架卡只有一段，复用同一个容器可以省掉「图标 + 数值行 + 箭头」
          三次重复的模板；CSS 里给它 flex: auto，让它在两种卡片里都撑满一行。
        -->
        <span class="eq-climb-top">
          <span class="eq-ico" aria-hidden="true">
            <img v-if="icoImg(d) && !icoFailed[d.ico]" :src="icoImg(d)" alt="" @error="onIcoError(d)" />
            <SvgIcon v-else :name="icoIcon(d)" />
          </span>
          <span class="eq-main">
            <span class="eq-hd">
              <strong>{{ d.name }}</strong>
              <!--
                状态点：有台账的卡按 `units` 派生；机器人没有台账，
                由 `Equip.dot` 显式给 'on'（现场这几类机器人常驻在线）。
              -->
              <i v-if="d.linked || d.dot" class="eq-dot" :class="d.dot ?? countOf(d).st"></i>
            </span>
            <!-- 爬架：三格「正常机位数 / 有读数的机位数」（CDN 真实读数） -->
            <span v-if="isClimb(d)" class="eq-vals">
              <span v-for="cell in climbCells" :key="cell.metric" class="eq-val">
                <b>
                  <template v-if="cell.total > 0">
                    <em class="eq-ok">{{ cell.normal }}</em><i class="eq-total">/{{ cell.total }}</i>
                  </template>
                  <template v-else>—</template>
                </b>
                <span>{{ cell.metric }}</span>
              </span>
            </span>
            <span v-else class="eq-vals">
              <template v-for="(cell, ci) in cellsOf(d)" :key="ci">
                <!--
                  在线 x/y 格：分子是「在线设备数」、分母是「设备总数」，两者必须
                  同时看得见 —— 只有分子会被读成「一共就这么几台」。
                  分子分母包在同一个 <b> 里并禁止换行：拆行会让「/4」掉到标签行上。
                -->
                <span v-if="cell.online" class="eq-val eq-online" :class="{ 'is-off': !cell.on }">
                  <b><span class="eq-on">{{ cell.on }}</span><i class="eq-total">/{{ cell.total }}</i></b>
                  <span>{{ cell.metric }}</span>
                </span>
                <!-- 普通数值格：单位拆出来单独排（设计稿 .eq-stat-unit） -->
                <span v-else class="eq-val">
                  <b>{{ cell.value }}<i v-if="cell.unit" class="eq-stat-unit">{{ cell.unit }}</i></b>
                  <span>{{ cell.metric }}</span>
                </span>
              </template>
            </span>
          </span>
          <!-- 箭头只属于可下钻的卡片：静态卡给箭头就是在暗示「能进去」 -->
          <span v-if="d.page" class="eq-more" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg></span>
        </span>
        <!--
          爬架说明行：有机位超限时是设计稿的「30#机位 左右倾斜 179.5mm，超过 60mm」
          （.eq-climb-note.is-bad），没有超限就是一句可核验的汇总（机位数 / 更新时间 /
          阈值）。取不到数据时如实说未取到，顺带保住真实的在线数。
        -->
        <span v-if="isClimb(d)" class="eq-climb-note" :class="{ 'is-bad': climbNote.bad }">{{ climbNote.text }}</span>
      </component>
    </div>
  </template>
</template>
