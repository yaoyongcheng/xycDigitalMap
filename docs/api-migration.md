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
| **A. 业务接口** | `http://115.159.67.12:8081` | 用户登录 → `Authorization: Bearer {token}`（RSA 加密登录） | 用户、天气代理入口 |
| **A′. 工作流服务** | 同一台机器的 **`:8085`** | 同上的 `Bearer {token}` | 视频报警列表 / 报警截图 |
| **A″. 数据服务** | 同一台机器的 **`:8084`** | 同上的 `Bearer {token}` | 设备台账 / 楼栋 / 区域 |
| **A‴. 认证旁路** | `http(s)://{host}`（**无端口**） | 同上的 `Bearer {token}` | ⚠️ 反编译里登出/续期用这个基址，但现场实测 404 —— 见下方「登出」一条 |
| **B. 大屏 open** | `https://dw.yzw.cn/open` | 项目级 `accessKey` + RSA-SHA256 签名（**无需登录**） | 人员/考勤/组织/网关标签/报警记录 |
| **C. 物联网网关** | `https://iot.cscec3b-iti.com` | `appKey/appSecret` 换 token（`X-Access-Token`） | 设备实时数据、告警事件、电梯/塔机 |
| **D. 第三方** | `https://open.ys7.com`（萤石云）、`https://account.keehang.com:23443`（无人机） | 各自 appKey / CAS 账号 | 监控视频流、无人机任务 |
| **E. 天气代理** | 同一台机器的 **`:8088`** | **免登录** | 高德实时/预报天气 |

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
| GET | `/api/user/auth/me/unity-permission` | 权限菜单 | 我的页菜单项 | ✅ **可用**（返回项目→权限位映射，形如 `{"P000000076":"1",…}`；暂无消费点） |
| GET | `/api/data/areas?page=1&page_size=100&project_id=` | 总平区域标签 | 首页·人员分布（区域清单） | ✅ **已接**（**在 8084**，阶段 5；本项目 9 条，无人数字段） |
| GET | `/api/data/buildings` | 楼栋清单 | 进度/楼栋分布 | ✅ **客户端已备**（**在 8084**；设计稿改版后无消费点） |
| GET | `/api/data/deviceinfos?page=1&page_size=100&project_id=` | 设备台账 | 智控设备列表/详情 | ✅ **已接**（**在 8084**，阶段 4） |
| POST | `/api/data/v1/tsdb/queryRealTimeDataV2` | 实时数据（查询语义） | 设备实时状态页 | ⚠️ **全部端口 404**（见下） |
| POST | `/api/data/v1/tsdb/queryEvent` | 事件查询 | 报警/事件时间线 | ⚠️ 同上 |
| POST | `/api/towercranedataservice/getWorkCycleInfoHis` | 塔机工作循环（查询） | 塔机详情「吊次」 | ⚠️ 同上 |
| POST | `/api/webgateway/v1/access/token` | IOT 网关换令牌 | C 组全部请求的前置 | ⬜ 阶段 6 |
| GET | `/api/video/alarms?page=1&page_size=50&sceneCode=` | 视频报警列表 | 智眸/报警预警 | ✅ **已接**（阶段 3，**在 8085**） |
| GET | `/api/video/alarms/{id}/picture` | 报警截图 | 预警详情大图 | ✅ **已接**（阶段 3，**在 8085**；base64 在 `data.pictureData`） |
| POST | `/api/user/auth/logout` | 登出 | 我的·退出登录 | ✅ **已接**（`:8081` 登录域下；`/v1/auth/logout` 与裸源站实测全 404） |
| POST | `/v1/auth/refresh` | 令牌续期（到期前 5 分钟） | 会话保活 | ⬜ 待接（同一基址） |
| GET | `/api/map/amap/weather/live?city=` | 实时天气 | 首页天气角标 | ✅ **可用**（**在 8088，免登录**；设计稿无天气位，暂无消费点） |
| GET | `/api/map/amap/weather/forecast?city=` | 天气预报 | 同上 | ⬜ 未验证（同端口推断可用） |
| 🔒 DELETE | `/api/video/alarms/{id}` | **删除报警** | — | 写，不调用 |
| 🔒 PATCH | `/api/video/alarms/{id}/status` | **修改报警状态** | — | 写，不调用 |
| 🔒 POST | `/api/webgateway/v1/auth/api/appUser/logout` | **IOT 登出** | — | 写，不调用 |

