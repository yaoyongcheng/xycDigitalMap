/**
 * 塔机当前负荷率（`当前吊重 ÷ 额定起重量`）
 *
 * ## 口径（2026-11-24 现场改定）
 *
 * 卡片上的「当前负荷」**不再取报文 `weightRate`**，改用同一张卡片上
 * 「当前吊重」那一格的读数除以额定起重量：
 *
 * ```
 * 当前负荷 = round(当前吊重 / CRANE_RATED_T * 100)%
 * ```
 *
 * 改这个口径的原因很直接：`weightRate` 是平台侧算的另一个数，现场看到的
 * 是「当前吊重 0.07t / 当前负荷 2%」这种配对 —— 0.07 ÷ 5 明明只有 1%，
 * 两个数摆在一起就像哪个错了。现在分子与「当前吊重」格是同一个 `weight`，
 * 卡片上的两个数永远自洽，进度条也用同一个返回值，不会出现「写 2% 却画 3%」。
 *
 * ## 常量
 *
 * `CRANE_RATED_T` = 5t：现场三台智能塔机的铭牌额定起重量。将来若有不同吨位
 * 的塔机混在同一屏，把额定值挪进台账/`data/craneSn.ts` 按 sn 取，改这一处即可
 * —— 调用点已经留了 `rated` 形参。
 *
 * ## 约定
 *
 * · 无实时帧（`null` / `undefined` / 非有限数）→ 返回 `null`，调用方写「—」
 *   且**不画进度条**（「没有数据」不该画成「负荷为零」）；
 * · 吊重 ≤ 0 → 0（空钩是结论，不是没数据）；
 * · 四舍五入到整数，0.07t → 1%；
 * · 超 100% 截到 100：进度条不允许溢出，超载另有告警，不靠这条条表达。
 *
 * 报文里的 `weightRate` 仍原样保留在类型与解析层（协议字段，解析不猜），
 * 只是不再参与卡片计算 —— 它单位有歧义（比值 0~1 还是百分数 0~100），
 * 而「吊重 ÷ 额定」没有歧义。
 */

/** 额定起重量（t）。现场三台智能塔机铭牌值，改吨位只需改这里 */
export const CRANE_RATED_T = 5

/**
 * 当前吊重 → 负荷百分比（0~100 的整数）。
 *
 * @param weight 实时报文里的当前吊重（t），也就是卡片「当前吊重」格那个数
 * @param rated  额定起重量（t），默认 `CRANE_RATED_T`
 */
export function craneLoadPct(
  weight: number | null | undefined,
  rated: number = CRANE_RATED_T,
): number | null {
  if (weight === null || weight === undefined) return null
  if (!Number.isFinite(weight)) return null
  if (!Number.isFinite(rated) || rated <= 0) return null
  if (weight <= 0) return 0
  return Math.min(100, Math.round((weight / rated) * 100))
}
