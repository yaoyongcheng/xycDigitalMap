/**
 * 全景图判定 + 环视角度数学（2026-11-16）
 *
 * ## 为什么靠「宽高比」判定，而不是靠字段
 *
 * keehang 的媒体接口只回 `name / path / size / mediaType / url / thumbnail`，
 * **没有「这是全景图」的字段**；`/task/list` 的 15 条航线 `taskType` 也全是
 * `AIRLINE`（连「全景 / 正射 / 三维」这种维度都没有，`resourceType` 全是
 * `AIR_LINE`）。所以「它是不是全景」只能从图本身的几何形状判断：
 *
 * 球面全景（等距圆柱投影 / equirectangular）展开成平面后必然是 **2:1** ——
 * 水平 360°、垂直 180°。手机直拍是 4:3、宽幅拼接是 16:9，都落不进
 * 1.9~2.1 这个区间。
 *
 * 实测（2026-11-16，本项目 12 条航线逐条抽样）：全景 / 正射 / 三维 / 各类
 * 定点，全部是 4032×3024 或 4000×3000 —— **目前平台里一张真全景都没有**。
 * 所以这里的判定是「来了就自动认出来」，而不是"先把按钮画上去"。
 *
 * ## 角度约定
 *
 * `yaw` 绕 Y 轴（左右环视，0~360 循环）、`pitch` 上下俯仰（±85°，留 5° 余量
 * 免得视线越过天顶翻面）、`fov` 垂直视场角（越小越"望远镜"）。
 * 三者都只在这一个文件里做归一化，组件只管把原始位移丢过来。
 */

/** 2:1 的容差下限（再窄就是普通宽幅照片） */
export const PANO_MIN_RATIO = 1.9
/** 2:1 的容差上限 */
export const PANO_MAX_RATIO = 2.1
/**
 * 宽度的下限：400×200 的图也是 2:1，但它不可能是全景。
 * 取 1024 是因为缩略图最小一侧也有这个量级，放大图则 4000 起步。
 */
export const PANO_MIN_WIDTH = 1024

/** 俯仰上限：±85°，避免视线穿过天顶后画面翻转 */
export const PITCH_LIMIT = 85
/** 视场角范围（度）：25° 相当于长焦细看，100° 已经有大广角的拉伸感 */
export const FOV_MIN = 25
export const FOV_MAX = 100

/**
 * 是否球面全景（等距圆柱投影）。
 *
 * 只吃正整数尺寸；拿不到尺寸（图还没加载完）时一律 `false` —— 宁可先按
 * 平面看，也不能把普通照片塞进球面里（那会看到一圈拉伸的畸形画面）。
 */
export function isEquirect(w: number, h: number): boolean {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false
  if (w < PANO_MIN_WIDTH) return false
  const ratio = w / h
  return ratio >= PANO_MIN_RATIO && ratio <= PANO_MAX_RATIO
}

/** 俯仰夹到 ±85° */
export function clampPitch(deg: number): number {
  return Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, deg))
}

/** 水平角归一到 [0, 360)，长时间连续拖动也不会让数值无限增长 */
export function wrapYaw(deg: number): number {
  const r = deg % 360
  return r < 0 ? r + 360 : r
}

/** 视场角夹到 [FOV_MIN, FOV_MAX] */
export function clampFov(deg: number): number {
  return Math.min(FOV_MAX, Math.max(FOV_MIN, deg))
}

/**
 * 拖动一个像素对应多少度。
 *
 * 用**垂直**视场角去除以视口高度：屏幕上像素是正方形的，所以水平方向
 * 一像素对应的角度与垂直方向相同（差别只在透视投影的边角畸变里，拖动
 * 手感按这个算最自然，Google 街景也是这个模型）。
 */
export function degPerPixel(fovDeg: number, viewportH: number): number {
  if (!(viewportH > 0)) return 0
  return clampFov(fovDeg) / viewportH
}
