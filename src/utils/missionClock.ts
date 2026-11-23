/**
 * 「当前巡检」进度条的时钟 —— 两处共用同一个 `now`。
 *
 * ## 为什么不能各自 `ref(Date.now())`
 *
 * 首页卡片（`views/home/EquipPanel.vue`）和无人机页（`views/sub/UavPage.vue`）
 * 画的是同一条任务、同一个 `missionProgress()`，但时间源曾是两份：
 *
 * ```ts
 * const now = ref(Date.now())                 // 各自的初始值 = 各自 setup 的时刻
 * setInterval(() => { now.value = Date.now() }, 30_000)  // 各自的相位
 * ```
 *
 * `setInterval` 的相位只跟「什么时候 start」有关。首页先挂载、无人机页后进，
 * 两条定时器就对不齐，最坏情况相差将近一整拍 —— 6 分钟的分母下是 8 个百分点，
 * 肉眼一看就是「两个条不一样长」（现场 50% vs 61%）。这不是算法错，是时钟有两套。
 *
 * ## 这里怎么保证一致
 *
 * - **模块级唯一 `now`**：谁读都是同一个数，不存在第二套时间；
 * - **网格对齐的 tick**：每次按 `TICK - Date.now() % TICK` 预约下一次，跳动落在
 *   `:00 / :05 / :10` 这些整 5 秒上，而不是由某一页的挂载时刻决定。两页即便
 *   先后启动，也落在同一批时刻上；
 * - **订阅时先对表**：`start()` 立刻把 `now` 拉到当前时刻，进来的人不会读到旧值；
 * - **引用计数**：没人看就停表（首页切走、子页关闭都不留定时器）。
 *
 * 粒度选 5 秒：6 分钟分母下每跳 1.4%，条几乎看不出在动；更细的粒度对齐成本更高，
 * 而「两处一致」靠的是同一个数，不是更高频率。
 */
import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'

/** 跳动间隔（毫秒）。要调就改这一个数 —— 两处都不许再各写一个。 */
const TICK = 5000

const nowRef = ref(Date.now())
let timer: number | null = null
let users = 0

/** 预约下一次跳动：`wait` 永远 ≤ TICK，且终点落在 TICK 的整数倍上 */
function schedule(): void {
  const wait = TICK - (Date.now() % TICK)
  timer = window.setTimeout(() => {
    nowRef.value = Date.now()
    schedule()
  }, wait)
}

function start(): void {
  // 进页面先对表：不等下一拍，挂载瞬间就与另一处同一个数
  nowRef.value = Date.now()
  if (timer === null) schedule()
}

function stop(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

/**
 * 订阅共享时钟：挂载 +1、卸载 -1，最后一个走了才停表。
 *
 * 返回 `readonly` —— 时间只能由时钟自己推进。谁要「手动拨表」，就等于再造
 * 一套时间源，这一整段注释说的 bug 会原样回来。
 */
export function useMissionClock() {
  onMounted(() => {
    users += 1
    start()
  })
  onBeforeUnmount(() => {
    users = Math.max(0, users - 1)
    if (users === 0) stop()
  })
  return readonly(nowRef)
}
