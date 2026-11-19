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
| GET | `/api/data/areas?page=1&page_size=100&project_id=` | 总平区域标签（**设备/工位标签，不是人员区域**） | 设备台账侧；2026-11-18 起不再用于首页人员分布 | ✅ **已接**（**在 8084**；本项目 9 条，无人数字段） |
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
| `/location/personCurLocation/v2` | 人员当前位置 | 人员分布/地图撒点 | ✅ **已接**（2026-11-18；**必须 POST**，用 GET 会回 57007 的假象） |
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
> **工种（2026-11-17 已解决，原「工种缺口」作废）**：工种数据**在**，藏在
> `POST /location/personCurLocation/v2` 的在场人员清单里 —— 每人带
> `personTypeWork`，按它分组就是「今日出勤工种」。详见下方「今日出勤工种」小节。
> 教训：当时用 GET 试这个路径拿到 `57007 接口权限未获取`，就判定「没有接口」，
> 其实**换成 POST 就能通**（网关把「方法不对」也回成 57007）。

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
| GET | 无人机：`/task/list`、`/task/exec/list/record`、`/dashboard/task/list/record`、`/dashboard/device/cache/telemetry/{id}/1`、`/{机库id}/2`、`/media/task/job/{jobId}` | 航线、任务明细、今日统计、机载遥测、机库遥测、媒体 | ✅ 阶段 8 已接（**必须带 pid 过滤**；`exec/list/record` 要带 `start/end`，否则拿最旧的一页；遥测类型段 1=无人机 2=机库） |
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
| 6 | 首页·人员分布 | **V2 三场景**（场布图 / 2#住宅楼 / 地下室）+ 下钻看管控区与**人员姓名** | `POST /location/personCurLocation/v2` 的 `alive` 名单 | ✅ 2026-11-18（原先用 `:8084 areas` 设备标签冒充，已废弃） |
| 7 | 智控·设备列表/四卡 | **真实台账**（`:8084` `deviceinfos`，8 台） | A `deviceinfos` + C `queryRealTimeData` | ✅ 阶段 4（实时数据无源） |
| 8 | 设备详情·实时状态 | 台账字段（高度/司机/安检/质检报告） | C `queryRealTimeDataV2` + `queryEvent`（**阶段 8 确认在 C 组存活，但台账没有 sn**） | ✅ 阶段 4（作业指标空态） |
| 9 | 塔机·吊次/工作循环 | 首页塔机卡「吊重/吊次」= 台账高度；详情页空态 | A/C `getWorkCycleInfoHis`（**路由存活，缺设备编号**） | ⚠️ 客户端已接（`api/towerCrane.ts`），无 sn → 整块跳过 |
| 10 | 智眸·现场快照（监控点位/抓拍） | **真实报警派生**（通道 + 日期 + `picture` base64） | 8085 `/api/video/alarms` + D 萤石云直播 | ✅ 阶段 5（抓拍已接；实时流仍无源） |
| 11 | 智眸·实景核验（隐患） | `stores/airHazard.ts` 常量 | B `device/danger/page`（实测 0 条） | 5（无数据，隐患上报是写接口） |
| 12 | 巡检任务清单 | **真实航拍照片**（keehang 媒体，按拍摄时间倒序） | D `/task/exec/list/record` + `/media/task/job/{id}` | ✅ 阶段 8 |
| 13 | 首页天气 | 无（设计稿无天气位） | E `:8088` amap/weather（**可用**） | ✅ 阶段 8 客户端已接，无消费点 |
| 14 | 无人机·航线与任务 | **真实任务 / 遥测 / 航线 / 今日统计**（keehang） | D `/task/exec/list/record`、`/dashboard/task/list/record`、`/dashboard/device/cache/telemetry/{id}/1`、`/2`、`/task/list` | ✅ 阶段 8（实时画面与航线下发仍无 REST 端点） |
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
- **和 V2 的「今日人员分布」是同一个接口**（反编译 `HotUpdateScripts.dll` 的 #US 堆：
  V2 的 `PersonApiHelper` 里就是 `/bigScreen/BigsHome/todayPersonHourStat`，
  面板标题「今日人员分布」）。2026-11-17 16:00 交叉验证：V2 大屏 项目人数 160 /
  今日出勤 65 / 出勤率 40.63%，与 `todayTeamsAtteStat` 三班组求和 160 / 65 / 40.63%
  逐位相等；曲线峰值也一致（接口工人 13 点 31 人，V2 图上绿线正好压在 30 刻度线上）。
  → **数值没有分歧，是 V2 的横轴把每个点右移了一小时**（2026-11-17 像素级核对）：
  - V2：横轴固定 1:00→23:00（标签每 2 小时，12 个），未到时段画成贴底 0；
    但它的第 i 个数据点直接摆在第 i 格上，于是**接口 11 点的值落在 12:00 刻度**；
  - 原先本项目：横轴只取接口已返回的整点铺满整图宽度，曲线被横向拉伸成另一条形状。
  证据（`todayPersonHourStat` 当日 17 条整点 + V2 截图标定 16.1 px/人，残差 < 1 人）：

  | V2 刻度 | 8:00 | 9:00 | 11:00 | 12:00 | 13:00 | 14:00 | 15:00 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | V2 曲线读数 | 23 | 22 | 23 | 18 | 30 | 31 | 27 |
  | 接口同小时 | 7 点 = 23 | 8 点 = 22 | 10 点 = 23 | 11 点 = 18 | 12 点 = 30 | 13 点 = 31 | 14 点 = 27 |

  即 **V2 的「L:00」显示的是接口 L-1 点的数**（气泡同样是这个口径：V2 悬停 12:00 显示
  工人 18 / 管理 6，接口 11 点正是 18/6）。现场另有旁证：接口把「正在走的这一小时」
  记 0（16:56 时 16 点回 0/0），而 V2 把这个 0 画在 **17:00** —— 未来时刻却是 0，只有
  「整条轴右移一格」能解释。
  现在按 V2 的画法对齐（`utils/chart.ts` 的 `peopleHourModel` live 分支）：
  - 横轴 **1:00→23:00 共 23 格**，每个点按 V2 口径右移一格（`V2_HOUR_SHIFT = 1`，
    改成 0 即回到「刻度 = 接口小时」的正确口径，逻辑只有这一处依赖它）；
  - **未到时段尾部贴 0**（V2 画法，见 `HourChartSpec.tailToZero`）：几何上补到 23:00 贴底，
    但 `series` / `ys` 仍留 null —— 触控气泡对没到的时刻显示「—」，不把「还没到」说成 0 人；
  - 纵轴与 V2 同一起点 **0/10/20/30/40**（峰值不足 40 也铺到 40；真超 40 才按 10 的倍数放大）；
  - 横轴标签取 V2 同一套奇点位的子集：**1:00 / 5:00 / 9:00 / 13:00 / 17:00 / 21:00**。
    V2 在 1080 宽大屏上标 12 个（每 2 小时，可见到 21:00，23:00 那格被屏宽挤出画外），
    手机卡片只有约 320 个 viewBox 单位、字号 11px（「21:00」本身约 28px 宽），12 个
    必然压字；这 6 个间距 50px，窗口与 V2 可见区间一致。23:00 不挂标签 —— 它与 21:00
    只隔 25px，两个四位数会直接叠在一起，右端由贴底曲线收尾。
    单测锁了「横轴标签两两间距 ≥30」这条，以后调宽度/字号不会悄悄挤成一坨。
- 两个接口各自独立成败（`Promise.allSettled`）：任一失败只影响它那块，该块显示空态；

#### 今日出勤工种（2026-11-17 上线，数据源 `POST /location/personCurLocation/v2`）

`/person/page`、`/report/attendance/attendanceDay`、`/location/personCurLocation/v2`
这三条**必须 POST**——用 GET 试会被网关当成「路径不匹配」，统一回 `57007 接口权限
未获取`（不是 405），2026-11-17 因此把它们误判成「无权限」查了很久。

三条路里只有最后一条能给出「今日在场」的口径，另两条都不对：

| 源 | 问题 |
|---|---|
| `POST /person/page` + `presentStatus=1` | 花名册的「在场」标记，含好多天没做出场的人：木工算 90 人，实际在场 17 人 |
| `POST /report/attendance/attendanceDay` + `{date}` | 日考勤明细**收工后才生成**：`date=昨天` 有数据、`date=今天` 恒为 `[]`，实时看不了 |
| `POST /location/personCurLocation/v2` + `{}` | ✅ 返回 `stayPersonPageVos`：当前在场人员清单（实测 66 人），每行带 `personTypeWork`/`personName`/`enterpriseName`/`personOrgan`/`totalStayTime` |

这也是 V2「今日入场人员」表格的同一个源（V2 第 1 行「雷承林 / 木工」与清单逐条对得上）。
端上按 `personTypeWork` 分组、人数降序；`其它 / 其他 / 未填工种` 属兜底桶，**固定沉底**
（不参与排名，否则读起来像现场真有一支「其它队」）。

卡片放在「今日班组出勤」**上方**（用户指定），条形图沿用设计稿 `.trade-*` 样式，
副标注「在场人数」以区分「今日打卡」口径；取不到时给空态，不拿演示值补。

#### 人员分布（2026-11-18 上线，同一接口的 `alive` 名单）

同一份 `POST /location/personCurLocation/v2` 响应里还有两块可直接用：

| 字段 | 内容 |
|---|---|
| `stayPersonPageVos[]` | 每人带 `personName` / `personTypeWork` / `areaName` / `enterpriseName` / **`alive`**（此刻是否在线） |
| `stayPersonCountVos[]` | 按管控区聚合：`areaName` / `onlinePersonNum` / `offlinePersonNum` / `totalPersonNum`，末行 `areaId="-1"` 是「全部」 |

**口径（逐项实测过）**：`alive === true` 的人按 `areaName` 分组，
管理区域 33 / 智能钢筋加工区 2 / 北侧钢筋加工区 3 = **38**，逐个等于
`stayPersonCountVos` 的 `onlinePersonNum`，也等于「全部」行的 38。所以人数直接取
名单条数 —— 名单与数字天生一致，不会出现「38 人」点开只有 30 个名字。
`totalPersonNum` **不能**用：各管控区之间会重复计人（同一个人今日去过多个区域），
加起来远超总人数。

页面按 V2 地图归成三个场景（`src/api/person.ts: sceneOf`）：

| 场景 | 纳入的管控区 | 下钻后列什么 |
|---|---|---|
| 场布图 | 管理区域 / 智能钢筋加工区 / 北侧钢筋加工区（总平面上的都在这里） | 管控区（人数降序） |
| 2#住宅楼 | `2#楼` 1F/3F/4F/5F 等楼栋管控区 | **楼层 1F~5F**（固定五行） |
| 地下室 | `B1管理区域`（先判 B\d / 地下，否则会被「管理区域」抢走） | **楼层 -1F** |

**楼层规则（2026-11-18，对齐 V2 浮层）**：2# 住宅楼固定列 `1F 2F 3F 4F 5F` 五行，
`B1管理区域` / `B2管理区域` 解析成 `-1F` / `-2F`（`floorOf`）。
固定枚举而不是"数据里有哪层列哪层"，是因为现场 2# 楼只有 1F/3F/4F/5F 四条管控区，
2F 没有——按数据列会凭空少一行，而 V2 里它就是一行 0 人。
同一层的多条管控区（如 `2#楼5F管控区` + `2#楼5F管控区_copy`）合并成一层；
表外楼层（将来出现 6F、-2F）按层数追加在后面，负层保持 -1F 在 -2F 之前。

点场景下钻 → 一行一楼层 / 一个管控区 + **人员姓名 + 工种**（限高 320px 内部滚动，
滚到边界后继续滑会接力给外层抽屉）。`-1`「全部」不参与归类，只用来校验总数。

> 与「今日出勤工种」卡的口径差异：工种卡用**全天在场清单**（含已离场的人，
> 对齐 V2「今日入场人员」表格）；人员分布用 **`alive` 在线**（对齐 V2 人员分布浮层）。
> 两卡数字不同不是 bug。

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

**报警地点（点位名）不在接口里。** 行里只有 `deviceNo` / `channelNo`；
`/api/video/cameras` 的 `install_location` 对 `P000000076` 是 0 条（实测
`?project_id=P000000076` → `total:0`），`/api/data/areas` 里也没有摄像头点位。
所以详情页「报警地点」由客户端映射表 `src/data/config.ts` 的 `CAM_PLACE`
（通道号 → 点位名）还原，映射来源是与 V2 的 AI 报警详情逐条对齐：

| 时刻（本项目接口里的同一条） | 通道 | V2 显示的报警地点 |
|---|---|---|
| `2026-11-17 12:39:06` 安全帽检测 | 2 | 材料堆场 |
| `2026-11-17 13:58:24` 安全帽检测 | 3 | 安全讲台 |

本项目只有一个设备（`06d0680610086`）、两个通道（2、3），所以这两条即全量。
**别拿慧眼 `camera_name` 来填**：`/api/video/alarms/hjhy` 是另一套编号
（ch2 = 现场大门内 / ch3 = 宣讲台），混用会张冠李戴。没有映射的通道一律退到
「N号通道」，不编地名。

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
| 首页卡数值位 | 今日吊重 1.87t、累计运行时间 2min、作业任务 1/3 | 塔机：工作循环汇总的吊重/吊次（编号见表 `src/data/craneSn.ts`，见第 13 节）；电梯：IOT 今日运行时长；**无人机：一格「今日作业次数」= 统计接口 `finishedCount`（已完成），没取到写「—」**；机器人：5/4/7/9/3 次，取自 V2 预制体 `UIView 装备管理一张图 / 底部栏 / 施工机器人栏` 的 `Value` 预置文本（见 `src/data/robotStats.ts`） |
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
| 监控点位 | 18 个写死点位名，`.map()` 把 img 全刷成同一张 `cam-crane2.webp` | `:8085` 报警 `channelNo` 去重 → 点位名取 `CAM_PLACE`（与详情页「报警地点」同源），没有映射的通道才叫 `N号通道` |
| 直播位 | 上面那张静态图（切点位画面不变） | 该通道最近一条报警的真实抓拍 base64；点播放明确 toast「实时视频流未开放」 |
| 抓拍视图 | `camShotPool` / `camShotTimes` 按「点位序号 + 日期」轮转，恒定 3 张 08:12/12:36/16:50 | 按「通道 + 真实日期」过滤报警，有几条显示几条；无记录的日期给明确空态 |
| 抓拍图 | 同一张 webp | `/api/video/alarms/{id}/picture` 的 `data.pictureData`，按需加载 + 缓存（首屏最多 6 张，单张约 1MB），登出清缓存 |
| 消息中心 | 2 条写死消息 + tabbar 硬编码角标 2 | 一条真实报警一条消息（最多列 20 条，角标按全部未读算），点开跳对应报警详情、按 `id` 记已读 |
| 人员分布 | 5 个手写区域 + 三栋楼各 5 层人数（`b*Occupied` 稀疏表） | `personCurLocation/v2` 的 `alive` 名单 → 场布图 / 2#住宅楼 / 地下室三场景，下钻到管控区可见**人员姓名**（2026-11-18） |
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
| `patrolCats`（六个手工分类） | `data/config.ts` | **2026-11-16 恢复**，但改成「航线名 → 六类」的显式映射（见 §四点二十五） |
| `airImgs` / `airTimes` / `airPos` | `data/config.ts` | 真实媒体按拍摄日期过滤 |
| `uavLive` / `uavTodayTasks` / `uavRoutes` / `uavChecks` | `data/device.ts` | keehang 任务 / 遥测 / 航线 |

「六个分类」删除是有意的：照片一到就不知道该归哪类，与其用假分类框住真照片，
不如按拍摄时间倒序铺开并标出「所属任务 + 时间」，让看的人自己判断。

### 4. 起飞条件改成三态（安全门）

~~遥测接口只给电量 / 电池温度 / 速度 / 高度 / 航向角，风速、雨量、网络速率
三项没有数据源。~~

**2026-11-13 15:00 更正：这个结论是错的。** 风、雨、网络一直都在接口里，
是我们的解析只取了 9 个字段：

| 指标 | 字段 | 在哪 |
|---|---|---|
| 风速 | `windSpeed` | **只取机库遥测 `/2`**（2026-11-16 起）。V2 弹层 `UIDronePop.cs:189` 就是 `txtWindSpeed.text = dockNet.wind_speed + "m/s"`，且其模型把 `wind_speed` 声明成 `int` → **整数显示，无小数**。机载 `/1` 也有 `windSpeed`，但那是机上气流计，实测同一时刻与机库差 0.5~1 m/s（机载 2 / 2.6 / 2.4，机库 2.6 / 2.2 / 1.6），V2 从不显示它 |
| 雨量 | `rainfall` | 机库遥测 `/2` |
| 网络质量 / 速率 | `networkQuality` / `networkRate` | 机库遥测 `/2` |
| 距机库 | `homeDistance` | 机载遥测 `/1` |
| 飞行距离（累计里程） | `totalFlightDistance` | 机载遥测 `/1`（V2 面板同名项） |
| 剩余续航 | `batteryInfo.remainFlightTime` | 机载遥测 `/1` |
| 累计架次 | `totalFlightSorties` | 机载遥测 `/1` |
| 翻滚角 | `attitudeRoll` | 机载遥测 `/1`（V2 面板「无人机翻滚角」，°） |
| 偏航角 | `attitudeHead` | 机载遥测 `/1`（V2 面板「无人机偏航角」，°；−180~180 原样收，**不归一化**到 0~360 —— V2 也不归一化，两边并排核对时同一方向不能出现两个数字） |

注意机库遥测的**类型段是 2**（`/telemetry/{机库id}/2`），用 1 查只会拿到一屏 null。

原版的 `uavChecks` 由写死的 `uavLive` 派生，五项永远全过。现在仍是三态
（`ok` 满足 / `bad` 明确不满足 / `unknown` 没有**可信**数据），
`canDispatch = checks.every(c => c.ok)` —— **有未知项也不放行**。

目前只剩雨量是 `unknown`，原因是**口径**未确认而不是没数据：实测 `rainfall=1`
而同日机库湿度 99%、天气阴，无法判断 1 是「有雨」还是「无雨」。所以既不改判定，
也不隐瞒 —— 原因里直接带原值（「机库雨量口径未确认（rainfall=1）」），
等厂家确认枚举含义后一行代码可改。

### 5. 航线下发：**没有** REST 端点，如实告知

实测 keehang 的 `/task/start`、`/task/exec/start`、`/task/control` 等一律 404。
原厂 Unity 端是打开网页控制台 `iot.keehang.com/dashboard/#/control?st={token}`
由那个页面下发。所以航线弹层**只读**：列出真实航线（实测本项目 15 条）、
显示选中那条的详情、给出平台地址，并明说「航线下发需在无人机平台操作，本页
不代为下发」。保留一个假的「已下发」toast 是在骗现场调度 —— 那条航线真的不会飞。

### 6. 实时视频流：无人机画面走 keehang 自建流媒体，不走萤石云

**2026-11-13 更正**：此前写「keehang 直播流需另一套鉴权且未验证」「萤石云凭据失效
所以没有画面」，两句都不对 —— **无人机画面压根不走萤石云**，是我没找到接口就下了结论。

真实链路（实测可用，当前正在出画面）：

```
GET /live/stream/list?deviceId=23498          ← keehang 业务服务
  → data[].streams[].playStreams[]            ← 按协议给了 6 个地址
  → type=flv & protocol=https                 ← 浏览器唯一能直接播的那个
  → https://live.keehang.com:8443/djiDock/{streamId}.live.flv
```

要点（都实测过）：

- 流是 **ZLMediaKit** 分发的（响应头 `Server: ZLMediaKit`），V2 桌面端拿同一路
  RTMP/RTSP 再经本地 mediamtx 转给 Unity；网页端直接用 HTTP-FLV。
- **不需要 token / 签名**，`Access-Control-Allow-Origin: *`，证书是 `*.keehang.com`
  正式 DV 证书（不用忽略校验）。所以浏览器侧连 `<video>` 都不必走自家后端代理。
- `?deviceId=` **必须带**：不带返回全平台 1197 组流、1.5MB；带上只有 1.2KB。
- `online` 是**当前是否在推流**：无人机飞行中 true；机库摄像头在库待机时 false
  （地址还在，连上去没有画面）。页面据此说「未开播」，不是干等。
- HLS 未开启（`/{app}/{stream}/hls.m3u8` 404），所以只能 FLV + `mpegts.js`；
  iOS 17 以前没有 MSE，那类浏览器给「不支持此直播格式」的明示。

> 顺带发现 keehang 业务服务**开着 Springdoc**：`GET /v3/api-docs` 直接吐 325 个
> 端点的 OpenAPI 定义（311KB，带全部参数与 schema）。整条直播链路就是这么找到的 ——
> 以后再缺接口，先看这份 spec，不要去猜路径。

### 6.1 无人机页与卡片（2026-11-13 15:00 按设计稿重排）

**首页卡只留一格「今日作业次数」**，值取统计接口的 `finishedCount`（已完成）——
用户 15:24 用截图指定：「V2 里展示的也是这个」（子页任务管理三格 15 / **11** / 0，
圈的是 11）。不用 `taskCount`（15）：那里面含 4 条还没飞的计划，是排班不是作业。
「设备状态 0/1」那一格同时撤掉 —— 台账登记态与「今天飞了几架次」无关，
两格并排还会被读成「1 架里 0 架在线」。在线与否由标题旁的状态点表达。

**子页四块照设计稿**，每块的数都有出处：

| 区块 | 设计稿 | 数据 |
|---|---|---|
| 实时监控 | 无人机 / 机库 两页签 + 画面 + 七格/五格 | **画面已接入**（HTTP-FLV，见 §6）：无人机页签＝机载画面 + 机载遥测（状态/海拔/飞行距离/水平速度/垂直速度/翻滚角/偏航角，后两格对齐 V2 详情面板）；机库页签＝机库摄像头 + 机库遥测（在库/充电/舱温/湿度/网络速率）。机库未推流时明说「机库画面未开播」，**不拿无人机画面顶替** |
| 任务管理 | 今日任务 / 已完成 / 失败次数 + 当前巡检进度（`62%` + 进度条 + 「已飞 X 分钟 · 预计 Y 分钟」） | `/dashboard/task/list/record` 的 `taskCount / finishedCount / failedCount`；**进度分母 = 同一 `taskId` 近 7 天已完成执行的时长中位数**（见下：服务端没有计划时长），`pct = (now − start) / 中位数`、封顶 99（还在执行中就不画成 100%）。中位数取不到时**不画条、不写预计**，只写已飞时长。三格与今日明细按 30s 慢档刷（`refreshSlow`），任务飞完不用退出子页 |
| 设备参数 | 状态/电量/距机库/续航/风速/网络质量/网络速率/电池温度 | 机载 + 机库遥测，**八格全部有源** |
| 任务下发 | **二期**，当前只有一句「接入中，敬请期待」 | 平台没有下发端点（keehang `/task/start` 404，原厂是网页控制台）。条件校验那套（`canDispatch / dispatchNote / risks`）留在 store 里给二期用，但**不摆 UI**：disabled 的「选择航线」看起来点得动，点了没反应会被当 bug |

三处口径要说清：

- **刷新节拍：机载 + 机库遥测同为 2s / 其余 30s**（`stores/uav.ts` 的 `LIVE_GAP` / `SLOW_GAP`）。
  V2 根本不轮询 —— `MqttDroneRealTimeInfoRequester` 连 broker `47.106.219.250:1883`
  订阅 `/prod/thing/product/{sn}/osd`，一条 OSD 到就刷界面，`droneOfflineTimeoutSeconds = 3`
  判离线，飞控 OSD 本身约 1Hz。浏览器接不了那层推送（broker 裸端口在 HTTPS 页面下被
  混合内容拦，Pages 更没有反代），只能轮询；2s 是最接近的近似 —— 实测服务端缓存就是
  秒级（每 2s 采样，翻滚角 / 水平速度 / 航向每次都在变）。2s 档**只拉飞机**
  （1.5KB/轮 ≈ 2.7MB/小时），页面不可见时整轮跳过。
- **机库读数（`/telemetry/23452/2`）跟机载同频，也在 2s 档**（2026-11-16 12:40 用户要求：
  「网络速度的刷新频率需要跟风速刷新频率一致」）。设备参数里 **风速 / 网络质量 / 网络速率
  三项都取自机库**（风速见上表，V2 面板也只打机库那份），早先机库只在 30s 档 → 同一屏
  风速 2 秒跳一次、网络速率半分钟才跳，看着像网络那格卡住了。两路同频后一起动。
  代价：机库那套从 120 次/小时变成 1800 次/小时（0.8KB × 1800 ≈ 1.4MB/h），
  同一个 `telemetryBusy` 门闩挡住并发（一轮没回来就跳过这一拍）。
  仍然要记住的事实：**V2 自身根本不轮询**，它是 OSD 推送（`network_state` / 湿度 / 雨量
  都在推送里，三元里源码全量 grep 无 `cache/telemetry`）；2s 是浏览器拿不到推送时的
  最接近近似，节拍对齐的是「同屏一致」，不是「跟 V2 的请求频率一致」。
- **姿态角**：`attitudeRoll` → 翻滚角、`attitudeHead` → 偏航角，一位小数 + °，
  对齐 V2 详情面板那两行。**不归一化到 0~360**：`attitudeHead` 是 −180~180，
  负值（实测 −93、−151）本身是合法航向，V2 也原样打；归一化会变成 267°/209°，
  同一方向两个数字，跟 V2 并排核对时互相打架。
- **「今日任务」数字与 V2 的差异：V2 取数时漏了 `pid`**（2026-11-16 更正，详见本文
  后面「MQTT 不是万能的」一节）。早先记的「两边不是同一个后端」是误判 —— 向阳村现场那台
  V2 的进程只连 `iot.keehang.com`（`110.41.50.115:23443`）和塔机 broker，没有连
  `47.106.219.250`（那是三元里的），也没有任何无人机 MQTT 连接。
  真正的差异就一个参数：`/dashboard/task/list/record` 不带 `pid` → `taskCount 23`
  （向阳村 15 + **光谷元著 8**），带 `pid` → 15。本项目照 V2 取（不传 `pid`），
  明细也一并放开到账号口径（`fetchTodayRecords`），23 = 15 + 8 逐条对得上。
- **状态**：**以机载遥测 `modeCode` 为主**（DJI `mode_code`：0 待机 … 18 空中 RTK 收敛），
  `status` 只在 `modeCode` 缺失时兜底 —— 映射表在 `utils/uavState.ts`。
  为什么主次是这样（2026-11-13 17:07 实测）：飞机从 69m 自动降落回库再落定，
  `verticalSpeed -3.9`、`relativeAltitude 69.3` 都在动，**`status` 全程恒为 1**，
  而 `modeCode` 走完 `10 自动降落 → 0 待机`。以 `status` 为主就会永远写「起飞准备」，
  与 V2 同一时刻的「航线飞行 / 待机」对不上 —— 用户截图就是这么发现的。
  结论：keehang 的 `status` 是**设备状态**（1 = 在线正常、-1 = 飞控未上报），
  不是飞行模式。
  **`-1` 不在枚举里**：库里断电时 `status:-1` + `modeCode:14`（实测电量 88%、
  `gear:1`），V2 在这个组合上显示红字「关机」，我们也照做；但 `status` 缺失、
  只有 `modeCode:14` 时只说「未连接」—— 缺数据不等于断电。
  ⚠️ 之前写的是「有执行中的任务 → 作业中，否则停泊」，那是拿任务状态冒充飞机状态
  （任务排了没飞、飞着却没任务都会错），用户拿 V2 一比就对不上，已撤。
