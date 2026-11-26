# 发布者部署说明（Docker）

> 这份是给**部署的人**看的，不需要懂前端、也不需要写 nginx 配置。
> 反代、缓存、PWA 回源策略都已经做进镜像，你只负责填一个 `.env`、跑三条命令。

---

## 一、交付清单

拿到的是**整个项目目录**（不要只挑文件，构建要用源码）：

| 文件 | 作用 | 你要改吗 |
|---|---|---|
| `Dockerfile` | 三个阶段：构建前端 → nginx 镜像 → MQTT 桥镜像 | 不改 |
| `docker-compose.yml` | 起两个容器（`web` + `bridge`），带健康检查 | 不改 |
| `deploy/nginx.conf.template` | 站点配置：静态托管 + 两段反代 + `/mqtt` 转发 | 不改 |
| `deploy/README.md` | 本文件 | — |
| `docs/proxy-coverage.md` | 三条反代各撑哪些页面、失效长什么样、怎么逐层排查 | 出事时查它 |
| `.env.example` | 配置模板 | **复制成 `.env`**，按现场改 |

`node_modules/`、`dist/` 不用传 —— 镜像里会自己装依赖、自己构建。

---

## 二、三条命令

```bash
# 1. 准备配置（只需第一次，或换环境时）
cp .env.example .env
vi .env                                  # 见第三节，通常只改 WEB_PORT

# 2. 构建并启动
docker compose up -d --build

# 3. 看状态（两个容器都应是 healthy）
docker compose ps
```

访问 `http://<服务器IP>:8080/xycMobileDigitalMap/`（端口取自 `WEB_PORT`）。

> 后面只改 `.env` 里的 `WEB_PORT` / `CRANE_*` / `IOT_*` / `MQTT_*` 时用
> `docker compose up -d` 就够（**不用** `--build`）。
> 但改了 `VITE_*` 必须加 `--build` 重新构建，否则页面里还是旧地址 ——
> 因为 `VITE_*` 是在构建时写死进 JS 文件的。

---

## 三、需要填的配置

全部在 `.env` 里，都有默认值，**不填也能跑**。

| 变量 | 含义 | 默认值 | 什么时候改 |
|---|---|---|---|
| `WEB_PORT` | 对外端口（宿主机） | `8080` | 80 被占用时，或想直接挂 80 |
| `VITE_API_BASE` | 业务接口根地址（登录/台账/报警） | `http://115.159.67.12:8081` | 现场换了服务器 |
| `VITE_CCTV_FLV_ORIGIN` | 视频 FLV 出口 | `http://120.26.34.95:9092` | 换视频网关 |
| `CRANE_UPSTREAM` | 塔机服务 `host:port` | `tciccs.cscec3bxjy.cn:30400` | 换塔机平台 |
| `CRANE_HOST` | 塔机服务纯域名（SNI 用） | `tciccs.cscec3bxjy.cn` | 同上，**不能带端口** |
| `IOT_UPSTREAM` | 电梯云网关 `host:port` | `iot.cscec3b-iti.com` | 换网关 |
| `IOT_HOST` | 网关纯域名（SNI 用） | `iot.cscec3b-iti.com` | 同上，**不能带端口** |
| `MQTT_UPSTREAM` | `/mqtt` 的上游 | `bridge:8080` | **不要改**（除非懂原理） |

### 为什么要拆成 `XX_UPSTREAM` 和 `XX_HOST` 两个

`proxy_pass` 需要 `域名:端口`，而 TLS 握手里的 SNI 和 `Host` 头**只能填纯域名**，
带上 `:30400` 会被上游拒绝。两个变量分工，各填各的一半。

### 这三个反代是干什么的（一句话版）

浏览器有同源策略，直接调这三个地址会被拦（且页面不报错，只是数字变「—」）。
所以站点自己开三条同源通道，由服务器替浏览器去访问：

| 站点路径 | 转发到 | 缺了会怎样 |
|---|---|---|
| `/crane-api/*` | 塔机平台 | 塔机报表全「—」、吊次吊重都是空 |
| `/iot-api/*` | 电梯云网关 | 电梯卡四格全「—」 |
| `/mqtt` | `bridge` 容器（再连 broker 1883） | 塔机实时数据不刷新，其余正常 |

---

## 四、验收（5 分钟）

