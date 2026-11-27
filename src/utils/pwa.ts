/**
 * Service Worker 注册与更新检查
 *
 * 背景：项目原依赖 vite-plugin-pwa 自动注入的 registerSW.js，那是个写死的三行
 * 脚本（register(url, { scope })），既没有回调也没有配置入口，下面两件事都做不了，
 * 故改为手动注册。
 *
 * ① 无法主动检查更新（主要动因）
 *   原先只靠浏览器在页面加载时的被动触发。PWA 常驻后台不关的用户可能长期停在
 *   旧版本。这里补上「回到前台时检查」+「每小时兜底检查」两条主动路径。
 *
 * ② 无法显式声明 updateViaCache
 *   navigator.serviceWorker.register 的第三参数控制 sw.js 本身是否走 HTTP 缓存，
 *   默认 'imports'。GitHub Pages 对所有文件（含 sw.js）发 Cache-Control: max-age=600，
 *   显式传 'none' 表示更新检查总是回源。
 *
 *   实测说明（Chromium，A/B 对照）：带与不带该参数行为一致 —— 发版后第 1 次打开
 *   都能发现新版（预缓存 revision 已换新），即 Chromium 的更新检查本就会绕过
 *   sw.js 的 HTTP 缓存。保留该参数**不是为了修 Chromium 的问题**（它没有这个问题），
 *   而是不依赖引擎默认行为（各引擎对 updateViaCache 的实现并不统一），
 *   且 sw.js 前面若有 CDN/代理时语义更明确。
 *
 * 为什么不能用插件配置解决（实测 vite-plugin-pwa 2.0.0）：
 *   - 自动注入脚本 dist/registerSW.js：register(url, { scope }) 没有第三参数
 *   - virtual:pwa-register：内部走 workbox-window，构造参数写死
 *     new Workbox('__SW__', { scope, type })（dist/client/build/register.js:27）
 *   - RegisterSWOptions 类型里也没有 updateViaCache 字段
 * 因此改为手动注册，并在 vite.config.ts 设 injectRegister: null 停用自动注入。
 *
 * 注意：以上只解决「能不能发现新版本」。发现之后，新版本仍要等**下一次冷启动**
 * 才真正生效 —— sw.js 里的 skipWaiting + clientsClaim 只保证新 SW 立刻接管，
 * 改变不了当前这个已经渲染完的页面。
 *
 * 实测时序（本地 SW 环境，服务端发版后）：
 *   第 1 次打开：导航由旧 SW 处理 → 显示旧版；后台发现并装上新版（预缓存已换新）
 *   第 2 次打开：导航由新 SW 处理 → 显示新版
 *
 * ③ 让「第 1 次打开」就换成新版（2026-11-27 新增）
 *
 *   动因不是「体验不好」，而是**旧壳会跑出真故障**：11-27 线上「首次点工作台 →
 *   视频监控 → 跳回首页」，三个入口（桌面 Chrome / iPhone Safari / 主屏书签）
 *   全复现，本地 dev 不复现。逐字符对比线上包与本地包后确认**线上代码已是修复版**
 *   （`index-apDnYpli.js` 与本地 `index-CDEZkonC.js` 归一化 CDN 常量后完全相等）。
 *   复现的是**旧壳**：旧 SW 的预缓存里存着旧 index.html，`navigateFallback` 把它
 *   当导航结果返回，于是页面跑的是没有 `owned` 计数器加固的旧 JS。而 dev 根本不
 *   注册 SW（本文件末尾 `if (!import.meta.env.PROD) return`），所以永远是最新源码。
 *
 *   代价权衡：发版后让旧壳多活一次会话，就等于让一个已知缺陷多活一次会话。
 *   所以这里在 **controllerchange（已换代）** 时主动换版，但**只在不会打断任何
 *   进行中操作的前提下**：
 *     · 页面不可见（切到后台）→ 用户看不到，直接 reload，回来就是新版；
 *     · 可见且无进行中的操作（没开覆盖层 / 没在输入）→ 直接 reload，只是闪一下；
 *     · 其余（开着监控、子页、正在输入）→ 不打扰，仍走 UpdateBanner 让用户决定。
 *   没自动刷新也不会亏：controllerchange 之后新 SW 已接管，**下一次导航必然返回
 *   新壳**，旧代码最多在本条会话里跑完。
 */

/** 兜底检查间隔：1 小时。update() 是一次条件请求，sw.js 仅约 1.6 KB，开销可忽略 */
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000

/**
 * 「现在刷新会不会打断用户」所需的全部判据。
 *
 * 只列**会丢状态**的层，不做「有没有操作过」这类推断：刷新能重建的东西不算打断，
 * 刷新会丢的东西才算。手机号输了一半、监控正播着、隐患填到第三栏 —— 这三类若被
 * 刷掉，用户会认为是故障。
 */
