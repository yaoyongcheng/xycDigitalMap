import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Connect, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// 塔机实时推送的 MQTT↔WebSocket 桥（dev / preview / serve.mjs 共用）
import { attachMqttBridge } from './server/mqttBridge.mjs'

/**
 * 塔机数据服务反代（仅开发期）
 *
 * `tciccs:30400` **不放行任何跨域来源** —— 带 `Origin` 的预检 `OPTIONS` 一律
 * `403 Invalid CORS request`，正常 POST 的响应里也没有 `Access-Control-Allow-Origin`。
 * 浏览器因此读不到响应体，而 Postman / curl 不执行同源策略，看上去就成了
 * 「Postman 能调、页面调不通」。开发期用这个中间件把它挂到同源的 `/crane-api` 下。
 *
 * 为什么不用 `server.proxy`：Vite 8（rolldown）的代理是原生实现，走自己的
 * 网络栈，对这类非常规端口（:30400）在本机直接 ECONNREFUSED；
 * 用 Node 的 `fetch` 手写一层更可控，也能在 `server/serve.mjs` 里复用同一套逻辑。
 *
 * 只转发这一个前缀、只接受 POST、请求体上限 64KB —— 它不是通用代理。
 */
const CRANE_PREFIX = '/crane-api'
const CRANE_UPSTREAM = 'https://tciccs.cscec3bxjy.cn:30400'

/**
 * 物联网网关的反代前缀（`/iot-api/*` → `iot.cscec3b-iti.com`）
 *
 * 与塔机是同一个病，但**病灶更窄**，这点值得记清楚：
 *
 * | 接口 | 预检 OPTIONS | 实际响应 ACAO | 浏览器能直连吗 |
 * |---|---|---|---|
 * | `/api/data/v1/tsdb/*` | 200 + `allow-origin/headers/methods` | 有（回显 origin） | **能** |
 * | `/api/webgateway/v1/access/token` | **403，无任何 CORS 头** | **无** | **不能** |
 *
 * 也就是说数据接口本身是好的，唯独**换令牌那个接口没进 CORS 过滤链**。
 * 浏览器带 `Content-Type: application/json` 发 POST 必然先打预检，预检 403 →
 * 请求根本出不去，`fetch` 抛 TypeError。于是 `ensureToken()` 永远失败，
 * 三个取数函数统统拿到 null，页面四格全「—」——**且不显示「重新登录」提示条**，
 * 因为那提示只认 401，而这里连 HTTP 状态码都没拿到。
 *
 * 这正是「V2 有数据、我们没有」的真正原因：V2 是 Unity 客户端走原生 socket，
 * 不受同源策略约束；我们是浏览器，绕不过预检。拿 curl / node 直连都能成功，
 * 所以历史上一直误判成「参数不对」「权限被收回」。
 *
 * 试过且不通的路（别再试）：
 *   · `Content-Type: text/plain` 绕预检 → 服务端 415，该接口只吃 application/json
 *   · `application/x-www-form-urlencoded` → 同样 415
 *   · 换 Origin 求进白名单 → localhost / *.github.io / null 全部 403
 *   · `mode: 'no-cors'` → 请求能发出但响应是 opaque，读不到 token
 *
 * 唯一可行的就是同源反代。**注意它有部署前提**：`npm run dev` / `preview` 与
 * `npm run deploy:http`（server/serve.mjs）都有这层；GitHub Pages 是纯静态托管，
 * 没有反代 —— 那种部署下电梯数据必然拿不到，除非原厂把 token 接口的 CORS 补上。
 */
const IOT_PREFIX = '/iot-api'
const IOT_UPSTREAM = 'https://iot.cscec3b-iti.com'

const PROXY_MAX_BODY = 64 * 1024

/**
 * 反代处理器工厂：dev server 与 preview server 共用一份。
 *
 * connect 的挂载会把 `req.url` 截成前缀之后的部分（`/crane-api/x` → `/x`），
 * 正好原样拼到上游主机名上，不用自己剥前缀。
 *
 * `maxBody` 限的是**请求体**（查询条件，几 KB）；响应不设上限 ——
 * 电梯工况一次能回 658 帧、几百 KB，卡住就把数据截断了。
 */
