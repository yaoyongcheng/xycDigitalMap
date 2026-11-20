import type { CamGroup } from '@/types'

import { CCTV_CHANNELS } from './cctv'

/**
 * 现场监控点位（2026-11-19 按现场要求重排分组）
 *
 * ## 为什么是九个点位
 *
 * 现场上游一共 20 个通道（清单见 `监控快照接口使用说明-向阳村.md`），设计稿与
 * 需求只保留这几类：**2#/4# 塔吊、地磅、钢筋加工棚、材料堆场、2#门（内外）、
 * 4#门（内外）**。其余（1#/3#/5# 门、监控A/B、场内1/2、安全讲台、门禁通道）
 * 一律不上墙 —— 点位列表是写死的白名单，不再从报警数据反推，避免「报警里
 * 出现一个通道就多一个点位」这种不可控的膨胀。
 *
 * ## 分组规则（2026-11-19 现场口径）
 *
 *   · 设备设施 —— 2#塔吊 / 4#塔吊 / 地磅全景 / 钢筋加工棚，**置顶**：
 *     这四路看的都是「设备本身的状态」，现场排查时最先要点；
 *   · 材料堆场 —— 新增点位（`34020000001320000005`），单独一组；
 *   · 出入口管控 —— 原「出入口」改名，点位与顺序不变。
 *
 * 组名与顺序只在 {@link CAM_GROUPS} 维护，组件按它渲染，不再二次排序。
 *
 * ## 为什么用 channelId 而不是 channelNo
 *
 * 这里是**两套编号**，不能混：
 *   · `channelId`：20 位 GB28181 通道号，历史抓拍接口（`/api/video/snapshots/history`）的主键；
 *   · `channelNo`：视频报警（`:8085`）里的 2 / 3 这种小数字，报警详情用它。
 * 两者之间没有可靠映射，所以监控页只认 `channelId`，报警那边继续用 `channelNo`
 * （点位名走 `CAM_PLACE`，见 `data/config.ts`）。
 *
 * ## 名字从哪来
 *
 * 逐字照服务端通道名 / 设计稿芯片文案，不自己起名：现场是拿这个名字找摄像头的。
 * 2#门的两个通道在服务端同名（都叫「2#门监控」），设计稿把它们标成
 * 「2#门监控1 / 2#门监控2」—— 这里沿用，谁在门内谁在门外只能看画面认。
 */

/** 一个监控点位 */
export interface CamPoint {
  /** 历史抓拍接口的通道号（20 位，服务端主键） */
  channelId: string
  /** 显示名：与设计稿芯片、服务端通道名逐字一致 */
  name: string
  /** 分组（与设计稿的「出入口 / 场内 / 塔吊」一致） */
  group: CamGroup
  /**
   * 单点临时覆盖用的流地址（**常态留空**）。
   *
   * 常态不需要填：每个通道的 HTTP-FLV 地址由 `data/cctv.ts` 的 `cctvFlvUrl()`
   * 按 `http://120.26.34.95:9092/rtp/{deviceId}_{channelId}.live.flv?originTypeStr=rtp_push`
   * 逐条拼出来（与现场给的模板逐字同构），改通道号即可，不必在这里抄八遍。
   *
   * 只有这两种情况才写这里：① 某台相机换了地址，其它通道不受影响；
   * ② 联调时点名指一路（比如临时挂个测试流）。
   */
  stream?: string
}

/** 分组顺序：页面从上到下就是这三组，第一组置顶（设备设施） */
export const CAM_GROUPS: CamGroup[] = ['设备设施', '材料堆场', '出入口管控']

/**
 * 九个点位。
 *
 * 顺序也照设计稿：组内按「塔吊 → 地磅 → 加工棚 → 堆场 → 门」的现场习惯排，
 * 芯片从左到右、从上到下就是这个顺序。改顺序就是改这里，不要在组件里再排一次。
 */
