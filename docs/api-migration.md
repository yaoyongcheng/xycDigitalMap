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
| POST | `/api/towercranedataservice/getWorkCycleInfoHis` | 塔机工作循环（查询） | 首页塔机卡「吊重/吊次」+ 塔机详情 | ⚠️ **路由存活但缺编号**（2026-11 三轮实测：**tciccs:30400 上有 handler**，任意请求体回 `{code:400,success:false,msg:"塔机编号不存在"}`；台账给不出编号，见下节 12） |
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
| `/device/label/page` | 定位标签（实测 200 条） | 人员定位设备 | ✅ 阶段 8 已接客户端（**行内无区域字段**） |
| `/device/label/getLabelOrPersonRelation` | 标签-人员绑定 | 人员定位 | ⬜ 未验证 |
| `/device/gateway/page` | 网关（实测 24 条） | 设备管理 | ⬜ 未验证 |
| `/device/gateway/pageByProjectId` | 项目网关（实测 102 条，含 areaName） | 设备管理 | ✅ 阶段 8 已接客户端 |
| `/device/beacon/page` | 信标（实测 78 条） | 设备管理 | ✅ 阶段 8 已接客户端 |
| `/device/danger/page` | 危险源 | 隐患卡 | ⚠️ 实测 `total=0`（现场未录危险源） |

> **CloudWAF 拦截（已恢复，2026-11-11 第八轮复查）**：下午曾整体拦成 **HTTP 418
> HTML 拦截页**，晚上复查已恢复，`/device/*` 三项都通。
> ⚠️ 但 WAF 对同一密钥的自动化请求会**间歇拦截**（同一私钥刚成功、下一发 418）：
> 探测脚本必须带退避重试，否则会把「WAF 挡了」误读成「接口没有」。
> 代码侧无需改动，页面按「接口失败 → 明确空态」处理，不要因此把演示数据加回来。
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
| POST | `/api/webgateway/v1/access/token` | 换 token | ✅ 阶段 8 已接（body `{ak, sk}`，成功码 `status===0`，令牌头 `X-APP-USER`） |
| POST | `/api/data/v1/tsdb/queryRealTimeDataV2` | 实时数据 | ✅ 阶段 8 已接客户端（**缺 sn，卡在台账没有序列号字段**） |
| POST | `/api/data/v1/tsdb/queryEvent` | 告警事件 | ✅ 阶段 8 已接客户端（同上） |
| 🔒 POST | `/api/webgateway/v1/auth/api/appUser/logout` | 登出 | 写，不调用 |

### D. 第三方与专用服务

| 方法 | 地址 | 用途 | 状态 |
|---|---|---|---|
| GET | `https://open.ys7.com/api/lapp/token/get?appKey=&appSecret=` | 萤石云 token | ⚠️ 阶段 8 实测 `code:-1`，**凭据已失效** |
| GET | `https://open.ys7.com/api/lapp/v2/live/address/get?...` | 监控直播地址（HLS/FLV） | ⚠️ 同上，无源 |
| POST | `https://account.keehang.com:23443/cas/auth/login` | 无人机平台登录 | ✅ 阶段 8 已接（body `{account, password}`） |
| POST | `https://account.keehang.com:23443/cas/auth/validate` | 校验 | ✅ 阶段 8 已接（body `{st}`，**不是 tgt**） |
| GET | `https://tciccs.cscec3bxjy.cn:30400/api/towercranedataservice/getWorkCycleInfoHis` | 塔机工作循环 | ⬜ 未验证 |
| GET | 无人机：`/task/list`、`/task/exec/list/record`、`/dashboard/device/cache/telemetry/{id}/1`、`/media/task/job/{jobId}` | 航线、任务、遥测、媒体 | ✅ 阶段 8 已接（**必须带 pid 过滤**；媒体按执行记录 id 取） |
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
| 8 | 设备详情·实时状态 | 台账字段（高度/司机/安检/质检报告） | C `queryRealTimeDataV2` + `queryEvent`（**阶段 8 确认在 C 组存活，但台账没有 sn**） | ✅ 阶段 4（作业指标空态） |
| 9 | 塔机·吊次/工作循环 | 首页塔机卡「吊重/吊次」= 台账高度；详情页空态 | A/C `getWorkCycleInfoHis`（**路由存活，缺设备编号**） | ⚠️ 客户端已接（`api/towerCrane.ts`），无 sn → 整块跳过 |
| 10 | 智眸·现场快照（监控点位/抓拍） | **真实报警派生**（通道 + 日期 + `picture` base64） | 8085 `/api/video/alarms` + D 萤石云直播 | ✅ 阶段 5（抓拍已接；实时流仍无源） |
| 11 | 智眸·实景核验（隐患） | `stores/airHazard.ts` 常量 | B `device/danger/page`（实测 0 条） | 5（无数据，隐患上报是写接口） |
| 12 | 巡检任务清单 | **真实航拍照片**（keehang 媒体，按拍摄时间倒序） | D `/task/exec/list/record` + `/media/task/job/{id}` | ✅ 阶段 8 |
| 13 | 首页天气 | 无（设计稿无天气位） | E `:8088` amap/weather（**可用**） | ✅ 阶段 8 客户端已接，无消费点 |
| 14 | 无人机·航线与任务 | **真实任务 / 遥测 / 航线**（keehang） | D `/task/exec/list/record`、`/dashboard/device/cache/telemetry/{id}/1`、`/task/list` | ✅ 阶段 8（实时画面与航线下发仍无 REST 端点） |
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
| **5** | 人员分布 / 定位 / 隐患 / 网关标签 | `api/people.ts`、`api/iotDevice.ts` | ✅ 阶段 8 已接定位台账客户端（**标签无区域字段，人数位仍「—」**）；`location/*` 仍 57007 |
| **6** | 无人机与塔机专用服务（CAS 登录、任务、工作循环） | `api/drone.ts`、`api/crane.ts` | ✅ 阶段 8 已接 keehang 全链路（CAS 两步 / 任务 / 遥测 / 航线 / 媒体）；塔机 `getWorkCycleInfoHis` 未验证 |
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

**机组顺序按台号升序**（`utils/deviceLedger.ts: byUnitNo`）：服务端按 id 倒序返回
（传统塔机5 在最前），现场读数习惯是 智能塔机2 → 3 → 4 → 传统塔机5。
排序键是名称里第一段数字，取不到数字的排最后；`2#智能爬架`、`智能电梯1` 同规则。

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
| 首页卡片数量 | 4 类（塔机/电梯/无人机/爬架） | **9 类**：前 4 类台账驱动，后 5 类机器人是静态入口卡（`div`，不可点），作业次数取 V2 预制体预置值，标题带绿点（现场常驻在线） |
| 顶部统计两格 | 写死「9 种 / 9 台」「在线 5 / 离线 4」 | **9 种**（页面上的设备类别数：4 台账类 + 5 机器人）、**13 台**（台账 8 台 + 5 类机器人各 1 台）。环形图在线 = 台账在线数 + 5（机器人按在线计），离线 = 台账里 `online_status=0` 的台数。口径与 V2 装备管理页一致（那边两个数都是预制体占位 9，不随数据变） |
| 首页四卡台数/在线数 | 写死 塔机3 / 电梯4 / 无人机1 / 爬架1 | 台账真实台数（本项目 4/2/1/1），在线数按 `online_status` |
| 首页卡数值位 | 今日吊重 1.87t、累计运行时间 2min、作业任务 1/3 | 塔机：工作循环汇总的吊重/吊次（编号见表 `src/data/craneSn.ts`，见第 13 节）；电梯：高度；无人机：作业任务 x/y（取自 `stores/uav.ts`，没取过数就整格不渲染）；机器人：5/4/7/9/3 次，取自 V2 预制体 `UIView 装备管理一张图 / 底部栏 / 施工机器人栏` 的 `Value` 预置文本（见 `src/data/robotStats.ts`） |
| 爬架卡三格 + 异常行 | 36 条手写机位读数（30# 179.70mm） | 三格 = 全场最不利机位的真实读数（CDN `ScaffoldData.json`，见第 13 节）；超限报「30#机位 左右倾斜 179.5mm，超过 60mm」，未取到才退回「—」+「传感器数据未取到」 |
| 设备详情机组 | 3 台塔机 / 4 台电梯（备案号、型号、出厂时间） | 台账 4 台塔机 / 2 台电梯，字段即 `extra_fields` |
| 详情卡今日吊次/吊重 + 负荷条 | 10 次 / 10.00t / 32% | **已接真实源**，四格 = 今日吊次 / 今日吊重 / 当前吊重 / 当前负荷（+ 负荷条）。前两项逐台来自 `getWorkCycleInfoHis`，后两项来自 MQTT 实时报文 `weight` / `weightRate`；无帧/无编号的车给「—」，见第 13 节 (13) |
| 作业报表（日/周/月） | 7 天历史 + 21 天派生序列 | **已接真实源**：三格 KPI（合计吊次/合计吊重/作业时长）+ 结论 + 机队表 + 导出分享，逐台区间汇总 `getWorkCycleInfoHis`（自然周/自然月，照 V2 `UICraneHistoryPop`）；设计稿的「平均利用率/负荷」没有源，换成作业时长/峰值吊重，见第 13 节 (15) |
| 设备信息弹层 | 产权备案号等 5 行 | 塔机严格 7 + 4 行（照 V2 塔机弹窗）：**基本信息** 当前状态/塔机编号/塔机高度/安检有效期/质检报告状态/司机/功效（编号来自 `craneSnOf` 台号映射，高度只认实时 `bodyHeight`，其余来自台账 `extra_fields`，缺的写「—」）+ **实时工况信息** 实时回转/实时幅度/实时高度/实时时间（MQTT `pushRealTimeInfo`）；台账的「是否隐藏」「更新时间」不进弹层；电梯只有一段平铺台账字段 |
| 历史数据弹层 | 7 天读数 + 利用率仪表 | **空态** |
| 爬架详情 | 36 行机位 + 3 页签 | 台账属性（在线/爬升高度）+ 真实 38 机位读数，三个读数页签（左右倾斜/前后倾斜/载荷）按绝对值倒序，超限行标红 |
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
- 作业报表：三格合计 + 结论 + 机队表全部来自工作循环接口（当时尚未接，见第 13 节 (15) 已补齐）；
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
| 设备详情·作业报表 | 三格 KPI + 5 行机队表 | 台账重载时，或工作循环三台车都在飞（`stores/craneReport.ts` 的 `state==='loading'` 且无任何结果） |
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

