import { computed, ref, watch, type Ref } from 'vue'

/**
 * 任务结束后的**画面宽限**（2026-11-24）
 *
 * ## 为什么需要它
 *
 * 无人机页的门禁是「有没有执行中的起飞任务」（没有任务就不连流，见
 * `views/sub/UavPage.vue`）。但服务端把架次标成「已完成」的那一刻，飞机往往
 * 还在推最后几秒（落地、云台回中、回库），按 `running` 立刻卸载播放器，
 * 现场看到的就是「画面活生生断在半空」，落地那一下正好没了。
 *
 * 这里给一段宽限：任务结束（`running: true → false`）后 `on` 再维持 `holdMs`，
 * 期间播放器不卸载、LIVE 角标不摘；到点自动收。
 *
 * ## 两个细节
 *
 * · **判到期用的是共享时钟**（`utils/missionClock.ts` 的 `now`，5s 网格），
 *   不是内部再开一个 `setTimeout` —— 页面上已经有一份时间源，多开一份就多一个
 *   相位，还会在组件卸载后残留定时器。
 * · **只在「跑过 → 结束」时开窗**。页面刚打开时 `running` 本来就是 false，
 *   那不是「刚结束」，不该让画面白连两分钟。
 *
 * @param running 任务是否正在执行（响应式）
 * @param now     共享时钟的当前时刻（毫秒时间戳）
 * @param holdMs  宽限时长，默认 2 分钟
 */
export function useStreamHold(
  running: Readonly<Ref<boolean>>,
  now: Readonly<Ref<number>>,
  holdMs = 120_000,
) {
  /** 宽限到什么时候（时间戳；0 = 不在宽限里） */
  const until = ref(0)

  watch(running, (on) => {
    until.value = on ? 0 : Date.now() + holdMs
  })

  /** 画面上屏的条件：任务在跑，或刚结束不到 `holdMs` */
  const on = computed(() => running.value || now.value < until.value)

  /** 宽限几分钟 —— 给文案用，别在模板里写死「2 分钟」 */
  const minutes = Math.round(holdMs / 60_000)

  return { on, until, minutes }
}
