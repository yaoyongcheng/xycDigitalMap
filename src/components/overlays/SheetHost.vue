<script setup lang="ts">
import { computed } from 'vue'

import BottomSheet from '@/components/ui/BottomSheet.vue'
import DeviceHistorySheet from '@/components/sheets/DeviceHistorySheet.vue'
import DeviceInfoSheet from '@/components/sheets/DeviceInfoSheet.vue'
import PatrolSheet from '@/components/sheets/PatrolSheet.vue'
import PeopleDistSheet from '@/components/sheets/PeopleDistSheet.vue'
import UavRouteSheet from '@/components/sheets/UavRouteSheet.vue'
import UavTodaySheet from '@/components/sheets/UavTodaySheet.vue'
import { deviceSet } from '@/data/device'
import { LIFT_CAGES } from '@/data/liftSn'
import { useBottomSheetStore } from '@/stores/bottomSheet'
import { useOverviewStore } from '@/stores/overview'
import { PANO_SHEET_ID, usePatrolStore } from '@/stores/patrol'
import { useUavStore } from '@/stores/uav'
import { panoLabel } from '@/utils/pano'

/**
 * 弹层宿主（2026-10 版本同步 · 第一批建立，第四批补齐内容）
 *
 * 全站只有一个弹层实例，挂在外壳里；内容按 store 的 kind 分发。
 * 新增一种内容 = 加一条 import + 一个分支，不牵动调用方。
 *
 * 为什么标题放在宿主而不是内容组件里：原版的标题行对所有内容都是同一套
 * （标题 + 右侧计数 + 关闭），放在外壳里才能保证几种内容的标题排版一致；
 * 各内容只负责标题下面那块。
 */
const sheet = useBottomSheetStore()
const patrol = usePatrolStore()
const overview = useOverviewStore()
const uav = useUavStore()

/**
 * 人员分布弹层对应的场景（kind 为 people-dist 时有效）。
 *
 * 按 store 里的 name 现查 `overview.scenes`，不缓存对象 —— 首页每 60s 左右会
 * 重新拉一次在场人员，弹层开着时数字也跟着更新。
 */
const peopleScene = computed(() =>
  sheet.kind === 'people-dist' ? overview.scenes.find((s) => s.name === sheet.id) : undefined,
)

/** 副标题：「有人 2 层 · 共 5 层」/ 场布图是「有人 2 个 · 共 3 个管控区」 */
const peopleSub = computed(() => {
  const s = peopleScene.value
  if (!s) return ''
  const live = s.units.filter((u) => u.count > 0).length
  const all = s.units.length
  return s.name === '场布图'
    ? `有人 ${live} 个 · 共${all}个管控区`
    : `有人 ${live} 层 · 共${all}层`
})

/** 当前巡检照片（kind 为 patrol 时有效；2026-11 阶段 8 起是真实航拍照片） */
const photo = computed(() => {
  if (sheet.kind !== 'patrol') return undefined
  // 走 store 的 `photoById`：六格（照片墙 / 全景航拍 / 材料堆场 / 设备设施 /
  // 安全巡查 / 出入口管控）各存一个数组，只查 `photos` 会让后面几格的标题
  // 退成「照片」——塔吊抓拍、门禁抓拍都是这么点开的
  return patrol.photoById(sheet.id)
})

/** 当前设备详情机组（device-info / device-history 时有效） */
const deviceUnit = computed(() => {
  const kind = sheet.view?.device
  if (!kind) return undefined
  const { units } = deviceSet(kind)
  return units.find((u) => u.id === sheet.id) ?? units[0]
})

const TITLES: Record<string, string> = {
  'device-info': '设备信息',
  'device-history': '历史数据',
  'uav-today': '今日任务',
  'uav-route': '选择航线',
}

const title = computed(() => {
  // 人员分布：标题就是分类名（场布图 / 2#住宅楼 / 地下室）
  if (sheet.kind === 'people-dist') return sheet.id || '人员分布'
  if (sheet.kind === 'patrol') {
    // 全景来自重建成果，标题用「站点-全景」（服务端名字末尾那串记录 id 去掉，
    // 见 utils/pano.ts 的 panoLabel）；文件名的 `_0.jpg` 对用户没有意义
    if (sheet.id === PANO_SHEET_ID) return (patrol.pano && panoLabel(patrol.pano.taskName)) || '项目全景'
    return photo.value?.name ?? '照片'
  }
  return (sheet.kind && TITLES[sheet.kind]) || '明细'
})

const subtitle = computed(() => {
  // 人员分布：有人几层 / 共几层，与 V2 那个浮层同一句
  if (sheet.kind === 'people-dist') return peopleSub.value
  // 今日任务：把清单条数写出来。它必须等于「任务管理」卡上的「今日任务」
  // （2026-11-24 用户要求「永远一致」），写在标题下就是为了对不上时一眼能看见
  if (sheet.kind === 'uav-today') return `共 ${uav.todayTasks.length} 条`
  // 巡检大图不设副标题：分类 / 来源 / 时间都在下面的 meta 三行里，
  // 标题行再来一遍就是同一句话写两次
  if (sheet.kind === 'patrol') return ''
  // 电梯按轿厢出卡，副标题用轿厢名（台账行只有「1#楼电梯」这种按楼的登记名）
  if (sheet.view?.sn) {
    const cage = LIFT_CAGES.find((c) => c.sn === sheet.view?.sn)
    // 副标题用展示名（带楼栋前缀），与卡片标题、报表行名同一份文案
    if (cage) return cage.display
  }
  if (sheet.kind === 'device-history' || sheet.kind === 'device-info')
    return deviceUnit.value?.name ?? ''
  return ''
})
</script>

<template>
  <BottomSheet v-if="sheet.isOpen" :title="title" :subtitle="subtitle" @close="sheet.close()">
    <!-- 人员分布：标题右侧补一个总人数（与 V2 浮层「4人 ×」同款） -->
    <template v-if="sheet.kind === 'people-dist'" #meta>
      <b class="pd-count">{{ peopleScene?.count ?? 0 }}<i>人</i></b>
    </template>

    <PatrolSheet v-if="sheet.kind === 'patrol'" :id="sheet.id" />

    <PeopleDistSheet v-else-if="sheet.kind === 'people-dist'" :name="sheet.id" />

    <DeviceInfoSheet
      v-else-if="sheet.kind === 'device-info' && sheet.view?.device"
      :device="sheet.view.device"
      :id="sheet.id"
      :sn="sheet.view.sn"
    />

    <DeviceHistorySheet
      v-else-if="sheet.kind === 'device-history' && sheet.view?.device"
      :device="sheet.view.device"
      :id="sheet.id"
    />

    <UavTodaySheet v-else-if="sheet.kind === 'uav-today'" />

    <UavRouteSheet v-else-if="sheet.kind === 'uav-route'" />
  </BottomSheet>
</template>