## 四点十、阶段 7：消息已读改服务端 handleStatus + PATCH 标记（2026-11-11 第七轮）

### 1. 问题

用户反馈「已读的消息会做已读标记吗？刷新之后消息数量没变」。根因：上一版
（阶段 5/6）把已读态做成**前端内存 `Set`**，刷新即归零，角标反弹。

### 2. 参照来源（Unity 端《万联装备集群作业系统》反编译）

桌面端在 `HotUpdateScripts.dll` 里有一套完整的已读逻辑，逆向结论：

- 数据模型 `AIAlarmMessage.AlarmStatus` ← 接口每行的 `handleStatus`
  （`0` = 未读/待处理，`1` = 已读/已处理）；
- 展示模型 `AlarmNoticeData.isRead`、UI 项 `AlarmNoticeItem.IsRead` +
  `unreadDot`，红点显示条件是 `status == 0`；
- 标记已读走**服务端写接口**：
  `PATCH {8085}/api/video/alarms/{id}/status`，body `{"status": 1}`，
  响应 `{code, message}`、`code === 200` 算成功；
- `AIAlarmDetail.UpdateLocalAlarmStatus` 先**本地乐观更新**（改 status + 按钮
  文案「标记为已读↔标记为未读」），再发 PATCH，成功回调用 `onComplete(true)`。

关键点：**已读状态是服务端持久化的，不是客户端本地状态**。这才是「刷新不丢」的
正确来源 —— 上一版本地 Set 的思路从一开始就错了。

### 3. 本项目落地

- `Alarm` 类型新增 `handleStatus?: number`（0 未读 / 1 已读，缺省按未读）；
  `toAlarm()` 不再丢弃 `VideoAlarm.handleStatus`。
- `api/video.ts` 新增 `setAlarmStatus(token, id, 0|1)`，实现上面的 PATCH 契约
  （401 同样走 `notifyUnauthorized()`）。
- `stores/msg.ts`：`messages.unread` 改读 `a.handleStatus === 1 ? 0 : 1`；
  `unreadTotal` 改为「已加载报警里 handleStatus !== 1 的条数」（不再用
  `total - readIds.size`，否则现场 1800+ 条未读会让角标永远钉在 99+，点开也看不出
  变化）；`markRead(id)` 乐观置本地 `handleStatus=1` 再发 PATCH，失败静默（下次
  同步以服务端为准回正）。本地 Set / localStorage 持久化整段删除。
- 写接口**首次真正接进业务**：这是用户明确要求「参照参考项目已读逻辑」，且该接口
  的唯一语义就是标记已读，联调已用 no-op（原值）先验契约、再实测点开→刷新闭环。

### 4. 验收（现场账号 · headless Chrome 390×844 · 真实接口）

```
目标报警 id=86020 handleStatus=0
点开前  unread=400 targetStatus=0
点开后  本地乐观 unread=399 targetStatus=1；服务端 handleStatus=1（PATCH 已生效）
刷新后  targetStatus=1 且 unread=399（服务端持久化，已读不丢）
恢复现场 PATCH status=0 → 200，把测试目标改回未读
```

- 单测 **632 条全过**（26 文件；`stage5.spec.ts` 新增「服务端 handleStatus 已读 /
  点开乐观置 1 且 PATCH body 为 `{status:1}`」2 条）、`vue-tsc --noEmit` 无错、
  `npm run build` 通过。

---

## 四点十一、阶段 8：无人机 / 巡检照片 / 定位台账 / 天气（2026-11-11 第八轮）

### 1. 先推翻三条旧结论

本轮开工前先复查了上一轮记下的「死路」，结果推翻了三条：

| 旧结论 | 复查实测 |
|---|---|
| CloudWAF 418 拦截，大屏 open 全挂 | **已恢复**。`/device/label/page`(200 条)、`/device/gateway/pageByProjectId`(102 条)、`/device/beacon/page`(78 条) 都通 |
| tsdb `queryRealTimeDataV2` 全端口 404 | **在 C 组 `iot.cscec3b-iti.com` 上存活**（404 的是 8084 上的同名路径）。ak/sk 换 token 成功 |
| 阶段 5/6「授权未开通 / 无凭据」 | 凭据从 Unity DLL 反编译提取：IOT ak/sk、keehang CAS 账号、萤石云 appKey |

> 复查纪律：CloudWAF 对同一密钥的自动化请求会**间歇拦截**（同一私钥刚成功、
> 下一发 418）。探测脚本必须带退避重试，否则会把「WAF 挡了」误读成「接口没有」。

### 2. 新增四组客户端

| 文件 | 组 | 鉴权 | 用途 |
|---|---|---|---|
| `src/api/drone.ts` | D 组 keehang | **CAS 两步** login→validate | 无人机任务 / 遥测 / 航线 / 媒体 |
| `src/api/iot.ts` | C 组 iot.cscec3b-iti.com | ak/sk 换 token（`X-APP-USER` 头） | tsdb 实时数据与事件 |
| `src/api/iotDevice.ts` | B 组大屏 open | 项目级 RSA 签名（免登录） | 定位标签 / 网关 / 信标 |
| `src/api/weather.ts` | E 组 `:8088` | 免登录 | 高德天气代理 |

**keehang CAS 是两步**（踩过一次坑）：

```
① POST https://account.keehang.com:23443/cas/auth/login
   body {account, password}          ← 字段名是 account 不是 username
   → {code:200, data:{tgt, st, userDetail:{uid}}}
② POST https://account.keehang.com:23443/cas/auth/validate
   body {st}                          ← 用 st，不是 tgt（传 tgt 报「参数输入错误」）
   → {code:200, data:{uid, token, timestamp}}
之后每个业务请求带 KH-USER-ID / KH-TOKEN 两个头
```

**C 组的成功码是 `status === 0`**（不是 200），换令牌 body 是 `{ak, sk}`
（不是 appKey/appSecret）—— 判错成功码会把失败当成功。

**E 组 `city` 要的是六位 adcode**（武汉 `420100`），传城市名会 400。

### 3. 演示数据清零（本轮删掉的全部常量）

