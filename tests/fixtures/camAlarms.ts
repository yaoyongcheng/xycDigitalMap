import { addDays, dateKey } from '@/utils/date'
import type { Alarm } from '@/types'

/**
 * 监控点位 / 报警抓拍的测试夹具（2026-11 阶段 5）
 *
 * 现场 `:8085` 的报警行带 `channelNo`，`stores/cam.ts` 按它派生真实点位。
 * 这里造一份形状确定的数据：今天 2 号通道 3 条（够测抓拍网格与大图元信息）、
 * 3 号通道 1 条（够测切换点位），昨天 2 号通道 1 条（够测按日筛选）。
 *
 * 日期按「系统当前日」派生，配合 `vi.setSystemTime()` 不会跨天失效。
 * id 用 `va-` 前缀（与真实接口一致），`remoteIdOf` 才能解析出服务端 Id。
 */
export function camAlarmFixtures(): Alarm[] {
  const today = dateKey(new Date())
  const yesterday = dateKey(addDays(new Date(), -1))
  const mk = (id: string, at: string, channelNo: number, handleStatus = 0): Alarm => ({
    id: `va-${id}`,
    day: 'today',
    src: 'cam',
    type: '反光衣检测',
    title: '防护报警',
    desc: `反光衣检测 · ${channelNo}号通道抓拍`,
    img: '',
    rel: '',
    at,
    geo: '',
    channelNo,
    handleStatus,
  })

  return [
    mk('101', `${today} 08:12:00`, 2),
    mk('102', `${today} 12:36:00`, 2),
    mk('103', `${today} 16:50:00`, 2),
    mk('104', `${today} 09:05:00`, 3),
    mk('105', `${yesterday} 10:00:00`, 2),
  ]
}
