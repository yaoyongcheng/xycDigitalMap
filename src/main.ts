import { createApp } from 'vue'
import { createPinia } from 'pinia'

// 全局样式：整体搬运的原 app.css，单文件引入一次。
// 不拆分 scoped —— 该文件是线性级联 + 覆盖链（暗色层/横屏层/两列宫格层均为覆盖），
// 拆分或调整顺序会导致样式失效。详见迁移方案「CSS 迁移策略」。
import './styles/app.css'

import App from './App.vue'
import { registerServiceWorker } from './utils/pwa'
import { mountDiag } from './utils/diag'

createApp(App).use(createPinia()).mount('#app')

// 真机诊断浮层：仅当 URL 带 ?diag 时挂载，正常访问首行即返回、零开销。详见 utils/diag.ts
mountDiag()

// PWA 离线与更新。注册行为受 vite.config.ts 的 injectRegister: null 约束 ——
// 自动注入脚本已停用，注册完全由这里接管，详见 utils/pwa.ts。
registerServiceWorker()

