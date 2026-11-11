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
 * 关键词兜底（真实视频报警用）。
 *
 * 上面的精确表只覆盖演示数据那 4 个名字；接口下发的名字是「反光衣检测」
 * 「区域入侵检测」这类具体称呼，精确匹配全部落空 → 全部变最低档蓝色，
 * 于是一条「人员打架」和一条「客流量统计」视觉重量相等。按后果分档：
 *   · 人身防护 / 暴力 / 火灾 → guard（红）
 *   · 用电 / 消防设施 / 岗位失守 → power（橙）
 *   · 环境扬尘 / 排污 → dust（琥珀）
 *   · 其余（统计、交通、文明施工）→ env（蓝）
 */
const TONE_RULES: { re: RegExp; tone: AlarmTone }[] = [
  { re: /安全帽|工帽|安全网|安全带|反光衣|工服|手套|口罩|临边|防护|护栏|洞口|未佩戴|未带头盔/, tone: 'guard' },
  { re: /烟火|火|烟|摔倒|打架|持械|入侵|越界|超员|周界/, tone: 'guard' },
  { re: /电缆|电线|用电|漏电|私拉|拖地|消防|灭火器|消防栓|离岗|睡岗|遮挡|位移/, tone: 'power' },
  { re: /裸土|扬尘|覆盖|渣土|洒水|苫盖|堆场|抛洒|排污|水质/, tone: 'dust' },
]

/**
 * @param type 预警类型（Alarm.type）。未知类型按最低档处理 ——
 *             宁可弱化，也不要给一条不知道是什么的预警染上最高警报色。
 */
export function alarmTone(type: string): AlarmTone {
  const exact = TONE_BY_TYPE[type]
  if (exact) return exact
  const s = (type || '').trim()
  return TONE_RULES.find((r) => r.re.test(s))?.tone ?? 'env'
}