> **视频报警不在 8081**。`Unity` 端的 `GetWFUrl(8085, …)` 把这两条打到**工作流服务
> 8085**（同一台机器，只换端口）：`:8081` 上访问 `/api/video/alarms` 是
> `404 page not found`，`:8085` 上是 `{"code":401,"message":"未提供认证令牌"}`。
> 所以接它需要 `API_BASE` 之外再一个 `WF_BASE`（同 host、端口 8085）。
>
> **`/api/data/*` 也不在 8081**（2026-11 第二轮实测）。反编译只记了路径没记端口，
> 8081/8085 上全是 `404 page not found`。把 80/443/8080–8091/9000 扫了一遍，
> 按端口拆开是这样（记下来省得下次再扫）：
>
> | 端口 | 是什么 | 验证方式 |
> |---|---|---|
> | 80 | nginx，`/api/*` 一律 404 | `404 Not Found / nginx/1.24.0` |
> | 443 | TLS 未配置，握手失败 | `fetch failed` |
> | **8080** | 大屏 SPA，任意路径回 `index.html`，POST 回 405 | `<title>工地数…` |
> | **8081** | 用户体系（登录/me/权限） | `/api/user/auth/*` 200 |
> | **8084** | **数据服务**：设备台账 / 楼栋 / 区域 | `/api/data/deviceinfos` 200 |
> | **8085** | 工作流：视频报警 + 抓拍图 | `/api/video/alarms` 401→200 |
> | **8088** | 高德天气代理（免登录） | `/api/map/amap/weather/live` 200 |
> | 8090 / 9000 | 各有一个前端站点 | `<!doctype html>` |
> | 8082/8083/8086/8087/8089/8091 | 无匹配路由 | 404 |
>
> **tsdb 与塔机工作循环确实调不到**：`/api/data/v1/tsdb/queryRealTimeDataV2`、
> `/queryEvent`、`/api/towercranedataservice/getWorkCycleInfoHis` 在以上**所有端口**
> 都是 404（也试过 `/api/v1/tsdb/*`、`/api/data/tsdb/*` 等变体）。这几条要么在
> 未开放的网关后面，要么当前部署没装。结论：设备的**作业指标**（吊次/吊重/
> 利用率/历史曲线）暂时无源，页面给空态；**静态台账**（型号属性/在线态）有源。

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

> **CloudWAF 拦截（2026-11-11 下午新增）**：`https://dw.yzw.cn/open/*` 目前被
> CloudWAF 整体拦成 **HTTP 418 HTML 拦截页**，连此前已接通、实测有数据的
> `personOverall` / `todayTeamsAtteStat` 也一样返回 418（不是签名错、不是 57007）。
> 这是外部网关策略，代码侧无法绕过；页面按「接口失败 → 明确空态」处理，
> 不要因此把演示数据加回来。恢复后签名客户端无需改动即可继续用。
>
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
| 4 | 首页·报警预警 + 轮播 | 8085 真数据；未登录 → 登录引导（不再用常量） | 8085 `/api/video/alarms` | ✅ 阶段 3 + 数据收口 |
| 5 | 报警历史（按日） | 全部真实，翻到更早日期按需回补 | 8085 `/api/video/alarms`（分页累积） | ✅ 阶段 3 + 数据收口 |
| 6 | 首页·人员分布 | **真实区域台账**（`:8084` `areas`，本项目 9 条）；人数位「—」 | B `location/*`（**57007 无权限 + CloudWAF 418**）+ `organ/list` | ✅ 阶段 5（区域已接；人数仍无源） |
| 7 | 智控·设备列表/四卡 | **真实台账**（`:8084` `deviceinfos`，8 台） | A `deviceinfos` + C `queryRealTimeData` | ✅ 阶段 4（实时数据无源） |
| 8 | 设备详情·实时状态 | 台账字段（高度/司机/安检/质检报告） | C `queryRealTimeDataV2` + `queryEvent`（**全端口 404**） | ✅ 阶段 4（作业指标空态） |
| 9 | 塔机·吊次/工作循环 | 空态 | A/C `getWorkCycleInfoHis`（**全端口 404**） | ⚠️ 无源，等网关开放 |
| 10 | 智眸·现场快照（监控点位/抓拍） | **真实报警派生**（通道 + 日期 + `picture` base64） | 8085 `/api/video/alarms` + D 萤石云直播 | ✅ 阶段 5（抓拍已接；实时流仍无源） |
| 11 | 智眸·实景核验（隐患） | `stores/airHazard.ts` 常量 | B `device/danger/page`（实测 0 条） | 5（无数据） |
| 12 | 巡检任务清单 | `views/sub/InspectList.vue` 常量 | D `/task/list`、`/task/exec/list/record` | 6 |
| 13 | 首页天气 | 无（设计稿无天气位） | E `:8088` amap/weather（**可用**） | ✅ 客户端待接，无消费点 |
| 14 | 无人机·航线与任务 | `stores` 常量 + 静态图 | D `/dashboard/*`、`/live/stream/list` | 6 |
| 15 | 智能爬架·机位读数 | **空态**（原 36 条手写读数已删） | 无任何后端接口 | ⚠️ 无源 |
| 16 | 消息中心 + tabbar 角标 | **真实报警派生**（一条报警一条消息、按 id 记已读） | 无独立消息接口，源为 8085 `/api/video/alarms` | ✅ 阶段 5 |

---

## 四、分阶段计划

