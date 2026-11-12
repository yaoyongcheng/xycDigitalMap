/**
 * 5 类机器人的「今日作业次数」—— 取自 V2 客户端的 **预制体默认文本**。
 *
 * ## 数据到底从哪来
 *
 * 不是猜的，也不是照抄设计稿。V2 的装备管理页预制体
 * `assets_hotupdateresources_prefabs_ui.bundle` 里的
 * `UIView 装备管理一张图 / 底部栏 / 施工机器人栏` 下，每张卡都预置了一组
 * TextMeshPro 默认文本（路径 → 文本，2026-11-12 用 UnityPy 逐节点读出）：
 *
 *   地坪研磨机器人        Value = `<size=24>5</size>次`   DataName = 今日作业次数
 *   喷涂机器人            Value = `<size=24>9</size>次`   DataName = 今日作业次数
 *   测量机器人            Value = `<size=24>7</size>次`   DataName = 今日作业次数
 *   抹灰机器人            Value = `<size=24>4</size>次`   DataName = 今日作业次数
 *   混凝土整平机器人      Value = `<size=24>3</size>次`   DataName = 今日作业次数
 *
 * 也就是说 V2 里这几个数字**本身就是写死的模拟值**（同栏的在线数统一写死
 * `4/4`，爬架高度写死 `0m`，也是同一性质的占位）。V2 没有任何机器人作业接口：
 * `HotUpdateScripts.dll` 里只有 `BuildingGrindingRobot` / `BuildingTrowelingRobot`
 * / `BuildingMeasuringRobot` 三个类，每个类仅一个 `followTarget` 字段（点模型时
 * UI 跟随的位置）；`:8084` 台账全项目 22 台设备里也没有机器人。
 *
 * 所以本项目照 V2 的做法取同一组值 —— 用户 2026-11-12 明确要求
 * 「V2 从哪来数据你也从哪来，是模拟值就设模拟值」。
 *
 * ## 这是本项目唯一一处授权例外
 *
 * 「生产代码不放演示种子」是硬约定，此处经用户明确授权打破一次。为了让例外
 * 不扩散：值只在本文件、卡片定义引用它、无障碍文案念作「示意值」。
 * 卡片本身仍是静态卡（`linked: false`）：不可点、不出箭头、不出在线格 ——
 * 因为「在线 x/y」连模拟值都没有（V2 的 4/4 是占位，台账里没有这些设备）。
 *
 * ## 接入真实数据时怎么改
 *
 * 现场机器人平台一旦给出「按类型统计当日作业次数」的接口，删掉本文件，
 * 改为在 `stores/deviceLedger.ts` 里与 `craneDay` 同法派生即可 ——
 * 卡片的渲染分支（`linked` / `stats`）不用动。
 */
export const ROBOT_DEMO_TRIPS: Readonly<Record<string, number>> = {
  grind: 5,
  plaster: 4,
  survey: 7,
  spray: 9,
  screed: 3,
}

/** 取示意值；没有登记的 id 返回 null（卡片退回「—」，不写 0） */
export function robotDemoTrips(id: string): number | null {
  return ROBOT_DEMO_TRIPS[id] ?? null
}