- **飞行距离**：取 `totalFlightDistance`（**累计里程**，实测 10809054.8m ≈ 10809km / 3070 架次），
  与 V2 面板「飞行距离」同一字段。**别与 `homeDistance` 混用** —— 后者是「此刻距起飞点」
  （飞机停在库里时 0.0136m），两者差 7~8 个数量级。之前那格标签写「距起飞点」、
  值取 `homeDistance`（162m），按 V2 心智会被读成「里程丢了」，已改。
- **剩余续航**：`remainFlightTime` 在地面恒为 0（实测：库里关机、电量 80% 时该字段 0；
  起飞后同一字段给 1753s），与「电池真的只剩 0 分钟」区分不开，所以 0 显示「—」
  （电量格另有真数），不写「0分」吓人。**地面/关机时在设备参数块下补一行小字**
  说明「取飞控剩余飞行时间，地面为 0，起飞后自动有值」—— 否则用户会以为这格没接数据。
  飞机飞行中该字段自动变真值，说明行同时收起来。
  **V2 面板里其实没有「续航」这一格**（取证见下），这一格是设计稿加的。
- **网络质量**：画成**五格递增信号**，亮几格由**网络速率**分档（≥800 满格 / ≥500 四格 /
  ≥300 三格 / ≥100 两格 / 其余一格），颜色只有「够用（绿）/ 不够（红）」两级。
  为什么不用厂家的 `networkQuality`：机库遥测里这个字段实测**长期恒为 1**
  （连采 5 次，速率从 9kbps 走到 897kbps 它一步没动），画出来是死的；
  V2 底部栏那排格子是跟着速率一起变的。档位是本项目的展示分档，不冒充厂家等级。
  取不到 / 0 → 「—」，**不画五条空条**（会读成「有信号但一格都没满」）。
  **起飞校验里那项「网络」同样看速率**（≥500kbps），两者现在同源。
- **当前巡检进度**（`62%` + 进度条 + 「已飞 X 分钟 · 预计 Y 分钟」）：
  分母**不是**服务端给的 —— 服务端没有「计划时长」这个字段，全项目找过一遍：
  排班 `/task/list` 的 `schedule` 只有触发时刻（这台机是 09:45 / 13:20 / 15:00 / 17:45），
  执行记录里执行中那条 `end` 是 `null`，航线 kmz 只有航点坐标。
  所以分母取**同一 `taskId` 近 7 天已完成执行的时长中位数**（`utils/uavProgress.ts`，
  一次 7 天实测 114 行 / 32KB，6 小时复用）。中位数而非平均数：现场偶尔有一次跑成 20 分钟
  （中途等待/重试），平均数会被拽偏。安全巡检近 7 天 28 次里 24 次都是 11 分钟，中位数落 11，
  今天 17:45 那趟跑到 17:49 就是 36%。
  **没有任何完整执行的任务不画条、不写「预计」**，只写已飞时长 —— 宁可少一格，
  也不拿排班间隔或 0 凑一个百分比；`pct` 封顶 99，还在「执行中」时不画成 100%。

另外修掉一个会让「今日任务」永远为 0 的坑：`/task/exec/list/record` 不带日期时
按开始时间**升序**返回（`page=1` 拿到的是 2026-07-14 那几条），本地再按今天过滤
就是 0 条。现在带 `start=今天&end=明天`（`end` 不含当天），并保留一道本地过滤
防边界差异。`size` 参数不生效（该区间有多少回多少），别拿它做分页。
记录 id 是 int64，个别行超过 JS 安全整数，列表 key 改用 `uuid`。

#### V2 无人机面板的取证（2026-11-13 16:00）

资源清单 `http://120.26.34.95:9689/CDN/PC/v1.0/DefaultPackage_2026-11-10-512.json` 的
`AssetList[].BundleID → BundleList[].FileHash` 能直接定位预制体；
`UIView 无人机` 在 `6bc3a417fecd6948b4c564f3c748c9f4.bundle`（161 KB）。
UnityPy 读出来的 `UIDroneBottomBar` 绑定字段只有这些：

```
txtStatus  txtWindSpeed  txtLensType  txtLensMode  txtZoomFactor
txtGimbalPitch / txtGimbalYaw / txtGimbalRoll
txtLTE  txtRC  txtTemperature  txtVatteryVoltage  txtBatteryPercent
txtPhotoCount  txtVideoLength  txtStorafe
```

三点结论：
① **没有「续航」字段**，设计稿那一格在 V2 里没有对应概念；
② 网络质量在 V2 是 `signalSprites`（四个 sprite，不写文字），这就是本项目改成信号格的依据；
③ 「预计可拍照 / 预计可录像」紧挨着 `txtStorafe`，是**存储**容量换算，不是电池续航 ——
缺原厂码率常数，接了就是编数，所以不做。

### 7. 巡检照片：列表用缩略图，点开才取原图

真实 DJI 原图单张 5~8MB（实测 5 378 048 字节）。媒体接口 `GET /media/task/job/{id}`
**同时返回 `thumbnail`**（`oss.keehang.com:19090/thumbnail/iot/...`，实测约 440KB）。

所以列表用缩略图 + `loading="lazy"`（滚动到才加载），点开大图才请求原图
（用户主动行为，走 `utils/albumSave.ts` 的预转机制）。缩略图缺失（刚飞完还没生成）
或加载失败时回退成「点击查看原图 · 体积」的文字占位，不留破图。

> 2026-11-16 之前这里写的是「列表**不**自动加载缩略图」，因为当时只解析了 `url`。
> 实测 153 张里 129 张有缩略图，值得接。

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
| tsdb 查询 | `{"status":10,"msg":"部分产品数据您无权查看，非法的产品列表为：P000000076"}`（去掉 productCode 同样报非法，只有空 `queryList` 才回「查询条件为空」）—— 是**产品白名单**问题。注意别跟 `status:11` 混：11 是令牌无效（HTTP 401），不是权限，见四点十四·6 |

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
| 今日吊重 | 当天循环 `weight` 累加（t，两位小数） | 「—」仅限「没查到 / 无 sn」（`craneDayBySn` 里没这台）；查询成功但当天无带重量循环 → **`0.00t`**（用户 2026-11-13 要求，与首页智控卡同口径） |
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
  1. 设计稿的「平均利用率 / 负荷」两格换成**作业时长 / 峰值吊重** —— 见下面
     「利用率与负荷的取证」，两个指标都算不出可信值；
  2. 机队表列 `塔机 / 吊次 / 吊重 / 峰值 / 时长`，结论条 `关注 / 主力 / 产出 /
     峰值 / 缺数`。

**利用率与负荷的取证（2026-11-12 18:3x，全部来自 `HotUpdateScripts.dll`）**：

设计稿报表页确有这两列（`gx2.js:2282` 表头 `塔机/吊次/吊重/利用率/负荷`、
`2333` KPI「平均利用率」、`2313/2323` 结论「关注·利用率最低」「负荷·最高」），
但那是**演示数据**：`craneChartSeries()`（`gx2.js:1951`）读的是 `u.history[].util`
与 `u.history[].avgRate` 这种写死的数组，再 `clamp` 到 8~96 造出平滑曲线，
整个设计稿没有一条接口取这两个值。

V2 侧逐条排除：

| 位置 | 证据 | 结论 |
|---|---|---|
| 报表明细行 | `ItemCraneHistory.InitInfo`（IL 249 字节）只绑 8 个字段：`txtCount/txtTime/txtDuration/txtType/txtWeight{0:F2}t/txtHeight{0:F1}m-{1:F1}m/txtAngle/txtMaxTorque` | **没有利用率和负荷** |
| 报表图表 | `UICraneHistoryPop.RefreshChart` 只 `AddData` 两条序列：`ldstr '吊次'`、`ldstr '吊重'` | 同上 |
| 全程序集字符串 | `利用率` `负荷` `负荷率` `台班` `效率` `平均` 在 `#US` 堆里出现 **0 次**＝0 次 | V2 代码层根本没有这两个概念 |
| 负荷的实时值 | 塔机卡 `UIBottomCardCraneLv2` 第四格「当前负荷 X%」取报文 `weightRate`；而 `weightRate` 在 `#Strings` 堆仅出现 1 次（纯字段名），配套没有 `ratedTorque/ratedWeight/maxLoad` | V2 **原样透传设备上报的百分比**，自己不按额定力矩换算 |

也就是说：**「负荷」只有瞬时值（已有，就是我们卡片上那个 `weightRate`），没有历史/平均**；
**「利用率」在 V2 里完全不存在**。`工时` 那 3 次命中的是人员效能枚举
（`WORKEFFICT_ATTENDANCE` 考勤工时比对 / `WORKEFFICT_CHAIN_RATIO` 工时环比），与塔机无关。

数据够不够自己算？

- **利用率** = Σ`duration` ÷ 台班时长。`duration` 接口有（秒），但**台班定义没有任何
  权威来源**（V2 无、台账无、平台无），填 8h 就是我们自己编口径。
- **负荷率** = `maxTorque` ÷ 额定起重力矩。`maxTorque` 接口有，单位 t·m
  （实测验算：0.61t × 23.32m = 14.2 ≈ 记录里的 `maxTorque: 14.23`），
  但**台账没有型号、没有额定起重力矩**（`extra_fields` 只有高度/安检/质检/司机/功效），
  换算不出百分比。

**本项目结论（2026-11-12，按「V2 怎么算就怎么算」定）**：报表页**不补**利用率和负荷率，
与 V2 `UICraneHistoryPop` 保持一致 —— V2 报表能算的只有「吊次 / 吊重 / 作业时长 / 单次峰值」，
我们这四样都在。设计稿那两列是演示造数，不作为实现依据。
**唯一的例外是实时「当前负荷」**：V2 塔机卡有（报文 `weightRate` 透传），
我们也已经在 5G塔机卡第四格显示，那个不受本结论影响。

> V2 报表明细行里还有一列我们暂未展示：`txtMaxTorque`（最大力矩，`{0:F1}`，单位 t·m，
> 实测 = 吊重 × 幅度）。它属于「单次循环明细」维度，而本项目报表是「逐台横向对比」，
> 两者不冲突 —— 将来要做「点进一台车看循环列表」时可直接取，原始报文里已经有这个字段
> （`toWorkCycles` 目前没有解析它，因为现在没有消费方）。

**实测（2026-11-12 18:0x，真机 Chrome + 现场账号）**：

```
日报 2026-11-12   22次 / 9.95t / 5.4h
  智能塔机2 20次 8.72t 峰值2.38t 5.3h ｜ 智能塔机3 0次 — — — ｜ 智能塔机4 2次 1.23t 0.67t 4分
  传统塔机5 全「—」（无平台编号，结论里单列一条「未纳入统计」）
周报 2026-11-09 至 11-15   131次 / 92.62t / 33.9h
月报 2026-11-01 至 11-30   413次 / 324.16t / 83.1h
```

电梯的报表仍不接入：升降次数/运行时长的源是 IOT `EVENT_WORKDATA`，当时测到
`status:11` 就停下了 —— 后来查明那是**令牌失效**（不是没权限），见四点十四·6。
接口本身是通的，口径也已定：**与 V2 一致，首尾跨度**（2026-11-13 决定，
见四点十四·4）。接报表时直接复用 `sumWork`，别在报表里另写一套算法 ——
同一份 `EVENT_WORKDATA` 在两个页面出两个数，比口径不纯糟得多。

**遗留观察**：服务端偶发单条循环 `duration` 异常大（近 30 天里出现过 33014s ≈ 9h
的一条），会直接抬高「作业时长」合计。这是平台原始数据，未做截断 —— 现场确认是
记录未闭合还是真连班后，再决定要不要过滤。

---

## 四点十二、首页切换标签即刷新（2026-11-13）

**诉求**：点首页的「智巡 / 智眸 / 智控」切换时，对应面板的接口要重新请求。

**为什么之前不刷新**：三个面板确实会重新挂载（`HomeSheet` 的 `.home-panels` 带
`:key="home.homeMod"`，切标签就是真卸载再挂载），但各面板 `onMounted` 里调的是
`load()` —— 那套「已经 ok 就跳过」的缓存本来是为了「首屏别重复打」，结果切回来
也一并不打了。

**改法**：每个数据源加一个 `refresh()`，语义是「已有数据也重拉，但**失败冷却仍生效**」：

| store | refresh 行为 |
|---|---|
| `overview` | 失败且 60s 内 → 停；否则 `load(true)` |
| `alarm` | `syncFromVideo(token, true)`，失败冷却同一套 |
| `patrol` | `load(true)`，失败 60s 内 → 停 |
| `deviceLedger` | `load(token, true)`，连带重跑 `loadCraneDay`（今日吊次/吊重） |
| `scaffold` | `load(true)`，失败 60s 内 → 停（仍不轮询） |

要区分 `refresh()` 与 `load(true)`：后者给页面上的「重试」按钮，**无条件**绕过
冷却；前者给「切标签」这种人会连点的高频动作，冷却期内直接不发请求。

**连带修的一处**：`deviceLedger.hasData` / `scaffold.hasData` 原本要求
`state === 'ok' && 有数据`。刷新时 `load` 一进来就把 state 置成 `loading`，
于是切回面板那一帧卡片会整块被骨架顶掉、再闪回来。改成**只看有没有数据**
（失败分支本来就清空数据），刷新就是原位替换。

---

## 四点十三、首页塔机「在线设备」改读实时四态（2026-11-13）

**诉求**：智控面板 5G塔机卡那格 `4/4` 要变成「在线设备数 / 台数」，其中在线设备数
**按子页面（5G塔机详情页）的口径**读 —— 那边状态取自 V2 `CraneModel.GetTowerState`
四态（离线 / 待机 / 工作中 / 正在吊装），只有「离线」不算在线。

**为什么两处会不一致**：首页原来数的是台账 `online_status`，而台账对 4 台塔机全报
`online_status=1`；但传统塔机5 **没有平台编号**（`data/craneSn.ts` 里 `deviceSn` 是空的），
它不在实时推送列表里，子页面 `stateOf(null)` 恒返回「离线」。于是首页写 4/4、
点进去只有 3 台非离线。

**改法**（`views/home/EquipPanel.vue`）：

- 面板在**已登录**时 `crane.open()`、卸载时 `crane.close()`（store 自带引用计数，
  与详情页共用同一条连接，不会重复连）；未登录时卡片是登录引导，不订阅。
- 新增 `countOf(d)`：塔机逐台 `crane.stateOf(craneSnOf(unitNo(name)))`，
  **非「离线」即算在线**；`stateOf` 返回 `null`（通道判断不了，线上 HTTPS 没有 WS 反代）
  时回落台账 `online_status` —— 不把「我们看不到」写成「设备离线」。
  其余三类设备仍走 `home.equipCount`。
- 分母恒为**台账里的台数**（现场 4 台，含没有编号的传统塔机5），不是写死的 4：
  台账多一台，分母跟着变。
- 顶部统计卡的「在线 / 离线」、卡片标题的状态点、aria-label 全部改用 `countOf`，
  避免出现「卡片 3/4、顶部 13 在线」这种同页两个数打架。

**连带**：塔机详情页（`views/sub/DevicePage.vue`）的「今日吊重」在**查询成功但当天
没有任何带重量的循环**时改显示 `0.00t`（用户 2026-11-13 要求，`day.weight === null`
就是这种情况）；**没查到 / 没有平台编号**（`craneDayBySn` 里没有这台）仍是「—」——
「今天没吊」是结论，横杠只留给「没数据源」。

#### (16) V2 塔机弹层的「告警信息」块：没有接数据，本项目暂不迁移

用户 2026-11-13 要求把 V2 塔机弹层红框里的「告警信息 / 当前无报警 / 查看详情」
搬过来。挖完之后**没有做** —— 因为它没有任何数据链路，照搬等于在界面上永久写一句
「当前无报警」，而现场真超载时它也会这么写。四条独立取证：

**① 脚本层没有落脚点。** `UIPanelCrane` 的全部字段只有
`txtName / txtStatus / txtID / txtHeight / txtRotate / txtRange / txtRopeHeight /
txtTime / txtSafetyInspectionValidity / txtQualityInspectionStatus /
txtTowerCraneDriver / txtEfficiency / curData`，没有任何告警字段；基类
`UIPopUpBase` 只有 `btnClose`。`InitPanelWithData` 的 IL 里也只给 `btnClose`
挂了监听。热更程序集里没有「塔机告警」类，`ldstr` 全扫也搜不到
「告警信息 / 当前无报警 / 查看详情」—— 说明那三句是预制体里的静态文本。

**② 预制体层证明它是死的。** 预制体在
`assets_hotupdateresources_prefabs_ui_塔机.bundle`（406,447 B，FileHash
`5fa13e327b522b69d23687213690a7b9`）里，UnityPy 读出三个节点：

| 节点 | 组件 | 说明 |
|---|---|---|
| `告警信息` | TextMeshProUGUI | 小标题 |
| `AlarmStatus` | TextMeshProUGUI（文本 `当前无报警`）+ ContentSizeFitter | **没有任何脚本挂载** |
| `Btn` | TextMeshProUGUI（文本 `查看详情`）+ Button | `m_OnClick.m_PersistentCalls.m_Calls` = **空数组** |

再把整包 3590 个对象扫一遍「谁引用了这三个节点」：命中 5 条，全是节点自身组件的
`m_GameObject` 反向引用，**没有任何脚本字段指向它们**。结论：这段 UI 永远是预制体
里那三行字，运行时既不更新文本，按钮也没绑回调。

**③ 接口层没有告警源。** V2 里出现的全部 URL 只有登录、`/api/data/*`、
`/api/video/alarms`、IOT 的 `queryEvent` / `queryRealTimeDataV2`、萤石云、
`getWorkCycleInfoHis`、讯飞语音 —— 没有塔机告警路由。另在
`tciccs.cscec3bxjy.cn:30400` 试了 7 个候选路径（`getAlarmInfoHis` / `getAlarmInfo` /
`getAlarmList` / `queryAlarmInfoHis` / `getAlarmDataHis` / `pushAlarmInfo` /
`getWarnInfoHis`），**全部 404 `No handler found`**。IOT `queryEvent` 的事件码只有
`EVENT_ON_OFF / EVENT_POST_ATTR / EVENT_WORKDATA`，没有告警事件码，且本账号
`status:11 权限不足`。

**④ 实时报文里也没有。** MQTT 一帧的键是
`angle / backArmLength / bodyHeight / craneType / deviceName / deviceSn /
frontArmLength / hasLoadInfo / height / markHeight / moment / monitorDateTime /
name / obliguity / range / safeWeight / siteName / topHeight / weight /
weightRate / windSpeed` —— 21 个，无告警/越限字段。

**将来要接需要什么**：塔机平台开放告警查询接口，或 IOT 开通告警事件码权限。
两者任一到位后，弹层加一段「告警信息」按 `sn` 查即可（结构照 V2：
标题 + 一句状态 + 右侧「查看详情」跳报警预警），布局不用重新设计。

**顺带留下重挖入口**（这次新打通的路径）：V2 的 YooAsset 资源可以直接从
`http://120.26.34.95:9689/CDN/PC/v1.0/` 取，目录列表可浏览；
`DefaultPackage_<PackageVersion>.json` 就是资源清单（`AssetList[].BundleID` →
`BundleList[].FileHash`），按 `<FileHash>.bundle` 下载后 UnityPy 直读，
不必再猜 bundle 名。

---

## 四点十四、智能电梯接通 IOT 网关（2026-11-13）

**诉求**：照设计稿 gx2 的智能电梯卡（`在线 x/y` + `累计运行时间`）补齐首页那一格，
并把 V2 `UIPanelElevator` 弹层里的字段搬进本项目「设备信息」。

### 1. 电梯在网关里是**另一个产品**，不是项目码

这一条卡了很久。塔机 / 大屏 / 报警全用项目码 `P000000076`（= `SCENE_CODE`），
但电梯在 IOT 网关里注册成独立产品：

```
产品码  01724121a94f4893b693f253173d1082     ← V2 ElevatorIotModel.ProductCode 常量
```

拿 `P000000076` 查电梯会得到
`{"status":10,"msg":"部分产品数据您无权查看，非法的产品列表为：P000000076"}` ——
读起来像「没权限」，其实是查错了产品。换成电梯码后 `status:0` 且有数据。

### 2. 4 个轿厢 sn 从 V2 场景包里挖出来（台账里没有）

`:8084` 的设备台账**没有序列号字段**（塔机那轮已经踩过一次），电梯台账只有
2 行（按楼登记：智能电梯1 / 智能电梯2）。实时数据却是**按轿厢**上报的 4 个 sn，
来自 V2 场景包 `cb4440f68c48489259d528982c1d7320.bundle` 里的
`BuildingElevator.sn` / `BuildingElevatorCage` 序列化字段。已登记在
`src/data/liftSn.ts`：

| sn | V2 friendlyName | 所属台账楼 |
|---|---|---|
| `3225122202` | 智能电梯1-1 | 1 |
| `32251222021` | 智能电梯1-2 | 1 |
| `32251222023` | 智能电梯2-1 | 2 |
| `E03C1CB9F5011824` | 智能电梯2-2 | 2 |

所以本项目：**卡片按轿厢出 4 张**（与 V2 `UIViewElevatorLevel1.InitCards` 一致），
档案字段仍按楼取台账行。首页「在线 x/4」的分母也是 4（用户 2026-11-13 确认按 4 台）。

### 3. 三份数据、三个事件码

| 用途 | 接口 | 关键参数 |
|---|---|---|
| 在线状态 | `POST /api/data/v1/tsdb/queryRealTimeDataV2` | `field:'online'`, `code:'EVENT_ON_OFF'`，值是 **`"true"/"false"` 字符串** |
| 当前工况 | `POST /api/data/v1/tsdb/queryEvent` | `eventCode:'EVENT_POST_ATTR'`，带 `relFloor / height / load / numberOfPeople / runningState / speed` |
| 今日升降 + 运行时长 | 同上 | `eventCode:'EVENT_WORKDATA'`，每次升降一条，带 `runStartTime / runEndTime / driverName` |

响应行格式 `{timestamp, metricIndex:"productCode~sn~eventCode", value?, resultMap?}`，
用 `snOfMetric()` 取第 2 段把行分回设备。**值全在 `resultMap` 里**，原来的
`toPoints()` 会把它压掉（`value` 对事件恒为 null），所以 `api/iot.ts` 另开了
`fetchEventRows` / `fetchRealtimeRows` 两个保留原始结构的入口。

CORS 实测完全放行（`Access-Control-Allow-Origin` 回显、允许 `x-app-user` 头），
线上 GitHub Pages 也能直连，不需要代理。

### 4. 「累计运行时间」接口**没有**这个字段，是客户端算的

这是用户 2026-11-13 直接问过的一点，结论要写清：

- 接口只回**明细**（每次升降的 `runStartTime` / `runEndTime`），**没有任何汇总字段**。
- V2 在 `ElevatorRequester.<FetchWorkCycleAsync>d__9` 里自己算（IL 实证）：

```csharp
int count = data.Count;
float hours = 0f;
var start = data[0].ResultMap?.RunStartTime;          // 第一条
var end   = data[data.Count - 1].ResultMap?.RunEndTime; // 最后一条
if (DateTime.TryParse(start, out var t0) && DateTime.TryParse(end, out var t1))
    hours = (float)(t1 - t0).TotalHours;               // 首尾跨度
SetWorkCycleData(sn, count, hours);
// 无数据时 SetWorkCycleData(sn, 0, 0f)
```

- 本项目**沿用同一接口、同一个算法（首尾跨度）**。2026-11-13 曾一度改成逐条
  `end - start` 累加（理由是「运行时间」不该含停机），但现场要拿两个系统对账：
  同一天 78 条循环，V2 面板显示 **6.1h**、累加只有 **1.3h**，差 4.8 小时全是停机。
  数字对不上比口径不纯更难受，**用户当日决定与 V2 完全一致**。
  - 实现：`src/utils/lift.ts` 的 `sumWork`（文件头有 IL 原文与取舍说明）；
  - ~~界面上那一格带「含停机」小注~~：加过又被用户去掉（当天下午）。弹层是与
    V2 并排对照着看的，V2 那格只有数字，多两个字反而显得两边不一样。弹层里
    **不标任何口径小注**，`.dev-info-note` 样式与 `Row` 的第三项一并删除；
  - 保留一处改良：V2 在 `Data[count-1].RunEndTime` 为空（最后一条还没跑完）时
    整个分支跳过、`hours` 保持 0，会把攒了一天的值打成 `0h`。这里退到「最后一个
    有效的结束时间」，数据完整时结果与 V2 逐字节相同。
- 顺带修掉 V2 的一个语义损失：V2 无数据时写 `(0, 0)`，界面上「今天没跑」与
  「没取到数」都是 `0.0h / 0次`；本项目无事件时不给值，页面显示「—」。

### 5. 电梯弹层八行（`UIPanelElevator` IL 逐行读出）

`ShowPanel` 的调用顺序是 `txtName = GetDisplayName(sn)` → `ClearPanelData()`（全部 `--`）
→ `txtSn = sn` → `UpdateOnlineState` → `UpdateRealtimeInfo` → `UpdateTodayWorkData`，
字段与格式化如下：

| 控件 | 内容 | 格式化（IL） |
|---|---|---|
| `txtStatus` | 状态 | `IsOnline == false` → **离线**；否则 `RunningState` 1→**停止** / 2→**上升** / 3→**下降** / 其余→**在线** |
| `txtSn` | 升降机编号 | sn 原文 |
| `txtRelFloor` | 相对楼层 | `RelFloor.ToString() + "F"`（`-1` 时 V2 给 `--`） |
| `txtHeight` | 高度 | `F1` + `m` |
| `txtLoad` | 载重 | `F1` + **`kg`**（不是吨） |
| `txtNumberOfPeople` | 人数 | 整数 + `人` |
| `txtTodayRuntimeHours` | 今日运行时长 | `F1` + `h` |
| `txtTodayLiftCount` | 今日升降次数 | 整数 + `次` |

弹层两段：**基本信息**（当前状态 / 升降机编号）+ **实时工况信息**（相对楼层 / 高度 /
载重 / 人数 / 今日运行时长 / 今日升降次数）。格式化函数统一在 `src/utils/lift.ts`
（`stateText` / `formatFloor` / `formatHeight` / `formatLoad` / `formatPeople` /
`formatHours` / `formatTrips`），卡片与弹层共用一份 —— 同一帧读数不该有两种写法。

电梯弹层按**轿厢**打开：`SheetView` 同时带 `id`（台账主键，取档案）和 `sn`
（取这一笼的读数）。少了 sn 会把 1-1 的楼层显示成 1-2 的（取「最新的那一帧」）。

### 6. 更正：「status:11 权限不足」不是没权限，是**令牌失效**（当日二次取证）

这一节初版写的是「服务端收回了这个 ak 对电梯产品的数据权限」。**那个结论是错的。**
半小时后用完全相同的参数再查，数据又回来了。逐项复测后定位到真因：

| 探测 | 返回 |
|---|---|
| 不带 `X-APP-USER` 头 | HTTP **401** + `{"status":11,"msg":"权限不足"}` |
| 空令牌 | 同上 |
| 随机 32 位串 | 同上 |
| 当前有效令牌 | HTTP 200 + `status:0` + 数据 |

也就是说 **`status:11` 的文案是「权限不足」，但它的 HTTP 码是 401，含义是「令牌无效」**。
而令牌会在 `expireTs`（172800s = 48h）**之前**被服务端轮换：10:15 换到的是
`f3ab7b03…`，10:35 再换变成 `30b97c31…`，旧的那个此时已经不能用。