每一阶段都以「可独立上线、可回到演示数据」为界；接口失败一律回落演示数据，
不让页面出现空数字或一直转圈。

| 阶段 | 内容 | 产出 | 状态 |
|---|---|---|---|
| **1** | 接口全量清单 + 大屏 open 签名客户端 + 首页人员总览四指标 | `src/api/open.ts`、`src/api/overview.ts`、`stores/overview.ts` | ✅ 已完成 |
| **2** | 首页班组出勤 + 分时人数（报警顺延） | `src/api/home.ts`、`stores/overview.ts`、`utils/chart.ts`、`SafetyPanel.vue` | ✅ 已完成 |
| **3** | 报警（8085 视频报警）+ 智控设备台账与实时数据（IOT token 待补） | `api/video.ts`、`api/data.ts`、`stores/deviceLedger.ts` | ✅ 报警 + 台账已完成；实时数据无源 |
| **4** | 天气、权限菜单（`unity-permission`） | `api/weather.ts` 待接手 | ✅ 两个接口已验证可用，客户端未接（无消费点） |
| **5** | 人员分布 / 定位 / 隐患 / 网关标签 | `api/people.ts`、`api/iotDevice.ts` | ⏸ 授权未开通，仅 `organ/list` 可用 |
| **6** | 无人机与塔机专用服务（CAS 登录、任务、工作循环） | `api/drone.ts`、`api/crane.ts` | ⬜ |
| **7** | 写接口接入（报警状态变更、删除、登出） | 统一走「显式确认 + 默认关闭」的写入通道 | ⬜ 需服务端代理与审计 |

### 阶段 2 的验收口径（已达成）

- 「今日班组出勤」来自 `GET /open/bigScreen/BigsHome/todayTeamsAtteStat`，实测 3 个
  班组（管理人员 12/19 63.16%、劳务班组 31/103 30.10%、产业工人班组 6/38 15.79%）；
- 「今日分时人数」来自 `GET /open/bigScreen/BigsHome/todayPersonHourStat`，实测
  0..17 整点两条曲线（工人峰值 18、管理峰值 13）；
- 两个接口各自独立成败（`Promise.allSettled`）：任一失败只影响它那块，该块显示空态；
- 曲线会掐掉「当前整点」那个还没结算的 0，避免右端垂直跳水成「人都走光了」；
- 单测覆盖字段收敛（`hours` 是小时数不是人数）、脏行丢弃、并集对齐补 0、空数组回落、
  单接口失败不影响其他块。

### 阶段 3 落地记录（报警 + 登出）· 2026-11-11 已用现场账号联调

服务器恢复后（上午 09:00 左右起 8081/8085/80 均可访问）用 `xiangyangcun` 完整跑通，
**反编译里的若干推断被现场推翻**，以下以实测为准：

| 项 | 反编译推断 | 现场实测 |
|---|---|---|
| 登出 | `POST {ServerUrl}/v1/auth/logout`（裸源站、无端口） | ❌ 全 404；正确是 **`POST :8081/api/user/auth/logout`** → `{"code":200,"message":"登出成功"}` |
| 列表行字段 | Pascal（`Id` / `AlertName` …） | 实际是 **camelCase**（`id` / `alertName` / `alertType` …），数字有的还是字符串 |
| `alertName` | 视为必有 | **全部为空串**（200 条里 200 条空），唯一可靠的是 `alertType` |
| 截图 | 返回 base64 纯文本 | 返回 **JSON**：`{code,message,data:{id,pictureData}}`，base64 在 **`data.pictureData`** |

- **名称必须靠类型码还原**：`ALERT_TYPE_NAME` 表来自 `AlarmCatalog` 的静态构造
  （11 安全帽 / 12 反光衣 / 18 车辆拥堵 / 20 打电话 / 22 玩手机 / 25 吸烟 / 30 摔倒 /
  32 越界 / 56 区域入侵 / 75 工服 / 382 手套 …）。「没有名字就丢行」的写法会把
  整页报警丢干净 —— 实测就是如此。
- **报警量级**：`total = 1807`，最新一条 08:37，本项目只有 11（安全帽）与 12（反光衣）
  两类在跑。首页「今日预警数」= 拉到的 50 条里当天的那部分（实测 8 条）。
- **抓拍图约 1MB/张**（1014720 字符 base64）。详情页按需拉 + 6 条 LRU 内存缓存，
  登出即清（`clearPictureCache()`），避免换人后看到上一个人的现场。
- 轮播卡的配图仍是四张分类示意图（`img/alarm-*.webp`）：50 条报警各拉 1MB 缩略图
  在手机流量下不可接受，而列表接口**没有**缩略图字段（`extInfo` 为空对象）。
- 2026-11-11 已解决：「近 7 日预警趋势」改用真实按日聚合（见下节数据收口）。

### 阶段 3 的接口契约（报警 · 实测）

`/bigScreen/bigAlarm/*` 在这个项目里恒为空，唯一的真实报警源是 **8085**
`/api/video/alarms`（要求 `Authorization: Bearer {token}`，与登录同一个 token）：

