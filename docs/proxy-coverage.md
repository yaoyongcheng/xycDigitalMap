# 反向代理影响面与验证手册

> 回答两个问题：**这三条反代各自撑着哪些页面**、**怎么确认它们真的生效了**。
> 代码位置按 2026-11-25 的仓库状态标注，改动后请同步本文件。
> 部署步骤见 `deploy/README.md`，配置在 `deploy/nginx.conf.template`。

---

## 零、先说清楚：本项目没有 URL 路由

没有 vue-router，页面切换靠 store 状态：

| 层级 | 机制 | 位置 |
|---|---|---|
| 一级页 | `shell.activeTab` = `home` / `work` / `msg` / `mine` | `src/stores/shell.ts:70` |
| 子页 | `subpage.view` = `{ kind: 'device' \| 'uav' \| 'climb' \| 'login' … }` | `src/stores/subpage.ts:22` |
| 页内页签 | 组件内 `ref`（如塔机的 `pageTab`） | `DevicePage.vue:63` |

所以「路由」一栏给的是**视图标识**，不是 URL。深链分享不成立，排查时也不能靠改地址栏复现。

---

## 一、总览

| 通道 | 反代到什么 | 撑起的页面 | 失效后的第一现场 |
|---|---|---|---|
| `/crane-api/*` | `tciccs.cscec3bxjy.cn:30400` | 首页智控塔机格、5G塔机页、塔机作业报表 | 塔机今日吊次/吊重全「—」，报表全空 |
| `/iot-api/*` | `iot.cscec3b-iti.com` | 智能电梯页、首页智控电梯格、设备弹层 | 电梯四格全「—」+ 顶部提示条 |
| `/mqtt`（WS） | `bridge` → TCP `115.159.67.12:1883` | 5G塔机页下两格、首页智控实时项、设备弹层 | 数字不跳，其余正常、不报错 |

---

## 二、通道一：`/crane-api`

### 接口

| 项 | 值 |
|---|---|
| 前端基址 | `CRANE_BASE`，默认 `/crane-api`（`src/api/towerCrane.ts:63`） |
| 实际请求 | `POST /crane-api/api/towercranedataservice/getWorkCycleInfoHis` |
| 上游 | `https://tciccs.cscec3bxjy.cn:30400/api/towercranedataservice/getWorkCycleInfoHis` |
| 参数 | `{ sn, startTime, endTime }`，按单台塔机 + 日期区间查工作循环 |
| 为什么要代 | 该服务不放行任何跨域来源：带 `Origin` 的 `OPTIONS` 回 `403 Invalid CORS request`，正常响应也没有 `Access-Control-Allow-Origin` |

### 影响面（三处，不止报表）

| 页面 / 模块 | 视图标识 | 组件 | 用到的字段 | 使用场景 |
|---|---|---|---|---|
| 首页 · 智控面板 · 塔机格 | `activeTab='home'` + `home.homeMod='equip'` | `views/home/EquipPanel.vue` | `craneDay`（全场合计） | 首页一眼看今天全场合计吊次/吊重 |
| 5G塔机页 · 每张卡上两格 | `subpage.view={kind:'device',device:'crane'}` | `views/sub/DevicePage.vue` | `craneDayBySn`（逐台） | 进塔机页看单台今日吊次/吊重 |
| 塔机页 · 作业报表 | 同上 + `pageTab='report'` | `views/sub/DeviceReport.vue` | 明细逐条 → 本地汇总 | 周报/月报：6 格统计、风险三卡、三张分布图、长图导出 |

取数实现：`stores/deviceLedger.ts` 的 `craneDayBySn`（逐台）与 `craneDay`（合计）
共用一批响应；报表走 `stores/craneReport.ts` 的 `fetchCraneWorkCycles`。

> **合计口径**：只要有一台查询失败（返回 `null`），`craneDay` 整体为 `null`、
> 卡片退回「—」，不会用部分数据凑合。所以单台 sn 配错也会表现成「首页全空」。

### 入口路径

```
底栏「首页」 → 上滑抽屉 → 面板滑块切到「智控」 → 点塔机卡
   ├── 卡片直接显示：今日吊次 / 今日吊重（本通道）
   └── 进 5G塔机 页 → 顶部页签「作业报表」→ 报表页
```