function postProxy(upstream: string, timeoutMs = 20_000): Connect.NextHandleFunction {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end('Method Not Allowed')
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    try {
      await new Promise<void>((resolve, reject) => {
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size > PROXY_MAX_BODY) {
            req.destroy()
            reject(new Error('too large'))
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve())
        req.on('error', reject)
      })
    } catch {
      res.statusCode = 413
      res.end('Payload Too Large')
      return
    }

    try {
      const up = await fetch(`${upstream}${req.url ?? ''}`, {
        method: 'POST',
        headers: {
          'Content-Type': req.headers['content-type'] ?? 'application/json; charset=UTF-8',
          Accept: 'application/json',
        },
        body: Buffer.concat(chunks),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await up.text()
      res.statusCode = up.status
      res.setHeader('Content-Type', up.headers.get('content-type') ?? 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(text)
    } catch (e) {
      res.statusCode = 502
      res.end(`Bad Gateway: ${(e as Error)?.message ?? e}`)
    }
  }
}

function craneProxy(): Plugin {
  const handler = postProxy(CRANE_UPSTREAM)
  return {
    name: 'xyc-crane-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(CRANE_PREFIX, handler)
    },
    /**
     * `vite preview` 用的是 preview server，**不共享** `configureServer` 挂的中间件。
     * 不挂这一份的话，用 `npm run preview` 验证 `dist` 产物时 `/crane-api` 会 404，
     * 看着像「反代白写了」—— 其实只是挂错了服务器。
     */
    configurePreviewServer(server) {
      server.middlewares.use(CRANE_PREFIX, handler)
    },
  }
}

/**
 * 物联网网关反代（`/iot-api`）—— 动机见上方 `IOT_PREFIX` 的说明。
 *
 * 超时给 25s：换令牌 + 一次 6 小时工况窗可能回几百 KB，比塔机慢。
 */
function iotProxy(): Plugin {
  const handler = postProxy(IOT_UPSTREAM, 25_000)
  return {
    name: 'xyc-iot-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(IOT_PREFIX, handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(IOT_PREFIX, handler)
    },
  }
}

/**
 * 塔机实时推送的同源桥（`/mqtt`）
 *
 * 浏览器碰不到原始 TCP 1883，所以历史上是转发到厂商的 WS 网关
 * `ws://115.159.67.12:8084/mqtt`。但那条网关路由 2026-11-12 傍晚起持续
 * 502/404（同一时刻 1883 完全正常、订阅立刻收到三台车推送）—— 坏的是 WS 包装，
 * 不是数据。现在改为**本机直连 1883，自己对外提供 WebSocket**，
 * 实现见 `server/mqttBridge.mjs`（dev / preview / serve.mjs 共用一份）。
 *
 * 前端零改动：照旧连同源 `/mqtt` 说 MQTT-over-WS。
 */
type UpgradeServer = { httpServer?: import('node:http').Server | null }

function attachMqttUpgrade(server: UpgradeServer): void {
  const httpServer = server.httpServer
  if (!httpServer) return
  attachMqttBridge(httpServer)
}

