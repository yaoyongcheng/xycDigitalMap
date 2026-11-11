# 接口盘点与分阶段迁移计划

来源：桌面端 Unity 包「向阳村-万联装备集群作业系统 V2」的 HybridCLR 热更新 DLL
（`HotUpdateScripts.dll`），用 `dnfile` 读元数据 + `dncil` 反汇编方法体得到调用点与
请求参数，再逐条用真实网络请求验证连通性与返回结构（只读接口）。

> **写接口的处理约定**
> 会改动现场系统数据的接口（报警删除、状态变更、登出、任务增改等）也在本清单里，
> 并且**照样接进本项目**，但：
> - 迁移与联调期间**不发起任何写请求**，避免污染现场原始数据；
> - 接入 UI 时默认关闭 / 二次确认，且在服务端代理可用前不对外开放。

---

## 一、后端与鉴权：一共有五套（四个服务）

项目不是「一个后端」，而是五套（其中 A′ 与 A 同机器不同端口）完全不同的数据源。
这决定了不能只写一个 `request()`。

| 代号 | 地址 | 鉴权 | 用途 |
|---|---|---|---|
| **A. 业务接口** | `http://115.159.67.12:8081` | 用户登录 → `Authorization: Bearer {token}`（RSA 加密登录） | 用户、设备台账、时序数据、天气 |
| **A′. 工作流服务** | 同一台机器的 **`:8085`** | 同上的 `Bearer {token}` | 视频报警列表 / 报警截图 |
| **A″. 认证旁路** | `http(s)://{host}`（**无端口**） | 同上的 `Bearer {token}` | 登出 `/v1/auth/logout`、续期 `/v1/auth/refresh` |
| **B. 大屏 open** | `https://dw.yzw.cn/open` | 项目级 `accessKey` + RSA-SHA256 签名（**无需登录**） | 人员/考勤/组织/网关标签/报警记录 |
| **C. 物联网网关** | `https://iot.cscec3b-iti.com` | `appKey/appSecret` 换 token（`X-Access-Token`） | 设备实时数据、告警事件、电梯/塔机 |
| **D. 第三方** | `https://open.ys7.com`（萤石云）、`https://account.keehang.com:23443`（无人机） | 各自 appKey / CAS 账号 | 监控视频流、无人机任务 |

已完成：A 的登录三件套（`public-key` / `login` / `me`）+ token 注入（阶段 0）、
B 的签名客户端 `src/api/open.ts`（阶段 1）、B 的班组出勤与分时人数（阶段 2）。
阶段 2 顺带查明「视频报警在 8085 而不在 8081」，见 A′ 与第二节的说明。

---

## 二、接口全量清单

### A. 业务接口（`:8081`）