这里埋着一个真 bug：`iotAuthPost` 只在 `err.code === 401 || 403` 时清令牌重换，
而 `iotJson` 抛的是 `ApiError(status=11)` —— 判据对不上，**一次令牌轮换就让整个
会话卡死在「权限不足」，只能刷新页面才恢复**。现在 `iotJson` 把 `401` 与
`status === 11` 统一规整成 `ApiError(401)`，自愈分支才真正生效。

顺带排除的两种猜测：

- **不是并发限流**：连续 24 个并发请求全部 `status:0`；
- **不是多客户端顶号**：同一 ak 连换 3 次 token 返回的是**同一个值**（服务端幂等）。

另附：4 个轿厢编号在网关侧并不等价，逐个单独查 `queryEvent` 的结果是

| sn | 结果 |
|---|---|
| `3225122202` | 正常返回（1# 楼主笼，唯一持续上报的一台） |
| `E03C1CB9F5011824` | `status:0` 空数组（认这台；最后一次在线是 10-21 的 `false`） |
| `32251222021` | `status:10 所选设备您无权操作`（网关不认这个编号） |
| `32251222023` | 同上 |

后两个是场景包 `sn` 字段的字面值（长度 11，不是解析错位）。**混批查询时服务端会
静默跳过它们**（200，只返回有数据那台的行），所以不会拖累 1-1；只有单独查一个
无效 sn 才回 `status:10`。

#### 第三轮更正：页面全横杠的主因是 **CORS**，不是令牌（同日 11:00 取证）

用户反馈「V2 有数据、页面四格全 —、点了重试也没用」。逐层排查后确认：
**换令牌那个接口没有配置 CORS**，浏览器里连请求都发不出去。这才是主因。

| 接口 | 预检 `OPTIONS` | 响应 `Access-Control-Allow-Origin` | 浏览器能直连 |
|---|---|---|---|
| `/api/data/v1/tsdb/*`（查数据） | 200，放行 `content-type`、`x-app-user` | 有（回显 origin）+ `allow-credentials: true` | **能** |
| `/api/webgateway/v1/access/token` | **403，无任何 CORS 头** | **无** | **不能** |

浏览器发这个 POST 必带 `Content-Type: application/json` → 必触发预检 → 预检 403 →
请求根本出不去，`fetch` 抛 `TypeError`。于是 `ensureToken()` 永远失败，三个取数
函数统统 null，页面全「—」**且不出现任何提示条**（提示只认 401，而这里连 HTTP
状态码都拿不到）。

**这解释了三个看似矛盾的现象**：curl/node 能查到数据（不执行同源策略）、V2 有数据
（Unity 原生 socket）、浏览器全横杠（被同源策略拦在预检）。

试过且不通的路，别再试：

- `Content-Type: text/plain` / `x-www-form-urlencoded` 绕预检 → 服务端 **415**，
  该接口只吃 `application/json`
- 换 Origin 求进白名单 → `localhost` / `127.0.0.1` / `*.github.io` / `null` 全部 403
- `mode: 'no-cors'` → 请求能发出，但响应是 opaque，读不到 token
- 鉴权头并没有漏：V2 `ElevatorIotModel.GetAuthHeader` 只返回 `{tokenKey: tokenValue}`
  这一项，就是我们发的 `X-APP-USER`

**唯一解法是同源反代**，已按 `/crane-api` 的现成模式落地：`vite.config.ts` 的
`iotProxy()`（dev/preview）+ `server/serve.mjs` 的同名路由，前缀 `/iot-api`。
**只代理换令牌这一跳** —— 数据接口 CORS 是好的，几百 KB 的工况帧不必绕一圈。

⚠️ 部署前提：GitHub Pages 是纯静态托管，没有这层反代，那种部署下电梯数据拿不到，
除非原厂给 token 接口补上 CORS。可用 `VITE_IOT_TOKEN_BASE` 指向别的可用反代。
改 `vite.config.ts` 后**必须重启 dev server**，中间件在启动时注册，HMR 不生效。

⚠️ 自己用 nginx / 任何静态 HTTP 服务部署时，**必须补上同一段反代**：

```nginx
location /iot-api/ {
  proxy_pass https://iot.cscec3b-iti.com/;
  proxy_set_header Host iot.cscec3b-iti.com;
  proxy_ssl_server_name on;
  proxy_read_timeout 25s;
}
```

漏了它的表现极具误导性：换令牌请求命中 nginx 的 404（或被 SPA 回退吐回
`index.html`，JSON 解析失败），`ensureToken()` 报错 → 三个取数接口全部返回
`null` → **电梯每一格都是「—」，而且没有任何报错**。这与「电梯今天没数据」
长得一模一样，现场只能靠猜。所以 2026-11-13 补了一条独立状态：
`api/iot.ts` 的 `iotTokenUnreachable()` 记录「换令牌这一跳没打通」，
`api/lift.ts` 的 `liftGatewayUnreachable()` 把它与 401 分开，
设备详情页据此显示警示条「电梯网关没连上 —— 部署环境缺「/iot-api」反代，
或服务器无法出网」。**看到这条提示就去查部署，点「重试」不会好。**
（`server/serve.mjs` 已内置这层反代，`npm run deploy:http` 不必额外配置。）


#### 第四轮：令牌「出厂即为废票」，重试也救不回

反代通了之后仍拿不到数据，进一步实测：

- 11:04 通过 `access/token` 拿到 `0dfb9634…`，**当时可用**（查回 658 条工况帧）；
- 11:14 同一张令牌 → **401 + `status:11`**，而 `expireTs` 声称 48 小时；
- 再调 `access/token`，服务端**幂等返回同一张已失效的令牌**（加 `nonce` / `timestamp` /
  `refresh` / `forceNew` 字段都一样），于是形成死锁：换到手就是坏的；
- `logout`（`/api/webgateway/v1/auth/api/appUser/logout`）用坏令牌调也是 401，无法自清；
- 服务端大约每 20–30 分钟才轮换出新值（10:15 `f3ab7b03` → 10:35 `30b97c31` →
  11:04 `0dfb9634`）。**这是服务端的状态问题，客户端无法自救。**

借这一轮把客户端两个真 bug 修了：

1. **`refreshToken()` 不能判「未过期就复用」**。它的调用前提就是「这张刚被判 401」，
   判有效期等于把坏令牌原样再交一次 —— 这正是「点重试没用」的直接原因。
2. **401 自愈要限频**。V2 程序集里有 `LoginCooldownSeconds` 常量，说明它对重新登录
   是限频的。我们一轮 12 个请求（3 接口 × 4 台）同时 401 时，若各自去换令牌就是
   12 次登录请求，只会把网关刷得更死。现在并发共享同一次换牌、失败后 60s 冷却，
   只有用户显式点「重试」（`clearToken()`）才跳过冷却。

另：提示条从「重新登录」改成「重试」。**登录换不到 IOT 令牌** —— 登录页登的是
`:8081` 业务账号（`xiangyangcun`），电梯用的是 IOT 云网关的项目级 ak/sk，两套凭证
不同源。之前让用户去登录，登完回来提示还在，反而像登录没生效。

#### 第五轮：服务端已轮换，数据恢复（同日 11:44 复测）

第四轮的死锁是**暂时性**的，不是永久失效。11:44 再换令牌拿到 `4c13ab21…`（不再是
`0dfb9634…`），三份数据一起回来了：

| 探测（`3225122202`） | 结果 |
|---|---|
| 在线 `EVENT_ON_OFF` | `"true"`（时间戳 11:30） |
| 今日 `EVENT_WORKDATA` | 12 条运行段（06:23 起，每段 1–2 分钟） |
| 工况 `EVENT_POST_ATTR` | `relFloor:1 / height:2.0 / load:0.0 / numberOfPeople:0` |

`32251222021` / `32251222023` 仍是无数据（网关不认这两个编号），`E03C1CB9F5011824`
最后一条是 10-21 的 `false` —— 与 `data/liftSn.ts` 登记的一致。

**客户端据此加了一道自检**（`api/iot.ts`）：换令牌是幂等的，若「刚被判 401 的那张」
重换回来**逐字节相同**，直接抛 `IotStaleTokenError` 收手，不再拿废票去打那 12 个
数据接口。判据只看令牌值，不看时间 —— 时间判不出来（`expireTs` 写着 48h，
实际 10 分钟就失效）。

### 7. 凭证失效要给出路，不能干摆「—」

自愈失败（重换令牌仍 401）时，卡片和九宫格都还在，但每一格都是「—」。这时必须
说清楚是为什么，否则用户只会反复下拉。

- `api/lift.ts` 记两个痕迹：`liftAuthFailed()`（401）与 `liftGatewayStale()`
  （重换回来还是同一张令牌 = 网关没轮换）；
- `stores/lift.ts` 出 `authLost` / `gatewayStale` 与 `relogin()`；
- 首页智控面板、电梯详情页各出一条提示 + 「重试」按钮，两处文案一致：
  - 常态：「**电梯**物联网网关凭证失效，请稍后重试」
  - 点过重试仍是同一张令牌：「**电梯**物联网网关未恢复，请稍后再试」
- 两句话都带「电梯」前缀：首页那屏同时有塔机 / 爬架 / 无人机，笼统写「物联网网关
  失效」用户不知道该看哪张卡（IOT 网关其实只供电梯这一路）。
- **不再写「重试可重新获取」**：服务端轮换之前重试确实拿不到，那是过度承诺。
- 提示条改版前这里是「重新登录」按钮 + `watch(auth.token)` 触发重取，**两个都已删除**：
  登录换的是 `:8081` 的 Bearer，与 IOT 的 ak/sk 令牌不同源，登录对这里毫无影响；
  反过来 `watch` 里那次 `clearToken()` 还会把好用的一张令牌丢掉重换。

### 8. 实时刷新：10 秒一轮，且**不许页面跳**

初版电梯只在进页面时取一次，理由是「工况帧几十秒才一条，轮询不划算」。那是帧的
节奏，不是页面的期待：用户盯着「当前楼层 / 当前载重」时一帧卡十分钟不动，看着就是
坏了。现在改成轮询，但做了三层收敛：

| 项 | 值 | 理由 |
|---|---|---|
| 工况（`EVENT_POST_ATTR`） | **10 秒** | V2 是 5 秒（原生客户端），10 秒足够「看着是活的」 |
| 在线（`EVENT_ON_OFF`） | 每 3 轮（30 秒） | 在线态分钟级才动 |
| 今日（`EVENT_WORKDATA`） | 每 6 轮（60 秒） | 当天累计，一分钟一刷已经够细 |
| 工况回看窗口 | 轮询 **3 分钟**（首轮仍 6 小时） | 6 小时的帧每 10 秒重拉一遍会随当天时间线性变痛 |

**只在这些地方跑**：首页智控面板、电梯详情页、设备信息弹层。三者按**名字**登记在
`stores/lift.ts` 的 `liveOwners`（Set，重复 start 幂等，不是计数器），最后一个离开
才停表；标签页隐藏（`visibilityState === 'hidden'`）时整轮跳过。

**不跳动的四条保证**（比轮询本身更容易做错）：

1. 轮询**绝不改 `state`** —— 一旦翻成 `loading`，页面会先铺骨架再回填，那就是肉眼
   可见的跳动。`pollOnce` 只写 `online/today/attr/updatedAt`。
2. 窗口内没有新帧时**保留上一次读数**，不清成「—」。静止的电梯停了五分钟，楼层该
   还是「5F」（帧自带时间戳，不会骗人）。
3. 数值格禁止折行（`.dev-card-grid b/span` 增加的 `white-space: nowrap`）：值从「5F」
   变「12F」若折行，卡片会变高、整页跟着上移。
4. 数值不做滚动动画（只有首页的 `CountUp` 是动画，电梯读数不走它），且全局
   `tabular-nums` 已在 `body` 上，位数变化不会逐字符抖。

凭证判定失效（`authLost`）时**整轮跳过** —— 否则每 10 秒往网关空撞一次，用户越等
越糟；点「重试」把它清掉后自动接上。

### 9. 连不上 = 离线，且**不留在线残值**

用户 2026-11-13 看到一屏矛盾：顶部「4/4 在线」+ 绿点，每一格却是「—」，下面还挂着
「网关尚未恢复」。这在语义上说不通 —— 网关都连不上了，凭什么说 4 台全在线。

两个原因叠在一起：

1. **在线状态留了残值。** `load()` 原本是「某块失败就保住上一次的值」，对工况 / 今日
   是对的（读数自带时间戳），对在线是错的：上一轮那 4 条 `true` 会被一直沿用。
2. **在线数回落了台账。** `onlineKnown` 为假时按台账 `online_status` 数，而台账对
   两栋楼都报在线 → 4/4。

改法：

- `stores/lift.ts`：在线这一路**失败即清空**（`load()` 的 `else online.value = {}`、
  `pollOnce()` 的 `else if (dueOnline) online.value = {}`）。`dueOnline` 必须留着 ——
  节流没查（`null`）与查了失败（`null`）是两回事，混起来会把「没刷」当「刷挂了」。
- 三处消费方一律 `isOnline(sn)` 直判，**不再回落台账**：
  `EquipPanel.countOf`（卡片 `x/4` 与状态点）、`DevicePage.liftCards`（卡片状态）、
  `DeviceInfoSheet.liftStatus`（弹层「当前状态」）。
- 结果是连不上时：卡片 `0/4` + 灰点、每笼「离线」、顶部离线数 +4，与提示条一致。
- `onlineKnown` 保留但**页面不再据此分叉**（连不上与真离线都渲染「离线」），
  只为排查时区分这两种情况。

代价是抖一下：网关偶发一次超时会把 `4/4` 打到 `0/4`，下一个在线轮次（30 秒）恢复。
这是刻意选的方向 —— 简报好过报假平安，何况同一时刻提示条会把原因写在脸上。
塔机那条实时通道**仍回落台账**（`stateOf` 返回 null 时），两者不同：MQTT 在线上
HTTPS 部署里本来就常连不上，而电梯走的是普通 HTTP，连不上就是真的有问题。

### 10. 作业报表（2026-11-13 下午，替换「暂未接入」空态）

原来那页是一句「电梯作业报表暂未接入，当前账号没有该接口权限」。那句已经过期：
权限问题查清是令牌失效（§6），数据本来就是通的。现在照设计稿做出了日报 / 周报 / 月报。

**数据源与 V2 的对应**：`EVENT_WORKDATA`（每次升降一条），就是
`ElevatorRequester.QueryWorkCycleHistoryAsync(sn, date, token)` 那份 ——
V2 电梯历史弹层 `UIPopElevatorHistory` 的行项是「序号 · 司机 · 开始 · 结束」。
V2 **只有单日**（一个 `date` 参数 + 一个日期选择器，无周报月报），设计稿的三档是
示意版式；区间改用与塔机报表同一套 `reportRange`（自然日 / 自然周 / 自然月）。

接口实测（单台 `3225122202`，2026-11-13）：当天 27KB / 7 天 213KB / 30 天 656KB，
0.2s / 0.4s / 0.7s；30 天 2242 条、31 天有数据、日均 72 次。

**「在运时段」= 按日切片再累加**，这是本节唯一需要记住的口径：

| 粒度 | 结果 |
|---|---|
| 日报 | 只有一个日切片 → **与弹层「今日累计运行时间」逐字节相同**（V2 首尾跨度） |
| 周报 | 7 个日切片之和 |
| 月报 | 30 个日切片之和 |

不能直接用区间首尾相减：30 天会变成「月初第一次动到月末最后一次动」≈ 720 小时，
那是日历不是运行时段。按日切片后每一段仍是「当天的工作时段」，月报实测
**358.8h（日均 11.6h）**，与工地电梯作息吻合（同批数据逐条累加只有 39.8h）。

**三格 KPI 与表格列换了**（设计稿那几格没有数据源，不摆永远写「—」的格子）：

| 设计稿 | 本项目 | 为什么 |
|---|---|---|
| 合计循环 | 合计循环 | 同量同词（= 事件条数 / V2 `Data.Count` / 弹层「今日升降次数」） |
| 合计载重 | 在运时段 | 载重只有 `EVENT_POST_ATTR` 瞬时帧，没有逐次累计 |
| 平均利用率 | 覆盖台数 | 利用率要台班排班表 |
| 表：循环/载重/利用率/运送 | 循环/在运时段/最长单次/在用天数 | 同上；「最长单次」「在用天数」都能逐条核验 |

**结论区四段照设计稿**（2026-11-13 15:00 用户决定「按现有数据定下来」）：
关注 / 主力 / 短板 / 当前，最多四段。

| 段 | 设计稿判据 | 本项目判据 | 为什么 |
|---|---|---|---|
| 关注 | 利用率最低 | 缺数台优先；否则**在用天数最少** | 利用率无源；天数同样表达「使用强度最弱」 |
| 主力 | 循环占比最高（+ 运送/载重占比） | 循环最多 + 占比，**单次最长并进这句** | 设计稿只有四段，峰值不单独占段 |
| 短板 | 循环最少 + 占比 | 同 | 同一量 |
| 当前 | 离线台 | 同（`onlineKnown` 为真才说） | 连不上时不能写成「4 台全停」 |

「缺数」占「关注」这一格：有台未纳入统计时，这比「哪台少跑」更该先说。

**两种缺失必须分开说**（页面结论区）：

- 键在返回里但是空数组 = 网关认这个编号、区间内没跑 → `0次`；
- 键没回来 = 网关不认编号（`status:10`，`32251222021` / `32251222023`）或请求失败
  → 该行 `—`，结论写「X 未纳入统计」（否则「合计 78 次」会被当成全场）。

`fetchLiftWorkRange` 因此**不用 `perSn`**（它把 rejected 过滤掉、丢失「哪台失败」
的对应关系），改成 `allSettled` 保序配对。

缓存与塔机报表同规则：同区间 45 秒内复用（月报四台约 2.6MB，现场是手机流量），
连点粒度用请求序号丢弃过期结果。

**空态有五种，前一种最坑**（2026-11-13 14:30 用户截图踩到）：

| 情形 | 页面 | 为什么这样写 |
|---|---|---|
| 网关凭证失效（`authLost`） | 「电梯物联网网关凭证失效，请稍后重试」+ **重试** | 三档走同一个网关、同一张令牌，写「换个粒度看看」是**假建议**，用户白点 |
| 重试过、网关没轮换（`gatewayStale`） | 「电梯物联网网关未恢复，请稍后再试」 | 自检在 `ensureToken` 就收手，四个请求没发出去，说了实话 |
| 网关认编号、区间内 0 条 | 正常报表 + `0次` | 有效结论，不是缺数 |
| 网关不认编号 / 请求失败 | 该行 `—` + 结论「未纳入统计」 | 与「0 次」必须分开 |
| 一台都没应答且不是凭证问题 | 「暂无作业报表数据」+「换个粒度看看」 | 这时换区间确实有意义 |

报表页原先**没有**凭证提示（`DevicePage` 那条 `.dev-auth` 只挂在 `pageTab === 'live'`），
用户看到的就是一句「暂无作业报表数据」。所以 `stores/liftReport.ts` 自己出一份
`authLost` / `gatewayStale` 快照（读 `api/lift.ts` 的模块级痕迹），并加 `retry()`
= `clearToken()` + 重查当前粒度 —— 不清令牌的话，`ensureToken` 会把那张刚被判 401
的令牌原样再交一次。

### 设计稿的「合计载重 / 平均利用率 / 运送人数」为什么不做（2026-11-13 复核）

设计稿是「2026-10-21 · 1-1 78次 / 11.20t / 79% / 610人」，三项互相自洽
（每次 144kg、7.8 人），看着像真数。但四个方向都查过，**本项目与 V2 都拿不到**：

1. **事件报文没有这两个字段**。`EVENT_WORKDATA` 当天全部 2242 行，`resultMap`
   的键集合只有 `deviceType / writeTsdbTime / runStartTime / runEndTime /
   driverId / driverName` —— 逐次载重和逐次人数根本不存在，累加无从谈起。
2. **V2 的电梯模型只存四个东西**。`ElevatorIotModel` 的字段是
   `OnlineDic / RealtimeDataDic / TodayLiftCountDic / TodayRuntimeHoursDic`
   （外加 token 三项），即「在线、瞬时工况、今日次数、今日时长」。没有载重、没有利用率。
3. **V2 的历史图表画的是次数**。`UIPopElevatorHistory.RefreshChart` 的 IL：开
   24 个 `Int32` 桶按 `Hour` 累加，series 名 `'升降次数'`，tooltip
   `<color=#FFFFFF>{b}</color>\n<color=#0089CA>{c:f0}次</color>`。对比塔机
   `UICraneHistoryPop` 那一套（`tog_Count` / `tog_Weight` 两个切换）—— **电梯只有次数**，
   没有第二个可切换的量。
4. **V2 面板的载重/人数是瞬时值**。`UIPanelElevator` 的 `txtLoad` /
   `txtNumberOfPeople` 取 `RealtimeResultMap.Load / NumberOfPeople`，是
   `EVENT_POST_ATTR` 那一帧的快照，不是累计。

顺带核了「设计稿是不是抄的我们自己的数」：本机 30 天数据里 2026-10-21 该笼
（`3225122202`）是 **81 次**（06:28:50 首、17:54:51 末），无重复行，凑不出 78；
其余三笼的编号网关至今不认（`status:10`），更不可能给出 22/14/28。**所以那页数
来自另一个系统**（大概率是电梯厂家的云平台），不是 V2，也不是本项目现有接口。

**将来要接需要什么**：厂家平台或 IOT 侧开放「逐次载重 / 逐次人数」的事件码或
汇总接口。结构不用改版 —— 三格 KPI 换回「合计循环 / 合计载重 / 平均利用率」，
表格换回「循环 / 载重 / 利用率 / 运送」即可，`.report-*` 都是现成的。

`平均利用率` 另有一层麻烦：全平台（V2 与 IOT）没有这个字段，也没有任何算法定义，
连分母（施工时段？台班排班？）都得现场定。真要算只能造口径，所以宁缺。

---

## 五、两个必须知道的隐患

1. **私钥在客户端**。大屏 open 用项目级私钥签名，原厂把私钥内嵌在桌面端；本项目
   照搬以拿到数据。它能防公开抓取，但防不住逆向（拿到包就能签）。彻底解决要服务端
   代理签名：前端调 `/proxy/yzw/*`，私钥只留在服务器（`server/serve.mjs` 加路由即可）。
2. **站点协议**。A/C/D 组接口多为 HTTP 或自签证书；站点若走 HTTPS 会被混合内容拦掉。
   当前用自托管 HTTP 部署规避，长期正解仍是「站点 HTTPS + 同域反代」。

---

## 六、MQTT 不是万能的：三条实测否证（2026-11-16）

「把轮询换成订阅 MQTT」这个方向被问过三次（无人机、电梯、塔机）。塔机确实该走
MQTT（已在跑，见 13(14)），但**无人机和电梯都不行**，理由各自不同，都实测过。

### 1. 无人机那台 broker 是**三元里**的，不是向阳村的

V2 源码 `MqttDroneRealTimeInfoRequester.cs` 里写死：

| 项 | 值 | 备注 |
|---|---|---|
| broker | `47.106.219.250:1883` | |
| 账号 | `AzmSylUser` / `Azm2025@` | 与 smart-build 账号密码同源 |
| 无人机主题 | `/prod/thing/product/1581F6Q8X251800G040D/osd` | QoS 1 |
| 机库主题 | `/prod/thing/product/7CTXN3500B07ME/osd` | QoS 1 |
| 离线判定 | 3s 收不到即判离线 | 飞控 OSD 约 1Hz |

**实测（本机 TCP 直连，非浏览器）**：CONNACK 0 成功，20 秒收到 49 帧机库 OSD，
无人机主题 **0 帧**。原因有三个，每个都足以否掉「接过来」：

1. **不是本项目的数据**。抓到的机库 OSD 里 `latitude 23.166839` /
   `longitude 113.256794` —— **广州**。向阳村在武汉（`30.5326 / 114.2463`，
   keehang 机库遥测实测值）。机库 sn `7CTXN3500B07ME` 也不同于本项目机库
   `origin_sn 7CTDM7R00B1498`。接上去等于把三元里的飞机画进向阳村。
2. **飞机主题 0 帧是因为飞机在关机**。机库 OSD 的
   `sub_device.device_online_status = 0`（0 关机 / 1 开机）、`drone_in_dock = 1`。
   DJI Cloud API 在飞行器关机时不推 `{drone_sn}/osd`，不是链路坏了。
3. **keehang 侧没有 MQTT 端口**。`iot.keehang.com` 的 1883 / 8083 / 8084 / 9001
   全部不通（只有 23443 HTTPS）。向阳村的无人机数据只存在于 keehang 的
   HTTP 接口里，没有可订阅的推送通道。

**补一次通配扫描**（订阅 `/prod/thing/product/+/{osd,state,events,status}`，35 秒），
这台 broker 上在推的机库共 **9 台**，坐标全部落在广东：

```text
 84  osd  sn=7CTXN3500B07ME   23.1668,113.2568
 78  osd  sn=8UUXP3Q00A128D   22.9882,113.2322
 78  osd  sn=8UUXP4D00A15J2   22.7376,114.3959
 78  osd  sn=8UUXP4D00A15C6   22.6856,113.9341
 78  osd  sn=8UUXNCF00A0X8Y   23.0709,113.3057
 78  osd  sn=8UUXP4700A14K0   23.3546,113.5433
 77  osd  sn=8UUXP3L00A11FG   24.7371,118.6531
 76  osd  sn=8UUXNC100A0V9N   24.4652,118.0923
 76  osd  sn=8UUXP4B00A155S   22.7556,113.1903
```

**没有一台在武汉**，而且 9 台的 `sub_device.device_online_status` 全是 0（飞行器关机），
所以无人机主题一帧不发是常态、不是故障。

另测塔机那台 `115.159.67.12:1883`（`#` 通配 30 秒）：8 个活跃主题全是塔机
（`/P000000076/towercranedataservice/pushRealTimeInfo` 12 帧）与挖机，**无无人机主题**。

> 结论：**2 秒轮询就是本项目的上限**。向阳村 V2 也一样是轮询（见下），
> 双方同源同接口，频率上不存在「V2 有而我们没有」的推送通道。

顺带解决一个悬案：机库 OSD 里 `rainfall = 0`，而同一天的 keehang 遥测
`rainfall = 1`。两台**不同机库**的设备，两边数值本就不该相同，
所以此前「`rainfall=1` 到底是雨量还是雨强」的口径疑问在这里没有对照价值，
仍以 keehang 那侧为准、起飞条件按未知处理。

### 2. V2 的智能电梯**不是** MQTT，是 HTTP 拉取

在三元里源码包里全量搜索，`new MqttClient(...)` **只出现一次**，在
`Network/无人机/MqttDroneRealTimeInfoRequester.cs`。电梯模块（`ElevatorRequester`、
`ElevatorIotModel`、`UIPanelElevator`）走的是 C 组 IOT 网关的
`/api/data/v1/tsdb/queryRealTimeDataV2` 与 `/queryEvent`，且 `FetchWorkCycleAsync`
是 async 状态机（IL 实证），即**主动拉取**，不是订阅。

所以电梯的 10 秒一轮刷新与 V2 同构，**没有「该改成 MQTT」这回事**。
它真正的问题是 换令牌那一跳缺 CORS（于是有了 `/iot-api` 同源反代），
与协议无关。

### 3. 任务数对不上：两套平台、两个项目，不存在同一份数

**先说结论：向阳村 V2 用的是同一套 keehang，23 是它漏传 `pid` 把隔壁项目算进来了。**

前面几轮绕了远路，是因为拿错了参照物 —— `客户端-三元里-源码` 那一份里，
无人机确实走 `v2.smart-build.cn/ynlkUavApi`（账号 `18800010001` / `Azm2025@`），
于是「23 应该来自 smart-build」成了先入为主的假设。**但向阳村现场跑的是另一版**：

