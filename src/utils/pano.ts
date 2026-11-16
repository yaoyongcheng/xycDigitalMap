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
 * 实测（2026-11-16，本项目 12 条航线逐条抽样）：媒体接口里的原片全是
 * 4032×3024 或 4000×3000，**一条 2:1 都没有** —— 真正的拼接成果不在这里，
 * 而在重建成果接口（`/dashboard/recreate/*`，`origin.jpg` 是 10000×5000）。
 * 所以这里的判定守的是"万一来了就自动认出来"，智眸的「项目全景」不走它
 * （那条链见 `stores/patrol.ts` 的 `loadPano`）。
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

/**
 * 航线/成果名 → 界面标题。
 *
 * 服务端的任务名末尾挂着执行记录 id：`光谷元著-全景_202611151300181656`、
 * `向阳村-全景_202611151130181616`。那串数字在界面上没有任何意义（同一站点
 * 每天换一个），只把前段留下来 —— 前段正好就是「站点 + 任务类型」，拿它当
 * 卡片标题比「项目全景」更有信息量，也能一眼看出是哪片工地。
 */
export function panoLabel(taskName: string): string {
  return String(taskName ?? '').replace(/_\d{6,}$/, '')
}

/**
 * 贴图上传的像素预算上限：18M 像素 ≈ 72MB 显存（开 mipmap 再 +33%）。
 *
 * 现场的 `origin.jpg` 是 **10000×5000 = 50M 像素**，按 RGBA 算接近 190MB。
 * 手机 GPU 根本扛不住，低端机直接被杀进程。
 */
export const PANO_TEX_MAX_PX = 18_000_000

/**
 * 给 WebGL 贴图算一个安全的缩放比（≤1）。
 *
 * 有两个硬约束，取更紧的那个：
 * 1. **边长 ≤ `maxSide`**（`gl.MAX_TEXTURE_SIZE`）。手机上普遍是 4096~8192，
 *    桌面才常见 16384。超限时 `texImage2D` 直接报 INVALID_VALUE、贴图保持
 *    不完整 —— 表现不是"糊"而是**整屏黑**，而且不同机型表现不一致，很难查。
 * 2. **总像素 ≤ 预算**。刚好卡在上限内（例如 8192×4096）也要 134MB，加上
 *    mipmap 后仍然会 OOM。
 *
 * 缩到 8192×4096 约 22.7 px/度；手机在 75° 视场、600px 高的弹层里（按 dpr 2
 * 算约 16 px/度）已经够用，看不出和原图的差别。
 */
export function panoTexScale(
  w: number,
  h: number,
  maxSide: number,
  maxPx: number = PANO_TEX_MAX_PX,
): number {
  if (!(w > 0) || !(h > 0)) return 1
  const side = Number.isFinite(maxSide) && maxSide > 0 ? maxSide : 4096
  const bySide = side / Math.max(w, h)
  const byPx = Math.sqrt((maxPx > 0 ? maxPx : PANO_TEX_MAX_PX) / (w * h))
  return Math.max(0.01, Math.min(1, bySide, byPx))
}