- 请求：`GET {WF_BASE}:8085/api/video/alarms?page=1&page_size=50&sceneCode=P000000076`
  （`sceneCode` 就是 Unity 端 `StaticParameter.ProjectId`，值 `P000000076`；
  `page_size` 实测上限 200）；
- 响应：`{ code:200, message:"success", data:{ list:[...], total:1807 } }`
  （是 `data.list`，不是 `data.rows`）；
- 行字段（camelCase）：`id`(int) / `captureTime` / `alertName`(常空) / `alertType`(int，
  可能是字符串) / `handleStatus` / `channelNo` / `deviceNo` / `extInfo`；
- 截图：`GET /api/video/alarms/{id}/picture` →
  `{code:200,message:"success",data:{id, pictureData:"/9j/..."}}`，
  `data.pictureData` 去掉前缀后拼 `data:image/jpeg;base64,`。
- 写接口（**一律接但不调用**）：`DELETE /api/video/alarms/{id}`、
  `PATCH /api/video/alarms/{id}/status`。

---

## 四点五、数据口径收口 + 登录守卫（2026-11-11 第二轮）

### 1. 一律真数据，不再「回落演示值」

上一轮的口径是「接口失败就退回 `data/config.ts` 的演示数字，页面不空不转圈」。
现场用下来这个兜底反而危险：**界面上分不清哪个数是接口来的**，拿着「项目人数 160」
去对账、服务端其实是 352。本轮改成：

| 数据块 | 取不到时的表现 | 演示常量 |
|---|---|---|
| 人员总览四指标 | 显示「—」+「暂无人员数据 / 重试」 | `crewKpis` **已删除** |
| 今日班组出勤 | 「暂无班组出勤数据」 | `squadRows` **已删除** |
| 今日分时人数 | 「暂无分时人数数据」（不画演示曲线） | 演示曲线仅留在 `chart.spec` 基线 |
| 报警（轮播/计数/列表/历史/详情） | 「今日暂无报警 / 同步中 / 失败 + 重试」 | 8 条种子 → 搬到 `tests/fixtures/alarms.ts` |
| 近 7 日预警趋势 | 「近 7 日暂无报警」 | 真实按日聚合 |

- 报警数据：首屏并发拉 2 页（`page_size=200`，共 400 条 ≈ 一个月），按 id 去重排序；
  历史页翻到更早日期时 `ensureDate()` 逐页回补，最多 8 页。
- 日历按日条数、历史列表全部由已加载数据实时聚合，不再有「已知分布 + 模板池」编造。
- 详情页抓拍图取不到时明确显示「该报警暂无抓拍图」，**不再退到分类示意图** ——
  示意图长得像现场抓拍，会被当成证据看。
- `overview` store 增加 `overallState / teamsState / hoursState`，页面据此区分
  「加载中」与「暂无数据」。

> 仍未接真实数据的区块（无接口 / 无权限）：人员分布（`location/*` 57007）、
> 智巡照片墙、智控设备卡与设备页、无人机。它们仍是设计稿常量。

### 2. 登录守卫（支付宝式）

报警是唯一需要 Bearer 的数据源。未登录进去只会看到「暂无」，用户会以为现场真没数据。
所以把「需要登录」显式化：

| 时机 | 行为 |
|---|---|
| 打开应用且无有效会话 | 自动打开登录页，顶部提示「当前未登录，请先登录后查看现场数据」 |
| 会话仍在有效期 | **不跳登录页**，直接进首页（token 从 localStorage 恢复） |
| 未登录点「历史 / 去登录」 | 打开登录页，并记住目标页；登录成功**直接落到该页**，不用再点一遍 |
| 未登录直接进巡检列表 / 报警历史 | 页面内守卫把人带到登录页，`loginNext` 记下目标 |
| 会话中途失效（401 / 到期） | 清会话 + toast + 回登录页；原在详情页的恢复到巡检列表（数据已清，回详情是空白） |
| 用户主动取消登录 | 清掉记住的目标，下次登录不会莫名跳页 |

实现：`stores/subpage.ts` 的 `loginNotice / loginNext / openLogin(notice, next) /
resumeAfterLogin()`；`api/http.ts` 的 `notifyUnauthorized()` 让 8085 这类
不走 `request()` 的服务也能把 401 同步给会话层。

---

## 四点六、阶段 4：设备台账（数据服务 `:8084`）+ 设备侧演示数据清零

### 1. 新发现的第四个服务：`:8084`

`/api/data/*` 既不在 8081（用户体系）也不在 8085（工作流），而在 **8084**，
鉴权沿用同一个 Bearer token。端口拓扑与探测过程见第二节的表格。

### 2. 设备台账契约（实测）

- 请求：`GET :8084/api/data/deviceinfos?page=1&page_size=100&project_id=P000000076`
  - `project_id` 传空串会返回**全部项目**的设备（8 条 → 数十条），必须带本项目 sceneCode；
  - `page_size` 上限 200；本项目 `total = 8`，一页拉完。