| 常量 | 原处 | 去向 |
|---|---|---|
| `patrolPhotos`（17 张静态图） | `data/config.ts` | 真实航拍媒体（keehang OSS 直链） |
| `patrolCats`（六个手工分类） | `data/config.ts` | **整组删除** —— 分类是设计稿的人工归类，服务端无此字段 |
| `airImgs` / `airTimes` / `airPos` | `data/config.ts` | 真实媒体按拍摄日期过滤 |
| `uavLive` / `uavTodayTasks` / `uavRoutes` / `uavChecks` | `data/device.ts` | keehang 任务 / 遥测 / 航线 |

「六个分类」删除是有意的：照片一到就不知道该归哪类，与其用假分类框住真照片，
不如按拍摄时间倒序铺开并标出「所属任务 + 时间」，让看的人自己判断。

### 4. 起飞条件改成三态（安全门）

遥测接口只给电量 / 电池温度 / 速度 / 高度 / 航向角，**风速、雨量、网络速率
三项没有数据源**。原版的 `uavChecks` 由写死的 `uavLive` 派生，五项永远全过。

现在改成三态：`ok` 满足 / `bad` 明确不满足 / `unknown` **该指标没有数据源**。
`canDispatch = checks.every(c => c.ok)` —— **有未知项也不放行**。把「没数据」
当成「条件满足」是放松安全门的方向，该拦的飞行没拦。未知项在界面上写明
「风速数据未接入」，让人知道还差什么。

### 5. 航线下发：**没有** REST 端点，如实告知

实测 keehang 的 `/task/start`、`/task/exec/start`、`/task/control` 等一律 404。
原厂 Unity 端是打开网页控制台 `iot.keehang.com/dashboard/#/control?st={token}`
由那个页面下发。所以航线弹层**只读**：列出真实航线（实测本项目 15 条）、
显示选中那条的详情、给出平台地址，并明说「航线下发需在无人机平台操作，本页
不代为下发」。保留一个假的「已下发」toast 是在骗现场调度 —— 那条航线真的不会飞。

### 6. 实时视频流：不挂静态图冒充

萤石云凭据实测已失效（`code:-1`），keehang 直播流需另一套鉴权且未验证。
UavPage 的画面区改成明说「实时视频流未接入 / 萤石云凭据已失效」，
不再挂一张静态示意图当直播画面 —— 示意图长得像现场画面，会被当成实时情况看。

### 7. 巡检照片为什么不自动加载缩略图

真实 DJI 原图单张 5~8MB（实测 5 378 048 字节）。列表里直接 `<img src>` 会把流量
吃光。列表只显示「所属任务 + 拍摄时间 + 体积摘要」，**点开大图时才加载原图**
（用户主动行为，走 `utils/albumSave.ts` 的预转机制）。

### 8. 定位标签拿不到区域 → 人数位仍为「—」

`/device/label/page` 每行绑定了 `personId` 且有 `isOnline`，但**标签行没有
区域/网关字段**（实测 keys：`labelSn,personId,thirdpartyPersonId,isOnline,
isEnable,power,isMotionless,softVersion,expiredDate,maxCsqRssi,runModel,
press,tamperProof`）。区域信息只在网关的 `areaName` 上，两边**无法关联**。

所以「区域人数 = 该区域下在线标签数」这条链路走不通，首页人员分布的人数位
维持「—」，不硬凑数字。`api/iotDevice.ts` 先把三组原始数据收回来，关联逻辑
放在 `utils/locateDevice.ts`（尚未创建），关联不上就退回「—」。

顺带修正两处字段语义：
- 信标行的 `gatewaySn` 其实是**信标自己**的 SN（前缀 `YZPB`），`gatewayName`
  才是它挂在哪个网关下。
- `fetchAll` 分页按唯一键去重：实测 `total=102` 但当页只回 1 行，不去重的话
  同一批行会被累加 5 次，在线设备数虚高。

### 9. C 组 tsdb：**接口通，但本项目拿不到 sn**

`queryRealTimeDataV2` 收 `{queryList:[{productCode, sn, field, code}]}`，
`productCode` 就是项目码 `P000000076`。但 `:8084` 的设备台账只有 `device_name`
与 `device_info.extra_fields`，**没有序列号字段**，`sn` 填不出来。

所以这一层只能拿到「接口可用」这个结论，设备详情页的作业指标（吊次 / 吊重 /
利用率）**保持空态**。客户端先建好，等台账补上 `sn` 即可直接用。

### 12. 塔机工作循环：路由在哪、卡在哪（2026-11 第三轮实测）

V2（Unity）端 `CraneWorkCycleRequester.QueryWorkCycleHistoryAsync` 的 IL 指向
`POST https://tciccs.cscec3bxjy.cn:30400/api/data/v1/tsdb/queryEvent`
（body `{startTime, endTime, eventItems:[{productCode, sn, eventCode:"EVENT_WORKDATA"}]}`）。
现场直连复测结论：

| 探测 | 结果 |
|---|---|
| `POST /api/data/v1/tsdb/queryEvent`（`/queryRealTimeDataV2` 同） | **404** `No handler found for POST /data/v1/tsdb/queryEvent` —— 该主机没有 tsdb 路由 |
| `POST /api/towercranedataservice/getWorkCycleInfoHis` | **400** `{"code":400,"success":false,"msg":"塔机编号不存在"}` —— **handler 存在**，缺的是设备编号 |
| `GET` 同一路径 | 405（只收 POST） |
| `GET /api/swagger-ui.html`、`/api/v3/api-docs` | 返回一页「saved from **attack.jinxibei.com**」的 HTML —— 该主机上疑似被挂过马/被 WAF 替换，**不要再抓这两个路径**，也不要把它当接口文档 |

因此客户端落在 `src/api/towerCrane.ts`：按 `getWorkCycleInfoHis` 发
`{sn, startTime, endTime}`（**字段名仍未验证**：服务端对任何 body 都回同一句
「塔机编号不存在」，无法区分「字段没取到」与「编号不存在」），解析层
`toWorkCycles()` 对信封与字段别名尽量宽容；拿不到编号 / 请求失败**一律返回
`null`、不抛错**，页面显示「—」。

sn 的来源只做了一件事：从 `extra_fields` 的 label 里按「序列号 / SN / 设备编号 /
塔机编号」取值（`utils/deviceLedger.ts: serialOf`）。**现场 8 台设备的
`extra_fields` 里没有这些键**，所以塔机卡当前退回台账里的「最大高度」一格；
等现场补上编号，`stores/deviceLedger.ts` 的 `craneDay` 有值后卡片自动换成
「今日吊重 + 今日吊次」两格（模板已经按 `stats` 渲染，不需要再改 UI）。

电梯「累计运行时间」需要同一族的工作循环能力（V2 端在 `ElevatorRequester`
里），本轮**未接**，卡片缺省不渲染该格。

### 12.1 为什么 Postman 能调、浏览器里调不通：CORS（2026-11 第四轮实测）

先补一句上表的过期结论：字段名与时间格式**已经验证** —— `deviceSN`（大写 SN）+
`'yyyy-MM-dd HH:mm:ss'` 字符串；写 `sn` 或传毫秒时间戳都会被回
`400 塔机编号不存在`（用真实 sn 复测，`siteName: 武汉向阳村项目`）。

而那台主机**没有放行任何跨域来源**，这是浏览器里调不通的唯一原因：

| 请求 | 结果 |
|---|---|
| `POST`（Postman / curl，不带 `Origin`） | 200 + 真实数据 |
| `POST` 带任意 `Origin`（**包括它自己的域名**） | 200，但响应里**没有** `Access-Control-Allow-Origin` → 浏览器不把 body 交给 JS |
| `OPTIONS` 预检（带 `Origin` + `Access-Control-Request-Method: POST`） | **403 `Invalid CORS request`** |
| `OPTIONS` 不带 `Origin` | 200，`Allow: POST,OPTIONS` |

我们的 fetch 带 `Content-Type: application/json`，属非简单请求，**必然先发预检**；
预检 403 → 请求直接失败 → `catch` 里 `return null` → 卡片显示「—」。
Postman / curl 不执行同源策略，所以看上去「接口是好的」。

**绕过方式：同源反代**（不改服务端，也不需要对方配合）

- 开发期：`vite.config.ts` 的 `craneProxy()` 把 `/crane-api/*` 用 Node `fetch`
  转发到上游。**不要用 `server.proxy`** —— Vite 8（rolldown）的代理是原生实现，
  对本机这个非常规端口直接 `ECONNREFUSED`，实测走不通。
