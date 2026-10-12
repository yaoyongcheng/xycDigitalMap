import { createApp } from 'vue'
import { createPinia } from 'pinia'

// 全局样式：整体搬运的原 app.css，单文件引入一次。
// 不拆分 scoped —— 该文件是线性级联 + 覆盖链（暗色层/横屏层/两列宫格层均为覆盖），
// 拆分或调整顺序会导致样式失效。详见迁移方案「CSS 迁移策略」。
import './styles/app.css'

import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')