- 日志堆栈命名空间是 `DigitalMap.UAV.*`（三元里那份是 `DroneDataCenter`）；
- 它的 `StreamingAssets/LoginUrl.txt` 指向 `http://115.159.67.12`；
- IL2CPP metadata / GameAssembly 里搜不到 `smart-build`。

**决定性证据是运行时连接**（V2 进程 PID 12116 实测，`Get-NetTCPConnection`）：

| 目标 | 归属 | 用途 |
|---|---|---|
| `110.41.50.115:23443` | **`iot.keehang.com` / `account.keehang.com` 的 A 记录** | 无人机（与本项目同一套） |
| `115.159.67.12:1883` | 塔机 broker | 塔机实时工况（与本项目同一条） |
| `124.70.126.80:443` / `171.43.196.129:443` | 华为云 ECS 等 | 其它业务 |

**它没有连接 `47.106.219.250`（三元里无人机 broker），也没有任何无人机 MQTT 连接。**
向阳村 V2 的无人机数据是 HTTP 轮询 keehang 拿的，跟我项目同源同接口。

### 23 与 15 的真正差异：一个 `pid` 参数

同一时刻（2026-11-16 09:45）对同一个接口取两次：

| 请求 | taskCount | 列表里出现的 pid |
|---|---|---|
| `/dashboard/task/list/record?pid=193640872670213` | **15** | 只有 `193640872670213`（向阳村） |
| `/dashboard/task/list/record`（**不传 pid**） | **23** | `193640872670213` ×7 + **`231070463906821` ×3（光谷元著）** |

不带 `pid` 时混进来的任务名是「光谷元著-正摄」「光谷元著-全局定点」「光谷元著-安全巡检」——
同一账号下**光谷元著项目**的任务被一起算了进来。8 = 23 − 15，正好是隔壁项目的量。

也就是说：

- **23 是「该账号下所有项目今日任务数」**，V2 取这一格时没带项目过滤，把光谷元著也画进了向阳村的卡片；
- **15 是向阳村自己的今日任务数**（3 已完成 + 11 计划），即带 `pid` 的结果。

**结论：本项目按 V2 口径取，`fetchTaskStat` 默认不传 `pid`**（2026-11-16 用户决定
「V2 咋获取的我就咋获取，先不管是不是向阳村」）。之前那版带 `pid` 的写法数字更「干净」，
但用户要的是与 V2 逐字一致，因此以 V2 为准；要回到项目内口径，传 `{ pid: KH_PROJECT_ID }` 即可，
不必改函数。

### 今日明细也放开到账号口径（2026-11-16 用户要求「23 条都放开」）

三格改成 23 之后，明细还只列向阳村 15 条，两者对不上。现在明细走 `fetchTodayRecords`：

1. `GET /dashboard/device/list?page=1&size=100` 取账号下所有项目 id（唯一一个**不吃 pid**
   就能列出全部设备的端点，实测 5 台设备 / 2 个项目：向阳村 `193640872670213`、
   光谷元著 `231070463906821`），本项目排第一；
2. 对每个 pid 各打一次 `/task/exec/list/record`，合并后按 `uuid` 去重。

实测逐条核对，三格那个 23 摊开正好是这张清单：

| 项目 | 今日执行记录 |
|---|---|
| 向阳村 | 15 |
| 光谷元著 | 8 |
| **合计** | **23** = `taskCount` |

⚠️ `/task/exec/list/record` **不带 `pid` 返回 0 条**（2026-11-16 09:57 实测），
所以「账号口径」只能逐个项目取完再合并，没有一次性端点。

两处设计约束：

- **`当前巡检` 与进度条只认本项目**（`UavTaskView.own`）。实时遥测是向阳村那台机库的，
  挂上光谷元著的航线会给出错误的「已飞多久 / 预计多久」；别的项目在执行中的任务
  仍在今日列表里照常显示。
- 列表里出现别的项目时，弹层底部加一句「含同账号其它项目的任务」；只有本项目时不出现。
- 某个项目请求失败仍返回其它项目（宁可少列，整页不塌）；全部失败才抛，页面写加载失败。

> 顺带澄清另外两条此前记错的：
> - `xiangyangcun` / `ZJWF2025` 是 `:8081` 业务平台（大屏/移动端）账号，不是无人机平台的；
>   拿它登 smart-build 会得到 `{"code":500,"msg":"号码非内部账号，无权登录"}`。
> - smart-build 那套（三元里 / 2025P04）近 31 天任务数最多 10 条，与向阳村无关，
>   不必再拿它当参照。

## 六点五、智眸照片：按航线分六类 + 缩略图 + 限流（2026-11-16）

用户要求：智眸「最新照片」按设计稿六个分类（项目全景 / 基坑区域 / 作业面 /
施工装备 / 材料堆场 / 现场场布）**固定 3×2 两行**显示，删掉「未分类」。

### 1. 服务端没有分类字段（V2 也一样）

不是我们没找到，是三层都没有：

| 层 | 字段 | 结论 |
|---|---|---|
| keehang 媒体 `GET /media/task/job/{id}` | `name / path / isDir / etag / lastModified / size / mediaType / url / limitUrl / thumbnail` | 无分类 |
| 万联后端《数据库设计文档》媒体文件表 `devDroneMedia` | `LinkId / CreatedTime / RecordId / MediaType / Url / LimitUrl / Thumbnail / Name / Size` | 无分类列 |
| keehang 航线 `/task/list` | 15 条任务 `taskType` 全 `AIRLINE`、`resourceType` 全 `AIR_LINE` | 无「正射/三维/巡检」维度 |

**所以 V2 也拿不到这六类** —— 设计稿那 17 张图是人工归类的演示数据。
要在真实照片上显示六类，只能在客户端按**航线名**映射。

### 2. 归类规则（`data/config.ts`）

`PATROL_TASK_CAT` 显式登记现场 15 条航线 → 六类之一；未登记的新航线走
`PATROL_CATS[].pattern` 关键词；都没命中落兜底类 `layout`（现场场布，语义最宽）。
**三者必有结果，所以不存在「未分类」**。卡片标题仍写真实航线名，徽标写归类 ——
归错类时一眼能看出是哪条航线，改的只是那张表。

落到兜底也不影响正确性判断：六类只是筛选维度，不是数据维度。

### 3. 取数逻辑（`stores/patrol.ts`）

三个接口行为必须记住（都实测过）：

1. **`size` 不生效**：带 `start/end` 时返回区间内全部记录（近 30 天 458 条）；
   不带日期按 `start` **升序**回全部 1663 条。旧代码用 `page=1&size=12` 取「最新」，
   实际拿到的是**最旧**一批 —— 页面标题写「最新照片」、内容却是 7 月的，就是这么来的。
2. **记录里混着未来排班**（`end` 已排到 11-23，`status=2` 但媒体为 0），必须用
   `start <= 现在` 剔掉，否则一直取到「今天下午 5 点」这种还没飞的班。
3. **媒体只能逐条取**（`/media/task/job/list` 之类不存在），且有**服务端限流**：

| 请求间隔 | 结果 |
|---|---|
| 4 路并发 | 第一轮能过，之后全拒（`code 42901 查询过于频繁，请2秒后再试`）→ 页面 0 张 |
| 600ms | 连续 14 次全被拒 |
| 1200ms | 13 / 14 成功 |

现在：串行 + `PROBE_GAP = 900ms`，遇 `42901` 等 2.2s 重试一次；按时间倒序最多探
`MAX_PROBE = 16` 条记录、收 `MAX_JOBS = 10` 个任务、每个任务最多 `MAX_PER_TASK = 24` 张
（「正射」「三维」一次就上百张，不设配额会把别的分类挤掉）。

实测结果：**13 秒拿到 153 张 / 8 个航线 / 129 张有缩略图**。因为是边探边上屏
（每拿到一个任务就 push 进 `photos`），用户 2 秒内就能看到第一批，不用等扫完。

### 4. 两个防撞限流的闸

- `refresh()` 成功后再进面板，60 秒内直接复用（`REFRESH_GAP`）—— 来回切三个
  标签会反复触发扫媒体，必撞限流；
- `apply()`（测试接线点）也置 `lastOkAt`，等价于「刚同步完」，不会被挂载时的
  `refresh()` 立刻清空。

### 5. 两张图：列表缩略图 → 点开原图（2026-11-16 用户要求「像微信那样」）

原图单张 4~8MB（实测 4 411 392 / 7 825 440 字节），缩略图 370~520KB。
现在的加载策略：

| 位置 | 加载什么 | 依据 |
|---|---|---|
| 列表卡片 | `thumbnail` + `loading="lazy"` | 滚动到才加载 |
| 大图首屏 | **同一张 `thumbnail`**（列表里已缓存，等于零等待） | 不重复下载 |
| 点「查看原图」 | `url`，`fetch` + 读流报**真实百分比** | 见 `utils/blobFetch.ts` |

三个接口事实（都实测）：

- **`limitUrl` 不是压缩版**：与 `url` 字节数完全相同（4 411 392），只是换成
  `moss.keehang.com:9443` 这个域名。**别拿它当低清图**。
- **两个域名都回 CORS**：`Access-Control-Allow-Origin` 回显请求 Origin，
  并且 `Accept-Ranges: bytes` —— 所以既能在浏览器里读流算进度，也能
  `canvas` 转码存相册。
- 拉不到（离线 / 被拦）时退回「把直链塞给 `<img>`」，慢但图能出来；
  进度条那一路失败不会把页面卡住。

「下载」优先复用点过原图后已经拿到的字节（直接包成 jpg `File`），
省掉再下一次 6MB；没点过原图才走原来的 `savePhoto(url)` 现转。

### 6. 项目全景：走「重建成果」接口（2026-11-16 修正）

> ⚠️ **上一版这一节的结论是错的**（「平台里一张全景都没有」）。当时只查了
> 媒体接口 `/media/task/job/{id}` —— 那是**原始拍摄件**。真正拼好的全景在
> **重建成果**里，V2 控制台「成果预览」用的就是这套。

**接口（与 V2 `#/control` 同源）**

```
GET  /dashboard/recreate/getProjectRecreateInfo?pid=<项目>&pageNo=1&size=30
       → {total, list:[{recordId, projectId, projectName, taskName, taskType,
                        status, createTime, resultRecordDTOList:[…]}]}
GET  /dashboard/recreate/recordInfo/{recordId}          ← 本项目不需要（列表已内嵌成果）
POST /share/recreate/fileUrl/{achievementId}/{secret}   → 重签 pano.json 直链
POST /share/recreate/sts/models/{id}/{secret}           → STS（V2 用它自己签每个切片）
POST /share/recreate/panoconfig/{id}                    → 默认视角 {yaw,pitch,zoom}（本项目为空）
```

**关键事实（全部实测）**

- `taskType`：**1=三维 2=全景 3=正射**；`status`：2=已完成。
- `taskType` / `status` **作为查询参数传了会被忽略**（返回的仍是最新那几条），
  所以必须自己筛。`page` / `pageNo` 都认，`size` 生效（`size=500` 一次回全部 419 条）。
- 排序默认 `createTime` 倒序。本项目 419 条，全景大致每 4 条出现一次
  （正射 → 三维 → 正射 → 全景 的节奏）。**2026-11-16 16:47 实测**：带 `pid` 时
  `size=30` 第一页就命中本项目最新全景（约 80KB）；不带 `pid` 时全平台 434 条，
  最新的是**光谷元著** 11-15 13:29（比向阳村 11-15 12:10 晚 1 小时）。
- 列表每行的 `resultRecordDTOList` **已经带签名直链**，不用再调 `recordInfo`。
- 一次飞行产出**多个**全景点：向阳村 `_0/_1/_2`（3 个，13.05/13.91/13.54MB）、
  光谷元著 `_0.._4`（5 个）。按名字排序取 `_0`（用户要求只留一张）。
- 每个成果带三样东西（签名 URL，`X-Amz-Expires=7200`，**2 小时过期**）：
  - `url` → `…_0/pano.json`：**立方体切片清单**（`cube` 六面 + `tiles.col=4` 的 4×4 切片），
    V2 的 `iot.keehang.com/pano/#/panorama` 用 Photo Sphere Viewer 读它；
  - `thumbnail` → **3162×1581 等距圆柱预览图**（约 185KB，OSS 缩略图桶）；
  - `download` → **`origin.jpg` 10000×5000 等距圆柱原图**（约 13MB，moss 域名）。
- 两个域名都回 `Access-Control-Allow-Origin`（**带 Origin 请求头时才回**），
  也支持 `Range` —— 能直接 `crossOrigin='anonymous'` 交给 WebGL 当贴图。
- **`createTime` ≠ `endTime`，展示要取 `endTime`**（2026-11-17 实测）。任务行两个时间：
  `createTime` = 重建**开始**（record 182233 → `2026-11-17 11:58:40`），
  `endTime` = `updateTime` = 拼接**完成**（`2026-11-17 12:07:30`），`progress: 100`。
  V2 的「重建已完成」列表显示的是完成时刻。本项目早期用 `createTime`，弹层写
  「11:58」，V2 同一条写「12:07:30」—— 不是取到了旧图，是口径不同；现已改成
  `endTime || updateTime || createTime`（`DronePano.time`）。排序仍按 `createTime`
  （与服务端倒序一致），两者对「谁最新」的结论没有分歧。

**本项目的实现（比 V2 简单一档）**

V2 的 cube 分支只贴 6 张 `cube/*_low.jpg`（每面 1024²，等效约 11 px/度），
高清还要另走 STS + 逐块切片。既然 `origin.jpg` 本身就是 2:1 等距圆柱，
这里直接**贴一张等距圆柱图**：`utils/pano.ts` + `ui/PanoViewer.vue`（手写 WebGL 球面），
手机与电脑同一套手势（拖拽 / 双指 / 滚轮 / 惯性 / 复位）。

- 首屏用 `thumbnail`（185KB）；「看高清」才拉 `download`（13MB），贴图没到位前
  旧图继续显示，不闪白。没有 WebGL 退平面 + 双指缩放，并写明原因。
- **按项目筛**（`pid` + 本地 `projectId` 双保险）：不筛会静默把光谷元著顶进来。
- 全景航线的**原片不进照片墙**（26 张碎片），也不为它发媒体请求。
- 签名过期时弹层给「全景图链接已过期 · 重新获取」，走 `loadPano(true)` 重取。

**仍然成立的旧结论**：媒体接口里没有 2:1 的图（12 条航线抽样全是 4032×3024 /
4000×3000），所以照片墙那条「按几何形状认全景」（`isEquirect`）保留着，
真来了就自动进环视。

#### 6.1 为什么不用 V2 那套 cubemap（2026-11-16 实测）

`pano.json`（`url` 指向它）里写着两种投影：

| 字段 | 内容 | 能不能直接取 |
| --- | --- | --- |
| `origin` | `origin.jpg`，**10000×5000** 等距圆柱（27.8 px/度） | 能，`download` 是签名直链，13MB |
| `cube` | 六面 `cube/{front,back,left,right,top,bottom}_low.jpg`，每张 **2500×2500**（27.8 px/度） | 不能，裸 URL 一律 **403**，要 STS 临时凭证自签 |
| `tiles` | `tiles/{面}_{行}_{列}.jpg`（4×4 切片） | 不能，目录实测 **404** |

**结论是等距圆柱够用**：两者角分辨率完全一样（都是 27.8 px/度），换 cubemap
不会更清晰，只会多出「STS 换凭证 + 浏览器端 SigV4 自签 6 个 URL」一条新链路
（`POST /share/recreate/sts/models/{id}/…` 能换到临时 ak/sk，实测能签出
`cube/bottom_low.jpg`）。

**天底其实不糊 —— 别再照着"糊"去优化**（2026-11-16 二次定案，推翻了当天下午
的一个错误结论）。把 `origin.jpg` 最下方 5%（纬度 -81°~-90°）按原始像素放大出来
看，混凝土地面纹理、板块接缝、轮胎印、构件边缘全都在。之前判断"天底是相机
自遮挡的填充死区、没有细节可抢救"是**看错了对象**：那次拿的是 3162×1581 的
`thumbnail`，不是原图。

所以正下方不清只有一个原因：**采样被过度模糊**。当天先后试过三件事，只有最后
一件是对的：

| 改动 | 结果 |
| --- | --- |
| 顶点 UV 插值 → 片元按视线方向现算 | 少一层误差，但极点条纹没消失 |
| 片元着色器 mediump → highp | 必须改（mediump 尾数不够，`acos` 在极点跳变） |
| 离天底 15° 内按方位 8 点平均 | **错的**：把真实地面抹成一片灰雾，看起来更糊 |

正确做法是**什么都别平均**：极点附近一个屏幕像素在纹理空间的足迹本来就近似
各向同性（方位被压缩的程度 ≈ 半径方向的距离），三线性过滤选出的 mip 层是合适的，
配上各向异性过滤就够。加了平均反而把可用细节抹掉。

**另一个真坑（顺手修掉）**：`origin.jpg` 10000×5000，超过多数设备的
`MAX_TEXTURE_SIZE`（手机 4096~8192）。超限时 `texImage2D` 报 INVALID_VALUE、
贴图保持不完整 —— 表现**不是糊而是整屏黑**，且各机型不一致。现在先按
`utils/pano.ts` 的 `panoTexScale` 缩到「边长 ≤ 上限 且 总像素 ≤ 18M」再上传。

**镜像**：`u` 必须取 `1 - θ/2π`。球面顶点按 `x=sinθ, z=cosθ` 生成、摄像机朝 -Z，
于是 θ 增大等于画面往左；若写成 θ/2π，整张全景就是左右反的（2026-11-16 实测）。

### 7. 全景航拍：全局定点拍照最新 9 张（2026-11-18）

「全景航拍」这一格不再是照片墙的一类，而是**固定 9 张**，来源与 V2 的
「任务记录 → 选中一条 → 采集数据 → 采集图片」完全同一条链：

```
GET /task/exec/list/record?pid=193640872670213&start=…&end=…   → 这条航线的班次
GET /media/task/job/{执行记录id}                                → 这一班的采集文件
```

筛选条件（与 V2 逐条对齐，`api/drone.ts` 的 `fetchSpotGallery`）：

| 规则 | 取值 | 为什么 |
| --- | --- | --- |
| 任务名 | **完全等于** `向阳村-全局定点拍照` | 同时段还有「分区定点拍照」，模糊匹配会混进来 |
| 状态 | `status === 2`（已完成）且 `start <= 现在` | 记录里混着未来排班（11-19 那几条 `status: -1`），没有媒体 |
| 顺序 | `start` 倒序，**跳过媒体为空的那一班** | 实测 11-18 08:20 那班 `status=2` 但媒体 0 条 |
| 媒体类型 | 只留 `image/*` | 每班都有 1 个 `.DAT` 飞行日志；V2「采集图片 9」= 9 张 JPEG |
| 张数 / 顺序 | 按 DJI 序号（`_0001_V` → `_0009_V`）升序，多于 9 张取最后 9 张 | 与 V2 那排缩略图从左到右一致 |
| 窗口 | 近 30 天，没有照片再退 180 天 | 与照片墙同一套策略 |

实测（2026-11-18 10:05）：`job 182349`（`2026-11-17 15:30–15:35`）返回 10 个文件
= 9 张 JPEG + 1 个 `.DAT`，9 张**全部带 `thumbnail`**（`oss.keehang.com:19090/thumbnail/iot/…`）。
V2 截图里「巡检时长 5 分钟 / 采集图片 9」就是这一班。

页面行为：

- 列表卡片只用 `thumbnail`（约 0.4MB/张），点开大图先显示同一张缩略图，
  点「查看原图」才拉 7~8MB 的 OSS 原图并显示进度 —— 与照片墙同一套弹层
  （`PatrolSheet.vue` 的 `photoById()`，照片墙与这 9 张各存一个数组）。
- 这条航线的照片**不再进照片墙**（`probe` 里跳过）：否则会在「安全巡查」里
  再出现一遍，还多打一次媒体请求。
- 这一格同时取代了旧的「基坑区域」：`向阳村-土方1` 的照片不再有专属按钮
  （`PATROL_TASK_CAT` 里的归类还在，只是页面不再按它铺图）。

### 8. 材料堆场 / 设备设施 / 安全巡查：按序号从班里挑图（2026-11-18）

这三格也不走照片墙的分类，而是**固定张数**，取数链与第 7 节完全相同
（`latestTaskMedia`：同一套窗口、任务名全等、`status=2` 且已开始、跳过空媒体、
只留 `image/*`、文件名升序），差别只有"从这一班里挑哪几个位置"：

| 格子 | 航线（**完全相等**） | 取第几张（1 基） | 张数 |
| --- | --- | --- | --- |
| 材料堆场（分类 id `equip`） | `向阳村-分区定点拍照` | 第 1、2、37 | 3 |
| 设备设施（分类 id `face`） | `向阳村-塔吊定点` | 第 2、7 | 2 |
| 安全巡查（分类 id `layout`） | `向阳村-土方1` | 第 1 | 1 |
| 安全巡查（同上，**另一条航线**） | `向阳村-分区定点拍照` | 第 34 | 1 |

⚠️ 安全巡查是唯一**跨两条航线**的一格（`SAFETY_SOURCES`），所以
`fetchSafetyGallery()` 返回的是 `DroneSpotGallery[]`（每个有图的来源一项），
不是单条 —— 两班的 `jobId / taskName` 不同，合成一条会让卡片标题和弹层 id 都错。
两条**串行**取（并行会在同一秒打两个媒体请求，keehang 直接 42901）；
一条取不到只少一张，两条都挂才抛错。

实测依据：土方1 `2026-11-17 17:00–17:05` 那班采集 **50** 张；分区定点
`2026-11-17 12:30` 那班采集 **41** 张（V2 截图里的那两个数）。

序号是用户对着 V2「任务记录 → 该航线 → 采集数据 → 采集照片(N)」那张网格逐格
点出来的，不做任何"看起来像堆场/像塔吊"的画面猜测。**班次照片数不足该序号时
只给存在的那几张**：不拿最后一张凑数，也不跨班补 —— 凑出来的不是指定的那张。

实测依据：分区定点 `2026-11-17 12:30` 那班 41 张；塔吊定点 `2026-11-17 14:15`
那班 16 张（截图里「采集照片(16)」），第 2、7 格是塔吊。

**待接入**：设备设施按用户口径应有 4 张，另两张来自「视频监控-塔吊-2#塔吊」
「视频监控-塔吊-4#塔吊」各自最新的一张。监控侧（tciccs）目前**没有照片查询
接口**，只有实时流与抓拍报警，2026-11-18 用户明确「本轮先保持现状」，所以这一格
现在稳定 2 张。等接口通了再在 `fetchFacilityGallery` 里拼一条链，页面不用改。

页面行为与第 7 节一致：列表用 `thumbnail`，点开走同一个大图弹层
（`photoById()` 现在查五个数组：照片墙 / spot / yard / facility / safety）；失败保留
上一批，只有服务端明确回"近期没有照片"才清空；`probe()` 跳过这几条航线的整班
照片（`塔吊定点` / `分区定点拍照` / `土方1` / `全局定点拍照`）—— 它们各自只被专用链
取指定张，上墙也没有位置，跳过还能省掉每次刷新的媒体请求。

于是**六格里只剩「出入口管控」（`yard`）还按航线名归组**（`PatrolPanel` 的 groups）。

## 六点六、场景截图底图：首页背景 + 二维图改走接口（2026-11-18）

现场平台每截一次图就上传一张，**每个项目分别保存一张 2D 与一张 3D**，同类型再上传覆盖。
首页背景（`.home-map`）与全屏地图的「三维 / 二维」从此都读它，不再写死
`public/img/site-map.webp` / `site-flat.webp`。接口文档是桌面
`向阳村工地数字地图/场景截图接口使用.md`（版本 365ea8f3，2026-11-17 发布）。

### 接口

| 用途 | 方法与地址 | 鉴权 |
| --- | --- | --- |
| 图片字节（**本项目用这个**） | `GET https://115.159.67.12/api/file/scene-screenshots/content?pid=P000000076&type=2d\|3d` | 头 `X-API-Key` |
| 元数据 + Base64 | `GET .../api/file/scene-screenshots?pid=..&type=..` | 头 `X-API-Key` |
| 上传 | `POST .../api/file/scene-screenshots`，multipart（pid / type / file） | 平台 `Bearer` |

- 查询用**第三方只读密钥**（文档原值，写在 `src/api/scene.ts` 的 `SCENE_KEY`），
  与平台登录 token 无关；**密钥不能放 URL 参数**。
- `type` 只认 `2d` / `3d`，**省略即 3D**；未上传指定类型回 **404，且不回退到另一种**。
- 成功回 `{code:200,message,data:{pid,type,fileName,contentType,fileSize,uploadedAt,updatedAt,imageBase64}}`；
  `uploadedAt` 首次上传、`updatedAt` 最近覆盖，均 UTC。本项目只用 `/content` 的字节，
  不用元数据接口（它会把整张图 Base64 塞进 JSON，实测 2D 那张响应 5.08MB）。

### 三个坑

1. **不能直接写进 `<img src>`**：图片 URL 本身也要 `X-API-Key`，而 `<img>` 无法带请求头。
   只能 `fetch` → `Blob` → `URL.createObjectURL`（文档同款说法）。项目里落在
   `stores/scene.ts`，换图时 `revokeObjectURL`。
2. **跨域是通的**（2026-11-18 实测）：该域对任意 `Origin` 都回显
   `Access-Control-Allow-Origin`（含 `https://yaoyongcheng.github.io`），预检放行
   `X-API-Key` —— 所以**不需要**像 `/iot-api` 那样加同源反代，GitHub Pages 也能直连。
3. **这张图是 1920×1080 PNG**（2D 3.81MB / 3D 3.25MB），旧的内置图是 1024×642 WebP。
   体积差 30 倍，所以：首页只取 3D 一张；2D 只在真的点「二维地图」时才拉。

### 页面行为

- `stores/scene.ts` 一次会话内每个类型只取一次（并发调用合并成一个 Promise），
  首页与全屏地图的三维共用同一份 objectURL。
- 失败不清图：已成功过的图在刷新失败时保留；本机有落盘兜底图（见下一节）就继续
  用它；两者都没有才回落到内置 `img/site-map.webp` / `img/site-flat.webp`
  （布局与首屏观感不变）。
- 未上传（404）单独记 `empty`，不当作错误反复重试。
- ⚠️ **报警撒点坐标按旧图取景标定**（`Alarm.pin` / `Alarm.flat` 都是百分比）。
  换图后取景若与旧图不同，点位会有偏移 —— 换图后需要人工核一次撒点位置。

### 六点六补：刷新时视角偏移 / 切图闪旧图（2026-11-18 晚）

用户先报「点二维时旧地图短暂闪现」，再报「刷新后 3D 视角偏移」，两者是同一个
根因的两面：**同一个位置上先后出现了两张取景不同的图**。

1. 兜底图与接口图不同源。`public/img/site-map.webp`（1024×642，迁移前的设计稿
   截图）取景更紧，接口图是 1920×1080 更宽；刷新时先出兜底图、3.2MB 到手后再
   切接口图 —— 一次刷新切了两次图，看起来就是「视角偏了一下」。
   **修法**：兜底图改由**同一次接口截图同源导出**（`site-map.webp` /
   `site-flat.webp` 都是 1280×720、16:9，约 132KB / 183KB），与接口图同比例
   同取景。以后接口图若换了取景角度，需要重导这两张（否则又会差一点）。
2. 默认自然尺寸与图不同比例。`MapViewer` 的 `natW/natH` 默认 1024×642（16:10），
   而接口图是 16:9：cover 在同一个容器里裁切方向不同（一个裁上下、一个裁左右），
   首屏会先按旧比例排一帧再重排。**修法**：默认值改成 1280×720，与两张图一致。