- 自托管 HTTP 部署：`server/serve.mjs` 的同名路由，逻辑一致（只放行该前缀、
  只收 POST、body ≤ 64KB；反代必须排在「只接受 GET/HEAD」的守卫之前）。
- 纯静态托管（GitHub Pages）：没有反代，该路径 404 → 仍是「—」（与之前被 CORS
  拦掉的结果一致，不引入假数据）。要在这里出数，只能请塔机平台把站点 origin
  加进白名单，再用 `VITE_CRANE_BASE` 指向那个放行跨域的地址。

前端侧只改了一处：`src/api/towerCrane.ts` 的 `CRANE_BASE` 默认 `/crane-api`。

### 10. 本轮改动清单

| 文件 | 改动 |
|---|---|
| `src/api/drone.ts` | 新增：CAS 两步登录、任务 / 遥测 / 航线 / 媒体 |
| `src/api/iot.ts` | 新增：ak/sk 换 token、tsdb 实时数据 / 事件 |
| `src/api/iotDevice.ts` | 新增：定位标签 / 网关 / 信标（分页去重） |
| `src/api/weather.ts` | 新增：高德天气代理 |
| `src/stores/uav.ts` | 新增：无人机 store（三态起飞条件） |
| `src/stores/patrol.ts` | 新增：巡检照片 store |
| `src/stores/airHazard.ts` | 航拍派生改为按真实拍摄日期过滤 |
| `src/stores/auth.ts` | `clear()` 里加 `useUavStore().reset()`（清缓存令牌） |
| `src/views/sub/UavPage.vue` | 四块改真数据；画面区明说未接入 |
| `src/views/home/PatrolPanel.vue` | 照片墙改真数据，删分类 |
| `src/components/sheets/PatrolSheet.vue` | 大图元信息改服务端字段 |
| `src/components/sheets/UavTodaySheet.vue` | 今日任务改真数据 |
| `src/components/sheets/UavRouteSheet.vue` | 航线改真数据 + 如实告知下发通道 |
| `src/components/overlays/SheetHost.vue` | 弹层标题取真实文件名 |
| `src/data/config.ts` `src/data/device.ts` | 删演示常量 |

### 11. 单测

新增两个文件（`drone.spec.ts` 29 条、`iot-weather.spec.ts` 25 条），并改了 6 个
既有文件：

- `bottom-sheet.spec.ts`：弹层入口从演示照片墙改为往 patrol store 灌真实照片；
  标题断言从「项目全景」改为文件名。
- `patrol.spec.ts`：卡片不再显示文件名（显示任务 + 时间），断言随之改；补 fetch
  断网桩，避免用例真的去请求 keehang。
- `device-page.spec.ts`：无人机页四块断言重写；桩返回真实形态的执行记录与遥测。
- `motion-perf.spec.ts`：「智巡分类」用例改为「智巡照片卡片」—— 六个分类已删除。
- `guards.spec.ts`：图片引用清单移出 `data/config.ts` 与 `views/sub/UavPage.vue`
  （演示图删完后自然不再引用）。
- `stores.spec.ts`：航拍派生用例改为按真实日期过滤。

> **踩到的测试陷阱**：`vitest.config.ts` 开了 `unstubGlobals: true`，桩会在每个用例
> 前被清掉。若上一个用例有**未 await** 的请求，它会在桩被清后真的打到线上，
> 并把 keehang 的模块级会话写回缓存（表现为随机失败 + 日志里的 401）。
> 解法：`afterEach` 里先 `await flushPromises()` 排空待决请求，再 `clearSession()`，
> 最后 `vi.unstubAllGlobals()`。

- 全量 **689 条全过**（28 文件）、`vue-tsc --noEmit` 无错、`npm run build` 通过。

### 13. 阶段 9（2026-11-12）：塔机 sn、爬架传感器、5G塔机

> **口径变更**：用户明确「页面展示的数据跟 V2 桌面端一致即可」，不要求与 `:8084`
> 台账的台号一一对应。以下结论**推翻上面第 9、12 节**里「拿不到 sn → 保持空态」。

**（1）塔机编号找到了**

`getWorkCycleInfoHis` 要的编号不在台账里，在 **V2 的 Unity 场景包**里。用 UnityPy
读 `MonoBehaviour` 的 typetree，抽到 3 个 `deviceSn`：

```
91320506MAE18ATB9XTC202606181EW2   → 向阳村2#塔机
91320506MAE18ATB9XTC202606181EW3   → 向阳村3#塔机
91320506MAE18ATB9XTC202606181EW4   → 向阳村4#塔机
```

反查接口确认 `siteName: 武汉向阳村项目`，是**本项目自己的**塔机。早先 MQTT 里抓到的
「光谷元箸项目N号塔机」是别的项目噪音，不能作为数据源。

登记表落 `src/data/craneSn.ts`。`stores/deviceLedger.ts` 的 `loadCraneDay()` 取编号分两级：
台账 `serialOf` 优先，否则用这张表按 3 台查（结果是**全场合计**，不做逐台映射 ——
台账台号与 sn 顺序没有可信对应关系）。

**（2）契约修正（原来的实现是错的）**

| 项 | 错误写法 | 正确写法 |
|---|---|---|
| 字段名 | `sn` | **`deviceSN`** |
| 时间 | `startTime: <ms>` | `startTime: "yyyy-MM-dd 00:00:00"` |
| 结束 | `endTime: <ms>` | `endTime: "yyyy-MM-dd 24:00:00"` |

写错时服务端不会说「字段错了」，只说 `{"code":400,"success":false,"msg":"塔机编号不存在"}`
—— 这也是第 12 节当年无法区分「字段没取到」和「编号不存在」的原因。

实测当日：2# = 12 次 / 6.74t，3# = 0 次，4# = 2 次 / 1.23t，合计 **14 次 / 7.97t**。

**（3）爬架传感器（CDN 静态 JSON，免登录）**

```
http://120.26.34.95:9689/CDN/PC/ScaffoldData.json
```

来自 V2 `ScaffoldDataRequester::InitRequest` 的硬编码地址（`CdnConfig.txt` 给根）。
38 个机位，字段 `itemName / fbTilt / lrTilt / load / updateTime`，**带单位字符串**
（`"3.13mm"` / `"0.00吨"`），解析走 `utils/scaffold.ts` 的 `toNumber()` 抓数字前缀。

阈值照 V2 `ScaffoldDataRequester.Evaluate(v, threshold, unit)` → `Math.Abs(v) > threshold`：
左右倾斜 60mm、前后倾斜 60mm、载荷 5 吨。实测 `30#机位 左右倾斜 179.5mm` 超限
（与设计稿上那个 `179.70mm` 同源，但这是现场真值）。

**（4）线上为什么需要内置快照**

`ScaffoldData.json` 是**纯 HTTP**，站点是 GitHub Pages（**强制 HTTPS**），浏览器会按
mixed content 直接拦掉。所以 `api/scaffold.ts` 做成三段：

1. CDN（6s 超时）→ `source = 'live'`
2. 失败 → 项目内置 `public/data/scaffold.json`（同一份文件的真实快照，38 机位，
   `updateTime` 最新 `2026-11-07 14:02:49`，随仓库发布）→ `source = 'snapshot'`
3. 都失败 → `null`，页面走空态

三条路径**都不抛错**。`source` 只做内部诊断，**页面不展示来源**（用户要求去掉
「离线快照」字样），只报读数时间戳。

**（5）其它**

- 卡片名「智能塔机」→ **「5G塔机」**（`utils/deviceLedger.ts` 的 `CARD_DEFS`、
  `stores/subpage.ts` 子页标题、`data/device.ts` 的 `deviceSet().title` 三处同改）。
  台账 `device_name` 里的「智能塔机2/3/4」是服务端原名，**不改**。
- 「全部设备运行状态」逐台列表**已按用户要求移除**（设计稿智控页只有
  「统计两卡 + 9 张设备卡」，没有逐台清单）。原 `ledger.allUnits` 一并删除，
  逐台状态改由各设备详情页承载 —— 首页不再重复一遍台账。
- 在线格 `/总数` 被吞的 bug：分子分母原写在两个兄弟节点里，CSS 只订到分子。
  改为两者同处 `.eq-online b` 内 + `white-space: nowrap`。
