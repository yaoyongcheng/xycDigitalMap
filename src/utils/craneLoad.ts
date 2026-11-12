/**
 * 塔机负荷率归一（报文 `weightRate` → 卡片上的百分比）
 *
 * ## 为什么需要一层归一
 *
 * `weightRate` 在塔机平台协议里没有公开的单位说明。两种写法都见过：
 *   · **比值** 0~1（与 Unity `Image.fillAmount` 同口径）→ 0.36 表示 36%；
 *   · **百分数** 0~100 → 36 表示 36%。
 *
 * 现场报文当前一直是 `0.0`（空钩），没法用真实数据反推。所以这里按
 * 「≤ 1 当比值、> 1 当百分数」的启发式处理 —— 它只在 0~1% 这一小段有歧义
 * （0.5 到底算 50% 还是 0.5%），实际吊装负荷不会停在那里。
 *
 * 宁可显示一个可能偏高的数，也不显示「—」：负荷是现场最需要盯的数，
 * 一直拿不到比偶尔差一倍更糟。**但超出 100% 一律截到 100**，
 * 进度条不允许溢出（超载会另有告警，不靠这条粉色条表达）。
 *
 * ## 约定
 *
 * 入参 `null` / `undefined` / 非有限数 → 返回 `null`，调用方显示「—」。
 * 返回 0~100 的整数（取整与卡片文案 `36%` 一致）。
 */
export function loadPct(weightRate: number | null | undefined): number | null {
  if (weightRate === null || weightRate === undefined) return null
  if (!Number.isFinite(weightRate)) return null
  if (weightRate <= 0) return 0
  const pct = weightRate <= 1 ? weightRate * 100 : weightRate
  return Math.min(100, Math.round(pct))
}