- 响应：`{ code:200, message:"success", data:{ list, total, page, page_size } }`
- 行字段：`id`(int 主键) / `project_id` / `device_name` / `online_status`(1|0) /
  `device_info:{ extra_fields, responsible_person, status_text, update_time }`
- **`extra_fields` 是 JSON 字符串**（不是数组）：`[{"label":"高度","value":"64"},…]`，
  无人机那台是空串。直接当数组用会拿到 undefined，必须 `JSON.parse` + 容错。
- 无 token → `401 {"error":"Authorization header required"}`（**没有 `code` 字段**，
  与 Go 信封不同，`request()` 靠 HTTP 状态码兜住）。

本项目 8 台设备（真实）：

| 类别 | 设备 | 台账字段 |
|---|---|---|
| 塔机 ×4 | 智能塔机2/3/4、传统塔机5 | 高度、塔吊司机、安检有效期、质检报告状态 |
| 电梯 ×2 | 智能电梯1、智能电梯2 | 高度、安检有效期 |
| 爬架 ×1 | 2#智能爬架 | 爬升高度 |
| 无人机 ×1 | 无人机 | （空） |

### 3. 接口 → 页面

- `src/api/data.ts`：`fetchDeviceInfos / fetchBuildings / fetchAreas`（后者两个已备、暂无消费点）
- `src/utils/deviceLedger.ts`：**唯一的映射层**
  - `categoryOf(name)`：设备名关键词归类（服务端没有类型字段；「传统塔机5」也是塔机；
    爬架规则排在电梯之前，防止「XX电梯爬架」这类名字串类）
  - `parseExtraFields(raw)`：脏数据一律丢行不抛错
  - `toUnit(row)`：→ 设备卡（四格按偏好字段排序、高度补 `m`、info 含责任人/更新时间）
  - `toEquip(rows)`：→ 首页四卡（**卡片恒定 4 张**，某类 0 台显示 0/0；数值位只放高度）
- `src/stores/deviceLedger.ts`：`state: idle/loading/ok/error`，失败 60s 冷却，
  并发去重，`apply()` 供测试/离线注入，`reset()` 由 `auth.clear()` 调用。
- `src/data/device.ts`：删除 3 台塔机 + 4 台电梯的完整假数据（含 7 天曲线），
  只保留一个 `reactive` 的「当前真实机组」登记表 —— `deviceSet()` 被 5 个组件
  在 `computed` 里同步调用，非响应式的话台账后到也不会重算。

### 4. 设备侧演示数据清零清单

| 区块 | 原演示内容 | 现在 |
|---|---|---|
| 首页四卡台数/在线数 | 写死 塔机3 / 电梯4 / 无人机1 / 爬架1 | 台账真实台数（本项目 4/2/1/1），在线数按 `online_status` |
| 首页卡数值位 | 今日吊重 1.87t、累计运行时间 2min、作业任务 1/3 | 台账真有的字段（最大高度 / 爬升高度），无人机留空 |
| 爬架卡三格 + 异常行 | 36 条手写机位读数（30# 179.70mm） | 删除 `data/climb.ts`；卡片与其它三类同构 |
| 设备详情机组 | 3 台塔机 / 4 台电梯（备案号、型号、出厂时间） | 台账 4 台塔机 / 2 台电梯，字段即 `extra_fields` |
| 详情卡今日吊次/吊重 + 负荷条 | 10 次 / 10.00t / 32% | **删除**（tsdb 无源） |
| 作业报表（日/周/月） | 7 天历史 + 21 天派生序列 | **空态**「暂无作业报表数据」，说明缺的是实时数据接口 |
| 设备信息弹层 | 产权备案号等 5 行 | 台账全字段 + 责任人 + 更新时间 |
| 历史数据弹层 | 7 天读数 + 利用率仪表 | **空态** |
| 爬架详情 | 36 行机位 + 3 页签 | 台账属性（在线/爬升高度）+ 机位空态 |
| 首页楼栋进度 `siteBuildings` | 6 栋楼（已无任何消费点） | 删除；`fetchBuildings()` 客户端已备 |

### 5. 登录守卫（设备侧）

台账要 Bearer，所以智控面板 / 设备页 / 爬架页都接同一套守卫：

| 场景 | 表现 |
|---|---|
| 未登录打开智控 | 「登录后可查看设备台账与运行状态」+ 去登录 |
| 未登录深链进设备页 | 「登录后可查看智能塔机运行状态」+ 去登录，`loginNext` 记回该页 |
| 已登录但 401 | 走 `auth.expire()`：清会话（含 `deviceLedger.reset()`）+ toast + 回登录 |
| 加载中 / 失败 | 慢请求在卡片原位铺灰条（见「四点七」）；失败才给错误文案 + 重试 |

### 6. 验收（2026-11-11 现场账号，headless Chrome + 真实接口）

