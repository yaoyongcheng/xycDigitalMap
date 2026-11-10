/**
 * 巡检 / 航拍大图的「原图」与「下载」（2026-11 设计稿 gx2 版，原 app.js:698-790）。
 *
 * 设计稿是一个全屏 photo-stage（顶栏：关闭 / 标题 / 原图 / 下载）。航拍大图
 * 已按它整层重做（AirPlayer 的 .air-pop）；巡检大图长在 PatrolSheet 底部弹层里、
 * 自带缩放与元信息，套不下那份顶栏，只把两个动作接进操作区。
 *
 * 清单式映射而不是拼路径：哪些照片有 1024 宽原图一目了然，tests/unit/
 * guards.spec.ts 的图片引用扫描也能跟踪到 img/hd/ 下的每一张 ——
 * 加原图时补一行映射即可，漏了会在「孤儿资源」用例里暴露。
 */

/**
 * 压缩图 → hd 原图（img/hd/ 目录，20261106 设计稿同步）
 *
 * 两级是真的两级：列表与详情首屏用的压缩图统一 640 宽（航拍那两张从 1024
 * 重压到 640，体积约 1/3），点「原图」才换成 img/hd/ 下的 1024 宽版本。
 * 只有航拍两张做了重压 —— 它们是唯一只服务航拍页的图；巡检/监控那批还兼着
 * 无人机页大屏与隐患详情，压小了会连带糊掉别的页面。
 */
const HD_MAP: Record<string, string> = {
  'img/aerial-a.webp': 'img/hd/aerial-a.webp',
  'img/aerial-b.webp': 'img/hd/aerial-b.webp',
  'img/cam-crane2.webp': 'img/hd/cam-crane2.webp',
  'img/patrol-crane.webp': 'img/hd/patrol-crane.webp',
  'img/patrol-crane-2.webp': 'img/hd/patrol-crane-2.webp',
  'img/patrol-face.webp': 'img/hd/patrol-face.webp',
  'img/patrol-layout.webp': 'img/hd/patrol-layout.webp',
  'img/patrol-layout-2.webp': 'img/hd/patrol-layout-2.webp',
  'img/patrol-pano.webp': 'img/hd/patrol-pano.webp',
  'img/patrol-power.webp': 'img/hd/patrol-power.webp',
  'img/patrol-road.webp': 'img/hd/patrol-road.webp',
  'img/patrol-yard.webp': 'img/hd/patrol-yard.webp',
}

/** 原 patrolFull()：压缩图路径 → hd 原图路径（清单外的图原样返回） */
export function photoHd(src: string): string {
  return HD_MAP[src] ?? src
}

/**
 * 把图片画进 canvas 再编码成 JPEG 的 Blob。
 *
 * 为什么不在下载时直接把 .webp 改名成 .jpg：站内图片全部是 WebP，
 * 改扩展名只是骗过文件名，拿到手的仍是 WebP —— 微信、部分图片查看器
 * 和多数办公软件不认，落地成「打不开的 jpg」。设计稿下载的是 photo.name + ".jpg"，
 * 所以这里真转一次格式。
 */

/** 解码结果：尺寸 + 可直接 drawImage 的源 + 资源回收 */
interface Decoded {
  w: number
  h: number
  el: CanvasImageSource
  done: () => void
}

async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    return { w: bitmap.width, h: bitmap.height, el: bitmap, done: () => bitmap.close() }
  }
  // 老 iOS Safari 没有 createImageBitmap，退回 <img> + decode()
  const objUrl = URL.createObjectURL(blob)
  const img = new Image()
  img.src = objUrl
  await img.decode()
  return {
    w: img.naturalWidth,
    h: img.naturalHeight,
    el: img,
    done: () => URL.revokeObjectURL(objUrl),
  }
}

