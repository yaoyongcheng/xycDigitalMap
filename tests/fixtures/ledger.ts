import type { DeviceInfoRow } from '@/api/data'

/**
 * 设备台账夹具（`GET :8084/api/data/deviceinfos?project_id=P000000076` 的真实形状）
 *
 * 取自 2026-11-11 现场返回：本项目 8 台设备，`device_info.extra_fields` 是
 * **JSON 字符串**（不是数组），无人机那台为空串。测试里刻意保留这几点脏数据
 * （数字型 value、空 extra_fields、名字里带「传统」而不是「智能」），
 * 用来钉住映射层的容错，而不是喂一份理想数据。
 */
export function deviceRows(): DeviceInfoRow[] {
  const row = (
    id: number,
    name: string,
    online: number,
    extra: { label: string; value: string | number }[],
    updated = '2026-09-10 17:35:58',
  ): DeviceInfoRow => ({
    id,
    project_id: 'P000000076',
    device_name: name,
    online_status: online,
    device_info: {
      // 故意做成字符串：服务端就是这么给的
      extra_fields: extra.length ? JSON.stringify(extra) : '',
      responsible_person: '1',
      status_text: online === 1 ? '在线' : '离线',
      update_time: updated,
    },
  })

  return [
    row(100, '智能电梯2', 1, [{ label: '高度', value: 30 }, { label: '安检有效期', value: '2026-12-10' }], '2026-09-17 19:11:23'),
    row(99, '2#智能爬架', 1, [{ label: '爬升高度', value: 21 }], '2026-09-23 10:53:57'),
    row(78, '智能电梯1', 1, [{ label: '高度', value: 60 }, { label: '安检有效期', value: '2026-12-10' }]),
    row(70, '传统塔机5', 1, [
      { label: '高度', value: 10.3 },
      { label: '安检有效期', value: '2026-12-10' },
      { label: '质检报告状态', value: '正常' },
      { label: '塔吊司机', value: '机师' },
    ]),
    row(69, '智能塔机4', 1, [
      { label: '高度', value: 70 },
      { label: '安检有效期', value: '2026-12-10' },
      { label: '质检报告状态', value: '正常' },
      { label: '塔吊司机', value: '机师' },
    ]),
    row(68, '智能塔机3', 0, [
      { label: '高度', value: 32.5 },
      { label: '安检有效期', value: '2026-12-10' },
      { label: '质检报告状态', value: '正常' },
      { label: '塔吊司机', value: '机师' },
    ]),
    row(67, '智能塔机2', 1, [
      { label: '高度', value: 64 },
      { label: '安检有效期', value: '2026-12-10' },
      { label: '质检报告状态', value: '正常' },
      { label: '塔吊司机', value: '机师' },
    ]),
    row(55, '无人机', 1, []),
  ]
}

/** 台账接口的成功信封（给 fetch 打桩用） */
export function ledgerEnvelope(rows: DeviceInfoRow[] = deviceRows()): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 200, message: 'success', data: { list: rows, total: rows.length } }),
  } as unknown as Response
}
