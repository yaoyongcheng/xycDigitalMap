/**
 * 无人机「状态」格 → 文案
 *
 * 数据来源：机载遥测 `status`（偶发 `status` 不刷新时退到 `modeCode`）。
 *
 * 枚举就是 DJI 上云 API 的 `drone_status`（0 待机 … 18 空中 RTK 收敛），
 * 和 V2 用的是同一张表 —— 从 V2 热更程序集 `HotUpdateScripts.dll` 的字符串堆
 * （`#US`，UTF-16LE）里能按顺序读到「待机 / 自动起飞 / 全景拍照 / ADS-B 躲避 /
 * 自动返航 / 升级 / APAS / 虚拟摇杆 / 指令飞行 / 空中 RTK 收敛模式 / 机场」，
 * 与官方枚举逐项吻合；「关机」在同一段里写成 `<color=red>关机</color>`。
 *
 * ## `-1` 为什么要单独处理
 *
 * `-1` 不在 DJI 枚举里。库里飞机飞控断电时 keehang 就报 `status: -1`
 * （2026-11-13 实测：`status: -1`、`modeCode: 14`、`gear: 1`、电量 88%），
 * V2 在这个值上显示的是红字「关机」。所以照它做。
 *
 * 但**不直接照抄**：多一步交叉校验 —— 若 `status` 是 `-1` 而 `modeCode`
 * 还在有效飞行态（不是 14「未连接」），说明飞机其实是连着的、只是 `status`
 * 没刷新，那种情况按 `modeCode` 说，免得「在飞」被写成「关机」。
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
 * @param status   机载遥测 `status`（-1 = 飞控未上报/关机）
 * @param modeCode 机载遥测 `modeCode`（同枚举，用于交叉校验与兜底）
 */
export function droneStateText(status: number | null, modeCode: number | null): string {
  // 主字段能读就直接用（-1 不在枚举里，下面单独收）
  if (status !== null && status >= 0) return DRONE_STATUS_NAME[status] ?? DASH

  // status 无效（-1 / 缺失）：modeCode 还在有效态说明飞机其实连着，以它为准
  if (modeCode !== null && modeCode >= 0 && modeCode !== MODE_DISCONNECTED) {
    return DRONE_STATUS_NAME[modeCode] ?? DASH
  }

  // 两个字段都说没连上 → 库里断电，V2 写「关机」
  if (status === -1) return '关机'
  if (modeCode === MODE_DISCONNECTED) return '未连接'
  return DASH
}

/** 状态是否「不正常」（关机 / 未连接），页面据此上色，不做业务判断 */
export function droneStateIsDown(status: number | null, modeCode: number | null): boolean {
  return droneStateText(status, modeCode) === '关机' || droneStateText(status, modeCode) === '未连接'
}