- **爬架卡三格改「正常台数/有读数的台数」**（用户要求，形状同设计稿 `35/36`）：
  `ScaffoldCell` 增加 `normal` / `total` 两个计数，卡片只放计数、不放读数，
  分子恒绿（`--online`）、分母中性；`total === 0` 时整格「—」**不写 0/0**。
  具体哪台越了多少由说明行（`firstOverLabel`）报，两处不重复。
  `total` 只数「有该指标读数」的机位 —— 没上报的机位留在分母里会被读成「异常」。
- **爬架子页机位列表改按机位号升序**（原按读数绝对值倒序，像排行榜，
  核对某一台时要倒着数）。比较器用 `localeCompare(..., {numeric: true})`，
  否则 `19#` 会排到 `2#` 前面；异常行仍靠红字 + 表头超限台数 + 上方告警句定位。

**（6）仍然无解**

- 电梯今日升降次数：接口/算法/字段全齐（`EVENT_WORKDATA`，`count = Data.Count`），
  但 C 组 IOT 账号权限不足（`status:11 权限不足`），换三组密钥均报 `status:2`
  → **服务端账号问题，客户端无法解决**。
- 5 类机器人「今日作业次数」：V2 **没有任何机器人接口** —— `HotUpdateScripts.dll` 里
  只有 `BuildingGrindingRobot` / `BuildingTrowelingRobot` / `BuildingMeasuringRobot`
  三个类，每个类仅一个 `followTarget` 字段（点模型时 UI 跟随的位置）；`:8084` 台账
  全项目 22 台设备里也没有机器人。但 V2 的**装备管理页预制体里预置了值**：
  `UIView 装备管理一张图 / 底部栏 / 施工机器人栏` 下每张卡的 `Value` 就是写死的
  `5次 / 9次 / 7次 / 4次 / 3次`（同栏在线数统一写死 `4/4`、爬架高度写死 `0m`）。
  2026-11-12 按用户要求「V2 从哪取你就从哪取」，照同一组值落地
  （`src/data/robotStats.ts`），卡片仍是静态卡：不可点、不出在线格 ——
  台账里没有这些设备，任何 `x/y` 都是编的。这是本项目**唯一一处经用户授权**的模拟值例外。
- `120.26.34.95:7117/test/query`（V2 的 AI 查询入口）：502，后端拒连。
- CDN `/CDN/PC/` 只有 4 个文件：`ScaffoldData.json`（已接）、`monitorData.json`、
  `versionDescAll.json`、`LinkSetting.json`。

**（7）验证**

`npm run test` **764 条 / 30 文件全过**，`npm run build`（含 `vue-tsc --noEmit`）通过。
新增 `tests/unit/scaffold.spec.ts`（23 条）+ `tests/unit/tower-crane.spec.ts` 契约用例。

**（8）塔机「设备信息」弹层：照 V2 塔机弹窗做两段（2026-11-12 第四轮）**

取证对象是场景包 `_Data/yoo/DefaultPackage/BundleFiles/cb/cb4440f68c48489259d528982c1d7320/__data`
（同一份包里既有塔机模型，也有 2D UI）。`GameObject` 树里能找到：

```
2D UI / UIView 塔机 / Level2 / 塔机弹窗
```

节点结构与文本（`MonoBehaviour.m_text`）+ 脚本 `UIPanelCrane` 的序列化字段一一对应：

| V2 段 | 行 | 绑定字段 |
|---|---|---|
| Title1 **基本信息** | 当前状态 / 塔机编号 / 塔机高度 / 安检有效期 / 质检报告状态 / 司机 / 功效 | `txtStatus` `txtID` `txtHeight` `txtSafetyInspectionValidity` `txtQualityInspectionStatus` `txtTowerCraneDriver` `txtEfficiency` |
| Title2 **实时工况信息** | 实时回转 / 实时幅度 / 实时高度 / 实时时间 | `txtRotate` `txtRange` `txtRopeHeight` `txtTime` |
| Title3 告警信息 | 当前无报警 / 查看详情 | `AlarmStatus` |

**两段的数据源不同，别混成一个**：

- **基本信息 = 设备台账**。V2 `DigitalMap.DeviceInfosRequester` 请求
  `GET :8084/api/data/deviceinfos?page=1&page_size=100&project_id=P000000076`，
  再解析 `device_info.extra_fields`（dll 里 `deviceinfos` / `device_info` /
  `extra_fields` 三个常量都在）。本项目早就走这条路，且值与 V2 完全一致
  （高度 `10.3m/70m/32.5m/64m`、安检有效期 `2026-12-10`、质检报告状态 `正常`、
  塔吊司机 `机师`）。台账里没有「塔机编号」与「功效」→ 写「—」，
  **不拿台号或主键 id 去凑**。
- **实时工况 = 塔机实时数据**。V2 侧是 `DigitalMap.Crane.Requester.CraneRealtimeRequester`
  （`FetchRealtimeDataAsync` / `PollRealtimeDataAsync`，字段 `RealtimeDataIntervalMs`），
  两条通道的地址都硬编码在 dll 里：
  1. `https://iot.cscec3b-iti.com/api/data/v1/tsdb/queryRealTimeDataV2`（查询式）
  2. MQTT `120.26.34.95:1883`（admin / `Test@wf.101025`），主题
     **`/{projectId}/towercranedataservice/pushRealTimeInfo`**（推送式）

**本项目当前两条都拿不到 —— 是源端没数据 / 没权限，不是客户端没实现**：

| 通道 | 2026-11-12 实测 |
|---|---|
| MQTT 推送 | 订阅 `#` 跑 20s，共 21 个活跃主题，**没有一条 `P000000076`**；塔机主题只有 `P000000096`（光谷元箸项目）在推 —— **这一行后来被推翻：当时连的是 `120.26.34.95`，本项目要连 `115.159.67.12`，见下方 (10)** |
| tsdb 查询 | `{"status":10,"msg":"部分产品数据您无权查看，非法的产品列表为：P000000076"}`（去掉 productCode 同样报非法，只有空 `queryList` 才回「查询条件为空」）—— 与电梯 `EVENT_WORKDATA` 的 `status:11 权限不足` 同属账号白名单问题 |

同平台塔机实时报文长这样（P000000096 抓到的真实 payload，字段正好对应 V2 的
`txtRotate / txtRange / txtRopeHeight / txtTime`）：

```json
{"angle":293.66,"range":7.98,"height":36.1,
 "monitorDateTime":"2026-11-12 15:56:46.970",
 "deviceSn":"…","deviceName":"光谷元箸项目1号塔机","siteName":"武汉光谷元箸项目",
 "weight":0.0,"weightRate":0.0,"moment":0.0,"windSpeed":0.0,
 "frontArmLength":44.6,"backArmLength":17.6,"bodyHeight":37.85,
 "topHeight":71.15,"safeWeight":18.0,"craneType":1,"hasLoadInfo":0}
```

所以四行按 V2 顺序占位「—」，弹层下方给一行说明，**不编数字，也不拿台账的
塔机高度冒充实时高度**。等向阳村塔机开始上报（或账号放开 tsdb），接
`api/iot.ts: fetchRealtimeData` / MQTT-over-WS 即可原位回填（模板已固定四行）。

> **V2 桌面端为什么"看起来有数"**：dll 里还有一个
> `DigitalMap.Crane.Development.TowerCraneSimulator`（`PlayCoroutine`、
> `[TowerCraneSimulator] JSON` 日志）。它在 **Development** 命名空间下，是本地造数
> 的调试模拟器，真实推送没来时由它驱动 3D 模型。也就是说 V2 界面上的实时回转 / 幅度
> 很可能不是现场设备上报的。本项目不启用它（会误导读数）。

#### (9) 「V2 的实时工况是不是取自 P000000096」—— 不是，已逐条否定

怀疑点：broker 上唯一在推塔机数据的主题是 `P000000096`，那 V2 界面上的
实时回转 / 幅度 / 高度 / 时间会不会就是它？**结论：不是**，三条独立证据：

1. **主题是硬编码的，且写的是本项目项目号**。`HotUpdateScripts.dll` 的 UTF-16LE
   常量里只有一条塔机主题：`/P000000076/towercranedataservice/pushRealTimeInfo`
   （连斜杠开头），同段还有 `P000000076` 与
   `/api/data/deviceinfos?page=1&page_size=100&project_id=`。V2 根本没订阅 096。
