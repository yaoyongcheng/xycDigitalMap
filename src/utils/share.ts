/**
 * 文本日报的导出与分享（2026-10 版本同步 · 第四批，原 js/app.js:1883-1920）
 *
 * 三档降级，顺序不能反：
 *   ① 系统分享（navigator.share + File）—— 手机上的主路径，能直接发微信/钉钉
 *   ② 下载 .txt —— 不支持分享文件时（桌面浏览器、部分安卓老内核）
 *   ③ 复制到剪贴板 —— 下载也可能被拦（无用户手势、权限策略），兜一层
 * 用户主动取消分享（AbortError）什么也不做：那不是失败，不该再弹出下载。
 */

function download(fileName: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 立刻 revoke 会让部分浏览器来不及读，延后一拍
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    // 环境不支持 Blob URL：交给剪贴板兜底
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    // 剪贴板也可能被拒（非安全上下文），到此为止
  }
}

export type ShareResult = 'shared' | 'downloaded' | 'cancelled'

export async function shareText(opts: { title: string; text: string; fileName: string }): Promise<ShareResult> {
  const { title, text, fileName } = opts
  const nav = navigator as Navigator & {
    share?: (data: ShareData) => Promise<void>
    canShare?: (data: ShareData) => boolean
  }

  if (typeof nav.share === 'function') {
    let file: File | null = null
    try {
      file = new File([text], fileName, { type: 'text/plain' })
    } catch {
      file = null
    }
    const payload: ShareData =
      file && nav.canShare?.({ files: [file] })
        ? { title, text, files: [file] }
        : { title, text }

    try {
      await nav.share(payload)
      return 'shared'
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled'
      // 分享失败（不支持文件、权限被拒）→ 落到下载
      download(fileName, text)
      await copy(text)
      return 'downloaded'
    }
  }

  download(fileName, text)
  await copy(text)
  return 'downloaded'
}
