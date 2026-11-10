import { onBeforeUnmount, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'

import { canShareFiles, photoJpegFile } from './photoHd'

/**
 * 要不要预转。
 *
 * 预转等于提前把 hd 原图拉一遍 —— 这正是「首屏只加载压缩图」想省掉的那份流量，
 * 所以只在真用得上时做：能走分享面板（触摸设备 + 有 Web Share），且用户没开省流。
 * 桌面与省流模式下不预转，点下载时现转（桌面本来就不赶那 200ms）。
 */
function shouldPrefetch(): boolean {
  if (!canShareFiles()) return false
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return !conn?.saveData
}

/**
 * 「存相册」用的预转文件（2026-11，配合 utils/photoHd.ts 的 savePhoto）。
 *
 * 为什么要提前转：手机端存相册走的是 navigator.share(files) 调系统分享面板，
 * 而分享面板要求调用时还带着用户手势。点「下载」之后再去 fetch + canvas 转码，
 * 中间跨了好几个 task，旧版 iOS 上这次手势就过期了 —— 表现是点了没反应
 * （NotAllowedError 被静默兜底成文件下载）。这里在打开大图的空档先把 jpg 备好，
 * 点按钮时同一个任务里就能直接调 share。
 *
 * 转失败静默吞掉：点下载时 savePhoto 会自己再转一次，只是慢一点。
 *
 * @param src  图源（压缩图路径，内部会换成 hd 原图）
 * @param name 文件名（不含扩展名）
 * @param delay 打开后延迟多久开始预转（ms），避开首屏渲染抢带宽
 */
export function useAlbumFile(
  src: MaybeRefOrGetter<string | undefined>,
  name: MaybeRefOrGetter<string>,
  delay = 300,
) {
  const file = shallowRef<File | null>(null)
  let seq = 0
  let timer = 0

  /** 图源变化 / 卸载时作废在途任务，避免旧图转完盖掉新图 */
  function reset(): void {
    seq += 1
    window.clearTimeout(timer)
    file.value = null
  }

  watch(
    () => toValue(src),
    (s) => {
      reset()
      if (!s || !shouldPrefetch()) return
      const key = seq
      timer = window.setTimeout(() => {
        void photoJpegFile(s, toValue(name))
          .then((f) => {
            if (key === seq) file.value = f
          })
          .catch(() => {})
      }, delay)
    },
    { immediate: true },
  )

  onBeforeUnmount(reset)

  return { file, reset }
}
