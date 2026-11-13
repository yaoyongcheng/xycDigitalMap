/**
 * 设备台账（数据服务 `:8084`，需 Bearer）
 *
 * 口径与首页其它面板一致：**只展示真实数据，取不到就空态 + 重试**。
 * 上一轮已经没有任何设备侧的演示数字（原先 data/device.ts 里有 3 台塔机 +
 * 4 台电梯的完整假数据），这里补上唯一的真实来源。
 *
 * 三个要点：
 *   ① 台账要靠登录态（`:8084/api/data/*` 无 token 回 401），所以取数入口带
 *      token；登出时必须 `reset()`，否则换账号还能看到上一个人的机组；
 *   ② 拉回来的行同时喂给两个消费方：首页前四张卡（toEquip）与设备详情/弹层
 *      （toUnit → data/device.ts 的响应式登记表）；
 *   ③ 失败不静默重试到底：60s 冷却，避免每次进首页都打一遍失败请求。
 *
 * **2026-11 第三轮：塔机「今日吊次 / 吊重」接工作循环接口。**
 * 这一步的前提是能拿到设备序列号，而台账里连字段都没有 —— 只能从
 * `extra_fields` 的 label 猜（utils/deviceLedger.ts: serialOf）。取不到 sn
 * 就整块跳过，卡片退回台账里的高度；拿得到就按天汇总一次，写进 `craneDay`。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchAreas, fetchDeviceInfos, type AreaRow, type DeviceInfoRow } from '@/api/data'
import { fetchCraneWorkCycle } from '@/api/towerCrane'
import { CRANE_SNS } from '@/data/craneSn'
import { setLiveUnits } from '@/data/device'
import { byUnitNo, categoryOf, serialOf, toEquip, toUnit, type DeviceCategory } from '@/utils/deviceLedger'
import type { CraneDayStats, CraneWorkCycle, DeviceKind, DeviceUnit, Equip } from '@/types'

/** 失败后的冷却时间（与 overview 一致） */
const RETRY_GAP = 60_000

/**
 * 工作循环数组 → 当日指标（吊次 + 吊重）。
 *
 * 两条口径：
 *   ① **吊次 = 条数**，哪怕某条没有重量也算「吊了一次」；
 *   ② **吊重 = 有重量的那些之和**，一条都没有有效重量时给 `null`（不是 0）——
 *      把「没记账」写成「0 吨」是最不该出现在塔机卡上的数字。
 *
 * 两位小数取整：浮点累加会出 4.970000000000001 这种尾巴，卡片的吨位本来
 * 也只到两位（1.87t），留噪声只会让下游断言与文案一起抖。
 */
function summarize(cycles: CraneWorkCycle[]): CraneDayStats {
  let weight = 0
  let weighed = 0
  for (const c of cycles) {
    if (c.weight === null) continue
    weight += c.weight
    weighed += 1
  }
  return { trips: cycles.length, weight: weighed ? Math.round(weight * 100) / 100 : null }
}

/** 台账状态：idle 未请求 / loading 请求中 / ok 已取到 / error 失败 */
export type LedgerState = 'idle' | 'loading' | 'ok' | 'error'