### 失效表现

- 塔机卡上两格为「—」，报表 6 格全「—」、三张图没有柱子；
- **页面不报错、不弹提示**（与 `/iot-api` 不同），最容易「以为只是今天没干活」。

---

## 三、通道二：`/iot-api`

### 接口（只代一跳，别扩大理解）

| 项 | 值 |
|---|---|
| 前端基址 | `IOT_TOKEN_BASE`，默认 `/iot-api`（`src/api/iot.ts:106`） |
| 被代的唯一一跳 | `POST /iot-api/api/webgateway/v1/access/token` |
| 上游 | `https://iot.cscec3b-iti.com/api/webgateway/v1/access/token` |
| 数据接口怎么走 | `IOT_BASE = 'https://iot.cscec3b-iti.com'`（`iot.ts:76`），**直连，不经反代** |
| 为什么要代 | 网关 CORS 是半拉子：`/api/data/v1/tsdb/*` 预检 200 且回显 ACAO，但 token 这一个**没进 CORS 过滤链**（预检 403、响应无 ACAO）。拿不到 token，后面所有数据请求都不会发出 |

### 影响面

| 页面 / 模块 | 视图标识 | 组件 | 用到的东西 | 使用场景 |
|---|---|---|---|---|
| 智能电梯页 · 4 张轿厢卡 | `subpage.view={kind:'device',device:'lift'}` | `views/sub/DevicePage.vue` | 当前楼层/高度/人数/载重（`EVENT_POST_ATTR` 工况帧） | 现场看 4 笼电梯实时状态 |
| 首页 · 智控 · 电梯格 | `homeMod='equip'` | `views/home/EquipPanel.vue` | 在线 x/y、今日运行时长 | 首页看电梯整体在线率 |
| 设备信息弹层 | `bottomSheet` | `components/sheets/DeviceInfoSheet.vue` | 电梯当前状态、运行时长 | 点卡片看档案 |

调用链：`iot.ts::ensureToken` → `api/lift.ts` → `stores/lift.ts` → 上面三处。

### 失效表现（有专门提示，好认）

- 电梯四格全「—」；
- 电梯页顶部会出现提示条：**「电梯网关没连上 —— 部署环境缺「/iot-api」反代，或服务器无法出网」**
  （`DevicePage.vue:351`）。这句话就是为这个场景写的，看到它直接查反代，别点「重试」。

---

## 四、通道三：`/mqtt`（WebSocket）

### 接口

| 项 | 值 |
|---|---|
| 前端地址 | `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mqtt`（`src/api/craneRealtime.ts:95`） |
| 可覆盖 | `VITE_CRANE_WS`（**构建期**，改完要重建） |
| 协议 | MQTT 3.1.1 over WebSocket（自实现客户端 `src/api/mqttWs.ts`） |
| 上游 | nginx → `http://bridge:8080` → 容器内 Node 用 **TCP** 连 `115.159.67.12:1883` |
| 为什么要代 | 浏览器开不了 TCP；厂商的 WS 网关（`:8084/mqtt`）自 2026-11-12 起 502/404 |

### 影响面

| 页面 / 模块 | 组件 | 用到的字段 | 使用场景 |
|---|---|---|---|
| 5G塔机页 · 卡片下两格 | `views/sub/DevicePage.vue` | 当前吊重、当前负荷（= 吊重 ÷ 5t） | 看这一吊现在多重、有没有超载 |
| 首页 · 智控 · 塔机实时项 | `views/home/EquipPanel.vue` | 同上 | 首页判断设备是否在动 |
| 设备信息弹层 | `components/sheets/DeviceInfoSheet.vue` | 当前状态 | 弹层里的状态行 |

连接策略：**引用计数、不常驻**（`stores/craneRealtime.ts`）。页面打开才订阅，关掉即断，
避免手机流量常挂一条 WS。

### 关键分诊表：塔机卡四格是两个数据源

排查时先看「哪几格不对」，能直接定位是哪条通道：

