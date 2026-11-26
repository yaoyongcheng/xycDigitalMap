# 生产构建与服务器部署（H5）

> 2026-11-25 构建验证通过。本文只讲**怎么把 `dist` 放上线**，不讲开发调试。

## 一、本地产出

```bash
npm run build          # = vue-tsc --noEmit && vite build
```

- 输出目录：`dist/`（Vite 默认，未自定义 `build.outDir`）
- 打包文件：`xyc-digital-map-dist-20261125.zip`（4.8 MB，**zip 内是 dist 的根内容**，没有多套一层目录）
- 构建产物结构（5.8 MB / 61 个文件）：

| 路径 | 内容 | 体积 |
|---|---|---|
| `index.html` | 唯一入口 | 9.6 kB（gzip 4.5 kB） |
| `assets/index-DYF_2RCM.js` | 业务主包 | 519.7 kB（gzip 182.7 kB） |
| `assets/mpegts-C7LVOrfd.js` | 视频流解码（首屏按需加载） | 272.4 kB（gzip 61.8 kB） |
| `assets/index-BULs1g1V.css` | 全站样式 | 142.2 kB（gzip 26.6 kB） |
| `img/` | 业务图片（WebP 为主） | 3.3 MB |
| `startup/` | iOS 启动图（10 张） | 968 kB |
| `data/` | 静态兜底 JSON（2 个） | 12 kB |
| `sw.js` / `workbox-*.js` | Service Worker（预缓存 12 项 / 921.9 KiB） | — |
| `manifest.webmanifest` + 7 张图标 | PWA 安装信息 | — |

## 二、必须知道的三个硬约束

### 1. 只能部署在 `/xycMobileDigitalMap/` 子路径

`vite.config.ts` 里 `base: '/xycMobileDigitalMap/'`，构建产物里所有引用都写死了这个前缀：

```html
<link rel="stylesheet" href="/xycMobileDigitalMap/assets/index-BULs1g1V.css">
<script type="module" src="/xycMobileDigitalMap/assets/index-DYF_2RCM.js"></script>
```

放到别的路径（例如根 `/`）会全站 404 白屏。想放根路径必须改 4 处后**重新构建**（不能只改 nginx）：

- `vite.config.ts` 的 `base` → `'/'`
- `manifest.id` / `start_url` / `scope` → `'/'`
- `workbox.navigateFallback` → `'/index.html'`
- `index.html` 里硬编码的 `startup/*.png` 引用（它们走 `BASE_URL`，通常自动跟随，但要复查）

### 2. 三个同源前缀必须由服务端提供，纯静态托管会缺功能

| 前缀 | 上游 | 缺了会怎样 |
|---|---|---|
| `POST /crane-api/*` | `https://tciccs.cscec3bxjy.cn:30400` | 塔机作业报表全「—」（上游不放行任何跨域来源，浏览器直连必失败） |
| `POST /iot-api/*` | `https://iot.cscec3b-iti.com` | 电梯四格全「—」（换令牌接口预检 403 且无 ACAO） |
| `WS /mqtt` | 本机直连 `115.159.67.12:1883` | 塔机实时状态/吊重不刷新（页面不报错，只是不更新） |

`/mqtt` **不是普通反向代理**：厂商的 WS 网关（`:8084/mqtt`）2026-11-12 起持续 502/404，现在的做法是由 Node 进程**直连 TCP 1883 自己对外提供 WebSocket**（`server/mqttBridge.mjs`）。nginx 做不到这件事，必须有一个 Node 进程在跑。

### 3. HTTPS 部署会让大半接口失效（混合内容）

现场后端目前只有 HTTP：

| 用途 | 地址 | HTTPS 页面上能否用 |
|---|---|---|
| 登录 / 用户 | `http://115.159.67.12:8081` | ❌ 被混合内容拦 |
| 设备台账 | 同 IP `:8084` | ❌ |
| 报警 + 抓拍 | 同 IP `:8085` | ❌ |
| 天气 | 同 IP `:8088` | ❌ |
| 爬架 / 监控清单 | `http://120.26.34.95:9689` | ❌ |
| 视频流 FLV | `http://120.26.34.95:9092` | ❌（连播放都不行） |
| 塔机数据 | `https://tciccs.cscec3bxjy.cn:30400` | ✅ |
| 电梯 IoT | `https://iot.cscec3b-iti.com` | ✅ |
| 无人机 keehang | `https://*.keehang.com:23443` | ✅ |
| 运营平台 | `https://dw.yzw.cn` | ✅ |

**结论：当前现场条件下请用 HTTP 部署。** 页面加载后 `api/config.ts` 会自己检测这个组合（`mixedBlocked`），登录页会挂一条橙色提示。

