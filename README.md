# 工地数字地图移动端标准版

向阳村项目智能建造管理平台 · 移动端。Vue 3 + Vite + TypeScript 实现的 PWA。

## 技术栈

| 项 | 版本 |
|---|---|
| Vue | 3.5 |
| Vite | 8.3 |
| TypeScript | 5.9 |
| Pinia | 4.0 |
| vite-plugin-pwa | 2.0（Workbox 7） |

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5173/xycDigitalMap/
npm run build      # 产出 dist/
npm run preview    # 以生产产物预览（验证 PWA 安装与离线）
npm run typecheck  # 仅做类型检查
```

> `localhost` 满足 Secure Context 要求，Service Worker 在本地即可注册调试，无需 HTTPS 证书。

## 目录结构

```
├── index.html                  Vite 入口（manifest 与 SW 注册由插件构建期注入）
├── vite.config.ts              base / PWA / cssTarget 配置
├── public/
│   ├── img/                    业务图片 10 张 / 3.3 MB（走运行时缓存，不进预缓存）
│   └── pwa-*.png 等            PWA 图标
├── legacy/                     迁移前原版（冻结，不参与构建），见 legacy/README.md
└── src/
    ├── main.ts
    ├── App.vue                 三层壳 .stage / .phone / .phone-screen
    ├── types.ts                12 个领域接口
    ├── data/                   纯静态配置常量
    ├── stores/                 7 个 Pinia store
    ├── components/
    │   ├── shell/              StatusBar / NavBar / TabBar / Toast
    │   ├── overlays/           5 个全屏覆盖层
    │   └── ui/                 共享组件（返回栏 / 日历 / 日期芯片 / 环形图等）
    ├── views/                  4 个 tab 页 + 首页 4 面板 + 子页内容
    ├── utils/                  日期 / 图表（纯函数）
    └── styles/app.css          777 条规则，单文件全局样式
```

## 两条架构约束（改动前必读）

### 1. 样式必须保持单文件全局，不要拆 `<style scoped>`

`src/styles/app.css` 是**线性级联 + 覆盖链**，不是模块化结构：

- 暗色层整体覆盖首页（145 条规则）
- 横屏层覆盖监控层
- 两列宫格覆盖单列列表
- 5 组 `:has()` 把外壳状态栏耦合到各覆盖层状态
- 3 条 `!important` 构成 7 个覆盖层的全局显隐开关

拆分或调整顺序会破坏级联，导致样式失效。

### 2. 覆盖层用 `.open` class 切换，**不要改成 `v-if`**

7 个覆盖层与 `.subpage` 都常驻 DOM。这是 CSS 的硬依赖：

- `:has(.map-land.open)` 等规则依赖这些元素持续存在才能联动状态栏深浅色
- 横屏规则假定元素常驻

改成 `v-if` 会同时打破这两组规则 —— 必须连同 CSS 一起重写。

## PWA

- **预缓存（应用外壳）**：9 项 / 191.7 KB — `js` / `css` / `html` / 图标
- **运行时缓存（业务图片）**：`/img/*` → `CacheFirst`，60 条 / 30 天
- **更新策略**：`autoUpdate`，新版本静默生效
- **离线能力**：完全断网后硬刷新仍可渲染应用外壳

### 部署

推送到 `main` 触发 `.github/workflows/deploy.yml`，自动构建并发布到 GitHub Pages：

```
https://yaoyongcheng.github.io/xycDigitalMap/
```

> ⚠️ `vite.config.ts` 的 `base` 必须与仓库名逐字符匹配（含大写）。
> 若改为根路径部署，把 `base` 换成 `'/'` 并同步调整 `workbox.navigateFallback`。

### 真机测试的 HTTPS 约束

用 `npm run dev -- --host` 让手机经局域网 IP 访问时，地址是 `http://192.168.x.x:5173`
—— **Service Worker 不会注册**，只能验证 UI。

推荐用 Chrome USB 端口转发绕开（`chrome://inspect` → Port forwarding），
手机侧地址变为 `localhost`，SW 即可注册。

## 后续计划

接入后端接口，把 `src/stores/` 中的硬编码数据替换为 API 调用。

数据来源已按领域归入 store，替换时无需改动组件：`cameras` / `inspectAlarms` /
`siteEquip` / `siteBuildings` / `qaCats` / `peopleTree` / `messages` /
`airImgs` 等。其中 `inspectAlarms` 是全项目唯一被 4 个功能域
（首页安全面板 / 巡检列表 / 预警详情 / 趋势图）消费的数据源。

原版实现与已知缺陷见 `legacy/README.md`。