export const useDeviceLedgerStore = defineStore('deviceLedger', () => {
  /** 原始台账行（保留服务端字段，页面派生时再映射） */
  const rows = ref<DeviceInfoRow[]>([])

  const state = ref<LedgerState>('idle')
  const error = ref('')
  /** 成功取数的时刻（HH:mm） */
  const updatedAt = ref('')

  /**
   * 项目区域清单（同一个 `:8084` 服务，阶段 5 给首页「人员分布」用）。
   *
   * 独立成一块状态：区域接口挂了不该把设备台账一起判失败，反之亦然。
   * 现场 `areas` 有 9 条真实区域，但**没有任何人数/定位字段** ——
   * 所以页面只能展示区域名，人数位显示「—」，不许拿 0 顶替。
   */
  const areas = ref<AreaRow[]>([])
  const areasState = ref<LedgerState>('idle')
  const areasError = ref('')

  let lastFailAt = 0
  let inflight: Promise<void> | null = null

  /**
   * 塔机当日作业指标（今日吊次 + 今日吊重）——**全场合计**，首页智控卡用。
   *
   * `null` = 没有 sn 或接口没通 → 卡片显示台账里的最大高度。
   * 有值时卡片改显「今日吊重 / 今日吊次」两格（设计稿塔机卡的结构）。
   */
  const craneDay = ref<CraneDayStats | null>(null)

  /**
   * 逐台的今日指标：`sn → { trips, weight }`。
   *
   * 设备详情页（5G塔机）每张卡片显示的是**这台车自己的**今日吊次/吊重
   * （V2 卡片「今日吊次 9次 / 今日吊重 5.05t」），不能拿全场合计糊上去。
   * 请求与 `craneDay` 共用同一批响应，只是汇总方式不同 —— 不多打一次接口。
   *
   * 表里没有的车（例如无 sn 的传统塔机5）就是「—」。
   */
  const craneDayBySn = ref<Record<string, CraneDayStats>>({})

  const equip = computed<Equip[]>(() => toEquip(rows.value, craneDay.value))

  /**
   * 有没有可渲染的台账行。
   *
   * **只看行、不看 `state`**：切回智控面板会强制重拉（`refresh`），而 `load`
   * 一进来就把 state 置成 `loading` —— 若这里要求 `state === 'ok'`，切回那一帧
   * 卡片会整块被骨架顶掉、再闪回来。失败分支已经清空 rows，所以「失败」依然
   * 是 false，语义没丢。
   */
  const hasData = computed(() => rows.value.length > 0)

  /** 设备总数与在线数（首页计数卡用；含未归类的设备，按真实台账算） */
  const total = computed(() => rows.value.length)
  const online = computed(() => rows.value.filter((r) => Number(r.online_status) === 1).length)

  /**
   * 某一类的真实机组（塔机 / 电梯 / 爬架 / 无人机），设备页与弹层共用。
   *
   * **按台号升序**：服务端按 id 倒序返回（传统塔机5 在最前），而现场读数习惯是
   * 智能塔机2 → 3 → 4 → 传统塔机5。排序键见 `utils/deviceLedger.ts: byUnitNo`。
   */
  function categoryUnits(kind: DeviceCategory): DeviceUnit[] {
    return rows.value
      .filter((r) => categoryOf(r.device_name) === kind)
      .map(toUnit)
      .sort(byUnitNo)
  }

  /** 塔机 / 电梯（DeviceKind 交集）—— 与 deviceSet 的登记表同名同源 */
  function unitsOf(kind: DeviceKind): DeviceUnit[] {
    return categoryUnits(kind)
  }

  /** 把真实机组同步给 data/device.ts 的响应式登记表（弹层宿主等同步消费方靠它） */
  function syncLive(): void {
    setLiveUnits('crane', unitsOf('crane'))
    setLiveUnits('lift', unitsOf('lift'))
  }

  /** 测试与「接口优先」的接线点：直接灌入一批行（不走网络） */
  function apply(list: DeviceInfoRow[]): void {
    rows.value = list
    state.value = 'ok'
    error.value = ''
    syncLive()
    // 夹具 / 接线数据里一般没有序列号 → 这里不会发任何请求
    void loadCraneDay(list)
  }

  /** 测试接线点：直接灌入区域清单 */
  function applyAreas(list: AreaRow[]): void {
    areas.value = list
    areasState.value = 'ok'
    areasError.value = ''
  }

  /** 拉区域清单；失败只影响这一块，且不参与台账的 60s 冷却 */
  async function loadAreas(token: string, force = false): Promise<void> {
    if (!token) return
    if (!force && (areasState.value === 'loading' || areasState.value === 'ok')) return
    areasState.value = 'loading'
    try {
      areas.value = await fetchAreas()
      areasState.value = 'ok'
      areasError.value = ''
    } catch (e) {
      areasState.value = 'error'
      areasError.value = e instanceof Error ? e.message : '区域清单加载失败'
      areas.value = []
    }
  }

  /**
   * 按天汇总塔机工作循环，**一次请求两个口径**：
   *   · `craneDay` —— 全场合计（首页智控卡「今日吊次/吊重」）；
   *   · `craneDayBySn` —— 逐台（5G塔机页每张卡片自己的数字）。
   *
   * 四条硬规则：
   *   ① **编号来源分两级**：台账 `extra_fields` 里能猜出 sn 就用台账的（那样
   *      数字与台账那 4 台车严格对应）；猜不出来（现场现状）就退到
   *      `data/craneSn.ts` 的 V2 登记表 —— 那是 V2 场景里真正在跑的那 3 台车，
   *      口径与 V2 桌面端一致。**绝不拿设备名/台号去凑一个编号**。
   *   ② 合计口径从严：只要有一台塔机的查询失败（`null`），`craneDay` 整体
   *      就置 null —— 合计是「全队在今天的产出」，少算一台的合计比「—」更容易被当真。
   *      **逐台不受此约束**：别台失败不该把已经拿到的这一台也抹掉。
   *   ③ 数组为空是有效结论（接口通了、今天没吊）→ 吊次 0、吊重 null。
   *      store 里保持 null（「没有称重记录」和「0 吨」在数据层是两件事），
   *      只在**展示层**（`utils/deviceLedger.ts: weightText`）写成 0.00t。
   *   ④ 逐台的 key 就是 sn，页面用 `craneSnOf(台号)` 对齐（V2 的卡片也是
   *      按 sn 取数的，见 `data/craneSn.ts`）。没有 sn 的车（传统塔机5）
   *      不在表里 → 卡片显示「—」。
   *
   * 请求是 fire-and-forget：台账到手就先渲染卡片（高度那层是立刻有的），
   * 吊次/吊重晚一步回填，不让首页为一条第三方请求多等一个来回。
   */
  async function loadCraneDay(list: DeviceInfoRow[]): Promise<void> {
    const own: string[] = []
    for (const row of list) {
      if (categoryOf(row?.device_name) !== 'crane') continue
      const sn = serialOf(row)
      if (sn && !own.includes(sn)) own.push(sn)
    }
    const sns = own.length ? own : CRANE_SNS.map((c) => c.sn)
    if (!sns.length) {
      craneDay.value = null
      craneDayBySn.value = {}
      return
    }

    const today = new Date()
    const results = await Promise.all(sns.map((sn) => fetchCraneWorkCycle(sn, today)))

    // 逐台：某台失败只是这台的指标缺，不影响别台（合计才要求全队齐全）
    const bysn: Record<string, CraneDayStats> = {}
    results.forEach((cycles, i) => {
      if (!cycles) return
      bysn[sns[i]] = summarize(cycles)
    })
    craneDayBySn.value = bysn

    if (results.some((r) => r === null)) {
      craneDay.value = null
      return
    }

    const cycles = results.flatMap((r) => r ?? [])
    craneDay.value = summarize(cycles)
  }

  function stamp(): string {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /**
   * 取台账。`token` 为空直接返回（未登录由调用方走登录守卫）。
   *
   * 并发调用复用同一个 Promise：首页智控面板与设备页可能同时挂载。
   */
  async function load(token: string, force = false): Promise<void> {
    if (!token) return
    if (inflight) return inflight
    if (!force && state.value === 'ok') return
    if (!force && state.value === 'error' && Date.now() - lastFailAt < RETRY_GAP) return

    state.value = 'loading'
    // 人员分布常驻首页，区域清单与台账同源同 token，顺带拉一次（不阻塞台账）
    void loadAreas(token, force)
    inflight = (async () => {
      try {
        const list = await fetchDeviceInfos()
        rows.value = list
        state.value = 'ok'
        error.value = ''
        updatedAt.value = stamp()
        syncLive()
        // 塔机作业指标晚一步回填（没有 sn 时这条路自己会短路）
        void loadCraneDay(list)
      } catch (e) {
        state.value = 'error'
        error.value = e instanceof Error ? e.message : '设备台账加载失败'
        lastFailAt = Date.now()
        // 失败时清空：留着上一次的行会让人以为「这是最新的」
        rows.value = []
        craneDay.value = null
        craneDayBySn.value = {}
        syncLive()
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /**
   * 切回智控面板时的刷新（首页标签切换会调用）。
   *
   * 与 `load(token, true)` 的区别：**失败冷却仍生效** —— 连点标签时不该反复
   * 打注定失败的台账请求；页面上的「重试」按钮才走 force。
   *
   * 台账本身变化不多，但**在线状态与塔机今日吊次/吊重是实时变的**，
   * 这两个正是智控卡上最该「切回来就是此刻」的字段。重拉会连带
   * `loadCraneDay` 再跑一遍（同一份数据喂给全场合计与逐台两套口径）。
   */
  async function refresh(token: string): Promise<void> {
    if (!token) return
    if (state.value === 'error' && Date.now() - lastFailAt < RETRY_GAP) return
    return load(token, true)
  }

  /** 退出登录 / 换账号时清空 */
  function reset(): void {
    rows.value = []
    state.value = 'idle'
    error.value = ''
    updatedAt.value = ''
    lastFailAt = 0
    craneDay.value = null
    craneDayBySn.value = {}
    areas.value = []
    areasState.value = 'idle'
    areasError.value = ''
    syncLive()
  }

  return {
    rows,
    state,
    error,
    updatedAt,
    craneDay,
    craneDayBySn,
    equip,
    hasData,
    total,
    online,
    categoryUnits,
    unitsOf,
    apply,
    load,
    refresh,
    reset,
    areas,
    areasState,
    areasError,
    applyAreas,
    loadAreas,
  }
})