| 卡面位置 | 字段 | 数据源 | 坏了说明 |
|---|---|---|---|
| 左上 / 右上 | 今日吊次 / 今日吊重 | `/crane-api`（HTTP） | 通道一 |
| 左下 / 右下 | 当前吊重 / 当前负荷 | `/mqtt`（WS） | 通道三 |

**四格全「—」= 通道一**；**只有下两格不动、上两格有数 = 通道三**。

---

## 五、看着像要反代、其实不需要的

| 接口 | 为什么不用代 | 依据 |
|---|---|---|
| `https://iot.cscec3b-iti.com/api/data/v1/tsdb/*` | 预检 200、回显 ACAO、放行 `x-app-user` 头 | `iot.ts:81-103` 实测记录 |
| `https://dw.yzw.cn/open`（人员/考勤/组织） | 对任意 Origin 回显 ACAO | `api-migration.md` 2026-11-18 实测 |
| `http://120.26.34.95:9689`（CDN：爬架 + 监控清单） | CORS 通 | 同上 |
| 地图底图 `api/scene.ts` | 服务端已放行 `X-API-Key` 与预检 | 该文件 30 行注释 |
| 萤石云 / keehang / 登录 8081 等 | 各自回 CORS 或本来就同源 | 各 api 文件头 |

> ⚠️ 「不需要反代」≠「怎么部署都行」。这些地址多数是 **HTTP**，站点一旦上 HTTPS，
> 会被混合内容整批拦掉 —— 这是协议问题，不是 CORS 问题。

---

## 六、怎么验证反代生效（三层，从下往上）

### 第 1 层：配置真的渲染了

```bash
docker compose ps                                   # 两个服务都应是 healthy
docker compose exec web cat /etc/nginx/conf.d/default.conf | grep -n "proxy_pass"
docker compose exec web nginx -t
```

| 检查项 | 预期结果 | 不符说明 |
|---|---|---|
| `web` / `bridge` 状态 | 都是 `healthy` | `bridge` unhealthy → `/mqtt` 必挂 |
| 三行 `proxy_pass` | 是**真实地址**：`https://tciccs.cscec3bxjy.cn:30400/`、`https://iot.cscec3b-iti.com/`、`http://bridge:8080` | 看到 `${CRANE_UPSTREAM}` 原样残留 → envsubst 没跑 / 变量没传，nginx 会报 `invalid URL prefix` |
| `nginx -t` | `syntax is ok` + `test is successful` | 报错即配置问题 |

### 第 2 层：三条通道通不通（服务器上，不碰浏览器）

```bash
# ① 塔机
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:8080/crane-api/api/towercranedataservice/getWorkCycleInfoHis

# ② 电梯换令牌
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:8080/iot-api/api/webgateway/v1/access/token

# ③ MQTT 握手
curl -s -o /dev/null -w '%{http_code}\n' -m 5 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' \
  http://127.0.0.1:8080/mqtt
```

| 通道 | 通过 | 业务层拒绝也算通过 | 失败 |
|---|---|---|---|
| ① 塔机 | `200` | `400`（参数不全） | `404` / `502` / `504` |
| ② 电梯 | `200` | `400` / `401`（空 body） | `404` / `502` / `504` |
| ③ MQTT | `101` | —— | `400` / `404` / `502` |

判断要点：**只要拿到上游的业务响应（哪怕是 4xx），就说明反代这条路通了**。
代理层故障只会给 404/502/504 这类「根本没到上游」的码。

### 第 3 层：浏览器里业务真的出数

开 DevTools → Network：

| 筛什么 | 预期 |
|---|---|
| `crane-api` | `getWorkCycleInfoHis` 200，Response 里 `data` 非空数组 |
| `iot-api` | `access/token` 200，Response 有 token 字段 |
| `WS`（筛 `mqtt`） | 状态 `101`，Frames 里能看到周期性报文 |

再肉眼验收四处：

1. **首页智控 · 电梯格**：在线 x/y 有数，「今日运行时长」不是「—」；
2. **智能电梯页**：4 张轿厢卡的楼层/高度/人数/载重都有值；
3. **5G塔机页**：四格都有数，且**盯 30 秒**——下两格（当前吊重）会自己变；
4. **塔机作业报表**：6 格统计有值、三张图有柱子、点柱子能弹读数。

