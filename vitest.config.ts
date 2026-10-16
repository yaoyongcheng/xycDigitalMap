import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/**
 * 测试配置（独立于 vite.config.ts）
 *
 * 刻意不复用 vite.config.ts：那里挂了 vite-plugin-pwa，跑单测时会去生成
 * Service Worker 与预缓存清单，既慢又与测试无关。这里只保留测试真正需要的
 * 两件事 —— Vue SFC 编译 与 `@/` 路径别名。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
    // 让每个用例从干净的 spy / 全局桩开始
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,vue}'],
      // main.ts 是启动引导（真实副作用全在浏览器里），types.ts 只有类型
      exclude: ['src/main.ts', 'src/types.ts', 'src/**/*.d.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      /*
       * 关掉「先删目录再写」：报告文件名是确定的，原地覆盖即可。
       * 某些受管控的执行环境会把删除操作重定向到回收站并对失败硬报错，
       * 导致第二次跑覆盖率直接崩在这里（与测试本身无关）。
       */
      clean: false,
    },
  },
})
