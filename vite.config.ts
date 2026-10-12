import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 项目站点部署在子路径下，必须与仓库名逐字符匹配（含大写）。
  // 若改为根路径部署，把 base 换成 '/' 即可。
  base: '/xycDigitalMap/',

  plugins: [
    vue(),

    VitePWA({
      // 现场用户不会手动刷新，用 autoUpdate 让新版本静默生效
      registerType: 'autoUpdate',

      // 这些图标同时用于 <link rel="icon">，需一并纳入预缓存清单
      includeAssets: ['favicon-64.png', 'apple-touch-icon.png'],

      manifest: {
        name: '工地数字地图移动端标准版',
        short_name: '数字地图',
        description: '向阳村项目智能建造管理平台 · 移动端',
        lang: 'zh-CN',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#0b1a2b',
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
         * 刻意排除 img/ 下的业务图片（10 张 / 3.3 MB，最大单张 cam-kitchen.png
         * 818 KB）—— 进预缓存会让首次安装流量暴涨，且这些图并非每次都需要。
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
