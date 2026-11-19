/**
 * 「快滚到眼前了再去取缩略图」的观察器（2026-11-19）
 *
 * ## 为什么需要一个共享观察器
 *
 * 报警预警列表一屏可能有几十条、消息页一次 20 条、首页轮播每页 3 条 ——
 * 每条缩略图都要打一次抓拍图接口（单张约 1MB）。如果列表一渲染就全量请求，
 * 一次进页面就是几十兆流量，现场 4G 会直接卡死。
 *
 * 所以只给「离视口 240px 以内」的行发请求：
 *   · 全站共用一个 `IntersectionObserver` 实例（不是每个组件一个）；
 *   · 元素一旦触发就立刻 `unobserve`，不会重复回调；
 *   · 元素被卸载（v-for 换数据）后，回调里发现 `isConnected === false` 就顺手
 *     `unobserve`，不留强引用。
 *
 * ## 没有 IntersectionObserver 的设备
 *
 * `IntersectionObserver` 从 Safari 12.1 / Chrome 51 起就有，本项目目标机型
 * 基本都在范围内。真遇到不支持的（老安卓 WebView），这里退化成「只加载前
 * {@link NO_IO_BUDGET} 条」：宁可缩略图不全，也不能一次性拽下几百张 1MB 原图。
 */
const NO_IO_BUDGET = 30

/** 元素 → 进视口后要执行的加载动作 */
const loaders = new WeakMap<Element, () => void>()

let io: IntersectionObserver | null = null
let noIoBudget = NO_IO_BUDGET

function ensureIO(): IntersectionObserver | null {
  if (io) return io
  if (typeof IntersectionObserver === 'undefined') return null
  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target
        if (!entry.isIntersecting) {
          // 已被卸载的元素：这里解除观察，等于给列表换页做一次清理
          if (!el.isConnected) {
            io?.unobserve(el)
            loaders.delete(el)
          }
          continue
        }
        io?.unobserve(el)
        const load = loaders.get(el)
        loaders.delete(el)
        load?.()
      }
    },
    // 底部 / 左右各留 240px 提前量：手指滑到那儿时图已经在路上
    { rootMargin: '240px 0px', threshold: 0 },
  )
  return io
}

/**
 * 登记一个「进入视口后要做什么」。
 *
 * 同一个元素重复登记时以最后一次为准（模板里用行内 `:ref` 时会每帧重建函数，
 * 重复登记是常态，不需要调用方去重）。
 */
export function revealThumb(el: Element | null | undefined, load: () => void): void {
  if (!el) return
  const obs = ensureIO()
  if (!obs) {
    if (noIoBudget <= 0) return
    noIoBudget -= 1
    load()
    return
  }
  loaders.set(el, load)
  obs.observe(el)
}

/** 测试 / 登出清理用：断开观察器并重置额度 */
export function resetThumbReveal(): void {
  io?.disconnect()
  io = null
  noIoBudget = NO_IO_BUDGET
}
