/**
 * 无人机「状态」格 → 文案
 *
 * 数据来源：机载遥测 **`modeCode` 为主**，`status` 只在 `modeCode` 缺失时兜底。
 *
 * ## 为什么主次是反的（2026-11-13 17:07 实测）
 *
 * 早先以 `status` 为主，理由是它名字更像「状态」。现场连着采样才发现：
 * 飞机从 69m 高度自动降落（`verticalSpeed -3.9`、`relativeAltitude 69.3`）
 * 到落回库内静止，**`status` 全程恒为 1**，而 `modeCode` 跟着走完
 * `10 自动降落 → 0 待机` 两段。于是页面永远写「起飞准备」，
 * 与 V2 同一时刻的「航线飞行 / 待机」对不上 —— 就是用户截图那一格。
 *
 * 结论：keehang 的 `status` 是**设备状态**（1 = 在线正常、-1 = 飞控未上报），
 * `modeCode` 才是 DJI 的 `mode_code` 飞行模式。两者同枚举、不同用途，
 * 位置摆错就会画出一个恒定的假状态。
 *
 * 枚举就是 DJI 上云 API 的 `mode_code`（0 待机 … 18 空中 RTK 收敛），
 * 和 V2 用的是同一张表 —— 从 V2 热更程序集 `HotUpdateScripts.dll` 的字符串堆
 * （`#US`，UTF-16LE）里能按顺序读到「待机 / 自动起飞 / 全景拍照 / ADS-B 躲避 /
 * 自动返航 / 升级 / APAS / 虚拟摇杆 / 指令飞行 / 空中 RTK 收敛模式 / 机场」，
 * 与官方枚举逐项吻合；「关机」在同一段里写成 `<color=red>关机</color>`。
 *
 * ## 「关机」的判定
 *
 * `status: -1` 不在 DJI 枚举里。库里飞机飞控断电时 keehang 报
 * `status: -1` + `modeCode: 14`（2026-11-13 实测：`gear: 1`、电量 88%），
 * V2 在这个组合上显示红字「关机」，所以照它做。
 *
 * 只有 `status` 真的是 `-1`（明确「没上报」）才敢说关机；`status` 缺失但
 * `modeCode` 是 14 时只说「未连接」—— 缺数据不等于断电。
 *
 * 之前这里写的是「有执行中的任务 → 作业中，否则停泊」，那是自己编的语义：
 * 任务和飞机状态不是一回事（任务排了但没飞、飞机飞着但没有任务），
 * 用户拿 V2 一比就露馅。
 */

/** 状态码 → 文案。只收已确认的 0~18；其它值一律「—」，不猜 */
const DRONE_STATUS_NAME: Record<number, string> = {
  0: '待机',
  1: '起飞准备',
  2: '起飞准备完毕',
  3: '手动飞行',
  4: '自动起飞',
  5: '航线飞行',
  6: '全景拍照',
  7: '智能跟随',
  8: 'ADS-B 躲避',
  9: '自动返航',
  10: '自动降落',
  11: '强制降落',
  12: '三桨叶降落',
  13: '升级中',
  14: '未连接',
  15: 'APAS',
  16: '虚拟摇杆',
  17: '指令飞行',
  18: '空中 RTK 收敛',
}

/** `modeCode` 里表示「没连上」的取值，与 `status` 同枚举 */
const MODE_DISCONNECTED = 14

/** 没数据时的占位（与全站一致） */
const DASH = '—'

/**
 * 飞机状态文案。
 *
 * @param status   机载遥测 `status`（**设备状态**：1 = 在线正常，-1 = 飞控未上报）
 * @param modeCode 机载遥测 `modeCode`（DJI `mode_code` 飞行模式，主字段）
 */
export function droneStateText(status: number | null, modeCode: number | null): string {
  // 断电在库：status 明确说「没上报」且 modeCode 说「未连接」→ V2 写「关机」
  if (status === -1 && modeCode === MODE_DISCONNECTED) return '关机'

  // 主字段：modeCode 是唯一跟随飞行状态的那个（实测 status 会恒定不动）
  if (modeCode !== null && modeCode >= 0) return DRONE_STATUS_NAME[modeCode] ?? DASH

  // modeCode 缺失 → 退到 status（只给一个字段的机型/旧快照）
  if (status !== null && status >= 0) return DRONE_STATUS_NAME[status] ?? DASH
  if (status === -1) return '关机'
  return DASH
}

/** 状态是否「不正常」（关机 / 未连接），页面据此上色，不做业务判断 */
export function droneStateIsDown(status: number | null, modeCode: number | null): boolean {
  return droneStateText(status, modeCode) === '关机' || droneStateText(status, modeCode) === '未连接'
}