| 方法 | 路径 | 用途 | 项目侧消费点 | 状态 |
|---|---|---|---|---|
| GET | `/api/user/auth/public-key` | 取登录公钥 | 登录页 | ✅ 已接 |
| POST | `/api/user/auth/login` | 登录（body 为 RSA 密文） | 登录页 | ✅ 已接 |
| GET | `/api/user/auth/me` | 当前用户 | 我的页 | ✅ 已接 |
| GET | `/api/user/auth/me/unity-permission` | 权限菜单 | 我的页菜单项 | ⬜ 阶段 7 |
| GET | `/api/data/areas?page=1&page_size=100&project_id=` | 总平区域标签 | 地图撒点 | ⬜ 阶段 5 |
| GET | `/api/data/buildings` | 楼栋清单 | 进度/楼栋分布 | ⬜ 阶段 5 |
| GET | `/api/data/deviceinfos?page=1&page_size=100&project_id=` | 设备台账 | 智控设备列表/详情 | ⬜ 阶段 3 |
| POST | `/api/data/v1/tsdb/queryRealTimeDataV2` | 实时数据（查询语义） | 设备实时状态页 | ⬜ 阶段 3 |
| POST | `/api/data/v1/tsdb/queryEvent` | 事件查询 | 报警/事件时间线 | ⬜ 阶段 3 |
| POST | `/api/towercranedataservice/getWorkCycleInfoHis` | 塔机工作循环（查询） | 塔机详情「吊次」 | ⬜ 阶段 3 |
| POST | `/api/webgateway/v1/access/token` | IOT 网关换令牌 | C 组全部请求的前置 | ⬜ 阶段 3 |
| GET | `/api/video/alarms?page=1&page_size=50&sceneCode=` | 视频报警列表 | 智眸/报警预警 | ✅ **已接**（阶段 3，**在 8085**） |
| GET | `/api/video/alarms/{id}/picture` | 报警截图（返回 base64） | 预警详情大图 | ✅ **已接**（阶段 3，**在 8085**） |
| POST | `/v1/auth/logout` | 登出 | 我的·退出登录 | ✅ **已接**（基址 `ServerUrl`，**无端口**） |
| POST | `/v1/auth/refresh` | 令牌续期（到期前 5 分钟） | 会话保活 | ⬜ 待接（同一基址） |
| GET | `/api/map/amap/weather/live?city=` | 实时天气 | 首页天气角标 | ⬜ 阶段 4 |
| GET | `/api/map/amap/weather/forecast?city=` | 天气预报 | 同上 | ⬜ 阶段 4 |
| 🔒 DELETE | `/api/video/alarms/{id}` | **删除报警** | — | 写，不调用 |
| 🔒 PATCH | `/api/video/alarms/{id}/status` | **修改报警状态** | — | 写，不调用 |
| 🔒 POST | `/api/webgateway/v1/auth/api/appUser/logout` | **IOT 登出** | — | 写，不调用 |

> **视频报警不在 8081**。`Unity` 端的 `GetWFUrl(8085, …)` 把这两条打到**工作流服务
> 8085**（同一台机器，只换端口）：`:8081` 上访问 `/api/video/alarms` 是
> `404 page not found`，`:8085` 上是 `{"code":401,"message":"未提供认证令牌"}`。
> 所以接它需要 `API_BASE` 之外再一个 `WF_BASE`（同 host、端口 8085）。

### B. 大屏 open（`https://dw.yzw.cn/open`，只读）

统一签名：`sign = Base64(RSA-SHA256(accessKey + timestamp + nonce))`，
URL 追加 `projectKey / accessKey / timestamp / nonce / sign`。

| 路径 | 用途 | 对应页面 | 状态 |
|---|---|---|---|
| `/bigScreen/BigsHome/personOverall` | 人员总览（在册/在岗/出勤/出勤率） | 首页·人员总览 | ✅ **阶段 1 已接** |
| `/bigScreen/BigsHome/todayTeamsAtteStat` | 今日班组出勤（3 个班组） | 首页·今日班组出勤 | ✅ **阶段 2 已接** |
| `/bigScreen/BigsHome/todayPersonHourStat` | 今日分时人数（管理/工人） | 首页·今日分时人数 | ✅ **阶段 2 已接** |
| `/bigScreen/BigsHome/weekEnterpriseAtteStat` | 周企业出勤（近 7 日 × 3 企业） | 暂无消费点（已备客户端） | ✅ 可用 |
| `/bigScreen/bigAlarm/getAlarmRecord` | 报警记录（分页） | 报警预警列表/历史 | ⚠️ **实测恒为 0 条**（见下） |
| `/bigScreen/bigAlarm/getMonthRecordStatus` | 月度按状态统计 | 报警历史图表 | ⚠️ 实测 `[]` |
| `/bigScreen/bigAlarm/getMonthRecordSubType` | 月度按子类型统计 | 报警历史图表 | ⚠️ 实测 `[]` |
| `/bigScreen/bigAlarm/getMonthEnterpriseRecordNum` | 企业维度记录数 | 报警下钻 | ⬜ 阶段 5 |
| `/bigScreen/bigAlarm/getMonthOrganRecordNum` | 组织维度记录数 | 报警下钻 | ⬜ 阶段 5 |
| `/organ/list` | 组织/企业清单 | 人员分布、班组下钻 | ✅ 可用（实测 200） |
| `/person/page` | 人员花名册 | 人员列表 | ⚠️ **57007 接口权限未获取** |
| `/report/attendance/attendanceDay` | 日考勤明细 | 考勤页 | ⚠️ **57007 接口权限未获取** |
| `/location/snapshootProjectPersonCountV3` | 项目人员数量快照 | 人员分布 | ⚠️ **57007 接口权限未获取** |
| `/location/personCurLocation/v2` | 人员当前位置 | 人员分布/地图撒点 | ⚠️ **57007 接口权限未获取** |
| `/location/track` | 人员轨迹 | 轨迹回放 | ⚠️ 同上（未单独验证，同属 location 分组） |
| `/device/label/page` | 定位标签（实测 200 条） | 人员定位设备 | ⬜ 阶段 5 |
| `/device/label/getLabelOrPersonRelation` | 标签-人员绑定 | 人员定位 | ⬜ 阶段 5 |
| `/device/gateway/page` | 网关（实测 24 条） | 设备管理 | ⬜ 阶段 5 |
| `/device/gateway/pageByProjectId` | 项目网关 | 设备管理 | ⬜ 阶段 5 |
| `/device/beacon/page` | 信标（实测 78 条） | 设备管理 | ⬜ 阶段 5 |
| `/device/danger/page` | 危险源 | 隐患卡 | ⚠️ 实测 `total=0`（现场未录危险源） |