若必须上 HTTPS，两条路：
- 给现场 8081/8084/8085/8088/9689/9092 配 HTTPS 或统一走同域反代，再用 `VITE_*` 环境变量把地址改成本地路径后重新构建；
- 全部走同域反代（`/api`、`/media`、`/cdn`、`/flv`），并在 `.env.local` 里写：

```bash
VITE_API_BASE=https://your.host/api
VITE_MEDIA_ORIGIN=https://your.host/media
VITE_CDN_ORIGIN=https://your.host/cdn
VITE_CCTV_FLV_ORIGIN=https://your.host/flv
```

## 三、方案 A（推荐，最省事）：直接跑自带的 Node 服务

`server/serve.mjs` 零依赖，同时干完四件事：静态文件、两个 POST 反代、MQTT WebSocket 桥、正确的缓存头。

```bash
# 服务器上（需 Node 18+，因为用了 fetch / AbortSignal.timeout）
mkdir -p /opt/xyc
unzip xyc-digital-map-dist-20261125.zip -d /opt/xyc/dist   # zip 里就是 dist 根内容
# server/ 目录要单独上传（就两个文件，零第三方依赖）
ssh root@host "mkdir -p /opt/xyc/server"
scp server/serve.mjs server/mqttBridge.mjs root@host:/opt/xyc/server/
cd /opt/xyc && node server/serve.mjs --port 8080 --dir /opt/xyc/dist
```

> `server/serve.mjs` 默认按仓库结构解析 `--dir`（相对项目根 `dist`），
> 上面显式传 `--dir` 就是给这种「dist 和 server 分开放」的部署准备的。

访问：`http://<服务器IP>:8080/xycMobileDigitalMap/`

长期运行建议交给进程管理器（`pm2 start server/serve.mjs -- --port 8080`，或 systemd）。它可以再被 nginx 反代到 80：

```nginx
server {
  listen 80;
  server_name your.host;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    # WebSocket（/mqtt）必须带这两个头，否则塔机实时推送连不上
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_set_header Host $host;
  }
}
```

## 四、方案 B：nginx 纯静态 + 一个 Node 桥

把 dist 内容放到 `/var/www/xycMobileDigitalMap/`，另起一个进程只提供反代与 `/mqtt`（同样用 `node server/serve.mjs`，它也会顺带托管静态文件，重复无害）：

```nginx
server {
  listen 80;
  server_name your.host;
  root /var/www;

  # 站点（dist 内容放在 /var/www/xycMobileDigitalMap/）
  location /xycMobileDigitalMap/ {
    try_files $uri $uri/ /xycMobileDigitalMap/index.html;
  }

  # PWA 自动更新的关键：这两个必须每次回源
  location = /xycMobileDigitalMap/sw.js        { add_header Cache-Control "no-cache"; }
  location = /xycMobileDigitalMap/index.html   { add_header Cache-Control "no-cache"; }

  # 带内容哈希，可永久缓存
  location /xycMobileDigitalMap/assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # manifest 的 MIME 必须对，否则「添加到主屏幕」不生效
  location ~* \.webmanifest$ {
    types { }
    default_type application/manifest+json;
    add_header Cache-Control "no-cache";
  }

  # 两个 POST 反代
  location /crane-api/ {
    proxy_pass https://tciccs.cscec3bxjy.cn:30400/;
    proxy_set_header Host tciccs.cscec3bxjy.cn;
    proxy_read_timeout 30s;
  }
  location /iot-api/ {
    proxy_pass https://iot.cscec3b-iti.com/;
    proxy_set_header Host iot.cscec3b-iti.com;
    proxy_read_timeout 30s;
  }

  # MQTT WebSocket → 本机 Node 桥
  location /mqtt {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }

  # 建议开压缩：主包 508 KB → 179 KB
  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml application/manifest+json;
  gzip_min_length 1024;
}
```

## 五、缓存与 MIME 的硬要求（做错就是「改了不生效」或白屏）

| 文件 | 缓存头 | 做错的后果 |
|---|---|---|
| `assets/*`（文件名带哈希） | `max-age=31536000, immutable` | 白白多耗流量，但不影响正确性 |
| `sw.js` | **`no-cache`** | 新版本永远发现不了，用户一直看旧页面 |
| `index.html` | **`no-cache`** | 同上：它决定引用哪几个哈希文件 |
| `*.webmanifest` | `application/manifest+json` | 安卓「添加到主屏幕」失败 |
| `*.js` | `text/javascript` | 配 `X-Content-Type-Options: nosniff` 时直接白屏 |

`index.html` 里还内联了一段 12 秒看门狗：白屏超过 12 秒会把启动骨架改成「加载失败，请检查网络后重试」。看到那句话，先查 `assets/*.js` 是否 404 / MIME 是否对。

