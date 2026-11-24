import { defineStore } from 'pinia'
import { ref } from 'vue'

import {
  fetchSceneImage,
  SceneNotFoundError,
  type SceneImage,
  type SceneType,
} from '@/api/scene'
import { fingerprint, readSceneCache, writeSceneCache } from '@/utils/sceneCache'

/**
 * 场景截图底图（首页背景 + 全屏地图的二维 / 三维）
 *
 * 2026-11-18 起这两张底图不再是 public/img 下的静态图，而是现场平台每次截图
 * 上传到 `115.159.67.12` 的 2D / 3D 场景图（见 `api/scene.ts` 的长注释）。
 * 这里是它们唯一的落地处：**一次会话内每个类型只取一次**，两个页面共用同一份
 * objectURL —— 首页背景和全屏地图的三维是同一张图，各取一次等于白下 3.2MB。
 *
 * ## 几个刻意的决定
 *
 * ① **本地兜底图参与比对与更新**（2026-11-18 晚）。打包在 public/img 的图是
 *    构建产物，运行时写不回去，所以「本地兜底」落在 IndexedDB（见
 *    `utils/sceneCache.ts`）。每次取到接口图先和它比指纹：
 *      · 相同 → 继续显示本地兜底图，**不换 URL、不重写**，画面零跳变；
 *      · 不同 → 立刻换接口新图，同时把兜底图替换成这张，下次刷新以它为准；
 *      · 首次没有兜底图 → 直接用接口图并落盘；
 *      · 接口空 / 失败 → 用兜底图顶上；连兜底图都没有才用打包图。
 * ② **失败不清图**。已经成功拿到过的图在刷新失败时保留，页面继续显示上一次
 *    的图；只有从来没成功过才落到内置底图。理由和航拍那几格一致：网络抖一下
 *    不该让首页背景变成空白。
 * ③ **内置图是最后的兜底**。`FALLBACK` 里的 site-map / site-flat 是迁移前就
 *    打包在 public/img 里的那两张，与接口图同源同取景（1280×720，见下方注释）。
 * ④ **objectURL 要 revoke**。换图时先撤掉旧的，否则每刷新一次就多留 3MB 在
 *    内存里，手机上很致命。但「指纹相同」那条路**不重建也不 revoke** ——
 *    那正是「不重复写入、不闪」的实现方式。
 * ⑤ **不抛错**。调用方（首页 / 全屏地图）只需读 `src()` 兜底后的地址，
 *    状态与原因分别留在 `state()` / `note()` 里，供排查与将来的提示条使用。
 * ⑥ **冷启动走 304，不再重下大图**（2026-11-24）。IndexedDB 那条记录里除了
 *    blob 与指纹，还存了服务端的 `ETag` / `Last-Modified`；`load()` 先挂本地图，
 *    再带着它们发条件请求 —— 图没变时服务端只回一个 304（几百字节），
 *    3.3~3.8MB 一个字节都不传。此前每次刷新都要把整张图下完再比指纹，
 *    这是首页背景「每次打开都慢」的主因。
 * ⑦ **同会话内仍在 `ok` 就早返回**，但页面回到前台且距上次确认超过 10 分钟时
 *    会补一次校验（`revalidate`）—— 既不重复下载，也不会长期停在旧图上。
 */

/**
 * 接口没通时用的内置底图。
 *
 * 2026-11-18：这两张不再是迁移前的设计稿截图，而是**用同一次接口截图
 * 同源导出**的 1280×720 快照（16:9，接口图是 1920×1080）。
 * 必须同源同取景 —— 否则「刷新时先显示兜底图、再切到接口图」会变成两次
 * 不同取景的跳变，看起来就像视角偏了一下。
 *
 * 注意它的地位：只在本机既没有接口图、也没有落盘兜底图时才出现（首次访问且
 * 接口不顺）。平时「本地兜底图」是 IndexedDB 里那张，比它新。
 */
const FALLBACK: Record<SceneType, string> = {
  '2d': `${import.meta.env.BASE_URL}img/site-flat.webp?v=20261118`,
  '3d': `${import.meta.env.BASE_URL}img/site-map.webp?v=20261118`,
}