> **权限缺口说明**：`/person/page`、`/report/attendance/attendanceDay`、
> `/location/*` 用当前 accessKey 全部返回 `57007 接口权限未获取` —— 不是我们调错，
> 是项目没开通这几个接口的授权。需要现场平台给 accessKey 加权限，代码侧已留好调用点。
>
> **报警数据缺口**：`/bigScreen/bigAlarm/*` 虽然 HTTP 200、`statusCode 20000`，但
> 试过无参、`page/pageSize`、`startTime/endTime`（当天/整月/跨年）以及
> `month/date/yearMonth` 各种组合，`total` 恒为 `0`、月度统计恒为 `[]` ——
> 这个项目的大屏报警模块没数据，不是参数问题。首页「报警预警」要么继续用演示
> 数据，要么改接 A 组视频报警（需登录，见下节 8085）。
>
> **工种缺口**：`todayPersonHourStat` 只分「管理 / 工人」，四套后端都没有「按工种
> 统计人数」的端点（Unity 端只有客户端枚举 `WorkTypeToEnum`）。所以设计稿的
> 「今日出勤工种」卡在阶段 2 被换成了有真数据的「今日分时人数」，`.trade-*`
> 样式一并删除，`data/config.ts: tradeRows` 保留作设计稿参考并加了警示注释。

### C. 物联网网关（`https://iot.cscec3b-iti.com`）

| 方法 | 路径 | 用途 | 状态 |
|---|---|---|---|
| POST | `/api/webgateway/v1/access/token` | 换 token | ⬜ 阶段 3（已探测到需补参数） |
| POST | `/api/data/v1/tsdb/queryRealTimeDataV2` | 实时数据 | ⬜ 阶段 3 |
| POST | `/api/data/v1/tsdb/queryEvent` | 告警事件 | ⬜ 阶段 3 |
| 🔒 POST | `/api/webgateway/v1/auth/api/appUser/logout` | 登出 | 写，不调用 |

### D. 第三方与专用服务

| 方法 | 地址 | 用途 | 状态 |
|---|---|---|---|
| GET | `https://open.ys7.com/api/lapp/token/get?appKey=&appSecret=` | 萤石云 token | ⬜ 阶段 6 |
| GET | `https://open.ys7.com/api/lapp/v2/live/address/get?...` | 监控直播地址（HLS/FLV） | ⬜ 阶段 6 |
| POST | `https://account.keehang.com:23443/cas/auth/login` | 无人机平台登录 | ⬜ 阶段 6 |
| POST | `https://account.keehang.com:23443/cas/auth/validate` | 校验 | ⬜ 阶段 6 |
| GET | `https://tciccs.cscec3bxjy.cn:30400/api/towercranedataservice/getWorkCycleInfoHis` | 塔机工作循环 | ⬜ 阶段 6 |
| GET | 无人机：`/live/stream/list`、`/task/list`、`/task/exec/list/record`、`/dashboard/task/list/record`、`/audit_center/get_by_device_id`、`{0}/media/task/job/{1}` | 航线、任务、审计、媒体 | ⬜ 阶段 6 |
| 🔒 POST | `https://iot.keehang.com/dashboard/#/control?st=`（下发控制） | 无人机控制 | 写，不调用 |

