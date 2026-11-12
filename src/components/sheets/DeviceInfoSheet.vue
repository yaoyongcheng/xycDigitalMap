<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'

import { craneSnOf } from '@/data/craneSn'
import { deviceSet } from '@/data/device'
import { useCraneRealtimeStore } from '@/stores/craneRealtime'
import { unitNo } from '@/utils/deviceLedger'
import type { DeviceUnit } from '@/types'

/**
 * 设备信息弹层
 *
 * ## 塔机：照 V2「塔机弹窗」的两段、两段各固定几行
 *
 * V2 客户端 `UIView 塔机 / Level2 / 塔机弹窗` 预制体（2026-11-12 用 UnityPy 从
 * 场景包 `cb4440f6…` 里读出节点树与 `UIPanelCrane` 的序列化字段）里就是：
 *
 * ```
 * Title1 基本信息    ：当前状态 / 塔机编号 / 塔机高度 / 安检有效期
 *                      质检报告状态 / 司机 / 功效      ← 7 行，一行不多
 * Title2 实时工况信息 ：实时回转 / 实时幅度 / 实时高度 / 实时时间   ← 4 行
 * ```
 *
 * 每行默认值都是 `'--'`，**没有说明行、没有「是否隐藏」「更新时间」这类台账技术字段**。
 * 所以这里也只渲染这 7 + 4 行：台账 `extra_fields` 里多出来的字段不再往弹层尾部追加。
 *
 * ## 各行的数据源
 *
 * | 行 | 来源 |
 * |---|---|
 * | 当前状态 | **实时四态**（离线 / 待机 / 工作中 / 正在吊装），照 `CraneModel.GetTowerState`；通道没通才回落台账 `status_text` |
 * | 塔机编号 | `data/craneSn.ts` 按台号映射的平台 sn（台账没有编号字段） |
 * | 塔机高度 | **实时报文的 `bodyHeight`**，没有帧就是「—」（不回落台账） |
 * | 安检有效期 / 质检报告状态 / 司机 | 台账 `extra_fields` |
 * | 功效 | 台账 `extra_fields`（智能塔机键名是「功效」，传统塔机5 是「功效统计信息」） |
 * | 实时回转 / 幅度 / 高度 / 时间 | MQTT 报文的 `angle` / `range` / `height` / `monitorDateTime` |
 *
 * **「塔机高度」为什么不用台账的「高度」**：dll 里 `UIPanelCrane.txtHeight` 与
 * `bodyHeight` 相邻绑定，V2 弹层显示智能塔机2 = 42.00m，而台账写的是 64 ——
 * 42.00 正是报文的 `bodyHeight`。台账那个「高度」在 V2 弹层里根本没有对应控件。
 * 因此没有实时帧时这里也给「—」，而不是拿台账值冒充实时高度。
 *
 * ## 传统塔机5 怎么处理（与 V2 的**逻辑**一致，不复制它的显示残留）
 *
 * V2 场景里它是一台正常的 `BuildingCrane`（`friendlyName = 传统塔机5`，
 * `buildingType = 31`），能点开同一个塔机弹窗；但 `TowerCraneController.deviceSn`
 * 是**空字符串**。V2 的弹层因此出现两件事（IL 实证，见 docs/api-migration.md 第 13 节 (12)）：
 *
 *   1. `UpdateOnlineState → CraneModel.GetTowerState("")` → `GetData("")` 为 null
 *      → 状态文案 **「离线」**（不是台账的 online_status）。本项目照此。
 *   2. `UpdateRealtimeInfo` 里 `GetData(curData.no)` 同样是 null 时**直接 return、
 *      不把四个文本清空** → 面板上留着上一次打开的那台塔机的编号/高度/四行读数。
 *      所以 V2 截图里「传统塔机5」显示 EW4 的编号和 67.50m/111.43°，那是
 *      **上一台车（智能塔机4）的残留值**，不是传统塔机5 的数据 ——
 *      冷启动直接点它会显示 `--`。
 *
 * 本项目不复制这个残留 bug（我们每台车一个弹层实例，也没有「上一台」可以残留）：
 * 编号 / 塔机高度 / 实时工况四行一律「—」，只有「当前状态」是 **离线**。
 *
 * ## 电梯
 *
 * V2 的升降机弹窗是「基本信息（当前状态/升降机编号）+ 实时工况信息（楼层/高度/
 * 人数/载重 + 四项今日累计）」两段，实时那段的源是 IOT `EVENT_WORKDATA`
 * （本项目 `status:11 权限不足`，未接）。当前仍按台账平铺，只过滤掉
 * 「是否隐藏」「更新时间」这两个纯后台技术字段。
 */
const props = defineProps<{ device: 'crane' | 'lift'; id: string }>()

const unit = computed<DeviceUnit | undefined>(() =>
  deviceSet(props.device).units.find((u) => u.id === props.id),
)

const isCrane = computed(() => props.device === 'crane')