function mqttWsProxy(): Plugin {
  return {
    name: 'xyc-mqtt-ws-proxy',
    apply: 'serve',
    configureServer(server) {
      attachMqttUpgrade(server)
    },
    // 同 craneProxy：preview server 不共享 configureServer 挂的东西
    configurePreviewServer(server) {
      attachMqttUpgrade(server)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 项目站点部署在子路径下，必须与仓库名逐字符匹配（含大写）。
  // 若改为根路径部署，把 base 换成 '/' 即可。
  base: '/xycDigitalMap/',

  plugins: [
    vue(),

    // 开发期把塔机数据服务挂到同源下（CORS 白名单不含本站，直连必被拦）
    craneProxy(),

    // 物联网网关：换令牌接口预检 403 且无 ACAO，浏览器直连必失败（数据接口本身没问题）
    iotProxy(),

    // 塔机实时推送：broker 的 MQTT-over-WS 挂到同源 /mqtt
    mqttWsProxy(),

    VitePWA({
      // 现场用户不会手动刷新，用 autoUpdate 让新版本静默生效
      registerType: 'autoUpdate',

      // 这些图标同时用于 <link rel="icon">，需一并纳入预缓存清单
      includeAssets: ['favicon-64.png', 'apple-touch-icon.png'],

      /**
       * 关闭自动注入注册脚本，改为 src/utils/pwa.ts 手动注册。
       *
       * 动因：注入的 registerSW.js 是写死的 register(url, { scope })，
       * 没有任何回调入口，无法挂「回到前台/定时主动检查更新」，也无法显式
       * 声明 updateViaCache（详见 pwa.ts 顶部注释与实测说明）。
       *
       * 影响面（实测）：
       *   构建产物不再有 dist/registerSW.js；index.html 不再注入该 script；
       *   预缓存清单从 9 条降到 8 条。
       *   注册逻辑全部由 pwa.ts 接管，且只在生产构建下执行。
       *
       * 顺带：dev 下也不再注入（插件据此判断，见 chunk-I2Z7IWCN.js:656），
       * 此前 dev 的 SW 会缓存旧外壳、干扰本地调试。
       * 注：devOptions 仍保留 enabled —— 开发期还要靠它注入 manifest 调试；
       * 已注册过 dev SW 的浏览器需清除一次站点数据。
       */
      injectRegister: null,

      manifest: {
        name: '工地数字地图移动端标准版',
        short_name: '数字地图',
        description: '向阳村项目智能建造管理平台 · 移动端',
        lang: 'zh-CN',
        display: 'standalone',
        orientation: 'any',
        /**
         * theme_color 决定系统状态栏区域底色，也是 iOS 判断状态栏文字颜色的依据
         * （深底配白字、浅底配黑字）。取浅色与导航栏 #fff 一致，避免工作台等
         * 浅色页面顶部出现一条黑带；首页与横屏覆盖层运行时会由
         * src/utils/themeColor.ts 动态改回深色。
         */
        theme_color: '#ffffff',
        background_color: '#0b1a2b',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          // maskable 让 Android 自适应图标时不被裁掉主体
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        /**
         * 预缓存 = 应用外壳，只含构建产物。
         * 图标不在此列，由上面的 includeAssets 负责 —— 两处都写会导致
         * 同一个图标在预缓存清单里出现两次（实测 13 条中有 4 条是重复项）。
         *
         * 刻意排除 img/ 下的业务图片（8 张 / 1.1 MB）—— 进预缓存会让首次安装
         * 流量暴涨，且这些图并非每次都需要。
         * 2026-10：业务图已由 jpg/png 统一转为 WebP（原 1.8 MB → 1.1 MB）；
         * 原先两张零引用的 cam-kitchen.png / cam-frame.png（共 1.5 MB）已移出
         * public/，不再进发布产物。
         */
        globPatterns: ['**/*.{js,css,html,woff2}'],

        // 预缓存体积上限（默认 2 MB），留出余量
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,

        // 单页应用：所有导航请求回退到 index.html
        navigateFallback: '/xycDigitalMap/index.html',

        runtimeCaching: [
          {
            // 业务图片全部走运行时缓存：首次访问后长期可用
            urlPattern: /\/img\/.*\.(?:png|jpg|jpeg|webp|svg)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'xyc-img',
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 天
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },

      // 让 dev 环境下也能看到 manifest 与 SW，便于调试
      devOptions: { enabled: true },
    }),
  ],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  build: {
    // 与 PWA 预缓存策略配套：图片不进预缓存，靠运行时缓存兜底
    chunkSizeWarningLimit: 800,

    // 关键：禁止 esbuild 把 @media (max-width: 480px) 改写成 Media Queries Level 4
    // 的范围语法 (width<=480px)。该语法需 Chrome 104+ / Safari 16.4+，
    // 而这条媒体查询正是手机全屏显示的关键 —— 在不支持的设备上会静默失效，
    // 导致小屏仍渲染成 390px 手机壳。固定保守目标以保证传统写法原样输出。
    cssTarget: ['chrome87', 'safari14', 'firefox78', 'edge88'],
  },
})
