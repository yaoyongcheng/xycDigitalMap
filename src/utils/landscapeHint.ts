import { ref } from 'vue'

/**
 * 横屏提示的状态（2026-11-23）
 *
 * 最简形态：一条两行字的深色胶囊，4.2s 自动淡出，点一下也能立刻关。
 * 刻意不做「一次会话只提示一次」——没有按钮就没有「已确认」这个动作，
 * 自动消失后错过的人，下次进全屏还能再看到。
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