/** V2 `DataContent2` 的四行，顺序照预制体 */
const LIVE_ROWS = ['实时回转', '实时幅度', '实时高度', '实时时间'] as const

/** 「—」统一成一个常量：空值、无来源、无权限都用它，不写 0、不写「暂无」 */
const DASH = '—'

/**
 * 台账里只给后台看的技术字段，V2 任何弹层都不展示。
 * 只影响「是否要出现在弹层」，不影响台账本身与卡片取值。
 */
const TECH_FIELDS = new Set(['是否隐藏', '更新时间'])

const crane = useCraneRealtimeStore()
const sn = computed(() => (isCrane.value ? craneSnOf(unitNo(unit.value?.name ?? '')) : null))
const live = computed(() => crane.of(sn.value))

/**
 * 实时工况这一段只在塔机弹层打开期间订阅（引用计数，关掉即断开），
 * 不常驻一条 WebSocket —— 现场是手机流量。
 */
onMounted(() => {
  if (isCrane.value) crane.open()
})
onUnmounted(() => {
  if (isCrane.value) crane.close()
})

const infoMap = computed(() => new Map(unit.value?.info ?? []))

/**
 * 从台账 `extra_fields` 取一个可展示的文本。
 *
 * 服务端会返回**空串**字段（不是缺字段），所以要连空白一起当「没有」——
 * `map.get(k) ?? DASH` 这种写法挡得住 undefined，挡不住 `''`，界面上会留一行空白。
 * 多个键名按顺序试（「功效」/「功效统计信息」就是同一件事的两种键名）。
 */
function pick(map: Map<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = map.get(k)?.trim()
    if (v) return v
  }
  return DASH
}

/** 读数：V2 的两位小数 + 单位 */
function reading(v: number, unitText: string): string {
  return `${v.toFixed(2)}${unitText}`
}

/**
 * 塔机基本信息：严格 7 行，顺序与文案照 V2 `UIPanelCrane`。
 *
 * 不再遍历 `u.info` 追加剩余字段 —— 那正是「是否隐藏」「更新时间」串进弹层的路径。
 * 台账以后多出新字段也不会自动漏到界面上，要展示就得在这里显式加一行。
 */
const baseRows = computed<[string, string][]>(() => {
  const u = unit.value
  if (!u) return []
  const map = infoMap.value
  const h = live.value?.bodyHeight
  const s = sn.value

  return [
    // 塔机的「当前状态」不取台账 online_status，取实时的四态（离线/待机/工作中/正在吊装）；
    // 通道没通（HTTPS 无 WS 反代）时 stateOf 返回 null，才回落到台账状态
    ['当前状态', (isCrane.value ? crane.stateOf(s) : null) ?? (u.status || DASH)],
    ['塔机编号', s ?? DASH],
    // 只认实时塔身高度；没有帧就是「—」，不拿台账「高度」顶替（V2 同口径）
    ['塔机高度', h !== undefined && h > 0 ? reading(h, 'm') : DASH],
    ['安检有效期', pick(map, '安检有效期')],
    ['质检报告状态', pick(map, '质检报告状态')],
    ['司机', pick(map, '塔吊司机')],
    // 功效是**平台按设备编号统计的台班效率**，没有编号的车无从统计 ——
    // 传统塔机5 的 `deviceSn` 是空串，V2 弹层这一行就是 `--`
    // （台账里那个「功效统计信息: 60 吊次/台班」没有任何界面在用，别拿它顶上去）。
    ['功效', s ? pick(map, '功效', '功效统计信息') : DASH],
  ]
})

/** 实时工况四行：有帧就填，没帧一律「—」 */
const liveRows = computed<[string, string][]>(() => {
  const f = live.value
  const values = f
    ? [reading(f.angle, '°'), reading(f.range, 'm'), reading(f.height, 'm'), f.at || DASH]
    : [DASH, DASH, DASH, DASH]
  return LIVE_ROWS.map((label, i) => [label, values[i]] as [string, string])
})

/** 电梯仍按台账原字段平铺，不加段标题；只滤掉纯后台技术字段 */
const flatRows = computed<[string, string][]>(() =>
  (unit.value?.info ?? []).filter(([label]) => !TECH_FIELDS.has(label)),
)
</script>

<template>
  <div v-if="unit">
    <section class="dev-info-block">
      <h4 v-if="isCrane" class="dev-info-hd">基本信息</h4>
      <div class="dev-info">
        <div v-for="[label, value] in isCrane ? baseRows : flatRows" :key="label" class="dev-info-row">
          <span>{{ label }}</span><b :class="{ 'is-dash': value === DASH }">{{ value }}</b>
        </div>
      </div>
    </section>

    <section v-if="isCrane" class="dev-info-block">
      <h4 class="dev-info-hd">实时工况信息</h4>
      <div class="dev-info">
        <div v-for="[label, value] in liveRows" :key="label" class="dev-info-row">
          <span>{{ label }}</span><b :class="{ 'is-dash': value === DASH }">{{ value }}</b>
        </div>
      </div>
    </section>
  </div>
</template>
