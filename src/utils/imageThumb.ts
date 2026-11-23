/**
 * data URL 缩小（列表缩略图用）
 *
 * ## 为什么要缩
 *
 * 报警抓拍图接口 `/api/video/alarms/{id}/picture` 下发的是**原尺寸 base64**，
 * 实测单张 820KB~1.3MB。列表 / 消息 / 首页轮播的图标位只有 42~48px，直接拿
 * 原图当缩略图有三个代价：解码耗时（低端机一屏 8 张会明显卡）、内存（1MB
 * 字符串 + 位图）、以及滚动时反复重绘。
 *
 * ## 尺寸取舍（2026-11-19 调整：加载性能优先）
 *
 * 缩到长边 {@link THUMB_MAX} 后约 **4~6KB**（144px/0.72 时是 8~12KB）。
 * 为什么敢降到 96：
 *   · 容器最大 48px，96 在 2 倍屏上仍是 1:1 点对点；3 倍屏会略软，
 *     但图标位只是「认得出这是哪条现场」，不需要看清细节；
 *   · 解码像素少 55%，`drawImage` 与 JPEG 编码都更快，滚动更不容易掉帧；
 *   · 落盘缓存与网络回传（若有）也只有原来一半大小。
 * 列表图标位「看不清」的问题 2026-11-23 已确认**暂不处理**（现场只要详情清晰）；
 * 真要调，只有 {@link THUMB_MAX} 与 {@link THUMB_QUALITY} 两个常量。
 *
 * ## 失败就退回原图，绝不返回空
 *
 * 缩图只是优化，**不是前置条件**。以下情况一律把原 URL 原样返回，让调用方
 * 有图可显示：
 *   · 没有 canvas 2D（happy-dom / 老 WebView / 某些隐私模式）；
 *   · 解码失败（base64 截断）或 1.5s 内没解出来；
 *   · `toDataURL` 抛异常（画布被污染，理论上 data URL 不会）；
 *   · 原图本来就比 `max` 小（再走一遍画布纯属浪费）。
 *
 * 这条「失败退回原图」也是单测能跑的前提：happy-dom 的 canvas 没有 2d 上下文，
 * 探到就同步返回，不会留一个永远不 resolve 的 Promise。
 */
export const THUMB_MAX = 96

/**
 * 缩略图 JPEG 质量。
 *
 * 0.62：图标位够用，再高只是白占字节（2026-11-23 现场确认「图标暂不处理」，
 * 清晰度预算全部留给详情页那一档，见 `utils/shotArchive.ts::PREVIEW_MAX_W`）。
 */
export const THUMB_QUALITY = 0.62

/**
 * 把一张 data URL 缩到长边不超过 `max` 的小图。
 *
 * @param url  原图 data URL（也可能是 http 地址，同样适用）
 * @param max  长边上限（px，默认 {@link THUMB_MAX}）
 * @param quality JPEG 质量（0~1，默认 {@link THUMB_QUALITY}）
 */
export function shrinkDataUrl(url: string, max = THUMB_MAX, quality = THUMB_QUALITY): Promise<string> {
  return new Promise((resolve) => {
    if (!url || typeof document === 'undefined') {
      resolve(url)
      return
    }

    // 先探画布：没有 2D 就不要往下走（否则要等解码超时才退，白白拖慢列表）
    let canvas: HTMLCanvasElement
    try {
      canvas = document.createElement('canvas')
      if (!canvas.getContext('2d')) {
        resolve(url)
        return
      }
    } catch {
      resolve(url)
      return
    }

    const Img = (globalThis as { Image?: typeof Image }).Image
    if (!Img) {
      resolve(url)
      return
    }

    const img = new Img()
    let done = false
    const finish = (value: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    // 解码超时：宁可多占一点内存，也不能让列表一直空着
    const timer = setTimeout(() => finish(url), 1500)

    img.onload = (): void => {
      try {
        const w = img.naturalWidth || img.width
        const h = img.naturalHeight || img.height
        if (!w || !h) {
          finish(url)
          return
        }
        // 原图本来就比目标还小：再画一遍只是多做一次编码，直接用它
        if (Math.max(w, h) <= max) {
          finish(url)
          return
        }
        // 等比缩放（长边贴到 max），不变形；容器再靠 object-fit: cover 裁切
        const scale = Math.min(1, max / Math.max(w, h))
        canvas.width = Math.max(1, Math.round(w * scale))
        canvas.height = Math.max(1, Math.round(h * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          finish(url)
          return
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        finish(canvas.toDataURL('image/jpeg', quality))
      } catch {
        finish(url)
      }
    }
    img.onerror = (): void => finish(url)
    img.src = url
  })
}
