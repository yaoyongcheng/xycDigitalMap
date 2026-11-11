import { addDays, dateKey, formatMD, startOfDay } from '@/utils/date'
import type { Alarm } from '@/types'

/**
 * 报警测试夹具（2026-11）
 *
 * 这 8 条原本是 `stores/alarm.ts` 内置的演示种子 —— 接口没通时会被当成真实
 * 数据展示，现场拿它去对账会对不上。数据层收口后 store 只存接口数据，
 * 种子退化成纯测试夹具：交互、撒点、详情页的用例靠它构造一份确定的数据。
 *
 * 日期一律按「距今天多少天」派生（不是写死年月日），所以用例推进系统时间时
 * 夹具跟着走，不会在跨天/跨月时突然失效。
 */
export function alarmFixtures(): Alarm[] {
  const base = startOfDay(new Date())
  const at = (off: number, hm: string): string => `${dateKey(addDays(base, off))} ${hm}:00`
  const rel = (off: number, hm: string): string =>
    off === 0 ? `今天 ${hm}` : off === -1 ? `昨天 ${hm}` : `${formatMD(addDays(base, off))} ${hm}`

  return [
    { id: 'trash', day: 'today', src: 'drone', type: '道路垃圾', title: '环境报警', desc: '场区道路发现垃圾堆放未清理！', img: 'img/alarm-trash.webp', rel: '1分钟前', at: at(0, '15:21'), geo: '114.24751233100210,30.53310211883421', pin: [32, 78], flat: [34, 86] },
    { id: 'cable', day: 'today', src: 'cam', type: '电缆拖地', title: '用电报警', desc: '作业面电缆拖地未架空，存在触电隐患！', img: 'img/alarm-cable.webp', rel: '3分钟前', at: at(0, '15:19'), geo: '114.24738810244102,30.53290155210933', pin: [48, 56], flat: [46, 40] },
    { id: 'net', day: 'today', src: 'snap', type: '安全网缺失', title: '防护报警', desc: '楼层临边安全网缺失，请立即整改！', img: 'img/alarm-net.webp', rel: '12分钟前', at: at(0, '15:10'), geo: '114.24742027911455,30.53296304904549', pin: [22, 48, 'left'], flat: [20, 34, 'left'] },
    { id: 'soil', day: 'today', src: 'drone', type: '裸土未覆盖', title: '扬尘报警', desc: '场区裸土未覆盖，扬尘风险较高！', img: 'img/alarm-soil.webp', rel: '1小时前', at: at(0, '14:22'), geo: '114.24760188412003,30.53322190771208', pin: [66, 62], flat: [60, 26] },
    { id: 'h-net', day: 'hist', src: 'snap', type: '安全网缺失', title: '防护报警', desc: '3#楼作业面临边安全网破损缺失。', img: 'img/alarm-net.webp', rel: rel(-1, '09:30'), at: at(-1, '09:30'), geo: '114.24742027911455,30.53296304904549' },
    { id: 'h-trash', day: 'hist', src: 'drone', type: '道路垃圾', title: '环境报警', desc: '场区北侧道路垃圾堆放未及时清运。', img: 'img/alarm-trash.webp', rel: rel(-2, '16:20'), at: at(-2, '16:20'), geo: '114.24749822001145,30.53308044122890' },
    { id: 'h-cable', day: 'hist', src: 'cam', type: '电缆拖地', title: '用电报警', desc: '钢筋加工区电缆拖地，存在漏电风险。', img: 'img/alarm-cable.webp', rel: rel(-3, '11:08'), at: at(-3, '11:08'), geo: '114.24735501988210,30.53284411902341' },
    { id: 'h-soil', day: 'hist', src: 'drone', type: '裸土未覆盖', title: '扬尘报警', desc: '基坑周边裸土未覆盖，扬尘超标。', img: 'img/alarm-soil.webp', rel: rel(-4, '08:46'), at: at(-4, '08:46'), geo: '114.24757700124480,30.53319822009112' },
  ]
}