```bash
# ① 站点能开：200，且 Cache-Control 是 no-cache
curl -sI http://127.0.0.1:8080/xycMobileDigitalMap/ | head -5

# ② 塔机反代通：返回 JSON（400/200 都算通），502/504 就是不通
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:8080/crane-api/api/towercranedataservice/getWorkCycleInfoHis

# ③ 电梯反代通：空 body 会回 400/401，说明请求已经到了上游
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:8080/iot-api/api/webgateway/v1/access/token

# ④ MQTT 桥通：期望 101 Switching Protocols
curl -s -o /dev/null -w '%{http_code}\n' -m 5 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' \
  http://127.0.0.1:8080/mqtt
```

浏览器里最终确认三条：首页地图/台账有数、**电梯卡四格不是「—」**、
**塔机页的吊次数字会自己跳**（说明 MQTT 通）。

---

## 五、故障对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `web` 容器反复重启，日志报 `invalid URL prefix` | `CRANE_UPSTREAM` 等变量没值，模板没渲染 | 检查 `.env` 里变量名是否拼错；`docker compose config` 看最终值 |
| `web` 起不来，报 `host not found in upstream "bridge"` | `bridge` 没先起 | `docker compose down` 后重新 `up -d`，别单独 `up web` |
| 页面能开，但电梯四格全「—」 | `/iot-api` 反代 502（服务器出不了网 / DNS 解析不了） | 进容器验：`docker compose exec web wget -qO- https://iot.cscec3b-iti.com/` |
| 页面能开，塔机报表全「—」 | 同上的塔机一侧 | 验 `tciccs.cscec3bxjy.cn:30400` 的连通性（注意是非标端口，防火墙常只放 443） |
| 塔机实时不动，其他正常 | `/mqtt` 到 broker 1883 不通 | `docker compose logs bridge` 看是否连上 `115.159.67.12:1883` |
| 改了 `.env` 但页面没变 | 改的是 `VITE_*`，没重新构建 | `docker compose up -d --build` |
| 手机提示「不安全」后白屏 | 站点放在了 HTTPS 上 | 见第六节第 1 条 |

---

## 六、三条硬约束（会踩，先看）

**1. 不要给这个站点套 HTTPS。**
现场后端（`:8081`、`:8084`、`:8085`、`:8088`、`:9092`、`:9689`）全是 HTTP，
站点一旦是 https，浏览器会按「混合内容」把这些请求整段拦掉，页面看着能开、
数据全空。这不是加个证书能解决的。要上 HTTPS，得先让后端支持 HTTPS。

**2. 不能只跑 nginx。**
`bridge` 容器是必须的：浏览器不能开 TCP 连接，而 MQTT broker 只有 TCP 1883。
`bridge` 用 Node 把这条 TCP 长连接包成 WebSocket 给页面用。
nginx 只能转发现成的 WebSocket，变不出一个来。

**3. 这套方案要能出网。**
容器需要访问 `tciccs.cscec3bxjy.cn:30400`、`iot.cscec3b-iti.com:443`、
`115.159.67.12:1883`、`115.159.67.12:8081` 等。内网隔离环境需先开白名单。

---

## 七、服务器上不想装 Node / 不能联网构建？

在你本地构建好镜像，导出成文件发过去即可：

```bash
# 本地（需要 Docker）
docker compose build
docker save xyc-digital-map-web:local xyc-digital-map-bridge:local | gzip > xyc-map-images.tar.gz

# 服务器
gunzip -c xyc-map-images.tar.gz | docker load
docker compose up -d          # 注意：不要加 --build，直接用导入的镜像
```

此时服务器上仍需保留 `docker-compose.yml`、`deploy/`、`.env` 三个东西
（compose 要读配置和变量），但不需要源码、不需要 `npm`。

---

## 附：走 GitHub Pages 时的路径坑（与 Docker 无关）

Docker 那套不受影响，因为 nginx 的 `location /xycMobileDigitalMap/` 是我们自己写的。
但 **GitHub Pages 的路径由「仓库名」决定**，与 `vite.config.ts` 里构建用的
`base: '/xycMobileDigitalMap/'` 是两件事：

- base 已是 `/xycMobileDigitalMap/`；
- 仓库名仍是 `xycDigitalMap`。

两者不一致时，Pages 会去 `/xycDigitalMap/assets/...` 找资源而产物在
`/xycMobileDigitalMap/assets/...` → **整站 404**。上线前二选一：把仓库改名成
`xycMobileDigitalMap`，或走自托管（本文档这套）。