3. 换图不是原子的。**修法**：
   - `stores/scene` 加 `settled()`（ok/empty/error 都算有结论）与 `warm()`（置 ok
     前先 `decode()`，最多等 1.2s），页面据此判断「能不能直接切」。
   - `MapLand` 等目标图有结论才翻 `flat`，等待期按钮写「二维加载中」并禁用；
     期间旧图继续显示（清空只会变黑）。报警点坐标与 `.is-flat` 样式跟着一起翻，
     保证撒点与画面永远是同一张图。
   - `MapViewer` 做双缓冲：两张 `<img class="map-base">` 叠在画布里，新图先在
     背层（opacity 0）备好，等它 `load`（像素可渲染、顺带拿到自然尺寸）才把
     `.is-front` 交过去，旧层淡出后清空 src。换图不再有白帧，也不会残留旧图。

自测覆盖：`map-viewer.spec`（默认 16:9 几何常量）、`map-alarm.spec`（切换后
`.map-canvas img.is-front` 才是正射图）、`scene.spec`（等就绪才切）。全量 40 文件
1045 例通过。

### 六点六再补：本地兜底图的比对与自更新（2026-11-18 晚）

需求：**每次取到接口图先和「本地兜底图」比，一样就继续用兜底图、不重写；不一样就
立刻换成新图，并把兜底图替换掉**，下次刷新以最新那张为基准。

#### 兜底图为什么不放在 `public/img`

`public/img/site-map.webp` / `site-flat.webp` 是**构建产物**，静态站运行时没有任何
办法写回自己的发布包（GitHub Pages 上更是只读）。所以「本地兜底图」只能落在浏览器
侧，用 IndexedDB 存 Blob（`utils/sceneCache.ts`）：

| 项 | 值 |
| --- | --- |
| 库 / 版本 | `xyc-scene` / `1` |
| 对象仓库 | `shots`（keyPath 无，key 就是 `'2d'` / `'3d'`） |
| 记录 | `{ blob, hash, savedAt }` |
| 容量 | 两张 PNG 合计约 7MB，按 key 覆盖写，不会越攒越多 |

`localStorage` 不行：3.8MB 单张、上限 5MB、只能存字符串，base64 一膨胀就顶满配额，
还会卡主线程。

#### 一次刷新的完整流程（`stores/scene.ts`）

1. `hydrate()`：先从 IndexedDB 读兜底图，有就**直接上屏**（状态 `cache`）——
   接口那 3MB 还没到时，画面已经是上次最新那张，不是打包老图。
2. `fetchSceneBlob()` 取接口图 → `fingerprint()` 算指纹。
3. 指纹与当前这张（`hashes[type]`，冷启动时由兜底图填充）**相同** →
   不建新 objectURL、不换 `src`、**不写库**。`MapViewer` 的 watcher 不触发，
   画面一帧都不动。
4. **不同**（或本机没有兜底图）→ 新图 `warm()` 解码后立刻上屏、`revoke` 旧的
   objectURL，再把新图 `writeSceneCache()` 覆盖成兜底图。
5. 接口 404 / 空体 / 断网 → 画面保持不动（兜底图或本次会话旧图），状态记
   `empty` / `error`；只有一张都没有时 `src()` 才回落到打包图。这类状态不阻挡
   下一次 `load()` 重试。

`MapLand` 的「二维 / 三维」在 `settled()`（含 `cache`）时直接翻过去，同时
`void scene.load(type)` 后台确认最新：回同一张则零跳变，回新图走双缓冲平滑换。

#### 指纹为什么要自己算

`crypto.subtle` **只在安全上下文存在**，而本项目日常要在局域网
`http://192.168.x.x:5173` 真机调（非安全上下文里它是 `undefined`）；完整 SHA-256
还得把 3.8MB 全读一遍。这里取**首 / 中 / 尾各 64KB** 做双通道 FNV-1a（共 192KB，
同步完成），足以区分「同一次上传」与「重新截的一张」。

判等口径是**字节级**：现场重新截的图即使画面看着一样，PNG 里也会带新的时间戳 /
差分编码，字节不同 → 走换图分支。宁可多换一次，也不让画面停在旧取景上。

#### 降级与边界

- 没有 IndexedDB（隐私模式 / 老 WebView）：退化成**会话内存**，本次刷新仍按缓存
  逻辑跑，只是关掉页面就丢；`writeSceneCache` 如实返回 `false`。
- `open()` 1.5s 超时、读写事务 1.2s 超时：库被别的标签页锁住 / 磁盘满时不能把
  底图加载吊死，超时按「没有兜底图」继续。
- 记录被写坏（没有 blob / 空 blob / 没有 hash）一律当作「没有兜底图」。
- **字节解不出图也算失败**：`warm()` 返回 `ok / bad / unknown` 三态，只有
  `decode()` **明确 reject** 才判 `bad` —— 这张既不上屏也不落盘（否则下次刷新
  会以一张打不开的图当基准）；没有 `decode`、或 1.2s 内没结果都算 `unknown`，
  照常使用（`<img>` 自己还会再解一次，不能因为测不出来就丢正常图）。
- 清站点数据、换浏览器或换设备 → 回到打包图，随后第一次成功取图会重新建立兜底。
- ⚠️ 兜底图只存在**本机这个浏览器**里，不是全项目共享；它保证的是「同一台设备
  刷新时不跳」，不是「所有人看到同一张」。

自测覆盖：`scene.spec`（同图不换不写 / 换图覆盖 / 接口失败用兜底 / 首次落盘 /
reset 后重新 hydrate）、`scene-cache.spec`（假 IndexedDB 走通真实读写路径 +
无库降级）。全量 `npm run build` 通过。

---

## 六点七、视频监控：画面按钮、播放联动与历史抓拍入口（2026-11-18）

### 一、画面区三颗控件（照设计稿 `#camPlayerStage` 还原）

| 控件 | 位置 | 尺寸 / 圆角 | 底色 | 行为 |
| --- | --- | --- | --- | --- |
| `.cam-play`（播放键） | 画面正中 | 68×68、3px 白圈、50% | `rgba(255,255,255,.08)` | 有流→播/停；无流→重取一帧 |
| `.cam-stage-btn`（历史抓拍） | 画面右上 8px | 28px 高、`r-6`、`0 10px` | `rgba(11,18,32,.62)` + `blur(8px)` | 切到历史抓拍视图 |
| `.home-full`（全屏 / 退出全屏） | 同上，间距 6px | 22px 高、`r-8` | `rgba(8,18,32,.55)` | 进 / 退横屏 |

- **文字标签仍然不叠**：`.cam-time`（时间戳）与点位名一个都不放 —— 相机 OSD 已经把
  时间刻在画面里，点位名在顶栏。按钮只占一圈，不挡人挡设备。
- 设计稿这两颗按钮本来**不一样高**（28 / 22），刻意不统一：统一了观感和设计稿对不上。
- 交互态：`hover` 加浓底色、`active` 再深一档（**不写 `transform`**，`:active` 里位移
  会丢 click，`motion-perf.spec` 守着）、`focus-visible` 走全站 `--blue-2` 描边、
  快照取图中播放键 `disabled`。
- 横屏时顶栏浮成渐变遮罩（z-index 3），`.cam-stage-acts` 下移到 `top:52px` 否则被盖住
  看得见点不到；窄屏（≤360px）内距与播放圈各收一档，仍 ≥44px 触控下限。

### 二、播放键 ↔ 视频联动：为什么是「双模」

**服务端没有视频流。** 2026-11-18 复核：

- `/api/video/snapshots/channels` 的返回只有 `channelId / name / status`，**没有任何流地址**；
- `stream / live / play / hls / flv / webrtc / rtsp / snapshots/live`、`snapshots/history`、
  `snapshots/list`、`snapshots/records`、`snapshots/count` 等 20 余条路径 **全 404（nginx）**；
- `/openapi.json`、`/swagger.json`、`/v3/api-docs`、`/docs` 也没有（没有可发现的接口表）；
- V2 Unity 包内同样搜不到 `rtsp/rtmp/ezviz/ys7/flv/m3u8`，`MonitorData.json` 只有一条空记录。

所以播放键做成双模，**不假装**：

1. `streamUrl` 有值才渲染 `<video>`（`data/cams.ts` 的点位 `stream` 字段，或 `.env`
   里配 `VITE_CAM_STREAM_TEMPLATE=https://gw/.../{channelId}.live.flv`，八个点位一次接通）；
2. 没有流 → 播放键 = 「重新取一帧」，无障碍名照实写「重新获取最新画面」。

联动实现要点：

- **状态以媒体元素为准**：`play / playing / pause / waiting / error` 五个事件推进
  store 的 `playState`，按钮图形（三角 / 双竖条 / 转圈）与 `aria-label`（播放 / 暂停）
  全部由它派生 —— 点击只是「请求播放」，不直接改按钮。
- **连点不炸**：`play()` 返回的 promise 被紧随其后的 `pause()` 打断（`AbortError`）时
  `catch` 吞掉，不当故障；`<video>` 用 `:key="camId"` 绑通道，切点位换元素而不是改
  `src`（后者会把上一个通道的缓冲态带过来，正是「连点卡死」的老根因）；快照模式下
  取图中按钮 `disabled`，连点只发一次请求（`stores.spec` 有断言）。
- **流挂了回落快照**：`error` 事件 → `streamBroken=true`，画面区换回 `<img>`（不是留
  一块黑），说明条写「直播流不可用 · 当前为定时快照」，播放键退回取帧模式。
- 切点位 / 关层 / 登出都 `resetPlay()`，不把「在播」带到下一台相机。

### 三、历史抓拍：入口已通，数据待接入

- 按钮 `#btnCamShots`：文案「历史抓拍」、`aria-label="查看历史抓拍照片"`、
  `aria-controls="camShotsView"`、`aria-expanded` 跟视图状态；图标是相册（`gallery`），
  不再是刷新箭头。位置 / 尺寸 / 层级 / 圆角与原来那颗「刷新」完全一致。
- 视图 `#camShotsView` 照设计稿：标题条（`历史抓拍` + `每天 3 张，点开查看照片`）→
  日期芯片 `.cam-day` → 三列照片网格 `.cam-shot-grid`。与画面视图用 `.hide` 互斥
  （不用 `v-if`：画面 `<img>` 一销毁，objectURL 的图要重建，退回来会闪白）。
- **唯一数据接入点**是 store 的 `loadShots()`（`src/stores/cam.ts`，函数里有 ①②③ 三段
  注释标好了）。返回的 `CamShot { id, thumb, url, at, channelId }` 一填，日期分组
  （`shotDays`，按 `at` 倒序）、网格、空态判断全部自动成立，视图不用改。
- 现状返回空列表 + 说明「历史抓拍接口尚未接入」，**不编造照片**；空态文案 +
  `data-empty="cam-shots"` 便于定位。
- 接口一旦提供（按天/按时段），只需在 `api/` 下加一个 fetch 并替换 `loadShots()` 中段。
- 返回键三级：抓拍视图 → 横屏 → 关层。

自测：`cam-player.spec` 23 例（含三颗控件就位、播放联动 5 例、历史抓拍入口 4 例）、
`stores.spec` 48 例（含播放态 4 例、抓拍分组 2 例），`vue-tsc --noEmit` 与
`npm run build` 通过。

---

## 六点八、流媒体地址全量迁移（对齐 V2 · 2026-11-18）

### 一、V2 的证据链（全部来自反编译 + 线上文件核对）

| 环节 | V2 实现 | 结论 |
| --- | --- | --- |
| CDN 根 | `StreamingAssets/CdnConfig.txt` = `http://120.26.34.95:9689` | 与爬架同源 |
| 路径拼法 | `CdnHelper.GetHostServerURL(fn) = 根 + "/CDN/PC/" + fn` | 清单在 `/CDN/PC/monitorData.json` |
| 清单加载 | `MonitorRequester.<LoadMonitorListFromCdnAsync>` → `GetHostServerURL("monitorData.json")` | 静态 JSON，免鉴权、无参数 |
| 清单结构 | `[{ "type":"Null", "monitorName":"地磅全景", "videoPath":["rtsp://…"] }]` | **20 条，全部 RTSP** |
| 地址拼法 | `rtsp://120.26.34.95:554/rtp/{deviceId}_{channelId}?originTypeStr=rtp_push` | deviceId = `42010500441188000001` |
| 播法判定 | `UIPopCCTV.CheckUrlMode(url)`：`url.Contains("flv") ? PlayFlv : PlayRTSP` | 只有 FLV / RTSP 两种 |
| RTSP 兜底 | `HttpFlv2RtspUtil.OpenFfmpeg` + `LinkParameter`（`ffmpeg`、`mediamtx`、`rtsp://localhost:8554/live`） | 桌面端本地起 ffmpeg 转 rtsp 给 mediamtx |
| 萤石云（备用源） | `OpenYs7MonitorModel`：`https://open.ys7.com/api/lapp/token/get?appKey=&appSecret=`；`…/api/lapp/v2/live/address/get?accessToken=&deviceSerial=GG9271178&protocol=2&channelNo=&supportH265=1&quality=1&expireTime=300` | appKey `d0496fc7…` / appSecret `63e5d21b…`；**2026-11-18 实测返回 `{"meta":{"code":-1,"message":"未知错误"}}`，凭据已失效** |

> 线上清单实测（2026-11-18）：`curl http://120.26.34.95:9689/CDN/PC/monitorData.json` 返回 20 条，
> `type` 全为 `Null`，`videoPath` 全为 `rtsp://120.26.34.95:554/rtp/…`，无第二条备用地址。

### 二、本项目落地

| 文件 | 内容 |
| --- | --- |
| `src/api/config.ts` | 新增 `CDN_ORIGIN`、`CCTV_RTSP_ORIGIN`、`CCTV_DEVICE_ID`、`CCTV_FLV_TEMPLATE`、`CCTV_HLS_TEMPLATE`（后两个默认空） |
| `src/data/cctv.ts` | `cctvStreamId()` / `cctvRtspUrl()`（与 V2 逐字同构）、`streamModeOf()`（照 `CheckUrlMode`）、`cctvPlayableUrl()`（网关模板）、`CCTV_V2_NAME`（20 条名称，按 channelId 对齐） |
| `src/api/cctv.ts` | 清单取数：线上 CDN 优先（6s）→ 内置快照（8s）→ null；`parseMonitorList` 按 V2 字段名解析；`channelIdOfEntry` 从 `/rtp/{dev}_{ch}` 取通道号；`pickStreamUrl` 优先 flv、其次 m3u8、最后原址 |
| `public/data/cctv.json` | 上述清单的**真实副本**（20 条），随站点发布，供 HTTPS 页面/断网时兜底 |
| `src/stores/cam.ts` | 打开监控层时 `loadManifest()`（只试一次）；`playUrl` 解析顺序：点位 `stream` 覆盖 → 清单 flv/hls → 网关模板；`rtspUrl` 交出原始地址；`playMode` 判定 |
| `src/components/overlays/CamPlayer.vue` | flv → mpegts.js（动态 import，MSE）；hls/other → 原生 `<video>`；只有 RTSP → 画面下方显示 `仅 RTSP` + 地址行（可选中复制），播放键退回「重新获取最新画面」 |
| `src/data/cams.ts` | 删掉旧的 `camStreamUrl()` / `VITE_CAM_STREAM_TEMPLATE`（与 V2 清单重复的两套机制收敛成一套），`stream?` 只留作单点临时覆盖 |

### 三、移动端能不能播（关键结论）

**RTSP 在任何移动端浏览器里都播不了**，这是浏览器能力边界，不是前端写法问题：
`<video>` 只认 mp4/HLS（iOS 原生）与 MSE 喂进去的 fMP4，没有任何移动浏览器实现 RTSP 客户端。

所以「移动端能播」的前提是**服务端另开一路浏览器可消费的流**，前端已按下面两条接好：

1. **HTTP-FLV**：配 `VITE_CCTV_FLV_TEMPLATE=https://<网关>/rtp/{streamId}.live.flv`
   → 走 mpegts.js（已在依赖里），Android Chrome / iOS 17+ 可播；`{streamId}` = `{deviceId}_{channelId}`。
2. **HLS**：配 `VITE_CCTV_HLS_TEMPLATE=https://<网关>/rtp/{streamId}/hls.m3u8`
   → 原生 `<video>`（iOS 原生支持；Android 需再引 hls.js）。
   模板里也支持 `{channelId}`。

**当前实测（2026-11-18，本项目网络内）**：

| 目标 | 结果 |
| --- | --- |
| `120.26.34.95:80 / :8080` | IIS 10.0（`/rtp/…live.flv`、`/index/api/getMediaList` 均 404） |
| `120.26.34.95:554` | TCP 可连（RTSP），DESCRIBE 无响应/被网络策略挡；即使通，浏览器也用不了 |
| `120.26.34.95:1935` | TCP 可连（RTMP），同样不是浏览器可播协议 |
| `120.26.34.95:10000 / :8081` | TCP 可连但不响应 HTTP（非 ZLM 的 HTTP 端口） |
| 萤石云 token | `code:-1`，凭据失效 |

结论：**ZLM 的 HTTP-FLV/HLS 端口没有对外开**，所以现在移动端拿到的是「定时快照 + RTSP 地址说明」。
让运维在 ZLMediaKit 上开放 HTTP 端口（默认 `http.port`，路径 `/rtp/{stream}.live.flv` 与
`/rtp/{stream}/hls.m3u8`），再把地址填进上面任一环境变量，**不用改代码**即可在手机上出画面。

### 四、自测

`cctv.spec` 13 例（地址同构、播法判定、清单解析、通道匹配、线上→快照降级、内置快照校验）、
`cam-player.spec` 24 例（含「只有 RTSP 时露出地址、不挂 `<video>`」与「有可播地址时不露该行」）、
`stores.spec` 48 例；`vue-tsc --noEmit`、`npm run build` 通过。

---

## 六点九、视频流拉取与播放：把 V2 的生命周期搬到浏览器（2026-11-18）

### 一、V2 的关键流程（反编译 + 线上清单核对）

| 环节 | V2 实现 | 浏览器里的对应做法 |
| --- | --- | --- |
| 取地址 | `CdnHelper.GetHostServerURL("monitorData.json")` → CDN 静态清单，20 条 | `api/cctv.ts`：线上 CDN 6s → 内置快照 8s → null，**永不抛错** |
| 判播法 | `UIPopCCTV.CheckUrlMode`：含 `flv` → `PlayFlv`，否则 `PlayRTSP` | `data/cctv.ts` 的 `streamModeOf()`，另认 `m3u8` |
| 初始化 | `PlayFlv(url)`：给 Unity `VideoPlayer` 设地址 + `Prepare/Play` | `utils/flvStream.ts`：`createPlayer → attachMediaElement → load → play` |
| 状态 | `VideoPlayerProgressController`：视频加载中 / 缓冲中 / 加载失败 | store `playState`：`buffering / playing / paused / error`，全部由媒体事件推进 |
| 异常 | RTSP 失败时 `HttpFlv2RtspUtil` 起本地 `ffmpeg + mediamtx` 兜底（桌面才有） | 浏览器没有 ffmpeg：改成**退避重连 + 回落快照**，并把 RTSP 地址交给人 |
| 销毁 | Unity 切场景 / 关面板时 `Release` 播放器 | `FlvStream.stop()/destroy()`：`pause → unload → detach → destroy` + 清定时器 |

> V2 能播 RTSP 是因为它跑在桌面 Unity 里；浏览器没有任何 RTSP 客户端，
> 所以本项目只认 HTTP-FLV / HLS，这一点在六点八已实测确认（ZLM 的 HTTP 端口未对外开）。

### 二、落地：一个引擎 + 一处状态

| 文件 | 职责 |
| --- | --- |
| `src/utils/flvStream.ts`（新） | FLV 生命周期：连流、12s 无画面超时、2/4/6s 快速退避 + 每 10s 持续重连（**不设上限**）、卡死看门狗、四步释放 |
| `src/stores/cam.ts` | `markConnecting()` / `markReconnecting()`；`playState` 仍是唯一状态源 |
| `src/components/overlays/CamPlayer.vue` | 引擎状态 → store；关层 / 切点位 / 进后台 / 卸载时收连接；`showPlayBtn` 决定播放键显隐 |
| `src/styles/app.css` | `.cam-frame` 绝对定位叠加 + `.is-veiled`（透明度隐藏，不用 `display:none`） |

关键实现点：

1. **打开即起流**（不再需要先点一下）：`muted + playsinline` 允许自动播放；
   被策略拦下时进入 `paused` 态并提示「点击播放键开始播放」，不谎报在播。
2. **状态只由媒体事件推进**：`play / playing / pause / waiting / error` → store；
   `play()` 的 resolve **不算**在播（数据没到它也会 resolve）。
3. **失败一律自动重连，不设上限**（2026-11-18 三改）：
   - FLV：`mpegts ERROR` / `LOADING_COMPLETE` / 12s 无帧 / `<video> error` /
     出过画面后 12s 无新数据（看门狗）统一进 `fail()`，按 2s→4s→6s 快速退避，
     之后**每 10 秒一次持续重连**，直到流回来或画面被关掉；连续失败会把
     「已连续重试 N 次，正在持续自动重连」写进说明条，但状态仍是 `reconnecting`，
     **不是 `error`** —— 这时播放键不出现，用户不需要（也不该）去点；
   - 只连**当前这一路地址**，绝不换源；连上就自动续播（`playing` → `markPlaying`）；
   - 只有「浏览器没有 MSE」「模块加载被环境彻底阻断」这类不可恢复的情况才报 `error`；
   - HLS / 直连：没有重连能力，`error` 回落快照，播放键文案变「重新连接直播流」，
     点击时**换一个 `<video>` 元素**（`:key` 带 `mediaNonce`）重新拉。
4. **重连期间画面退回快照**，但 `<video>` 用 `opacity:0` 蒙起来而**不销毁** ——
   移动浏览器对 `display:none` 的视频会停解码，回来永远等不到 `playing`。
5. **播放键只在「需要人」时出现**（`showPlayBtn`）：播放中与重连中都不画，
   避免遮挡画面、避免被当成「暂停 / 重新连接」反复点；只在快照模式、
   自动播放被拦（`paused`）、环境不可恢复（`error`）时出现。
6. **单实例**：`FlvStream` 的 `connect()` 走单飞（`pending` 折成同一个 Promise），
   同一路重复 `start()` 直接复用；组件侧用 `flvKey = camId|url` + 元素身份做幂等，
   切点位 / 清单晚到 / 前后台切换不会反复 detach-attach（现场表现是画面黑一下），
   也不会让两只 mpegts 播放器抢同一个 `<video>`。
7. **用户意图优先**：`wantPlay` 记住「想看 / 自己按了暂停」，重连成功只在想看时自动播；
   进后台再回来重建实例时，通过 `autoplay` 把这个意图带过去。
8. **释放三处必到**：关层、切点位、页面进后台（`visibilitychange`）。
   FLV 一路 1~4Mbps，切一次点位多挂一根连接，手机上很快就能看出来；
   关层同时 `resetPlay()` 清状态，重连定时器随 `destroy()` 一起清掉。
9. **网络恢复立刻重连**：监听 `online`，不等 10 秒退避 —— 手机上从电梯/地下室
   出来时这是唯一的信号。

### 三、移动端能不能播（结论不变，但链路已就绪）

浏览器能力边界：**任何移动端浏览器都不能直连 RTSP**。所以手机要出画面，服务端必须
另开一路 HTTP-FLV 或 HLS。前端已经把开关留好，**不用改代码**：

```bash
# HTTP-FLV（推荐：Android Chrome / iOS 17+ 都能播，走 mpegts.js）
VITE_CCTV_FLV_TEMPLATE=https://<网关>/rtp/{streamId}.live.flv
# 或 HLS（iOS 原生可播；Android Chrome 还需 hls.js）
VITE_CCTV_HLS_TEMPLATE=https://<网关>/rtp/{streamId}/hls.m3u8
```

`{streamId}` = `42010500441188000001_{channelId}`，与 V2 清单地址里的那一段一致。
2026-11-18 复测：`120.26.34.95` 的 80 / 8080 / 9689 全是 404（IIS），8000 / 10000
不响应 HTTP，554 / 1935 是 RTSP / RTMP。**唯一待办是让运维在 ZLMediaKit 上开 HTTP 端口。**

### 四、自测

- `tests/unit/flv-stream.spec.ts`（15 例）：起播参数、超时收口、2s 退避、
  出画面后计数归零、**快速段用完转持续重连（不停止、不换源、流回来自动续播）**、
  用户暂停后不再重连、暂停掐掉待执行的重连、**卡死看门狗**、
  重复 `start` / 重连与退避撞车只保留一只播放器、无 MSE 直接报错、自动播放被拦、
  `stop` 四步释放、`destroy` 解绑、手动重试清计数。
- `tests/unit/cam-player-flv.spec.ts`（8 例）：打开即起流、出画面切直播态、
  断流回落快照且元素不销毁、**播放中/重连中都不出现播放键**、
  **重连成功自动续播且地址不变**、关层即释放、切到无流点位收掉旧连接、
  进后台断流/回前台接上。
- `cam-player.spec` 24 例（原生流失败改为「元素留着 + 蒙起来 + 播放键=重新连接」）、
  `stores.spec` 48、`cctv.spec` 13、`stage5` 21、`tokens/guards/motion-perf` 全绿；
  `vue-tsc --noEmit`、`npm run build` 通过（mpegts 仍是独立 chunk，272KB 只在真播流时加载）。

---

## 六点十、视频流地址按现场模板全量接通（2026-11-18）

### 一、现场给的模板（逐字，不可改）

```
http://120.26.34.95:9092/rtp/42010500441188000001_34020000001320000005.live.flv?originTypeStr=rtp_push
```

| 片段 | 值 | 说明 |
| --- | --- | --- |
| 协议 / 域名 / 端口 | `http://120.26.34.95:9092` | ZLMediaKit 的 HTTP-FLV 端口（`:554` 是给桌面客户端的 RTSP） |
| 路径前缀 | `/rtp/` | ZLM 的国标推流应用名 |
| 流 ID | `42010500441188000001_{channelId}` | `CCTV_DEVICE_ID` + 20 位通道号 |
| 后缀 | `.live.flv` | 少一个字就变成别的资源 |
| 查询参数 | `?originTypeStr=rtp_push` | **不能省**，少了 ZLM 会当回放请求 |

实测（`curl -r 0-4000`）：`200 video/x-flv`，正文以 `FLV\x01` 开头，
`Server: ZLMediaKit(git hash:1e6a896/…, build 2025-12-20)`，
且回 `Access-Control-Allow-Origin: <请求 Origin>` + `Allow-Credentials: true`
→ **浏览器可直连，不需要同源反代**。

> **该端口不提供 TLS**（`https://120.26.34.95:9092` 连接失败）。当前站点按 HTTP
> 部署（`npm run deploy:http`），所以没有混合内容问题；若将来改回 HTTPS，
> 这条流会被浏览器拦掉，届时需要给 ZLM 配 `ssl` 或用 HTTPS 网关中转。

