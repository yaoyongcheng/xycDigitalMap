/**
 * 塔机设备编号（sn）登记表
 *
 * ## 为什么需要这份表
 *
 * `:8084` 的设备台账里**没有任何序列号字段**（V2 反编译也确认
 * `/api/data/deviceinfos` 的响应只有 `device_name / online_status /
 * device_info{extra_fields, status_text, responsible_person, update_time}`），
 * 而塔机工作循环接口 `getWorkCycleInfoHis` 必须按 sn 查。
 *
 * ## 编号从哪来（不是编的）
 *
 * 来自 **V2 场景**本身。V2 的塔机编号是 Inspector 上的序列化字段
 * （`TowerCraneController.deviceSn`），运行时 `CraneModel` 就是拿它去查
 * 今日吊次 / 吊重的：
 *
 * ```
 * CraneModel.GetTodayWorkCycleCount(deviceSn)
 * CraneModel.GetTodayTotalWeight(deviceSn)
 * ```
 *
 * 2026-11-12 用 UnityPy 解析 `_Data/yoo/DefaultPackage/BundleFiles/
 * cb4440f68c48489259d528982c1d7320` 这份场景包，`MonoBehaviour` 里
 * `deviceSn` 字段只有这 3 个非空值，原样抄下来。
 *
 * ## 查回来的确实是向阳村
 *
 * 用这 3 个编号打 `getWorkCycleInfoHis`，返回行的 `siteName` 是
 * **"武汉向阳村项目"**、`deviceName` 是「向阳村2#塔机」「向阳村4#塔机」。
 * （对照：MQTT broker 上另有一批「光谷元箸项目N号塔机」，那是别的项目串过来的
 * 噪音，与 V2 算吊次/吊重用的不是同一批设备，已剔除。）
 *
 * ## 为什么只有 3 台，台账却有 4 台塔机
 *
 * 台账里是「智能塔机2 / 3 / 4 + 传统塔机5」共 4 台，而场景里只挂了 3 个
 * `TowerCraneController`（对应 2# / 3# / 4#）。「传统塔机5」没有接入塔机平台，
 * V2 桌面端同样算不到它（`FetchAllWorkCycleHistoryAsync` 只遍历场景里的
 * `BuildingCrane.deviceSn`）。**这里与 V2 的口径保持一致：只算这 3 台。**
 *
 * ## 逐台映射（2026-11-12 补：实时工况需要它，且这次有键）
 *
 * 早前这里的结论是「不做逐台映射」，那是针对**今日吊次/吊重合计**说的 ——
 * 合计值贴在某一台车名下会误导，且没有可靠键。
 *
 * 实时工况不一样：**报文自己带设备名**（`deviceName: "向阳村2#塔机"`），
 * 而 V2 场景里 `塔机2` 的 `TowerCraneController.deviceSn` 正是 `EW2` ——
 * 台号对台号是 V2 自己在用的映射（它弹层标题「智能塔机2」来自台账、
 * 「塔机编号」来自 sn，两者就是这么拼起来的）。所以这里按**台号**映射：
 * 台账「智能塔机N」 → 平台「向阳村N#塔机」 → sn。见 `craneSnOf()`。
 *
 * 「传统塔机5」没有 sn（场景里 `塔机5` 的 `deviceSn` 是空的）——
 * 与 V2 一致：那台车在弹层里没有「塔机编号」，也没有实时工况。
 *
 * ## 台账一旦补上编号
 *
 * `stores/deviceLedger.ts: loadCraneDay` 会优先用台账 `extra_fields` 里的编号，
 * 这份表自动退为兜底 —— 那时逐台口径才谈得上准确。
 */

export interface CraneSnEntry {
  /** 塔机平台设备编号 */
  sn: string
  /** 平台侧设备名（报文原样，仅用于排查，不直接展示） */
  name: string
}

/** V2 场景里登记的 3 台向阳村塔机 */
export const CRANE_SNS: readonly CraneSnEntry[] = [
  { sn: '91320506MAE18ATB9XTC202606181EW2', name: '向阳村2#塔机' },
  { sn: '91320506MAE18ATB9XTC202606181EW3', name: '向阳村3#塔机' },
  { sn: '91320506MAE18ATB9XTC202606181EW4', name: '向阳村4#塔机' },
]

/**
 * 台账台号 → 塔机平台编号。
 *
 * `智能塔机2` → 台号 2 → `向阳村2#塔机` → `…EW2`。
 * 传统塔机5 没有对应编号，返回 null（弹层里「塔机编号」与「实时工况」都显示「—」）。
 *
 * 传台号而不是传名字：调用方本来就要用 `unitNo()` 排序，同一个数字两处复用，
 * 不再重复解析名称。
 */
export function craneSnOf(no: number | null | undefined): string | null {
  if (no === null || no === undefined) return null
  const hit = CRANE_SNS.find((c) => c.name.startsWith(`向阳村${no}#`))
  return hit?.sn ?? null
}