---

## 三、项目缺口的盘点结论

按页面倒推，现在缺接口的地方共 **14 处**（原标注「接后端后由接口替换」的演示数据）：

| # | 页面/区块 | 当前数据来源 | 应接接口 | 阶段 |
|---|---|---|---|---|
| 1 | 首页·人员总览 | `data/config.ts: crewKpis` | B `personOverall` | ✅ 阶段 1 |
| 2 | 首页·今日班组出勤 | `data/config.ts: squadRows` | B `todayTeamsAtteStat` | ✅ 阶段 2 |
| 3 | 首页·今日分时人数（原「今日出勤工种」） | `utils/chart.ts` 演示曲线 | B `todayPersonHourStat` | ✅ 阶段 2（工种无接口，已换卡） |
| 4 | 首页·报警预警 + 轮播 | 已登录 → 8085 真数据；未登录 → 常量 | 8085 `/api/video/alarms` | ✅ 阶段 3（登录后生效） |
| 5 | 报警历史（按日） | 真数据覆盖到的日期用真值，其余沿用演示 | 8085 `/api/video/alarms`（按日过滤） | ✅ 阶段 3 |
| 6 | 首页·人员分布 | `stores/home.ts: peopleTree` | B `location/*`（**57007 无权限**）+ `organ/list` | 5（受阻） |
| 7 | 智控·设备列表/四卡 | `stores/home.ts: siteEquip` | A `deviceinfos` + C `queryRealTimeData` | 3 |
| 8 | 设备详情·实时状态 | `data/device.ts` 常量 | C `queryRealTimeDataV2` + `queryEvent` | 3 |
| 9 | 塔机·吊次/工作循环 | `data/device.ts` 常量 | A/C `getWorkCycleInfoHis` | 3 |
| 10 | 智眸·现场快照（监控九宫格） | 静态图 | 8085 `/api/video/alarms` + D 萤石云直播 | 3 |
| 11 | 智眸·实景核验（隐患） | `stores/airHazard.ts` 常量 | B `device/danger/page`（实测 0 条） | 5（无数据） |
| 12 | 巡检任务清单 | `views/sub/InspectList.vue` 常量 | D `/task/list`、`/task/exec/list/record` | 6 |
| 13 | 首页天气 | 无 | A `amap/weather` | 4 |
| 14 | 无人机·航线与任务 | `stores` 常量 + 静态图 | D `/dashboard/*`、`/live/stream/list` | 6 |

---

## 四、分阶段计划

每一阶段都以「可独立上线、可回到演示数据」为界；接口失败一律回落演示数据，
不让页面出现空数字或一直转圈。

| 阶段 | 内容 | 产出 | 状态 |
|---|---|---|---|
| **1** | 接口全量清单 + 大屏 open 签名客户端 + 首页人员总览四指标 | `src/api/open.ts`、`src/api/overview.ts`、`stores/overview.ts` | ✅ 已完成 |
| **2** | 首页班组出勤 + 分时人数（报警顺延） | `src/api/home.ts`、`stores/overview.ts`、`utils/chart.ts`、`SafetyPanel.vue` | ✅ 已完成 |
| **3** | 报警（8085 视频报警）+ 智控设备台账与实时数据（IOT token 待补） | `api/videoAlarm.ts`、`api/device.ts` | ⬜ 需现场账号 |
| **4** | 天气、权限菜单（`unity-permission`） | `api/weather.ts`、我的页菜单由权限驱动 | ⬜ |
| **5** | 人员分布 / 定位 / 隐患 / 网关标签 | `api/people.ts`、`api/iotDevice.ts` | ⏸ 授权未开通，仅 `organ/list` 可用 |
| **6** | 无人机与塔机专用服务（CAS 登录、任务、工作循环） | `api/drone.ts`、`api/crane.ts` | ⬜ |
| **7** | 写接口接入（报警状态变更、删除、登出） | 统一走「显式确认 + 默认关闭」的写入通道 | ⬜ 需服务端代理与审计 |