export interface ReloadBlockers {
  /**
   * 不在首页标签（智控 / 消息 / 我的）。
   *
   * `shell.activeTab` 是纯内存态、无路由，刷新后必回初值 `'home'` —— 用户正停在
   * 智控看设备读数，页面自己跳回首页，观感就是「又跳回首页了」（和本次要修的那个
   * 故障一模一样），必须在刷新前避开。
   */
  offHome: boolean
  /**
   * 开着子页/详情，**且不是登录页**。
   *
   * 登录页要排除掉：刷新后 `App.vue` 的 onMounted 会按 `!isLoggedIn` 自动重新
   * 弹出，观感与没刷一样，而它恰好是「发版后第一次打开」最常见的画面。
   */
  subpage: boolean
  /** 监控播放器 */
  cam: boolean
  /** 航拍播放器 */
  air: boolean
  /** 隐患填报 */
  hazard: boolean
  /** 底部弹层 */
  sheet: boolean
  /** 地图全屏（横屏态） */
  land: boolean
  /** 焦点在输入控件上（输入法正打开，刷新会清空已输入内容） */
  typing: boolean
}

/**
 * 纯判定：能不能无声刷新。
 *
 * 抽成独立函数而不是内联在回调里，是为了可单测 —— 这段判断一旦写错，代价是
 * 「用户正在填隐患，页面自己刷新了」，比不刷新严重得多，必须有办法在 CI 里守住。
 */
export function canSilentReload(b: ReloadBlockers): boolean {
  return (
    !b.offHome && !b.subpage && !b.cam && !b.air && !b.hazard && !b.sheet && !b.land && !b.typing
  )
}

/**
 * 状态快照的读取器，由 `App.vue` 注入。
 *
 * 为什么不在这里直接读 DOM（如 `document.querySelector('.subpage.open')`）：
 * 状态只在 store 里改是本项目的铁律；用 DOM 反推状态会在「状态已改、DOM 未提交」
 * 的那一帧给出错误答案（`historyBack` 的 `fireBack` 就是这么踩过的，见文档
 * 六点一百零六）。工具层只管时序，判断交回持有状态的那一层。
 *
 * 缺省全 true：**没注册之前永不自动刷新**。宁可少刷一次，也不要在没人担保的情况下
 * 把用户的页面刷掉。
 */
let readBlockers: () => ReloadBlockers = () => ({
  offHome: true,
  subpage: true,
  cam: true,
  air: true,
  hazard: true,
  sheet: true,
  land: true,
  typing: true,
})

/** 由 App.vue 在挂载时调用，注册真实的状态读取器 */
export function setReloadBlockers(fn: () => ReloadBlockers): void {
  readBlockers = fn
}

/**
 * 注册 Service Worker 并启动更新检查
 *
 * 只在生产构建下注册：dev 环境由插件提供的是 dev-sw.js，与线上 sw.js 不同源，
 * 且此前 dev 的 SW 会缓存旧外壳、干扰调试（见 vite.config.ts 的 injectRegister 注释）。
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  // BASE_URL 由 vite 的 base 配置注入（当前为 '/xycMobileDigitalMap/'）。
  // swUrl 与 scope 必须一致，否则注册会落在错误路径下。
  const swUrl = `${import.meta.env.BASE_URL}sw.js`
  const scope = import.meta.env.BASE_URL

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(swUrl, { scope, updateViaCache: 'none' })
      .then((registration) => {
        const check = (): void => {
          // 离线或网络抖动时会 reject，属预期情况，静默忽略
          registration.update().catch(() => {})
        }

        // 回到前台时检查一次：用户从后台切回来是最可能赶上发版的时机
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check()
        })

        window.setInterval(check, UPDATE_CHECK_INTERVAL)

        /*
         * 新 SW 接管后换版（见文件头 ③）。
         *
         * 首次安装也会触发 controllerchange（clientsClaim 接管空控制器），此时
         * 页面本来就是最新壳，刷新纯属白折腾，故以「注册时刻是否已有 controller」
         * 作守卫 —— 有 controller 就说明之前跑过一版，这次是**换代**。
         *
         * 分支顺序即优先级：
         *   ① 页面不可见：用户看不到，直接换，回来就是新版（零打断）；
         *   ② 可见但没有进行中的操作：闪一下即可，收益远大于代价；
         *   ③ 有进行中的操作：只广播事件，由 UpdateBanner 让用户决定。
         */
        if (navigator.serviceWorker.controller) {
          let settled = false
          const reloadNow = (): void => {
            settled = true
            window.location.reload()
          }

          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (settled) return
            if (document.visibilityState === 'hidden') {
              reloadNow()
              return
            }
            if (canSilentReload(readBlockers())) {
              reloadNow()
              return
            }
            // 收口：本轮只提示一次，不排队等「下次切后台」—— 新 SW 已接管，
            // 用户下次打开必然是新壳，旧代码最多在本条会话里跑完。
            settled = true
            window.dispatchEvent(new CustomEvent('xyc:sw-updated'))
          })
        }
      })
      .catch(() => {
        // 注册失败（如隐私模式、不支持）不阻断应用启动
      })
  })
}
