import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 项目站点部署在子路径下，必须与仓库名逐字符匹配（含大写）。
  // 若改为根路径部署，把 base 换成 '/' 即可。
  base: '/xycDigitalMap/',

  plugins: [vue()],

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
