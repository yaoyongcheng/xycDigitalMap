/**
 * 预警类型 → 风险色
 *
 * 改造前 4 类预警在列表里长得一模一样，只有文案不同：一条「电缆拖地」
 * 和一条「道路垃圾」的视觉重量完全相等，扫一眼分不出哪条该先处理。
 *
 * 分档依据是现场后果的严重程度，不是类型名称的字面分类：
 *   guard  安全网缺失  临边坠落 → 最高，红
 *   power  电缆拖地    触电     → 高，橙
 *   dust   裸土未覆盖  扬尘环保 → 中，琥珀
 *   env    道路垃圾    文明施工 → 低，蓝（信息色，不抢注意力）
 *
 * 刻意只做四档、且全部沿用既有深色调色板里的颜色：新增色会让首页
 * 那套已经很满的蓝色系再散一档，反而更乱。
 */
export type AlarmTone = 'guard' | 'power' | 'dust' | 'env'

const TONE_BY_TYPE: Record<string, AlarmTone> = {
  安全网缺失: 'guard',
  电缆拖地: 'power',
  裸土未覆盖: 'dust',
  道路垃圾: 'env',
}

/**
 * @param type 预警类型（Alarm.type）。未知类型按最低档处理 ——
 *             宁可弱化，也不要给一条不知道是什么的预警染上最高警报色。
 */
export function alarmTone(type: string): AlarmTone {
  return TONE_BY_TYPE[type] ?? 'env'
}
