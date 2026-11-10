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

/** 下载当前图（原图优先，输出 jpg）：fetch → canvas 转码 → a[download]，失败交给调用方提示 */
export async function downloadPhoto(src: string, name: string): Promise<void> {
  const url = new URL(photoHd(src), window.location.href).href
  const blob = await toJpegBlob(url)
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = `${name}.jpg`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(objUrl), 1500)
}