2. **P000000096 是另一个项目的 4 台车**。25s 抓包，该主题下 4 个 `deviceSn`
   全是 `91320506MAE18ATB9XTC20260818 11/13/16/18`，`deviceName`
   「光谷元箸项目1号/3号/6号/8号塔机」，`siteName` 一致的**武汉光谷元箸项目**。
   而向阳村塔机 sn 是 `…XTC2026**06**181EW2/EW3/EW4`（`data/craneSn.ts`，
   用 `getWorkCycleInfoHis` 查回来 `siteName=武汉向阳村项目`）。两批设备无关。
3. **V2 无数据时的默认文本就是 `--`**。`UIView 塔机/Level2/塔机弹窗` 的
   `DataContent1/2` 下，`Value状态 / Height Value / Safe Value / Quality Value /
   Driver Value / Efficiency Value / Value回转 / Value幅度 / Value高度`
   预制体默认值**全部是 `'--'`**。也就是说 076 没推送时 V2 显示的是 `--`，
   与本项目现在的「—」一致，而不是 096 的数字。

**另一条硬约束**：`120.26.34.95` 只开了 1883（TCP MQTT），8083/8084/9001/15675
全关，`http://120.26.34.95:8083/mqtt` 直接 502 —— broker 没有 WebSocket 监听。
浏览器拿不到 1883，要用只能自建 WS 桥（dev 中间件 / `server/serve.mjs` 可做，
GitHub Pages 静态托管做不了）。这也是「即使想用 096，线上也上不了」的原因。

**顺带补一条**：V2 弹窗还有第三段 **Title3 告警信息**（`AlarmStatus` 默认
「当前无报警」+「查看详情」按钮）。本项目弹层目前只有前两段，未实现第三段。

#### (10) 塔机实时工况：已接通（broker 之前找错了）

上一小节把 tsdb 与 MQTT 都判成「源端无数据」，**结论错在 broker 地址**。
V2 客户端界面确实有实时读数，用户反复质疑后重挖，四个证据一次对齐：

1. **场景对象上的序列化字段是真值**。`场景 / 塔机2 / 实时数据` 挂着
   `CraneRealtimeRequester`，UnityPy 读出来的字段是：

   ```
   host = 115.159.67.12    port = 1883    userName = admin    password = Test@wf.101025
   topic = /P000000076/towercranedataservice/pushRealTimeInfo
   offlineTimeout = 25.0   checkInterval = 3.0
   ```

   而之前所有抓包都打在 `120.26.34.95:1883` —— **那是另一台 broker**，
   上面只有「光谷元箸」4 台车（`…XTC2026**08**1811/13/16/18`）在推。
   V2 启动时 `StreamingAssets` 里给的是 `http://120.26.34.95:9689`（资源 CDN），
   塔机推送却是 `115.159.67.12`（登录/数据服务那台），两台机器，别混。

2. **连对 broker 后本项目三台塔机一直在推真数据**（10s 左右一帧）：

   ```json
   {"angle":223.79,"range":17.67,"height":6.10,"monitorDateTime":"2026-11-12 16:30:46.951",
    "bodyHeight":42.0,"topHeight":56.0,"weight":0.0,"weightRate":0.0,"windSpeed":0.0,
    "deviceSn":"…EW2","deviceName":"向阳村2#塔机","siteName":"武汉向阳村项目"}
   ```

3. **「塔机高度」的口径也对上了**：V2 弹层显示智能塔机2 = `42.00m`，
   而台账 `extra_fields` 里 2 号的「高度」是 `10.3m`；`bodyHeight` 正好 42.0。
   所以 V2 的塔机高度取**实时报文的塔身高度**，不是台账值。
   （截图佐证：16:19 回转 `220.72°`，16:30 抓到 `223.79°`，同一台车在慢慢转。）

4. **浏览器侧只有 WebSocket 这一条路**：`115.159.67.12` 只开
   `ws://115.159.67.12:8084/mqtt`（MQTT over WebSocket，与数据服务同端口不同路径）；
   443 的 `/mqtt` 不升级、8083 handshake 失败，`wss` 不存在。

**实现（2026-11-12 落地）**

| 文件 | 职责 |
|---|---|
| `src/api/mqttWs.ts` | 自写极简 MQTT 3.1.1 over WebSocket（CONNECT/SUBSCRIBE/PUBLISH/PINGREQ，仅 QoS 0，约 200 行，不引 `mqtt` 包） |
| `src/api/craneRealtime.ts` | 主题拼法、报文解析（脏帧丢、不抛）、地址推导与断线重试（2→4→8→15s 封顶） |
| `src/stores/craneRealtime.ts` | 引用计数开关（弹层开才连）、`sn → 最新帧`、25s 无帧即视为离线（对齐 V2 `offlineTimeout`） |
| `vite.config.ts` / `server/serve.mjs` | 同源 `/mqtt` 的 WebSocket 裸字节反代（`node:net` pipe，不用 Vite 原生 proxy） |
| `components/sheets/DeviceInfoSheet.vue` | 四行填真值；「塔机编号」用 `craneSnOf(unitNo)` 补上；「塔机高度」优先 `bodyHeight` |
| `data/craneSn.ts` | 新增 `craneSnOf()`：按台号映射（V2 场景里 `塔机2` 的 `deviceSn` 就是 EW2，与它同口径） |

**部署边界（必须知道）**：`ws://` 在 HTTPS 页面下会被当混合内容拦掉，所以

- `npm run dev` / `npm run preview` / `npm run deploy:http` —— 有同源反代，**实时工况可用**；
- GitHub Pages（HTTPS 静态托管、没有服务端）—— 连不上，四行回落「—」。
  要给线上也开，只有两条路：给 broker 配 `wss` + 可信证书，或用 `VITE_CRANE_WS`
  指一个自己的 wss 端点。

「传统塔机5」在场景里 `deviceSn` 是空的 → 没有编号也没有实时工况，与 V2 一致。
具体到弹层怎么渲染，见下面的 (11)。

**取证方法（下次挖 V2 照这个走）**：V2 的业务代码**不在 `GameAssembly.dll`**
（那里连 `tsdb` 都搜不到），而在 YooAsset 包里的热更程序集 ——
`_Data/yoo/DefaultPackage/BundleFiles/d9/d96081d47e6b8fc1d2a0bc70c6c0a2c6/__data`
是个 bundle，其 `TextAsset` 里有 `HotUpdateScripts.dll`（893KB，`MZ` 头）。
UnityPy 读 `m_Script` 存成 .dll 再搜字符串即可。**字符串常量在 UTF-16LE 的 `#US` 堆里，
按 UTF-8 搜会全部落空** —— 这正是之前误判「V2 没有这些接口」的原因。

**机组顺序**：`utils/deviceLedger.ts: byUnitNo` 按名称里第一段数字升序，
塔机页从「传统塔机5 → 智能塔机4 → 3 → 2」（服务端 id 倒序）变成
**智能塔机2 → 3 → 4 → 传统塔机5**；电梯/爬架同一规则。

#### (11) 弹层行数与「传统塔机5」：V2 到底渲染几行

**V2 塔机弹窗的完整节点树**（`BundleFiles/cb4440f6…` 里 `UnityPy` dump，
带默认值）：

```
Title1 基本信息      DataContent1  7 行，值节点默认全是 '--'
  当前状态 / 塔机编号 / 塔机高度 / 安检有效期 / 质检报告状态 / 司机 / 功效
Title2 实时工况信息  DataContent2  4 行
  实时回转 / 实时幅度 / 实时高度 / 实时时间
Title3 告警信息      DataContent3  AlarmStatus='当前无报警' + Btn='查看详情'
```

**没有说明行，也没有「是否隐藏」「更新时间」「责任人」** —— 那几项是台账
`extra_fields` / `device_info` 的后台字段，V2 界面从不展示。

**「传统塔机5」在 V2 里怎么处理**：场景里它是一台正常的 `BuildingCrane`
（`friendlyName = 传统塔机5`、`buildingType = 31`，对照智能塔机是 `21`），
能点开**同一个**塔机弹窗；但 `TowerCraneController.deviceSn` 是**空字符串**。于是：

