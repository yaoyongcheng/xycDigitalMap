import { createApp } from 'vue'
import { createPinia } from 'pinia'

// 全局样式：整体搬运的原 app.css，单文件引入一次。
// 不拆分 scoped —— 该文件是线性级联 + 覆盖链（暗色层/横屏层/两列宫格层均为覆盖），
// 拆分或调整顺序会导致样式失效。详见迁移方案「CSS 迁移策略」。
import './styles/app.css'

import App from './App.vue'
import { useAuthStore } from './stores/auth'
import { registerServiceWorker } from './utils/pwa'
import { mountDiag, unmountDiag } from './utils/diag'
import { hideBootSplash, markEnvironment } from './utils/standalone'

const pinia = createPinia()
createApp(App).use(pinia).mount('#app')

/**
 * 主屏独立运行的环境标记（2026-11-19）
 *
 * 给 <html> 打 is-standalone / is-ios / is-android / no-has。
 * 其中 no-has 是兼容兜底：老内核（Chrome 105 之前，部分小米 / 华为 / OPPO / vivo
 * 自带浏览器）不支持 :has()，样式表里靠它切换的「子页打开时隐藏底栏」会失效，
 * 由 CSS 的等价 class 规则顶上。详见 utils/standalone.ts。
 */
markEnvironment()

/**
 * 移除 index.html 的启动骨架。
 *
 * iOS 独立窗口没有地址栏、也不能下拉刷新，入口 JS 若慢一拍就是一秒多的白屏；
 * 骨架铺在 #boot 上（同 background_color 的深蓝），这里等首帧画出来再淡出。
 */
hideBootSplash()

/**
 * 尽早建一次会话 store：它负责从 localStorage 恢复 token 并注册到 api/http 的
 * 请求头注入钩子上。若等到用户点开「我的」才创建，首屏就可能带着空 token 去
 * 请求需要鉴权的接口（表现为莫名 401）。
 */
useAuthStore(pinia)

// 真机诊断浮层：仅当 URL 带 ?diag 时挂载，正常访问首行即返回、零开销。详见 utils/diag.ts
mountDiag()

// 开发期热更新会重跑本文件；不卸掉上一份诊断浮层就会叠加定时器与 DOM
if (import.meta.hot) import.meta.hot.dispose(() => unmountDiag())

// PWA 离线与更新。注册行为受 vite.config.ts 的 injectRegister: null 约束 ——
// 自动注入脚本已停用，注册完全由这里接管，详见 utils/pwa.ts。
registerServiceWorker()