### 二、改动的文件与入口位置

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `src/api/config.ts` | 新增 `CCTV_FLV_ORIGIN` | 默认 `http://120.26.34.95:9092`，`VITE_CCTV_FLV_ORIGIN` 可覆盖 |
| `src/data/cctv.ts` | 新增 `cctvFlvUrl()` | **唯一的地址拼装点**：`{origin}/rtp/{streamId}.live.flv?originTypeStr=rtp_push` |
| `src/data/cctv.ts` | `cctvPlayableUrl()` | 优先级改为 env FLV 模板 → env HLS 模板 → **默认 `cctvFlvUrl()`** |
| `src/data/cctv.ts` | 新增 `CCTV_CHANNELS` | 现场核对表 20 条（channelId + 名称 + 当日实测有无流），`CCTV_V2_NAME` 由它派生 |
| `src/data/cams.ts` | `CamPoint.stream` 注释 | 说明常态留空，地址由模板逐条拼；该字段只做单点覆盖 |
| `src/stores/cam.ts` | `playUrl` 注释 | 写明三级优先级，并解释为什么跳过 rtsp |
| `src/api/scaffold.ts` | `CDN_BASE` | 去掉硬编码，改为引用 `CDN_ORIGIN`（同一台 CDN 只留一处定义） |
| `.env.example` | 新增小节 | 记录 `VITE_CCTV_FLV_ORIGIN` 与两个模板覆盖项的用法 |

调用方式、数据结构、页面展示**一处未动**：`cam.playUrl / playMode / isLive` 的
签名不变，`CamPlayer.vue` 一行没改，上墙的仍是 `CAM_POINTS` 那 8 个点位。

### 三、20 个通道的替换结果

地址按模板逐条生成，只换中间那段 20 位通道号。当日实测有无流：

| channelId | 名称 | 当日 FLV |
| --- | --- | --- |
| 34020000001310000001 | 监控A | ✅ |
| 34020000001310000002 | 监控B | ✅ |
| 34020000001310000003 | 地磅全景 | ✅ |
| 34020000001320000001 | 4#门安全通道门禁监控 | ✅ |
| 34020000001320000002 | 场内 | ✅ |
| 34020000001320000003 | 2#门监控 | ⚠️ 时有时无 |
| 34020000001320000004 | 4#门外监控 | ⚠️ 按需拉流后恢复 |
| 34020000001320000005 | 材料堆场 | ✅ |
| 34020000001320000006 | 2#门监控 | ✅ |
| 34020000001320000007 | 4#门监控 | ⚠️ 按需拉流后恢复 |
| 34020000001320000008 | 3#门外监控 | 未确认 |
| 34020000001320000009 | 场内 | 未确认 |
| 34020000001320000010 | 1#门安全通道门禁监控 | 未确认 |
| 34020000001320000011 | 1#门监控 | 未确认 |
| 34020000001320000012 | 5#门监控 | 未确认 |
| 34020000001320000013 | 5#门外监控 | 未确认 |
| 34020000001320000014 | 钢筋加工棚 | ⚠️ 按需拉流后恢复 |
| 34020000001320000015 | 安全讲台 | 未确认 |
| 34020000001320000016 | 4#塔吊 | ✅ |
| 34020000001320000017 | 2#塔吊 | ⚠️ 按需拉流后恢复 |

**上墙 8 个点位的对应关系**（`data/cams.ts`，顺序照设计稿）：

| 点位 | channelId | 生成的流地址（后缀统一） |
| --- | --- | --- |
| 2#门监控1 | …13200000003 | `…_34020000001320000003.live.flv?originTypeStr=rtp_push` |
| 2#门监控2 | …13200000006 | `…_34020000001320000006.live.flv?originTypeStr=rtp_push` |
| 4#门监控 | …13200000007 | `…_34020000001320000007.live.flv?originTypeStr=rtp_push` |
| 4#门外监控 | …13200000004 | `…_34020000001320000004.live.flv?originTypeStr=rtp_push` |
| 地磅全景 | …13100000003 | `…_34020000001310000003.live.flv?originTypeStr=rtp_push` |
| 钢筋加工棚 | …13200000014 | `…_34020000001320000014.live.flv?originTypeStr=rtp_push` |
| 2#塔吊 | …13200000017 | `…_34020000001320000017.live.flv?originTypeStr=rtp_push` |
| 4#塔吊 | …13200000016 | `…_34020000001320000016.live.flv?originTypeStr=rtp_push` |

> 2026-11-19 起上墙 **9 个点位**并重排分组（新增材料堆场、设备设施置顶），
> 见本文档末「六点二十四」；上表是当时那 8 个的历史留档，地址拼法未变。

### 四、「首次 404 / 超时」是正常的，不是配错了

ZLM 这台是**按需拉流**（请求进来才去国标设备拉 RTSP 源）。实测同一批通道
隔几分钟再打，404 的会变 200、200 的会变 404：

- 第 1 轮：`13200000004 / 14 / 17` 全 404；第 2 轮：全部 200；
- `13200000003` 第 2 轮 404、第 3 轮连续 3 次连接超时（源端卡住）；
- `13200000007` 首轮 404，之后连续 3 轮稳定 200。

所以**不能把 404 当「永久不可用」**：`utils/flvStream.ts` 的 2s/4s/6s 退避重连
正好覆盖这段拉流时间，重试成功后画面自然出来。这也是为什么播放键在 error 态
仍允许「重新连接直播流」，而不是永久退回快照。

### 五、自测

`cctv.spec` 17 例（新增 5 例：FLV 地址与现场模板逐字同构、20 通道全部可拼且
域名/端口/前缀/参数一致、默认可播、名单 20 条不重复）、`stores.spec` 48、
`cam-player.spec` 24、`cam-player-flv.spec` 6、`flv-stream.spec` 10 全绿；
`vue-tsc --noEmit`、`npm run build` 通过（mpegts 仍是独立 chunk，272KB 按需加载）。

> 组件/状态机用例里把 `cctvPlayableUrl` 压成空串（`vi.mock('@/data/cctv')`），
> 这样「快照模式」「切到无流点位」这些场景仍可构造；真实拼法只在 `cctv.spec` 里钉。

## 六点十一、全设备回到 FLV + 撤掉画面内播放键（2026-11-18 二次定稿）

### 一、结论

现场确认：**不做按机型分流，所有设备统一走 HTTP-FLV**（`cctvPlayableUrl()`），
并且**画面里不再出现播放键**。上一版按机型切 HLS 的实现已整段撤回：

| 已删除 | 说明 |
| --- | --- |
| `CCTV_HLS_ORIGIN` | 配置项一并删掉 |
| `cctvHlsUrl()` / `cctvPreferredUrl()` | 地址拼装回到只有一个出口 `cctvPlayableUrl()` |
| `utils/env.ts` 的 `preferHls()` | 不做协议分流 |
| `CamPlayer.vue` 的 HLS 分支 | 自动起播、每 3s `load()`、`hlsTimer` 全部移除 |

保留 `isAppleMobile()` 与 `stripRetryCount()`：手机端**仍然不显示重连计数**
（删计数的范围后来又扩到「所有手机」，见六点十二）。播放键则对所有设备一视同仁地撤掉。

### 二、播放键：整颗撤掉，能力交给「点画面」

`showPlayBtn` 恒为 `false`（模板那段留着当开关，将来某类设备必须点一下才能起播时
改一行就能放回来）。播放 / 暂停 / 立即重连三种能力改由 `#camPlayerStage` 的
`onStageClick` 承担 —— 内部就是原来的 `onPlay`，语义没变：

| 当前状态 | 点画面 |
| --- | --- |
| 没有可播地址（只有 RTSP / 没清单） | 重新取一帧快照（取图中再点会被 `busy` 挡掉，不堆请求） |
| `reconnecting` / `error` | 立刻重连，不等退避（`flv.retry()` 清零计数） |
| 播放中 | ~~暂停~~ → **什么都不做**（暂停这一条已撤销，见六点十二） |
| 已暂停 | 继续播 |

右上角两颗控件（历史抓拍 / 全屏）点击时冒泡到画面区，`onStageClick` 用
`target.closest('button, a')` 放行，不会「点全屏顺带把画面暂停」。

### 三、无限自动重连（不变）

`utils/flvStream.ts` 本来就是**不设上限**：快速段 2s / 4s / 6s，此后每 10s 一次
持续重连，直到流回来或画面被关掉；网络失败**永不进 `error`**（error 只留给
「没有 MSE / 播放器模块加载失败」这类重试无意义的情况）。`wantPlay` 记住用户意图：
自己按过暂停就不再后台拉流，重新打开 / 切点位则回到「想看」。

### 四、手机端为什么仍然要裁掉计数（范围后来扩到所有手机，见六点十二）

iPhone Safari 没有 mpegts 需要的 `MediaSource`（`ManagedMediaSource` 也不被认），
`isSupported()` 为假 —— FLV 在 iPhone 上**必然**连不上，说明条会一直刷
「第 N/3 次」「已连续重试 3 次」，而且永远等不到「连上」把它盖掉。
所以 `stampText` 在苹果端统一过 `stripRetryCount()`，把次数与倒计时全部裁掉，
只留「出什么事了 + 正在自动重连」；其他设备照旧显示引擎原话（排查有用）。

> 实测记录（留档，当前**不使用**）：同一台 ZLM 的
> `http://120.26.34.95:9092/rtp/{streamId}/hls.m3u8` 返回 `200
> application/vnd.apple.mpegurl`，切片 `ts`、`TARGETDURATION` 约 10s，
> Safari 原生可播。将来若要让 iPhone 真正出画面，这是现成的一条路
> （代价是 4~10s 延迟），但需要现场先确认。

### 五、自测

`env.spec` 9 例（机型判定 5 + 文案去计数 4）、`cam-player.spec` 25、
`cam-player-flv.spec` 10（新增苹果端去计数、其他设备保留原话两条）、
`cctv.spec` 17、`flv-stream.spec` 15、`stores.spec` 49 全绿；
`vue-tsc --noEmit`、`npm run build` 通过，产物里已无任何 `hls.m3u8`，
`120.26.34.95:9092` 与 `live.flv?originTypeStr=rtp_push` 仍在。

## 六点十二、手机端去计数扩到「所有手机」+ 点画面不再暂停（2026-11-18 三改）

### 一、背景：现场三个反馈

1. 换一台安卓手机看，说明条又开始跳「2 秒后自动重连（1/3）」—— 上一版只对
   苹果特判，等于「换台设备就又露出来」；
2. 手机上点一下画面，视频**停了**；
3. 掉线后要能一直自己连回来（这条本来已满足，本轮复验）。

### 二、去计数：判定从 `isAppleMobile()` 换成 `isMobileDevice()`

`src/utils/env.ts` 新增 `isMobileDevice(ua?, touchPoints?)`，三层都要认，
缺一条就会漏掉一整类设备：

| 来源 | 覆盖 |
| --- | --- |
| `isAppleMobile()` | iPhone / iPod / iPad；iPadOS 13+ 自报 `Macintosh` 时靠 `maxTouchPoints > 1` |
| UA 关键字 | `Android`、`Mobile`、`HarmonyOS`、`OpenHarmony`、`Windows Phone`、`IEMobile`、`BlackBerry`、`Opera Mini`、`Kindle`、`Silk`、`Symbian`、`Tablet` |
| `(pointer: coarse)` + 触点 > 0 | 自报桌面 UA 的移动浏览器 / App 内置 WebView |

判定**故意做宽**：它只决定一句话里带不带数字，判宽了没有任何副作用；
判窄了就会出现「这台手机又露计数」。组件里在 `setup` 时算一次
（`const isPhone = isMobileDevice()`），UA 在页面生命周期里不会变，不做响应式。

桌面继续保持引擎原话（`2 秒后自动重连（1/3）`）—— 排查时这是有用的信息。

### 三、点画面为什么会让视频暂停，已经改掉

根因就在组件里，与浏览器无关：`#camPlayerStage` 的 `onStageClick` → `onPlay`，
而 `onPlay` 的兜底分支是「在播就 `pause()`」—— 那是播放键时代的交互
（播/停切换）。按钮撤掉后能力挂到整块画面上，于是「点画面 = 暂停」。
手机上手指落在画面里极其常见（误触、想看清一点、滑动没成），
一停画面就定在最后一帧，看着像卡死。

改法：`onPlay` 只做「加法」，**永不暂停**：

| 当前状态 | 点画面 |
| --- | --- |
| 没有可播地址（只有 RTSP / 没清单） | 重新取一帧快照（取图中再点被 `busy` 挡掉） |
| `reconnecting` / `error` | 立刻重连（`flv.retry()`，不换源、不新建第二条连接） |
| 已暂停（自动播放被策略拦下 / 系统停掉） | 继续播 |
| **正在播** | **什么都不做**（判 `video.paused`，不是判 `playState`） |

连带一处必要修正：`applyStreamState` 的 `case 'paused'` 不再把 `wantPlay` 置 false。
界面上已经没有「暂停」这个动作，能走到 paused 的只剩「自动播放被策略拦下」，
若此时清掉播放意图，之后的断流就**不会重连**了 —— 与「掉线无限重连」直接冲突。
现在只把 paused 记进 store 让说明条说实话，重连意图保持不变。

### 四、无限重连复验（未改动，确认仍然成立）

`utils/flvStream.ts` 的 `fail()` 只有两种出口：

- `attempt < fastRetries`：2s / 4s / 6s 三次快速退避，状态 `reconnecting`；
- 否则：`slow = true`，每 `slowRetryDelay`（10s）再连一次，**永不停止**，
  直到 `playing`（自动续播、不换源）或 `stop()`/`destroy()`（关层、进后台、切换）。

网络类失败（`ERROR`、`LOADING_COMPLETE`、12s 首帧超时、12s 无数据看门狗、
`<video> error`、动态 `import('mpegts.js')` 失败）**全部走 `fail()`**，都不会进 `error`。
`error` 只留给 `isSupported()` 为假（没有 MSE，重试一万次也没画面）。
另有 `window online` 监听：网络恢复时立刻重连，不等那 10 秒。

### 五、自测

- `env.spec` 14 例（新增 `isMobileDevice` 五组：苹果 / 安卓手机与平板 /
  鸿蒙与自带 WebView / 桌面不误判 / 读 `navigator`）；
- `cam-player-flv.spec` 新增 4 例：`播放中点画面不暂停（pause 调用 0 次、连接仍 1 条）`、
  `重连中点画面 = 立即重连（元素不换、地址不变、存活连接仍 1 条）`、
  `安卓手机同样不出现次数`、`桌面保留原话`；
- `cam-player.spec` 把「播放中连点 = 播/停切换」改成「连点不暂停、不重复起流」；
- 全量 45 个 spec 文件 44 通过（唯一红的是 `patrol.spec` 既有的测试隔离问题），
  `vue-tsc --noEmit`、`npm run build` 通过。

## 六点十三、视频链路复核 +「暂停 / 断流」双通道修复（2026-11-19）

现场反馈：iPhone 上看着看着就断、播放不连续，**点一下屏幕才回来**。
按采集 → 传输 → 解码 → 播放四段复核，结论是前三段没问题，问题全在播放层的
状态判定上。

### 一、四段链路复核

| 段 | 实际链路 | 复核结论 |
| --- | --- | --- |
| 采集 | 相机 RTSP → ZLMediaKit 按需拉流 | 正常。ZLM 按需拉流会 404↔200 翻转，属于预期；前端靠重连吃下 |
| 传输 | `:9092/rtp/{dev}_{ch}.live.flv?originTypeStr=rtp_push`（HTTP-FLV 长连接） | 正常。实测 200 + `video/x-flv` + `FLV\x01` 魔数 + `ACAO` 回显 |
| 解码 | mpegts.js → MSE | **参数偏激进**：只开 `liveBufferLatencyChasing` 不给上下限，弱网时反复 seek → 花屏 / 跳帧 / 声音断续，正是「播放不连续」 |
| 播放 | `FlvStream` + `<video>` | **两处致命判定**，见下节 |

### 二、根因（都在 `utils/flvStream.ts`）

**① `play()` 被拒 = 被判成「用户不想看」**

```ts
// 旧：doConnect() 里 await p.play() 失败且未出画
this.wantPlay = false          // ← 把「环境拒绝」记成「用户不想看」
this.clearTimers()
this.emit('paused', '点击播放键开始播放')
```

`wantPlay` 变 false 之后，`fail()` 里有这道早退：

```ts
if (!this.wantPlay) { this.emit('paused', '已暂停'); return }   // 不排重连
```

于是「无限重连」在这台设备上实际失效 —— 不是次数用完，是根本没进队列。
而 iOS 上元素一旦被系统暂停过，无手势的 `play()` 大概率被拒，所以必然走到这里。

**② 看门狗见了 `paused` 直接返回**

```ts
// 旧：checkIdle()
if (this.video.paused) { this.lastDataAt = Date.now(); return }
```

系统把 `<video>` 暂停后（来电、锁屏、切后台、控制中心、低电量、拔耳机），
看门狗每 2 秒进来一次、每次刷新时间戳然后返回：既不判卡死，也不尝试恢复。
两条路同时堵死 → 画面定格在最后一帧，只有手指点一下才动。

> 用户看到的「点击后重新连接」，其实多半只是一次 `play()`，不是重连。

### 三、修复：拆成两条通道

| 现象 | 走哪条 | 行为 |
| --- | --- | --- |
| 连接真的断了（ERROR / 超时 / 看门狗判卡死） | `fail()` | 2s / 4s / 6s → 每 10s，**不设上限**，不换源 |
| 连接还在、只是停着（系统暂停 / 策略拒绝） | `scheduleResume()` | 只重试 `play()`，1/2/3/4s（封顶 5s），**不 teardown、不新建播放器、不改 url** |

具体改动：

- `wantPlay` 恢复为「用户意图」语义：**只有 `pause()` / `stop()` 能改**；
  策略拒绝只记「暂时受阻」，不再改写意图。
- 新增 `scheduleResume()` / `clearResume()` / `resumeTries`：恢复通道，
  连续 `resumeMaxTries`（默认 4）次失败才转 `fail()` 重连（那时多半是解码管线废了）。
- 新增 `<video>` 的 `pause` 监听：`started && wantPlay && hasFrame` 就排恢复。
- 看门狗改判：`paused` 且还想看 → 先排恢复；用户真暂停（`wantPlay=false`）才跳过。
- 新增 `suspend()` / `resume()`：页面切前后台用。暂停但**保留连接与意图**，
  回来 `play()` 直接续，不重建、不黑屏、不需要手势。
- mpegts 追帧加上下界：`liveBufferLatencyMaxLatency: 3.0`、
  `liveBufferLatencyMinRemain: 0.5`，避免追帧过猛反复 seek。

组件侧（`CamPlayer.vue`）：

| 位置 | 旧 | 新 |
| --- | --- | --- |
| `onPlay`（点画面） | 重连中调 `flv.retry()`（拆连接重建） | **重连中什么都不做**；只有 `error` 才 retry |
| `onMediaPause` | 一律 `markPaused()` | FLV 时改 `markReconnecting('画面恢复中…')`，不谎报「已暂停」 |
| `onVisibility` | hidden 立刻 `destroyStream()` | 先 `suspend()`，超过 30s 才释放；visible 时 `resume()` |

### 四、怎么验证

**现场（手机）**

1. 打开任意点位，等画面出现，说明条应为「现场画面 · 直播中」；
2. 下拉控制中心再收起 → 不应断流；即使断了也应在几秒内自己回来，**不用点屏幕**；
3. 锁屏 10s 再解锁 → 同上；锁屏超过 30s 再回来 → 会重建一次，仍不需要点；
4. 飞行模式开 20s 再关 → 说明条出现「正在自动重连」，恢复后自动续播；
5. 全程点画面：不应暂停、不应黑一下、不应出现「重新连接」；
6. 说明条上不应出现任何次数 / 倒计时（手机端统一裁掉）。

**单测**

- `flv-stream.spec`（17 例）：新增「自动播放被拦自己恢复且不重建连接」、
  「系统暂停后自己恢复」「恢复连续失败转重连且仍无限」「挂起再恢复连接不变」；
- `cam-player-flv.spec`（15 例）：新增「重连中点画面什么都不做」、
  「系统暂停说明条写恢复中」、「进后台先挂起」「后台超 30s 才释放」；
- `cam-player.spec` / `stores.spec` / `cctv.spec` / `env.spec` 全绿。

### 五、边界情况

- **iOS 一直不给手势**：恢复通道会一直试（4 次后转重连，再 4 次…），
  界面上是「正在自动重连」，不会假装在播。真起不来时用户点一下仍然有效（那是手势）。
- **后台被系统冻结**：定时器在后台会被节流，30s 释放可能延后到回前台才执行；
  代码里判了 `document.hidden`，回来就不会误销毁。
- **网络恢复事件**（`online`）仍走 `retry()`：那是真断网，重建连接是对的。
- **快照兜底不变**：断流期间画面让给最近一帧快照，重连成功切回直播。
- **不做按机型分流**：所有设备同一条链路、同一套参数。


## 六点十四、主屏安装与独立运行（iOS 18 + 安卓各机型，2026-11-19）

目标：iPhone iOS 18 添加到主屏幕后**独立窗口**运行；小米 / 华为 / OPPO / vivo
等安卓机型同样能装、能独立开、图标和启动画面正常。

### 一、原来的缺口

| 缺什么 | 后果 |
| --- | --- |
| `<meta name="apple-mobile-web-app-capable">` | iOS 点主屏图标仍**在 Safari 里带地址栏**打开，不是独立窗口 |
| `apple-mobile-web-app-status-bar-style` | 状态栏与自绘色条（`--status-h`）关系不确定，顶部可能多出一截 |
| `apple-mobile-web-app-title` | 主屏名取 `<title>`，被截成「向阳村项目智能建造…」 |
| `apple-touch-startup-image` | iOS 独立启动**白屏 1~2 秒**（iOS 不读 manifest 的 background_color） |
| manifest 的 `id` / `start_url` / `scope` | 从监控页添加到桌面后，以后点开直接落在监控层；改 start_url 还会被当成另一个应用 |
| 专用 maskable 图标 | 原 512 主体贴边（约 76% 宽），安卓自适应图标把两端柱子裁掉 |
| 首帧前的骨架 | 从 WebView 首帧到 Vue 挂载这段是白屏 |

### 二、改了什么

| 文件 | 改动 |
| --- | --- |
| `index.html` | 补 4 条主屏 meta + `format-detection`；10 张 `apple-touch-startup-image`（按设备宽高/像素比精确匹配）；app 挂载前的 `#boot` 骨架（内联样式，外链 CSS 没下来时也生效）；12s 未挂载给「重新加载」入口 |
| `vite.config.ts` | manifest 补 `id` / `start_url`（`?from=homescreen`）/ `scope` / `display_override` / `categories` / `prefer_related_applications`；图标区分 `any` 与 `maskable`，补 180 / 152 / 167 |
| `public/` | 新增 `pwa-maskable-512.png`（主体缩进中心安全区）、`pwa-152x152.png`、`pwa-167x167.png`、`startup/*.png`（10 张，共 125 KB） |
| `src/utils/standalone.ts`（新） | `isStandalone()` / `displayMode()` / `isIOS()` / `isAndroid()` / `watchDisplayMode()` / `markEnvironment()` / `hideBootSplash()`；`beforeinstallprompt` 捕获与 `promptInstall()` |
| `src/main.ts` | 挂载后 `markEnvironment()` + `hideBootSplash()` |
| `src/App.vue` | `.app` 加 `has-subpage`，`.phone-screen` 加 `has-home-top` / `has-land-top`（只给旧内核兜底用） |
| `src/styles/app.css` | 新增 `.no-has` 兜底：底栏隐藏、右滑揭示、顶部色条 |

### 三、启动显示分成三段，各管一段

1. **系统启动 → WebView 首帧**：由 `apple-touch-startup-image`（iOS）与
   `background_color`（安卓 12+ SplashScreen）负责，纯色底 + 居中标识；
2. **首帧 → Vue 挂载**：由 `#boot` 骨架负责，同色 `#0b1a2b`，与上一段无缝；
3. **挂载之后**：`hideBootSplash()` 等**两帧**（布局 + 绘制）再淡出 260ms，
   避免「骨架先没了、下面还是白的」那一帧。

### 四、全屏与安全区

- `viewport-fit=cover` 已有；`--status-h: max(32px, env(safe-area-inset-top))`、
  `--safe-bot: max(8px, env(safe-area-inset-bottom))` 已覆盖刘海与手势条。
- 状态栏风格选 **`default`** 而不是 `black-translucent`：后者会把页面顶到状态栏
  下面并要求白字，而工作台 / 消息 / 我的都是白色顶栏，白字会看不见。
- 高度用 `100vh` → `100dvh` 双写（旧内核取前者，新内核取后者）。
- `theme_color` 由 `utils/themeColor.ts` 按视图动态改，状态栏底色始终跟页面一致。

### 五、页面兼容性（重点：`:has()`）

样式表里有 22 处 `:has()`，`:has()` 需要 Chrome 105+ / Safari 15.4+。
小米 / 华为 / OPPO / vivo 自带浏览器仍有一批老内核，命不中时**整条规则被丢弃**，
症状是「子页打开后底栏还露在下面」。

兜底做法：启动时 `CSS.supports('selector(:has(*))')` 检测，不支持就给 `<html>`
加 `.no-has`，CSS 里用等价 class 规则顶上（只兜三条影响可操作性的：
底栏隐藏、右滑揭示、顶部色条）。支持 `:has()` 的设备永远命中不到 `.no-has`。

### 六、异常处理

- SW 注册失败已静默（`utils/pwa.ts` 的 `.catch`），不阻断启动；
- 独立窗口没有地址栏、不能下拉刷新 → 骨架 12s 未挂载时给出「重新加载」按钮；
- 图标 / 启动图缺失只会退化成系统默认，不会白屏；
- `beforeinstallprompt` 必须 `preventDefault()` 才能自己决定时机，
  否则 Chromium 会立刻弹自己的安装条；当前**不主动弹**，只把能力开放给页面；
- iOS 没有 `beforeinstallprompt`，只能「分享 → 添加到主屏幕」，这是系统限制。

### 七、各机型验证要点

**iPhone（iOS 18）**

1. Safari 打开 → 分享 → 「添加到主屏幕」，图标应是三根柱子的标识，名称「数字地图」；
2. 从主屏点开：**没有地址栏**，顶部状态栏与页面顶栏衔接，无多余白条；
3. 冷启动：先出现深蓝启动图，接着深蓝骨架，再淡入首页 —— 全程**不应出现白屏**；
4. 底部手势条区域不压内容（底栏按钮可点）；
5. 锁屏 / 切后台再回来，页面状态与滚动位置保持。

**安卓（小米 / 华为 / OPPO / vivo 自带浏览器 + Chrome）**

1. 菜单里应有「添加到桌面 / 添加到主屏幕」，图标为圆形或方圆自适应形状，
   **主体不被裁切**（验证 maskable）；
2. 从桌面图标打开：独立窗口，无地址栏；
3. 启动：先系统 SplashScreen（深蓝 + 图标），再骨架，无白屏；
4. 打开任意子页 → 底栏应隐藏；右滑返回时底栏随页面揭开（这是 `:has` /
   `.no-has` 两条路径都要验的点，老机型尤其）；
5. 按系统返回键：先退子页，再退首页，不直接退出应用；
6. 微信内置浏览器不支持安装，属预期，引导用系统浏览器打开。

**通用**

- 桌面 Chrome 打开 DevTools → Application → Manifest：无报错、图标全部可加载、
  `start_url` 与 `scope` 正确；
- Lighthouse 的 PWA / Installability 检查应通过。

## 六点十五、历史抓拍：真实快照 + 本机档案（2026-11-19）

### 一、先摆清服务端能做什么

《监控快照接口使用说明-向阳村》第 1、3 节已经写明，2026-11-19 又逐条实测了一遍：

| 能力 | 实测结果 |
| --- | --- |
| `GET /api/video/snapshots?pid&channelId` | 200，直出图片字节（`image/jpeg`，单张约 280KB） |
| 带 `date` / `startTime` / `endTime` 等参数 | **400**「不支持的查询参数，密钥须通过请求头传递」 |
| `/api/video/snapshots/history`、`/list`、`/records`、`/count` | 全 **404**（nginx） |
| 响应头 | `Cache-Control: no-store`，**没有** `Last-Modified` / `ETag`，拿不到拍摄时刻 |
| 服务端是否存历史 | 文档明确「万方只转发、不保存图片、不做历史快照留存」 |