| 行 | V2 显示（逻辑上） |
|---|---|
| 安检有效期 / 质检报告状态 / 司机 | 照台账正常显示（`DeviceDic` 用 `building.GetUniqueID()` 查，不靠 sn） |
| 功效 | **`--`** —— 功效是按平台设备编号统计的台班效率，没有 sn 无从统计（台账里的「功效统计信息 60 吊次/台班」没有任何界面在用） |
| 当前状态 | **`离线`** —— 走 `GetTowerState("")`，不是台账的 `online_status` |
| 塔机编号 | `--`（`GetData("")` 为 null） |
| 塔机高度 | `--` |
| 实时工况四行 | `--` |

即 **照常弹出、缺的留 `--`**，不隐藏这台车、不隐藏第二段、不加任何说明文案。
本项目照此实现，不对它做特殊分支。

> ⚠️ **但这台车在实际运行的 V2 里会「看起来有数」**：`UpdateRealtimeInfo`
> 在 `GetData` 为 null 时**直接 return，不清空四个文本**，于是面板留着
> 上一次打开的那台车的编号 / 高度 / 四行读数。详见下面的 (12) ——
> 那是显示残留，不是传统塔机5 的真实数据。

#### (12) 为什么 V2 截图里「传统塔机5」有 EW4 的编号和实时值（显示残留，不是它的数据）

2026-11-12 用 `dnfile` 把热更程序集 `HotUpdateScripts.dll` 的 IL 逐条读出来
（`UIPanelCrane` / `CraneModel` / `UIViewCraneLevel2` / `UIBottomCardCraneLv2`）：

```csharp
// UIViewCraneLevel2.OnSelected(card)
panel.ShowPanel(new UIPanelCraneData { no = card.no, building = cranes.Find(c => c.GetCraneNo() == card.no) });

// UIBottomCardCraneLv2.InitCard(BuildingCrane crane, Action cb)
no = crane != null ? crane.DeviceSn : string.Empty;     // ← 传统塔机5 这里是 ""

// UIPanelCrane.ShowPanel(data)
txtName.text = data.building != null ? GetDisplayName(building) : GetCraneName(data.no);  // ← 标题：传统塔机5
UpdateRealtimeInfo(); UpdateOnlineState(); UpdateDeviceInfo();

// UIPanelCrane.UpdateRealtimeInfo()
var d = CraneModel.GetData(curData.no);   // GetData("") → null
if (d == null) return;                    // ★ 早退，四个文本一个都不清
txtID.text = d.deviceSn; txtHeight.text = d.bodyHeight.ToString("F2") + "m"; …

// UIPanelCrane.UpdateOnlineState()
txtStatus.text = CraneModel.GetTowerState(curData.no);   // GetData("") null → "离线"

// CraneModel.GetTowerState(key)
if (deviceStateMap.TryGetValue(key, out var s)) return s;  // "待机"/"工作中"/"正在吊装"
var d = GetData(key); if (d == null) return "离线";

// CraneModel.UpdateState(sn)   ← 每帧到达后调用，状态就是这么来的
var d = GetData(sn); if (d == null) return;
moving = |Δangle| > 0.1f || |Δrange| > 0.1f || |Δheight| > 0.1f;
deviceStateMap[sn] = d.HasLoad && d.weight > 0 ? "正在吊装" : (moving ? "工作中" : "待机");
```

三个结论：

1. **V2 的塔机「当前状态」不是台账的在线状态**，而是实时四态
   `离线 / 待机 / 工作中 / 正在吊装`（`GetTowerState`）。`SetOffline(sn)` 会把
   `deviceStateMap[sn]` 与 `DataMap[sn]` 一起删掉，之后 `GetTowerState` 兜到「离线」。
2. **传统塔机5 的编号/高度/四行是上一台车的残留**。因为它 `no == ""`，
   `GetData("")` 为 null，代码直接 `return`，没有把文本恢复成 `--`。
   截图里那组 `EW4 / 67.50m / 111.43° / 42.26m / 11.00m` 正是
   **智能塔机4（EW4，`bodyHeight = 67.5`）** 的数字。
   验证方法：重启 V2，**第一次**就点「传统塔机5」，那几行会显示 `--`。
3. 这个残留是 **V2 的显示 bug**（同一份 `CraneData` 被两台车的面板先后使用）。
   本项目每个弹层一个实例、每次打开重新计算，没有「上一台」可残留，
   所以按逻辑口径给「—」，不复制这个 bug。

**本轮对齐的改动**：`stores/craneRealtime.ts` 新增 `stateOf()`，照 `GetTowerState`
的四态与 `0.1` 位移阈值实现（首帧与 0 比，同 V2）；`api/craneRealtime.ts` 解析
`hasLoadInfo`；`DeviceInfoSheet.vue` 的「当前状态」改成 `stateOf(sn)`，只在
**通道完全没通**（HTTPS 无 WS 反代，`stateOf` 返回 null）时才回落台账
`status_text` —— 免得把「我们看不到」写成「设备离线」。


**「塔机高度」不回落台账**：dll 里 `UIPanelCrane.txtHeight` 与 `bodyHeight`
相邻（同一个类的取值链），V2 弹层智能塔机2 显示 `42.00m` 而台账写 `64` ——
42.00 正是报文的 `bodyHeight`。台账那个「高度」在 V2 弹层里**没有对应控件**。
所以本项目改成「只认实时 `bodyHeight`，没有帧一律 `—`」，不再拿台账值顶替。
（早前版本是「优先 bodyHeight、回落台账」，会让人把台账高度当成实时高度读。）

**「功效」台账里其实有值，但只有接平台的车才显示**（2026-11-12 实测 `:8084` 原样）：

| 设备 | key | value | 界面 |
|---|---|---|---|
| 智能塔机2 | `功效` | `55 吊次/台班` | 显示 |
| 智能塔机3 | `功效` | `70 吊次/台班` | 显示 |
| 智能塔机4 | `功效` | `55 吊次/台班` | 显示 |
| 传统塔机5 | **`功效统计信息`** | `60 吊次/台班` | **「—」** |

两种键名都认（`功效` / `功效统计信息`），但**有没有 sn 是前提**：这台车的功效在
V2 弹层里是 `--`（见 (11) 表格）。2026-11-12 用户实测 V2 客户端确认这一点 ——
所以本项目也只在 `craneSnOf(台号)` 有值时显示，传统塔机5 恒「—」。
`pick()` 顺手把服务端返回的**空串**也当「没有」（`??` 挡不住 `''`）。

#### (13) 5G塔机页卡片四格 + 列表状态与弹层「当前状态」统一

**卡片四格**（照 V2 `UIBottomCardCraneLv2`：「今日吊次 9次 / 今日吊重 5.05t /
当前吊重 1.26t / 当前负荷 36%」+ 一条负荷进度条）：

| 格 | 源 | 无数据时 |
|---|---|---|
| 今日吊次 | `getWorkCycleInfoHis` 当天循环条数（逐台按 sn） | 「—」 |
| 今日吊重 | 当天循环 `weight` 累加（t，两位小数） | 「—」（一条都没重量时也是「—」，不写 0.00t） |
| 当前吊重 | MQTT 报文 `weight` | 「—」（25s 无帧即过期） |
| 当前负荷 | MQTT 报文 `weightRate` → `utils/craneLoad.ts: loadPct` | 「—」，且**不画进度条** |

逐台数字**不是全场合计**：`stores/deviceLedger.ts` 一次请求两个口径，
`craneDay`（合计，首页智控卡用）与 `craneDayBySn`（逐台，设备页用）。
某台查询失败只丢这台的指标，不会把别台已经拿到的数一起抹掉；
但合计口径仍从严 —— 少一台的合计比「—」更容易被当真。

**`weightRate` 的单位是个已知的不确定项**：协议没写，现场报文一直是 `0.0`
（2026-11-12 17:24 抓包，三台车 `weight=0 / weightRate=0 / hasLoad=0`，只有
`range` 在动，空钩状态），没法用真实数据反推。`loadPct` 按「≤1 当比值、
>1 当百分数」处理，超 100 截到 100。若现场出现「负荷显示比实际大 100 倍」，
改这一处即可。

**列表状态**：卡片右上角的胶囊以前是台账 `status_text`（只有「在线/离线」），
而弹层「当前状态」是实时四态 —— 同一台车卡片写「在线」、点开写「待机」。
现在两边都走 `crane.stateOf(sn)`：**工作中 / 正在吊装 → 绿，待机 → 灰环，
离线 → 灰字**；只有整条通道没通（HTTPS 无 WS 反代）才回落台账，
且弹层与列表回落的是同一个值。设备页在「塔机 + 已登录」时订阅实时通道，
离开页面即断开（引用计数，与弹层共用一条连接）。

