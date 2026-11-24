import { ref } from 'vue'

/**
 * 横屏提示的状态（2026-11-23，2026-11-24 收窄适用范围）
 *
 * 最简形态：一条两行字的深色胶囊，4.2s 自动淡出，点一下也能立刻关。
 * 刻意不做「一次会话只提示一次」——没有按钮就没有「已确认」这个动作，
 * 自动消失后错过的人，下次进全屏还能再看到。
 *
 * ## 只有一处会打开它
 *
 * 智眸 → VR 360 环视 → 项目全景 → 右上角「全屏」（`PatrolSheet.vue` 的
 * `panoLand`，`useLandscape({ page: true, hint: true })`）。
 *
 * 那句「把手机横过来看」是为球面全景写的：竖屏里球面只剩中间一条窄缝，
 * 拖都拖不动，只能请用户转屏。其它全屏场景（首页全屏地图、监控播放器、
 * 抓拍大图、航拍全景、智眸的平面照片）**都不再触发** —— 它们不转屏也能看，
 * 2026-11-24 现场要求清掉，别再往别处挂这个开关。
 */
export const landscapeHintOpen = ref(false)

/** 自动淡出：够读完两行，又不至于挡着看地图 */
const HINT_MS = 4200

let timer = 0

export function openLandscapeHint(): void {
  landscapeHintOpen.value = true
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    landscapeHintOpen.value = false
  }, HINT_MS)
}

export function closeLandscapeHint(): void {
  window.clearTimeout(timer)
  landscapeHintOpen.value = false
}