- 智控面板：`4 种 / 8 台`；塔机 `4/4 · 70m`、电梯 `2/2 · 60m`、无人机 `1/1`（无高度位）、
  爬架 `1/1 · 21m 爬升高度`；
- 塔机详情：4 台机组，四格为 `高度 10.3m/70m/32.5m/64m`、`塔吊司机 机师`、
  `安检有效期 2026-12-10`、`质检报告状态 正常`；
- 作业报表：空态文案正确，无任何合计数字；
- 单测 596 条全过（新增 `device-ledger.spec` 11 条 + 重写 `device-page.spec`），
  `vue-tsc --noEmit` 无错，`npm run build` 通过。

---

## 四点七、慢加载骨架：灰条占位 → 数据原位回填（2026-11-11 第三轮）

**问题**：接口慢时，各页面原来把整块内容换成一张居中的「正在加载…」空态卡。
它比真实内容矮一截，数据到了整页要重排；读起来还像个弹窗。

**改法**（对齐支付宝）：在数据将要出现的位置铺同构灰条，数据到达原位替换，
高度不变、不弹任何窗。

| 落点 | 骨架形态 | 触发条件 |
|---|---|---|
| 首页·智控 | 两块统计卡 + 4 张设备卡（图标 / 名称 / 两列数值 / 箭头） | `!ledger.hasData && ledger.state==='loading'` |
| 首页·报警 | 计数卡数字 + 近 7 日趋势块 + 轮播卡 | `!alarm.hasLive && alarm.liveState==='loading'` |
| 首页·人员 | 4 个 KPI 数字、分时曲线、班组出勤行 | `overview` 对应区块 `loading` 且无数据 |
| 设备详情·实时状态 | 机组卡卡头 + 台账四格 | `!set.units.length && ledger.state==='loading'` |
| 设备详情·作业报表 | 三格 KPI + 5 行机队表 | 同上（台账重载时） |
| 爬架页 | 汇总数字 + 信息行 | 同上 |
| 报警预警 / 巡检列表（今日 + 历史） | 计数数字、趋势块、列表项（48px 图 + 两行文字） | 首屏同步 or `ensureDate()` 按需回补 |
| 报警详情大图 | 整块等高灰底 | `shotLoading` |

**时序**（`utils/slowLoading.ts` + `components/ui/Skel.vue`）：

- 骨架元素**第一帧就占住位置**，但 `.skel-fade` 初始 `opacity: 0`；
- 只有请求越过 `SKEL_DELAY = 280ms` 才加 `.is-on` 淡入（200ms）。
  快请求全程看不到灰条，不会闪一下；
- 数据到达**立刻撤**，不等延迟 —— 延迟只加在「上屏」这一侧；
- 组件卸载清定时器；`prefers-reduced-motion: reduce` 时不做淡入；
- 灰条底色两套：浅底 `rgba(16,24,40,.07)`、深底 `rgba(255,255,255,.08)`，
  共用 `.simg` 的扫光 keyframes；读屏侧用 `.sr-only[role=status]` 保留「正在加载…」。

**「不提前下结论」**：加载中计数位不写 `0`（0 是个结论），换成灰条或「…」；
历史窗格在 `ensureDate()` 回补期间也不能先说「该日暂无预警记录」。
`tests/unit/skeleton.spec.ts` 9 条钉住这些行为。

**验收**（headless Chrome + CDP 拦 `deviceinfos` 拖慢 4s，真机 390×844）：

```
慢加载中: 灰条 36 条, 统计卡 82px, 卡片网格 418px
数据到达: 灰条 0,   统计卡 82px, 卡片网格 416px   → 高度差 0 / -2px
塔机详情 4 台机组；台账重载 → 设备页 24 条 / 报表页 31 条灰条
报警历史窗格：回补中 12 条灰条 + 计数「…」→ 回包后 0 条 + 空态
```

> 两个「看不到骨架」的假象，排查时别误判成 bug：
> ① 截图截在 280ms 阈值之前，`.skel-fade` 还是 `opacity: 0`（等 `.is-on` 再截）；
> ② 首页设备卡要台账到手才可点，所以「台账没回来就钻进设备页」这条路径不存在 ——
>    设备页 / 报表页骨架只在**子页已打开时台账重新拉取**（换账号、重试）才可见。

---

## 四点八、阶段 5：现场影像 / 消息中心 / 人员区域台账（2026-11-11 第五轮）

> 这里说的「阶段 5」是**第五轮实现**，不是第四节计划表里编号 5 的「人员定位」
> （那一组仍卡在 `57007` / CloudWAF）。本轮的取舍是：不做没有数据源的模块，
> 把「假得最明显、且已有真实数据源」的三块全部换成真数据。

### 1. 先把边界探清楚（避免再对着空气写适配）

