/**
 * 巡检 / 航拍大图的「原图」与「下载」（2026-11 设计稿 gx2 版，原 app.js:698-790）。
 *
 * 设计稿是一个全屏 photo-stage（顶栏：关闭 / 标题 / 原图 / 下载），项目里
 * 大图已分别长在 PatrolSheet 底部弹层与 AirPlayer 大图 pop 里且都带缩放，
 * 故不另起一层，只把两个动作接进两处操作区。
 *
 * 清单式映射而不是拼路径：哪些照片有 1024 宽原图一目了然，tests/unit/
 * guards.spec.ts 的图片引用扫描也能跟踪到 img/hd/ 下的每一张 ——
 * 加原图时补一行映射即可，漏了会在「孤儿资源」用例里暴露。
 */

/** 压缩图 → hd 原图（img/hd/ 目录，20261106 设计稿同步） */
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

/** 下载当前图（原图优先）：fetch → blob → a[download]，失败交给调用方提示 */
export async function downloadPhoto(src: string, name: string): Promise<void> {
  const url = new URL(photoHd(src), window.location.href).href
  const res = await fetch(url)
  if (!res.ok) throw new Error('load')
  const blob = await res.blob()
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = `${name}.webp`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(objUrl), 1500)
}
