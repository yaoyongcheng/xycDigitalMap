import { onScopeDispose, ref, watch, type Ref } from 'vue'

/**
 * 骨架屏出现的等待时间（毫秒）。
 *
 * 支付宝的做法是「慢才显示骨架」：局域网/缓存命中的请求 100~200ms 就回来了，
 * 这时闪一下灰条再变内容，观感比直接出内容更差（像一次闪烁故障）。所以骨架
 * 延迟这么久才上屏；只要请求在此之前完成，用户完全看不到骨架。
 *
 * 反过来，骨架**一旦显示就不再等**：数据到了立刻撤（见下面 else 分支）。
 * 只延迟上、不延迟下 —— 否则数据已经在了还挂着灰条，更像卡死。
 */
export const SKEL_DELAY = 280

/**
 * 把「正在请求」翻译成「现在该不该显示骨架」。
 *
 * @param pending 请求进行中的判定（通常直接传 store 的 loading / state）
 * @param delay   上屏延迟，测试里可以调小
 *
 * 用法：
 * ```ts
 * const showSkel = useSlowLoading(() => ledger.state === 'loading')
 * ```
 * 组件卸载时会清掉未触发的定时器（快速切页时不会在已销毁的组件上写状态）。
 */
export function useSlowLoading(pending: () => boolean, delay = SKEL_DELAY): Ref<boolean> {
  const show = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  function clear(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  watch(
    pending,
    (on) => {
      clear()
      if (on) {
        timer = setTimeout(() => {
          timer = undefined
          show.value = true
        }, delay)
      } else {
        show.value = false
      }
    },
    { immediate: true },
  )

  onScopeDispose(clear)

  return show
}