### 阶段 2 的验收口径（已达成）

- 「今日班组出勤」来自 `GET /open/bigScreen/BigsHome/todayTeamsAtteStat`，实测 3 个
  班组（管理人员 12/19 63.16%、劳务班组 31/103 30.10%、产业工人班组 6/38 15.79%）；
- 「今日分时人数」来自 `GET /open/bigScreen/BigsHome/todayPersonHourStat`，实测
  0..17 整点两条曲线（工人峰值 18、管理峰值 13）；
- 两个接口各自独立成败（`Promise.allSettled`）：任一失败只影响它那块，回落演示数据；
- 曲线会掐掉「当前整点」那个还没结算的 0，避免右端垂直跳水成「人都走光了」；
- 单测覆盖字段收敛（`hours` 是小时数不是人数）、脏行丢弃、并集对齐补 0、空数组回落、
  单接口失败不影响其他块。

### 阶段 3 落地记录（报警 + 登出）

现场服务器在 2026-11-11 上午整体不可达（8081/8085/80 全端口 connect timeout、
ICMP 全丢、traceroute 无响应），所以这一轮用**本地 mock 服务**把链路跑通验证，
真机联调仍需等主机恢复。已验证的部分：

- `src/api/video.ts` → `src/utils/videoAlarm.ts` → `stores/alarm.ts`：
  登录后拉真实报警，映射成项目内的 `Alarm`（首页轮播/巡检列表/预警详情/地图撒点
  四处无需改动）；退出登录即 `clearLive()` 回落演示数据；
- 详情页按服务端 `Id` 异步拉抓拍图（`data:image/jpeg;base64,…`），拉不到保留占位图；
- **登出**对齐 `LoginRequestHelper.LoginOut`：`POST {ServerUrl}/v1/auth/logout`，
  基址是 `ServerConfig.BaseUrl`（`http(s)://host`，**不带端口**），带 Bearer、空 body。
  本地会话**先清再请求**，服务端失败一律吞掉 —— 网络一抖就退不出去是更糟的体验。
- 顺带发现同组还有一个 `POST /v1/auth/refresh`（Unity 在 token 到期前 5 分钟调用），
  比「过期即踢」体验好，留给下一轮。

### 阶段 3 的接口契约（报警）

`/bigScreen/bigAlarm/*` 在这个项目里恒为空，唯一的真实报警源是 **8085**
`/api/video/alarms`，它要求 `Authorization: Bearer {token}` —— 必须有现场账号才能
联调。已从 `AIAlarmListRequester` 的状态机里挖出全部要素，拿到账号即可一次接完：

- 请求：`GET {WF_BASE}:8085/api/video/alarms?page=1&page_size=50&sceneCode=P000000076`
  （`sceneCode` 就是 Unity 端 `StaticParameter.ProjectId`，值 `P000000076`）；
- 响应：`{ code, data: { list: [...] } }`（注意是 `data.list`，不是 `data.rows`）；
- 行字段：`Id`(int) / `CaptureTime` / `AlertName` / `AlertType` / `HandleStatus` / `ChannelNo`；
- 截图：`GET /api/video/alarms/{Id}/picture` 返回 **base64 字符串**（客户端
  `Base64ToSprite`），转 `data:image/jpeg;base64,…` 直接用。

---

## 五、两个必须知道的隐患

1. **私钥在客户端**。大屏 open 用项目级私钥签名，原厂把私钥内嵌在桌面端；本项目
   照搬以拿到数据。它能防公开抓取，但防不住逆向（拿到包就能签）。彻底解决要服务端
   代理签名：前端调 `/proxy/yzw/*`，私钥只留在服务器（`server/serve.mjs` 加路由即可）。
2. **站点协议**。A/C/D 组接口多为 HTTP 或自签证书；站点若走 HTTPS 会被混合内容拦掉。
   当前用自托管 HTTP 部署规避，长期正解仍是「站点 HTTPS + 同域反代」。
