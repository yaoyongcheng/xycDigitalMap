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

## 账号登录（2026-11）

「我的」页接入了现场服务器的真实鉴权（接口与 Unity 端「向阳村-万联装备集群作业系统」一致）。

**登录流程**（`src/api/auth.ts`）：

1. `GET /api/user/auth/public-key` → `{ code, message, data: { public_key } }`（1024 位 PEM）
2. `POST /api/user/auth/login`，body `{ encrypted_data }`；
   `encrypted_data = Base64(RSA_PKCS1v15(JSON.stringify({ username, password })))`
3. 响应 `{ access_token, expires_in }` → 建立本地会话

> 服务端拒绝明文登录（返回「为了安全起见，登录请求必须加密」），所以两步都不能省。
> WebCrypto 只支持 RSA-OAEP、不支持 PKCS#1 v1.5 加密，因此用 `jsencrypt`。
> RSA 1024 单块明文上限 117 字节，超长会在本地先拦下并提示。

**Token 注入**：`src/api/http.ts` 的 `request(path, { auth: true })` 自动加
`Authorization: Bearer {token}`（同 Unity 端 `GetTokenHeader`）；401 会清会话并提示重新登录。
业务接口以后统一走这个封装，不要各自 `fetch`。

**会话持久化**：token 存 localStorage（键 `xyc.auth.session`，只存 token/过期时间/账号/姓名，
**不存密码**），刷新后自动恢复；过期或登出即清。服务端没有 refresh token 端点，静态站点
不落盘就得每次重登 —— 更严格的做法是服务端下发 httpOnly Cookie，属后端改造项。

**接口地址**：默认 `http://115.159.67.12:8081`，可用 `VITE_API_BASE` 覆盖（模板见 `.env.example`）。

> ⚠️ 本地 `npm run dev` 是 HTTP 页面，可直接联调；部署到 GitHub Pages 后页面是 HTTPS，
> 而现场接口只有 HTTP，浏览器会按「混合内容」拦截。登录页会提前给出提示。
> 上线有三条路：给接口配 HTTPS（最优）、在同域加一层 HTTPS 反代、或者整个站点走 HTTP
> ——最后一条见下方「HTTP 部署」。

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

### HTTP 部署（绕开混合内容）

先说结论：**GitHub Pages 对 `*.github.io` 强制 HTTPS，仓库设置里没有关闭开关**，
所以「把这个 Pages 站点改成 HTTP」本身做不到 —— 想走 HTTP 只能自托管。

仓库自带一个零依赖静态服务 `server/serve.mjs`，直接复用 Pages 那份 `dist/`：

```bash
npm run deploy:http              # 先构建再起服务（默认 8080）
npm run serve:http -- --port 80  # dist 已构建时只起服务
```

启动后打印可访问地址：

```
本机     http://localhost:8080/xycDigitalMap/
局域网   http://192.168.8.54:8080/xycDigitalMap/   ← 手机同 WiFi 用这个
```

站点挂在 `/xycDigitalMap/`（与 `vite.config.ts` 的 `base` 一致，故无需二次构建），
访问 `/` 会 302 过去。`assets/` 永久缓存、`sw.js` 与 HTML 强制回源。

实测（局域网 HTTP 地址）：登录页不再出现混合内容提示，填错误账号能拿到服务端原文
「用户名或密码错误」，说明取公钥 → RSA 加密 → 登录端点整条链路在 HTTP 下是通的。

**要公网 HTTP**：把 `dist/` 拷到现场服务器，nginx 吃静态文件即可：

```nginx
server {
  listen 80;
  server_name _;
  root /var/www;
  location = / { return 302 /xycDigitalMap/; }
  location /xycDigitalMap/ {
    # 单页回退：不带扩展名的路径交给 index.html
    try_files $uri $uri/ /xycDigitalMap/index.html;
  }
  # 哈希文件名可长缓存；sw.js 必须回源，否则新版本永远发现不了
  location ~* ^/xycDigitalMap/assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }
  location = /xycDigitalMap/sw.js {
    add_header Cache-Control "no-cache";
  }
}
```

**HTTP 的固有代价**（浏览器规范，任何 HTTP 部署都一样，不是本项目的 bug）：

- **Service Worker 不注册** → 没有离线缓存，也不能「添加到主屏幕」当 App 用；
- **`navigator.share` 不可用** → 航拍 / 巡检的「下载」回退成落文件，
  不再弹系统分享面板存相册；
- 剪贴板、定位等 API 受限（非安全上下文）。

想同时保住 PWA 与「存相册」，就别降级站点，而是在同域加一层 HTTPS 反代把 `/api`
转到现场 HTTP 服务（此时构建给 `VITE_API_BASE=/api`）—— 站点仍是 HTTPS，
混合内容不存在，PWA 与 share 全保留。

### 真机测试的 HTTPS 约束

用 `npm run dev -- --host` 让手机经局域网 IP 访问时，地址是 `http://192.168.x.x:5173`
—— **Service Worker 不会注册**，只能验证 UI。

推荐用 Chrome USB 端口转发绕开（`chrome://inspect` → Port forwarding），
手机侧地址变为 `localhost`，SW 即可注册。

同一条限制对 `npm run serve:http`（上方 HTTP 部署）一样成立 —— 非 localhost 的
HTTP 地址本来就进不了安全上下文。

## 后续计划

接入后端接口，把 `src/stores/` 中的硬编码数据替换为 API 调用。

数据来源已按领域归入 store，替换时无需改动组件：`cameras` / `inspectAlarms` /
`siteEquip` / `siteBuildings` / `qaCats` / `peopleTree` / `messages` /
`airImgs` 等。其中 `inspectAlarms` 是全项目唯一被 4 个功能域
（首页安全面板 / 巡检列表 / 预警详情 / 趋势图）消费的数据源。

原版实现与已知缺陷见 `legacy/README.md`。
