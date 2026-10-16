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
    ├── types.ts                13 个领域接口（含新增 MapPoint）
    ├── data/                   纯静态配置常量（含新增 mapPoints 撒点坐标）
    ├── stores/                 7 个 Pinia store
    ├── components/
    │   ├── shell/              StatusBar / NavBar / TabBar / Toast / UpdateBanner
    │   ├── overlays/           5 个全屏覆盖层
    │   └── ui/                 共享组件（返回栏 / 日历 / 日期芯片 / 环形图 /
    │                           交互地图 MapViewer / 数字滚动 CountUp 等）
    ├── views/                  4 个 tab 页 + 首页 4 面板 + 子页内容
    ├── utils/                  日期 / 图表（纯函数）/ PWA / 主题色
    └── styles/app.css          单文件全局样式（末尾有「2026-10 改造」分组）
```

## 2026-10 体验改造（新增能力说明）

| 能力 | 入口 | 实现 |
|---|---|---|
| 交互地图：拖拽/捏合/滚轮缩放、双击放大 | 首页顶部地图、横屏全屏地图 | `ui/MapViewer.vue`，点位坐标在 `data/config.ts` 的 `mapPoints` |
| 地图撒点：摄像头/塔吊点开监控，楼栋弹进度摘要 | 点位针标 | HomePage / MapLand 的 `onMapPoint` |
| 抽屉跟手拖拽（收起/半开/全开三档吸附） | 抓手胶囊或「拉起/收回」按钮直接拖 | `shell.sheetLevel`，`HomePage` 拖拽逻辑；点按仍是收起↔全开 |
| 数据动效 | 数字滚动 / 折线描边 / 柱条生长 / 预警呼吸点 | `ui/CountUp.vue` + app.css 末尾 C 组（尊重系统减弱动效设置） |
| 占位功能反馈 | 消息页非巡检项、工作台工具卡 | Toast 提示「接入中」 |
| 数据时效戳 | 安全面板「预警」标题旁 | 面板挂载时刻 |
| PWA 更新可感知 | 新版本就绪弹条 | 见下方 PWA 节 |

> 撒点坐标是按 site-map.jpg 底图目测的演示标定值，接后端时应由接口下发。
> 两条架构约束（单文件 CSS 级联 / 覆盖层 .open 常驻）本次改造均遵守：
> 新增样式全部追加在 app.css 末尾，覆盖层结构未动。

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

4 个覆盖层与 `.subpage` 都常驻 DOM。改动前需知悉：

- **状态栏配色联动已不构成阻碍** —— app.css:160-185 的 5 组
  `.phone-screen:has(...) .status-bar` 在 `v-if` 下依然成立
  （元素存在时即带 `.open`，匹配条件相同）
- **横屏规则仍是硬依赖** —— app.css:3124-3216 的横屏布局假定覆盖层结构
  常驻，改成 `v-if` 必须连同这组 CSS 一起重写

因此当前保持 `.open` 切换。若确实要改用 `v-if`，先处理横屏那组规则。

## PWA

- **预缓存（应用外壳）**：9 项 / 191.7 KB — `js` / `css` / `html` / 图标
- **运行时缓存（业务图片）**：`/img/*` → `CacheFirst`，60 条 / 30 天
- **更新策略**：`autoUpdate` + 可感知提示。新 SW 后台就绪并接管后，
  `utils/pwa.ts` 广播 `xyc:sw-updated`，`shell/UpdateBanner` 弹「新版本已就绪」操作条，
  由用户决定何时刷新（首次安装不打扰，靠「注册时是否已有 controller」守卫）
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