| 探测 | 结论 |
|---|---|
| `:8084 /swagger/doc.json` | 服务名「万方项目服务API」，**20 个路由全是 CRUD**（areas / buildings / deviceinfos / floors / rooms / decoratematerials / floorqualities / materialpoints / presets），**没有任何人员定位、人数、报警、实时量测接口** |
| `:8084 /api/data/areas/person` 等 | 一律 `400 ID无效` 或 404；试过 `id / area_id / areaId / area` 四种传参都不通，是 `/areas/{id}` 路由在兜底，不是人数接口 |
| B 组 `dw.yzw.cn/open` | `personOverall` / `organ/list` / `location/person` / `todayTeamsAtteStat` **全部 HTTP 418 CloudWAF 拦截页**，连已接通的接口也一样 |
| C / D 组 | 萤石云实时流未接；因此监控画面只能是「最近一次真实报警抓拍」，不能演直播 |

**一个容易误判的参数**：报警列表的项目过滤参数必须叫 **`sceneCode`**。
早期探测脚本写成 `scene_code`，服务端忽略过滤，返回的是**全部项目** 9672 条 /
5 个通道（2/3/4/5/6，含 `P000000096`、`P000000073`）；改成 `sceneCode=P000000076`
后是本项目 1825 条 / **2 个通道**（2、3）。所以监控页只有「2号通道 / 3号通道」
是对的，不是漏了点位。

### 2. 演示数据清零清单（本轮）

| 区块 | 原演示内容 | 现在 |
|---|---|---|
| 监控点位 | 18 个写死点位名，`.map()` 把 img 全刷成同一张 `cam-crane2.webp` | `:8085` 报警 `channelNo` 去重 → `N号通道`，服务端不给名称就不编 |
| 直播位 | 上面那张静态图（切点位画面不变） | 该通道最近一条报警的真实抓拍 base64；点播放明确 toast「实时视频流未开放」 |
| 抓拍视图 | `camShotPool` / `camShotTimes` 按「点位序号 + 日期」轮转，恒定 3 张 08:12/12:36/16:50 | 按「通道 + 真实日期」过滤报警，有几条显示几条；无记录的日期给明确空态 |
| 抓拍图 | 同一张 webp | `/api/video/alarms/{id}/picture` 的 `data.pictureData`，按需加载 + 缓存（首屏最多 6 张，单张约 1MB），登出清缓存 |
| 消息中心 | 2 条写死消息 + tabbar 硬编码角标 2 | 一条真实报警一条消息（最多列 20 条，角标按全部未读算），点开跳对应报警详情、按 `id` 记已读 |
| 人员分布 | 5 个手写区域 + 三栋楼各 5 层人数（`b*Occupied` 稀疏表） | `:8084 areas` 本项目 **9 条**真实区域；**人数没有任何数据源**，数字位一律「—」并注明原因 |
| `data/config.ts` | `camShotPool` / `camShotTimes` / `b1~b3Occupied` / `b2FloorCount` / `tradeRows` | 全部删除（后两者零消费点，留着只会被当成兜底） |

### 3. 接口 → 页面

- `src/api/data.ts` 的 `fetchAreas(projectId)` 从「客户端已备」变成真消费点，
  `stores/deviceLedger.ts` 里 `areas / areasState / areasError / loadAreas()` **独立成一块状态**：
  区域接口挂了不把设备台账一起判失败，也不参与台账的 60s 失败冷却。
- **`views/home/parts/PeopleDist.vue` 自己触发 `loadAreas()`**（挂载 + `auth.token` 变化）。
  首版漏了这一步，区域只在打开智控/设备页时才顺带拉，导致首页人员分布永远显示
  「暂无项目区域数据」—— 真机验收抓到后补上。
- `stores/cam.ts`：`channelCounts` / `latestByChannel` / `shotsFor()` 全部从
  `alarm.liveAlarms` 派生；`cameras` 由 ref 改 computed；新增 `watch(cameras)` 在报警
  晚到时自动选中首个通道（否则 `openCam('')` 之后 `camId` 一直是空串，抓拍视图永远空）。
- `stores/msg.ts`：`messages` / `unreadTotal` 改 computed，`readIds` 只存本次会话已读，
  换账号由 `auth.token` 的 watch 清掉。
- **登录守卫**：`openCam()` 未登录直接 `openLogin('登录后可查看现场监控抓拍')`，
  不先摆一个空播放器；直播位给「登录后可查看现场监控 / 暂无监控点位 /
  该通道暂无可用抓拍图」三种明确空态。全轮**未调用任何写接口**。

### 4. 加载态沿用「四点七」的支付宝式骨架

- `PeopleDist` 与 `MsgPage` 新增同构灰条层（`.skel-fade` + `280ms` 阈值），
  数据到达原位替换；**同步中不先说「暂无项目区域数据 / 暂无消息」**。
- `CamPlayer` 在 `alarm.liveState === 'loading'` 时写「正在同步现场点位… /
  正在同步报警抓拍…」，不把加载中误报成「暂无」。
- 区域失败给错误原因 + 重试按钮；人数位永远不写 0（0 是结论，不是空值）。