## 六、上线自检清单

1. `http://host/xycMobileDigitalMap/` 返回 200，页面出现启动骨架并进入首页；
2. F12 Network：`assets/index-*.js`、`assets/index-*.css`、`manifest.webmanifest`、`pwa-192x192.png` 全 200；
3. 登录能进（说明 `:8081` 通）；首页设备台账有数字（说明 `:8084` 通）；
4. 塔机卡「今日吊次」有值、状态点会闪（说明 `/mqtt` 通）；点进去「作业报表」有图表（说明 `/crane-api` 通）；
5. 电梯卡有「在线 x/y」（说明 `/iot-api` 通）；抓拍能出图（说明 `:8085` + CDN 通）；
6. 爬架页有读数与「更新时间」（说明 `:9689` 通）；监控能播（说明 `:9092` 通）；
7. HTTP 部署时不要期待：Service Worker（无离线/无 PWA 安装）、`navigator.share`（存相册退化为下载文件）、剪贴板/定位 API —— 这是非安全上下文的固有限制，不是 bug。

## 七、换现场 / 换后端地址

默认值写在 `src/api/config.ts`（`http://115.159.67.12:8081`、CDN `120.26.34.95` 等）。换服务器时**必须重新构建**，因为是编译期注入：

```bash
# .env.local（不进 git）
VITE_API_BASE=http://new.host:8081
VITE_DATA_BASE=http://new.host:8084
VITE_WF_BASE=http://new.host:8085
VITE_WEATHER_BASE=http://new.host:8088
VITE_CDN_ORIGIN=http://new.host:9689
VITE_CCTV_FLV_ORIGIN=http://new.host:9092
VITE_MEDIA_ORIGIN=http://new.host
npm run build
```

不填 `VITE_DATA_BASE` / `VITE_WF_BASE` / `VITE_WEATHER_BASE` 时，它们会从 `VITE_API_BASE` **换端口**推导（8081 → 8084/8085/8088），所以同一台机器换 IP 时只填 `VITE_API_BASE` 就够。

## 八、方案 C：Docker Compose（仓库已自带）

三个文件已经放在仓库里，不用自己写：

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 多阶段，三个 target：`builder`（npm ci + build）、`web`（nginx）、`bridge`（Node `/mqtt` 桥） |
| `docker-compose.yml` | `web` + `bridge` 两个服务，端口、依赖、健康检查都配好 |
| `deploy/nginx.conf.template` | 静态托管 + `/crane-api`、`/iot-api` 两段反代 + `/mqtt` 转发 + 缓存策略；上游地址用 `${CRANE_UPSTREAM}` 等占位符，**启动时**由 nginx 官方 entrypoint 的 envsubst 渲染成 `conf.d/default.conf` |
| `deploy/README.md` | 给发布者的一页纸：配置项、验收命令、故障对照 |
| `.dockerignore` | 排除 `node_modules`/`dist`/`legacy` 等，**保留 `.env`**（现场地址靠它在构建期写入） |

```bash
docker compose config            # 先校验（不启动）
docker compose up -d --build     # 构建并启动
docker compose logs -f bridge    # 看 MQTT 桥有没有连上 broker
```

访问 `http://<宿主机IP>:8080/xycMobileDigitalMap/`（`WEB_PORT=80 docker compose up -d` 可改端口）。

**为什么是两个容器**：`/crane-api`、`/iot-api` 只是普通 HTTP 反代，nginx 够用；但 `/mqtt`
不是「转发到现成的 WebSocket 服务」——现场没有可用的 WS 上游（厂商网关 `:8084` 自
2026-11-12 起 502/404），真实上游是 `bridge` 里的 Node 进程：它用 TCP 连 broker 的
`1883`，再把长连接包装成 WebSocket。nginx 做不了这件事。

Docker 部署下有三条与裸机一样的硬约束，另加两条容器特有的：

| 约束 | 说明 |
|---|---|
| 容器要能出网到 `115.159.67.12:1883`（TCP） | 否则 `/mqtt` 永远连不上，塔机实时不刷新 |
| 只跑 nginx 不跑 bridge | `/mqtt` 会 502，页面不报错、只是数值停住 |
| 别给它套 HTTPS | 现场 `:8081/:8084/:8085/:8088/:9689` 全是 HTTP，混合内容会整批拦掉 |
| `web` 必须等 `bridge` 健康 | nginx 启动时就要解析 `bridge` 这个服务名，解析不到会反复重启（compose 里已用 `depends_on.condition` 处理） |
| 改 `base` 要重建镜像 | 前缀写在构建产物里，`COPY` 目标目录也跟着变 |