结论：**服务端没有「按天 / 按时段查历史」这回事**，只回「最近一次成功更新」的那一帧。
设计稿里「每天 3 张」来自上游的更新节奏（08:00 / 12:00 / 18:00 各一次），
不是一份可查的列表；参考站那 3 张是 `camShotTimes` 写死 + 图池轮转的演示数据。

### 二、所以历史从哪来：本机档案

`src/utils/shotArchive.ts`（新）把每次取到的快照按**通道 + 更新档**存进 IndexedDB：

- 主键 `通道|日期|档位`，同一档重复取图天然去重；
- 同一档再取到**同样大小**的字节 → 认为服务端还没换图，保留原记录与首次时刻；
  字节大小变了才覆盖（那是真换了新一张）；
- 每档存两份字节：`thumb`（canvas 缩到长边 480 的 WebP，约 20KB）与 `full`（原图）；
- 淘汰：只留最近 30 天（与可选日期范围对齐，见六点十六），总量超 64MB 从最旧删；登出 / 换账号由
  `clearFrames()` 调 `clearShots()` 整层清空 —— 现场照不该留给下一个人；
- 单测 / 老 WebView 没有 IndexedDB 时退内存 Map，行为一致。

档位判定 `slotAt(ts)` 取「最近一次已经发生的更新」：09:19 属于今天 08:00 档，
07:30 仍属于昨天 18:00 档（今天那档还没生成）。

### 三、页面（`CamPlayer.vue` 的 `#camShotsView`）

按设计稿还原并补齐交互：

- 标题条：`历史抓拍` + 右侧「每天 8 / 12 / 18 点更新 · 当天 N 张」
  —— 设计稿的「每天 3 张」改成了真实口径，避免把更新次数说成存量；
- 日期：`今天 / 昨天 / 选日期`（复用 `ui/DayPickChips.vue`）+ `ui/MonthCalendar.vue`
  月历（与航拍、巡检历史同一份组件与样式）；
- 网格：三列 `repeat(3, minmax(0,1fr))`，**列表只挂压缩预览**；
- 三态：加载中一句话 + 转圈（不摆灰方块，灰方块看着像已加载好的图）；
  空态说清「服务端只留最新一帧，这一天本机没有记录」并给「重新获取」；
  失败态显示接口原话（如「上游视频服务异常，请稍后重试」）+ 重试；
- 列表上标的是**档位时刻**（今天 08:00），不是取图时刻 —— 否则会让人以为图是
  打开的那一刻拍的；真实取图时刻写在详情里（「本机 09:19 取得」）。

### 四、详情大图（`#camShotPop`）

默认压缩预览，图片右上角两颗胶囊，交互照智眸（`PatrolSheet.vue`）：

- `查看原图`：换成档案里的原始字节（本机就有，即时切换；已是原图时禁用）；
  左上角角标在「压缩预览 / 原图」之间切换；
- `横屏`：`utils/landscape.ts` 的 `useLandscape`，画布 Teleport 到 body 铺满视口，
  尽力 `requestFullscreen` + 锁方向，拿不到就只铺满（iOS 现状）；
  **z-index 要 96**（`.cam-player` 是 90，照抄智眸的 48 会被整层监控压住 → 横屏黑屏）；
- 缩放：`useImageZoom`（双击 / 双指 / 单指拖动），换图或关层复位；
- 返回键顺序：大图 → 日历 → 抓拍视图 → 横屏 → 关层。

### 五、验证

1. 打开任一监控点位 → 「历史抓拍」：应出现**今天 1 张**（刚抓的那一帧），
   标题右侧写「当天 1 张」；
2. 再进一次：仍是 1 张、时刻不变（同档不重复存）；
3. 点「昨天」：空态只一行「这一天没有抓拍记录」+「重新获取」（不拿今天的图顶替，
   也不写长说明）；
4. 点「选日期」：月历只到本月、**区间是今天往前 30 天** —— 未来日期提示
   「这一天的记录还没生成」，10/21 之前提示「只能查看 10/21 起的记录」；
   翻月按钮卡在区间当月，点不到更早的月份；
5. 点开任意一张：默认「压缩预览」，点「查看原图」角标变「原图」、画面更细腻；
6. 点「横屏」：铺满视口（支持全屏的浏览器同时进系统全屏）；「竖屏」退出；
7. 断网后重进：失败态 + 重试，不再挂灰块；
8. 关掉监控层再进：档案仍在（同一天同一档），换账号登录 → 档案清空。

**已知边界**：换设备 / 清缓存 / 清站点数据后，之前的日期没有记录 —— 这是服务端
不存历史的直接结果，页面会明说，不会用演示图凑。将来万方开了历史接口，只改
`stores/cam.ts` 的 `loadShots()` 里「取数」那一段，视图与档案层都不用动。

## 六点十六、抓拍日期限定近 30 天 + 隐患上报暂缓（2026-11-19）

### 一、日期范围：只放行「今天往前 30 天」

`stores/cam.ts` 新增 `SHOT_RANGE_DAYS = 30`，并派生两个 computed：

- `shotMaxDate` = 今天（`startOfDay`）；
- `shotMinDate` = 今天 − 29 天（含今天正好 30 天）。

写成 computed 而不是常量：应用挂在后台跨零点后「今天」会变，区间要跟着挪一天，
否则第二天早上打开还是只能选到昨天。

**校验只有一个裁决点** —— `setShotDate()`。日期芯片、月历、以后补的任何入口都走它：

| 输入 | 结果 |
| --- | --- |
| 今天 ~ 第 29 天前 | 通过，落 `shotDate` 并查询 |
| 未来日期 | 拦下，toast「不能查看未来日期的抓拍」，原日期与列表不变 |
| 第 30 天前及更早 | 拦下，toast「只能查看近 30 天（M月D日 起）的抓拍」 |

返回 `boolean`：拦下时不闪空态、不发请求，用例也靠返回值断言。

`setShotCalMonth()` 另夹一层，月份翻不出区间当月（组件已禁掉上一月/下一月，
这层是防键盘、防将来补的快捷跳转）。

`ui/MonthCalendar.vue` 新增可选 `minDay` 属性：传了就参与「格子禁用」和
「上一月按钮禁用」，提示语按越界方向分两种 —— 越过上界说「这一天的记录还没生成」，
越过下界说「只能查看 10/21 起的记录」。不传时行为与以前完全一致（航拍、巡检历史不动）。

**档案保留天数同步 14 → 30**（`SHOT_KEEP_DAYS`）：可选日期范围比档案更宽，
用户点进去只会看到一排「没有记录」的死日期。两个常量必须一起改。

### 二、空态不写长说明

按现场反馈去掉空态那句「服务端只保留最近一帧快照、不保存历史；这一天本机也没有
留存记录（本机只存近 30 天）」。现在空态只有「这一天没有抓拍记录」+「重新获取」。
边界说明交给月历的禁用与 toast —— 每次点进空日期都念一遍缘由，既占屏又像报错。
**失败态仍保留原因原话**（那是要排查的信息，不是科普）。

### 三、隐患上报 → 功能待定

`views/WorkPage.vue` 的快捷入口加了 `pending` 字段：

- 隐患上报标 `pending: '功能待定'`，卡片下方显示一枚灰色小胶囊，`aria-label`
  读作「隐患上报（功能待定）」，图标透明度降到 0.55；
- 点击**只 toast**「隐患上报功能待定，留待二期开发」，不打开表单、不复位草稿、
  不发任何请求；
- 表单本身（`HazardPage.vue` + `stores/airHazard.ts`）与单测全部保留 —— 二期
  接了上报接口，把 `pending` 去掉、恢复 `air.openHazard()` 即回到原来的行为。

为什么不是「先留着能填」：没有接口时提交只能假装成功，用户以为报上去了、
实际没人能看到，比不提供更糟。

## 六点十七、航拍照片：站点下拉 + 最新一次采集（2026-11-19）

### 一、口径对齐 V2「任务记录」

V2 的任务记录列表里，每条记录都标了「站点名称」。但记录行本身**没有**
`spotName` 这类字段（2026-11-19 实测，一行只有
`id / uuid / taskId / taskName / start / end / status / pid / dockId`），
界面上那个站点名就是这条航线去掉分隔符后的展示。所以本项目：

- **站点 = 航线（`taskName`）**，`toStations()` 去重 + 按最近一次执行倒序；
- 下拉框选项就是这份清单（现场 11 条：安全巡检 / 土方1 / 全局定点拍照 / 全景 / 正射 / 三维 …）；
- 选中一个站点 → 只看它**最新一次采集**，不再按「今天 / 昨天」翻日历。

日期轴下线的原因：数据单位是「一次采集」，不是「一天」。用日期筛只会筛出
「今天没飞 = 一片空白」（改造前的截图就是 `08/08 无人机定点拍摄 0 张`），
还会和「最新一次」的口径打架。

### 二、取数：三条接口，一条链

```
GET /task/exec/list/record?pid=&start=&end=     V2 任务记录（站点清单 + 各班次）
GET /media/task/job/{记录id}                     这一班的采集文件（只收 image/*）
GET /dashboard/recreate/getProjectRecreateInfo   成果列表 → 该班的 PANO 全景
```

- **最新一次**：`status === 2` 且 `start <= now`，按 `start` 倒序**第一个有图片媒体**
  的班次。实测存在「已完成但 0 条媒体」的班（2026-11-18 08:20 那班），
  直接取最新一条会显示空白，所以往下找，最多探 4 班（keehang 媒体接口限流 42901，
  被拒等 2.2 秒重试一次）。
- **全部照片**：不再截 9 张。全局定点拍照那班正好 9 张，正射那种上百张也照给；
  列表只挂 `thumbnail`（约 440KB）并 `loading="lazy"`，点开才按需换 `url` 原图。
  每班混着的 1 个 `.DAT` 飞行日志不算照片。
- **全景**：V2 的「采集数据 → 全景图片(3)」是按**执行记录**取该批成果，而接口
  **不支持按 recordId 过滤**（带 `recordId` / `recordIds` / `id` 参数返回值一样，
  `taskType` 也同样被忽略），只能按时间倒序翻页自己挑。所以 `fetchRecordPano()`
  做一个会话级索引：`recordId → 最新一条 PANO 成果`，翻过的页缓存复用，
  翻到比目标记录更早的成果就停（没全景的站点只打 1 次）。
  - 只认 `taskType === 2 && status === 2 && projectId === 本项目`（项目守卫不能省，
    成果接口的 pid 不保证被采纳）；
  - 一次飞行有多个全景点（如 `_0 / _1 / _2`）→ 名字排序取第一个，与「项目全景」同一口径；
  - 资源就取截图里那排成果的链接：`thumbnail`（3162×1581，约 185KB）做首屏 / 环视贴图，
    `download`（10000×5000，约 13MB，`origin.jpg`）留给「看高清」；
  - 给 `since`（最新一班减 3 天）兜住「今天刚飞、全景还在拼」—— 能退到上一班的成果；
  - 拿不到全景**不影响照片**：照片先上屏，全景后到；失败只是「没有全景」。

### 三、页面（`AirPlayer.vue`）

- 顶部：`站点` 标签 + 原生 `<select>`（手机上走系统选择器，无障碍语义自带），
  选项就是站点清单；下面一行写「最近采集 11/19 08:20 · 9 张 · 含全景」；
- 网格：**全景排第一格、占满一行（2:1）**，带「全景 · 可环视」蓝标；其余照片 4:3 依次排；
- 三态：加载中一句话 + 转圈（不摆灰格子）；空态「这个站点没有照片」+ 重新获取；
  失败态给接口原话 + 重新获取；
- 大图：照片走原来的平面看（缩放 / 原图 / 下载）；全景走 `ui/PanoViewer.vue`
  —— 与智眸 VR360 完全同一个组件（拖动转头、双指或滚轮改视场角、松手惯性），
  画布右上角三颗胶囊：复位 / 看高清（带真实字节进度）/ 横屏；
- **横屏层级 96**：航拍层是 90，照抄智眸的 48 会被整层遮住 → 横屏只剩黑屏。

### 四、验证

1. 工作台 →「航拍照片」：顶部下拉默认选最近飞过的站点，列表出现该站照片；
2. 选「向阳村-全局定点拍照」：应为 **9 张**（最近一班 11-19 08:20）；
3. 选「向阳村-全景」：第一格是「全景 · 可环视」，下面是这一班的全部采集照片；
4. 点全景：拖动可环视，双指/滚轮缩放，点「复位」回正，「看高清」有进度，
   「横屏」铺满、再点「竖屏」退回；
5. 选「向阳村-安全巡检」等没有全景成果的站点：只有照片，第一格不是全景；
6. 快速连点几个站点：列表跟着最后一次选择，不会串台（响应按序号丢弃）；
7. 断网后重进：失败态 + 接口原话 + 重新获取。

## 六点十八、航拍照片：日期控件恢复 + 原图下载进度（2026-11-19）

### 一、日期控件：原地恢复，没有换组件

2026-11-19 上午先把日期轴取下（改成纯「站点 + 最新一次采集」），随后按要求
**把原来那套控件加回来**：

- `ui/DayPickChips.vue`（今天 / 昨天 / 选日期）—— 组件一行没改，只是重新挂上；
- `ui/MonthCalendar.vue`（全站唯一的 `.cam-cal`）—— 与监控抓拍、巡检历史同一份；
- `data-air-cal-open` 这个展开钩子也照旧。

日期与站点是**两个维度**，同时生效：

| 操作 | 取数 |
| --- | --- |
| 打开页面 / 换站点 | 该站点**最近一次采集**（`fetchLatestGalleryOf`），日期芯片随之落到那一天 |
| 点今天 / 昨天 / 月历某天 | 该站点**那一天**的采集（`fetchStationDay`），同一天飞两班取后一班 |
| 点「重新获取」 | 重取**当前站点当前日期**，不会弹回最新（`refreshAir`） |

### 二、按天查：`fetchStationDay`

```
GET /task/exec/list/record?pid=&start=YYYY-MM-DD&end=次日&size=200
```

- 服务端 `end` **不含当天**，所以查 7/14 要传 `end=2026-07-15`；
- `size` 不生效（返回区间全部），正好一次拿全，不用翻页；
- 过滤链与「最新一次」完全一致：站点名相等 → `status===2` 且已开始 →
  `start` 落在当天 → 按 `start` 倒序探媒体（最多 4 班，撞 42901 等 2.2s）→
  第一个有 `image/*` 的班；
- 没有就返回 `null`，页面给空态「这一天没有航拍照片」，**不拿别的日期凑**。

站点清单的窗口从「30 天没有就退 180」改成固定 **90 天**（`STATION_WINDOW_DAYS`），
日期下界也用它（`airMinDate`）—— 两个数不同源就会出现「日期能选、站点却没在
下拉里」的死区间。校验只有一个裁决点 `setAirDate()`，越界 toast 并返回 false。

### 三、筛选区：同一块，窄屏两行 / 宽屏一行

评估结论：**375 宽塞不进一行**。日期三颗芯片本身约 226px，剩给站点下拉 117px，
「向阳村-全局定点拍照」会被截成三四个字。所以做成：

```css
.air-filter { display: flex; flex-wrap: wrap; gap: 8px; }
.air-pick   { flex: 1 1 200px; min-width: 168px; }
.air-days   { flex: 0 0 auto; }
```

- 手机竖屏（≤ 420）：自动折两行，站点名保留可读宽度；
- 横屏 / 平板 / 桌面：并成一行，下拉自动拉宽；
- 只有一套布局代码，没有两个断点两套样式。

月历从页面末尾移进 `.air-filter`，定位改成 `top: calc(100% + 6px)` ——
两行、一行时都紧贴筛选区下沿，不用为两种高度各写一个固定 top。

### 四、「原图」= 带进度的原图下载

独立那颗「下载」按钮**撤掉**（现场确认不需要）。「原图」按钮沿用 `.photo-bar-btn`
（位置、尺寸、颜色、圆角都不动），交互改成与智眸「看高清」同一套：

1. 点击 → `fetchBlobWithProgress(原图直链)`（4~8MB，OSS 签名链）；
2. 按钮文案：`原图` → `下载中` / `原图 42%` → `已是原图`（其间 `disabled`，防连点）；
3. 进度带：`.hd-progress.is-in-stage` 压在图底边（与全景那条同一样式）；
4. 下完先 `preload` 解码再换源（避免切过去空一帧），然后 toast「原图已加载」；
5. 失败：toast「原图加载失败，请稍后重试」，画面仍留缩略图，按钮回到「原图」；
6. 关弹层 / 换张 → `releaseImgHd()` abort 请求并 `revokeObjectURL`，不留在后台空跑。

为什么不直接把 `src` 换成原图直链：那样没有进度，4G 下停几秒毫无反馈，
用户会以为没点上 —— 智眸全景当初就是为此改的。

### 五、验证

1. 工作台 → 航拍照片：默认站点 + 最近一次采集，日期芯片指的是那一天；
2. 点「昨天」：列表换成昨天的采集；昨天没飞 → 空态一句「…在昨天没有采集记录」；
3. 点「选日期」：月历紧贴筛选区，翻到上个月点某天 → 该天该站点的照片与全景；
4. 横屏 / 平板宽度：站点下拉与日期芯片并成一行，月历仍贴着筛选区下沿；
5. 点开一张照片 → 点「原图」：按钮依次显示「下载中」「原图 42%」「已是原图」，
   底边有进度带，完成后画面变清晰并 toast；
6. 下载中断网：toast 失败，画面仍是缩略图，按钮可再点；
7. 下载中直接关弹层：再打开另一张不会串图（请求已 abort）。

## 六点十九、航拍站点下拉：剔除调试航线 + 外观统一（2026-11-19）

### 一、下拉里不再出现三条航线

V2 任务记录里混着三条没有业务意义的航线，现场截图里排在下拉末尾：

| 航线名 | 为什么去掉 |
| --- | --- |
| `测试` | 联调临时航线 |
| `测试全景` | 联调临时航线 |
| `向阳村-三维（新）` | 与「向阳村-三维（加密）」同片区的重复建图航线，两条并排容易选错 |

收敛点在 `api/drone.ts`：`HIDDEN_STATIONS` + `isHiddenStation()`，在
`toStations()` 分组时跳过。比较前去掉所有空白并把半角括号归到全角，避免接口
多一个空格、换个括号就漏掉。

只过滤**下拉选项**，不拦数据：按名字直接调 `loadStation()` 仍取得回那一班
（真有人现场要查时不用改代码）。清单在 store 里缓存 5 分钟，改完要刷新页面才看到。

### 二、外观：与日期芯片同一套语言

改动前下拉比芯片高 4px、字重 600 到底，站在同一行里比别的控件「重」。
现在统一到：白底（`--surface`）、1px `--line`、圆角 `--r-8`、13px、
32px 高 —— 日期芯片在 `.air-filter` 内也同步到 32（`.air-filter .cam-day`，
别处仍 30px），两行布局时上下两组等高。

| 状态 | 表现 |
| --- | --- |
| 默认 | 白底 + 1px 描边，`font-weight: 500`，长名 `text-overflow: ellipsis` |
| 悬停（仅 `hover: hover`） | 描边转淡蓝 + `--sh-1`；触屏不触发，避免选完还浮着阴影 |
| 按下 | 底色压到 `--surface-2`，不做位移（`:active` 里禁 transform） |
| 聚焦 / 展开 | `focus-within` 淡蓝描边 + 箭头翻成向上；键盘 `focus-visible` 再加 3px 淡蓝环（与登录框同口径） |
| 选中 | 值本身左对齐 500 字重；桌面端 `option:checked` 蓝色 600 |
| 禁用 / 无站点 | 底色 `--surface-2`、文字 `--muted`、箭头一并变淡，`cursor: not-allowed` |

箭头不再用 `▾` 字符（各系统字体大小、基线不一，和 13px 文字并排总差半像素），
改成 CSS 画的 7px chevron（右下两条边转 45°），`focus-within` 时转 225°。

`option` 的样式只有桌面端（Chrome / Edge / Safari 部分）吃得到，移动端弹的是
系统选择器 —— 这不是缺陷，是选原生 `select` 换来的手感与无障碍语义。

间距顺带调了一档：`.air-filter` 的 `gap` 从 `8px` 改为 `10px 8px`（行距 > 列距，
折两行时看得出是两组条件），上下内边距 `4px 12px 9px`。

## 六点二十、日期与站点解耦：默认今天，切站点不动日期（2026-11-19）

### 一、缺陷

用户选 11/10 看照片 → 在下拉里换站点 → 列表变成新站点**最近一次采集**，
日期芯片被悄悄改成该次采集的日期。根因在 `pickStation()`：

```ts
// 修复前
function pickStation(name: string) { void loadStation(name) }  // 不带 day
// loadStation 成功后又用接口回传的 g.start 反推并覆盖 airDate
```

「取该站点最近一次」本身没错，但它把一个**用户已经表达过的意图**覆盖掉了。

### 二、定稿：日期默认今天，任何自动行为都不改

页面所有入口都显式带上 `airDate`：

```ts
pickStation(name) → loadStation(name, airDate.value)      // 换站点，日期不动
refreshAir()      → loadStation(station.value, airDate.value)  // 重试，日期不动
loadStations()    → loadStation(keep, airDate.value)      // 重进页面，日期不动
```

| 入口 | 日期 |
| --- | --- |
| 首次打开 | **今天**（`airDate` 初值），不再按最近一次采集回填 |
| 切站点 / 重新获取 / 重进页面（TTL 到期） | 保持当前值 |
| 今天 / 昨天 / 月历 | 用户指定 |

**演进过程**（两次都被现场打回，记下来免得再犯）：

1. 最初 `pickStation` 不带 day → 日期被「最近一次采集」覆盖，用户选的 11/10 变昨天；
2. 改成「用户没显式选过就跟新站点最近一次」→ 首次打开切「向阳村-全景」，
   芯片从今天跳成昨天 —— 用户视角仍是「我什么都没动，日期自己变了」；
3. 定稿：连「首次打开回填最近一次」也去掉。用户的心智是「日期是筛选条件，默认今天」；
   打开时站点自动选最近飞过的那个，日期就是今天，今天没飞就给空态。

`loadStation()` 的 `day` 参数从此只有页面显式传入；不带 day 的兜底路径
（取最近一次 + 用 `start` 回填日期）只剩工具调用与单测在用。
`datePicked` 标记**已删除** —— 所有入口都保持日期，不再需要判断「谁改过」。

代价：早上还没飞时打开页面会是空态（「今天没有航拍照片」+ 最近一次是哪天），
这是「日期即筛选」的必然结果；换日期仍然只是一次点击。

### 三、新站点没有那一天的数据

不自动跳到最近一次（那等于第二次覆盖日期），而是：

- 日期芯片**停在当前那天**；
- 空态标题跟着日期走：`{{ airDateLabel }}没有航拍照片` →「今天没有航拍照片」；
- 正文：

  > 向阳村-安全巡检 昨天没有采集记录（最近一次 11/08），换个日期或站点看看

括号里那句由 `lastStartOf(name)` 从**已加载的 90 天任务记录**里算，零额外请求。
用户由此知道该往哪天翻，不用在月历上逐天试。

### 四、回归验证

1. **首次打开航拍照片**：日期芯片是「今天」，不因最近一次采集在昨天而变；
   今天没飞 → 空态「今天没有航拍照片」；
2. 第一次打开 → 直接切「向阳村-全景」：日期仍是「今天」，不跳成昨天；
3. 点「昨天」→ 切任意站点：仍是「昨天」，列表是该站点昨天的照片；
4. 切到一个昨天没飞的站点：空态文案含「（最近一次 MM/DD）」，日期不变；
5. 选 11/10 → 切站点 → 再切回原站点：仍是 11/10；
6. 选 11/10 → 关层 → 等 5 分钟以上重开：仍是 11/10（重进页面不重置日期）；
7. 点空态的「重新获取」：重取当前站点当前日期，不弹回最新；
8. 连点两个站点（快速切换）：只显示最后选中的那个站点，无串台。

## 六点二十一、航拍照片：渲染分片（首屏 8 张 + 滚动续铺，2026-11-19）

### 一、先说结论：服务端不能分页

`GET /media/task/job/{执行记录id}` 的响应是**裸数组**（`DroneMedia[]`），
没有 `{list,total}` 信封，也没有 `page` / `size` / `offset` 之类的入参 ——
2026-11-19 复核 `fetchMediaJobs()`：`Array.isArray(raw)` 为真才解析，其它形状
一律当空。也就是说：

- 拿不到「共 N 张」，无法算页数；
- 传任何分页参数都不会减少返回条数（`/task/exec/list/record` 的 `size` 不生效
  是同一类问题）；
- 一次调用必须回整班媒体清单。

所以「下滑请求下一页」在这个接口上**没有请求可发**。

### 二、能做到的部分：分页落在渲染层

网格实际渲染的是 `airList` 的**前缀**，数据仍一次取回：

| 状态 | 位置 | 说明 |
| --- | --- | --- |
| `airShown` | `stores/airHazard.ts` | 已铺条数，初值 `AIR_PAGE_SIZE = 8`，追加 +8 |
| `airListShown` | 同上（computed） | `airList.slice(0, airShown)`，下标与 `airList` 一致，弹层索引不用换算法 |
| `airHasMore` / `airRemain` | 同上 | 底部按钮 / 哨兵显隐、文案 |
| `loadMoreAir()` | 同上 | 唯一追加入口：`busy` 挡同帧连发，`airPageSeq` 挡「等待这一帧时换了站点/日期」 |
| 触发 | `components/overlays/AirPlayer.vue` | `IntersectionObserver`，`root` = `.air-grid`（它自己 `overflow:auto`），`rootMargin` 底部 240px（约两行提前量） |

要点：

- **不改数据结构**：`airList` 仍是「全景第一 + 全部照片」，页头 `airHint` 的张数
  仍是这一班的总数；分页只决定「铺几条 DOM」。
- **不重复请求**：`loadMoreAir()` 里没有网络调用（单测断言媒体接口调用次数不变），
  只有 `await nextTick()` 让「正在加载更多」真出现一帧、并合并同帧多次触发。
- **不重复渲染**：卡片 key 从下标改成内容 id（`photoId` / `'pano'`），追加下一页时
  前 8 张 identity 不变；换站点 / 换日期时 `airState` 先变 `loading`，网格整块卸载，
  新列表从首屏重新铺，连带滚动位置也回到顶部。
- **观察器不可用时**：`typeof IntersectionObserver === 'undefined'` 直接不装
  （老 WebView、happy-dom），底部那颗按钮点一下同样追加 —— 功能不依赖观察器。
- **矮内容自动补页**：首屏 8 张若撑不满一屏（大屏横屏），哨兵一开始就在视野内，
  会再追加一页直到撑满或铺完。这是期望行为，不是重复触发。

### 三、三种状态怎么落地

| 状态 | 表现 |
| --- | --- |
| 加载中 | 底部按钮变「正在加载更多…」+ 小转圈（`.cam-shots-spin`），`aria-disabled` 挡重复点；网格不遮罩、不影响已有的 8 张 |
| 没有更多 | 按钮整条换成一行灰字「已显示全部 N 张」（`.air-more.is-end`），哨兵同时被 `v-if` 摘掉、观察器断开 |
| 请求失败 | **分页这一层不存在失败**——它不发请求。真正的失败只有「取整班」那一次，仍走原有 `airState === 'error'`：标题「航拍照片加载失败」+ 接口原话 + 「重新获取」。单张图坏掉由 `SmartImg` 的占位兜底，不会让整页变错误态 |