### 5. 验收（现场账号 · headless Chrome 390×844 · 真实接口）

```
登录成功（有效期内不跳登录页）          今日预警 26
监控点位 ["2号通道","3号通道"]           直播位真实抓拍 base64 长度 1,170,083
报警抓拍 11 条（今天 14:45:59 起）       图片首张 1,170,083 字符
消息 20 条，首条「防护报警反光衣检测 · 2号通道抓拍」，角标 99+
人员分布 9 条：智能电梯2 / 机器人展示区 / 5G塔机控制室 / 智能电梯1 /
             智能塔机4 / 酒店 / 智能塔机2 / 传统塔机5 / 智能塔机3
诊断 areas=9 areasState=ok ledgerState=idle alarmCount=400 liveState=ok
```

- 单测 **617 条全过**（25 文件；新增 `stage5.spec.ts` 13 条 + 夹具 `camAlarms.ts`），
  `vue-tsc --noEmit` 无错，`npm run build` 通过。
- 三处回归护栏：点位只能来自 `channelNo`、抓拍按通道+日期过滤且不留假图、
  人数位不许出现 `0人`、加载中不提前下结论。

---

## 四点九、阶段 6：消息页 20 条/页分页查询（2026-11-11 第六轮）

### 1. 问题与口径

阶段 5 把消息改真实报警派生后，列表被 `slice(0, 20)` 硬截断，而 tabbar 角标
按全部已同步报警（首屏 400 条）计算 —— 现场出现「角标 99+、列表只有 20 条，
剩下的永远看不到」。本轮调整为：

- **下滑一次 = 一次 `page_size=20` 的分页请求 = 列表 +20 条**（用户明确的口径）。
- 首屏**不**重复请求 page 1：登录后报警首屏同步（200 条/页 × 2 页）已拿到
  最近数据，`msg.seed()` 直接复用其中 20 条；`pageNo` 按「已展示条数 / 20」
  取整，只有首屏不足 20 条时才从第 1 页开始查。
- 分页拉回的报警经 `alarm.appendLive()` 并进全局报警源 —— 详情页 `byId()`、
  抓拍图按 id 拉取都依赖它；`total` 取较大值，避免小页查询把总数改小。
- `unreadTotal = max(total, 已同步条数) - 已读`：翻页过程中角标不「越翻越多」，
  真正翻到底（某页无新数据，`exhausted`）回落为实际条数。
- `syncFromVideo` 增加「已成功同步过就复用」守卫：首页安全面板（onMounted +
  watch token）与消息页（刷新后直接落在消息 tab）都会触发它，不拦的话首屏
  400 条会被来回打好几遍。

### 2. 失败与到底

- 拉页失败：`loadError` 只记在 msg store（不污染全局 `liveError`，首页不闪
  错误态），已有消息一条不少，底部给「重试」，`pageNo` 不推进、重试仍查同一页。
- 某页没带回新数据（total 虚高或服务端偏移）：`exhausted = true`，`hasMore`
  变 false，显示「已显示全部 N 条消息」，不再空打接口。
- 未登录：`loadMore` 直接 return，不发带空 Bearer 的请求。

### 3. 交互

- `#page-msg` 绑 `@scroll.passive`，距底 160px 内触发；列表变高后一次触底
  只追加一屏，不连锁拉完全量。
- 底部四态就地占位：加载中（慢请求铺同构灰条）/ 失败重试 / 「还有 N 条，
  点击或下滑加载」（按钮兜底 + 键盘可达）/ 已到底。
- `MsgPage` 挂载时若报警还没同步过（刷新直接落在消息 tab）补一次
  `syncFromVideo`，避免停在「暂无消息」。

### 4. 验收（现场账号 · headless Chrome 390×844 · 真实接口）

```
首屏真实请求数 = 2（performance resource timing；预检不计入）
初始 items=20 pageNo=1 hidden=1805 unread=1825 badge=99+
下滑 5 轮：items 40→60→80→100→120，pageNo 2→6，每轮一次 page_size=20 请求
分页请求序列 page=2..10（CDP Network 抓包），角标全程恒定 99+
底部状态区与 tabbar 不重叠（overlap=false）
```

- 单测 **630 条全过**（26 文件；`msg-paging.spec.ts` 13 条）、`vue-tsc --noEmit`
  无错、`npm run build` 通过。

---

## 五、两个必须知道的隐患

1. **私钥在客户端**。大屏 open 用项目级私钥签名，原厂把私钥内嵌在桌面端；本项目
   照搬以拿到数据。它能防公开抓取，但防不住逆向（拿到包就能签）。彻底解决要服务端
   代理签名：前端调 `/proxy/yzw/*`，私钥只留在服务器（`server/serve.mjs` 加路由即可）。
2. **站点协议**。A/C/D 组接口多为 HTTP 或自签证书；站点若走 HTTPS 会被混合内容拦掉。
   当前用自托管 HTTP 部署规避，长期正解仍是「站点 HTTPS + 同域反代」。
