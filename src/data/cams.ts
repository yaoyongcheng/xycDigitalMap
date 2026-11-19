import type { CamGroup } from '@/types'

/**
 * 现场监控点位（2026-11-18 按设计稿收口）
 *
 * ## 只有八个点位，为什么
 *
 * 现场上游一共 20 个通道（清单见 `监控快照接口使用说明-向阳村.md`），但设计稿与
 * 需求只保留这几类：**塔机（2#/4#塔吊）、地磅、钢筋加工棚、2#门（内外）、4#门（内外）**。
 * 其余（1#/3#/5# 门、监控A/B、场内1/2、安全讲台、门禁通道）一律不上墙 ——
 * 点位列表是写死的白名单，不再从报警数据反推，避免「报警里出现一个通道就多一个
 * 点位」这种不可控的膨胀。
 *
 * ## 为什么用 channelId 而不是 channelNo
 *
 * 这里是**两套编号**，不能混：
 *   · `channelId`：20 位 GB28181 通道号，快照接口（`/api/video/snapshots`）的主键；
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
  /** 快照接口的通道号（20 位，服务端主键） */
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

/** 分组顺序：设计稿从上到下就是这三组 */
export const CAM_GROUPS: CamGroup[] = ['出入口', '场内', '塔吊']

/**
 * 八个点位。
 *
 * 顺序也照设计稿：组内按「门 → 场内 → 塔吊」的现场习惯排，芯片从左到右、
 * 从上到下就是这个顺序。改顺序就是改这里，不要在组件里再排一次。
 */
export const CAM_POINTS: CamPoint[] = [
  // 出入口：2#门（两个通道）、4#门（门内 + 门外）
  { channelId: '34020000001320000003', name: '2#门监控1', group: '出入口' },
  { channelId: '34020000001320000006', name: '2#门监控2', group: '出入口' },
  { channelId: '34020000001320000007', name: '4#门监控', group: '出入口' },
  { channelId: '34020000001320000004', name: '4#门外监控', group: '出入口' },
  // 场内：地磅 + 钢筋加工棚
  { channelId: '34020000001310000003', name: '地磅全景', group: '场内' },
  { channelId: '34020000001320000014', name: '钢筋加工棚', group: '场内' },
  // 塔吊：2# / 4#
  { channelId: '34020000001320000017', name: '2#塔吊', group: '塔吊' },
  { channelId: '34020000001320000016', name: '4#塔吊', group: '塔吊' },
]

/** 按 channelId 找点位（找不到返回 undefined，调用方自己兜底） */
export function findCamPoint(channelId: string): CamPoint | undefined {
  return CAM_POINTS.find((p) => p.channelId === channelId)
}