async function toJpegBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('load')
  const pic = await decode(await res.blob())
  const canvas = document.createElement('canvas')
  canvas.width = pic.w
  canvas.height = pic.h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas')
  // WebP 可能带透明通道，JPEG 没有；不铺底的话透明区域会变黑
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(pic.el, 0, 0)
  pic.done()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  if (!blob) throw new Error('encode')
  return blob
}

/* ---------- 存相册 / 下载 ---------- */

/** 保存结果：album = 已存进相册（分享面板完成）；download = 落成文件；cancel = 用户取消 */
export type SaveResult = 'album' | 'download' | 'cancel'

/** 原图优先，转成 jpg 的 File（可直接塞进 navigator.share 的 files） */
export async function photoJpegFile(src: string, name: string): Promise<File> {
  const url = new URL(photoHd(src), window.location.href).href
  return new File([await toJpegBlob(url)], `${name}.jpg`, { type: 'image/jpeg' })
}

/** Web Share 的文件分享（lib.dom 里的 ShareData 未覆盖 files，这里自己收窄） */
interface FileShareData {
  files: File[]
  title?: string
}
type ShareCapable = Navigator & {
  canShare?: (data?: FileShareData) => boolean
  share?: (data?: FileShareData) => Promise<void>
}

/**
 * 当前环境是否具备「系统分享面板」的能力（不看具体文件类型）。
 *
 * 只在触摸设备上算可用：桌面 Chrome 也支持 navigator.share（会弹 Windows 的
 * 系统分享），但桌面用户点「下载」要的是落一个文件，不是弹系统分享。
 */
export function canShareFiles(): boolean {
  const coarse = window.matchMedia?.('(pointer: coarse)')
  if (!coarse?.matches) return false
  const nav = navigator as ShareCapable
  return typeof nav.share === 'function' && typeof nav.canShare === 'function'
}

/**
 * 能不能把这张图交给系统分享面板（→ 相册）。
 *
 * 手机浏览器没有把图片写进系统相册的 Web API（既没有相册权限，也没有目录访问），
 * 唯一能把文件交出去的口子是系统分享面板：iOS 里选「存储图像」、Android 里选
 * 「保存到相册 / 照片」，落点就是相册。所以「存相册」= navigator.share(files)。
 */
function canShareToAlbum(file: File): boolean {
  if (!canShareFiles()) return false
  try {
    return (navigator as ShareCapable).canShare!({ files: [file] })
  } catch {
    // 部分 WebView 的 canShare 收到 files 会直接抛，按不支持处理
    return false
  }
}

/** 兜底：a[download] 存成文件（桌面直接落下载目录，移动端落「文件/下载」） */
function saveAsFile(file: Blob, name: string): void {
  const objUrl = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = `${name}.jpg`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(objUrl), 1500)
}

/**
 * 保存当前图（原图优先，输出 jpg）。
 *
 * `ready` 是提前转好的文件：分享面板要求在用户手势里调用，点按钮后再
 * fetch + canvas 转码（几百毫秒、跨好几个 task）在旧版 iOS 上会把这次手势
 * 耗掉，面板压根不弹。调用方可在打开大图的空档先备好（见 utils/albumSave.ts），
 * 传进来就能在同一次任务里直接 share。没备好也不要紧，照样等转完再试。
 *
 * 取消（AbortError）不算失败，也不再兜底下载 —— 否则点「取消」反而落一份文件。
 */
export async function savePhoto(
  src: string,
  name: string,
  ready?: File | null,
): Promise<SaveResult> {
  const file = ready ?? (await photoJpegFile(src, name))
  const nav = navigator as ShareCapable
  if (canShareToAlbum(file)) {
    try {
      await nav.share!({ files: [file], title: name })
      return 'album'
    } catch (err) {
      if ((err as DOMException | undefined)?.name === 'AbortError') return 'cancel'
      // NotAllowedError（丢手势）等：面板没弹出来，退回文件下载
    }
  }
  saveAsFile(file, name)
  return 'download'
}