/**
 * idle 未取 / loading 取图中 / ok 已换成接口图 / cache 本地兜底图已上屏
 * （接口还没给结论）/ empty 该项目没上传 / error 取失败
 */
export type SceneState = 'idle' | 'loading' | 'ok' | 'cache' | 'empty' | 'error'

export const useSceneStore = defineStore('scene', () => {
  /** type → objectURL（空串表示还没成功取到） */
  const urls = ref<Record<SceneType, string>>({ '2d': '', '3d': '' })
  const states = ref<Record<SceneType, SceneState>>({ '2d': 'idle', '3d': 'idle' })
  /** 失败/空态的说明（给人看，也可直接写进提示条） */
  const notes = ref<Record<SceneType, string>>({ '2d': '', '3d': '' })

  /**
   * type → 当前这张图的指纹。
   *
   * 判等基准：与接口新图比的是**这个**，不是「上一轮请求」。冷启动时它由
   * 本地兜底图填充，所以「刷新后接口图没变」能被认出来，不会白换一次图。
   */
  const hashes: Record<SceneType, string> = { '2d': '', '3d': '' }

  /**
   * type → 本地那张图对应的服务端校验器（2026-11-24）。
   *
   * 与 `hashes` 一起从 IndexedDB 那条记录里恢复：冷启动先上本地图，再带这两个
   * 值发条件请求 —— 图没变时服务端回 304，3.3~3.8MB 一个字节都不传。
   * 这也是「不再每次刷新都白下一次大图」的关键。
   */
  const etags: Record<SceneType, { etag: string; lastModified: string }> = {
    '2d': { etag: '', lastModified: '' },
    '3d': { etag: '', lastModified: '' },
  }

  /**
   * type → 上次向服务端确认「有没有更新」的时间（ms）。
   *
   * 只用于 `revalidate()`：页面从后台回到前台时，太勤地校验没意义（现场图的
   * 更新频率是小时级），但一直不校验又会长期停在旧图上，所以给一个 10 分钟
   * 的门槛 —— 见 `revalidate` 的注释。
   */
  const checkedAt: Record<SceneType, number> = { '2d': 0, '3d': 0 }

  /** 本次会话里已尝试过从本地兜底恢复的类型（避免每次 load 都开一次库） */
  const hydrated = new Set<SceneType>()

  /** 进行中的请求（同一类型并发调用只发一次，例如首页与全屏地图同时挂载） */
  const pending = new Map<SceneType, Promise<void>>()

  /** 实际给 `<img>` 用的地址：本地兜底 / 接口图优先，都没有就用内置底图 */
  function src(type: SceneType): string {
    return urls.value[type] || FALLBACK[type]
  }

  /**
   * 当前显示的是不是「动态图」—— 接口图或已落盘的兜底图都算。
   *
   * 首页 `.home-map` 用它决定要不要把 CSS 背景也换成同一张（只在图片字节
   * 还没到、`<img>` 还没出像素的空窗期露出来）。内置打包图不需要这层。
   */
  function isLive(type: SceneType): boolean {
    return Boolean(urls.value[type])
  }

  function state(type: SceneType): SceneState {
    return states.value[type]
  }

  /**
   * 这一类型是否已经有结论（成功 / 用兜底图 / 未上传 / 失败都算）。
   *
   * 页面切换底图前先问它：有了结论就能一步切到最终图；只有 `idle /
   * loading` 才需要等 —— 这一条是「切二维时不闪旧图」的前提，否则会先拿
   * 内置兜底图上屏，等下完再换一次，用户看到两次切换。
   */
  function settled(type: SceneType): boolean {
    const s = states.value[type]
    return s === 'ok' || s === 'cache' || s === 'empty' || s === 'error'
  }

  /**
   * 预热：把图先解到内存里。
   *
   * 1920×1080 的 PNG 有 3~4MB，`<img src>` 换过去时浏览器还要解码一次，
   * 移动端往往先白一帧再出图。这里提前 decode，等 `state === 'ok'` 时
   * 图已经是「可渲染」状态，切过去基本同步出像素。
   *
   * 返回三种结果，用途不同：
   *   · `ok`      —— 解码成功，可以放心上屏；
   *   · `bad`     —— **明确解码失败**（字节坏了 / 下载不完整）：这张图根本
   *                  出不了像素，不能拿它覆盖掉好的兜底图；
   *   · `unknown` —— 环境没有 `decode`、或 1.2s 内没结果（低端机解码慢、
   *                  happy-dom 里永不 settle）。属于「不知道」而不是「坏」，
   *                  照常上屏 —— `<img>` 自己还会再解一次，不能因为测不出来
   *                  就把正常图丢掉。
   */
  async function warm(url: string): Promise<'ok' | 'bad' | 'unknown'> {
    const Ctor = (globalThis as { Image?: typeof Image }).Image
    if (typeof Ctor !== 'function') return 'unknown'
    const im = new Ctor()
    im.src = url
    if (typeof im.decode !== 'function') return 'unknown'
    return Promise.race<'ok' | 'bad' | 'unknown'>([
      im.decode().then(
        () => 'ok',
        () => 'bad',
      ),
      // 兜底超时：某些环境（含测试用的 happy-dom）decode 可能永不 settle，
      // 卡住会让 `load()` 永远不返回，页面就一直停在「加载中」
      new Promise<'unknown'>((resolve) => {
        setTimeout(() => resolve('unknown'), 1200)
      }),
    ])
  }

  function note(type: SceneType): string {
    return notes.value[type]
  }

  /** blob → objectURL（环境不支持时抛，由调用方决定降级） */
  function objectUrl(blob: Blob): string {
    if (typeof URL.createObjectURL !== 'function') {
      throw new Error('当前环境不支持 objectURL')
    }
    return URL.createObjectURL(blob)
  }

  /**
   * 冷启动挂上本地兜底图 —— 接口还没回来时，画面就已经是「上一次最新的那张」。
   *
   * 为什么不 await 完再让页面渲染：没法做到。IndexedDB 是异步的，首帧一定
   * 早于它；所以这里只求「尽快」——读库通常 10~30ms，`MapViewer` 的双缓冲会
   * 把从打包图到兜底图的这一次替换做成淡入，不是白帧。
   */
  async function hydrate(type: SceneType): Promise<void> {
    if (hydrated.has(type)) return
    hydrated.add(type)
    if (urls.value[type]) return

    const entry = await readSceneCache(type)
    // 读库期间可能已经取到接口图（并发的 load）：有图就别再盖掉
    if (!entry || urls.value[type]) return

    try {
      urls.value[type] = objectUrl(entry.blob)
    } catch {
      return
    }
    hashes[type] = entry.hash
    // 校验器跟着图一起恢复：下一次请求就能走 304
    etags[type] = { etag: entry.etag ?? '', lastModified: entry.lastModified ?? '' }
    states.value[type] = 'cache'
  }

  /**
   * 换图失败时该回到哪个状态。
   *
   * 画面还有图（本地兜底 / 本次会话旧图）就沿用那张的来历（`ok` / `cache`），
   * 一张都没有才算 `error`。别把「屏幕上明明有图」谎报成没图。
   */
  function keepShownState(
    type: SceneType,
    prev: SceneState,
    fallback: SceneState,
  ): SceneState {
    if (!urls.value[type]) return fallback
    return prev === 'ok' || prev === 'cache' ? prev : fallback
  }

  async function run(type: SceneType): Promise<void> {
    const prevState = states.value[type]
    states.value[type] = 'loading'
    notes.value[type] = ''

    const meta = etags[type]
    let res: SceneImage
    try {
      /*
       * 条件请求（2026-11-24）：带上本地这张图的 ETag / Last-Modified。
       * 图没变 → 304（空响应，几百字节）；变了 → 200 + 新字节。
       * 首次没有校验器时就是普通 GET。
       */
      res = await fetchSceneImage(type, {
        etag: meta?.etag || undefined,
        lastModified: meta?.lastModified || undefined,
      })
      /*
       * 304 但屏幕上没有图（IndexedDB 被系统清掉 / blob 坏了，只剩内存里的
       * 校验器）：304 帮不上忙，再无条件取一次全量。这条概率很低，但不处理
       * 就会「一直 304、一直没有图」。
       */
      if (res.notModified && !urls.value[type]) res = await fetchSceneImage(type)
    } catch (e) {
      /*
       * 接口没给图（404 / 空响应体 / 断网 / 密钥失效）：**画面保持不动**。
       * 有本地兜底图（或本会话已取到的接口图）就继续用它；只有一张都没有
       * 时 `src()` 才会回落到打包的内置图。
       *
       * 状态按「这次取图的结论」记（而不是「画面现在是哪张」）：`empty /
       * error` 不阻挡下一次 load 重试，网络恢复后切一下地图就能补上最新图。
       */
      states.value[type] = e instanceof SceneNotFoundError ? 'empty' : 'error'
      notes.value[type] = (e as Error)?.message || '场景截图加载失败'
      // 失败也记一次时间：前后台来回切不该把这台机器当成「每 10 分钟才问一次」的例外
      checkedAt[type] = Date.now()
      return
    }

    /*
     * 304 / 无字节：服务端说「还是那一张」。
     *
     * 这是本次优化的主路径 —— 什么图都不用下，本地那张直接继续显示：
     * 不换 URL、不重建 objectURL、不写库（`writeSceneCache` 一次是 3.3MB），
     * 状态从 `cache` 升到 `ok`（已向服务端确认过是最新）。
     */
    if (res.notModified || !res.blob) {
      etags[type] = { etag: res.etag, lastModified: res.lastModified }
      if (urls.value[type]) {
        states.value[type] = 'ok'
        notes.value[type] = ''
        checkedAt[type] = Date.now()
      } else {
        states.value[type] = 'error'
        notes.value[type] = '场景截图没有返回内容'
      }
      return
    }

    const fresh = { blob: res.blob, hash: await fingerprint(res.blob) }

    /*
     * 与本地兜底图比指纹：一模一样就**什么都不做**。
     *
     * 不重建 objectURL、不换 src —— MapViewer 那边 watcher 不会触发，
     * 双缓冲不参与，画面一帧都不动。这是「刷新时不闪、不重复写」的核心：
     * 用户看到的还是上次那张，服务端也确实是同一张，没有任何理由重画。
     */
    if (urls.value[type] && hashes[type] === fresh.hash) {
      states.value[type] = 'ok'
      checkedAt[type] = Date.now()
      /*
       * 内容一样但 ETag 变了（nginx 的 ETag 由 mtime+size 拼，重新上传同一张
       * 图也会换 ETag）：把这颗新 ETag 写回本地那张记录，否则以后每次都是
       * 200 + 3.3MB，永远轮不到 304。只在 ETag 真的变了时写，正常情况零写入。
       */
      if (res.etag && res.etag !== (meta?.etag ?? '')) {
        const local = await readSceneCache(type)
        if (local) {
          void writeSceneCache(type, local.blob, local.hash, {
            etag: res.etag,
            lastModified: res.lastModified,
          })
        }
      }
      etags[type] = { etag: res.etag, lastModified: res.lastModified }
      return
    }

    let url: string
    try {
      url = objectUrl(fresh.blob)
    } catch (e) {
      notes.value[type] = (e as Error).message
      states.value[type] = keepShownState(type, prevState, 'error')
      return
    }

    // 先解码再置 ok：等 `settled()` 为真时这张图已经能直接上屏，
    // 页面据此切换就不会出现「换过去还空一下」。
    // 明确解不出来（字节坏了 / 下载不完整）就当这次没取到 —— 既不换图，
    // 也不把坏字节写成新的兜底图，否则下次刷新会以「一张打不开的图」为基准。
    const quality = await warm(url)
    if (quality === 'bad') {
      URL.revokeObjectURL(url)
      notes.value[type] = '场景截图无法解码（可能下载不完整）'
      states.value[type] = keepShownState(type, prevState, 'error')
      return
    }

    const prevUrl = urls.value[type]
    urls.value[type] = url
    hashes[type] = fresh.hash
    states.value[type] = 'ok'
    notes.value[type] = ''
    checkedAt[type] = Date.now()
    // 换图先撤旧的：每张 3MB 左右，不撤就是纯内存泄漏
    if (prevUrl && prevUrl !== url) URL.revokeObjectURL(prevUrl)

    /*
     * 把这张存成新的兜底图（覆盖同 type 的旧记录，不会越攒越多）。
     * ETag 与图同批存 —— 下次冷启动就靠它换 304。
     * 放在展示之后：写库慢或失败都不影响用户此刻看到的东西，最坏情况只是
     * 下次刷新比较的基准还差一张。写失败也不提示 —— 缓存是尽力而为的。
     */
    etags[type] = { etag: res.etag, lastModified: res.lastModified }
    await writeSceneCache(type, fresh.blob, fresh.hash, {
      etag: res.etag,
      lastModified: res.lastModified,
    })
  }

  /**
   * 取某个类型的底图。
   *
   * - 默认 `ok / empty` 直接返回（一次会话内不重复下 3MB）；
   * - `force` 跳过这个判断，强制重取（刷新 / 换图后想看最新一张时用）；
   * - 同一类型的并发调用复用同一个 Promise；
   * - 冷启动第一步是「从本地兜底恢复」，第二步才是问接口要最新的一张。
   */
  async function load(type: SceneType, force = false): Promise<void> {
    const s = states.value[type]
    if (!force && (s === 'ok' || s === 'empty')) return
    const running = pending.get(type)
    if (running) return running

    const task = (async () => {
      await hydrate(type)
      await run(type)
    })()
    pending.set(type, task)
    try {
      await task
    } finally {
      pending.delete(type)
    }
  }

  /**
   * 「回到前台时确认一下有没有新图」（2026-11-24）。
   *
   * 为什么需要：本次优化后**同一会话内不再重复取图**（`ok` 直接返回），代价是
   * 现场上午重截了图、用户下午一直开着前台也不会变 —— 那就成了「长期加载旧图」。
   * 折中办法是只在**页面重新可见**且距上次确认超过 `maxAge` 时补一次校验：
   * 有 ETag 在，这一次通常只是 304（几十毫秒、几百字节），变了才下新图。
   *
   * 10 分钟是现场图的更新频率（小时级）与校验成本的折中；比它勤没有意义。
   */
  async function revalidate(type: SceneType, maxAge = 10 * 60_000): Promise<void> {
    const last = checkedAt[type]
    if (last && Date.now() - last < maxAge) return
    // 已经有结论的类型才补校验；从没取过的由页面自己的 load 负责
    if (!settled(type)) return
    await load(type, true)
  }

  /**
   * 预热（只在「本机已经有这张图」时动手）。
   *
   * 用途：进全屏地图后顺手把二维图确认一遍 —— 用户点「二维」时就能一步到位。
   * **本机没有图就什么都不做**：二维 3.8MB，没看过二维的人不该为一次点击
   * 之外的猜测付流量（这是「减少不必要请求」的边界）。
   */
  async function warmUp(type: SceneType): Promise<void> {
    if (!hydrated.has(type)) await hydrate(type)
    if (!urls.value[type]) return
    if (states.value[type] === 'empty') return
    // 已确认最新（本会话取到过）→ 不重复请求；只剩 `cache` 需要校验一次
    await load(type)
  }

  /** 清空（退出登录 / 换项目时用；不撤 objectURL 会被一直引用） */
  function reset(): void {
    for (const t of ['2d', '3d'] as SceneType[]) {
      if (urls.value[t]) URL.revokeObjectURL(urls.value[t])
      urls.value[t] = ''
      states.value[t] = 'idle'
      notes.value[t] = ''
      hashes[t] = ''
      etags[t] = { etag: '', lastModified: '' }
      checkedAt[t] = 0
    }
    hydrated.clear()
    pending.clear()
  }

  return {
    urls,
    states,
    notes,
    src,
    isLive,
    state,
    settled,
    note,
    load,
    revalidate,
    warmUp,
    reset,
  }
})
