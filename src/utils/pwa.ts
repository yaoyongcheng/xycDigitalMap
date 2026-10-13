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
 * 要做到「打开一次就最新」，还需监听 controllerchange 后 reload，
 * 属单独一轮改动（涉及「是否打断用户操作」的取舍）。
 */

/** 兜底检查间隔：1 小时。update() 是一次条件请求，sw.js 仅约 1.6 KB，开销可忽略 */
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000

/**
 * 注册 Service Worker 并启动更新检查
 *
 * 只在生产构建下注册：dev 环境由插件提供的是 dev-sw.js，与线上 sw.js 不同源，
 * 且此前 dev 的 SW 会缓存旧外壳、干扰调试（见 vite.config.ts 的 injectRegister 注释）。
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  // BASE_URL 由 vite 的 base 配置注入（当前为 '/xycDigitalMap/'）。
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
      })
      .catch(() => {
        // 注册失败（如隐私模式、不支持）不阻断应用启动
      })
  })
}
