import { watch } from 'vue'

import { useShellStore } from '@/stores/shell'
import type { TabId } from '@/types'

/**
 * 切回某个底栏 tab 时重新取数（2026-11-24）
 *
 * ## 为什么需要它
 *
 * 四个 tab 页是**常驻挂载**的（`App.vue` 里 `<HomePage />` 等四个组件一直在 DOM 里，
 * 靠 `.page.active` 切显隐），所以 `onMounted` 一辈子只跑一次。用户在首页看到
 * 「待处理 3」，切到工作台再回来 —— 数字不会变，一直是早上进 App 那一刻的快照。
 * 预警状态由服务端 / 审核平台推进，页面上停着旧值就会被读成 bug。
 *
 * 于是每个页面自己声明「我被切到前台时要做什么」：本 composable 只负责**时机**，
 * 取哪个接口、走 force 还是走缓存，仍由页面决定（各 store 的节流口径不同，
 * 不该在这里一刀切）。
 *
 * ## 两道闸
 *
 * · `watch(activeTab)` 只在**真的换了 tab**时触发：点当前 tab 不动数据
 *   （`activeTab` 没变，watch 不跑），不会因为连点底栏就重打请求；
 * · `minGap` 防的是 首页 → 消息 → 首页 这种来回横跳：同一页面 600ms 内
 *   被切回来两次只刷一次。各家 store 内部还有自己的在途去重与失败冷却，
 *   这里只是省掉明显多余的那一趟。
 *
 * 组件卸载时 watch 自动停止（在 setup 里注册），不会给已离开的页面拉数据。
 */
export function useTabRefresh(tab: TabId, reload: () => void, minGap = 600): void {
  const shell = useShellStore()
  let lastAt = 0

  watch(
    () => shell.activeTab,
    (to, from) => {
      if (to !== tab || from === to) return
      const now = Date.now()
      if (now - lastAt < minGap) return
      lastAt = now
      reload()
    },
  )
}