export const CAM_POINTS: CamPoint[] = [
  // 设备设施（置顶）：2# / 4# 塔吊、地磅、钢筋加工棚
  { channelId: '34020000001320000017', name: '2#塔吊', group: '设备设施' },
  { channelId: '34020000001320000016', name: '4#塔吊', group: '设备设施' },
  { channelId: '34020000001310000003', name: '地磅全景', group: '设备设施' },
  { channelId: '34020000001320000014', name: '钢筋加工棚', group: '设备设施' },
  // 材料堆场：2026-11-19 新增（通道在快照接口清单内，实拍 200 JPEG）
  { channelId: '34020000001320000005', name: '材料堆场', group: '材料堆场' },
  // 出入口管控：2#门（两个通道）、4#门（门内 + 门外）
  { channelId: '34020000001320000003', name: '2#门监控1', group: '出入口管控' },
  { channelId: '34020000001320000006', name: '2#门监控2', group: '出入口管控' },
  { channelId: '34020000001320000007', name: '4#门监控', group: '出入口管控' },
  { channelId: '34020000001320000004', name: '4#门外监控', group: '出入口管控' },
]

/** 按 channelId 找点位（找不到返回 undefined，调用方自己兜底） */
export function findCamPoint(channelId: string): CamPoint | undefined {
  return CAM_POINTS.find((p) => p.channelId === channelId)
}

/**
 * 智眸「设备设施」里额外插进来的两张**塔吊抓拍**（2026-11-20）。
 *
 * 顺序即展示顺序：2# 塔吊在前、4# 塔吊在后，排在「塔吊定点」那两张航拍之后。
 * `channelId` 不在这里另抄一份 —— 从 {@link CAM_POINTS} 按名字取，监控页改名 /
 * 换通道时这里跟着变；两处写死迟早会对不上。
 */
export const CRANE_SHOTS: { channelId: string; name: string }[] = ['2#塔吊', '4#塔吊']
  .map((n) => CAM_POINTS.find((p) => p.name === n))
  .filter((p): p is CamPoint => Boolean(p))
  .map((p) => ({ channelId: p.channelId, name: p.name }))

/**
 * 智眸「出入口管控」里的 5 张**历史抓拍**（2026-11-20）。
 *
 * 用户点名的 5 个来源，顺序即展示顺序 —— 这里**不做排序、不做合并**，
 * 一个来源一条、只取各自最新的一张：
 *
 *   1. 视频监控A —— 通道号用户已点明 `34020000001310000001`，名字取监控页
 *      `CCTV_CHANNELS` 里的「监控A」（同一路）。它**不在** {@link CAM_POINTS}
 *      那 9 个白名单里（白名单只上墙塔吊 / 地磅 / 加工棚 / 堆场 / 四个门），
 *      所以这一条不能按名字从 `CAM_POINTS` 里找；
 *   2. 视频监控-2#门监控1 → `CAM_POINTS` 的「2#门监控1」；
 *   3. 2#门监控2；
 *   4. 4#门监控；
 *   5. 4#门外监控。
 *
 * 后四条一律**按名字**从 `CAM_POINTS` 取 channelId，不在这里另抄一份通道号：
 * 监控页改名 / 换通道时这里跟着变，两处写死迟早对不上。名字对不上时
 * `channelId` 留空，取图那一步直接跳过（宁可少一张，也不猜个通道号去拍）。
 */
const GATE_SHOT_SOURCES: { name: string; channelId?: string }[] = [
  { name: '监控A', channelId: '34020000001310000001' },
  { name: '2#门监控1' },
  { name: '2#门监控2' },
  { name: '4#门监控' },
  { name: '4#门外监控' },
]

export const GATE_SHOTS: { channelId: string; name: string }[] = GATE_SHOT_SOURCES.map((s) => {
  // 点明了通道号的：名字以 `CCTV_CHANNELS` 为准（现场靠这个名字找摄像头）
  if (s.channelId) {
    const cctv = CCTV_CHANNELS.find((c) => c.channelId === s.channelId)
    return { channelId: s.channelId, name: cctv?.name ?? s.name }
  }
  const p = CAM_POINTS.find((c) => c.name === s.name)
  return { channelId: p?.channelId ?? '', name: p?.name ?? s.name }
})