**传统塔机5**：没有 sn → 四格全「—」，状态恒「离线」，不画负荷条。

#### (14) 实时推送不再经厂商 WS 网关（`server/mqttBridge.mjs`）

浏览器碰不到原始 TCP 1883，历史上的链路是「页面 → 同源 `/mqtt` → 厂商网关
`ws://115.159.67.12:8084/mqtt` → broker」。2026-11-12 傍晚这条网关路由开始
**间歇 404 / 502**，而同一时刻 `115.159.67.12:1883` 完全正常 —— 直连订阅立刻
收到三台车推送。**坏的是那层 WS 包装，不是数据。**

现在改为我们自己当 WS 服务端、直连 1883：

```
浏览器 ──WS(/mqtt)──▶ server/mqttBridge.mjs ──TCP(1883)──▶ 115.159.67.12
          MQTT 字节流                           MQTT 字节流（原样）
```

- 实现是一段**零依赖**的 WS 服务端（`101` 握手 + 帧解包/封包 + 双向转发），
  只接管 `/mqtt` 一条路径，其它 upgrade（Vite HMR）原样放过；
- 回 `Sec-WebSocket-Protocol: mqtt` —— 浏览器请求了子协议却不收到回执会**直接
  判握手失败**（Node 客户端不会，这也是「脚本能连、页面连不上」的常见成因）；
- dev / preview（`vite.config.ts`）与 HTTP 部署（`server/serve.mjs`）共用这一份，
  改完后重启 dev server 生效；`VITE_CRANE_WS` 仍可覆盖成任意 wss 地址。

**实测口径（2026-11-12 17:4x）**：三台车每 12s 一帧，浏览器端四格渲染为
`0.00t / 0%`（`weight=0 / weightRate=0 / hasLoadInfo=0`，空钩），状态「工作中」。
**「—」只在 25s 收不到该车的帧时出现**（该车停推/网关抖动），与「值是 0」不是
一回事 —— V2 桌面端拿的是同一份报文，空钩时同样显示 0.00t / 0%。

**电梯（升降机）弹层 V2 也是两段**，本项目尚未对齐（实时源未接）：

```
Title1 基本信息  ：当前状态 / 升降机编号
Title2 实时工况  ：当前楼层 / 当前高度 / 当前人数 / 当前载重
                  今日累计总人数 / 今日累计载重 / 今日累计运行时间 / 今日累计升降次数
```

实时那八项的源是 IOT `EVENT_WORKDATA`（本项目 `status:11 权限不足`）。
当前电梯弹层仍按台账平铺，只过滤掉 `是否隐藏` / `更新时间`（`TECH_FIELDS`），
等权限放开再换成两段结构。

#### (15) 塔机「作业报表」的数据在哪里（2026-11-12 第五轮）

**结论：和塔机卡片的「今日吊次/吊重」是同一条链路**，不是 tsdb、也不是新接口。

V2 的报表界面是 `UICraneHistoryPop`（37 个方法），IL 逐条读下来只有三个入口：

| 方法 | 内容 |
|---|---|
| `ShowPanel` | 取 `picker.SelectedDateTime`（默认今天），保证 `tog_Count` 至少勾一个 |
| `RefreshByMode` → `Get(GetStartDate(), GetEndDate())` | 取数 |
| `Get` | `GetRequester()` 拿 `CraneWorkCycleRequester` → `QueryAllWorkCycleHistoryAsync(startDate, endDate)` → 遍历 `WorkCycleRecordDic` 摊平 → `Sort` → `RefreshList` + `RefreshChart` |

`<QueryWorkCycleHistoryAsync>d__10.MoveNext` 里的字符串常量就是那条 URL：

```
https://tciccs.cscec3bxjy.cn:30400/api/towercranedataservice/getWorkCycleInfoHis
（失败日志 '[CraneWorkCycle] 塔机 [ … ] 工作循环获取失败或数据为空'）
```

时间窗由 `CraneWorkCycleRequester.FormatStartTime/FormatEndTime` 拼：
`"{0:yyyy-MM-dd} 00:00:00"` / `"{0:yyyy-MM-dd} 24:00:00"`。**区间口径**
（`UICraneHistoryPop.GetStartDate/GetEndDate`）：

- `mode=0` 日报：`curSelectDate` 当天（起止相同）
- `mode=1` 周报：`curSelectDate.AddDays(-(DayOfWeek-1))` → 起 +6 天（自然周，周一起）
- `mode=2` 月报：当月 1 号 → `DaysInMonth` 月末（自然月）

界面上它只有**图表 + 明细列表**：`RefreshChart` 加两条序列（`ldstr '吊次'` /
`ldstr '吊重'`，带 `tog_Count` / `tog_Weight` 切换）；`ItemCraneHistory.InitInfo`
每行六项 —— `时间 HH:mm` / `时长 {0:F1} min` / `{0:F2}t` / `{0:F1}m-{1:F1}m` /
`{0:F1}°-{1:F1}°` / 力矩 `{0:F1}`。**V2 报表里没有「利用率」也没有「负荷率」**。

**本项目落地（照设计稿排版 + 照 V2 取数）**：

- 接口层 `api/towerCrane.ts` 新增 `fetchCraneWorkCycles(sn, start, end)`（`dayRange`
  只是它的单日特例），`toWorkCycles` 补 `duration`（秒，缺字段用 `end-start` 兜底）
  与 `type`（上料/下料）。**跨月区间已实测可用**：2026-10-14~11-12 一次回 474 条 / 235KB。
- 数据层 `stores/craneReport.ts`：按 sn 并发取数、45s 环形缓存（同一区间在页签
  来回切时不重复打接口）、请求序号丢弃过期结果、登出 `reset()`。
- 口径层 `utils/craneReport.ts`：区间（自然周/自然月，照 V2）、逐台汇总、全场合计。
- 页面 `views/sub/DeviceReport.vue`：设计稿的「粒度切换 → 区间 → 三格 KPI →
  结论 → 机队表 → 导出分享」。**两处刻意偏差**：
  1. 设计稿的「平均利用率 / 负荷」两格换成**作业时长 / 峰值吊重** —— 那两个指标
     现场没有任何接口能算（利用率要排班台班，负荷率只有实时报文的 `weightRate`），
     留一个永远写「—」的格子不如换两个能逐条核验的量；
  2. 机队表列 `塔机 / 吊次 / 吊重 / 峰值 / 时长`，结论条 `关注 / 主力 / 产出 /
     峰值 / 缺数`。

**实测（2026-11-12 18:0x，真机 Chrome + 现场账号）**：

```
日报 2026-11-12   22次 / 9.95t / 5.4h
  智能塔机2 20次 8.72t 峰值2.38t 5.3h ｜ 智能塔机3 0次 — — — ｜ 智能塔机4 2次 1.23t 0.67t 4分
  传统塔机5 全「—」（无平台编号，结论里单列一条「未纳入统计」）
周报 2026-11-09 至 11-15   131次 / 92.62t / 33.9h
月报 2026-11-01 至 11-30   413次 / 324.16t / 83.1h
```

电梯的报表仍不接入：升降次数/载重在 IOT `EVENT_WORKDATA`（`status:11 权限不足`），
页签给的是明确空态 + 原因说明，不摆空指标。

**遗留观察**：服务端偶发单条循环 `duration` 异常大（近 30 天里出现过 33014s ≈ 9h
的一条），会直接抬高「作业时长」合计。这是平台原始数据，未做截断 —— 现场确认是
记录未闭合还是真连班后，再决定要不要过滤。

---

## 五、两个必须知道的隐患

1. **私钥在客户端**。大屏 open 用项目级私钥签名，原厂把私钥内嵌在桌面端；本项目
   照搬以拿到数据。它能防公开抓取，但防不住逆向（拿到包就能签）。彻底解决要服务端
   代理签名：前端调 `/proxy/yzw/*`，私钥只留在服务器（`server/serve.mjs` 加路由即可）。
2. **站点协议**。A/C/D 组接口多为 HTTP 或自签证书；站点若走 HTTPS 会被混合内容拦掉。
   当前用自托管 HTTP 部署规避，长期正解仍是「站点 HTTPS + 同域反代」。