若将来媒体接口补了 `page/size`，只改 `loadMoreAir()` 的函数体（发请求、失败置
`airMoreErr`），`airShown / airHasMore / airRemain / busy` 这套状态和组件模板都不用动。

### 四、回归验证

1. 选「向阳村-全局定点拍照」（9 张）：首屏 8 格 + 底部「加载更多（还有 1 张）」；
   滑到底自动补出第 9 张，底部变「已显示全部 9 张」；
2. 选正射那种上百张的站点：首屏只有 8 张，滑到底一次多 8 张，滚轮 / 手指都能触发；
3. 首屏 8 张时直接拉到底再回顶：不会一次性把全部图片铺出来；
4. 翻到第 3 页 → 切站点：新站点从 8 张开始、滚动位置在顶部；
5. 翻到第 3 页 → 换日期：同上，且底部文案按新的一天重新算；
6. 手机横屏 / 大屏：8 张撑不满会自动续一页，直到撑满或到底；
7. 点开任意一张（含第二次追加出来的）：大图标题与内容对得上，不再是别的照片。

## 六点二十二、航拍站点下拉：按微信（WeUI）「选择行」统一外观（2026-11-19）

### 一、先回答「微信有没有下拉框样式可参照」

**没有。** 微信的设计体系里不存在「下拉浮层 / dropdown」这种控件：

| 微信里的控件 | 形态 | 能否照搬 |
| --- | --- | --- |
| 小程序 `<picker>` / WeUI `.weui-picker` | 底部弹出**滚轮**（240px 高、每行 56px、带渐变遮罩与选中指示线） | 不能：那是另一套交互，且手机上的原生 `<select>` 本来就是系统滚轮 |
| WeUI `.weui-actionsheet` | 底部操作面板（iOS 上滑 / 安卓居中弹窗） | 不能：用于「选项带取消」的场景，不是取值控件 |
| WeUI `.weui-cell`（表单/列表行） | 白底整行、左侧标题、右侧值 + 灰箭头，点击进入下一页或弹选择器 | **可以**：取值控件唯一有参照价值的视觉 |

所以本次参照的是 **`.weui-cell` 的「选择行」视觉语言**，套在现有的 32px 触发器上，
而不是去仿一个微信根本不存在的浮层。

### 二、具体对齐了哪些属性

| 维度 | 改前 | 改后（微信口径） |
| --- | --- | --- |
| 字体 | 13px / 500 | **14px / 400**（微信表单正文是 regular，17px；这里按 32px 控件等比缩） |
| 文字色 | `--text` | `--text`（`#1D2129` ≈ 微信 `#191919`） |
| 占位 / 无站点 | `--muted` | `rgba(0,0,0,.35)`（微信 placeholder） |
| 边框 | 1px `--line`（带蓝味的浅灰） | **1px `rgba(0,0,0,.08)`** 中性描边（微信 cell 的分割线是 `rgba(0,0,0,.1)`） |
| 圆角 | `--r-8` | 不变（微信卡片 8~12；必须与日期芯片一致） |
| 阴影 | hover 时 `--sh-1` | **全部去掉** —— 微信的列表/表单不浮 |
| 内边距 | 左 12 / 右 30 | 左 14 / 右 30（微信 cell 左右 16，这里给箭头留位） |
| 悬停（桌面） | 描边转淡蓝 + 投影 | 描边 `.12` + 底色 `rgba(0,0,0,.03)`（换底色，不换颜色倾向） |
| 按下 | `--surface-2` | 不变（`#F2F3F5` ≈ 微信 `#ECECEC`） |
| 展开 | 描边转淡蓝 + 箭头翻起 | **只翻箭头**，描边略加深到 `.16`，不出现蓝色 |
| 键盘聚焦 | 3px 淡蓝环 | 保留（无障碍要求，仅 `focus-visible`） |
| 选中项（桌面面板） | 蓝色 + 600 | 同文字色 + 500（微信没有「选中变品牌色」） |
| 禁用 | 灰底 `--surface-2` | **白底 + 文字 26% 黑**（微信禁用只压文字，不变灰底，避免看着像骨架屏） |
| 箭头 | 7px / `--muted` / 展开变蓝 | **6px / `rgba(0,0,0,.3)`** / 展开不变色（微信 chevron 是 30% 黑的细线） |

另外给 `<select>` 补了 `:title`（桌面 hover 可看完整站点名）—— 14px 下
「向阳村-全局定点拍照」这类长名在窄屏仍会被 `text-overflow: ellipsis` 收尾。

### 三、刻意不做的

- **不换成自绘 picker**：手机端原生 `<select>` 打开的就是系统滚轮，与小程序的
  `<picker>` 是同一种交互；自绘一套只会多一份手势代码与无障碍负担。
- **不引入微信绿 `#07C160`**：本项目强调色是蓝，绿色在筛选区会与日期芯片的
  选中态抢注意力。微信自己的表单控件也不用绿色。
- **不改 32px 高度**：`.air-filter .cam-day` 也是 32，窄屏折两行时两行必须等高。

### 四、验证

1. 桌面（Chrome）：悬停只变浅灰底、无阴影；点开后箭头翻上、描边略深，没有蓝边；
2. 键盘 Tab 到下拉：仍有淡蓝环（`focus-visible`）；
3. 手机：点开是系统滚轮（与小程序的 picker 同形），松手后无残留 hover 底色；
4. 没有站点时：白底 + 淡字「暂无站点」，看着像「还没选」而不是「正在加载」；
5. 与同排日期芯片仍等高、圆角一致，窄屏两行 / 宽屏一行都不错位。

## 六点二十三、航拍站点下拉再剔三条：只留「拍照站点」（2026-11-19）

现场要求把 `向阳村-安全巡检`、`向阳村-三维（加密）`、`向阳村-环绕视频`
也从下拉里去掉。连同六点十九已剔的三条，`drone.ts::HIDDEN_STATIONS` 现在是：

| 航线 | 为什么不出现在下拉 |
| --- | --- |
| `向阳村-安全巡检` | 内部巡检航线（一圈 11 分钟），产出是巡检记录，不是站点照片；区域与「全局定点拍照」大量重叠 |
| `向阳村-三维（新）` / `向阳村-三维（加密）` | 同一片区的重复建图航线，并排摆着容易选到没数据的那条 |
| `向阳村-环绕视频` | 视频航线（`video/*`），本来就没有照片可看 |
| `测试` / `测试全景` | 联调临时航线，无业务含义 |

**口径**：下拉的语义 = 「拍照站点」，一条航线一个站点。所以过滤条件不是
「这条航线有没有问题」，而是「它是不是一次能看照片的定点采集」。

**范围不变**：只过滤下拉选项（`toStations`），不拦数据 —— `loadStation(name)` 仍能按
名字取到任何航线；巡检模块（`stores/patrol.ts`）、航线统计（`data/config.ts` 的分类
映射）都照旧使用这些航线名，不受影响。

**行为变化**：这几条被剔除后，默认选中的站点（`stations[0]`，按最近一次采集倒序）
会自动顺延到下一条；日期仍固定今天，不受影响。

验证：航拍照片 → 展开下拉，只剩定点拍照类站点（全局定点拍照 / 塔吊定点 / 土方…），
上面三条不再出现；`tests/unit/drone.spec.ts` 新增一条「下拉只留拍照站点」用例，
并覆盖半角括号 `向阳村-三维(加密)` 与前后空白的归一化匹配。

## 六点二十四、视频监控：设备设施置顶 + 出入口管控改名 + 新增材料堆场（2026-11-19）

### 一、分组怎么变的

| 组 | 点位 | 变化 |
| --- | --- | --- |
| **设备设施**（置顶） | 2#塔吊 / 4#塔吊 / 地磅全景 / 钢筋加工棚 | 原「塔吊」2 条 + 原「场内」2 条合并成一组，并按现场要求在页面第一组 |
| **材料堆场**（新） | 材料堆场 `34020000001320000005` | 新增点位，独立一组（只有这一路） |
| **出入口管控** | 2#门监控1 / 2#门监控2 / 4#门监控 / 4#门外监控 | 原「出入口」**改名**，点位、顺序、channelId 都不动 |

上墙总数 8 → **9**。`CamGroup` 联合类型与 `data/cams.ts::CAM_GROUPS` 同步为
`['设备设施', '材料堆场', '出入口管控']`；组件仍是 `v-for="g in cam.grouped"`，
不参与排序，所以「置顶」只是数组第一位，没有额外的 CSS order。

默认选中仍是 `CAM_POINTS[0]`，因此现在打开就是 **2#塔吊**（与设计稿一致）。

### 二、材料堆场这一路是实测过的，不是照抄通道表

| 项 | 实测（2026-11-19 15:35） |
| --- | --- |
| 快照 | `GET /api/video/snapshots?pid=P000000076&channelId=34020000001320000005` → **200 `image/jpeg`，288,964 字节** |
| 直播 | `GET :9092/rtp/…_34020000001320000005.live.flv?originTypeStr=rtp_push` → **200 `video/x-flv`，首字节 `FLV`** |

也就是说：直播走既有 `cctvPlayableUrl()`（`data/cctv.ts` 里这条通道本来就标了
`flv: true`），快照走既有 `api/camsnap.ts`，**没有为它新写任何请求分支**。
历史抓拍照旧：服务端只有最近一帧，历史靠本机 `utils/shotArchive.ts` 的 IndexedDB
档案（近 30 天、08/12/18 三档），所以这个点位上线当天开始积累，之前没有历史。

### 三、没动的地方

- 播放/重连仍是 `utils/flvStream.ts` 那一套（打开即连、无限重连、点画面不暂停）；
- 历史抓拍的日期轴、三态、压缩预览、详情「查看原图 / 横屏」一律照旧；
- 报警侧 `channelNo` 与 `CAM_PLACE` 映射不动（那是另一套编号，见 `data/cams.ts` 头注释）。

### 四、验证

1. 打开视频监控：第一组就是「设备设施 4」，芯片顺序 2#塔吊 / 4#塔吊 / 地磅全景 / 钢筋加工棚；
2. 第二组「材料堆场 1」，点开有画面（直播 FLV），右上「历史抓拍」能进、当天有帧；
3. 第三组「出入口管控 4」，四颗芯片与原来一致；
4. 切点位时顶栏标题、芯片高亮、播放态复位都跟着走。

`cam-player.spec.ts` 的「分组渲染」用例已改为 9 个点位 + 新组名，索引点击改用
新位置；`cam-player.spec / cam-player-flv.spec / cctv.spec` 61 passed，
`vue-tsc --noEmit`、`vite build` 通过。

## 六点二十五、列表图标位换成「详情页那张抓拍图」的缩略图（2026-11-19）

### 一、改了哪三处

| 位置 | 文件 | 原内容 | 现在 |
| --- | --- | --- | --- |
| 报警预警列表（今日 / 历史） | `components/ui/InspectItem.vue` | `.insp-pic` 是分类示意图 `img/alarm-*.webp` | 该条报警详情页那张抓拍图的缩略图 |
| 消息页每条消息 | `views/MsgPage.vue` | `.msg-ico` 里一颗监控图标 | 同上；取到图之前仍是那颗图标 |
| 首页「报警预警」轮播 | `views/home/parts/AlarmFeed.vue` | `.alarm-feed-pic` 分类示意图 | 同上 |

三处**只换图片内容**：容器尺寸（48 / 44 / 42px）、圆角、间距、层级、点击与
键盘交互、文字与角标一律未动。图片用 `object-fit: cover` 铺满容器——等比裁切，
不拉伸变形；消息那颗图标框新加 `.msg-shot { width:100%; height:100%;
object-fit:cover; border-radius:inherit }`，其余两处沿用原有 `.insp-pic /
.alarm-feed-pic` 的 `cover`。

### 二、图片从哪来：与详情页同一个接口、同一张图

详情页 `views/sub/AlarmDetail.vue` 走 `fetchAlarmPicture(token, remoteId)`
（`GET {8085}/api/video/alarms/{id}/picture` → `data.pictureData` base64）。
列表这里**复用同一个函数**，因此「列表里的那张」与「点进去看到的那张」必然是
同一张图，不存在两套取图口径。

### 三、为什么不能「渲染即请求」

单张抓拍图实测约 1MB（base64 约 101 万字符）。报警预警列表一屏几十条、
消息页一次 20 条、轮播每页 3 条 × 多页 —— 全量请求等于一进页面几十兆流量。

分三层收着：

1. **只给快滑到眼前的行发请求**：`utils/thumbReveal.ts`，全站共用一个
   `IntersectionObserver`（`rootMargin: 240px`），触发即 `unobserve`；元素被卸载
   （列表换日期 / 换页）时在回调里顺手解除观察，不留强引用。老 WebView 没有
   该 API 时退化成「只加载前 30 条」。
2. **同一个 id 只请求一次**：`stores/alarm.ts` 的 `thumbs / thumbFailed /
   thumbWaiting / thumbQueue`，`THUMB_PARALLEL = 2` 限并发。同一条报警同时出现在
   首页、消息、列表时共用一份结果。
3. **落库前先缩小**：`utils/imageThumb.ts::shrinkDataUrl()` 用 canvas 缩到长边
   144px（约 8~12KB）。**缩不了就把原图当缩略图**——没有 canvas 2D、解码失败、
   1.5s 超时都退回原 URL，页面不会因为「优化失败」变空。

### 四、没有图怎么办

- 接口没有 `pictureData` / 请求失败 → 该 id 进 `thumbFailed`，**不再重试**
  （否则每次滚动都会重打一次必然失败的请求）；
- 页面继续显示原来的分类示意图 / 图标（即「保留现有占位展示」）；
- 未登录、非视频报警（没有 `va-` 远端 id）直接不发请求；
- 登出 `clearLive()` 会连缩略图一起清空，并用代际号丢弃在途结果 —— 不把现场
  照片留给下一个人。

### 五、验证

1. 报警预警（今日 / 历史）：每行左侧是与详情页一致的现场照片；往下滚才陆续出图，
   不会一进页面就把整屏都拉一遍；
2. 消息页：图标位变成同一条报警的照片；点进详情看到的是同一张；
3. 首页「报警预警」轮播：第一页三张先出图，横滑到下一页再取；
4. 找一条没有抓拍图的报警：左侧仍是分类示意图 / 图标，不会出现破图；
5. 登出后重新登录（换账号）：列表不会残留上一个账号的现场照片。

`tests/unit/alarm-thumb.spec.ts`（5 例：三处引用只打一次、无图不重试、无 token /
非视频报警不发请求、登出清空、缩不了退回原图）通过；
`video.spec / msg-paging.spec / stores-views.spec / guards.spec` 112 passed，
`stage5.spec / interaction.spec / tokens.spec / motion-perf.spec` 94 passed；
`vue-tsc --noEmit`、`vite build` 通过。

## 六点二十六、报警图标位统一为「蓝底摄像机」，行首红色竖条下线（2026-11-19）

### 一、统一成哪一枚图标

现场给的样图是一枚**蓝底圆角方块 + 白色摄像机线稿**，与本项目消息页
`.msg-ico.video`（`--blue` 底 + `work-cam` 图标、22/44 = 50%）完全一致，
所以不新增图片资源，直接把这套语言做成一个公共类：

```css
.alarm-tile { display: grid; place-items: center; background: var(--blue); }
.alarm-tile svg { width: 50%; height: 50%; }
```

宽高、圆角、`flex-shrink` 全部沿用**所在位置原有的容器类**，
所以三处看起来是同一枚图标，版式一处没动：

| 位置 | 容器 | 尺寸 / 圆角 | 原来显示的 |
| --- | --- | --- | --- |
| 报警预警列表（今日 / 历史） | `.insp-pic` | 48px / `--r-8` | `img/alarm-*.webp` 分类示意图 |
| 首页「报警预警」轮播 | `.alarm-feed-pic` | 42px / `--r-8` | 同上 |
| 消息页每条消息 | `.msg-ico` | 44px / `--r-12` | 已经是这枚图标（本次不变） |

### 二、为什么要换掉分类示意图

那 4 张图（`alarm-net / cable / soil / trash.webp`）是**按分类挑的示意图**，
画得却像真实现场——列表里和真抓拍图并排时，用户会把它当成「这条报警的照片」。
现在规则只剩两条：**有抓拍图就铺图，没有就铺统一占位图标**，一眼能分辨。

配套改动（数据层一起收口，避免留下「有字段没人用」的残留）：

- `types.ts::Alarm` **删掉 `img` 字段**（注释里写明原因）；
- `utils/videoAlarm.ts` 的 `STYLE` 只留 `title`，不再挂图；
- `public/img/alarm-*.webp` 四张文件**物理删除**（`guards.spec` 的引用清单、
  孤儿资源守卫同步更新；`utils/videoAlarm.ts` 因此退出「图片引用点」清单）；
- `AlarmDetail.vue` 的缩放重置从 `watch(alarm.img)` 改为 `watch(alarm.id)`。

### 三、红色竖条

`.alarm-feed-item::before` / `.insp-item::before` 那根 2px × 26px 的色标
（`--tone` 分档）整层删除，`[data-tone="guard|power|dust|env"]` 四条变量赋值
一并删掉 —— 现场反馈它离图标太近，看起来像「图标前多了一条红线」，与缩略图
并排时更像加载失败的竖条。

保留 `data-tone` 属性本身（`utils/alarmTone.ts` 的分档语义仍然成立，只是不再
有视觉落点），也保留 `.alarm-feed-item, .insp-item { position: relative }`
（列表行里的时间、角标等绝对定位子元素依赖它）。

### 四、回归

1. 报警预警（今日 / 历史）：每行左侧是抓拍缩略图；没有抓拍图的行走蓝底摄像机图标；
   行首不再有红 / 橙 / 蓝色竖条；
2. 首页「报警预警」轮播：同上，42px 位置一致；
3. 消息页：图标位与原来一致（蓝底摄像机），取到图后换成照片；
4. 预警详情：抓拍图 / 「该报警暂无抓拍图」——不变；
5. `guards.spec`：图片引用清单、孤儿资源、`v-html` 白名单全绿；
   `motion-perf.spec`：新增「色标已下线」断言（`var(--tone, transparent)` 与
   `[data-tone="…"]` 都不再出现在 CSS 里）。

## 六点二十七、列表缩略图加载慢：实测定位与优化（2026-11-19）

### 一、链路与实测（不是推测，全部当场 curl）

链路：`stores/alarm.ts::ensureThumb` → `api/video.ts::fetchAlarmPicture`
→ `utils/imageThumb.ts::shrinkDataUrl` → 组件图标位。

| 项 | 实测值（2026-11-19 16:5x） |
| --- | --- |
| 报警列表 `GET :8085/api/video/alarms?page=1&page_size=20&sceneCode=P000000076` | 200，TTFB **0.212s**，总 **0.222s**，**7.8KB**，`total=2150` |
| 抓拍图 `GET :8085/api/video/alarms/{id}/picture` × 4 | **826KB / 2.7s**、**824KB / 2.7s**、**998KB / 3.4s**、1.3MB / 10.3s |
| 同一张图再拉一次 | 8.6s（服务器抖动，同一 id 从 2.7s 变 8.6s） |
| 卡住的请求 | 86601 连续两次 **30s 未完成**（curl 超时） |
| 响应头 | `Content-Type: application/json`、`Transfer-Encoding: chunked`；**无 `Content-Encoding`（没开 gzip）**、**无 `Cache-Control` / `ETag` / `Last-Modified`** |
| 4 路并发 | 8.4s / 9.5s / 10.3s / 30s(卡住) —— 每张都变慢，**总吞吐没变** |

结论（按影响排序）：

1. **单张 1MB 且服务端不压缩、不给缓存头** —— 浏览器无从缓存，重开页面 = 重下；
2. **带宽是瓶颈，不是并发** —— 4 路并发单张 8~10s，2 路并发单张 ~5s，串行 ~3s，
   总时长基本相同（约 1MB/s），调高并发只会让**第一张更晚**；
3. **尾延迟极差** —— 有请求 30s 不返回，占住并发位，后面已进入视野的图全排着；
4. **首次进入无任何预热** —— 等 IO 触发才开始拉，用户必然先看到一排占位图标；
5. 列表本身没问题：列表接口 0.22s / 7.8KB，渲染 20~45 行毫无压力。

### 二、已实施（按优先级）

| # | 措施 | 原因 | 涉及文件 | 风险 | 回归方式 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | **缩略图落盘缓存**（IndexedDB，7 天 / 400 条，一条 4~6KB） | 唯一能真正消掉「每次重下 1MB」的手段：同一张图二次进入 0 网络 | `utils/thumbCache.ts`（新）、`stores/alarm.ts::runThumb` | 隐私：登出必须清库（已接 `clearThumbs`）；配额满写失败只会当没缓存 | 进入列表 → 退出 → 再进：Network 面板里 picture 请求为 0，图标立即出现；登出后 IndexedDB 里的 `xyc-alarm-thumb` 为空 |
| P0-2 | **首屏预取**（数据到手后预取今日最新 4 条） | 打开页面再拉必然慢 3s+；提前在首页同步完成时排队，切过去已就绪 | `stores/alarm.ts::prefetchThumbs`（`syncFromVideo` 成功后调用） | 多花 4MB 流量 → 闸门：`navigator.connection.saveData` 为真、或 2G/3G 时不预取；只取今日最新 4 条 | 冷启动 → 首页停留 5s → 进消息页：前 4 行图标基本已出；开启「省流模式」后 Network 里没有 picture 请求 |
| P0-3 | **缩略图尺寸策略改「性能优先」**：144px/0.72 → **96px/0.62** | 容器最大 48px，96 在 2 倍屏仍是点对点；解码像素少 55%，单张 8~12KB → **4~6KB**，`drawImage` 与 JPEG 编码都更快 | `utils/imageThumb.ts` | 3 倍屏会略软（现场接受「基本辨识度」）；要回退只改 `THUMB_MAX` 一个常量 | 列表里图标仍能认出是哪条现场；DevTools 里 `img.src` 长度约为原来一半 |
| P0-4 | **8s 超时 + 30s 冷却重试** | 复现到 30s 卡住的请求；原来这种失败会被记为「永久没有图」，那一行永远停在占位图标 | `api/video.ts::fetchAlarmPicture`、`stores/alarm.ts` | 超时中断的请求服务端可能仍在跑（不会更糟）；「确实没有图」仍永久不重试 | 断网进入列表 → 行显示占位图标 → 恢复网络滚动一次 → 该行出图（30s 后） |
| P1-1 | **并发维持 2（不调高）** | 实测 4 路的单张耗时是 2 路的 2 倍，总时长不变 | `stores/alarm.ts::THUMB_PARALLEL` | 无（只是不加） | —— |
| P1-2 | 已取到图的行不再注册观察器 | 每次 patch 都会重建行内 `:ref`，重复 observe 是白开销 | `InspectItem.vue` / `MsgPage.vue` / `AlarmFeed.vue` | 无 | 滚动列表，Performance 面板无重复 observe 抖动 |
| P1-3 | 原图比目标还小就直接用，不再走画布 | 省一次 `drawImage + toDataURL` | `utils/imageThumb.ts` | 无（尺寸本来就够） | 单测覆盖（缩不了退回原图） |

### 三、需要后端配合的两件事（前端无需改映射）

这两条是数量级改善，但必须服务端动，列在这里备查：

1. **开 gzip**：base64 的 JSON 压一遍通常省 20~30%（1MB → 0.75MB），改 nginx 一行；
2. **给抓拍图加缓存头**（`Cache-Control: private, max-age=600` + `ETag`），
   或直接提供 `?w=96` 的缩略图变体 —— 后者能把单张 1MB 变成 **~6KB**，
   首屏从「十几秒」变成「不到一秒」。前端只要把 `fetchAlarmPicture` 的 URL
   加一个查询参数，映射规则与图源都不变。

### 四、未做（留作下一步）

- `createImageBitmap` + `OffscreenCanvas` 把解码挪出主线程：现在每次落图会在主线程
  做一次 96px 的 draw + 编码（约 10~20ms），2 路并发时偶发掉帧才需要它；
- Service Worker 缓存 picture 响应：现在服务端无缓存头，SW 需要自行存响应体，
  与 IndexedDB 方案重复，暂不做。

### 五、回归清单（覆盖速度 / 质量 / 缓存 / 功能 / 兜底）

1. **首次进入**（清缓存后）：图标位先显示灰底摄像机，请求开始后外圈出现进度环，
   随后逐张换成抓拍图；首屏前 4 张在预取生效时应明显早于其余；
2. **二次进入**：图标「秒出」（本地缓存），Network 里没有 picture 请求；
3. **冷启动后再次进入**：同上（IndexedDB 跨会话有效）；
4. **清晰度**：列表 / 消息 / 轮播三处图标仍能辨认现场，不糊成一团；
5. **缓存隔离**：登出后重新登录（换账号），列表不残留上一个人的现场照片；
6. **异常兜底**：断网 / 超时 → 占位图标；恢复后滚动回来能补上；
   「确实没有抓拍图」的报警保持占位图标，不反复请求；
7. **功能不变**：点条目进详情、消息已读、日期筛选、轮播分页都不受影响。


### 六、占位图标：灰底 + 下载进度环（2026-11-19 晚）

现场反馈两件事：① 蓝底摄像机读起来像一枚功能入口，不像「这里该有一张图」；
② 抓拍图 1MB / 2~3s，这段时间图标位完全静止，分不清「在取」还是「没有图」。

| 项 | 做法 | 涉及文件 |
| --- | --- | --- |
| 底色 | `.alarm-tile` 与 `.msg-ico.video` 由 `--blue` 改 `--surface-2`，加 1px 内描边把「图的位置」框出来 | `styles/app.css` |
| 图标 | 灰底上白描边不可见，用 CSS 覆盖 `stroke: rgba(16,24,40,.32)`（presentation attribute 优先级最低，可直接盖） | `styles/app.css` |
| 进度来源 | **真实字节进度**：`fetchAlarmPicture` 增加第 4 个参数 `onProgress`，`wfText` 在有 `Content-Length` 时按流读完再解码（`res.body.getReader()`），每 chunk 回吐 `got / total` | `api/video.ts` |
| 进度状态 | store 新增 `thumbPct` / `thumbBusy`（`reactive`，不整对象替换 —— 进度高频写入，避免全列表重算）+ `thumbPctOf` / `thumbBusyOf`；< 4 个点不写、封顶 99、`finally` 里删 key | `stores/alarm.ts` |
| 进度环 | 新组件 `ThumbRing.vue`：SVG 圆环绝对定位铺满图标位（不参与布局，42/44/48 三处尺寸共用），`rotate(-90deg)` 从 12 点起画，弧长按百分比收 | `components/ui/ThumbRing.vue` |
| 不确定态 | 接口没给 `Content-Length` 时**不编百分比**，只留 28% 弧并整圈旋转（动效收在 `prefers-reduced-motion: no-preference`） | 同上 + `app.css` |

三条刻意的取舍：

- **排队中不显示进度**：`thumbBusy` 只在过了缓存查询、真发请求时置位。队列里排着
  20 条时让 20 颗图标一起转圈，看起来像整页都在加载，且没有可报的进度；
- **不估算分母**：没有 `Content-Length` 就退成不确定态。猜出来的进度一定会在最后
  突然跳回 100%，比转圈更让人怀疑数据是否真实；
- **图到了立即清状态**：`runThumb` 的 `finally` 删 `thumbPct` / `thumbBusy`，否则
  滚过一屏会在 reactive 里留几百个死 key。

回归：断网进入列表 → 灰底图标（无环，因为 `readThumb` 之后请求立刻失败）；
正常网络 → 环从 0 走到 99 再换成图；系统开「减弱动态效果」→ 环静止但仍有短弧；
三处图标位尺寸/圆角/点击热区不变。`alarm-thumb.spec` 新增 3 例（真实百分比、
无 `Content-Length`、登出清空），共 8 例。