---

## 七、没生效怎么查（按症状分诊）

| 症状 | 最可能的原因 | 怎么定位 |
|---|---|---|
| `/crane-api/...` 返回 **404**，且响应体是 `index.html` | nginx 没这条 location（挂的是默认站点 / 模板未渲染） | `docker compose exec web grep -c crane-api /etc/nginx/conf.d/default.conf`，应为 1 |
| 返回 **502 Bad Gateway** | 上游不可达：服务器出不了网、DNS 解析失败、端口被防火墙拦 | 容器内直连上游对照：`docker compose exec web wget -qO- --no-check-certificate --post-data='{}' --header='Content-Type: application/json' https://tciccs.cscec3bxjy.cn:30400/...` |
| 返回 **504** | 上游慢于超时（塔机 20s / 电梯 25s） | 同上，看直连耗时；真慢就调 template 里的 `proxy_read_timeout` |
| 返回 **403** | 上游拒绝：缺 SNI / `Host` 头带了端口 / 来源 IP 不在白名单 | 核对 `CRANE_HOST` 是否为**纯域名**；确认原厂是否按来源 IP 授权 |
| **200 但 `data` 为空** | 不是反代问题，是业务（sn 不匹配、日期区间无数据） | 拿同一组参数直连上游对比，两边一致就说明反代无辜 |
| `/mqtt` 一直 `pending` 或 `101` 后立刻断开 | `bridge` 没起 / `MQTT_UPSTREAM` 写成 `127.0.0.1` / broker 1883 不通 | `docker compose logs bridge` 看是否 `connected`；`docker compose exec bridge node -e "..."` 测 TCP |
| 控制台 `Mixed Content` 报错 | 站点被套了 HTTPS，而接口是 HTTP | 改回 HTTP 访问；或按 `docs/deploy-h5.md` 的混合内容章节整体处理 |
| 电梯页出现「部署环境缺 /iot-api 反代」提示 | token 一跳没出去 | 走第 2 层第 ② 条 |
| 只有塔机下两格不动 | `/mqtt` 通、`/crane-api` 通 | 看 broker 是否有该 sn 的 topic 推报文 |

**排查顺序建议**：先第 1 层（配置渲染），再第 2 层（通道），最后才看页面 ——
因为页面上的「—」对三条通道是同一个长相，从下往上查能少绕两圈。

---

## 八、信息缺口（这几项需要你补充才能定稿）

| 缺口 | 影响 | 需要什么 |
|---|---|---|
| 生产环境**域名与端口**未定 | 决定 WS 用 `ws://` 还是 `wss://`、是否触发混合内容 | 发布后的实际访问地址 |
| 塔机平台是否按**来源 IP 白名单**授权 | 反代后来源变成服务器 IP，可能被拒 | 原厂确认；或一份能用的调用凭据说明 |
| 现场防火墙是否放行**出向 1883** | 不通则 `/mqtt` 永远握手失败 | 运维确认，或一次 `telnet 115.159.67.12 1883` 的记录 |
| 既有 nginx 是否已占用 80 | 端口冲突 / 需要外层再代一层 | 现有站点配置或 `ss -lntp` 输出 |
| `/mqtt-drone`（无人机读数） | **当前不存在，但不是误记**：2026-11-16 实现过（`api/droneMqtt.ts` + 同源桥，另一台 broker `47.106.219.250:1883`、机库 2.3Hz），当日 11:45 按决定回滚到 `1eb7713`，改造整体存进 `git stash@{0}`「wip: 无人机 MQTT OSD 推送改造」。现在无人机走 REST 轮询 | 若哪天 `git stash pop` 恢复它，**必须同步加第四条反代** `/mqtt-drone`（WS → 该 broker），否则无人机页读数整页「—」 |
| 无人机 MQTT 读数（若有）走哪条 WS | 决定是否要第四条反代 | 对应接口文档或现场抓包 |

---

## 九、一句话备忘

三条通道、两个数据源混在一张卡上 —— **看「哪几格不对」，比看控制台快**。
