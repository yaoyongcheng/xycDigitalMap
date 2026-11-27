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
（2026-11-26 设备设施调序后首位改为 4#塔吊，打开即 4#塔吊，见六点九十八。）

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
| P0-4 | **8s 超时 + 30s 冷却重试**（2026-11-20 调为 **15s**，见下节补记） | 复现到 30s 卡住的请求；原来这种失败会被记为「永久没有图」，那一行永远停在占位图标 | `api/video.ts::fetchAlarmPicture`、`stores/alarm.ts` | 超时中断的请求服务端可能仍在跑（不会更糟）；「确实没有图」仍永久不重试 | 断网进入列表 → 行显示占位图标 → 恢复网络滚动一次 → 该行出图（30s 后） |
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

### 七、抓拍图超时 8s → 15s（2026-11-20）

现场反馈「偶发加载失败 / 图不出来，过一会儿再看又好了」。对回上面的实测表就清楚了：

| 实测场景 | 耗时 | 8s 超时的判定 |
| --- | --- | --- |
| 单张正常 | 2.7~3.4s | 通过 |
| 同一张重拉（服务器抖动） | **8.6s** | **误杀** |
| 4 路并发单张 | **8.4 / 9.5 / 10.3s** | **误杀** |
| 真卡死（86601） | 30s+ 不返回 | 该杀 |

8s 卡在「正常但慢」这一段中间，被拦下的其实都是会成功的请求。它们转成
「可重试 + 30s 冷却」，表现出来就是偶发失败、随后自愈。

改为 **15s**：覆盖实测上沿 10.3s 约 1.5 倍余量；仍远低于 30s 卡死，
`THUMB_PARALLEL = 2` 下最坏占用一个并发位 15s，不会拖死队列。

**只改了这一个常量**：

- `api/video.ts::PIC_TIMEOUT_MS` 8000 → `15_000`；
- 超时判定、`linkAbort` 桥接外部 signal、抛 `ApiError(0, '抓拍图请求超时，稍后重试')`、
  store 的「可重试 / 30s 冷却 / 确实没有图永久不重试」**全部未改**；
- 详情页大图与列表缩略图共用 `fetchAlarmPicture`，一处生效两边一致；
- 其他接口的超时（`cctv.ts` 6s/8s、`scaffold.ts` 6s/8s）未动。

回归：详情页打开大图不再在中速网络下报超时；列表滚动时偶发失败的条目变少；
断网仍按原路径失败（立刻 reject，不等 15s）；「确实没有图」的条目仍不反复请求。

### 八、报警接口是否下发「图标」字段：实测**否**（2026-11-20）

背景：图标位现在由前端自己决定（抓拍缩略图 or 统一占位图标），需确认服务端有没有
现成的图标地址 / 名称 / 类型标识可直接用。

实测（真实登录 + 真实请求，不是看文档）：

```text
GET http://115.159.67.12:8085/api/video/alarms?page=1&page_size=100&sceneCode=P000000076
→ 200, data.total=2172, 样本 100 条
```

`data.list[]` 每条**完整 17 个字段**，与 swagger `domain.VideoAlarmListItem` 一致：

| 字段 | 类型 | 取值示例 | 是否图标相关 |
| --- | --- | --- | --- |
| `type` | string | `"alert"` | 否，消息类别（推送类型） |
| `id` | number | `86654` | 否 |
| `deviceNo` | string | `"06d0680610086"` | 否 |
| `channelNo` | string | `"3"` | 否，通道号 |
| `boxNo` | string | `"1"` | 否，检测框号 |
| `alertType` | string | `"12"` | **间接**：报警类型码，前端查表换中文名，可据此选图标，但不是图标标识 |
| `alertName` | string | `""` | 否（100 条样本全为空串） |
| `captureTime` | string | `"2026-11-20 08:51:29"` | 否 |
| `sceneCode` | string | `"P000000076"` | 否 |
| `plateNo` | string | `""` | 否 |
| `createTime` | string | `"2026-11-20T08:51:29.222578896+08:00"` | 否 |
| `timestamp` | number | `1795135889` | 否 |
| `extInfo` | object | `{}`（100/100 全空） | 唯一的可扩展位，实际未使用 |
| `handleStatus` | number | `0` / `1` | **间接**：处理状态，不是图标状态 |
| `createdAt` / `updatedAt` | string | ISO | 否 |
| `handledAt` | string | `"2026-11-19T16:37:20.559+08:00"` | 只有已处理行才有（3/100） |

递归搜索行内所有键名（含 `extInfo` 内部）命中 `icon|image|img|pic|photo|logo|badge|avatar|color|level|severity|symbol`：**0 个**。

其余接口同样没有：

| 接口 | 结果 |
| --- | --- |
| `GET /api/video/alarms/{id}` | **404**，没有单条读接口；详情页数据全部来自列表行 |
| `GET /api/video/alarms/{id}/picture` | `{code,message,data:{id,pictureData}}`；`pictureData` 为 base64（本次 799,404 字符 ≈ 780KB），无名称/类型/状态 |
| `GET /api/video/alarms/hjhy` | 另一路报警源（total 48762），14 字段：`alarm_type`（中文 `"安全帽检测"`）、`alarm_type_code`（`"1"`）、`alarm_picture_md5` 等，**无图标字段** |
| `GET /api/video/cameras` | 24 字段（`camera_type`、`video_stream_url`、`status` …），**无图标字段** |
| `/api/video/alarm/types`、`/alarm/icon`、`/icons`、`/alarm/type/list`、`/channels` | 全 **404** |
| `GET /api/video/snapshots` | 直接回 JPEG 字节，没有 JSON 字段 |

swagger 里唯一 image 类字段是 `domain.CameraResult.img`（交通态势的「抓拍图片」），
与报警图标无关。

结论：**图标不由接口下发**。现有图标位的两种来源都是前端行为 ——
抓拍图缩略图（`/alarms/{id}/picture` 自己压）或灰底 `work-cam` 占位；
分类名（环境/用电/扬尘/防护）由 `utils/videoAlarm.ts::CLASSIFY` 按关键词猜。
若要让服务端控制图标，需要后端新增字段（建议 `iconUrl` 或 `iconKey` 放行级，
不要塞进 `extInfo` 让前端猜）。

### 九、智眸照片「不是最新」的成因（2026-11-20 实测）

现象：刷新后展示的照片（批次时刻）有时变早，与「每次都应是最新一批」不符；
同任务名存在多条记录。链路是 `fetchStationDay` → `probeGallery` → `fetchMediaJobs`。

实测（真实 CAS 登录，11-20 09:1x / 09:2x）：

| 事实 | 数据 | 影响 |
| --- | --- | --- |
| **记录 id 精度失真** | 当天 30 条记录里 **27 条** id 是 19 位雪花号；JSON 字面量 `5968386048883676116`，`JSON.parse` 后变 `5968386048883676000`（差 −44），另有 −391 / +388 等 | `toTaskRecords` 的 `num(o.id)` 拿到的已是舍入值；用它请求 `/media/task/job/{id}` 查不到 → 该班被当成「没有媒体」 |
| **限流码对不上** | 密集请求返回 `{"code":429,"msg":"当前查询较多，请稍后再试！"}`；`stationMedia` 只对 `42901` 退避重试 | 429 直接 `return null`，与「这班没图」无法区分 → 静默跳到上一班 |
| **「完成但 0 图」确实存在** | 11-19 各站 `status=2`：正射 108 张、三维 956 张、全景 78 张；同时有班次 0 张 | 最新班刚完成、媒体未上传完时，同样被跳过 |
| **列表按文件名升序** | 正射 107 张，`sort(name)` 首图 `DJI_20261120080144`（08:01:44 拍），末张 `08:05:00`；`lastModified` 在 name 序上**不单调** | 列表首图是**最早**一张，"展示最新"的预期不成立 |
| 重放 5 次（正常网络） | 11-20 正射 / 全局定点各 5 次均稳定选中同一班；11-19、11-18 多班组合 3 次也稳定 | 说明**不是排序随机**，而是「取不到就退一班」的失败回退 |

结论（按影响排序）：

1. **P0 雪花 id 精度**：浏览器 `response.json()` 阶段就丢了，前端改 `string` 也救不回。
   必须服务端把 `id` 序列化成字符串；前端可行的临时方案是用 `res.text()` + 把
   `"id":<16 位以上数字>` 包成字符串后再 parse。
2. **P1 限流码**：`429` 与 `42901` 都要按限流处理（退避 + 重试），且不可与「无图」共用一个 `null`。
3. **P1 语义**：`probeGallery` 是「最新**有图**的一班」，不是「最新一班」。最新班没图时
   应显示该班空态，而不是回退展示上一班的旧照片 —— 否则用户看到的就是「旧数据」。
4. **P2 排序**：列表按 `lastModified` 或文件名内嵌时间戳**降序**，首图 = 最新一张。
5. **P2 去重**：在取数入口显式按 `taskName` 分组、组内 `start` 降序（tie-break 用 id），
   只留一条，别依赖「sort 后取第一个有图的」这一隐含语义。

### 十、记录改走 V2 开放接口 `/api/open/v1`（2026-11-20）

**结论：能拿到最新数据，而且只有这条路能拿到。**

#### 旧链路为什么必然"不是最新"

`/task/exec/list/record` 的 `id` **不是取媒体的 jobId**：

| 班次 | 旧接口 `id` | 取媒体结果 | 真实 jobId（`taskRecordId`） |
| --- | --- | --- | --- |
| 11-20 08:20 全局定点 | `182748` | 10 个文件 | 182748 |
| 11-20 15:30 全局定点（排班） | `5626789748139799000`（雪花） | **200 + 空数组** | 1827xx |
| 11-21 08:20 全局定点（排班） | `8511377620515822000` | 200 + 空数组 | 1827xx |

雪花 id 与自增 jobId 是两套号，拿前者查媒体**不报错、回空数组**，代码把
「空数组」当成「这班没拍照」→ 静默往下退一班 → 刷新一次看到的批次就可能变。

另外两点：媒体接口限流返回 `code 429`（HTTP 200），旧实现只认 `42901`，
429 被直接当失败跳过；`size` 在旧接口不生效、`sort` 也没有。

#### 开放接口实测（真实登录、真实请求）

```text
POST https://iot.keehang.com:23443/api/open/v1/task-record/page
body: {"page":1,"size":100,"projectIds":[193640872670213],
       "startTime":"2026-11-20 00:00:00","endTime":"2026-11-21 00:00:00"}
→ 200 {"code":200,"data":{"total":3,"page":1,"size":100,"list":[
     {"taskRecordId":182761,"taskId":4974,"taskName":"向阳村-三维（加密）",
      "projectId":193640872670213,"airlineId":...,"dockDeviceId":263,
      "status":2,"result":0,"scheduled":true,
      "startTime":"2026-11-20 09:00:00","endTime":"..."}]}}
```

| 能力 | 实测 | 说明 |
| --- | --- | --- |
| 分区（日期） | ✅ | `startTime`/`endTime` 必须 `yyyy-MM-dd HH:mm:ss`；**带 `T` 直接 400** |
| 分页 | ✅ 但上限 100 | 传 500/1000/2000 都回显 `size:100`、只回 100 行 → 必须翻页 |
| 排序 | ❌ 无效 | `sort=startTime,desc` / `-startTime` / `startTime desc` 全按开始时间**升序**，只能前端排 |
| 项目过滤 | ✅ `projectIds[]` | 不传会带上账号下别的项目（光谷元著） |
| 权限 | ✅ 现有 CAS 令牌 | 用同一个 `KH-USER-ID` + `KH-TOKEN` 头即可，没有再要 appKey/签名 |
| 记录号 | ✅ 自增 | `taskRecordId` 可直接调 `/media/task/job/{id}`，也可调 `/api/open/v1/media/file/list` |
| 媒体统计 | ✅ | `POST /api/open/v1/media/job/page`（**taskId + taskRecordId 都要**，只给记录号回 `taskId 不能为空`）→ `fileCount / uploadedCount / uploadState / processStatus` |
| 媒体清单 | ✅ | `POST /api/open/v1/media/file/list`（只给 `taskRecordId`）→ `fileName / fileUrl / thumbnailUrl / mediaType / size / lastModified`，一次回全部（108 / 350 条实测都行） |

`/v3/api-docs` 是公开的（317KB），331 条路径，上面这些都在里面；
`/swagger/index.html`、`/swagger/doc.json` 是 404。

#### 落地

| 改动 | 文件 |
| --- | --- |
| 记录统一走开放接口：`fetchTaskRecords()` 内部分页翻到 `total`，`id = taskRecordId` | `api/drone.ts` |
| 站点索引（90 天，只取名字/时间）**保留旧接口一次拉全**，避免为一个下拉框打 12 个分页请求 | `api/drone.ts::fetchRecentRecords` |
| 航拍照片按「任务名去重 + 只取最新一班」：`pickLatest()`，同一天两班只留后一班 | `api/drone.ts` |
| 最新一班没图时先问回传进度：`pending`（已传/总数），**不回退上一班**；页面标题写「本班照片正在回传」 | `api/drone.ts::stationProgress`、`stores/airHazard.ts`、`AirPlayer.vue` |
| 媒体失败不再当「没图」：`stationMedia` 认 `429`+`42901` 各重试一次；`latestTaskMedia` 失败直接抛（页面写加载失败，重试即可），只有「200 且 0 张图」才退下一班 | `api/drone.ts` |

#### 「全景航拍」为什么不是最新一批（2026-11-19 那 9 张）

11-19 的两班都真实存在且能取到（实测 `taskRecordId 182577` / `182691`，各 9 张）：

| 班次 | taskRecordId | 图片 |
| --- | --- | --- |
| 11-20 08:20 | 182748 | 9 |
| **11-19 15:30** | 182691 | **9** |
| **11-19 08:20** | 182577 | **9** |
| 11-18 15:30 | 182540 | 9 |
| 11-18 08:20 | 182447 | **0** |

所以那 9 张**没有「未同步」**，也不是被规则按日期排除 —— 是旧实现的两个 bug 让它显示成更早的批次：

1. 最新几班的 `id` 是雪花号（见上表），媒体查询回空数组 → 被当成「没拍」跳过；
2. 媒体被限流（`429`）时旧代码只认 `42901`，直接 `continue` → 又跳过一班。

两条都命中时就会落到 11-18 15:30 甚至 11-17，看起来就是「11-19 的 9 张没同步」。
现在记录号换成 `taskRecordId`、限流会重试、失败不再静默退班，最新一班就是最新那班。

#### 回归

- 智眸「全景航拍」：11-20 08:20（9 张）→ 11-19 15:30（9 张）逐班对照；
- 航拍照片页：选今天 → 本班正在回传时显示「本班照片正在回传（已传 x/y）」，不再是上一班；
- 断网进入：显示加载失败 + 「重新获取」，不再显示旧批次；
- `drone.spec` 76、`patrol.spec` 57、`device-page` 与 stores/stage5 共 300、全量 1177 passed；`vue-tsc` + `vite build` 通过。

### 十一、智眸「一直刷新 / 照片加载不出来」与安全巡查「只剩一张」（2026-11-20 下午）

#### 实测（真实登录、真实请求）

| 观测项 | 结果 |
|---|---|
| `/media/task/job/{id}` 正常响应 | **1.2s / 3.2s / 10.8s / 13.2s**，第 5 次直接 `ECONNRESET` |
| 连发 12 条媒体请求 | **10 条限流**：`HTTP 200` + `{code:429, msg:"当前查询较多，请稍后再试！"}` + `data: []` |
| 同一 job 间隔 900ms 连发 6 次 | 6 次全 429 |
| 冷却 60s 后单发 | 恢复 200，耗时 10.5s |
| 缩略图响应头 | `Content-Type: application/octet-stream` + `nosniff` + `content-disposition: attachment`，字节是真 JPEG（430KB） |

`application/octet-stream` **不是**图片加载失败的原因（Chrome 对 `<img>` 会按字节解码，实测同源/跨源、带 nosniff 均能渲染），只造成直链打开变下载，属服务端配置不规范。

#### 前端五处修复

1. **媒体接口单独超时 25s**（`drone.ts` 的 `MEDIA_TIMEOUT`）：全局 12s 正好压在实测耗时上沿，正常响应也会被判超时。
2. **限流码统一**：`stores/patrol.ts` 的 `THROTTLE_CODES = Set([429, 42901])`（原只认 42901，碰上现在的 429 直接放弃）；`STATION_THROTTLE_WAIT` 2.2s → 3s。
3. **`latestTaskMedia` 不再把「取不到」当「没拍到」**：`stationMedia` 内部吞错返回 `null`，旧写 `?? []` 会静默退到更早一班；现在显式抛错。
4. **缩略图失败自愈**（`PatrolPanel.vue`）：`broken` 跟随当前照片集合重置 + 同一张图失败后 3 秒自动重试一次（原来永不复位，只能切标签重建组件）。
5. **执行记录批次共享**（`drone.ts` 的 `beginRecordBatch / endRecordBatch / runInRecordBatch`）：一次 `load()` 里五条链查同一个 30 天窗口，原来各翻 5 页 ≈ 25+ 个 `task-record/page`，现在共享一份。

#### 安全巡查「有时只剩一张」

不是查询条件或遍历写错：`土方1` 第 1 张、`分区定点拍照` 第 34 张，实测每班分别 **49~50 张 / 41 张**，序号都在（5 班里 2~3 班返回 429）。

根因是两条来源各自拉记录、各打一次媒体，任一条撞上 429 → `stationMedia` 重试一次仍失败 → `fetchSafetyGallery` 的 `catch` 把它当「这条航线没照片」静默跳过 → 整格只剩另一条的一张。

修法：两条来源共享同一份执行记录；一条失败时**隔 3.2 秒只补那条**（已拿到的不重取）；结果按下标存放，补取后顺序仍与 `SAFETY_SOURCES` 一致。

#### 回归

- 智眸：进入面板 → 五格计数正常；「出入口管控」不再长期空；缩略图破图会在 3 秒内自愈；
- 安全巡查：连点「重试」多次，稳定 2 张（不再随机变 1 张）；
- `patrol.spec` 59（新增「补取后仍两张」「同窗口只查一次」两例）、全量 **1179 passed / 50 files**；`vue-tsc` + `vite build` 通过。

---

### 十二、「设备设施」由 2 张扩到 4 张：两张塔吊抓拍（2026-11-20）

#### 需求

「设备设施」原有 2 张（`向阳村-塔吊定点` 最近一班的第 2、第 7 张）。需再补两张：**2#塔吊**、**4#塔吊** 各自「按抓取时间最新的历史抓拍」，排在原有两张之后，共 4 张。

#### 接口现实（决定了怎么取）

| 能力 | 结果 |
| --- | --- |
| `GET https://115.159.67.12/api/video/snapshots?pid&channelId` | 200，直出 JPEG（实测 319,452 / 306,583 字节） |
| 响应头里的拍摄时间 | **没有**（`Cache-Control: no-store`，无 `Last-Modified` / 自定义头） |
| `snapshots/history`、`/list`、`/records` | 全 404（nginx），**服务端不保存历史** |

所以「最新的一条历史抓拍」= **现取一帧** 与 **本机档案里最新一条** 里更新的那条：

1. `fetchCamSnapshot(channelId)` 取一帧 → `saveShot()` 落本机档案（与监控页「历史抓拍」**同一份档案**，`utils/shotArchive.ts`）。同一档同样字节不覆盖，时刻保持第一次看到的那个，不会每次刷新都变成「刚刚拍的」；
2. 取不到（相机离线 / 断网 / 429）→ `latestShot(channelId)` 退回档案里最新一条（真实抓拍，不是别的图顶替）；
3. 两样都没有 → 这两张不出现。宁少两张，不编照片。

通道号不另抄一份：`data/cams.ts` 的 `CRANE_SHOTS` 按名字 `2#塔吊 / 4#塔吊` 从 `CAM_POINTS` 取（`34020000001320000017` / `34020000001320000016`），顺序即展示顺序。

#### 前端改动

- `utils/shotArchive.ts`：新增 `latestShot(channelId)` —— 只查 `meta` 表挑出最新 `at` 的 key，再取那条完整记录（90 条元信息 vs 90 张原图）。
- `stores/patrol.ts`：
  - `PatrolPhotoReal` 新增可选 `snap?: boolean`（来源是视频监控抓拍）；
  - 新增 `craneShots()`：**串行**取两台塔吊（并行会撞 `Retry-After` 429），产出 `taskName = '2#塔吊' / '4#塔吊'`、`time = 'YYYY-MM-DD HH:mm:ss'` 的四张之一；缩略图用档案里的 480 长边 WebP（约 20KB），原图用档案原始字节；
  - `loadFacility()`：航拍两张**先上屏**，抓拍到了再追加（抓拍是 300KB×2，不让前两张陪着等）；加 `facilitySeq` 序号，连点「重试」时只让最后一次落地；objectURL 统一登记，重取 / `reset()` 时撤销；
  - 失败互不牵连：抓拍取不到只少两张；只有航拍那条彻底失败才 `facilityState = 'error'`。
- `views/home/PatrolPanel.vue`：卡片来源徽标按 `p.snap` 写「视频监控」（`alarm-src-cam` 绿标）/「无人机」（蓝标），缩略图角标写「抓拍」/「航拍」；样式、尺寸、间距、`grid` 布局与其余分类完全复用，没有新样式。
- `components/sheets/PatrolSheet.vue`：抓拍的大图 meta 写「点位 / 视频监控」，航拍仍是「任务 / 无人机」。

#### 回归

- 智眸 →「设备设施」：4 张（前两张塔吊定点航拍、后两张 2#/4# 塔吊抓拍），计数与「N 张」都变 4；
- 断网 / 相机离线：前两张照常，抓拍少几张就少几张，不报整格错、不显示旧图冒充；
- 监控 → 2#塔吊 →「历史抓拍」：能看到今天那几张（与这里同源，同一份档案）；
- `patrol.spec` 62（新增「抓拍取不到退回档案最新」「刷新只换航拍两张」）、全量 **1182 passed / 50 files**；`vue-tsc` + `vite build` 通过。

---

### 十三、「出入口管控」改为 5 张门禁抓拍（2026-11-20）

#### 需求

「出入口管控」新增 5 张历史抓拍，**固定 5 张**、来源不重复不缺项，每个来源只展示其历史抓拍中最新的一张：

| # | 来源 | channelId | 怎么来的 |
| --- | --- | --- | --- |
| 1 | 视频监控A | `34020000001310000001` | 用户点名通道号；名字取 `CCTV_CHANNELS` 的「监控A」 |
| 2 | 视频监控-2#门监控1 | `34020000001320000003` | 按名字从 `CAM_POINTS` 取 |
| 3 | 2#门监控2 | `34020000001320000006` | 同上 |
| 4 | 4#门监控 | `34020000001320000007` | 同上 |
| 5 | 4#门外监控 | `34020000001320000004` | 同上 |

来源表在 `data/cams.ts` 的 `GATE_SHOTS`：第一条只写 channelId（「监控A」不在智眸那 9 个白名单点位里），后四条只写名字，通道号**从 `CAM_POINTS` 现取**，不另抄一份。

#### 实测（2026-11-20）

| channelId | 结果 |
| --- | --- |
| …310000001（监控A） | 200 / 339,642B / image/jpeg，画面水印 11-20 12:06 |
| …320000003（2#门监控1） | 200 / 367,983B |
| …320000006（2#门监控2） | 200 / 244,629B |
| …320000007（4#门监控） | 200 / 387,673B |
| …320000004（4#门外监控） | 200 / 264,889B，画面水印 **11-19 19:46**（这路服务端最近一帧就是昨晚那张） |

五路全通，所以「固定 5 张」成立。接口仍是既有那一个（`GET {MEDIA_ORIGIN}/api/video/snapshots?pid&channelId`，`X-API-Key`），**没有**新地址、新参数或新字段；服务端依旧不提供历史列表。

#### 前端改动

- `data/cams.ts`：新增 `GATE_SHOTS`（5 条，顺序即展示顺序；名字对不上时 `channelId` 留空，取图那步跳过，不猜通道）。
- `stores/patrol.ts`：
  - 拍出 `snapShotOf(channelId, name, pool)` —— 塔吊与门禁共用的「最新一条抓拍」：现取一帧 → `saveShot` 落本机档案（与监控页「历史抓拍」同一份）→ 取不到退 `latestShot` → 都没有就 `null`；通道号为空也 `null`；
  - `snapSerial()`：**模块级串行队列**，一次只打一张快照。设备设施 2 张与出入口 5 张是两条并行链，各排各的等于没排（文档要求「多通道逐张请求」）；
  - `makeUrlPool()`：objectURL 池抽成工厂，`cranePool` / `gatePool` 各持一个（两格刷新时机不同，共用会在一边重取时撤掉另一边正在显示的图）；
  - 新增 `gate` / `gateState` / `loadGate()`：首屏逐张上屏（先看到第一张），已有内容时**攒齐再换**（避免张数 5→1→5 的跳动）；一张都取不到才 `error`；
  - `photoById` 加 gate；`load()` 里 `gateTask` 并入 `Promise.all`、「有内容」判断加 gate；`reset()` 撤池 + 递增 `gateSeq`。
- `views/home/PatrolPanel.vue`：
  - 「出入口管控」不再走照片墙归组（`groups.get('yard')` 常年为空），`shown` / `chips` / `catLoading` 全部改读 `patrol.gate`；
  - 空态区分「暂时取不到」+ 重试（`retryGate`，只重取 5 张，不重扫照片墙）；
  - 少了几路时网格下方一行 `.patrol-gate-note`（`grid-column: 1 / -1`）写出缺的点位名。
- `styles/app.css`：新增 `.patrol-gate-note`（字号 / 颜色同 `.patrol-empty`）；`.patrol-grid:has(.patrol-card:only-child)` → `only-of-type`（下面可能还有那行说明）。
- `components/overlays/SheetHost.vue`：标题改走 `patrol.photoById()`（原来只查 `photos`，塔吊 / 门禁抓拍点开时标题退成「照片」）。

#### 一张不编

5 路里某一路相机离线、本机档案也没留过图时，那一张**不出现**，并写明是哪一路。不拿别的图顶替、不拿演示图凑数 —— 与「取不到就显示 `—`」同一条红线。

#### 回归

- 智眸 →「出入口管控」：固定 5 张，顺序 监控A / 2#门监控1 / 2#门监控2 / 4#门监控 / 4#门外监控，卡片「抓拍 / 视频监控」，标题是点位名；
- 点开大图：标题是点位名（不是「照片」），meta 写「点位 / 视频监控」；
- 断网 / 相机离线：少几张就少几张，网格下方写出缺的那路；5 路全挂才写「出入口管控照片暂时取不到」+ 重试；
- 其它五格（VR 360环视 / 全景航拍 / 设备设施 / 材料堆场 / 安全巡查）计数与内容不变；
- `patrol.spec` 70（新增 8 例：来源表 5 条通道号、取回 5 张与顺序、单路失败、档案兜底、全挂、刷新重取、面板 5 张、面板缺项说明）、全量 **1190 passed / 50 files**；`vue-tsc` + `vite build` 通过。

## 六点二十八、消息页拆成「监控预警 / 无人机预警」两类（2026-11-20）

### 需求

消息页原来是一条报警一条消息（`:8085` 视频报警），设计稿 gx2 的消息页是**分类卡**。
现场口径：现有报警统一算「监控预警」，另加一类「无人机预警」，随手拍预警**不接**。

### 数据源：V2 的「工单列表」= 审核中心 AI 工单

问的是「V2 里工单列表的数据从哪来」。keehang 那 331 个路径里 `work_order/*` 只有 4 个推送口，
`/work_order/page` 全 404，`/algorithm/*` 对本项目设备统一 500。最后从 V2 Unity 客户端
`HotUpdateScripts.dll` 的字符串堆里挖出 `auditCenterUrl` / `AuditWorkOrder` / `FetchAllAuditWorkOrdersAsync`
→ `/audit_center/get_by_device_id?pidList=`，再实测：**23443（网关）404，`:12666` 上 GET 405 / POST 200**。

```
POST https://iot.keehang.com:12666/audit_center/get_by_device_id?pidList=193640872670213
     { pageNum, pageSize, deviceId, auditStatusType? }        # 鉴权仍是 CAS 那套 KH-USER-ID / KH-TOKEN
```

| 参数 | 实测结论 |
| --- | --- |
| `pidList`（query） | 项目过滤；返回行的 `pid` 全是本项目 |
| `pageNum` / `pageSize` | 从 1 开始；`pageSize=10` → `totalPage=105`、`totalRecord=1044` |
| `deviceId` | **必填且必须是无人机**：23498 → 1044 条；23452（机库）→ 0 条；不传 → 500；传网关 263 → 「已拒绝该项目下的相关操作」 |
| `auditStatusType` | `UNAUDITED` / `AUDITED`；**传空串 400**，不筛选就整个字段都别给 |
| `startTime` / `endTime` / `businessStartTime` / `startDate` | **全部被忽略**（`totalRecord` 恒 1044）→ 做不了按日期筛 |

信封是两层的：`{code, data: {data: [...], totalRecord}}`（`khJson` 先剥一层 `code/data`，
业务侧还要再取 `data.data`）。本项目计数：**1044 条 / 待处理 717 / 已完成 316**。

字段与 V2「预警详情」逐项对得上：`businessTime`=检测时间、`jobName`=任务名称、
`title`/`labelName`=识别结果、`lng`/`lat`=经纬度、`rawFiles[0].fileUrl`=现场大图、`auditStatusType`=待处理/已完成。

⚠️ 图片是 OSS **签名直链**（`X-Amz-Expires=7200`，单张 0.6~1.3MB，`x-oss-process` 一加就 403），
所以**列表不铺缩略图**（20 条一次铺开十几 MB），只在详情页加载那一张。

### 前端落地

- `api/drone.ts`：`fetchAuditWorkOrders({page,size,status})` + `DroneWorkOrder` 收敛（`toWorkOrder`：
  `businessTime` 的 `T` 换空格截到秒、`title ← labelName`、`jobName ← lineName`、`rawFiles[0].fileUrl`；
  没有 `dataPayloadId` 的行直接跳过，不编一条假的）。
- `stores/droneAlarm.ts`（新）：`load()` 一次打三趟 —— 全部 20 条 + `UNAUDITED size=1` + `AUDITED size=1`，
  后两趟只要 `totalRecord`（卡片要「多少条待处理」，而 `totalRecord` 是**当前筛选**下的总数）；
  `loadMore()` 只追加、下一页全是重复就判 `exhausted`；`setFilter()` 走服务端真支持的状态维度；
  `apply()` 是测试接线点（不触发请求）。
- `stores/msg.ts`（重写）：`categories`（监控 / 无人机两张卡）、`monitorUnread`、`unreadTotal`、`markRead`。
  **tabbar 角标口径不变**（只算监控未读）—— 717 条待处理算进去角标永远钉在 99+，点开还不减。
- `views/MsgPage.vue`：两张卡；未登录仍是一句话 + 去登录；条数没拿到写「—」不写 0；
  骨架改成「灰条位先占着、`skel-fade` 280ms 后淡入」（不是先出内容再换灰条）。
- `stores/subpage.ts`：新增 `work-orders` / `work-order-detail` 两个视图与 `openWorkOrders()` / `openWorkOrderDetail()`；
  `isAlarm` 带上详情页（深色导航栏 + 通栏 hero）。
- `components/overlays/SubPage.vue`：`LIST_KEYS` 加 `work-orders`（滚动记忆），垫底层与主层都接上。
- `views/sub/WorkOrderList.vue`（新）：**不另起版式**，逐项复用监控子页那套 ——
  `.home-stats/.home-stat`（待处理 / 已完成）、`.insp-tabs/.insp-tab`（全部 / 待处理 / 已完成）、
  `.insp-list/.insp-item`（48px 无人机占位图标 + 标题 + `.alarm-src-drone`「无人机」徽标 + 任务名）、
  `.wo-side`（相对时间 + `.alarm-src-todo`「待处理」橙 / `.alarm-src-done`「已完成」灰）、
  `.insp-item.is-skel`、`.insp-empty`、`.msg-more` 四态。
- `views/sub/WorkOrderDetail.vue`（新）：与 `AlarmDetail.vue` 同一套 `.alarm-hero` / `.alarm-info` / `.alarm-kv`；
  三组信息（基础 / 识别结果 / 位置）；大图 `@load` / `@error` 走具名方法（模板里多行内联语句编译不过）。
- `views/sub/InspectList.vue`：单条报警的已读入口从消息页迁到这里（点一条先 `msg.markRead(id)` 再进详情）。

### 为什么不摆日期选择器

审核中心接口没有时间筛选能力（见上表），摆一个点了不反应的日期芯片比没有更糟。
页签按状态分：形态与监控子页一致，语义按各自数据能力来。

### 回归

- 消息页：两张卡（监控在前 / 无人机在后），监控未读=服务端 `handleStatus!==1` 的条数，
  无人机卡写待处理数（>99 → `99+`），待处理数不进 tabbar 角标；
- 点「监控预警」→ 巡检预警（今日）；点「无人机预警」→ 无人机预警列表；
- 无人机列表：待处理 / 已完成两格是服务端 total，三条页签可切，点一条进详情、返回回列表；
  一条都没有 → 「暂无无人机预警」；接口失败 → 写明原因 + 重试（不清空已有列表）；
- 无人机详情：任务名称 / 检测时间 / 识别结果 / 经纬度 / 相对高度逐项照服务端，缺的写「—」；
  图加载失败写「现场图加载失败」，没有图写「该预警暂无现场图」；
- 测试：`msg-categories.spec`（9，替掉旧的 `msg-paging.spec`）、`work-order.spec`（20，新）、
  `stage5.spec` 消息段与 `guards.spec` 的消息图标用例按分类卡改写；
  全量 **1204 passed / 51 files**，`vue-tsc` + `vite build` 通过。

## 六点二十九、监控预警：标题正名 + 今日未读红点（2026-11-20）

### 口径

1. 子页标题 `巡检预警` → **`监控预警`** —— 它就是消息页那张「监控预警」卡的明细，
   两个入口叫两个名字会让人以为是不相干的两处。
2. **今日预警**的未读条目在图标位右上角点一颗红点（微信的位置：压在头像角上、
   外留一圈白边）；已读的不点。
3. **历史预警不打点、也不参与未读判断**：点开历史某条只进详情，不发
   `PATCH /status`。「已读」表达的是「今天这条我看过了」，把上周的报警标成已读没有意义。
4. 消息页「监控预警」卡上的数字 = **今日未读**，与列表红点用同一个判据
   （`handleStatus !== 1`），所以数字与红点个数永远一致；数字旁加了 11px 的
   `今日未读` / `待处理` 标签，避免读成「今日总数」。

### 落地

- `stores/subpage.ts::titleOf('inspect-list')` → `监控预警`。
- `components/ui/InspectItem.vue`：新增可选 `dot` 属性，图标位外包一层
  `.insp-pic-box`（相对定位容器：有抓拍图时节点是 `SmartImg`、没有时是占位 `span`，
  类名不同，直接在它们身上取定位会漏一种），红点是 `.insp-dot`（9px + `--danger`，
  白圈用 `box-shadow` 不用 `border`，免得撑大圆点、改变定位基准）。
- `views/sub/InspectList.vue`：今日列表传 `:dot="isUnread(a)"`，历史列表不传；
  `onItemOpen(id, fromToday)` 只对今日 `markRead`；空态/登录文案同步改成「监控预警」。
- `stores/msg.ts`：`monitorUnread` 从「全部已加载未读」改成 **`alarm.latest`（今日）
  里 `handleStatus !== 1` 的条数**；`monitorLatest` 今日没有才退到最近一条（时间会写成
  「昨天 21:41」，不会误读成今天）；`MsgCategory` 加 `hint`。
- `views/MsgPage.vue` + `styles/app.css`：数字行 `.msg-count` + `.msg-hint`。

### 回归

- 进「监控预警」：标题是监控预警；今日列表未读带红点、已读没有；切「历史预警」整列无红点。
- 点今日某条 → 红点立刻消失、发一次 `PATCH /api/video/alarms/{id}/status {status:1}`；
  返回列表时该条仍无红点。
- 点历史某条 → 进详情，列表红点状态不变、不发 PATCH。
- 消息页「监控预警」卡：数字与今日列表红点个数一致；今日全部已读时不显示角标（不是「—」）。
- 测试：`monitor-alarm.spec` 7 例（标题 / 红点 / 历史不打点 / 点开已读与 PATCH / 只对今日 /
  数字与红点一致 / 全已读无角标）；`msg-categories.spec`、`stage5.spec`、`interaction.spec`、
  `stores-views.spec` 同步。

## 六点三十、无人机预警：版式对齐监控 + 红点按状态 + 角标两类之和（2026-11-20）

### 一次复测，把「做不做得了日期筛选」钉死

`POST https://iot.keehang.com:12666/audit_center/get_by_device_id?pidList=`（鉴权仍走 CAS 的
`KH-USER-ID` / `KH-TOKEN`）在 2026-11-20 又试了一轮时间参数，结论与上次一致：

| 传的参数 | 结果 |
| --- | --- |
| `startTime`/`endTime`、`beginTime`/`endTime`、`businessStartTime`/`businessTimeEnd`、`businessTimeBegin`、`businessTimeStart`、`createTimeBegin`、`createTime`、`startDate`/`endDate`、`timeStart`/`timeEnd`、`dateRange[]` | `code 200`、`totalRecord` 恒为 **1048**（当时）→ **全部被忽略** |
| `auditStatusType=UNAUDITED` | `totalRecord=721`（服务端真支持的唯一筛选维度） |
| `pageNum` / `pageSize` | 从 1 开始，`size=100` 时 `totalPage=11` |

同时确认了**行里没有未读/已读字段**（整行只有 `auditStatusType` / `auditType` /
`lastProcessedTime`，没有 `readStatus` / `handleStatus` 之类）。所以按现场规则：

- 有未读字段 → 按监控那套 `handleStatus`（不适用，没有）；
- 没有 → 按 **待处理 / 已完成** 控制红点（采用）。

### 今日 / 历史：靠「倒序前缀」，不靠参数

返回是按 `businessTime` 倒序的，于是「今日」就是这份有序数据的前缀：

```
load():  page=1..3, size=100
         └ 每页追加；服务端不足 100 条 / 已够 total → 停
         └ 最老一行的日期 < 今天-6 → 停（今日与 7 日窗口都齐了）
```

- 实测 100 条正好覆盖 11-14~11-20 这 7 天（今日 9 条），**通常一次请求就够**；
- 「今日预警数」= 前缀里 `businessTime` 是今天的条数（精确值，不是估算）；
- 「近 7 日预警趋势」= 同一批行按日期分桶（窗口内每天都被完整覆盖）；
- 「历史预警」= 其余行，继续 `size=20` 往后翻（`nextPage` 接着扫描的页号，不用再算偏移）；
- 首屏结果有 **120 秒保鲜期**（`STALE_MS`）：切 tab / 重进列表不重扫，过期才重来一趟。

顺带删掉两趟只为拿「待处理 717 / 已完成 316」的 `size=1` 请求 —— 页面不再显示这两个全局总数，
省下两次往返。列表页签也随之从「全部/待处理/已完成」改成**今日预警 / 历史预警**（与监控同名同位）。

### 红点与角标口径（现场 2026-11-20 二次定稿）

| 位置 | 数字 | 判据 |
| --- | --- | --- |
| 无人机列表 · 今日条目红点 | — | `status === 'UNAUDITED'` 且 `businessTime` 是今天 |
| 无人机列表 · 历史条目 | — | **一律不点**，也不参与任何计数 |
| 无人机列表 · 统计卡 | 今日预警数（含已完成） | 今日全部工单条数 |
| 消息页 · 无人机卡 | 今日待处理 | 与红点同一条判据，所以「数字 = 红点个数」 |
| 消息页 · 监控卡 | 今日未读 | `handleStatus !== 1`（原口径） |
| 底栏「消息」角标 | **监控今日未读 + 无人机今日待处理** | 两者相加（本次改动） |

点开无人机条目**不改状态**：审核平台里的人工动作，本 App 没有这个接口，不假装能做
（所以红点只会随上游审核而消失，不会因为「看过了」而消失 —— 这是规则本身决定的）。

### 落地

- `stores/droneAlarm.ts`：`load()` 改成分页扫描 + `STALE_MS` 保鲜；新增
  `todayItems/todayCount/todayPending/todayKnown/histItems/histCount/weekTrend/weekComplete/isUnread`；
  删 `pending/done/pendingKnown/filter/setFilter/pageNo`（对应的「状态筛选」页签一并下线）。
- `views/sub/WorkOrderList.vue`：与 `InspectList` 逐项同构 —— `.insp-tabs`（今日/历史）、
  `.home-stats.alarm-row`（`.home-stat.alert` 今日预警数 + `.home-chart-card.alarm-mini` 近 7 日趋势，
  图用同一个 `TouchChart` / `alarmTrendLive`，只把渐变 id 换成 `woAlarmFill` 免得和另两张图撞）、
  `.insp-list/.insp-item`、`.insp-pic-box` + `.insp-dot`、`.insp-hist-hd`、`.insp-empty`、`.msg-more`。
- `stores/msg.ts`：`unreadTotal = monitorUnread + drone.todayPending`；无人机卡 `hint` 改「今日待处理」。
- `views/MsgPage.vue`：切回消息 tab 时补一次（该页常驻挂载，`onMounted` 一辈子只跑一次）。
- `App.vue`：启动 / 登录后各拉一次无人机预警 —— 底栏角标要它，不能等用户点进消息页才有数。

### 回归

- 消息页：无人机卡写「今日待处理 N」，N 与无人机列表今日红点个数相等；底栏角标 = 两卡数字之和。
- 无人机列表：标题下两个页签；今日页签有「今日预警数」+ 近 7 日趋势 + 今日条目（未处理带红点）；
  历史页签是「更早的预警 N 条」+ 无红点列表 + 底部「还有 N 条 / 已显示全部」。
- 今日没有工单时：今日页签写「今日暂无无人机预警」，趋势位写「近 7 日暂无预警」，页签仍可切。
- 测试：`work-order.spec` 27 例（接口 4 + store 9 + 列表 10 + 详情 4）；`msg-categories` / `stage5` 的
  角标断言按「两类之和」改写；`vue-tsc`、`vitest`（1218）、`vite build` 全绿。

## 六点三十一、无人机预警图标位对齐监控（2026-11-20 当晚）

### 需求

无人机预警列表左侧 48px 图标位要与「监控预警」页的同类图标**显示条件、状态映射、
样式、交互**全部一致，同时**原有那颗灰底无人机占位图标不能变**。

### 监控那边是怎么做的（`components/ui/InspectItem.vue`）

| 环 节 | 实现 |
| --- | --- |
| 何时取图 | `utils/thumbReveal.ts` 全站共用一个 `IntersectionObserver`，滚到视口 240px 内才请求；无 IO 时降级为「只加载前 30 条」 |
| 有图 | `SmartImg class="insp-pic"`（48px + `--r-8` + `object-fit: cover`） |
| 没图 | `.insp-pic.alarm-tile`：`--surface-2` 灰底 + 1px 内描边 + 图标 50% + 深灰描边 |
| 取图中 | `ThumbRing`：占位图标外圈的**真实字节**进度环（无 `Content-Length` 走不确定态） |
| 失败 | 「没有可用抓拍图」= 结论永久放弃；超时/断网 = 30s 冷却后可重试 |
| 缓存 | `utils/thumbCache.ts` IndexedDB，96px / JPEG 0.62 / 7 天 / 400 条 |
| 红点 | 与图无关，`.insp-dot` 由 `isUnread` 单独决定 |

### 无人机这边为什么以前不铺图

工单现场图是 OSS **预签名**直链，当初判定「不能缩图也不能缓存」所以只铺占位图标。
2026-11-20 复测把三条结论钉死：

| 试的 | 结果 |
| --- | --- |
| 响应头 | `Access-Control-Allow-Origin` **回显 Origin**（CORS 通）+ `Expose` 了 `Content-Length` / `ETag` |
| 体积 | 单张 **203KB / 218KB**（两次取样），`Content-Type: application/octet-stream` |
| `x-oss-process=image/resize,w_96` | **403 `SignatureDoesNotMatch`** —— 预签名把 query 一起签了，追加参数即失效 |
| `Cache-Control` | **没有**（有 `ETag` / `Last-Modified`），所以浏览器缓存不可靠 |

→ 缩图只能在前端做（`utils/imageThumb.ts` 本来就有），落盘走 `utils/thumbCache.ts`，
**CORS 通就能 fetch 到字节**。原来的「不能铺图」只对「服务端缩图」成立。

### 落地（只动这条图标链，别处一行没改）

- `api/drone.ts::fetchWorkOrderPicture(url)`：`fetch` → 流式读字节（有 `Content-Length`
  就报真实进度）→ **强制标成 `image/jpeg`** 的 data URL（服务端给的是 octet-stream，
  少数内核按 MIME 拒绝解码）。8s 超时与报警抓拍图同口径。403/404 抛 `ApiError` 带状态码
  （结论），其余统一 `code 0`（可重试）。
  返回 data URL 而不是 Blob，是为了不引入 objectURL 生命周期、也不依赖
  `URL.createObjectURL`（happy-dom / 老 WebView 都没有）—— 下游 `shrinkDataUrl` 直接吃它。
- `stores/droneAlarm.ts`：新增 `thumbOf / thumbPctOf / thumbBusyOf / ensureThumb / clearThumbs`，
  口径与 `stores/alarm.ts` 逐条对齐 —— 并发 2、同 id 去重、缓存键 `wo:<id>`（与报警
  `va-…` 共用同一个库）、进度用 `reactive`（高频写）、403/404 永久放弃、超时断网 30s 冷却、
  `reset()` 一并清空并清库。
  **只有真缩下来才落盘**：没缩成的那份是 200KB 原图，400 条会把配额吃光。
- `components/ui/ThumbRing.vue`：加两个**可选**入参 `busy` / `pct`。不传就仍读
  `useAlarmStore()`（报警侧三处一个字节没动）；传了就用调用方的值。
- `views/sub/WorkOrderList.vue`：今日 / 历史两个列表的图标位都改成
  `SmartImg v-if="thumbOf"` / `else .insp-pic.alarm-tile + SvgIcon('drone') + ThumbRing`，
  用行元素的函数 ref 登记 `revealThumb`（列表是 v-for，没有子组件挂 `onMounted`）；
  `decorative` 垫底层不取图（主层已经在取同一批 id）。红点位置与判据不变。

### 回归

- 进无人机预警：先看到灰底无人机图标（**与改之前一模一样**），随后逐条换成现场图缩略图；
  取图过程中图标外圈有一圈蓝色进度弧；图到了弧消失。
- 行里没有现场图（`rawFiles` 为空）的条目：永远是占位图标，且**不发请求**。
- 点一条照旧进详情，红点仍只表示「今日 + 待处理」，与有没有图无关。
- 历史页签同样铺图，但不带红点。
- 断网：图标停在占位图（不再转圈），30s 后滚回来会自己再试一次。
- 测试：`work-order-thumb.spec` 13 例（接口 5 / store 5 / 列表 3）；`vue-tsc`、`vite build` 通过。

## 六点三十二、首页预载占位改成与卡片同色（2026-11-20）

`.alarm-tile` 铺的是全站浅灰 `--surface-2`，在白卡上是「图还没到」的正确表达；
首页这套卡片底是深色 `--bg-3`，同一块浅灰成了整屏最亮的一块，看起来像一张白图。

只加一条首页作用域覆盖，**不改正本**：

```css
#page-home .alarm-feed-pic.alarm-tile { background: var(--bg-3); box-shadow: none; }
#page-home .alarm-feed-pic.alarm-tile > svg:not(.tile-ring) path,
#page-home .alarm-feed-pic.alarm-tile > svg:not(.tile-ring) circle,
#page-home .alarm-feed-pic.alarm-tile > svg:not(.tile-ring) rect { stroke: var(--bg-3); }
```

首页里这个占位只有一条渲染路径（`views/home/parts/AlarmFeed.vue`，SafetyPanel 用了它一次）。
轮播的多页 slide 与回卷 clone 共用同一对类名，所以一条规则覆盖首页所有条目；
`.tile-ring` 进度环不在覆盖范围，取图时仍能看到蓝色进度弧。
`InspectItem`（48px 巡检/无人机）、`WorkOrderList`、`MsgPage` 的 `msg-ico`、设备卡 `eq-ico`
选择器都不匹配，一个像素没动。

## 六点三十三、首页进度环「不转 / 看不见」的定位与最小修复（2026-11-20）

### 四个怀疑点逐条核对

| 怀疑 | 结论 |
| --- | --- |
| 加载状态没设上 | **不成立**。`stores/alarm.ts::runThumb` 在 `fetchAlarmPicture` 之前置 `thumbBusy[id]=true`，`finally` 删 key；`pct` 按 `Content-Length` 真实字节推进（`api/video.ts::wfText` 每个 chunk 回调一次），store 侧 `<4` 个点不写、封顶 99。排队中刻意不点亮（`ensureThumb` → `thumbQueue`，`runThumb` 才亮）。 |
| 组件没渲染 | **不成立**。`ThumbRing` 用 `v-if="busy"`，首页传 `:id` 走 store 版；`busy` 与 `pct` 都读得到。 |
| 动画/类名不生效 | **成立，主因。** 旋转只挂在 `.tile-ring.is-indeterminate` 上，而 `is-indeterminate` 的条件是 `pct <= 0`。抓拍图带 `Content-Length`，第一个 chunk 就是几个百分点 → 挂载后一两帧就退出不确定态，**动画刚起头就被摘掉**；剩下只有 `.tile-ring-bar` 的 `transition: stroke-dashoffset .18s`，在 42px 上表现为「弧变长」，不是「转」。 |
| 动画完成前被卸载 | **不成立**。`busy` 存活整段下载（2~3s），比 1s 的旋转周期长；只有「缓存命中」「失败」两种会提前清 —— 那两种本来就不该有环。 |
| 颜色太深看不见 | **成立，次因（本次改动引入）。** 轨道 `rgba(16,24,40,.1)` 是按浅灰底调的，压在 `--bg-3`（#132033）上比底色还深，等于没画；只剩一条蓝弧，更像「卡死」。 |

### 最小修复（只两处声明，且只在首页）

```css
#page-home .alarm-feed-pic .tile-ring-track { stroke: rgba(255, 255, 255, 0.18); }
#page-home .alarm-feed-pic .tile-ring-bar   { stroke: rgba(110, 168, 255, 1); }

@media (prefers-reduced-motion: no-preference) {
  #page-home .alarm-feed-pic .tile-ring { animation: tile-ring-spin 1.1s linear infinite; }
}
```

语义拆成两条互不干扰的信息：**「在转」= 仍在取图**（busy 才挂载，转即加载）；
**「弧多长」= 取了百分之几**（`stroke-dashoffset` 仍按 pct 走）。没改组件、没改 store、
没改其它三处（消息 44px / 巡检 48px / 无人机 48px）的任何一条既有规则。

`prefers-reduced-motion: reduce` 时依旧不转（项目惯例，只留弧长变化）。

## 六点三十四、进度环整颗消失：Vue 的 Boolean prop 缺省转换（2026-11-20）

### 现象

消息页「监控预警」（`InspectList` / `InspectItem`）与首页预警轮播（`AlarmFeed`）的
图标位在取图期间**没有任何进度环**；无人机预警那边正常。

### 链路核对（数据侧全部正常）

```
revealThumb(滚到视口 240px)
  → alarm.ensureThumb(token, id)        入队（排队中刻意不点亮）
    → runThumb: readThumb 未命中 → thumbBusy[id] = true
      → fetchAlarmPicture(token, rid, undefined, onProgress)
        → api/video.ts::wfText 按 chunk 报 got/total（响应带 Content-Length）
          → store: pct <4 不写、封顶 99 → thumbPct[id] = pct
      → 图到 / 失败 → finally: delete thumbBusy[id]、delete thumbPct[id]
```

`thumbBusyOf / thumbPctOf` 的取值本身没有丢，问题出在**组件读不到**。

### 根因：可选 Boolean prop 的「没传」不是 `undefined`

2026-11-20 给 `ThumbRing` 加可选入参时写的是：

```ts
const props = defineProps<{ id: string; busy?: boolean; pct?: number }>()
const busy = computed(() => props.busy ?? alarm.thumbBusyOf(props.id))
```

Vue 的 `resolvePropValue`（runtime-core）对 Boolean prop 有一条缺省转换：

```js
if (opt[0 /* shouldCast */]) {
  if (isAbsent && !hasDefault) value = false
  else if (opt[1] && (value === '' || value === hyphenate(key))) value = true
}
```

`<ThumbRing :id="a.id" />` 属于 **isAbsent**，于是 `props.busy === false`（不是 `undefined`），
`false ?? store` 永远短路 → `busy` 恒为 false → `v-if="busy"` 的 `<svg class="tile-ring">`
整颗不挂载。报警侧三处（消息页监控预警 / 巡检列表 / 首页轮播）都不传 `busy`，
所以同时消失；无人机页显式传了 `:busy` / `:pct`，所以只有它还在 —— 与现场观察完全吻合。

`pct` 是 Number，不受这条规则影响（所以「有没有在下载」错、「进度多少」没错）。

### 修复（一行，且不加新 API）

```ts
const props = withDefaults(
  defineProps<{ id: string; busy?: boolean; pct?: number }>(),
  /* 显式给 undefined 默认值：hasDefault 为真 → 上面那条 false 转换被跳过，
     「没传」保持 undefined，`??` 才能回落 store */
  { busy: undefined },
)
```

`withDefaults` 编译出来是 `{ type: Boolean, required: false, default: undefined }`，
正好命中 `hasDefault`，语义与「可选」的原意一致。组件逻辑、样式、三处调用点都没动。

### 回归闸

`tests/unit/alarm-thumb.spec.ts` 新增两例：

1. `不传 busy 时环按 store 渲染，图到了就消失` —— 只挂 `:id`（与三处调用点一致），
   断言 `.tile-ring` 存在且不是 `is-indeterminate`（有真实字节进度时是确定性态）。
   把默认值改回 `false` 复现旧行为，这条会红 —— 已反向验证过。
2. `没在下载时一颗环都不铺；显式 busy=false 同样不铺` —— 空闲不误显示；
   显式 `busy:true, pct:40` 才渲染（无人机侧形态不受影响）。

## 六点三十五、历史抓拍改走服务端历史接口（2026-11-20）

依据桌面《监控快照接口.docx》（简版，2026-11-20）改写，取代原先「只有最近一帧 + 本机按档存档」的做法。

### 接口（全部 GET，`X-API-Key` 放请求头，密钥不能进 URL）

| 用途 | 地址 | 关键返回 |
| --- | --- | --- |
| 历史列表 | `/api/video/snapshots/history?pid&channelId&page&pageSize[&date]` | `data.items[]` + `data.total`；`page` 从 1、`pageSize` ≤ 100、`date=YYYY-MM-DD` 只支持北京时间近 30 个自然日 |
| 历史图片 | 行里的 `imageUrl`（拼 `MEDIA_ORIGIN`） | 直接是图片字节；响应头带 `X-Snapshot-Mark` / `X-Snapshot-Time` |
| 最新一帧 | `/api/video/snapshots?pid&channelId` | 图片字节（同上响应头） |

`items[]` 一行：`{ mark, capturedAt, timestamp(ms), fileSize, imageUrl, latest }`。
**抓拍时刻以服务端为准**，不再用本机时钟猜「属于 08/12/18 哪一档」；`mark` 是唯一标识，直接当缓存主键。

错误码：400 参数（`date` 越界会把原因写在 `message`）、401 密钥、403 项目无权限、404 无记录或无图、
429 繁忙（按 `Retry-After` 重试一次）、502/503 上游或索引异常。

### 代码位置

- `api/camsnap.ts`：`fetchCamShotHistory()` / `fetchCamShotImage()` / `fetchCamSnapshotWithMeta()`；
  `pageSize` 在 `camShotHistoryUrl()` 里夹到 1~100、`page` 不小于 1（越界服务端直接 400）；
  404 当作「这天没有」返回空页，其余错误抛 `ApiError` 并优先用服务端 `message`。
- `utils/shotArchive.ts`：本机**只做图片缓存**，键 `通道|mark`（IndexedDB v2，升级时整库重建，
  旧「通道|日期|档位」记录直接丢弃）。`ensureShot()` 是唯一取图入口：缓存命中且字节数与
  `fileSize` 一致就直接用，否则按 `imageUrl` 重下并生成 480px WebP 缩略图。保留 30 天 / 64MB。
- `stores/cam.ts::loadShots()`：按 `date` 查列表 → **元信息先上屏** → 图片 2 路并发补（补一张亮一张）；
  列表为空且选的是今天 → 补一次「最近一帧」，只有它的抓拍时刻确实落在今天才摆上来；
  接口整体失败 → 有本机缓存就摆缓存并在说明里写「这是缓存」，没有才报错。

### 首页智眸同步

`stores/patrol.ts::snapShotOf()` 换成「历史列表最新一条（`pageSize=1`）→ 该通道无历史则退最近一帧 →
都失败再用本机缓存最新一张」，与工作台同一个 `ensureShot()`、同一套缓存键。实测 2#/4# 塔吊、
2#门监控等几路服务端没有历史索引（`total=0`）但「最近一帧」可用 —— 所以两条兜底都必须留，
否则首页会从 7 张掉到 2 张；反过来，有历史的通道时刻用的是 `capturedAt`，不再拿「刚取到的这一刻」冒充拍摄时间。

### 页面表现

- 列表标签：`今天 12:00`（真实抓拍时刻）+ 网格三列；图未到时转圈、失败时写「重试」（点击重查这一天）。
- 详情标题：`点位 · 今天 12:00 抓拍`，正文 `抓拍 12:00 · 原图 332KB`；「查看原图」仍是本机缓存里的原字节。
- 空态：只写结论（「这一天没有抓拍记录」）+「重新获取」，失败才写服务端给的原因。

## 六点三十六、下线旧「最新一帧」快照接口（2026-11-20 晚）

现场要求：把旧的 `GET https://115.159.67.12/api/video/snapshots?pid=P000000076&channelId=…`
（不带 `mark`、只回「最近一帧」）连同它的调用方、方法、配置、入口、测试一起删掉。
**注意区分**：带 `mark` 的 `…/api/video/snapshots?channelId=…&mark=…&pid=…` 是历史列表
行里的 `imageUrl`，属文档指定的取图方式，**保留**。

### 删了什么

| 位置 | 删掉的东西 |
| --- | --- |
| `api/camsnap.ts` | `camSnapshotUrl()` / `fetchCamSnapshot()` / `fetchCamSnapshotWithMeta()`；`CamSnapshot` 改名 `CamShotImage`；`camShotImageUrl()` 去掉 `channelId` 形参与「缺 `imageUrl` 就拼快照地址」的兜底（返回空串 → 取图时报「缺少抓拍图片地址」） |
| `stores/cam.ts` | 整个取帧链路：`state` / `note` / `frames` / `frame` / `frameUrl` / `frameAt` / `load()` / `refresh()`；`applyCam`、`openCam` 不再取帧；`clearFrames` → `clearAll`（只清抓拍与档案）；`loadShots` 删掉「今天为空补一次最近一帧」分支 |
| `components/overlays/CamPlayer.vue` | `<video poster>`、断流兜底的 `<img id="camPlayerFrame">`、`busy` / `playDisabled` / `playIcon` / `playLabel` 与被撤掉的中央播放键模板、`onRefresh` + 空态「重试」、`fetchedAt`；说明条不再写「· HH:mm 获取 / 当前为定时快照」 |
| `stores/patrol.ts` | `latestShotOf` 只查 `/snapshots/history?page=1&pageSize=1`，无历史返回 `null`；去掉 `fetchCamSnapshotWithMeta` + `saveShot` 兜底 |
| `styles/app.css` | `.cam-play` 整块（含 `::after` / `:hover` / `.is-busy` / `.is-playing` / 窄屏覆盖）与 `.cam-grid .cam-play` |
| 注释 | `api/config.ts`、`data/cams.ts`、`shotArchive.ts`、`CamPlayer.vue` 里所有「最近一帧 / 定时快照作兜底」的说法 |
| 测试 | `cam-player.spec`（取图 / 空态重试 / 晚到响应 / 快照模式点画面 4 例，改写成「不再取帧」）、`stores.spec`（frameUrl / refresh / 取图失败 3 例，改写 + 「退最近一帧」2 例合成「空就是空」）、`stage5.spec`、`patrol.spec`（`snapOk` → `imgOk`）、`shot-archive.spec`（缺 `imageUrl` 现在必须报错） |

### 行为变化（有意为之，现场已确认）

- **视频监控主画面不再有静态兜底**：`<video>` 没有 poster，断流 / 重连期间画面蒙起来
  （`.is-veiled`，不销毁元素），说明条报引擎原话。iPhone 没有 MSE、FLV 播不了时
  这里就是空的（只剩「仅 RTSP」行交地址）。
- **历史抓拍不再有「最近一帧」兜底**：`/snapshots/history` 为空就是空态。实测
  `2#塔吊 / 4#塔吊 / 钢筋加工棚 / 2#门监控1 / 2#门监控2` 五路 `total=0` —— 这些点位
  今天不会有抓拍图。
- **首页智眸**：抓拍格改成「历史最新一条 → 本机缓存最新一张 → 不出现」。上面那五路
  （含塔吊 2 张、2#门 2 张）只会在本机留有缓存时出现，所以首页「设备设施」后两张
  与「出入口管控」通常只剩 3 张（监控A / 4#门监控 / 4#门外监控）。

## 六点三十七、点「全屏」自动横屏：能力边界与实现（2026-11-23）

需求：点全屏后设备自动转成横屏。**结论是分平台、尽力而为** —— 能不能转不由页面决定，
取决于宿主浏览器是否实现 `Element.requestFullscreen` 与 `screen.orientation.lock`，
以及系统有没有开「旋转锁定」。页面能做的只有三件：申请全屏、申请锁方向、失败时引导。

### 各平台口径

| 平台 / 浏览器 | `requestFullscreen` | `orientation.lock('landscape')` | 点全屏后能否自动横屏 |
| --- | --- | --- | --- |
| iOS 全系（Safari / Chrome / 微信 / 各家 App 内嵌 WebView） | 无 | 无（`screen.orientation` 有，`lock` 未实现） | **不能**，只能提示用户手动横转 |
| Android Chrome / Edge | 有 | 有，须先进全屏 | 能（系统开了旋转锁定时可能被忽略） |
| 华为（HarmonyOS 4 及以下，Chromium 内核）/ 小米 / vivo / OPPO 自带浏览器 | 有 | 多数有 | 多数能，厂商裁剪版可能无效 |
| HarmonyOS NEXT（ArkWeb） | 有 | 支持不完整 | 大概率不能 |
| Android 微信内置浏览器（XWeb / X5） | 版本差异大，多不可用 | 基本无效 | 多半不能 |
| 桌面 Chrome / Edge / Safari | 有 | 抛 `NotSupportedError` | 不适用（桌面无方向），故**不申请** |

### 实现（`src/utils/orientation.ts`）

全部 try/catch，失败静默，不抛错、不留痕：

- `enterNativeLandscape()`：`documentElement.requestFullscreen({ navigationUI: 'hide' })`
  → `screen.orientation.lock('landscape')` → 等 320ms 转屏动画 →
  用「`innerWidth > innerHeight`」这一**观感事实**回报结果。
- `exitNativeLandscape()`：**先 `unlock()` 再 `exitFullscreen()`**（顺序反了会留一段被钉住的方向）。
- `onFullscreenExit(cb)`：只在「有全屏 → 没全屏」时回调，供外壳把横屏态收回来。

接入点三处：

| 位置 | 做什么 |
| --- | --- |
| `shell.openMapLand()` / `closeMapLand()` | 进/出全屏地图时申请与释放；落定后仍是竖屏 → 摆出横屏引导卡 |
| `cam.setCamLand(true/false)` | 监控播放器横屏，同一套 |
| `App.vue` 的 `onFullscreenExit` | Android 返回键 / 桌面 Esc 退全屏时，全屏地图走**收层**、监控只收横屏态 |

### 失败时的提示（`utils/landscapeHint.ts` + `components/shell/LandscapeHint.vue`）

一句 toast 在 iPhone 上等于没说：「请横转手机」在开了竖屏锁定、或在微信里打开时都办不到。
所以换成一条**最简**提示 —— 深色胶囊一行字，无遮罩、无按钮：

```
横屏查看，请关闭「竖屏锁定」
```

> 2026-11-26 调整：原为两行（`把手机横过来看` / `转不动就关掉系统的「竖屏锁定」`），
> 现合成一句；位置也从整屏居中改为贴画面底边、说明文字上方。见六点九十九。

4.2s 自动淡出，点一下也能立刻关；用户自己转过来（`resize` 里宽 > 高）也收掉。
外层 `pointer-events: none`、层级 `z-index: 220`（压在地图层 80 / 监控层 90 / toast 210 之上），
弹着的时候地图照样能拖。**不做「一次会话只提示一次」** —— 没有按钮就没有「已确认」，
错过的人下次进全屏还能再看到。

### 为什么游戏 App 能直接横屏，网页不能

不是技术差异，是**权限层级**差异：

- **原生游戏**（Unity / Unreal / Cocos 打成 APK / IPA）直接调系统窗口 API：
  Android 是 `Activity.setRequestedOrientation(SCREEN_ORIENTATION_LANDSCAPE)`
  或 manifest 的 `android:screenOrientation="landscape"`；iOS 是
  `supportedInterfaceOrientations` 只声明横屏 + `attemptRotationToDeviceOrientation()`。
  由**系统窗口管理器**转屏，不需要用户手势，也不受浏览器策略约束。
- **微信小游戏**走原生渲染（不是 DOM），`game.json` 里 `deviceOrientation: "landscape"`
  由客户端保证横屏。
- **H5 网页**跑在浏览器沙箱里，浏览器**故意**不给 JS 无条件转屏能力：否则广告页可以把你
  手机锁死在横屏、还退不出去。规范因此把 `orientation.lock()` 限死在「全屏 + 用户手势」，
  Safari 干脆不实现。
- **App 内嵌 WebView** 里的网页之所以能横屏，是**宿主 App 在原生层锁的方向**，网页只是跟着
  转 —— 能力来自壳，不来自网页。iOS 上所有浏览器都必须用 WebKit，所以 Chrome / 微信在
  iOS 上跟 Safari 一样没有这个能力。
- PWA 的 `manifest.orientation` 只在**启动时**决定方向（Android Chrome 生效），运行中切不了。

### 风险与边界

1. **对 `documentElement` 全屏，不对画布元素全屏** —— 本项目弹层都 Teleport 到 body，
   只对子元素全屏会把弹层一起藏掉。
2. **桌面不申请**（`isTouchDevice()`：`any-pointer: coarse` 或 `maxTouchPoints > 0`）——
   桌面没有横屏概念，全屏只会藏掉浏览器 UI，还要 Esc 退出、连带收层，纯干扰。
3. **成功判据是视口宽高，不是 `lock()` 的 Promise** —— 桌面 / 平板全屏后天然宽 > 高，
   不该被当成失败去提示用户转屏。

### 风险与边界

- **锁成功但没解锁 = 用户整台手机被钉在横屏**，这是本方案唯一的硬风险。所有退出路径
  （关层、关播放器、组件卸载、系统退全屏）都调 `exitNativeLandscape()`；浏览器在退出
  全屏时也会自动重置方向，是第二重保险。
- 系统「旋转锁定」开着时 `lock()` 多半失败，页面仍是竖屏 → 提示用户手动横转
  （iOS 恒走这条路）。
- iOS 没有任何 JS 手段；`manifest.orientation` 只影响 PWA **启动**方向，做不到「点击后
  转屏」，故不采用。
- `utils/landscape.ts` 有两种模式（2026-11-23 起）：智眸的照片 / 全景传
  `{ page: true, hint: true }`，并入上面这套「整页全屏 + 失败提示」；CamPlayer 的历史
  抓拍大图、AirPlayer 的全景仍走**对画布元素全屏**的老路（它们全屏的就是那块画布本身，
  且提示卡在画布外面、弹了也看不见）。细节见六点三十九。

## 六点三十八、视频画面缩放：复用同一套手势内核（2026-11-23）

现场要求：所有视频展示组件支持画面缩放（移动端捏合 + 明确的放大/缩小/复位控件，
桌面端也能用控件），保持宽高比、限制范围、不影响播放控制与布局。

**后续调整（同日晚）**：画面上的三颗按钮（－ / 复位 / ＋）已整体下线 ——
它们压在直播画面右下角，正好挡住塔吊臂、基坑边这类最需要看清的部位，而画面本身
只有 16:9 的一块，叠一条胶囊控件太占地方。现在**手势是唯一入口**：双指捏合、
双击 1×↔2.4×、桌面滚轮、放大后单指拖动。`components/ui/ZoomCtrls.vue` 与
`.zoom-ctrls` 样式一起删除；`useImageZoom` 的 `zoomTo/zoomIn/zoomOut` 保留为
能力储备（无调用方，要恢复按钮只需再写一份十几行的控件组件）。

### 先摸清有几处视频

全项目只有两处真正渲染 `<video>`，且都没有独立播放器组件（各自直接写 `<video>`）：

| 组件 | 用途 | 视频元素 |
| --- | --- | --- |
| `components/overlays/CamPlayer.vue` | 现场监控直播（FLV 走 `utils/flvStream.ts` 喂 MSE，直连走原生 src） | `.cam-frame`（16:9 画面框内 absolute 铺满） |
| `components/ui/LivePlayer.vue` | 无人机 / 设备实时画面（mpegts.js） | `.live-video`（100%×100%，cover） |

历史抓拍大图、智眸照片、全景都是**图片**，早已用 `utils/zoom.ts` 的 `useImageZoom`
（捏合 / 双击 / 滚轮 / 放大后单指拖动），不在此次范围内。

### 复用而不是再造一套

`useImageZoom` 原本只有四种入口（捏合 / 双击 / 滚轮 / 拖动），**没有可点的控件**。
曾补过两处（现第 2 条已下线）：

1. `utils/zoom.ts` 新增 `zoomTo/zoomIn/zoomOut`（`BTN_STEP = 1.4`，以元素中心为锚，
   位移按 `k` 同比缩放，越界交给已有的 `clampPan`）—— 方法保留，暂无调用方；
2. ~~新增 `components/ui/ZoomCtrls.vue`：三颗按钮（－ / 复位 / ＋），只 emit 不发状态，
   两个视频组件共用同一份 UI~~ —— **2026-11-23 已删除**（挡画面，见开头说明）。

`imgStyle` 另给一个别名 `contentStyle`，视频读这个名字 —— 同一个 computed，
不为「名字合不合适」再拼一次 transform。

### 关键行为

- **范围**：1× ~ 3×。下限 1 是「铺满容器」；再小会在画面里露出底色，等于缩成小窗口。
  上限 3 是因为源是 1080p，再放大只剩马赛克。
- **保持宽高比**：只用等比 `scale`，没有非等比变换；`object-fit: contain/cover` 不变。
- **不影响布局**：`transform` 不参与布局；`DOM` 结构一个字节没动（没有新增包裹层，
  避免动 `.cam-frame` 的 absolute 定位与 `LivePlayer` 的 absolute 铺满）。
- **溢出裁剪**：`.cam-player-stage`、`.live-player` 各加 `overflow: hidden` ——
  放大后的画面只在自己的框里被裁，不会压到说明条、切换点位列表。
- **不抢页面滚动**：视频元素写 `touch-action: pan-y`（`.v-zoomable`），单指竖滑仍归页面，
  只有捏合才缩放；`useImageZoom` 本来就在「未放大时单指不接管」。
- **不影响播放控制**：两个播放器本来就没有原生 `controls`；点画面只触发播放
  （`#camPlayerStage` 的 `onPlay`），缩放手势不拦 click。断流蒙屏时 `.is-veiled`
  有 `pointer-events: none`，手势自然失效。
- **复位时机**：监控换点位 / 关层 / `mediaNonce` 重挂（重连换 `:key`）都 `reset()`；
  无人机换 `src` 也 `reset()` —— 否则新画面会带着上一次的倍数进来。
- **画面上不放任何缩放控件**：手势唯一入口，右下角不再有任何胶囊按钮。

### 为什么不做成一个「视频播放器组件」

`CamPlayer` 的 `<video>` 承担了 FLV 引擎绑定、`:key` 重挂、播放态事件回写 store
（`onMediaPlay/onMediaPause/onMediaBuffering/onMediaError`），`LivePlayer` 的则绑定
mpegts 生命周期。把这层包进通用组件等于把两条播放链一起重构，风险远大于收益；
缩放只是「在手势与样式上叠加一层」，用 composable 叠加是侵入最小的做法。

## 六点三十九、智眸照片查看：「横屏」改「全屏」，并进整页全屏 + 失败提示（2026-11-23）

现场要求：智眸照片查看里那颗「横屏」改成「全屏」，点下去直接进全屏横屏；转不过去时
给提示，**文案与交互跟首页背景图那颗「全屏」完全一致**。

### 为什么不是简单改个文案

原来的 `utils/landscape.ts` 对**画布元素**申请 `requestFullscreen`：画布独占屏幕，
`.phone-screen` 里的提示卡在全屏元素**外面**，弹了也看不见。而首页那套是对
`documentElement` 全屏（整页进全屏），提示卡才能一起进去。所以给 composable 加了两个开关：

| 选项 | 作用 | 谁用 |
| --- | --- | --- |
| `page: true` | 对 `documentElement` 申请系统全屏（`utils/orientation.ts` 的 `enterNativeLandscape`），不再对画布元素全屏 | 智眸照片 / 全景 |
| `hint: true` | 落定后仍是竖屏且是触屏设备 → `openLandscapeHint()`（与首页同一份实现、同一句文案） | 智眸照片 / 全景 |

默认（都不传）= 旧行为，`CamPlayer` 的抓拍大图与 `AirPlayer` 的全景一个字节没变。

### 交互链路

1. 点「全屏」→ `land = true`（同步，画布立刻 Teleport 到 body 铺满视口）；
2. 同一手势栈里 `documentElement.requestFullscreen()` → `orientation.lock('landscape')`；
3. 等 320ms 转屏动画，用「视口宽 > 高」判成败：
   - Android Chromium（Chrome / 华为 / 小米 / vivo / OPPO）→ 真横屏，**不提示**；
   - iOS 全系 / 微信内置 / 系统开了旋转锁定 → 仍是竖屏 → 在画面底部（说明文字上方）
     摆出「横屏查看，请关闭『竖屏锁定』」，4.2s 淡出，点一下即关；
   - 桌面 → `isTouchDevice()` 为假，不申请全屏、不提示（与首页一致）。
4. 再点「退出」/ 系统返回键 → 解锁方向 + 退全屏，画布回弹层内。

### 改动清单

| 位置 | 改动 |
| --- | --- |
| `utils/landscape.ts` | 新增 `LandscapeOptions { page?, hint? }`；`enter/exit/onBeforeUnmount` 按模式分叉；page 模式走 `enterNativeLandscape/exitNativeLandscape` |
| `components/sheets/PatrolSheet.vue` | 两处按钮文案 `横屏/竖屏` → `全屏/退出`（4 字「退出全屏」会把 26px 胶囊撑宽，挤掉「看高清」）；`aria-label`、全景底部提示语同步；两个 `useLandscape` 传 `{ page: true, hint: true }` |
| `styles/app.css` | `.patrol-view.is-land` / `.pano-stage.is-land` 的 `z-index` 48 → **205**：整页全屏后要压住 `.status-bar`(200)，同时低于 Toast(210) 与提示卡(220) |
| `tests/unit/patrol.spec.ts` | 文案断言改「全屏 / 退出」（未运行，按项目红线由用户验） |

### 边界

- 智眸全屏时 `land` 与首页 `mapLandOpen` 互不干扰：`App.vue` 的 `onFullscreenExit`
  只看 `mapLandOpen` / `cam.isLand`，智眸这边由 `useLandscape` 自己的
  `fullscreenchange` 监听把 `land` 收回。
- 方向锁释放：退出按钮走 `exitNativeLandscape`（先 unlock 再 exit）；系统退全屏由浏览器
  自动重置方向，双保险。

## 六点四十、iOS 上全屏「关不掉」的排查与修法（2026-11-23）

现象：iOS 27 上打开智眸照片的全屏后无法关闭。Android 与桌面正常，故不是布局或逻辑走错，
而是 **iOS 这条路径上「退出」这件事本身没有可靠的落点**。逐条列证据与修法。

### 根因排序（按可能性）

| 可能性 | 原因 | 证据 | 修法 |
| --- | --- | --- | --- |
| **P0** | 唯一出口是右上角 26px 胶囊，全屏时 `top:8 right:8` 紧贴屏幕边缘。iOS 横屏右侧是**圆角 + 安全区 + 系统边缘手势区**，边缘 20px 内的触摸会被系统收回，按钮大半面积落在这一带 | `.pano-tools{top:8;right:8}` 与 `.pano-tool{height:26}`；全屏态此前**没有**任何其它出口 | 工具条退进 `env(safe-area-inset-*)`；点画布黑边也退出（底部 40px 大按钮曾作第二出口，当日按现场要求下线，见下节） |
| **P1** | `exitNativeLandscape()` 以 `if (!fullscreenElement()) return` 为前置条件。iOS / 微信里这个属性常读到 null（即使已在全屏），于是**根本不发 `exitFullscreen`** | `orientation.ts` 原实现；iOS 上 `document.fullscreenElement` 不可靠是长期已知行为 | 无条件调 `exitFullscreen`（没全屏时只会 reject，catch 掉）；300ms 后复查再退一次 |
| **P2** | 只监听 `fullscreenchange`，没听 `webkitfullscreenchange`；判断也只看 `document.fullscreenElement` | `landscape.ts` 原实现 | 两个事件都监听，判定用 `fullscreenElement ?? webkitFullscreenElement` |
| **P3** | 图片手势 `setPointerCapture` 在异常路径残留（`pointercancel` 没释放、也没有 `lostpointercapture` 清理）。残留的 pointerId 会让下一次点击被当成「第二根手指」，click 不产生 | `zoom.ts` 的 `onPointerup` 有释放、`onPointercancel` 没有；无 `lostpointercapture` | `pointercancel` 补释放；新增 `lostpointercapture` 清理指针表 |
| **P4** | 返回逻辑没有「先退全屏」这一级：iOS 侧滑由 Safari 认领，走 `historyBack` 的层数（直接关整个弹层） | `utils/historyBack.ts` 的 `depth` 只看 store 的层 | **未改**：关弹层等于退出全屏，可接受；若要求「滑一次只退全屏」，把 `land` 并入 depth |
| **P5** | iOS 27 是否已开放非 `<video>` 元素的 Fullscreen API —— 决定 P0 与 P1 谁是主因 | 需真机 | 两条都修，不依赖结论 |

判断分叉：点全屏后**屏幕真的转成横向** → 说明进了系统全屏，主因在 P1/P2；
**画面只是铺满、手机没转** → 系统全屏没进去，主因在 P0/P3。

### 改动

| 文件 | 改动 |
| --- | --- |
| `utils/orientation.ts` | `exitNativeLandscape` 去掉 `fullscreenElement()` 前置判断，无条件退全屏 |
| `utils/landscape.ts` | 加 `webkitfullscreenchange` 监听；`systemFullscreen()` 含 webkit 前缀；退出后 300ms 复查（带 `!land` 守卫，防止把 300ms 内重新打开的全屏又退掉） |
| `components/sheets/PatrolSheet.vue` | 照片 / 全景全屏时画布 `@click.self` 点黑边退出（底部「退出全屏」按钮已下线，见下节） |
| `styles/app.css` | 全屏态 `.pano-tools` 退进安全区（`.land-exit` 已随按钮一并删除） |
| `utils/zoom.ts` | `pointercancel` 释放捕获；新增 `lostpointercapture` 清理 |

### 后续：底部「退出全屏」按钮下线（同日）

现场看过实际效果后要求：全屏画面里不要那颗按钮。于是删掉 `PatrolSheet.vue` 两处
`<button class="land-exit">`（含 `@click` 绑定）、`app.css` 的 `.land-exit` /
`.land-exit:active` 整段、以及那段注释里关于第二出口的描述。

**退出全屏能力没有减弱**，仍有三条路：

1. 右上角工具条那颗「退出」（`togglePanoLand` / `togglePhotoLand`）—— 现在它在
   `env(safe-area-inset-*)` 之内，不再压在圆角与边缘手势区上；
2. 点画面四周黑边（画布 `@click.self` → `onPanoBackdrop` / `onPhotoBackdrop`）；
3. 系统返回键 / Esc —— `fullscreenchange` + `webkitfullscreenchange` 把 `land` 收回，
   `exitNativeLandscape` 的 300ms 复查仍在。

删掉的只是「可见的第二颗按钮」，`P1`/`P2`/`P3` 三项修复（无条件退全屏、webkit 事件、
pointer capture 清理）全部保留，它们才是真正让 iOS 退得出去的东西。

## 六点四十一、退出全屏回竖屏后「整页向上偏移」：视口落定与安全区兜底（2026-11-23）

现象：iOS 27 iPhone，首页点「全屏」进横屏，再退出回竖屏，整页上移（底部露背景 / 顶栏变矮）。

### 尺寸链路先理清

`.stage`（`100dvh`）→ `.phone`（真机 `100dvh`）→ `.phone-screen`（`100%`）→
`.page`（`absolute inset:0`，首页 `overflow:hidden`）。顶部留白单独走 `--status-h`
（真机 = `env(safe-area-inset-top)`），被 6 处复用：`.status-bar` 高度、`.navbar` 的
`height` 与 `padding-top`、`.map-land` / `.cam-player` / `.air-player` / `.hazard-page`
的 `inset-top`、`.home-top` 的 `top`。

`.page` 是 `inset:0` 的绝对定位，**高度不跟着 navbar 变**，所以「整页上移」不可能来自
导航栏内容塌陷，只能来自下面三条：

| 可能性 | 机制 | 修法 |
| --- | --- | --- |
| **P0** | 自定义属性里的 `env()` 会缓存：横屏时 `safe-area-inset-top` 为 0，退出后 `--status-h` 仍是 0 → `.status-bar` 高 0、`.navbar` 矮 47px、4 个覆盖层 `top` 少 47px | 6 处使用点改 `max(var(--status-h), env(safe-area-inset-top, 0px))`，把 `env()` 放回普通属性值里参与每次布局计算 |
| **P1** | `documentElement` 全屏进出会改写 `scrollY`，`html,body{overflow:hidden}` 只禁手势滚动、拦不住系统写值；残留几十 px → 整页永久上移且滑不回来 | `settleViewport()` 里 `window.scrollTo(0,0)` + 根/body 的 `scrollTop = 0` |
| **P2** | `.stage` / `.phone` 用 `100dvh`，iOS 旋转 / 全屏切换后可能滞后若干帧 | `settleViewport()` 先「写自定义属性 → 读 `offsetHeight`」强制同步重排，催 `dvh` 重新求值 |
| **P3** | 首页抽屉半开位是 inline px（`sheetAnchors()` 按 `#page-home` 实测高度算）；`resize` 在转屏动画**期间**触发，读到的是旧高度 → 抽屉定在偏上位置 | `onResize` 立即算一次 + 360ms 后再校准；另加 `orientationchange` 监听 |

### 新增 `utils/orientation.ts::settleViewport()`

进 / 退全屏落定后统一的收尾，三件事按顺序做：强制重排 → 归零文档滚动位 →
340ms 后 `dispatchEvent(new Event('resize'))`（让依赖视口的组件重算）。

调用点四处：

| 位置 | 时机 |
| --- | --- |
| `enterNativeLandscape()` 末尾（`afterRotate` 之后） | 进系统全屏、方向锁落定 |
| `shell.closeMapLand()` | 首页全屏地图点「退出」 |
| `cam.setCamLand(false)` | 监控播放器退横屏 |
| `App.vue` 的 `onFullscreenExit` | 系统方式退出（Android 返回键 / Esc / 智眸照片的全屏）—— 覆盖不经过上面两个 store 开关的路径 |

### 为什么 `--status-h` 不能只靠变量

`:root { --status-h: env(safe-area-inset-top, 0px) }` 在真机分支里，值本身是一次求值后缓存的；
旋转 / 全屏切换后变量可能仍给旧值。把 `env()` 写进 `height` / `padding` / `inset` / `top`
这些**普通属性**里，每次布局都会重新求值，且桌面（`env()`=0）时 `max(32px, 0)` 仍是 32px，
与改动前逐像素一致。

### 验证要点

1. iPhone 首页：全屏 → 手动/自动横屏 → 退出，顶部状态栏留白与顶栏高度应恢复原样；
2. 退出后不要出现「内容整体上移、底部露背景」；页面也不该能被上下拖动；
3. 抽屉半开档退出全屏后应回到与之前相同的位置，不偏高；
4. Android：进出全屏后 `--status-h` 与覆盖层位置一致；桌面预览壳仍是 32px 留白。

## 六点四十二、历史抓拍 / 航拍全景的「横屏」统一改为「全屏」（2026-11-23）

现场要求：历史抓拍里照片右上角那颗「横屏」换成「全屏」，样式、图标、点击交互、
进出全屏后的观感都要与**首页-智眸**里的照片全屏按钮一致，且覆盖所有照片展示场景。

### 还剩哪两处

全项目四份 `.pano-tools` 里，智眸的两份（VR 360 / 单张照片）在六点三十九已改完。
这次清掉最后两处，都是 `useLandscape()` 的**默认（画布全屏）**模式：

| 位置 | 场景 | 原按钮 |
| --- | --- | --- |
| `overlays/CamPlayer.vue` | 历史抓拍详情大图（截图里的「地磅全景」） | `横屏 / 竖屏` |
| `overlays/AirPlayer.vue` | 航拍照片弹层里的全景 | `横屏 / 竖屏` |

### 做法：只换两个开关，其余完全复用

两处 `useLandscape()` → `useLandscape({ page: true, hint: true })`：

- `page`：对 `documentElement` 申请系统全屏（整页全屏），不再只把画布塞进全屏 ——
  提示卡挂在 `.phone-screen` 里，只有整页全屏才跟着进去；
- `hint`：落定后仍是竖屏且是触屏 → 摆出与首页一字不差的
  「把手机横过来看 / 转不动就关掉系统的「竖屏锁定」」。

按钮文案与智眸同形：未全屏 `全屏` / 已全屏 `退出`（不用「退出全屏」——四字会把
26px 胶囊撑宽，把并排的「查看原图」「复位」「看高清」挤走）；`aria-label` 与
`aria-pressed` 同智眸。

### 层级与安全区

整页全屏后页面上还有 `z-index: 200` 的 `.status-bar`，画布必须抬到它之上：

| 选择器 | 原 | 现 |
| --- | --- | --- |
| `.cam-shot-stage.is-land` | 96（只为压过 `.cam-player` 的 90） | **205**（同时压过 90 与 200，低于 Toast 210 / 提示 220） |
| `.cam-shot-pop.air-pop .pano-stage.is-land` | 96 | **205**（同上） |

全屏态工具条一并退进 `env(safe-area-inset-*)`：安全区那条规则的第三个选择器补
`.cam-shot-stage.is-land .pano-tools`（航拍全景命中已有的 `.pano-stage.is-land`）。

### 顺带补齐的视口落定

`useLandscape` 的 `page` 模式此前只有**进入**侧落定（`enterNativeLandscape` 内部调
`settleViewport`）。这次补上退出侧三处：`exit()` 退完全屏后、系统方式退出
（`onFullscreenChange` 收到「有→无」）、`onBeforeUnmount` 退全屏后 —— 否则同样会
出现六点四十一说的「退回竖屏后整页上移」。

### 验证要点

1. 历史抓拍点开一张 → 右上角是「全屏」，点下去画面铺满并尽力横过来；Android 不弹提示、iOS 弹那句两行提示；
2. 再点「退出」→ 回弹层原位，顶部状态栏不露白、页面不上移；
3. 航拍照片弹层里的全景同形；
4. 桌面点「全屏」= 铺满可视区，不弹提示（`isTouchDevice()` 为假）。

## 六点四十三、监控「切换点位」列表：去掉标题行 + 分组标题加分隔线（2026-11-23）

现场要求：删掉「切换点位」四个字，并在「设备设施 / 材料堆场 / 出入口管控」三个分组
标题后面各加一条与标题对齐的水平细线，增强分区层次，其余不变。

| 位置 | 改动 |
| --- | --- |
| `overlays/CamPlayer.vue` | 删掉 `.cam-player-switch` 里的 `<p>切换点位</p>` |
| `styles/app.css` | 删除已无用的 `.cam-player-switch > p`（margin / 字号 / 颜色三条）；新增 `.cam-chip-group h5::after` 1px 线 |

细节：

- 线用 `::after` 而不是插一个空 `<i>`：`h5` 本来就是 `display:flex; align-items:center`，
  伪元素作为最后一个 flex 项 `flex: 1` 自动吃满行尾，并且天然与标题文字**垂直居中**，
  不需要写任何 top / 偏移量；计数 `<em>` 在它前面，所以线从数字之后才开始画。
- 线的颜色用 `--line`（与 `.cam-chip` 的 1px 描边同一支），高度 1px。
- 删掉标题行后，列表整体上移约 28px（那一行 18px 行高 + 10px 下边距），
  这是删文字的必然结果；容器顶部 12px 内边距与分组间 14px 间距都没动。

## 六点四十四、智眸「VR 360 环视」卡片：缩略图按画面比例放开高度（2026-11-23）

现场要求：红框那张「向阳村-全景」的缩略图垂直高度调高，水平位置、缩放比例、
画面比例都不变，且画面完整、不裁切不拉伸。

### 为什么原来是一条窄带

`.patrol-thumb` 钉死 `height: 96px` + `object-fit: cover`，全站航拍 / 抓拍（16:9）
用着合适。但项目全景的预览是重建成果的 `thumbnail`，**3162×1581 ≈ 2:1**；塞进
约 3.6:1 的窄条后，cover 按宽度铺满（343 宽 → 渲染 343×171.6）再上下裁掉近一半。

### 改法：只把高度还给比例

```css
.patrol-card.is-pano .patrol-thumb {
  height: auto;
  aspect-ratio: 3162 / 1581;
}
```

- **缩放比例不变**：cover 在 96px 与 171px 两种高度下都按宽度铺满，scale 完全相同
  （都是 343/3162），改的只是「露出多少」；
- **水平位置不变**：宽度仍是卡片满宽，图左边缘贴着卡片内边缘；
- **画面完整不裁切**：`width / 2` 正好是整张图的高度，没有可裁的部分，也不会像
  `contain` 那样在左右留黑边（那会把水平缩放改小）；
- **不塌陷**：用 `aspect-ratio` 而不是 `img { height:auto }` —— 图是 `loading="lazy"`，
  高度若由图片撑开，加载前整卡会先塌成一条（`.patrol-thumb` 注释里那条老坑）。

### 补一步：图片必须绝对定位铺满

第一版只写了 `height: auto; aspect-ratio`，结果截图里出现上下两条卡片底色 ——
**图片没被撑满**。原因是通用那条 `img { height: 100% }` 的百分比要相对父级的
**计算高度**解析，而这里的父级高度是 `auto`（由 `aspect-ratio` 在布局期算出），
浏览器按 `auto` 处理 → 图片退回自身高度并在 flex 里居中，于是上下各留一条。

修法：给全景这张图单独加 `position: absolute; inset: 0; width/height: 100%` ——
`.patrol-thumb` 本来就是 `position: relative`，`inset: 0` 拿到的是确定的容器盒，
不受百分比解析影响。`object-fit: cover` 保留；容器与图片同为 2:1，实际零裁切。

### 范围

只命中 `.patrol-card.is-pano`（`v-if="activeCat === 'pano' && patrol.pano"` 那一张，
即「VR 360 环视」里的项目全景）。「全景航拍」列表里的全景照片仍是 96px 窄条 ——
如果要一并放开，把同一段规则的选择器从 `.patrol-card.is-pano` 换成一个按
`img[src*=…]` 或给 v-for 卡片加 `is-pano` 类即可，其余不动。

## 六点四十五、智眸照片卡片：删掉「分类 + 来源」胶囊行，时间单独一行（2026-11-23）

现场要求：删掉红框那一行「全景航拍 · 无人机」，并把时间从标题同一行移到下一行
单独显示，行距 / 上下间距 / 对齐方式一起理顺；其余元素（缩略图、角标、体积、
标题、筛选、页签）不动。

### 位置

`src/views/home/PatrolPanel.vue` 的 `.patrol-card-ft`（两种卡片：`pano` 全景卡与
`v-for="p in shown"` 的普通卡），样式在 `src/styles/app.css` 的 `.patrol-card-ft` 一段。

### 改动

```html
<!-- 普通卡：整行 patrol-tags 删除 -->
<div class="patrol-card-ft">
  <div class="patrol-card-name"><strong>{{ p.taskName }}</strong></div>
  <p class="patrol-card-time">{{ p.time.slice(0, 16).replace('T', ' ') }}</p>
</div>
```

- 时间由 `.patrol-card-name` 里的 `<em>`（`margin-left:auto` 顶到右边）换成
  `.patrol-card-ft` 的第二个 flex 子项 `<p class="patrol-card-time">` —— 竖向
  flex 里就是「下一行」，`display:block` + `margin:0` 让它左对齐贴齐标题起点。
- 字号仍 `--fs-11`、颜色仍 `--ink-3-dark`、粗细 400，只把 `line-height` 收到 1.3；
  `.patrol-card-ft` 的 `gap` 由 6px 收到 4px（少了一行 16px 胶囊，两行文字之间
  不该再空一个标签的高度）。
- **标题因此拿满整行宽度**：原来时间挤在右边，标题被 ellipsis 截成「向…」。
- 骨架卡（`syncing` 与 `catLoading` 两处 `is-skel`）补一条 `Skel w="45%" h="11px"`
  对应时间行，数据回来不跳高。
- 「VR 360 环视」的全景卡**保留**「可环视 / 无人机」那行（`可环视` 是功能提示，
  不在红框里），但时间同样改到独立一行，顺序为 标题 / 时间 / 标签。

## 六点四十六、智控面板三处（09:0x，2026-11-23）

现场给了三张标注图，要求只改三处：①智能爬架卡的图标换成参考稿那张；②爬架三格里
「有任意机位越限」的数字转红；③超限说明行的背景换成参考稿的暗红。其余布局、数据、
功能都不动。

### ① 图标：换资源，不改代码

- 新图取自设计稿仓库 `img/eq-climb.jpg`（1024×1024），按既有立绘规格缩到
  **256×256、q86** 转 webp，覆盖 `public/img/eq-climb.webp`（6.8 KB → 8.8 KB）。
- 老图是同一台设备的**特写**：石墙几乎占满画面、三层平台被右边缘切掉；参考稿是
  **全身像**（细长墙板 + 三层完整平台 + 四周留白）。所以这不是裁切参数问题，
  是资源本身换了 —— CSS 一行都没动。
- `.eq-ico` 是 64×64 方框 + `img { width/height:100%; object-fit:cover }`，源图同为
  方形，cover 实际不裁；尺寸、居中、点击区域全不变。
- 文件名不变，`tests/unit/guards.spec.ts` 的图片清单无需改。

### ② 数字转红：按指标判，不是全场判

- `EquipPanel` 的 `ClimbCell` 加 `bad`：`cell.total > 0 && cell.normal < cell.total`。
  依据是 `utils/scaffold.ts::worstOf` 里 `normal = total - 超限台数`，所以
  「正常数少于总数」等价于「该指标下有 ≥1 个机位越限」；`total = 0`（格子显示「—」）
  不算异常。
- 模板：`<em class="eq-ok" :class="{ 'is-bad': cell.bad }">`。
- CSS：`#page-home .eq-card.is-climb .eq-val b em.is-bad { color: var(--danger-dark) }`，
  特异性（1 id + 4 class + 2 元素）压过基础段的 `--online` 绿；全部正常时自动回落绿色。
- **三格各判各的**：参考稿里「左右倾斜 35/36」红、「前后倾斜 / 载荷 36/36」绿 ——
  不是「全场有一台越限就三格全红」，否则三格会同时变红，与参考稿不符。

### ③ 超限说明行：深色 wash

- 基础段 `.eq-climb-note.is-bad` 用的是 `--danger-wash`（#FDECEE 浅粉），那是白卡
  配色；落在智控深色卡上是一块发光白条。
- 参考稿实测：条底 `(49,39,57)` 叠在卡片底 `(21,31,50)` 上，反解即
  `rgba(255,107,107,.12)`（= `--danger-dark` 的 12%）。新增令牌
  **`--danger-wash-dark`**，在 `#page-home` 作用域覆盖该行底色。
- 字色同时换成 `--danger-dark`：底色压深后 `--danger`（#F53F3F）与该底只约 4:1，
  12px 粗体不达 AA；参考稿用的也是提亮后的红。

### 范围

只动 `public/img/eq-climb.webp`、`EquipPanel.vue`（`climbCells` + 一处模板）、
`app.css`（一个令牌 + 两条 `#page-home` 规则）。爬架详情页（`views/sub/ClimbPage.vue`）
的分项卡片没有改 —— 那边不是「红框 2」所在的位置。

### 补充（10:2x）：爬架详情页表头数字跟着卡片变红

现场反馈：智控面板里那一格已经按「有越限就转红」显示，但点进「智能爬架」详情页，
同一个 `37/38` 的 37 还是绿的 —— 同一份数据两处两个结论。

- `views/sub/ClimbPage.vue` 新增 `cellBad`：`total > 0 && normal < total`，
  与 `EquipPanel` 的 `ClimbCell.bad` **同一条判据**（都从 `normal = total - 超限台数` 推）。
- 模板 `<b :class="{ 'is-bad': cellBad }">`，只作用于表头那组数字。
- `app.css`：`.climb-board header b.is-bad { color: var(--danger-dark) }`。
  分母 `i` 自带 `--ink-1-dark`，不随 `b` 走，所以「37/38」里红的只有 37；
  字号 / 字重 / 行高 / 布局一行没动。
- 三个页签各判各的（`cellNow` 是当前页签的 cell）：只有越限的那个指标会红，
  切到「前后倾斜 / 载荷」时若全在阈值内仍是原来的绿。

## 六点四十七、无人机页三处 + 今日任务剔除「光谷元著」（2026-11-23）

现场给了两张图三处标注：①「今日任务」等任务数剔除光谷元著；②飞行参数七格整块
删掉；③「机库」页签删掉；随后追加一条：「今日任务」弹层里的光谷元著也要剔除。

### ① 任务数与明细：改回「只本项目」，两条链一起改

服务端本来就支持过滤（`fetchTaskStat` 早有 `{ pid }`，实测 `?pid=193640872670213`
回 15、不带回 23 = 15 + 光谷元著 8）。所以不动解析，只改调用口径：

| 位置 | 原先 | 现在 |
|---|---|---|
| `stores/uav.ts::load` | `fetchTaskStat()` / `fetchTodayRecords({start,end})` | `fetchTaskStat({ pid: KH_IDS.pid })` / `fetchTodayRecords({..., pids: [KH_IDS.pid] })` |
| `stores/uav.ts::refreshSlow` | 同上（30s 那一轮） | 同上 |
| `stores/uav.ts::loadStat`（首页卡） | `fetchTaskStat()` | `fetchTaskStat({ pid: KH_IDS.pid })` |

- **三格一起过滤**，不是只改「今日任务」那一格：否则「已完成 16 / 今日任务 12」
  会自相矛盾（已完成不可能多于总数）。
- **明细一起过滤**：`fetchTodayRecords` 本来先取账号下所有 pid 再逐个拉；传
  `pids: [本项目]` 后只发 1 个请求（少 3 个），弹层里也就只剩向阳村的航线。
  `todayHasOthers`（「含同账号其它项目的任务」）随之恒为 false，**代码保留**作兜底。
- 连带影响：首页「无人机 · 今日作业次数」读的就是同一个 `finishedCount`，
  现在也只算本项目 —— 与无人机页那格同值同源，两处不会再打架。

### ② 飞行参数七格整块下线

`views/sub/UavPage.vue` 删掉 `.uav-fly` 那段（状态 / 海拔 / 飞行距离 / 水平速度 /
垂直速度 / 翻滚角 / 偏航角）。连带清理只为它服务的 `speed()` / `deg()` 两个格式化
函数（`noUnusedLocals` 会报）。遥测本身仍每 2s 刷新 —— 设备参数那几格（状态 /
电量 / 距机库 / 续航 / 风速 / 网络质量 / 网络速率 / 电池温度）和起飞校验都在用。

### ③ 「机库」页签删除

删掉 `dev-tabs` 里的机库按钮，`tab` 恒为 `'fly'`（状态与 `streamNow`、播放器
`:key` 的写法保留，将来加回来只需补一个按钮）。机库那套读数（在库 / 充电 /
舱温 / 湿度 / 网速）随之不再可达，整块删除；`dockIn` / `chargeText` 两个
computed 一并删除。机库直播流仍由 store 取（结构没拆），只是没入口展示。

### 提示

- 机上「今日任务」从 20（账号）会变成只算向阳村的值，属预期。
- `todayRecords` / `own` / `todayHasOthers` 的口径注释已同步改写，回退时把
  `pid` / `pids` 参数去掉即可。

## 六点四十八、任务「失败」在 `result`，不在 `status`（2026-11-23 实测）

现场问「为什么列表里看不到失败任务、15 与明细条数为何对不上」，用项目凭据直连复核：

### 实测数据（16:4x）

| 来源 | 结果 |
|---|---|
| `GET /dashboard/task/list/record?pid=…` | `taskCount 15 / finishedCount 12 / failedCount 1 / planCount 2` |
| `POST /api/open/v1/task-record/page`（今天→明天，本项目） | `total 13`，**全部 `status:2`**，唯一 `result:3` 的是 15:00「向阳村-安全巡检」 |
| 近 14 天（204 行） | `status` 全 2；`result` 只有 `0`×202、`3`×2 |
| 旧 `/task/exec/list/record?start=今天&end=明天` | 30 行 = 12 完成 + 1 失败 + 17 未执行，**并混进次日 15 条排班** |

### 结论

1. **`status` 只表示「有没有这条执行记录」**：已执行恒为 2；`-1` 是「未执行」的计划项。
2. **飞行结果在 `result`**：`0` 成功、`3` 失败、`4` 未执行。`failedCount` 就是当日 `result===3` 的条数（今天恰为 1），`finishedCount` 只数 `result===0`（12）。
3. 因此 15 = 12 成功 + 1 失败 + 2 未执行计划；明细 13 = 12 + 1＝已产生记录的项。**两个数字口径不同，不是漏取**。
4. 旧接口把次日排班也返回（`end` 语义宽松），所以「今日」必须在本地按 `start.slice(0,10)` 再滤一次 —— 现由 `stores/uav.ts::todayRecords` 负责。

### 已改（2026-11-23 下午）

| 位置 | 改动 |
|---|---|
| `api/drone.ts::DroneTaskRecord` | 新增 `result: number | null`（枚举与依据写在字段注释里） |
| `toOpenTaskRecords` / `toTaskRecords` | 读 `o.result` —— 以前声明了不读，失败信息在解析这步就丢了 |
| `stores/uav.ts::stateText/stateClass` | 先看 `result` 再看 `status`：`result===3` → 已失败 / `is-bad`；`result===4` 或 `status===-1` → 未执行 |
| `api/drone.ts::DroneTaskStat` | 新增可选 `pending: DronePlanTask[]`，`toTaskStat` 解析 `unfinishedTaskList[].tasksDetail` |
| `stores/uav.ts::todayPending` | 把「当天还没飞」的计划项并进 `todayTasks`，按 `taskId + start` 与记录去重；合并后按开始时间倒序（接下来要飞的在最上面） |
| `components/sheets/UavTodaySheet.vue` | 清单直接渲染 `todayTasks`，未执行的行走 `is-plan`（`--ink-4-dark`，比已完成再淡一档） |
| `app.css` | 新增 `.uav-log em.is-bad`（`--danger-dark`）与 `.uav-log em.is-plan` |

结果：清单 = 12 完成 + 1 失败 + 2 未执行 = 15，与三格 `taskCount` 一致。

### 仍未动的取舍

- 首页「今日作业次数」仍取 `finishedCount`（=12，只算成功，与 V2 卡片一致）。若要「出勤架次」应改 `finished + failed`，指标名也要跟着改成「出勤次数」，需用户点头。
- `status===-1` 的记录只在旧接口出现；若哪天把明细切回 `/task/exec/list/record`，必须**本地按日期过滤**（实测会把次日 15 条排班一起返回）。

## 六点四十九、智控面板无人机卡：复用「当前巡检」进度条（2026-11-23）

现场要求：把无人机页那条进度条**复用**到首页智控面板的无人机卡上（红框位在
「12次 / 今日作业次数」下方），默认隐藏、有任务执行时自动出现并按状态实时更新、
任务完成后消失；无人机页已有那条**一行不改**。

### 复用的是什么

| 层 | 来源 | 首页是否重写 |
|---|---|---|
| 条的样式 | `.uav-bar` / `.uav-bar i`（4px、圆角、`--blue-2`、0.3s 缓动） | 否，同一个 class |
| 百分比算法 | `utils/uavProgress.ts::missionProgress()` | 否，同一个函数 |
| 数据 | `uav.running`（起飞时刻）+ `uav.runningEstimate`（同任务历史中位数） | 否，同一个 store |
| 版面 | 无人机页是「标题 / 条 / 说明」三段 | **是** —— 首页只有两行位置，见下 |

新增组件 `src/components/ui/MissionBar.vue`：根节点是 `span`（卡片是 `<button>`，
只能放 phrasing content），内部「当前巡检 · 任务名 + 百分比」一行、`.uav-bar` 一行。
完整说明（起飞时刻 / 已飞 / 预计）走 `title`，同时并进卡片的 `aria-label`
（读屏拿不到内层文本，卡片自身的 aria-label 会盖掉子树）。

### 什么时候出现（默认隐藏）

`EquipPanel.vue::droneMission` —— **任务在跑 + 百分比算得出来**，两者都满足才渲染：

- 没有执行中的任务 → `v-if` 为假，整块不渲染，卡片与改动前完全一致；
- 任务在跑但该航线一次都没完整跑过（没有历史分母）→ `pct === null`，
  同样不渲染。这与无人机页一致：不拿 0% 或排班间隔凑一条「看起来在动」的条。

`has-mission` 这个 class 跟进度块一起加，卡片才会从「横向一行」切成「纵向两段」
（与 `.eq-card.is-climb` 同一思路）—— 否则 `.eq-card` 是 flex 行，进度块会被摆到
右侧箭头旁边。

### 数据从哪来（首页原先拿不到）

首页只打 `loadStat()`（统计接口），没有今日明细 → `uav.running` 永远为空。
新增 `stores/uav.ts::loadMission()`：

- 取本项目今日明细（`fetchTodayRecords({ pids: [KH_IDS.pid] })`）；
- 真有执行中任务时才 `loadEstimates()`（7 天记录算中位数，内部 6h 缓存）；
- **失败静默**、不改 `state`（卡片少一条进度条，比把整页判成失败好）；
- **60s 冷却**：首页 30s 一拍地调（`settle` 用的同一个 ticker），实际约两拍一个请求；
  没任务时也照调，否则任务 09:45 起飞后一直停在首页的人永远等不到进度条。

### 版面细节

- `.eq-card .mission-hd strong` 用了 `flex: 1 1 auto` + `min-width: 0` + ellipsis
  三件套：航线名可能很长（「向阳村-高空作业面全景拍照」），少写一条就会把百分比
  顶出卡片、或者整行被裁掉半截字。
- 字号 `--fs-12`（与卡片标题同级）、颜色走 `#page-home .eq-card .mission-hd strong
  → --ink-1-dark`（基础段的 `--text` 在 `#132033` 上等于看不清）；百分比 `--fs-11`
  + `--blue-2`，与无人机页 `.uav-mission-hd em` 同色。
- 净增高约 34px（15px 标题行 + 6px + 4px 条 + 8px 段间距），只在有任务时发生。

### 范围

新增 `components/ui/MissionBar.vue`；改 `stores/uav.ts`（`loadMission` + 导出）、
`views/home/EquipPanel.vue`（import / `now` + ticker / `droneMission` / 卡片一处模板 /
`ariaOf` 补一句）、`styles/app.css`（一段 `.eq-card.has-mission` + `.mission-*`）。
`views/sub/UavPage.vue` 一行未动。

### 补充（17:2x）：两处进度条百分比不一致 —— 时间源有两套

现场截图：同一条「当前巡检 · 向阳村-土方1」，首页卡片写 50%、无人机页写 61%。

**根因不是算法，是时钟。** 两处各持一份时间：

```ts
const now = ref(Date.now())                            // 初值 = 各自 setup 的时刻
setInterval(() => { now.value = Date.now() }, 30_000)  // 相位 = 各自挂载的时刻
```

`setInterval` 的相位只由「什么时候 start」决定。首页先挂、无人机页后进，两条
定时器对不齐；6 分钟分母下 30 秒就是 8 个百分点，加上「刚进页面那一拍还是旧值」
与点进/截图的间隔，就是现场的 11 个百分点。`missionProgress()` 本身没问题 ——
同参数必然同结果，差异全在 `now`。

**修法**：新增 `src/utils/missionClock.ts`，两处共用一个 `now`。

| 要点 | 做法 | 为什么 |
|---|---|---|
| 唯一时间源 | 模块级 `ref`，`useMissionClock()` 返回 `readonly` | 两个 `ref` 就会有两个数，包一层 `readonly` 断掉「手动拨表」的后路 |
| 网格对齐 | `setTimeout` 链，每次按 `TICK - Date.now() % TICK`（TICK = 5000）预约 | `setInterval` 的相位由启动时刻决定；对齐到整 5 秒后，谁先启动都落在同一批时刻 |
| 进页对表 | `start()` 先 `nowRef.value = Date.now()` | 从别的页面进来时第一眼就是当前值，不用等下一拍 |
| 引用计数 | 订阅 +1 / 退订 -1，归零才 `clearTimeout` | 切走 tab、关子页都不留定时器；再进来重新对表 |

调用方改动：`EquipPanel` 删掉 `now` 的 30s 写入（那条 interval 保留，只做
`loadMission()` 的「有没有新任务」检查）；`UavPage` 整条 ticker 删除。

粒度 5 秒：6 分钟分母下每跳 1.4%，条几乎看不出在动，而两处差值的上限从
「近 30 秒」收到「tick 边界内的一瞬」。

### 补充（17:2x）：验收用的模拟任务已下线

`stores/uav.ts` 里那段 `?simMission=1`（`SimMission` 结构 + URL 解析 +
`running` / `runningEstimate` 的模拟分支）已整体删除。验收目的已经达成
（进度条能出现、两处一致），留着它就是一条「能造出不存在任务」的暗门 ——
尽管有 `import.meta.env.DEV` 守卫，但它会把「当前巡检」这个字段的来源变成
两种可能，排查问题时反而要多问一句「这条是真的吗」。

现在 `running` / `runningEstimate` 只有一个来源：今日记录里 `own && is-ok`
的那一条 + 同航线的历史实测中位数。`dist` 里搜 `simMission` 命中 0。

## 六点五十、爬架详情页：删掉顶部「设备信息」四行（2026-11-23）

红框圈的是页签上方那块表格式信息：**设备数量 / 设备状态 / 设备名称 / 爬升高度**。
四行全删，连带它依赖的那条取数链。

### 删了什么

| 层 | 位置 | 内容 |
|---|---|---|
| 模板 | `views/sub/ClimbPage.vue` | `.climb-sum`（设备数量 / 设备状态）与 `.dev-info`（设备名称 + 台账字段 `v-for`）两块 |
| 骨架 | 同上 | `.climb-sum.skel-fade` + `.dev-info.skel-fade` 那段 `v-if="ledger.state === 'loading'"`；它与下面的 `v-else` 是同一对，删后把内容提上一层（少一层 `<template>`） |
| 脚本 | 同上 | `useDeviceLedgerStore` / `units` / `unit` / `fields` / `showSkel` / `Skel` / `useSlowLoading` 六个依赖；`onMounted` 与 `retry()` 里的 `ledger.load()` |
| 样式 | `styles/app.css` | `.climb-sum`、`.climb-sum span`、`.climb-sum b`、`.climb-sum b.is-time` 四条 |

### 特意没删的

- **`.dev-info` / `.dev-info-row` 样式保留**：`components/sheets/DeviceInfoSheet.vue`
  还在用（塔机/电梯的「基本信息 / 实时工况」），删了会连带坏掉那个弹层。
- **`deviceLedger` store 本身不动**：首页智控、DevicePage、DeviceInfoSheet 都在用。
  只是爬架详情页不再是它的消费者。
- **空态文案去掉半句**：原「…，当前只展示台账中的设备属性。」—— 台账属性已经不展示了，
  留着就是假话，改为只报错误原因。

### 影响

- 进爬架详情页少一次台账请求（原先 `ledger.load(token)`），只剩 CDN 传感器那一路；
  首屏不再有「等台账」的骨架阶段，页面结构变成 **页签 → 机位列表/空态**。
- 未登录时仍是原来的登录引导（`auth.isLoggedIn` 门控没动）。
- `tests/unit/device-page.spec.ts` 那条用例同步改写：从「断言展示 1 / 在线 / 爬升高度 / 21m」
  变成「断言 `.climb-sum` 与 `.dev-info` 都不存在」，防止这块悄悄回来。

## 六点五十一、报警预警历史页：监控预警 + 无人机预警合并成一条时间线（2026-11-23）

首页「报警预警 → 历史 >」打开的 `views/sub/AlarmHist.vue` 原先只查 `:8085` 的视频报警；
现场要求这一页和消息页的两个入口对齐：**同一份列表里既有监控预警，也有无人机预警**。

### 数据来源（两套后端，各走原有接口，没有新增任何请求类型）

| 一侧 | 接口 | 进 store 的位置 |
|---|---|---|
| 监控预警 | `GET :8085/api/video/alarms?page&page_size&sceneCode` | `stores/alarm.ts`（`liveAlarms`，一次 2×200 条 ≈ 一个月，`ensureDate` 按需回补到 8 页） |
| 无人机预警 | `POST iot.keehang.com:12666/audit_center/get_by_device_id?pidList=193640872670213`（`pageNum/pageSize`） | `stores/droneAlarm.ts`（`items`，首屏扫 100 条 ≈ 7 天，`loadMore` 往后翻） |

`AlarmHist.vue` 的 `onMounted` 现在会补一次 `alarm.syncFromVideo(token)`（仅在没有任何监控数据时）
和 `drone.load()`（store 自带 2 分钟保鲜期），所以从首页直接进来也有两类数据。

### 合并规则（`src/utils/alarmMerge.ts`）

- **时间线信封** `AlarmEntry { key, kind, at, alarm?, work? }`：只做排序与去重，
  不重写任何一方的字段映射 —— 渲染仍交给原来的行组件，两边各看各的字段
  （监控：报警名 + 点位 + 「视频监控」徽标；无人机：识别类别 + 任务名 + 「无人机」徽标 + 状态徽标）。
- **去重**：按 `key`（监控 = 报警 id `va-*`，无人机 = `wo-` + 工单 uuid）。两边 id 各自成命名空间，
  真正的重复来自同一数据源翻页重叠（服务端无稳定游标），与两侧 store 的去重口径一致。
- **排序**：`at` 倒序（两边都是 `YYYY-MM-DD HH:mm:ss`，可直接字符串比较），同刻按 key 兜底稳定排序。
- **按日切分**：今日 = `alarm.latest` + `drone.todayItems`；历史 = `alarm.dayRecords(histDate)` + `worksOn(drone.items, histDate)`。
- **计数与趋势同口径**：卡片「今日预警数」= 合并后今日行数；近 7 日折线 = 两份 `trend/weekTrend`
  按 `M/D` 标签相加（`mergeTrend`）—— 不会出现「写 35 条、列表 41 行」。

### 组件

| 文件 | 变化 |
|---|---|
| `components/ui/WorkOrderItem.vue` | **新增**：从 `WorkOrderList.vue` 抽出的无人机行（缩略图 / 灰底占位 + `ThumbRing` 进度环 / 红点 / 状态徽标 / 键盘可达），DOM 与类名逐字节不变 |
| `components/ui/AlarmRow.vue` | **新增**：按 `kind` 分派到 `InspectItem`（`use-title`）或 `WorkOrderItem` |
| `views/sub/WorkOrderList.vue` | 两处行模板换成 `<WorkOrderItem>`（`dot` = `isUnread`，历史不传）；`armThumb` / `statusClass` / `onKey` 一并移走 |
| `views/sub/AlarmHist.vue` | 列表改吃合并结果；`syncing` / `histSyncing` 增加「无人机首屏是否已扫完」这一路；新增两行注脚（某一路失败 → 「列表可能不完整」；无人机只加载到某日 → 「继续加载」） |
| `stores/droneAlarm.ts` | 新增 `earliestDay` 与 `ensureDay(d)`（选到更早的日期时最多再翻 3×20 条，不抛错） |
| `stores/subpage.ts` | `openWorkOrderDetail(id, from = { kind: 'work-orders' })` —— 从历史页点进去要显式传 `{ kind: 'alarm-hist' }`，否则返回会跳到从未打开过的页面 |
| `styles/app.css` | `.alarm-hist-page .insp-note` / `.insp-note-btn`（两行注脚，全是 `:root` 令牌） |

### 特意没动的

- 页签（今日预警 / 历史预警）、日期芯片、月历、`#subBody` 滚动位置记忆（`SubPage.scrollMemo` 的
  `alarm-hist` key）、`openAlarmHist(tab)` 全部原样。
- 消息页的两张分类卡与底部角标口径不变（仍是「监控今日未读 + 无人机今日待处理」）。
- 首页智巡面板的「今日预警数」（35）**仍是监控一路**：它是智巡面板的报警块，本次只改历史页；
  若要与历史页对齐（把无人机今日条数加进去）需另开一次口径确认。
- 无人机预警列表页（`work-orders`）版式与交互不变 —— 只是行被抽成了组件。

### 已知边界

- 无人机历史受接口能力限制（无时间筛选、只能从新往旧翻页）：首屏约覆盖 7 天，
  选更早的日期时 `ensureDay` 自动补几页，仍不够就显示「无人机预警仅加载到 X 日」+ 继续加载，
  不假装那天没有预警。
- 合并是「当天两类各自完整」的前提下的完整；某一路接口失败时列表只含另一路，页面会写明「可能不完整」。

## 六点五十二、首页「报警预警」块纳入无人机预警（2026-11-23）

现场要求：首页报警预警卡片的两处（**今日预警数 + 近 7 日趋势**、**下方预警轮播**）
都要把无人机预警算进来，展示样式与其他统计规则不变。

### 数据来源（与历史页完全同一份）

| 一侧 | 接口 | store |
|---|---|---|
| 监控预警 | `GET :8085/api/video/alarms?page&page_size` | `stores/alarm.ts` |
| 无人机预警 | `POST keehang /audit_center/get_by_device_id?pidList=…` | `stores/droneAlarm.ts` |

合并逻辑仍只用 `utils/alarmMerge.ts`（`mergeAlarmEntries` / `mergeTrend`），
没有新增任何请求类型：首页只是**多读了一份已经在内存里的数据**。

### 三处口径

| 位置 | 改之前 | 现在 |
|---|---|---|
| 今日预警数 | `alarm.latest.length`（监控） | `mergeAlarmEntries(alarm.latest, drone.todayItems).length` |
| 近 7 日趋势 | `alarm.trend` | `mergeTrend(alarm.trend, drone.weekTrend)`（按 `M/D` 相加） |
| 轮播列表 | `alarm.feed` | 今日两类合并；今日都为空才退到两侧各 6 条（`FEED_FALLBACK_N`，已导出） |

轮播行由 `views/home/parts/AlarmFeed.vue` 内的 `FeedCard` 收敛：监控取
`title / desc / alarmSrcOf(src).tag / rel`，无人机取 `title / jobName||projectName / '无人机' / relOf`。
DOM 类名、每页 3 条、双向循环、圆点跳页、跟手滑动全部未改；无人机行用同一颗
`.alarm-tile` 占位（首页被覆盖成 `--bg-3`，视觉上仍是「图还没到」）+ `ThumbRing`
（进度取 `drone.thumbBusyOf/PctOf`，监控侧不传 props，仍回落报警 store）。

### 交互

- 点无人机行 → `openWorkOrderDetail(id, null)`（`from` 现在允许 `null`，语义同
  `openAlarmDetail(id, false)`：返回落回首页）；id 失效退到无人机预警列表。
- 点监控行不变（`openAlarmDetail(id, false)`）。
- 未登录不请求无人机（`auth.token` 存在时才 `drone.load()`，store 自带 2 分钟保鲜）。

### 统计与空态

- 「有没有结论」按两路分别判：`alarmReady`（`hasLive || ok || error`）与
  `droneReady`（`scanned || error`），任一路还在首屏时铺骨架 —— 否则会先写一个
  偏小的数字再跳。
- 两路都为空才算「今日暂无报警」；一路失败时另一路照常展示，块底加一行
  `.data-note`「…统计可能不完整」；两路都失败给失败原因 + 重试。
- 仍是**未合并**的地方：巡检列表（`InspectList`）的「今日预警数」只算监控；
  消息页两张分类卡本就分两类，角标口径未动。

## 六点五十三、抓拍详情照片清晰度：新增 1280 详情预览档（2026-11-23）

现场口径：**列表 / 图标的清晰度暂不处理，点进详情后的照片要更清楚**，
但仍不接受「为了预览去拉原图」。

### 现状与问题

`utils/shotArchive.ts` 只生成一档缩略图（长边 480 的 WebP，质量 0.72，约 20KB），
列表与详情首屏共用它。480 铺满手机（≈1170 物理像素）明显发虚，而原图
200~340KB 又违背「预览别拉原图」。

### 改法：多一档「详情预览」，按需生成

| 档 | 长边 | 质量 | 何时生成 | 体积 | 用在哪 |
|---|---|---|---|---|---|
| `thumb`（不变） | 480 | 0.72 | 取回首图时 | ~20KB | 三列网格 |
| `preview`（新增） | 1280 | 0.80 | **第一次打开这张详情** | ~90~130KB | 详情首屏 |
| `full`（不变） | 原尺寸 | — | 取回首图时 | 200~340KB | 「查看原图」 |

- 生成入口：`ensureShotPreview(rec)`（`utils/shotArchive.ts`）。原图本来就在本机
  缓存里，所以**不产生任何网络请求**，只是 canvas 缩一次；
- 结果写回 IndexedDB（`ShotRecord.preview`，objectStore schemaless，**不需要升版本**），
  同一张第二次打开直接用；
- 失败（无 canvas / 编码失败 / 结果不比 thumb 大）返回 `null`，调用方继续用 `thumb`；
- `saveShot` 遇到「字节数相同」的旧记录时**保留已有 preview**，不重复生成。

### 接线

- `stores/cam.ts`：`CamShot.preview`（objectURL）+ `loadShotPreview()`，在 `openShot`
  里触发（`previewBusy` 去重）；`toCamShot` 会把缓存里已有的 preview 一并挂上；
  `releaseShotUrls` / `revokeShotUrl` 统一回收，与前两档一致；
- `components/overlays/CamPlayer.vue`：`shotSrc = shotShowFull ? url : (preview || thumb)` ——
  预览先生成时先显示 thumb，生成完同一条记录内换 URL，不重开弹层；角标仍写「压缩预览」。

### 没动的

- 列表缩略图 480/0.72 与报警/工单图标 96/0.62 全部不动（现场明确「图标暂不处理」）；
- 智眸 / 航拍 / 巡检大图的预览用的是**服务端下发的 `thumbnail`**（370~520KB），
  前端无法在不拉原图的前提下再提清晰度，保持原样。

## 六点五十四、详情大图四档加载策略：后台预取「清晰预览」（2026-11-23）

现场口径：**列表不动、页面初次加载不发请求**；点开详情后允许在后台预取
「约 4~8MB、清晰度只比原图低一点点」的预览并显示进度，但**不得阻塞首屏**；
**高清原图必须由用户显式操作才加载**。

### 先说清楚一件事：中间这一档没有服务端资产

| 想知道 | 实测结论 |
|---|---|
| 能不能让服务端缩一版 | **不行**。直链是 OSS 预签名，追加 `x-oss-process=image/resize,...` → `SignatureDoesNotMatch 403`（11-16 / 11-20 两次复测） |
| `limitUrl` 是不是低清版 | 不是，字节数与 `url` 完全相同，只是换了 `moss.keehang.com:9443` 域名 |
| 平台给不给中间尺寸 | 不给。只有 `thumbnail`（370~520KB，最长边约 1600）与 `url`（原图 4~8MB） |

所以「中间这一档」只能是**下完原始字节后在前端缩**——这也正是「预取约 4~8MB」
这个体积的来源。与现场要求的差别只有一句：那 4~8MB 的请求地址与高清原图相同，
但它发生在**后台任务**里（带真实进度、可取消、不阻塞、省流量时跳过），
画面显示的是缩过的 3840 版本；用户点「原图」时**复用这次下载**，不再发第二遍。

### 四档：时机 / 数据 / 状态表现

| 档 | 什么时候加载 | 加载什么 | 体积 | 状态表现 |
|---|---|---|---|---|
| ① 列表缩略图 | 列表渲染（`loading="lazy"` / 网格分片），**与本次改动无关** | `thumbnail` | 370~520KB | 格子里的图 |
| ② 详情首屏 | 打开详情那一帧 | **同一张 `thumbnail`**（列表已缓存，零请求） | 0 字节新增 | 角标「压缩预览」 |
| ③ 后台预取（新） | 详情打开、首屏画完之后（`whenIdle`：`requestIdleCallback`，无则 320ms 定时器） | 原图直链字节 → canvas 缩到长边 **3840** / WebP **0.85** | 网络 4~8MB；显示的那版约 0.6~1.2MB | 角标「清晰预览 42%」+ 画布底边 3px 真实字节进度条；完成后角标「清晰预览」，**无声换源**（不重置缩放、不重开弹层） |
| ④ 按需高清原图 | 用户点「原图 / 查看原图」 | 复用③已下到的字节（缓存命中=瞬时）；没有才现下 | 0 字节 / 4~8MB | 按钮「原图 42%」→「已是原图」；角标变「原图」 |

### 落地

| 文件 | 变化 |
|---|---|
| `src/utils/photoPreview.ts` | **新增**。`prefetchDetailPreview(src,{signal,onProgress,soft})`：带进度下载 → 只读 JPEG 头拿尺寸（SOF 段）→ `createImageBitmap` **按目标尺寸解码**（避免 21MP 全量解码吃掉 84MB）→ canvas 编 WebP。3 条 LRU 缓存（`cachedPreview` / `clearPreviewCache`）；同一地址的并发调用共享一次下载（`jobs`）；`canPrefetch()` 挡 `saveData` / 2G·3G；`whenIdle()` 提供「首屏后」时点 |
| `src/components/sheets/PatrolSheet.vue` | 智眸/巡检照片详情：`shown` 增加「清晰预览」这一档；新增 `previewSoft/prefetchBusy/prefetchPct`、`schedulePrefetch/cancelPrefetch`；`viewTag` 四态角标；底边新增预取进度条；`onHd` 改走 `prefetchDetailPreview`（复用同一次下载）；`onBeforeUnmount` / 换图 / 探到 2:1 全景时取消 |
| `src/components/overlays/AirPlayer.vue` | 航拍照片弹层同上一套（`imgSoft/imgTag/scheduleImgPrefetch`）；`shownSrc` 增加该档；`onHd` 同样复用下载；`airPopOpen`/`airPopIdx` 变化与卸载时取消 |
| `src/styles/app.css` | **没改**：角标复用 `.patrol-view-tag`（`.photo-view` 本身就是 `position:relative`），进度复用 `.hd-progress.is-in-stage`，只多了 `data-state` 便于排查 |

### 特意没做 / 没动

- **项目全景**（`PANO_SHEET_ID`，球面视图）不预取：它的「看高清」是 13MB
  的 `pano.json` + 贴图集，后台自动拉会和当前视角的瓦片抢带宽；保持手动。
- **工单详情**（0.6~1.3MB 单张）与**报警详情**（1MB 抓拍）本来就是一进详情
  取那一张，体量够小，不套这套两段式。
- 列表、图标缩略图（`imageThumb` 96/0.62、`thumbCache` v2）**一行没改**。
- 预取失败**不弹提示、不重试**：画面继续用缩略图，用户点「原图」时还有一次机会。

### 已知风险

- ③ 的字节缓存是内存（3 条 ≈ 12~24MB），刷新页面即失效；不做 IndexedDB 落盘
  （现场照片不进本机磁盘，与 `thumbCache` 只存 96px 小图的口径一致）。
- 3840 的 canvas 峰值约 44MB，仍可能在中低端机上被系统回收标签页；只影响
  「预取那一下」，不影响列表与首屏。要更轻就把 `PREVIEW_LONG_EDGE` 调小（单常量）。

## 六点五十五、详情大图收敛成「打开即高清」（2026-11-23，取代六点五十四）

现场口径（两次追加后定稿）：智眸照片、智眸**项目全景**、航拍照片、航拍全景，
**四处统一**——点开详情就显示高清那一版，**不再有「查看原图 / 看高清」按钮**；
加载过程仍要有进度，加载完正常显示。

### 与上一版（六点五十四）的差别

六点五十四是「四档 + 后台预取 3840 预览 + 点按钮换原图」。现场看完真实效果后
要求直接给高清，于是把中间档与按钮一起去掉：

| | 六点五十四 | 现在 |
|---|---|---|
| 照片首屏 | 缩略图 | 缩略图（同上一版，零请求） |
| 中间档 | 后台预取 3840 WebP | **删除**（要缩就必须先下完原图，缩出来时原图也到了） |
| 高清 | 用户点「查看原图」 | **打开即自动拉**，带真实字节进度 |
| 按钮 | 画布右上「查看原图 / 看高清」 | **移除**；照片只留「全屏」，全景只留「复位 / 全屏」 |
| 全景 | 预览 3162×1581，点「看高清」拉 13MB | **打开即拉** 13MB 高清贴图，进度同上 |

### 落地

| 文件 | 变化 |
|---|---|
| `src/utils/photoOriginal.ts` | **新增**（取代 `photoPreview.ts`，后者已删）。`fetchDetailOriginal(src,{signal,onProgress})`：`fetch` 流式读字节报真实进度；同一地址共享一次在途下载（多订阅者广播进度）；abort 时**立刻从在途表摘掉**（底层不认 signal 时不会留一个永不落地的任务卡住下次打开）；最近 3 张原图字节留在内存（≈12~24MB），关掉再开不重下 |
| `src/components/sheets/PatrolSheet.vue` | 照片：`loadHd()` 在 setup 与换图时自动调用；`shown = 原图（objectURL / 直链兜底）→ 缩略图`；角标 `压缩预览 → 原图 42% → 原图`；工具条只剩「全屏」。项目全景：`enterPano()` 取完最新成果就 `loadPanoHd()`；角标 `全景 · 可环视 → 全景 · 高清 42% → 全景 · 高清`；工具条只剩「复位 / 全屏」 |
| `src/components/overlays/AirPlayer.vue` | 照片与全景同一套（`loadHd` / `loadPanoHd`，打开弹层或换张时触发）；顶栏 `photo-bar` 只剩「关闭 + 标题」，`.photo-bar-acts` 样式随之删除；全景数据晚到时由 `watch(air.airPano.full)` 补拉 |
| `src/styles/app.css` | 删 `.photo-bar-acts`（唯一使用点已去掉）。进度条与角标复用既有的 `.hd-progress.is-in-stage` / `.patrol-view-tag`，**没有新增样式** |

### 状态表现（两处一致，便于现场辨认）

- 加载中：画布/贴图底边一条 3px 进度带（宽度 = 已收字节 / `Content-Length`，
  不是估算动画），左上角角标写 `原图 42%` / `全景 · 高清 42%`；
- 加载完：角标变 `原图` / `全景 · 高清`，进度带自动收掉，画面**无声换源**
  （不重开弹层、不重置缩放）；
- 拉不到（CORS / 断网 / 被取消）：照片退回直链由浏览器自己加载（角标仍是
  `原图`，只是没有百分比）；全景退回直链贴图，失败时仍给「链接已过期 → 重新获取」；
- 关弹层 / 换照片 / 换站点：在途请求 abort，几 MB 流量不留在后台白烧。

### 没动的

- 监控抓拍详情（`components/overlays/CamPlayer.vue`）仍是「压缩预览 + 查看原图」：
  它的原图本来就在本机 IndexedDB 档案里，切换零等待，与这两处的远端大图不同源。
- 列表缩略图（智眸抓拍 480、报警/工单图标 96）与页面初次加载**一个请求都不发**。
- 项目全景的球面渲染、`panoTexScale` 缩贴图、天底采样策略全部原样。

## 六点五十六、照片详情加本机缓存：再看同一张不再重下（2026-11-24）

### 问题

六点五十五把详情改成了「打开即原图」，但取到的字节**只留在内存里 3 份**
（`utils/photoOriginal.ts`）。现场实测：刷一次页面、或者退出 PWA 再进，
同一张 4~8MB 的原图又要完整下一次；全景 13MB 更明显。OSS 是预签名直链，
签名每次不同，服务端也没回 `Cache-Control`，浏览器缓存基本指望不上。

### 现在的取数顺序

```
内存 LRU（3 份，秒开）
  → 本机落盘（IndexedDB，跨刷新/重开）   ← 本次新增
    → 网络（带真实字节进度），下完写回上面两层
```

只要**外层列表没刷新**，再打开同一张就是本地读盘，一个网络请求都不发。

### 键与失效规则

- **键 = URL 去掉签名参数**（`scheme://host/path`）：列表刷新会换一组签名，
  但对象路径不变 —— 所以缓存能跨刷新命中；服务端真换了图（路径变了）自然是
  另一个键，不会串图。
- **过期**：写入超过 7 天不再使用；
- **数据变更**：外层列表声明的 `size` / 拍摄时刻与缓存不一致 → 当场删掉重下；
- **列表刷新**：`stores/patrol.ts::syncDetailCache()` 与
  `stores/airHazard.ts::syncDetailScope()` 在列表定稿后对账 —— 这批里已经没有的
  照片整条删除；作用域分别是 `patrol` 与 `air|站点|日期`，互不影响；
- **登出 / 换账号**：`stores/auth.ts::clear()` 整库清空（现场照片不留给下一个人）。
- `blob:` 地址（监控抓拍档案生成的 objectURL）**不入缓存**：它本来就是本机字节。

### 容量

最多 8 条、总量 64MB、单条 24MB（装得下 13MB 全景贴图），超出按**最近命中时间**
LRU 淘汰；没有 IndexedDB（隐私模式 / 老 WebView / 单测）时退化成进程内 Map，
行为一致，刷新即丢。所有读写吞异常：缓存只是优化，任何失败都不能让详情打不开。

### 落地

| 文件 | 变化 |
|---|---|
| `src/utils/photoDetailCache.ts` | **新增**。`readDetail` / `writeDetail` / `patchDetailMeta` / `reconcileDetailScope` / `pruneDetail` / `clearDetailCache` / `detailKeyOf`；IndexedDB 双 store（`detail` 存字节、`meta` 存元信息，淘汰时不必把几十 MB 读出来） |
| `src/utils/photoOriginal.ts` | `fetchDetailOriginal` 增加 `scope` / `meta` / `onLocal`；取数顺序变成「内存 → 落盘 → 网络」；下载完成写回落盘；读盘期间被 abort 就不再发请求 |
| `src/components/sheets/PatrolSheet.vue` | 照片 `loadHd` 传 `scope: PATROL_DETAIL_SCOPE` 与 `{id,time,size}`；命中缓存且带宽高时直接 `setDims`，省掉缩略图解码；`probeDims` 探到的宽高回写缓存；项目全景 `loadPanoHd` 改走同一函数（原先是裸 `fetchBlobWithProgress`） |
| `src/components/overlays/AirPlayer.vue` | 照片与全景都传 `scope: air.airScope`；全景同样改走 `fetchDetailOriginal` |
| `src/stores/airHazard.ts` | `AirShot` 增 `size` / `at`；新增 `airScope`（`air|站点|日期`）与 `syncDetailScope()`，在列表定稿 / 空态后对账 |
| `src/stores/patrol.ts` | 新增 `PATROL_DETAIL_SCOPE` 与 `syncDetailCache()`，`load()` 成功后对账六格照片 + 项目全景 |
| `src/stores/auth.ts` | 清会话时 `clearOriginalCache()` + `clearDetailCache()` |

### 没动的

- 监控抓拍详情（`CamPlayer.vue`）：原图本来就在本机 IndexedDB 档案里，零网络。
- 列表缩略图与页面初次加载：仍然一个请求都不发（缓存只在详情打开时读写）。
- 进度条 / 角标 / 缩放 / 全屏 / 「打开即原图」的观感：一条没改。

## 六点五十七、智眸子页懒加载：切回来只取当前这一格（2026-11-24）

### 问题

首页三个标签（智巡 / 智眸 / 智控）切换时，`HomeSheet` 的 `.home-panels` 带
`:key="home.homeMod"`，面板是**真的卸载再挂载**。于是带出两个毛病：

1. 每次切回智眸都跑一遍 `patrol.refresh()` → `load(true)`：照片墙 + 全景 +
   全景航拍 + 材料堆场 + 设备设施 + 安全巡查**六条链一起打**。现场 15 条航线、
   媒体接口还限流，一次刷新要十几秒；一分钟内重进才被 `REFRESH_GAP` 挡住。
2. 选中的子页是组件里的 `ref('')`，组件一卸载就没了 —— 上次停在「全景航拍」，
   切走再回来落回默认格。

### 现在的两条路径

```
面板挂载（从智巡/智控切回来）→ patrol.enterPanel()
    ├─ 有上次选中的子页 → 只取这一格（刷新它）
    └─ 本会话还没选过   → 先看手里已有数据；没有才按 3×2 顺序逐格探，
                          探到第一个有内容的就停（只发生在第一次进入）

面板内部点分类按钮 → watch(activeCat) → patrol.loadCat(id)
    └─ 只取新点中的这一格
```

- **选中状态放在 store**（`pickedCat`）：面板卸载不丢；登出 `reset()` 才清。
- **一次只取一格**：`loadCat(id)` 按 id 派发到六条专用链之一，
  别的格一个请求都不发。首次探测是唯一会碰到多格的路径，且探到即停。
- 两道闸：同一格已在取（连点）不叠加；15 秒内刚成功过 / 60 秒内刚失败过不重发。
  空态上的「重试」传 `force = true` 绕过它们。
- 只有一格在取时，`beginRecordBatch` 那套跨链共享自然用不上；每条链内部
  （`runInRecordBatch`）仍然共享自己那几条同窗口查询。

### 详情缓存跟着改

- 缓存元信息多了 `group`（这张属于哪一格）。**必须按格对账**：一次刷新只知道自己
  这一格有哪些照片，整作用域对账会把「还没打开过的格子」的缓存一起删掉。
- `reconcileDetailScope(scope, items, group?)`：传 group 只对账这一格；航拍那套
  （`air|站点|日期`）一次取齐，不传，行为不变。
- `IndexedDB` 版本升到 v2（加了 `group` 字段）。缓存而已，升级时整库重建，不做迁移。

### 落地

| 文件 | 变化 |
|---|---|
| `src/stores/patrol.ts` | 新增 `pickedCat` / `entering` / `catAt` / `catFailAt`；新增 `catStateOf` / `catHasData` / `catOfPhoto` / `pickCat` / `loadCat` / `enterPanel`；`syncDetailCat` 按格对账；**删掉 `refresh()`**（`load()` 保留给整页刷新与单测） |
| `src/views/home/PatrolPanel.vue` | `picked` 改成 store 的读写代理；`onMounted` → `enterPanel()`；新增 `watch(activeCat)` → `loadCat()`；分类条恒定显示（懒加载下它是唯一入口）；空态按「这一格自己的状态」写「暂时取不到 / 还没有照片」+ 一个 `retryCurrent()`；六条重试函数收成一个 |
| `src/utils/photoDetailCache.ts` | `DetailMeta.group`；`DB_VER` 2；`reconcileDetailScope` 加第三个参数 `group` |
| `src/components/sheets/PatrolSheet.vue` | 落盘时写 `group`（全景 `pano`，照片按 `patrol.catOfPhoto(id)`） |

### 观感上的变化

- 切回智眸不再「白等 + 六条链一起转」：只刷新当前那一格，别的格保持上次的样子。
- 分类条在首屏（骨架期间）就出现，计数随「点开过哪一格」逐个补上 —— 没点过的
  格子没有数字，不是 0 张。
- 没选过子页时首次进入会按顺序探（通常第一格或第二格就停），探测期间铺首屏骨架，
  不会先闪一句「这个分类下还没有照片」。

## 六点五十八、「今日任务 15 / 清单 10」：清单改取当天全量记录（2026-11-24）

### 现象

「任务管理」三格写「今日任务 15」，点开「查看今日任务」只有 10 行 ——
差 5 条，看起来像丢数据。

### 根因（2026-11-24 09:55 抓的原始响应，非推测）

`GET /dashboard/task/list/record?pid=193640872670213` 同一次响应里：

| 字段 | 条数 | 内容 |
|---|---|---|
| `taskCount` | **15** | 三格那个数；`planCount 11` + 完成 2 + 失败 1 + 执行中 1 |
| `completedTaskList` | 3 | 08:00 正射 / 08:20 全局定点 / 09:45 安全巡检（`result:3` 失败） |
| `unfinishedTaskList` | **7** | 09:00 三维（`status:1` 执行中）+ 10:50 ~ 14:15 六条未执行 |
| `taskStatusList` | 不返回 | 文档里有这个字段，实际响应没有 |

3 + 7 = 10。**当天最后 5 条排班（15:00 安全巡检 / 15:30 全局定点拍照 / 16:15 环绕视频 /
17:00 土方1 / 17:45 安全巡检）服务端不在 `unfinishedTaskList` 里回** ——
`planCount` 是 11，而它只给了 6 条未执行。清单当时是「执行记录 + 未完成排班」拼的，
拼到顶也就 10 条，与 `taskCount` 永远差这 5 条。

### 修法

清单主源换成**当天全量端点**：

```
GET /dashboard/task/list/execRecord/today
→ data: [{ executeInfo: {id, uuid, taskId, taskName, start, end, scheduled, suspended, status, result, pid}, taskInfo }]
```

- 一次回当天全部记录（实测 20 行 = 向阳村 15 + 光谷元著 5），按 `executeInfo.pid`
  过滤后 **正好 15 条**，与 `taskCount` 逐条一致；
- `pidList` 查询参数服务端**不认**（传了仍回别的项目），只能本地过滤；
- 行结构是 `{executeInfo, taskInfo}`，字段全在 `executeInfo` 上；
- 主源挂了（老网关没这个端点 / 404 / 超时）退回原来的两段式：执行记录
  （开放接口）+ `unfinishedTaskList`，少列几条也强过整页报错。

`taskCount` 仍取统计接口，两个数字现在同源同量。

### 落地

| 文件 | 变化 |
|---|---|
| `src/api/drone.ts` | 新增 `fetchTodayTaskList(pid)`（解析 `executeInfo`、按 pid 过滤）；`DroneTaskRecord` 增 `suspended`（`toTaskRecords` / `toOpenTaskRecords` 都读它）；`fetchTodayRecords` 标注为兜底 |
| `src/stores/uav.ts` | 新增 `loadTodayList()`（全量端点 → 兜底）；`load` / `refreshSlow` / `loadMission` 三处改用它；`stateText/stateClass` 增「已暂停」；`todayPending` 降级为补漏（按 `taskId + start` 去重） |
| `src/components/sheets/UavTodaySheet.vue` | 副标题写「共 N 条」；条数与 `taskTotal` 仍不一致时补一行「统计 N 条，本清单 M 条（其余排班未回传明细）」 |
| `src/components/overlays/SheetHost.vue` | `uav-today` 的 subtitle = `共 N 条` |
| `tests/unit/drone.spec.ts` | 新增 2 条：全量端点条数与三格一致 + 别的项目不混入；端点挂了走兜底 |

### 核对（用真实接口跑的，同一天同一时刻）

```
三格 taskCount      : 15  {finished:2, failed:1, running:1, plan:11, suspended:0}
旧口径(记录+未完成) : 10  (3 + 7)
新口径(全量端点)    : 15  {已完成:2, 执行中:1, 已失败:1, 未执行:11}
一致? true
```

## 六点五十九、分页排查：截断的不是数据源，是翻页算法（2026-11-24）

用户要求把「分页导致任务数对不齐」从根上堵住，逐项查了参数、终止条件、累计方式、
游标推进与去重。实测把三个疑点全部问清：

### 实测结果（2026-11-24 10:2x）

| 端点 | 行为 |
|---|---|
| `/dashboard/task/list/record` | `completedTaskList` / `unfinishedTaskList` 默认**只回 7 条**；带 `pageNum/pageSize` 回全（12 条）。20 / 200 / 1000 三档条数相同，`pageNum=2` 不做偏移 → 不是真分页，只是「带参数才解除默认截断」 |
| `/dashboard/task/list/execRecord/today` | **不分页**：`pageSize=2`、`pageNum=2` 仍回全部 20 条 |
| `/api/open/v1/task-record/page` | 真分页：`total` 恒为区间总数（429）；**越界页重复返回最后一页**（page=12/13/99 都是同一批 29 条）；`size=0/-5` 回落 20 条，`size>100` 压到 100，`page=0/-1` 等价 1 |
| `/dashboard/device/list` | `page/size` **完全不生效**（`size=2` 仍回 5 条），裸数组、无 total → 不需要翻页 |

### 翻页算法修的四处

1. **终止条件**：`p * pageSize >= total` → `(p - 1) * pageSize + res.rows.length >= total`。
   前者在 `page > 1` 时算的是「已翻页数 × 页长」，与 `total` 比较会提前退出；
   后者按「已覆盖到的 offset」算，与真实进度一致。
2. **总数累计**：`total = res.total` → `total = Math.max(total, res.total)`。
   翻页期间有新增记录时 `total` 会变大，取最后一次会把先前进度作废；取最大值更接近真实总量。
3. **游标推进（空页 / 短页）**：原实现 `if (!res.rows.length) break`，一个空页就收手。
   现在空页**先重试同一页**（限流/瞬时空响应），仍空才往后翻；短页但 `total` 还有时
   也重试同一页 —— 直接 `p += 1` 会让 offset 前移、整段跳过缺口。
4. **去重**：原来 `rows.push(...res.rows)` 不去重，越界重复页会重复计数。
   现在按 `recordKey` 去重，键顺序 `rid`（原始 `taskRecordId` 字符串）→ `uuid` → `id+taskId+start`。
   **不能用 `id`**：19 位雪花号转 `number` 丢精度（`5968386048883676116` 与 `...117` 变成同一个数），
   拿它当键会把不同记录合并成一条（少条）。为此 `DroneTaskRecord` 新增 `rid`。

另外把 `OPEN_MAX_PAGES` 从 30（3000 条）抬到 500（5 万条），触顶时返回
`truncated: true` 并 `console.warn`，不再静默截断；`fetchTodayRecords` 也会对
单个项目未取全的情况留痕。

### 落地

| 文件 | 变化 |
|---|---|
| `src/api/drone.ts` | `DroneTaskRecord.rid`；`recordKey()`；`DroneTaskPage.truncated`；`fetchTaskRecords` 翻页重写（终止/累计/空页重试/短页重试/去重/触顶告警）；`fetchTaskStat` 带 `pageNum=1&pageSize=1000`；`fetchTodayRecords` 改用 `recordKey` + 未取全告警 |
| `tests/unit/drone.spec.ts` | 新增 `describe('执行记录翻页…')` 8 条：末页不满、末页整除、越界重复页、翻页中新增、空页重试、连续空页收手、雪花号精度不误合并、size/page 边界 |

### 验证

```
npx vitest run tests/unit/drone.spec.ts   → 87 passed
npx vue-tsc --noEmit                      → 通过
npm run build                             → 通过（precache 897.46 KiB）

真实接口复刻翻页（30 天窗口，total=429）：
  size=100 → rows 429 / total 429 / 5 次请求 / 重复 0 / truncated false
  size=50  → rows 429 / total 429 / 9 次请求 / 重复 0 / truncated false
  size=7   → rows 429 / total 429 / 62 次请求 / 重复 0 / truncated false
```

今日任务口径未变：三格 = `taskCount + suspendedCount` = 4 + 11 = 15，清单全量 15 条，
清单里暂停项显示「未执行」。

## 六点六十、横屏引导语收窄：只在 VR 360 环视的全景全屏出现（2026-11-24）

现场截图反馈：「把手机横过来看 / 转不动就关掉系统的「竖屏锁定」」这条卡片出现得
太泛 —— 首页全屏地图、监控播放器全屏、抓拍大图全屏、航拍全景全屏、智眸平面照片
全屏都会弹。要求**只保留**在智眸「VR 360 环视 → 项目全景 → 全屏」这一处。

### 判断依据

这句引导是给**球面全景**写的：竖屏里球面只剩中间一条窄缝，拖不动也看不全，
只能请用户转屏；其它全屏画面不转过去照样能看清，弹卡片纯属打断视线。

### 改动

| 文件 | 变化 |
|---|---|
| `src/stores/shell.ts` | `openMapLand()` 只 `enterNativeLandscape()`，删 `openLandscapeHint` 调用与 import（首页全屏地图不再提示） |
| `src/stores/cam.ts` | `setCamLand(true)` 同上（监控播放器全屏不再提示） |
| `src/components/overlays/CamPlayer.vue` | `useLandscape({ page: true, hint: true })` → `{ page: true }`（抓拍大图不再提示） |
| `src/components/overlays/AirPlayer.vue` | 同上（航拍全景全屏不再提示） |
| `src/components/sheets/PatrolSheet.vue` | `panoLand` **保留** `hint: true`；`photoLand`（平面照片）去掉 |
| `src/utils/landscape.ts` | `hint` 选项注释改为「只有 VR 360 环视项目全景用它」 |
| `src/utils/landscapeHint.ts` / `LandscapeHint.vue` / `App.vue` / `app.css` / `orientation.ts` | 注释与适用范围说明同步；样式与状态**保留**（那唯一一处仍要用） |

保留的链路（与原行为一字不差）：点「全屏」→ `enterNativeLandscape()` 申请
`documentElement` 全屏 + `orientation.lock('landscape')` → 等 320ms → 视口仍
宽 < 高 且是触摸设备 → `openLandscapeHint()` → 卡片 4.2s 淡出 / 点击关闭 /
用户自己转过来（`resize`）立刻收掉。

### 验证

```
npx vue-tsc --noEmit   → 通过
npm run build          → 通过（precache 897.38 KiB）
```

手动确认点（真机竖屏 + 系统开旋转锁定）：①智眸 VR 360 环视 → 项目全景 → 全屏
→ 应出现卡片；②首页地图全屏 / 监控全屏 / 抓拍大图全屏 / 航拍全景全屏 / 平面照片
全屏 → 都不应出现。

## 六点六十一、iOS 上「全屏 → 横屏 → 竖屏 → 退不出全屏」：状态机被旋转打散（2026-11-24）

现象（iOS 27 iPhone，智眸 → VR 360 环视 → 项目全景 → 全屏）：进全屏正常，把手机
横过来正常，再转回竖屏之后**点「退出」退不出来**，画面留在系统全屏里。

### 根因

`land`（App 认为「在全屏」）与系统是否真的在全屏是两套状态，原先**三个关键决定
全都押在 `document.fullscreenElement` / `webkitFullscreenElement` 上**，而 iOS 上
这两个属性在**旋转的瞬间会先报 null 再恢复**（进全屏那一刻是读得到的，所以旋转
之前一切正常 —— 与现场现象完全吻合）。三个决定是：

| # | 位置 | 做法 | 旋转时发生的后果 |
|---|---|---|---|
| R1 | `landscape.ts::onFullscreenChange` | 一读到「没有全屏元素」就 `land = false` | 旋转连发事件，一次误读就把铺满的画面收掉：「退出」按钮变回「全屏」，`.is-land` 摘掉、Teleport 复位 |
| R2 | `landscape.ts::exit` | 先 `land = false` 再 `exitNativeLandscape()` | 出口比系统状态先消失，同 R1；而且 `exitFullscreen()` 一旦被转场吞掉就再没机会补 |
| R3 | `orientation.ts::exitNativeLandscape` | 只发一次 `exitFullscreen`；退失败后的 300ms 复查也以同一属性为前提 | 属性读 null → 复查不执行；第一次调用被吞 → 永远停在全屏 |

R1 是触发点：`land` 被误置 false 之后，**再没有任何代码会去发 `exitFullscreen`**
（系统全屏没变，`fullscreenchange` 不会再发，旋转回竖屏也不产生新事件），于是
「系统在全屏、App 认为不在全屏」这个错位一直留着，用户看到的就是「退不出全屏」。
另有一个次要因素：全屏里唯一出口是右上角那颗 26px 胶囊（WebGL 画布铺满
`.pano-host`，`@click.self` 的「点黑边」在全景全屏下根本不会触发），26px 本身低于
44pt 触控下限。

### 修法（三条规则 + 一处几何加固）

| 文件 | 改动 |
|---|---|
| `utils/orientation.ts` | 新增 `isSystemFullscreen()`，并把「读到 false ≠ 已退出」写进注释；新增 `fireExitOnce()`（只认退出事件 / 被拒 / 超时复查，**不认 promise resolve**）；`exitNativeLandscape()` 改为**退三次**（0 / 260 / 700ms，只在「仍读得到全屏」时才继续），退出前解锁、退出后再解锁一次，返回 `boolean` 供调用方判断 |
| `utils/landscape.ts` | `scheduleDropCheck()`：消失事件**不立刻**收 UI，转屏窗口内等 900ms、平常 280ms，期间只要又读到全屏就撤销；`exit()` 改为**先退系统全屏、确认后再收 UI**，退不掉就保留 `land` 与「退出」按钮并 900ms 后重试；新增 `onRotateEvent()` + `reconcile()`：转屏后对账，①系统还在全屏而 UI 已收 → 主动补一次退出，②UI 还在全屏而系统层没了 → 走二次确认；`enter()` 补一条「320ms 等待期间用户已点退出」的收尾 |
| `styles/app.css` | 全屏工具条的定位改成 `calc(max(env(safe-area-inset-*), 12px) + 10px)`（旋转后 `env()` 可能仍给横屏那档 0）；新增 `.pano-tool::after` 把命中区上下各撑 9px → **44pt**，视觉不变 |
| `components/sheets/PatrolSheet.vue` | 注释纠正：全景全屏下「点黑边退出」不可达，唯一出口是右上那颗按钮 |

要点：`land` 只能由「用户意图」和「二次确认过的系统状态」改变，**不能由一次属性
读取改变**；退出必须先作用在系统上，UI 跟着系统走，不能抢在前面。

### 验证要点（真机竖屏 + 系统开/关旋转锁定各跑一遍）

1. **进入全屏**：点「全屏」→ 画面铺满；能进系统全屏的机型应转成横屏，转不了的
   机型弹「把手机横过来看」，4.2s 自动消失，不影响拖动环视。
2. **横竖屏切换**：横过来 → 画面跟着铺满、不黑屏、不回到弹层；再竖回去 →
   **按钮仍是「退出」**，画面仍是全屏态（这一条就是这次修的根因，回归必测）。
3. **退出全屏**：竖屏态点「退出」→ 一帧内回到弹层原位、页面不偏移、方向锁解除
   （手机能自由转）；若系统全屏倔着不退，按钮**仍在**且仍写「退出」，再点一次即可。
4. **系统方式退出**：横屏态用系统手势 / 安卓返回 / Esc 退全屏 → 280ms 内 UI 收回，
   不出现「黑屏卡住」。
5. **旋转中退出**：横屏转竖屏的动画进行中就点「退出」→ 不出现「按钮消失但画面
   还在全屏」。
6. **关闭弹层**：任何方向下点「返回」关掉明细 → 系统全屏必定退出，不留全屏窗口。

### 验证

```
npx vue-tsc --noEmit   → 通过
npm run build          → 通过（precache 899.04 KiB）
```

## 六点六十二、实时监控：没任务就不连流（2026-11-24）

### 现象与理由

无人机页「实时监控」在没有执行中任务时，画面区仍是「画面未开播 / 无人机起飞推流后
会自动出画面，不用手动刷新 / 重试」—— 而那时**根本没有推流**，播放器却已经连上去、
18s 后判 `offair`、每 20s 再重连一次，一直循环到用户离开页面。白烧流量与电，
还给了一个按不出结果的「重试」。

### 门禁改了：从「有没有地址」改成「有没有执行中的起飞任务」

| 状态 | 行为 |
|---|---|
| **没有**执行中任务（`uav.running === null`） | 不挂 `LivePlayer`（卸载即 `seq+1`、清超时/重连定时器、`teardown()`），画面区写「当前无正在执行的任务，无视频画面」+「起飞任务开始后会自动连上画面」，**不给重试按钮** |
| **有**执行中任务 + 有地址 | 原逻辑一字未改：有地址就先连（ZLM 挂着等推流）、连不上 → `offair` → 每 20s 自动重连、`playing` 才挂 LIVE |
| 有执行中任务 + 平台没给地址 | 原逻辑：`实时画面未开播` + `平台没有这台无人机的直播流` |

判定用 `running`（只认本项目、`status === 1` 执行中），不是「今日有没有任务」：
已排班未起飞、已完成的架次都不推流，挂上去就是空转。任务起止由 30s 那轮
`refreshSlow` 感知，`watch([tab, missionOn])` 同时把 `liveState` 清回 `idle`，
LIVE 角标不会带着上一路的状态闪一下。

### 落地

| 文件 | 变化 |
|---|---|
| `src/views/sub/UavPage.vue` | 新增 `missionOn = computed(() => uav.running !== null)`；`LivePlayer` 与 LIVE 角标都加 `missionOn &&` 前置；`uav-stage.is-wait` 改为 `!missionOn \|\| !hasStream`；新增空态两块（无任务 / 有任务没地址）；新增 `idleHint` |
| `src/components/ui/LivePlayer.vue` | 顶部注释补一节：门禁在调用方（不挂即不重连），组件内不再加第二套「有没有任务」的判定 |
| `tests/unit/device-page.spec.ts` | 新增 2 条（无任务时即使有地址也不挂播放器、无重试按钮；任务结束后播放器卸载、角标摘掉）；原「完全没有直播流」那条补 `stubRecords`，改成「有任务但没地址」 |

### 验证

```
npx vue-tsc --noEmit                                → 通过
npx vitest run tests/unit/device-page.spec.ts -t 无人机页 → 21 passed / 3 failed
npm run build                                       → 通过（precache 899.28 KiB）
```

那 3 条 failed 是**既有失效用例**，与本次改动无关：它们钉的是 2026-11-23 已下线的
「飞行参数七格」（`.uav-fly`）与「机库页签」（`.dev-tabs button[1]`），选择器已不存在。

## 六点六十三、实时监控的两个边界：结束宽限 + 刷新失败不断流（2026-11-24）

六点六十二 的门禁（没任务不连流）上线后还剩两处会「切画面」，这次一并收掉。

### ① 任务结束：留 2 分钟宽限再卸载

服务端把架次标成「已完成」的那一刻，飞机往往还在推最后几秒（落地、云台回中、
回库）。按 `running` 一变 false 就卸载播放器，现场看到的就是「画面活生生断在
半空」，落地那一下正好没有。

新增 `src/utils/streamHold.ts::useStreamHold(running, now, holdMs = 120_000)`：

| 规则 | 说明 |
|---|---|
| 只在「跑过 → 结束」开窗 | 页面初开时 `running` 本来就是 false，那不是「刚结束」，不该白连两分钟 |
| 到期判据是共享时钟 `now` | 读 `utils/missionClock.ts` 的 5s 网格，不另开 `setTimeout`（那会多一套时间源，卸载后还可能残留） |
| 窗口内 | 播放器不卸载、`LIVE` 角标不摘、断流重连照旧；另加一句「任务已结束，画面保留 2 分钟 后自动关闭」 |
| 到点 | 自动卸载，回到「当前无正在执行的任务，无视频画面」 |

页面里 `streamOn = useStreamHold(missionOn, now).on`，模板一律读 `streamOn`；
`liveState` 的清零也跟着 `streamOn` 而不是 `missionOn` —— 否则窗口内明明在播、
`LIVE` 却被摘掉。

### ② 强制刷新失败：不再清空执行记录

`stores/uav.ts::load()` 失败分支原先是 `records.value = []`。而页面 mount 与点
「重试」都走这条**强制刷新**，一次网络抖动就会让 `running` 变 null ——「当前巡检」
卡片、进度条、实时画面（门禁是 `running`）一起下线，飞机却还在飞。

现在与 30s 那轮 `refreshSlow` 同口径：**失败只改状态与原因，手上有什么留什么**。
为避免「拿旧数据装实时」，`state === 'error'` 且仍有旧数据时，任务管理块底部补一句
「刷新失败，以上为上一次的数据」。真正清空只发生在 `reset()`（退出登录）。

### 落地

| 文件 | 变化 |
|---|---|
| `src/utils/streamHold.ts` | **新增**：`useStreamHold()`（`on` / `until` / `minutes`），默认 2 分钟 |
| `src/views/sub/UavPage.vue` | 用 `useStreamHold(missionOn, now)` 取代内联的 `holdUntil`；模板改读 `streamOn`；新增「任务已结束…」提示；任务管理块底部新增「刷新失败，以上为上一次的数据」 |
| `src/stores/uav.ts` | `load()` 失败不再 `records = []`，注释写清原因 |
| `src/components/ui/LivePlayer.vue` | 注释同步「任务刚结束还留 2 分钟宽限」 |
| `tests/unit/stream-hold.spec.ts` | **新增** 4 条：初开不宽限 / 结束后窗口内仍上屏、到点收 / 宽限里重新起飞立刻清窗 / 默认 2 分钟 |
| `tests/unit/device-page.spec.ts` | 「任务结束」那条改断言：窗口内播放器与 LIVE 都还在、出现宽限提示 |
| `tests/unit/drone.spec.ts` | 新增 1 条：强制刷新失败保留记录、`running` 不为 null |

### 验证

```
npx vue-tsc --noEmit                                      → 通过
npx vitest run tests/unit/stream-hold.spec.ts             → 4 passed
npx vitest run tests/unit/drone.spec.ts -t 强制刷新失败     → 1 passed
npx vitest run tests/unit/device-page.spec.ts -t 无人机页   → 21 passed / 3 failed（既有失效用例：`.uav-fly` 七格与机库页签 2026-11-23 已下线）
npm run build                                             → 通过（precache 899.72 KiB）
```

## 六点六十四、无人机预警退出未读体系 + 详情返回一致 + 顶栏「一键已读」（2026-11-24）

现场三条反馈，一起收掉。

### ① 无人机预警详情「返回」与监控预警详情对齐

返回的**动作**本来就共用一套（`SubPage.onBack` 的 0.22s 滑出 + 垫底层 + 右滑手势），
不一致的是**返回后的状态**：

| 现象 | 原因 | 现在 |
|---|---|---|
| 从「历史预警」点进详情，返回后落在「今日预警」 | 页签是 `WorkOrderList` 的局部 `ref`，组件被整棵卸载就归位 | 页签进 store（`droneAlarm.listTab`），与监控的 `alarm.inspTab` 同一条规则 |
| 返回后滚动位置错位（贴着底部 / 跳到别处） | 滚动记忆只按视图 key 记，两个页签共用 `work-orders` 一个键 | `SubPage` 的记忆键改「视图 + 页签」，今日 / 历史各记各的 |
| 返回后列表重算骨架、历史被截回首屏 | `onMounted` 无条件 `drone.load()`，它整批替换 `items`（监控那边 `syncFromVideo` 是合并） | 只在 `state === 'idle'`（从没扫过）时拉；保鲜由入口负责（App 启动 / 消息 tab 切换） |

顺带：`SubPage` 里**进入动画仍用 `viewKey`**，只有滚动记忆用 `scrollKey` ——
切页签不该重播滑入动画。

### ② 无人机预警不再参与「未读 / 待处理」

无人机侧没有「已读」这个动作（`auditStatusType` 只有 `UNAUDITED` / `AUDITED`，
服务端也没有单条标记接口），早先按「今日 + 待处理」硬凑的未读数点开也清不掉：

| 位置 | 改之前 | 现在 |
|---|---|---|
| 底栏角标 `msg.unreadTotal` | 监控今日未读 + 无人机今日待处理 | **只算监控今日未读** |
| 消息页无人机卡 | 「今日待处理 N」（红色徽标） | 「今日 N 条」**中性数字**，且**不配标签**（现场要求去掉「今日预警」四个字） |
| 无人机列表 | 今日 + 待处理点红点 | 不点红点（状态仍照实显示在右侧徽标：待处理 / 已完成） |

`MsgCategory` 随之调整：`unread` → `count`，新增 `tone: 'alert' | 'plain'`
（`alert` 才是红色未读徽标），`hint` 允许空串。
`droneAlarm.todayPending` / `isUnread` 保留但**只作事实描述**，不要再接角标。

### ③ 顶栏「一键已读」（消息页红框位置）

`NavBar` 右侧那一格（原 `#navRight` 是空占位），出现条件三条同时满足：
在**消息 tab**、**已登录**、**今日确实有监控未读**。

点一下走 `stores/msg.ts::markAllRead()`：

1. 从 `alarm.latest` 取今日未读，按 id 回 store 取**真身**置 `handleStatus = 1`
   （`latest` 是派生出来的新对象，改它列表红点不会消失）；
2. 按 4 个一批并发 `PATCH /api/video/alarms/{id}/status {status:1}`；
3. 有失败才 `syncFromVideo(force)` 以服务端为准回正 —— 宁可让用户再点一次，
   也不留一个假的「已全部已读」；
4. **只动监控预警**：一个 keehang 请求都不发，无人机条数、今日预警数不受影响。

### 落地

| 文件 | 变化 |
|---|---|
| `src/stores/droneAlarm.ts` | 新增 `listTab`（`reset()` 归零）；文件头补「无人机不参与未读体系」「页签为什么在 store」；`todayPending` / `isUnread` 注释改为「只作事实描述」 |
| `src/stores/msg.ts` | `unreadTotal = monitorUnread`；`MsgCategory.unread → count` + `tone`；无人机卡 `hint: ''`、`count: todayCount`；新增 `markAllRead()` + `markingAll` |
| `src/views/MsgPage.vue` | 徽标按 `tone` 分红色 / 中性；`hint` 为空时不渲染标签 |
| `src/components/shell/NavBar.vue` | 右侧「一键已读」（`[data-read-all]`，处理中禁用并写「处理中…」）；`.has-action` 让第三列变 auto |
| `src/components/overlays/SubPage.vue` | `tabOf` / `scrollKeyOf` / `scrollKey`；两个滚动 watcher 改用 `scrollKey`，列表判定按基名 |
| `src/views/sub/WorkOrderList.vue` | 页签改读 store；去掉 `:dot`；`onMounted` 只在 `state==='idle'` 时拉 |
| `src/components/shell/TabBar.vue` / `src/App.vue` | 角标与预热注释同步新口径 |
| `src/styles/app.css` | `.navbar.has-action` / `.nav-action`（44px 命中区、`--fs-13`、禁用态不塌）；`.msg-badge.is-plain`（中性数字） |

### 验证

```
npx vue-tsc --noEmit                                        → 通过
npx vitest run tests/unit/work-order.spec.ts                → 29 passed
npx vitest run tests/unit/msg-categories.spec.ts            → 14 passed（新增 5 条）
npx vitest run tests/unit/subpage-scroll.spec.ts            → 5 passed（新增 1 条）
npx vitest run tests/unit/stage5.spec.ts work-order-thumb.spec.ts monitor-alarm.spec.ts → 40 passed
npx vitest run tests/unit/swipe-back.spec.ts history-back.spec.ts → 28 passed
npm run build                                               → 通过（precache 901.54 KiB）
```

## 六点六十五、一键已读的即时性与竞态 + 切 tab 重新取数（2026-11-24）

替代六点六十四第 ③ 节里的「顺序」三条（置读 → 批量 PATCH → 失败才回正），
那三条在**并发**下会打脸，这一节是它的修订版。

### ① 为什么会出现「数字不刷新 / 刷新后又跳回去」

| 现象 | 根因 |
|---|---|
| 点完「一键已读」数字是 0，一两秒后又变成 2 | 点下去的同一瞬间正有一趟同步在路上（切 tab / 面板挂载）。那趟请求是在置读**之前**发出的，服务端回的 `handleStatus` 还是 0，`merge()` 朴朴素素地把本地 1 换成 0 |
| 全部已读失败时，界面仍显示 0 | 失败只 `void syncFromVideo(force)` 补拉一次；若此时已有同步在途，`syncFromVideo` 直接 `return false`，等于什么也没补 |
| 从别的 tab 切回消息页，未读数不动 | `MsgPage` 的 watch 里带 `!alarm.hasLive` 条件：首屏已拿到数据 ⇒ 以后再也不刷 |
| 首页「今日预警数」长时间停在早上那个数 | 四个 tab 页常驻挂载（`.page.active` 切显隐），`onMounted` 一辈子只跑一次 |

### ② 已读：本地权威登记 + 失败立即回正

`stores/alarm.ts` 新增 `readMarks: Map<id, { at, patching }>`（本地已置读登记）：

* `markLocalRead(a)`：`handleStatus = 1` 并登记 `{ at: now, patching: true }`；
* `settleLocalRead(id, ok)`：成功解除 `patching`（登记留到下一次同步确认），
  失败**立刻回正为未读**并撤销登记 —— PATCH 失败就是服务端没记住，本地挂着
  「已读」，下次冷启动数字还会跳回来；
* `merge(incoming, fetchedAt)`：`fetchedAt` 是**请求发出时刻**（不是回来时刻）。
  - `patching === true` 或 `fetchedAt <= at` → 这批数据不可能知道我们刚置读，**本地为准**；
  - 否则 → **服务端为准**，登记随之撤销（不制造一个永远压制服务端的本地值）。

`stores/msg.ts`：

* `markAllRead()`：先对今日未读全部 `markLocalRead`（数字、角标、红点同一帧归零），
  再 4 路并发 PATCH，**逐条** `settleLocalRead`；有失败才 `void syncFromVideo(force)`
  补一趟对账 + `showToast('部分预警标记失败，已恢复为未读，请重试')`；
  返回「成功条数」，`markingAll` 在 `finally` 里复位。
* 连点：`markingAll` 挡住进行中的第二次；置读后今日未读已是 0，第二次进来
  `targets` 为空直接返回 0，一个请求都不发。
* `markRead(id)` 同样走这套（单条失败也回正为未读，红点回来）。

`alarm.syncFromVideo` 同时补了**在途复用**：`syncInflight` 存在时无论 `force`
都返回同一个 promise。首屏面板挂载 + 消息页 watch + 切 tab + 失败回正四个入口
在同一秒触发时只有一趟网络（两页 400 条），晚到的旧结果也不会覆盖新结果。

### ③ 切 tab 重新取数

新增 `src/utils/tabRefresh.ts::useTabRefresh(tab, reload, minGap = 600)`：
`watch(shell.activeTab)`，只在**真的换了 tab**时调 `reload`；同一页面 600ms 内
来回横跳只刷一次（真正的去重仍在各 store 里）。点当前 tab 不触发。

接线（各自决定取哪些接口，不在这里一刀切）：

| 页面 / 面板 | 切回时 |
|---|---|
| 首页 · 智巡 `SafetyPanel` | `overview.refresh()` + `alarm.refresh(token)`（force）+ `drone.load()` |
| 首页 · 智眸 `PatrolPanel` | `patrol.loadCat(pickedCat, true)`（强制，绕过 15s 节流）；没选过则 `enterPanel()` |
| 首页 · 智控 `EquipPanel` | `ledger.refresh` + `scaf.refresh` + `lift.refresh` + `uav.loadStat` + `uav.loadMission`（不重复注册 `startLive` 与 30s 定时器） |
| 消息 `MsgPage` | `alarm.refresh(token)`（force）+ `drone.load()`；原来那条 `!alarm.hasLive` 的 watch 删掉 |
| 我的 `MinePage` | `auth.refreshProfile()`（新函数：/me 重拉姓名与角色，在途复用、失败静默） |
| 工作台 `WorkPage` | **不动**：这一页没有任何接口数据（快捷入口与工具卡都是 `data/config` 常量），挂了也只是空转 |

### 落地

| 文件 | 变化 |
|---|---|
| `src/stores/alarm.ts` | `readMarks` / `withLocalRead` / `markLocalRead` / `settleLocalRead`；`merge(incoming, fetchedAt)`、`fetchPages(..., fetchedAt)`；`runSync` 拆出；`syncFromVideo` 在途复用（`syncInflight`）；`clearLive` 清登记 |
| `src/stores/msg.ts` | `markAllRead` 逐条 settle + 失败回正 + Toast；`markRead` 失败回正；导入 shell store |
| `src/stores/auth.ts` | 新增 `refreshProfile()`（`profileInflight` 去重，账号变了丢弃结果） |
| `src/utils/tabRefresh.ts` | 新增 |
| `src/views/MsgPage.vue` / `MinePage.vue` / `home/SafetyPanel.vue` / `home/PatrolPanel.vue` / `home/EquipPanel.vue` | 接 `useTabRefresh`；SafetyPanel 的取数收成 `fetchPanel()` 供挂载与切 tab 共用 |
| `src/views/WorkPage.vue` | 注释说明「无接口数据，故不挂刷新」 |

### 验证

```
npx vue-tsc --noEmit                                                     → 通过
npx vitest run tests/unit/msg-read-race.spec.ts                          → 6 passed（新增）
npx vitest run tests/unit/tab-refresh.spec.ts                            → 5 passed（新增）
npx vitest run tests/unit/msg-categories.spec.ts monitor-alarm.spec.ts alarm-thumb.spec.ts → 31 passed
npx vitest run tests/unit/stores.spec.ts stores-views.spec.ts auth.spec.ts → 103 passed
npm run build                                                            → 通过（precache 902.97 KiB）
```

已存在的红：`tests/unit/guards.spec.ts`「每个图片引用点都被登记」仍然失败
（`src/utils/themeColor.ts` 注释里写了 `public/img/site-map.webp`，清单里没有它）——
与本节无关，未改。

## 六点六十六、预警状态只读 + 今日预警数/待处理 + 切 tab 刷新（2026-11-24）

**本节取代六点六十五**（「一键已读的即时性与竞态」）：那套乐观置读、批量 PATCH、
失败回正的实现已整体下线，不再是现行口径。

### ① 删除「一键已读」及所有相关入口

| 位置 | 变化 |
|---|---|
| `components/shell/NavBar.vue` | 删除右侧 `[data-read-all]` 按钮、`canReadAll`、`onReadAll`；`navRight` 恢复为空配重 |
| `stores/msg.ts` | 删除 `markAllRead` / `markRead` / `markingAll` / `BATCH_READ_PARALLEL`，不再 import `setAlarmStatus`、`auth`、`shell` |
| `stores/alarm.ts` | 删除 `readMarks` / `withLocalRead` / `markLocalRead` / `settleLocalRead`；`merge(incoming)` 原样采用服务端 `handleStatus`，`fetchPages` 去掉 `fetchedAt` |
| `styles/app.css` | 删除 `.navbar.has-action` / `.nav-action` / `.msg-badge.is-plain` / `.insp-dot` |
| `tests/unit/msg-read-race.spec.ts` | 随功能删除 |

`syncInflight`（在途复用）保留：切 tab 与面板挂载仍可能同秒触发同步。

### ② 两个列表的状态展示一致，且只读

* 监控预警：`components/ui/InspectItem.vue` 右侧改为 `.wo-side`（相对时间 +
  状态徽标），`handleStatus === 1` → 「已完成」/ `.alarm-src-done`，其余 →
  「待处理」/ `.alarm-src-todo`；
* 无人机预警：`WorkOrderItem.vue` 本来就是这套，两页现在逐像素同构；
* **红点全部下线**（两页）：本 App 没有「标记已读 / 已处理」动作，红点点开也
  清不掉，等于一颗永久装饰；
* 进详情**不改状态**：`InspectList.onItemOpen()` 只调 `openAlarmDetail`，不再
  发 `PATCH /api/video/alarms/{id}/status`；`AlarmDetail` 把「已处理 / 未处理」
  改为「已完成 / 待处理」，只读展示；`WorkOrderDetail` 沿用 `drone.statusText`。

### ③ 今日预警数 + 今日待处理（两个数都在）

两个列表页统计卡结构相同：大数字 = **今日预警数**，下一行小字
（`.stat-sub`）=「待处理 N」。

| 页面 | 大数字 | 小字 |
|---|---|---|
| 监控 `InspectList` | `todayList.length` | `msg.monitorPending`（今日 `handleStatus !== 1`） |
| 无人机 `WorkOrderList` | `drone.todayCount` | `drone.todayPending`（今日 `UNAUDITED`） |

消息页两张卡都写「今日待处理」+ 红色徽标（`MsgCategory.hint` 统一，
`tone` 字段删除）；**底栏角标 = `msg.pendingTotal` = 两份待处理之和**。
数字不会因为「看过」下降，只随服务端把状态置为已完成而下降。

### ④ 切 tab 必定刷新

`utils/tabRefresh.ts::useTabRefresh` 不动，刷新内容改为 force 语义：

* 消息 tab：`alarm.refresh(token)` + `drone.load(true)`（原来是 `load()`，
  2 分钟保鲜会让「每次切回都刷新」落空）；
* 首页智巡：`fetchPanel()` → `overview.refresh` + `alarm.refresh` + `drone.load(true)`；
* 首页智眸：`loadCat(pickedCat, true)`；首页智控：台账/爬架/电梯/uav；
* 我的：`auth.refreshProfile()`；工作台：无接口数据，不挂。

### 落地文件

`src/components/shell/NavBar.vue`、`src/components/shell/TabBar.vue`、
`src/stores/msg.ts`、`src/stores/alarm.ts`、`src/stores/droneAlarm.ts`（注释）、
`src/components/ui/InspectItem.vue`、`src/components/ui/WorkOrderItem.vue`、
`src/views/MsgPage.vue`、`src/views/sub/InspectList.vue`、
`src/views/sub/WorkOrderList.vue`、`src/views/sub/AlarmDetail.vue`、
`src/views/home/SafetyPanel.vue`、`src/styles/app.css`、`src/utils/tabRefresh.ts`；
测试：`monitor-alarm` / `msg-categories` / `stage5` / `guards` 改写，
`msg-read-race.spec.ts` 删除。

### 验证

```
npx vue-tsc --noEmit    → 通过
npm run build           → 通过（precache 900.00 KiB）
monitor-alarm 7 / msg-categories 12 / stage5 20 / work-order 29 /
work-order-thumb 13 / tab-refresh 5                      → 86 passed
guards `-t 底部标签栏`                                   → 3 passed
```

## 六点六十七、左滑闪首页：前进方向的历史条目（2026-11-24）

### ① 现象与复述

「在任意页面左滑一下，页面先闪出首页，一两秒后又自己回到左滑前那一页。」

### ② 根因（两层，缺一不可）

**第一层：历史里有一条「快照是首页」的旧条目，跑到了光标前面。**

历史条目与覆盖层层数一一对应（六点六十二的模型）。页面内点返回、点底栏切 tab
时，层是被**应用自己**关掉的，`utils/historyBack.ts::sync()` 就用
`history.go(-1)` 把多余条目退掉。`go` 只能移光标，**条目本身还在**，于是它从
「光标后面」变成「光标前面」（前向栈）。而这条条目的快照拍在它被压的那一刻 ——
「那一层打开之前的屏幕」。登录页、子页、全屏层几乎都是从首页进的，所以那张
快照绝大多数时候就是**首页**。用户随后切到别的 tab，快照和当前页就不是同一张
图了。

**第二层：左滑在浏览器那边就是「前进」。**

iOS Safari 右边缘左滑、桌面触控板左滑、部分安卓浏览器的边缘手势，都走前向
遍历。浏览器把光标移到那条旧条目上，并按它自己的快照演一遍转场 —— 屏幕上就
是「闪一下首页」。紧接着 `onPop` 只按层数判断（`depth <= target` 走 `settle()`），
80ms 后 `sync()` 发现「条目比层数多」，再补一次 `history.go(-1)`：浏览器又演
一遍「退回来」。**「闪一下」+「过一会儿自动恢复」就是这么来的**，两段还是分开
的两次遍历，所以现场感觉「停了好几秒」。

同一条链路在**反向**（条目层数高于真实层数时按返回）会表现为「按了返回却退得
比预期更深」——`sync()` 的 `go` 是方向无关的，它只管「把条目退到与层数相等」。

### ③ 修法

1. **`onPop` 分方向，前进零导航。** `target > depth`（前进 / 落到旧条目）时：
   取消在途返回、清掉 `settle` 与 `sync` 定时器、**就地把条目改写成真实层数**
   （`replaceState` 不产生遍历、不画新帧），一个 `history.go` 都不发。再加一次
   80ms 后的复核（popstate 里写历史有被排队/丢弃的先例）。
   `target === depth` 仍走 `settle()`（对齐时空转）。
2. **裁剪从「逐条 go」改为「一次 go(-delta) 退到位」。** 以前每退一条都要等一轮
   `settle`，每轮都是一次独立遍历 + 一次转场，「闪一下、过一会儿又闪一下」的节奏
   就是它给的。现在一次退完（`MAX_TRIM_DELTA = 6`）。
3. **裁剪加验证。** `TRIM_VERIFY_MS = 400` 后复查 `currentLayer()`：Safari 会节流
   / 丢弃转场期间的 `go`，没生效就重试一次（`MAX_TRIM_TRIES = 2`），再不生效就
   就地 `setLayer(want)`，绝不留「条目比层数多」这个会让返回算不出层的状态。
4. **手势层把起手记录清干净**（`utils/swipeBack.ts`）：`giveUp()` 同时清
   `tracking / layer / pid`。只置 `tracking = false` 会留下悬空的「正在跟手」的
   层引用，下一次 pointerdown 先撞上 `abortGesture()` 的补偿路径 —— 左滑本来
   什么都没发生，却像被硬中断过一次手势。

### ④ 已知平台边界（不再尝试在网页层解决）

只要历史里还有前向条目，iOS Safari 在**手指还按着**的时候就会把那张旧快照画
出来（系统级手势预览，网页拿不到事件也拦不住）。现在保证的是：

* 松手之后**不跳、不弹回、不重播动画**；
* 那条旧条目被用掉一次就地归位（层数改写为真实值），不会反复咬人；
* 前进消费完所有旧条目后，再前进就是彻底的空操作。

真要「一次都看不到」，只能让历史里永远没有前向条目 —— 那就得放弃「页面自己
关层后返回不空转」，两者不可兼得（`go` 是唯一能移光标的手段，而它必然把条目
留在前向栈里）。这里选的是**返回正确**。

### 落地文件

`src/utils/historyBack.ts`（方向判定 + 裁剪/复核）、`src/utils/swipeBack.ts`
（`giveUp()`）；测试 `tests/unit/history-back.spec.ts`（+3）、
`tests/unit/swipe-back.spec.ts`（+1）。

### 验证

```
npx vue-tsc --noEmit                     → 通过
npm run build                            → 通过
history-back 13 / swipe-back 19 /
back-action 7 / interaction …            → 72 passed
```

新增用例：前进落到被裁掉的旧条目时不关层、不回弹、层数就地改写（并断言迟到的
对齐也不会发 `go`）；`dismiss()` 一次关两层只发一次 `go(-2)`；`go` 被吞掉时
重试一次后就地改写、不死循环；向左滑完全撒手且不污染下一次右滑的基准。

## 六点六十八、三个预警历史页的日期控件统一成「单颗日期芯片」（2026-11-24）

现场口径：预警历史页只留**一个日期控件**，不摆「今天 / 昨天」（今日预警本身
就是另一个页签）。三处（监控预警 · 报警预警 · 无人机预警）逐项一致。

### ① 组件

`components/ui/DayPickChips.vue` 新增 `single` 模式：只渲染带日历图标的那一颗
（`.cam-day.cam-day-pick.on`），文案固定是 `formatCamDate(selected)` →
「今天 / 昨天 / MM/DD」，**永远带选中态**（单颗按钮必须能看出选的是哪天）。
默认 `single=false`，监控抓拍 / 航拍照片那两处仍是「今天 / 昨天 / 选日期」三颗，
一个字符都没动。

样式完全复用既有的一份 `.cam-day` / `.cam-day-pick`：白底浅边 → 选中蓝底白字、
8px 圆角、30px 高、图标 14px，与截图那颗一致。没有新增任何 CSS。

### ② 三处接线

| 页面 | 日期状态 | 默认值 | 列表 |
|---|---|---|---|
| 监控预警 `InspectList` | `alarm.inspHistDate` | 昨天 | `alarm.alarmsOnDate()` |
| 报警预警 `AlarmHist` | `alarm.histDate` | 昨天 | `alarm.dayRecords()` + `worksOn(drone.items)` |
| 无人机预警 `WorkOrderList` | **新增** `drone.histDate` | 昨天 | `drone.histItems`（改为按日筛） |

三处都：点芯片 → `MonthCalendar` 展开（月份对齐所选日）；选日 → 写入 store、
收起月历、`ensureDate` / `ensureDay` 按需回补；月历 `max-day` 仍是
`inspCalMaxDay()`（昨天），筛选范围与改造前一致。

`drone.histItems` 从「今天之前的已加载部分」改为「**所选日期那一天**」，
`histCount` 随之变成那天的条数；`histDate / histCalMonth / histCalOpen` 存在
store 里（与 `listTab` 同一规则：只有 `reset()` 归位，任何重扫都不改它）。
审核中心没有服务端时间筛选，所以：

* 那天在已加载范围内 → 精确值；
* 更早 → `ensureDay` 回补几页；仍不够时列表下面写明「无人机预警仅加载到 X 日」
  并给「继续加载」（版式同 `AlarmHist` 那条 `.insp-note`），**不假装那天没有**。

无人机历史页原来的「下滑加载更多 / 还有 N 条」随按日筛选下线：按日筛的列表
不是「今天之前全部」，那个计数已经没有意义；深历史改由「选日期 + 继续加载」走。

### 落地文件

`src/components/ui/DayPickChips.vue`（`single`）、`src/stores/droneAlarm.ts`
（`histDate/histCalMonth/histCalOpen` + `histItems` 按日筛 + `reset`）、
`src/views/sub/InspectList.vue`、`src/views/sub/AlarmHist.vue`、
`src/views/sub/WorkOrderList.vue`；测试 `tests/unit/work-order.spec.ts`。

> 本轮按用户要求**未做行为验证**（不跑用例、不截图），只过了 `vue-tsc --noEmit`。

## 六点六十九、航拍照片筛选区：日期控件在 iOS 上被折行挤上去（2026-11-24）

### ① 现象

航拍照片（`AirPlayer`）。iPhone 上**切到较早日期**后，整块日期芯片往上跑，和
「站点」下拉挤进同一行，并压住下面那行张数提示（`共 111 · … · 16 张`）。

### ② 根因（不是数值没调好，是布局规则本身不确定）

筛选区原来是 `display: flex; flex-wrap: wrap`，**折不折行由内容宽度自己算**：

* 站点 `.air-pick` 是 `flex: 1 1 200px`（`min-width: 168px`）；
* 日期三颗芯片按内容宽 ≈ 213px（「选日期」三字 15px/字）；
* 换行判定用的是 hypothetical main size ≈ 200 + 8 + 213 = **421px**。

而主流 iPhone 的可用内容宽正好贴在它附近：375→351、390→366、430→406。
日期第三颗的文案会随选中日期在「选日期」（3 个字）和「11/23」之间变宽变窄，
`--fs` 在 ≤359px 还会 +1 档 —— 于是同一台机器上**点一下日期就可能翻到另一侧**。
iOS 27 又没把折行后的第二行算进容器高度，溢出的那行就画到 `.air-hint` 上：
视觉上既是「上移」，也是「和站点同行」「压住提示」。同一份代码在 iOS 26 上
看着正常，正是因为它恰好按两行算高。

### ③ 修法：行数交给 grid 定死

* `.air-filter` → `display: grid; grid-template-columns: minmax(0, 1fr);
  align-items: center; gap: 10px`。单列 = 恒定两行，行高与总高都不再依赖
  内容宽度、系统字体、iOS 版本，日期永远在站点下方那一行。
* `.air-pick` 去掉 `flex: 1 1 200px` / `min-width: 168px`，改 `min-width: 0`
  —— 站点名再长也只按 ellipsis 截断（`.air-select` 已有），不会把整行顶宽。
* `.air-days` 改 `min-width: 0; flex-wrap: wrap`（三颗在极小屏 / 大字号下
  真要折，也只让这一行变高，不会挤回上一行），并加
  `.air-days .cam-day-pick { margin-left: 0 }` 中和第三颗的 `auto` 外边距 ——
  那一颗是给满宽的 `.cam-shot-days` 靠右用的，这里必须仍靠左排。
* `.air-player` 加 `overflow: hidden`：子项算高偏小时不再画到标题栏上。

视觉零变化：手机上原本就是两行、三颗靠左、行距 10px、芯片 32px 高（与
`.air-select` 等高），月历仍是 `.air-filter .cam-cal { top: calc(100% + 6px) }`
贴着筛选区下沿。功能（今天 / 昨天 / 选日期 + 月历）一个都没动。

### 落地文件

`src/styles/app.css`（`.air-player` / `.air-filter` / `.air-pick` / `.air-days`）、
`src/components/overlays/AirPlayer.vue`（只改注释）。未新增令牌、未改字号。

> 同上：本轮未跑用例、未截图，只过了 `npm run build`（含 `vue-tsc --noEmit`），
> 交给用户在真机验证。

## 六点七十、视频监控画面加等待圈（2026-11-24）

现场要求：视频监控模块里凡是视频画面，**加载 / 缓冲时**在画面正中转一颗小圈，
能正常播放就自动消失；样式简洁、尺寸小，不新增第二套视觉。

### ① 挂在哪

视频监控层只有一个播放器（`CamPlayer`），全部点位 / 横屏全屏 / 切点位 /
断流重连共用这一块 `<video>`，所以圈挂在 `.cam-player-stage` 里，
紧贴 `<video>` 之后、右上两颗控件之前 —— **一处改动覆盖模块内所有画面**。
历史抓拍视图与大图不是视频，不挂。

### ② 什么时候转（单一事实源 = `cam.playState`，组件不另记）

| 状态 | 转圈 | 理由 |
|---|---|---|
| `buffering` | ✅ | 连流 / 追帧 / MSE 缓冲枯竭 |
| `reconnecting` | ✅ | 断流自动重连，画面已蒙起来，正等它回来 |
| `idle`（且 `wantPlay`） | ✅ | 刚打开层 / 刚切点位，地址有了、第一帧还没到 |
| `playing` | ❌ | 已经在放 |
| `paused` | ❌ | 自动播放被策略拦下，该由说明条让用户点一下画面；转圈会被读成「正在努力」 |
| `error` | ❌ | 真播不了，说明条写引擎原话 + 继续重连 |
| 无可播地址（只有 RTSP / 未登录） | ❌ | 那不是加载，空态与「仅 RTSP」行各说各的 |

`idle` 分支带 `wantPlay`：用户/系统停住的画面不该被画成正在加载。

### ③ 兜底：别让圈转个不停

部分机型从缓冲恢复只续帧、**不再补发 `playing`**（`canplay` 之后没有 `playing`），
状态会卡在 `buffering`。加 `@timeupdate` → 若 `playState === 'buffering'` 就
`markPlaying()`：有帧推进就是真在播。不碰 `reconnecting` —— 断流时 MSE 缓冲
枯竭、帧不推进，这个回调不响，重连进度条照旧。

### ④ 样式（与站内既有转圈同一套画法）

`.cam-stage-spin`：`position:absolute; inset:0; z-index:1`（压画面、低于右上控件 2），
`display:flex` 居中，**`pointer-events:none`** —— 点画面立即重连这一下不能被吃掉。

`.cam-stage-ring`：20px、`border:2px` + `border-top-color:#fff` + `border-radius:50%`，
`animation: spin 0.7s linear infinite`（复用已有的 `@keyframes spin`，与
`.cam-shots-spin` / `.hazard-spin` 同一套：细环 + 顶部高亮 + 线性匀速）。
黑画面上取白色系（`rgba(255,255,255,.3)` 环身 + 白顶），不加阴影不加底盘。
横屏全屏下 `.cam-player-stage` 变 flex 容器，圈是 absolute，仍居画面正中。

无障碍：视觉一颗环，另配 `<span class="sr-only" role="status">视频加载中</span>`
（与 `EquipPanel` 同一写法）；说明条 `#camStageBar` 的 aria-live 不动。

### 落地文件

`src/components/overlays/CamPlayer.vue`（`stageSpinning` computed、`onMediaTimeUpdate`、
模板里那颗圈 + `@timeupdate`）、`src/styles/app.css`（`.cam-stage-spin` /
`.cam-stage-ring`）。未新增令牌、未改字号、未动 flvStream。

> 本轮未跑用例、未截图、未真机，只过了 `npm run build`（含 `vue-tsc --noEmit`）。
## 六点七十一、首页背景图（场景截图）加载优化（2026-11-24）

### ① 实测到的现状（2026-11-24 16:2x，直接打接口）

| 项 | 3D（首页背景 / 三维） | 2D（全屏二维） |
|---|---|---|
| 字节 | **3,349,212（3.19MB）** | **3,842,725（3.66MB）** |
| 类型 | `image/png`（1920×1080 级，客户端无法要求更小尺寸） | 同 |
| 缓存头 | `Cache-Control: private, no-cache` + `Vary: X-API-Key` | 同 |
| 校验器 | `ETag: "5ba759…"` + `Last-Modified` | `ETag: "a9beb3…"` |
| 条件请求 | **支持**，`If-None-Match` → `304`（body 为空） | 同 |
| CORS | 预检放行 `If-None-Match`；`Access-Control-Expose-Headers` 已含 `ETag`、`Last-Modified`（304 响应同样带） | 同 |
| 尺寸参数 | `&w=` / `&width=` / `&size=` / `&thumb=` 一律 **400** | 同 |

### ② 定位到的四个真问题

1. **冷启动每次都把整张图重下**（主因）。`sceneCache` 只存了 `blob + hash`，
   没存任何服务端校验器；`run()` 的流程是「先无条件 GET 完 3.19MB → 再算指纹 →
   和本地比 → 相同就什么都不做」。**比对的成本是一整次下载**，所以「图没变」
   这个最常见的情况反而最亏：每次刷新白付 3.19MB（二维 3.66MB）。
2. **请求头里没有 `If-None-Match`**。`api/scene.ts` 原注释写的是「服务端支持 304
   但收益不值那个复杂度」—— 在「每次都要下完才能比」的前提下确实如此，
   但把校验器存下来之后，304 就是最省的一条路。
3. **首屏少一次预连接**。这张图只能走 `fetch`（要带 `X-API-Key`，不能进 `<img src>`），
   请求要等 JS 起来、HomePage 挂载才发出；`index.html` 里没有 preconnect，
   移动网络下白等一个 DNS+TCP+TLS（100~300ms）。
4. **二维图「用时才下」的代价全压在点击上**。进全屏只取 3D，点「二维」才开始
   下 3.66MB（截图里那句「二维加载中」）。而其中大部分用户其实**看过**二维
   （本机 IDB 里有），完全可以提前确认一次。

另外两条**不是**问题、但值得记下来免得再查：`<img>` 与 `.home-map` 的 CSS 背景
用的是同一个 objectURL（不重复请求）；`warm()` 预解码也是 blob URL（不产生网络）。

### ③ 改法

**A. 把 ETag 存到本地图旁边，冷启动走 304**（`utils/sceneCache.ts` + `api/scene.ts` + `stores/scene.ts`）

* `SceneCacheEntry` 增 `etag` / `lastModified`（可选字段，DB 版本不用升，旧记录读出来是空串）；
* 新增 `fetchSceneImage(type, {etag, lastModified})` → `{ blob|null, etag, lastModified, notModified }`；
  带 `If-None-Match`（无 ETag 时退 `If-Modified-Since`），并加 `cache: 'no-store'`
  —— 本地 IDB 已有一份，不要浏览器再存 3.19MB；
* `stores/scene.run()`：先 `hydrate`（IDB 上屏）→ 带校验器请求 →
  · **304**：零字节，`states = ok`，不换 URL、不写库（省 3.19MB 下载 + 一次 IDB 写）；
  · **200**：照原逻辑比指纹、换图、落盘（落盘时把新 ETag 一起写）；
  · 304 但屏幕上没图（IDB 被清 / blob 坏了）：再无条件取一次，避免「一直 304 一直没有图」；
  · 内容相同但 ETag 变了（nginx 的 ETag 是 mtime+size，重传同一张图也会变）：
    把新 ETag 写回那条记录，否则以后每次都是 200 + 3.19MB，永远轮不到 304。
* `fetchSceneBlob(type, signal)` 保留原签名（单测用它钉鉴权头 / 404 语义），
  内部改为 `fetchSceneImage` 的薄封装。

**B. 首屏预连接**（`index.html`）

```html
<link rel="preconnect" href="https://115.159.67.12" crossorigin />
<link rel="dns-prefetch" href="https://115.159.67.12" />
```

`crossorigin` 必须加，否则带自定义头的跨域请求复不到这条连接上。

**C. 二维图「本机有图才提前确认」**（`stores/scene.warmUp` + `MapLand.vue`）

进全屏地图 1.5s 后调 `scene.warmUp('2d')`：
* 本机 IDB **有**二维图 → 带 ETag 校验一次（通常就是 304，用户点「二维」一步到位）；
* 本机**没有** → 什么都不做，不替用户猜着下 3.66MB（「减少不必要请求」的边界）。

**D. 回前台补校验，保证不长期停在旧图**（`stores/scene.revalidate` + `HomePage.vue`）

`visibilitychange → visible` 时若距上次确认超过 **10 分钟**，`load('3d', true)` 再问一次。
有 ETag 在，这一次基本只是 304（几十毫秒、几百字节）；服务端真换了图才会下新图。
失败也记 `checkedAt`，前后台来回切不会变成连续重试。

### ④ 预期改善

| 场景 | 改前 | 改后 |
|---|---|---|
| 冷启动、图没变（最常见） | 3.19MB 全量 + 指纹比对 | **304，约 0.3KB**（首屏本地图直接上屏） |
| 冷启动、现场重截过 | 3.19MB | 3.19MB（必要的一次，无法再省） |
| 首次访问（本机无图） | 3.19MB | 3.19MB + 少一个 TLS 握手（preconnect） |
| 全屏点「二维」且本机有图 | 3.66MB 全量，按钮转圈等 | 通常 304 后立刻可切（预热已在后台完成） |
| 浏览器存储 | HTTP 缓存 3.19MB + IDB 3.19MB | 只有 IDB（`no-store`） |
| 同会话内第二次进入首页 | 不请求（原本就有） | 不请求（保持） |

按现场 4G/弱网 1~3MB/s 估：冷启动背景图从 **1~3s 降到几十~两百毫秒**（只剩一次 RTT）。

### ⑤ 为什么这样还能「及时拿到新图」

旧实现「每次必下」在正确性上是天然最新的；加了 304 以后，靠下面三条保证不落后：

1. **校验器就是版本号**：图一旦重传，nginx 的 ETag 立刻变 → 下一次请求就是 200 + 新图；
2. **每次冷启动都校验**（不是按天/按缓存过期），用户重开 App 一定拿到最新；
3. **长驻前台也有兜底**：`visibilitychange` + 10 分钟门槛补一次校验，不用重启 App 也能更新。

只有一种情况会短暂落后：**用户一直让 App 停在前台超过 10 分钟且从不切后台** ——
这是刻意的折中（现场图是小时级更新，多问几次只多几十毫秒但会打断首屏）。
真要强制刷新，退出重进即可（会走一次校验）。

### ⑥ 验证方式

1. **Network 面板**：第二次打开首页，`/scene-screenshots/content?...&type=3d`
   应是 **304**（Size 显示几十~几百 B，不是 3.2MB）；点「二维」同理。
2. **Application → IndexedDB → `xyc-scene` → `shots`**：`3d` 记录里应能看到
   `etag: "5ba7…"`、`lastModified`、`blob.size ≈ 3349212`。
3. **更新及时性**：让现场重传一张三维图（或临时改 nginx 的 mtime）→ 冷启动一次，
   应看到 200 + 新图，且 IDB 里的 `etag` 跟着变。
4. **弱网**：DevTools 限速 Fast 3G，冷启动应只剩一次很短的请求；
   首屏先显示内置 `site-map.webp`（130KB）或 IDB 上一张，不应白屏。
5. **回归**：断网冷启动 → 仍显示 IDB 兜底图（状态 `error`，画面不清空）；
   从未联网过 → 落到内置 `site-map.webp`。

### 落地文件

`src/api/scene.ts`（`fetchSceneImage` + 条件请求 + `no-store`）、
`src/utils/sceneCache.ts`（记录里加 `etag` / `lastModified`，兼容旧记录）、
`src/stores/scene.ts`（304 分支、ETag 回写、`revalidate`、`warmUp`）、
`src/views/HomePage.vue`（`visibilitychange` 补校验）、
`src/components/overlays/MapLand.vue`（1.5s 后 `warmUp('2d')`）、
`index.html`（preconnect / dns-prefetch）。

> 本轮未跑用例、未截图；接口行为用 curl 实测（响应头 / 304 / 400），构建用
> `npm run build`（含 `vue-tsc --noEmit`）通过。**体积本身降不下来**：服务端只接受
> `pid/type` 两个参数（多余参数 400），图片是 Unity 侧导出的 3.19/3.66MB PNG，
> 想真正变小只能在上传侧转 WebP / 降分辨率，属服务端改造，不在本次前端范围。
## 六点七十二、横向手势归属与首页轮播边界（2026-11-24）

现场要求：**只允许首页的预警轮播响应左右滑动**，其它页面严格禁用左滑（不误触返回、
不切换页面）；同时处理横滑与纵滚冲突、轮播首尾边界、进出页面后的状态恢复。

### ① 先盘点：全站到底有几处横向手势

| 位置 | 是否换页 | 处理 |
|---|---|---|
| `views/home/parts/AlarmFeed.vue` 首页预警轮播 | **是**（唯一） | 本轮强化，见 ② |
| `utils/zoom.ts` / `useImageZoom` 图片放大平移 | 否（动画面） | 保留 |
| `PanoViewer` 全景拖拽、`MapViewer` 地图拖拽 | 否（动画面） | 保留 |
| `utils/swipeBack.ts` 右滑返回 | 是（只关层，只认右滑） | 行为不变，补文档 |
| 其余所有页面 | — | **没有任何横向手势实现** |

结论：一级页面（首页 / 工作台 / 消息 / 我的）在应用层**本来就没有左滑逻辑** —— 
`swipeBack` 的 `topLayer()` 只认覆盖层，一级页面返回 null，左右两向都不接管。
所以「左滑切换页面」在应用内是不存在的；现场能看到的左滑只可能来自浏览器/系统。

浏览器级左滑（前向遍历）由 `utils/historyBack.ts` 的「前进分支」兜住：落到旧条目
就地 `replaceState` 改写层数，**不关层、不发起任何遍历**，松手后画面不动。

> 仍需说清的平台边界：iOS Safari / 微信内置浏览器在手指还按着时会画出前向条目的
> 系统快照（网页拿不到事件、也拦不住）。我们能保证的是「松手不跳、不弹回、不重播
> 动画」。装了 PWA（全屏 `display: standalone`）时这条系统手势不再生效。

### ② 轮播：三处硬改（`AlarmFeed.vue`）

**A. 方向锁 —— 横滑与纵滚不再打架**

`.alarm-feed-win` 早已是 `touch-action: pan-y`（纵向归浏览器、横向归 JS），但
`onMove` 之前**任何方向都写 `translateX`**：手指斜着划时，浏览器在滚页面、
轨道又在横移，观感是「滚列表时轮播在抖」。

现在按 8px 抖动区分方向，先定向再动：

| 判定 | 处置 |
|---|---|
| `|dx| ≤ 8 && |dy| ≤ 8` | 还没定向，一像素都不写（可能只是点击） |
| `|dy| > |dx|` | 认定纵滚：**就地撒手**（`releaseDrag` 还掉指针捕获，否则页面根本滚不动）+ 轨道吸附回原页 + 抑制随后的 click |
| 其余 | 认定横滑：进入跟手，只在这一支里写 `transform` |

**B. `pointercancel` 不再当 `pointerup`**

旧模板是 `@pointercancel="onUp"` —— 浏览器接管纵向滚动时会 cancel 指针，而
`onUp` 会拿「滚到一半的 `lastX`」算位移，于是**竖着滚一下偶尔把轮播翻一页**。
现在 `onCancel` 一律 `go(startIdx, true)` 吸附回原页，不判翻页。

**C. 首尾边界双保险**

双向副本页（轨道 = [末页副本] + 真实页 + [首页副本]）保持不变，另加：
* `onUp` 的目标下标再夹一道 `[0, slides.length - 1]` —— 兜「页数刚好在这一帧变了」
  的极窄窗口（越界下标会 translate 到轨道外，露白比回弹难看得多）；
* 单页（`pageN ≤ 1`）时 `onDown` 直接返回：不装指针捕获、不响应拖动（只有一颗圆点，
  没有可切换的目标）。

### ③ 状态恢复：轮播只在「真的看得见」时转

四个 tab 页是常驻挂载的（`.page.active` 只切显隐），本组件不会因为切 tab 而卸载 ——
旧实现里 4s 定时器一直在后台跑。现在由 `running` 一个 computed 收口：

```
running = 轮播在视口内 && activeTab === 'home'
          && !sub.isOpen && !cam.isOpen && !air.isOpen && !air.hazardOpen && !sheet.isOpen
```

* **视口**：`IntersectionObserver`（threshold 0.25）盯根元素，首页往下滚把轮播滚出
  屏幕就停表；没有这个 API 的老内核退化为恒真（行为等同旧版）。
* **覆盖层**：进子页 / 打开监控、航拍、弹层时暂停，返回首页时恢复。
* **恢复语义**：`normalize()` + `restart()` —— **停在哪一页就从哪一页继续**，
  不重置到第一页（真正需要回第一页的只有「页数变了」那条 watch）。
* 页数变化时 `start()` 重铺轨道；若此刻不可见，紧接着 `pause()`，等回来再起表。

### ④ 落地文件

`src/views/home/parts/AlarmFeed.vue`（`axis` 方向锁、`releaseDrag`、`onCancel`、
目标夹紧、`rootEl` + `IntersectionObserver`、`running` + watch、`onMounted/onUnmounted`、
模板 `@pointercancel="onCancel"` 与 `ref="rootEl"`）、
`src/utils/swipeBack.ts`（仅补「横向手势归属」注释，行为未改）。

`app.css` 无需改动：`html, body` 已有 `overscroll-behavior: none`，`.page` 是
`overscroll-behavior: contain`，`.alarm-feed-win` 早已 `touch-action: pan-y`。

### ⑤ 验证点

1. 首页轮播：左右滑各翻一页；第 1 页右滑绕到最后一页、末页左滑绕回第 1 页，不露白；
2. 手指斜着划（往下居多）：页面正常纵向滚动，轮播**不翻页也不抖**；
3. 滚到轮播上突然放开（触发 `pointercancel`）：轮播吸附回原页；
4. 进详情再返回：轮播停在离开那一页，4s 后继续自动播；
5. 切到工作台 / 消息 / 我的各页横滑：**页面无任何变化**（无返回、无换页）；
6. 首页进子页后左滑、其它一级页面左滑：松手后画面不动（系统手势预览属平台边界）。

> 本轮未跑用例、未截图、未真机，只过了 `npm run build`（含 `vue-tsc --noEmit`）。
## 六点七十三、全站禁选与可编辑区豁免（2026-11-24）

现场要求：移动端与桌面端长按 / 拖动时**不得框选页面内容**（不出现文字选中高亮、
不弹选择手柄、不弹「拷贝 / 查询 / 存储图像」菜单），同时滚动、点击、表单输入、
文本域与可编辑区域的选择编辑**必须照旧**。

### ① 定位结论

全站选择行为只有一处来源，且是**样式层**：

| 位置 | 原状 | 问题 |
|---|---|---|
| `app.css` `body{}` | 只有无前缀 `user-select: none` | ① 缺 `-webkit-user-select`，iOS 15 及更早的 WebKit 视其为无效声明 → 长按照样选中；② **完全没有 `-webkit-touch-callout`** → iOS 长按图片 / 链接仍弹系统菜单（「存储图像」「拷贝」），这一条与 `user-select` 无关，加多少条 `user-select` 都挡不住 |
| `index.html` `#boot` | 有前缀的 `user-select: none` | 同样缺 `-webkit-touch-callout`，启动骨架里长按 logo 会弹菜单 |
| 交互代码 | **无** | `src/` 里没有任何 `selectstart` / `contextmenu` / `getSelection` 监听，不存在第二套拦截逻辑 |

由此定调：**不需要加 JS**。用 `contextmenu` 全局拦截是错的——它会连带吃掉输入框
右键「粘贴」和桌面端正常右键菜单，直接违反「表单输入不受影响」；而 `selectstart`
的 `preventDefault` 与 CSS 是同一件事，多一层只多一个失效点。

### ② 改法（三处，共 8 行有效声明）

**A. `body` 补齐两条**（`src/styles/app.css`）

```css
-webkit-user-select: none;
user-select: none;
-webkit-touch-callout: none;
```

三条分工不同，少一条就漏一类现象：前两条管「不产生选区」→ 手柄无从出现；
第三条管 iOS 的系统长按菜单（图片 / 链接），**只对 Safari 系有效**。

**B. 可输入 / 可编辑区域写回**（`src/styles/app.css`，紧跟 `button, input, textarea` 那条）

```css
input, textarea, select,
[contenteditable]:not([contenteditable="false"]) {
  -webkit-user-select: text;
  user-select: text;
  -webkit-touch-callout: default;
}
```

为什么不靠浏览器默认：Chrome 对表单控件确实有特殊照顾，但 iOS Safari 上父级的
`touch-callout: none` 会把长按菜单一起吃掉（全选 / 粘贴都弹不出来），必须显式还原。
`select` 一并列入是为了「原生下拉不受影响」；`[contenteditable]` 排除
`contenteditable="false"`（可编辑容器里的只读片段不该变可选）。

**C. 两处刻意可选的地方补 `-webkit-touch-callout: default`**

* `.cam-url`（监控层里那行 FLV 地址，注释写明「让人能复制去 VLC / 运维侧排查」）——
  它已经写了 `user-select: text`，但刚加的 `body{touch-callout:none}` 会让它在 iOS 上
  长按弹不出「拷贝」，必须配对写回；
* `index.html` 的 `#boot` 补 `-webkit-touch-callout: none`（外链 CSS 未到时它也生效）。

### ③ 为什么不动 `touch-action`

| 要求 | 依赖的属性 | 有没有碰 |
|---|---|---|
| 页面纵向滚动 | `touch-action`（`.page` 容器自身滚动）+ `overscroll-behavior` | 未改 |
| 首页轮播横滑 | `.alarm-feed-win{touch-action:pan-y}` | 未改 |
| 图片缩放平移 | `img.zoomable{touch-action}` | 未改 |
| 按钮 / 链接点击 | 与上述属性无关 | 未改 |

`user-select` 与 `-webkit-touch-callout` 都不参与 `touch-action` 的判码，也不影响
`click` 的派发 —— 禁用选择不会让任何点击变迟钝或失效。

### ④ 已知平台边界

* `-webkit-touch-callout` 是 Safari 私有属性，**Android Chrome 不认**。安卓长按图片
  仍可能弹「下载图片」—— 那是浏览器级菜单，抑制它只能全局拦 `contextmenu`，代价是
  废掉输入框长按/右键粘贴，故不做；
* iOS 有个老 bug：页面里存在 `<input>` 时，长按输入框**附近**的文字偶尔会把光标
  抢过去。属 WebKit 缺陷，CSS 无解，且本项目输入框只出现在登录页与隐患上报层。

### ⑤ 落地文件

`src/styles/app.css`（`body` 补两条、新增可编辑区豁免块、`.cam-url` 补 callout）、
`index.html`（`#boot` 补 callout）。未新增令牌、未改字号、未动任何 JS。

### ⑥ 验证点

1. 首页 / 工作台 / 消息 / 我的：**鼠标按住拖动**不出现蓝色选区、不出现「I」形光标拖影；
2. iOS 长按任意卡片 / 图片 / 站点名：不出现选择手柄、不弹「拷贝 / 查询 / 存储图像」；
3. 安卓长按文本：不出现手柄（长按图片仍可能弹浏览器菜单，见 ④）；
4. 登录页输入框：点得进光标、能框选一段文字、iOS 长按弹出「全选 / 粘贴」；
5. 隐患上报 `textarea`：能正常输入、换行、长按粘贴；
6. 监控层那行 FLV 地址：iOS 长按能弹出「拷贝」；
7. 回归：各页纵向滚动正常、轮播横滑正常、按钮与链接点击正常、表格/列表 `:active` 反馈不变。

> 本轮未跑用例、未截图、未真机，只过了 `npm run build`（含 `vue-tsc --noEmit`）。
## 六点七十四、横向手势收口：只有轮播能横滑（2026-11-24 二次加固）

现场反馈：上一轮「只让首页轮播响应左右滑」之后，**部分页面仍能被左滑**。本轮逐条
排查所有触摸 / 指针事件与页面切换触发点，找到三条真正的漏网路径并补上。

### ① 上一轮漏在哪（逐条对照代码）

| # | 漏网路径 | 为什么上一轮没兜住 |
|---|---|---|
| 1 | **`overflow` 单轴声明把另一轴算成 `auto`** | `.page` 写的是 `overflow: auto`，等于**横向也可滚**；`#homePanels` / `.pd-list` 写的是 `overflow-y: auto` —— 按 CSS 规则，一个方向非 `visible` 时另一个 `visible` 会被计算成 `auto`，横向照样能滚。于是只要页面里有一个略宽的表格、不换行的长串或超宽的横排，整块内容就能被横着拖走。这一条是「部分页面仍可左滑」的主因：**能滑的页面 = 恰好有横向溢出的页面** |
| 2 | **没有任何「统一」的守卫** | 上一轮只做了两件事：轮播自己 `touch-action: pan-y`、`historyBack` 前进零导航。前者是**逐元素**声明，散在各组件里，漏一个就有一个洞；后者只能管「已经发生的浏览器导航」，管不住内容先被拖走 |
| 3 | **轮播左边缘与返回手势共用起手区** | `.page` 左右 padding 16px < `swipeBack` 的 24px 边缘起手区。有覆盖层时从轮播最左侧起手，两层会同时认领这一指 |

顺带确认**不是**问题的几处（免得以后再查）：`AlarmFeed` 的方向锁与首尾副本页、
`swipeBack` 的左滑 `giveUp()`、`historyBack` 的 `target >= depth` 分支（前进零
`go`）、`HomePage` 的抽屉拖拽（只读 `clientY`）、`TouchChart` / `DonutTouch`
（`pointerdown.prevent` + move，不换页）、`MapViewer` / `PanoViewer` / `useImageZoom`
（动画面，不换页）。`.page` 非激活时是 `display: none`，隐藏页收不到任何事件。

### ② 改法一：统一守卫 `utils/horizontalGuard.ts`（新增）

document 层一处判定，只有三条规则：

| 情形 | 处置 |
|---|---|
| 多指（≥2） | 完全不管 —— 那是捏合缩放 |
| 位移 < 10px | 不表态（可能只是点击） |
| `|dy| > |dx|` | **整指撒手**，交给浏览器滚动，本次手势后面不再干预 |
| 起手在 `.alarm-feed-win` 内 | 放行 —— 轮播自己用 pointer 跟手，`touch-action: pan-y` 已让浏览器不处理横向 |
| 起手元素往上存在**真的能横滚**的祖先（`overflow-x: auto/scroll` 且 `scrollWidth > clientWidth`） | 放行 —— 设备详情 `.pd-units` 那类刻意横滑条 |
| 其余横向移动 | `preventDefault()`，并锁到 `touchend` |

三个关键点：

* **为什么用 touch 而不是 pointer**：要的是「阻止默认行为」（取消滚动与浏览器手势
  判码），只有 `touchmove` 能 `preventDefault`，且必须 `{ passive: false }`；
  pointer 事件不可取消，用它拦不住内容被拖走。
* **为什么不给全站写 `touch-action: pan-y`**：`touch-action` 沿祖先链取交集，写到
  `.pages` 会把 `TouchChart` 的横向选点、`DonutTouch` 的分段拖动一起废掉。守卫按
  「起手元素」判断，粒度才是对的。
* **锁到 `touchend` 而不是每帧重判**：否则「斜着划一半再改横」会让页面先滚半屏
  再横移，比不放行还乱。

### ③ 改法二：把所有纵向滚动容器的横向锁死（`app.css`）

| 选择器 | 改动 |
|---|---|
| `.page`、`.cam-player-switch`、`.cam-shots`、`.air-grid`、`.hazard-body`、`.subpage-body` | 在统一那组里加 `overflow-x: hidden`（原本只有 `overscroll-behavior: contain`） |
| `#homePanels`（首页抽屉） | 补 `overflow-x: hidden` —— 它只写了 `overflow-y: auto`，横向被算成 auto。首页抽屉里塞着轮播、KPI 横排、统计格，**这是「首页非轮播区域也能左滑」的直接来源** |
| `.pd-list`（设备详情名单） | 同上补 `overflow-x: hidden`（它另有 `touch-action: pan-y` 兜底） |

刻意横滑的子元素不受影响：`.pd-units` 自己 `overflow-x: auto`、宽度受父级约束，
照旧能滑 —— 守卫那边也会识别它并放行。

### ④ 改法三：轮播与返回手势隔离（`AlarmFeed.vue`）

模板 `@pointerdown` → `@pointerdown.stop`：把 pointerdown 挡在轮播窗口内，不再冒泡
到 `window` 上的右滑返回手势。`pointermove` / `pointerup` 仍照常冒泡 —— 返回手势
没有 pointerdown 就不会进入 tracking，本来就互不干扰。

### ⑤ 平台边界（拦不住的部分，必须说清）

| 手势 | 能否拦 | 说明 |
|---|---|---|
| Android Chrome 横向 overscroll 导航 | ✅ 基本拦住 | `html, body{overscroll-behavior: none}` + 守卫 `preventDefault` |
| iOS / Android 内容横向滚动 | ✅ 拦住 | `overflow-x: hidden` + 守卫 |
| iOS Safari / 微信 **边缘侧滑导航** | ❌ | 系统级手势，`preventDefault` 无效。应用内保证「内容不动、不发任何 history 遍历」；**手指按住期间的系统快照预览拦不住**。装 PWA（standalone）后该手势消失 |
| 桌面触控板双指横滑 | ❌ | 属浏览器 / 系统级历史导航，网页收不到可取消事件 |

### ⑥ 重点回归页面与场景

**A. 必须「有反应」的（唯一白名单）**

1. 首页预警轮播：左滑翻下一页、右滑翻上一页；首页右滑绕过末页、末页左滑绕回首页；
2. 轮播上斜着往下划：页面正常纵向滚动，轮播**不翻页也不抖**；
3. 轮播上按下后不移动就松手：当点击处理，进对应详情。

**B. 必须「完全无反应」的（左滑与右滑都不动内容）**

4. 首页轮播以外的全部区域：地图背景、KPI 卡、统计卡、图表卡、抽屉空白处；
5. 首页抽屉展开 / 半开两种档位，横滑内容不动、只有纵向能滚；
6. 工作台：全部卡片、图表（`TouchChart` 的点选仍要正常）、列表；
7. 消息：两张预警卡、列表；
8. 我的：全部行项；
9. 全部子页（`.subpage-body`）：报警历史、巡检列表、设备详情（含 `.pd-units`
   横滑条 —— **这里是唯一应放行的子页横滑**）、日报 / 周报 / 月报、无人机、登录页；
10. 视频监控层：点位切换列表、历史抓拍网格；画面内未放大时横滑不动、放大后可平移；
11. 航拍照片层：站点下拉、日期芯片、照片网格；照片详情内未放大时横滑不动、放大后可平移；
12. 隐患填报层：表单区横滑不动，`textarea` 内文字选择与光标不受影响；
13. 全屏地图：拖拽可平移地图（这是唯一应该响应横向拖的覆盖层），松手不换页、不返回；
14. 全景 / VR 环视：拖拽转视角正常。

**C. 交互不能坏的**

15. 纵向滚动：上述每一页滚到底 / 滚到顶都不出现横向位移与整屏回弹；
16. 点击与按压反馈：按钮、卡片、底栏四个 tab、列表行项的 `:active` 与点击；
17. 表单：登录页输入框、隐患填报 `textarea` 的聚焦、输入、光标定位、长按粘贴；
18. 右滑返回（保留）：子页 / 监控 / 航拍 / 隐患从**左边缘**起手右滑，仍能跟手返回；
19. 浏览器返回键 / 安卓物理返回：仍按层数逐级退，不多退也不少退；
20. 图片缩放：双指捏合仍能缩放，单指在放大态仍能平移（不被守卫拦）。

### 落地文件

`src/utils/horizontalGuard.ts`（新增）、`src/App.vue`（`useHorizontalGuard()`）、
`src/styles/app.css`（`.page` 等 6 个容器 + `#homePanels` + `.pd-list` 补
`overflow-x: hidden`）、`src/views/home/parts/AlarmFeed.vue`（`@pointerdown.stop`
与注释）。未新增令牌、未改字号、未动 `historyBack` 与 `swipeBack` 的行为。

> 本轮未跑用例、未截图、未真机，只过了 `npm run build`（含 `vue-tsc --noEmit`）。
## 六点七十五、塔机「当前负荷」改口径：当前吊重 ÷ 额定 5t（2026-11-24）

现场要求：5G 塔机页（`DevicePage`，`kind='crane'`）里智能塔机 2 / 3 / 4 的
「当前负荷」统一按 **当前吊重 ÷ 5t** 算，数值来源与「当前吊重」格一致，
卡下进度条与显示值同源。

### ① 改前是什么口径，为什么必须改

| 格 | 改前来源 |
|---|---|
| 当前吊重 | MQTT 报文 `weight` |
| 当前负荷 | MQTT 报文 **`weightRate`**（`utils/craneLoad.ts: loadPct` 归一，启发式猜 0~1 还是 0~100） |

两个数是**两个来源**：`weightRate` 是平台侧自己算的利用率，与报文 `weight`
没有强制关系。现场看到「当前吊重 0.07t / 当前负荷 2%」这种配对（0.07 ÷ 5 只有
1%），第一反应就是哪个数错了。而且 `weightRate` 单位在协议里没写，旧实现靠
「≤1 当比值」的猜测 —— 猜错就整格错一倍。

### ② 改成什么

```ts
// utils/craneLoad.ts
export const CRANE_RATED_T = 5                       // 现场三台智能塔机铭牌额定
export function craneLoadPct(weight, rated = CRANE_RATED_T): number | null
// pct = min(100, round(weight / rated * 100))
```

| 输入 | 输出 | 说明 |
|---|---|---|
| `0.07` | `1` | 0.07 ÷ 5 = 1.4% → 四舍五入 1% |
| `0.25` | `5` | 5.0% |
| `1.00` | `20` | 20% |
| `0` | `0` | 空钩是结论，不是没数据 |
| `5.4` | `100` | 超额定截到 100，进度条不溢出（超载另有告警） |
| `null` / 无帧 | `null` | 格子写「—」且**不画条**，「没数据」不能画成「负荷 0%」 |

`weightRate` 仍原样留在报文类型与解析层（协议字段，解析不猜），只是不再参与
卡片计算；`loadPct` 这个旧函数已删除，全项目只剩一个负荷口径。

### ③ 显示值与进度条怎么保证一致

`cards` computed 里**只算一次**：

```ts
const pct = frame ? craneLoadPct(frame.weight) : null
...
cells: craneCells(sn, frame, pct),   // 「当前负荷」格写 `${pct}%`
load: pct,                            // 模板 `:style="{ width: `${c.load}%` }"`
```

模板拿的就是 `c.load`，没有第二处计算、没有硬编码百分比。进度条的填充色是
固定渐变（`.dev-bar i`），**没有按值变色**，所以「状态」就体现在宽度上 ——
同一个数不可能出现「写 2% 画 3%」。

### ④ 影响面

* 只动塔机卡：`cards` 里 `if (!isCrane.value) return liftCards.value`，电梯卡
  `load: null`（从不画条），四格也不经过 `craneLoadPct`；
* 传统塔机5 没有平台编号（`craneSnOf` 为 null）→ 无帧 → 两格仍是「—」，行为不变；
* 报表页（`DeviceReport`）本来就不用实时负荷（它的「负荷」一栏早已换成
  「峰值吊重」），不受影响；
* 设备信息弹层不显示负荷，不受影响。

### ⑤ 落地文件

`src/utils/craneLoad.ts`（重写：`CRANE_RATED_T` + `craneLoadPct`，删 `loadPct`）、
`src/views/sub/DevicePage.vue`（import、顶部注释、`craneCells` 注释、`cards` 里
`pct` 一行）、`src/api/craneRealtime.ts`（`weightRate` 注释改为「卡片不用它」）。
未改样式、未改测试期望（`device-page.spec.ts` 只断言四格标签文字）。

### ⑥ 验证点

1. 塔机 2/3/4 卡片：「当前负荷」≈ `当前吊重 ÷ 5` 四舍五入（0.07t → 1%，0.00t → 0%）；
2. 同一张卡的进度条宽度 === 该百分比，切换帧时两者同步变化；
3. 无实时帧（通道不通 / 25s 过期）：两格「—」、无进度条；
4. 传统塔机5：四格仍全「—」；
5. 电梯页：四格与行为完全不变（无「当前负荷」、无进度条）；
6. 报表页：数据与之前一致。

> 本轮未跑用例、未截图、未真机，只过了 `npm run build`（含 `vue-tsc --noEmit`）。
## 六点七十六、5G塔机机组改名与「传统塔机5」下线（2026-11-25）

现场要求（截图给的是 5G塔机 页的四张卡）：

| 台账原名 | 现场展示名 |
|---|---|
| 智能塔机2 | **2#楼-智能塔机2** |
| 智能塔机3 | **3#楼-智能塔机3** |
| 智能塔机4 | **酒店-智能塔机4** |
| 传统塔机5 | **删除该条目** |

只改名称与这一条的去留，其余内容与顺序不变。

### ① 为什么改在映射层，而不是改页面模板

设备名在四个地方露脸：设备页卡片标题、设备信息弹层副标题、作业报表的机队表
与结论句、首页智控卡的机组列表（`online x/y` 的分母）。四处都从
`utils/deviceLedger.ts` 的两个出口拿数据（`toUnit` / `toEquip`），
另有一处 `stores/deviceLedger.categoryUnits` 直接由台账行映射。

若只在 `DevicePage` 模板里换文案，会出现「卡片叫 2#楼-智能塔机2、点开弹层叫智能塔机2、
报表又是智能塔机2」的三套名字。所以统一收在映射层，加两个纯函数：

```ts
displayNameOf(name)   // 台账设备名 → 展示名，未登记的原样返回
isHiddenDevice(name)  // 这一行还要不要在机组列表里出现
```

`toUnit`（卡片 + 弹层 + 报表）、`toEquip`（首页四卡）、`categoryUnits`（机组登记表）
三处出口统一套用，原始 `rows` 一行不动。

### ② 两条必须守住的约束

1. **新名字里保留台号数字**。台号是 `unitNo()` 取「名称里第一段数字」得来的，
   实时工况的 sn 也靠它（`craneSnOf(台号)` → `向阳村N#塔机`）。
   `2#楼-智能塔机2` → 2、`3#楼-智能塔机3` → 3、`酒店-智能塔机4` → 4，
   与改名前完全一致 —— 所以当前吊重 / 当前负荷 / 今日吊次 / 今日吊重 /
   实时四态**一格都不会变**。若把数字拿掉，这几台会立刻掉成「—」与「离线」。
2. **只影响条目，不影响台账统计**。`total` / `online` 仍按 `rows` 全量算
   （8 台 / 7 在线），`rows` 里那条「传统塔机5」照旧在。页面上看不到它，
   但「平台登记了几台设备」这个事实没有被改写。

### ③ 连带变化（都是「删除条目」的必然结果，非新增逻辑）

| 位置 | 改前 | 改后 |
|---|---|---|
| 5G塔机 页卡片 | 4 张 | **3 张**（2 → 3 → 4 顺序不变） |
| 首页智控「5G塔机」卡 | 在线 2/4 | **2/3** |
| 首页统计卡「台数」 | 15 台 | **14 台**（在线 9、离线 5） |
| 作业报表机队表 | 4 行 | **3 行** |
| 报表结论「传统塔机5 无平台编号，未纳入统计」 | 有 | **不再出现**（该条不在机组里，规则本身保留） |
| 设备信息弹层 | 可打开传统塔机5 | 无入口（列表里已没有它） |
| 台账总数 / 在线数（首页计数卡） | 8 / 7 | **8 / 7 不变** |

`toEquip` 里「最大高度」的聚合刻意放在隐藏判断**之前**：它算的是「这一类设备在
台账里的最大高度」，与某台是否展示无关，隐藏那台（10.3m）不该让这个数变小。

### ④ 落地文件

`src/utils/deviceLedger.ts`（`DISPLAY_NAMES` / `HIDDEN_NAMES` / `displayNameOf` /
`isHiddenDevice`，接入 `toUnit` 与 `toEquip`）、
`src/stores/deviceLedger.ts`（`categoryUnits` 过滤隐藏项、`loadCraneDay` 不为隐藏项
发请求、import）、
`src/views/sub/DevicePage.vue` / `DeviceReport.vue` / `components/sheets/DeviceInfoSheet.vue`
（只更新注释，行为未改）。

测试期望同步（**未运行，按要求交给用户验证**）：`device-ledger.spec.ts`（展示名、
机组 3 台）、`device-page.spec.ts`（卡片 3 张与名称、首页 2/3 与 14 台、报表 3 行、
删除「传统塔机5 弹层」用例）、`stores-views.spec.ts`（`{on:2,total:3}`）。

### ⑤ 验证点

1. 5G塔机 页：恰好 3 张卡，标题依次为「2#楼-智能塔机2 / 3#楼-智能塔机3 / 酒店-智能塔机4」，
   顺序与改名前一致，没有「传统塔机5」；
2. 三张卡的今日吊次 / 今日吊重 / 当前吊重 / 当前负荷与改名前**逐格相同**
   （改名不影响台号 → sn 不变）；
3. 点「设备信息」：副标题是新名字，编号仍是 EW2 / EW3 / EW4；
4. 作业报表：机队表 3 行、结论里不再出现「传统塔机5」；
5. 首页智控「5G塔机」卡：在线 2/3；统计卡仍是 8 台设备 / 7 在线；
6. 电梯页与电梯报表：完全不变。

> 本轮按要求**未跑用例、未截图、未真机**，只过了 `npx vue-tsc --noEmit`。

---

## 六点七十七、智能电梯四笼改名：加楼栋前缀（2026-11-25）

现场报「1# 那栋其实叫酒店」，于是 4 个轿厢的展示名统一加前缀，与上一节塔机改名
同一口径：**只改展示层，不动数据线**。

| sn | V2 原始名（`name`，保留） | 页面展示名（`display`） |
|---|---|---|
| `3225122202` | 智能电梯1-1 | **酒店-智能电梯1-1** |
| `32251222021` | 智能电梯1-2 | **酒店-智能电梯1-2** |
| `32251222023` | 智能电梯2-1 | **2#楼-智能电梯2-1** |
| `E03C1CB9F5011824` | 智能电梯2-2 | **2#楼-智能电梯2-2** |

### ① 为什么加一列而不是直接改 `name`

`LIFT_CAGES[].name` 是 V2 场景包里 `BuildingElevatorCage.friendlyName` 的原样抄录，
`data/liftSn.ts` 顶部那张 sn 对照表就是照它建的 —— 它是**数据出处的凭证**（将来
回查 UnityPy 解析结果只有这一条线索）。所以原样留着，新增 `display` 承载现场叫法。

### ② 改名不碰读数：`sn` 与 `building` 一个字没动

- 实时数据按 **sn** 查（`api/lift.ts`），卡片四格、在线状态、今日升降次数都靠它；
- 档案字段按 **building** 找台账那两行（`unitNo(u.name) === c.building`），
  而台账名「智能电梯1 / 2」没改，所以这条线也不受影响；
- 新名里楼号/笼号数字都保留（1-1 / 1-2 / 2-1 / 2-2），现场念设备就念这两个号。

结论：改名后**四格逐格与改名前相同**，不会出现「名字变了、数据掉成 —」。

### ③ 连带变化（都是「换文案」的必然结果）

| 位置 | 改前 | 改后 |
|---|---|---|
| 智能电梯 页 4 张卡标题 | 智能电梯N-M | **酒店-/2#楼- 前缀** |
| 设备信息弹层副标题 | 智能电梯1-1 | **酒店-智能电梯1-1** |
| 作业报表机队表「电梯」列 | 同上 | 同上 |
| 报表结论（关注/主力/短板/当前）点名的台 | 同上 | 同上（含「X 离线」那句） |
| 卡头布局 / 字号 / 状态胶囊 / 「设备信息」按钮 | — | **不变**（`.dev-card-hd strong` 是 `flex:1`，名字变长只吃中间的空余量） |

### ④ 落地文件

`src/data/liftSn.ts`（`LiftCage` 增 `display`、4 条数据补值、说明改名口径）、
`src/views/sub/DevicePage.vue`（卡片 `name: c.display`、注释）、
`src/stores/liftReport.ts`（报表行 `name: c.display`）、
`src/views/sub/LiftReport.vue`（「X 离线」点名的 `c.display`）、
`src/components/overlays/SheetHost.vue`（弹层副标题 `cage.display`）。

测试期望同步（**未运行，按要求交给用户验证**）：`device-page.spec.ts`（4 张卡标题、
弹层副标题）、`lift-report.spec.ts`（机队表行名、四段结论里的台名）。

### ⑤ 验证点

1. 智能电梯 页：4 张卡标题依次为「酒店-智能电梯1-1 / 酒店-智能电梯1-2 /
   2#楼-智能电梯2-1 / 2#楼-智能电梯2-2」，顺序与改名前一致；
2. 四张卡的状态、「当前楼层 / 当前高度 / 当前人数 / 当前载重」与改名前**逐格相同**；
3. 点「设备信息」：副标题是新名字，档案字段（安检有效期等）仍取自所属那栋楼；
4. 作业报表：机队表 4 行名字同步，结论里点名的台名同步；
5. 首页「智能电梯」计数仍是 4 台（在线数看网关实际回报），塔机三张卡不受影响。

> 本轮同样**未跑用例、未截图、未真机**，只过了 `npx vue-tsc --noEmit`。

---

## 六点七十八、电梯「作业报表」子页下线（2026-11-25）

智能电梯页原先与 5G塔机共用一套双页签（设备实时状态 / 作业报表）。现场要求
**电梯只保留实时状态**，于是把这条子页从页面到数据层整条摘掉。塔机的「作业报表」
原样保留，一行逻辑没动。

### ① 摘掉了什么

| 层 | 文件 | 处理 |
|---|---|---|
| 页面 | `src/views/sub/LiftReport.vue` | **删除**（269 行） |
| 数据层 | `src/stores/liftReport.ts` | **删除**（147 行，含 45s 区间缓存与凭证失效态） |
| 纯函数 | `src/utils/liftReport.ts` | **删除**（157 行，按日切片算在运时段那套） |
| 接口 | `src/api/lift.ts::fetchLiftWorkRange` | **删除**（区间查 `EVENT_WORKDATA`，只被上面那个 store 用过） |
| 用例 | `tests/unit/lift-report.spec.ts` | **删除**（460 行） |
| 引用 | `src/views/sub/DeviceReport.vue` | 去掉 `LiftReport` 的 import 与 `v-else-if="!isCrane"` 分支、`isCrane` 相关判断 |
| 入口 | `src/views/sub/DevicePage.vue` | 页签栏 `v-if="isCrane"`（电梯不渲染），实时态分支改 `v-else-if="!isCrane \|\| pageTab === 'live'"`，报表分支改 `v-else-if="isCrane"` |

没有独立路由：本项目的子页是 `stores/subpage.ts` 的视图栈（`openDevice(kind)`），
电梯报表页签一直是 `DevicePage` 内部的 `pageTab`，所以「菜单入口 / 路由配置」这两项
在代码里就是这次的页签栏与分支 —— 没有别处要摘的注册表。

### ② 判定口径

- 电梯页 `isCrane === false` → 页签栏不渲染；内容分支命中 `!isCrane`，永远走实时状态，
  即使 `pageTab` 因任何原因残留为 `'report'` 也不会再渲染报表；
- `DeviceReport` 现在只可能收到 `kind === 'crane'`，内部判断从「按 kind 分叉」简化为
  「塔机一条路」，空态文案与骨架屏都没改；
- `stores/lift.ts`（在线/工况/今日作业轮询）、`data/liftSn.ts`、`DeviceInfoSheet` 的电梯
  读数与档案**全部不受影响** —— 它们与报表没有共享代码，唯一交点是 `api/lift.ts`
  里被删的那个区间函数。

### ③ 连带变化

| 位置 | 改前 | 改后 |
|---|---|---|
| 智能电梯 页顶 | 两个页签 | **无页签**，进来就是四张轿厢卡 |
| 电梯日报/周报/月报 | 可切换、可导出分享 | **不再存在** |
| 5G塔机 页 | 两个页签 | **不变**（设备实时状态 / 作业报表 7 个粒度与导出都在） |
| 电梯四张卡的读数、`设备信息` 弹层 | — | **不变** |
| 打包体积 | precache 906.09 KiB | **898.26 KiB** |

> 上一节（六点七十七）里「作业报表机队表 4 行名字同步」那条随之失效 ——
> 页面已整体移除，电梯的展示名现在只剩卡头与弹层副标题两处。

### ④ 验证点

1. 智能电梯 页：顶部**没有**「设备实时状态 / 作业报表」页签，四张卡直接铺开，
   卡头与上一轮改名一致；
2. 5G塔机 页：页签仍是两个，「作业报表」切过去仍是日报/周报/月报 + 三格合计 +
   结论 + 机队表 + 导出分享；
3. 电梯 `设备信息` 弹层照常打开（副标题、档案字段、实时工况两段都在）；
4. 首页「材料堆场 → 智能电梯」入口照常，`智能电梯` 计数仍是 4 台。

> 本轮同样**未跑用例、未截图、未真机**；`npx vue-tsc --noEmit` 与 `vite build` 均通过。

---

## 六点七十九、电梯卡片移除「HH:mm 工况帧」小字（2026-11-25）

现场看四张轿厢卡，只想看四格读数，那行「10:06 工况帧」的脚注要去掉。

### ① 摘掉了什么

| 层 | 位置 | 处理 |
|---|---|---|
| 模板 | `views/sub/DevicePage.vue` 卡片尾部 `<p v-if="c.note" class="dev-note">` | **删除**（连同上方注释） |
| 数据 | 同文件 `Card.note` 字段 / `liftCards` 里的 `note: at ? \`${frameTime(at)} 工况帧\` : ''` | **删除** |
| 工具 | 同文件 `frameTime()`（帧时间 → `HH:mm`） | **删除**（唯一调用点没了） |
| 取值 | `liftCells()` 返回值里的 `at` | **删除**，只返回 `cells` 四格 |
| 样式 | `styles/app.css` 的 `.dev-note` | **删除**（全站只有这一个用处） |
| 用例 | `tests/unit/device-page.spec.ts` 里断言 `.dev-note` 含 `09:59` | 改为断言**不存在** |

### ② 为什么只删展示，不动数据

`EVENT_POST_ATTR` 工况帧本身还要用：四格读数（楼层/高度/人数/载重）就是这一帧的值，
`设备信息` 弹层的「当前状态」也要读它的 `runningState`。所以
`stores/lift.ts`、`utils/lift.ts::LiftAttr`（含 `at`）、`api/lift.ts` 的取数链路
**一行未动** —— 去掉的只是「把 `at` 画到卡面」这一步。

### ③ 连带变化

| 位置 | 改前 | 改后 |
|---|---|---|
| 有读数的轿厢卡（如实测的 1-1、2-2） | 四格下方多一行「HH:mm 工况帧」 | **只有四格** |
| 没读数的轿厢卡 | 本来就没有这行 | 不变 |
| 四张卡高度 | 在线卡比离线卡高一行 | **四张等高** |
| 「设备信息」弹层 | 副标题 / 实时工况两段 | **不变**（仍读同一帧） |

### ④ 验证点

1. 智能电梯 页：四张卡底部都不再有「HH:mm 工况帧」，四格数字照常刷新（10 秒一轮）；
2. 四张卡视觉等高，卡间距与改前一致；
3. 点「设备信息」：弹层里的实时楼层/高度/人数/载重与卡片同一帧，内容不缺；
4. 5G塔机 页与首页各面板不受影响（`.dev-note` 原本只有电梯在用）。

> 本轮同样**未跑用例、未截图、未真机**；`npx vue-tsc --noEmit` 与 `vite build` 均通过。

---

## 六点八十、爬架页标题带楼栋前缀 + 导航栏「更新时间」（2026-11-25）

### ① 改了什么

| 位置 | 改前 | 改后 |
|---|---|---|
| 导航栏标题（`stores/subpage.ts::titleOf` 的 `climb` 分支） | `智能爬架` | **`2#楼-智能爬架`** |
| 导航栏标题下方 | 无 | **`更新时间 yyyy-MM-dd HH:mm:ss`**（仅爬架页） |
| `.nav-title` 结构 | 直接是 navbar 第 2 列 | 包一层 `.nav-mid`（纵向居中：标题 + 副标题） |
| 其余页面 | — | 不变（`navSub` 为空串，`.nav-sub` 不渲染，中栏只剩标题，居中结果与改前一致） |

导航栏高度**没改**：标题（`--fs-17` = 19px）与副标题（`--fs-10` = 12px）两行合计
约 36px，仍在 `.navbar` 的 44px 内容高之内。

### ② 时间从哪来（真实数据，不是渲染时间）

- 数据源是 **CDN 静态 JSON**，不是 REST、不是数据库表、也不是父组件传进来的：
  - 线上：`http://120.26.34.95:9689/CDN/PC/ScaffoldData.json`（`api/config.ts::CDN_ORIGIN`，
    可用 `VITE_CDN_ORIGIN` 覆盖），免登录、无鉴权头；
  - 兜底：站内快照 `public/data/scaffold.json`（`api/scaffold.ts::SCAFFOLD_SNAPSHOT_URL`），
    HTTPS 站点被 mixed content 拦掉时用；
- 报文每行形如
  `{ itemName:'1#机位', lrTilt:'0.25mm', fbTilt:'3.13mm', load:'0.00吨', updateTime:'2026-11-07 14:02:49' }`；
- `utils/scaffold.ts::parseSensors` 逐条解析（单位后缀剥成数字，脏行丢弃），
  `summarize()` 把 38 行里**字典序最大**的 `updateTime` 作为 `summary.updatedAt`
  （定长格式，字典序即时间序，不解析成 `Date`，避免时区偏移）；
- 导航栏读的就是 `stores/scaffold.ts` 的 `summary.updatedAt`，新增
  `utils/scaffold.ts::timeStamp()` 做**严格格式校验**：只认
  `yyyy-MM-dd HH:mm:ss`（容忍分隔符写成 `T`），对不上返回空串 → 页面写「—」。
  绝不把 `2026-11-07 14:02` 这种半截值补成「精确到秒」。

改造前页面里只有 `timeHm()` 的「14:02 更新」（卡片表头那句），本轮没动它；
新增的只是导航栏这行完整时间。

### ③ 落地文件

`src/stores/subpage.ts`（`titleOf` 的 climb 分支）、
`src/utils/scaffold.ts`（新增 `timeStamp()`）、
`src/components/overlays/SubPage.vue`（`.nav-mid` + `navSub` computed，引入
`useScaffoldStore` / `timeStamp` / `DASH`）、
`src/styles/app.css`（新增 `.nav-mid` / `.nav-sub`）、
`tests/unit/scaffold.spec.ts`（`timeStamp` 五个边界）、
`tests/unit/device-page.spec.ts`（爬架页标题与副标题一条用例）。

### ④ 验证点

1. 首页「材料堆场 → 智能爬架」进入：标题「2#楼-智能爬架」，下方一行
   「更新时间 2026-11-07 14:02:49」（秒级，取 CDN 报文里最新的 `updateTime`）；
2. 数据未取到 / 加载中时这行写「更新时间 —」，不写当前时间；
3. 其余子页（5G塔机 / 智能电梯 / 无人机 / 预警…）导航栏与改前完全一致，高度不变；
4. 爬架页的页签（左右倾斜/前后倾斜/载荷）、37/38 表头、机位列表、超限红字全部不变。

> 本轮**未跑用例、未截图、未真机**；`npx vue-tsc --noEmit` 与 `vite build` 均通过。

---

## 六点八十一、塔机作业报表对齐标准版：6 格统计 + 风险三卡 + 分布三图 + 长图导出（2026-11-25）

「5G塔机 → 作业报表」按标准版设计稿重排。**数据一行没换**：仍只有
`getWorkCycleInfoHis`（V2 `CraneWorkCycleRequester`）这一条链路，界面新增的
每一项都由工作循环明细算出，没有第二套接口、没有占位数字。

### ① 版式（自上而下）

| 段 | 内容 | 与设计稿的差异 |
|---|---|---|
| 粒度 | 周报 / 月报 两档胶囊 | **日报 2026-11-25 按现场要求去掉**（`ReportSpan` 仍保留 `'day'`，恢复只改两颗按钮） |
| 周期 | `本周/本月` 预设 + `选日期`（周报周列表 / 月报月网格）+ 区间文案 | 一致 |
| 机组 | 每台（2×2 网格，带塔机小图标，默认第一台） | **「全场」聚合页签按现场要求去掉**；文案按现场：`2#楼-塔机2` / `3#楼-塔机3` / `酒店-塔机4` |
| 数据统计 | 6 格：累计吊次 / 累计吊重 / 峰值载荷 / 平均载荷 / 平均作业时长 / 平均载荷利用率 | 一致 |
| 作业风险分析 | 高峰时段 / 夜间作业 / 超重情况 三卡 | **「分析建议」按要求不出现** |
| 分布可视化 | 总吊次时段分布 / 峰值载荷分布 / 作业时长分布 三张柱状图 | 一致 |
| 机队对比 | —— | **2026-11-25 按现场要求下线**（机组页签已能逐台看，一屏里再摆五行表既挤又重复） |
| 导出 | 「导出分享」 | 行为改为**当前页面长图 → 存相册**（见 ③） |

### ② 每一项数字怎么来（全部可核验）

| 指标 | 口径 |
|---|---|
| 累计吊次 | 区间内工作循环**条数** |
| 累计吊重 | Σ 单次最大吊重（只累加有重量的记录） |
| 峰值载荷 | 单次吊重最大值 |
| 平均载荷 | Σ 吊重 ÷ 有重量的条数 |
| 平均作业时长 | Σ `duration` ÷ 有时长的条数（分钟，一位小数） |
| 平均载荷利用率 | 平均载荷 ÷ 额定 5t × 100%（与实时卡「当前负荷」同一口径，常量 `CRANE_RATED_T`） |
| 时段分布 | 每条循环的 `startTime` 落在 0–23 哪个小时 |
| 载荷分布 | 单次吊重分 7 箱（0.5 t 一档）：0–0.5 / 0.5–1 / 1–1.5 / 1.5–2 / 2–2.5 / 2.5–3 / ≥3 t |
| 时长分布 | 单次时长分 8 箱（2 分钟一档）：0–2 / 2–4 / 4–6 / 6–8 / 8–10 / 10–12 / 12–14 / ≥14 分钟 |
| 夜间作业 | `22,23,0,1,2,3,4,5` 时的条数，占比分母是「有时间戳的条数」 |
| 超重 | 单次吊重 ≥ 额定 5t 的次数（另给单次最大值） |

缺字段的记录**不进对应的箱**（没有时间戳就不知道落在哪个小时），但仍算一次吊次；
平均值的分母是「有该字段的条数」，不是总条数 —— 否则会凭空把均值拉低。

机组切换：进页面默认第一台，6 格 / 三卡 / 三图都只算这一台。选中一台**没取到数**的车时，风险与图表
整块换成「这台机组未取到工作循环数据」，不写「本期无吊次 0 次」
（那会被读成「确实没吊」）。

### ③ 导出分享 = 长图（2026-11-25 现场改定）

- 不再导 `.txt`。点按钮把**当前报表**（当前粒度 + 当前周期 + 当前机组）画成一张
  PNG 长图：头部（项目 / 报表名 / 区间 / 范围）→ 6 格 → 三卡 → 三图 → 页脚
  （与页面同构：页面没有机队表，长图里也没有）。
- 绘制在 `src/utils/reportImage.ts`：canvas 2× 宽度 750，高度按内容算（约 2200px），
  颜色读 `:root` 令牌，字体走系统中文栈。**没有引入 html2canvas 之类的依赖**
  （PWA 预缓存不允许为一张图多背 200KB）。
- 存相册仍只有一条路：`navigator.share({ files })`（iOS「存储图像」/ Android「保存到相册」），
  不支持时回退 `a[download]` 落成 PNG —— 与 `utils/photoHd.ts::savePhoto` 同一口径。
- iOS 的分享面板要求调用时还带用户手势，`canvas.toBlob` 会跨多个 task 把手势耗掉。
  所以数据一变（500ms debounce）就预生成一份文件，点按钮时直接分享已备好的那份；
  没备好就现画（会退回下载）。组件卸载时作废在途任务。

### ④ 落地文件

| 文件 | 改动 |
|---|---|
| `src/utils/craneReport.ts` | 新增 `weekStartOf` / `presetLabel` / `isCurrentPeriod` / `periodText` / `weekOptions` / `monthOptions` / `analyze` / `peakHourText` / `minutesOf` / `percentText` / `sameWeek` / `inRange` |
| `src/stores/craneReport.ts` | 新增 `anchor`（周期锚点）与 `series`（每台原始明细）；`load(units, span, anchor)`；缓存键仍是 `sn|区间` |
| `src/components/ui/ReportPeriod.vue` | **新增**：周期芯片 + 深色日历（日 / 周 / 月三种内容） |
| `src/components/ui/BarChart.vue` | **新增**：纯 SVG 柱状图（模板直出，无 v-html） |
| `src/utils/reportImage.ts` | **新增**：长图绘制 + 存相册/下载 |
| `src/views/sub/DeviceReport.vue` | 重排；新增机组切换、6 格、三卡、三图；去掉「结论」区；导出改长图 |
| `src/data/icons.ts` | 新增 `report-peak` / `report-night` / `report-over` |
| `src/styles/app.css` | 新增 `.report-pick` / `.report-cal*` / `.report-devs` / `.report-part` / `.report-insight` / `.crane-chart` / `.crane-bars` / `.report-none` 等；新增 `--violet-dark` |
| `tests/unit/crane-report.spec.ts` | **新增**：周期口径、周/月选项、分箱与风险判定 |
| `tests/unit/device-page.spec.ts` | 报表两条用例改 6 格 / 机组文案 / 三卡三图 |

### ⑤ 验证点

1. 报表页依次出现：周报/月报两颗胶囊 → `本周` + `11/23–11/29` 芯片 → 区间 → 3 个机组页签（默认第一台高亮）→
   「数据统计」6 格 → 「作业风险分析」三卡（**没有「分析建议」那行字**）→
   「分布可视化」三张图 → 「导出分享」（**没有「机队对比」表**）；
2. 点「选日期」：周报弹该月周列表、月报弹 12 个月网格（未来的周/月灰掉）；
   选中后区间文案与数据一起变；
3. 点另一台机组：6 格与三张图整块切到那一台；
4. 「导出分享」：手机上弹系统分享面板，选「存储图像 / 保存到相册」后相册里能看到长图；
   桌面上直接下载 PNG；长图里的数字与当前页面一致；
5. 5G塔机「设备实时状态」页与智能电梯页不受影响。

> 本轮**未跑用例、未截图、未真机**；`npx vue-tsc --noEmit` 与 `vite build` 均通过
> （precache 897.93 → 920.31 KiB）。

---

## 六点八十二、报表柱状图：横轴标签去前导 0 + 抽稀，点柱子看读数（2026-11-25）

### ① 横轴（截图里那条黑边）

现场截图「总吊次时段分布」的横轴是 `000102030405…2223` 连成一片。两个原因叠在一起：

| 原因 | 数字 |
|---|---|
| 24 个小时桶**全部**画标签 | 绘图区 304 单位 ÷ 24 = 12.7 单位一格 |
| 标签是两位（`00`…`09`） | `00` 在 `--fs-9`（11px）下约 12 单位宽 |

一格 12.7、字宽 12 —— 每个标签都把隔壁挤满。现在两层处理：

1. **去前导 0**（`utils/craneReport.ts::axisLabel`）：`01` → `1`、`09` → `9`、
   `10` 及以上原样；非纯数字的标签（载荷 `0–1`、时长 `<1`、`≥5`）原样返回，
   不给 `Number()` 拆坏；
2. **抽稀**（`axisStep`）：≥20 格每 2 格标一个 → `0 2 4 6 8 10 12 14 16 18 20 22`
   共 12 个，每个标签占 25 单位，读得清也不压隔壁；6 格的分箱（载荷 / 时长）
   全部标出。

柱子一根不少（24 根照画），动的是刻度文字，不是数据、不是分箱、不是颜色。
判定只看**格数**不看像素，所以页面（窄屏）与长图（750px）用同一套步长 ——
导出的图与看到的图刻度一致。

### ② 点柱子看读数

横轴抽稀后，没被标出来的那 12 个小时没有文字可看，于是每根柱子都能点：

- 点一下 → 绘图区顶部弹出一个小标签写 **`9时 · 22次`**，该柱描一道亮边；
- 再点同一根收起；点柱子上方的空白也收起（那一片不接管点击）；
- 每根柱子从柱顶到基线铺一块透明命中区（最矮 24 单位），所以 **0 次的那一列
  柱高为 0、看不见，也点得到**，读到的是 `0时 · 0次`，不是没反应；
- 换机组 / 换周期时 `bins` 是新的数组，读数自动收起（`watch(props.bins)`）。

读数文字的单位后缀由页面给（`unit` 属性）：时段 `时`、载荷 `t`、时长 `分`，
所以三张图都能点，标签分别是 `9时 · 22次` / `4–5t · 6次` / `2–3分 · 5次`。

没有引入任何依赖，也没有 `v-html`：标签是一个 `<rect>` + 一个 `<text>`，
宽度按码位估算（CJK 1 字宽、其余 0.56）后夹在绘图区内，最左（0 时）与最右
（22 时）那两根不会顶出画布。柱顶离标签太近（高柱子）时不画导向虚线 ——
那条线会从柱顶的次数文字中间穿过。

### ③ 落地文件

| 文件 | 改动 |
|---|---|
| `src/utils/craneReport.ts` | 新增 `axisLabel()` / `axisStep()` |
| `src/components/ui/BarChart.vue` | 横轴改用抽稀后的 `ticks`；新增 `unit` 属性、`active` 选中态、读数值 `tip`、透明命中区与空白收起 |
| `src/views/sub/DeviceReport.vue` | 三张图各带 `unit`（时 / t / 分），说明文字补一句「点柱子看…」 |
| `src/utils/reportImage.ts` | 长图横轴用同一套 `axisLabel` / `axisStep` |
| `src/styles/app.css` | 新增 `.crane-bar-void` / `.crane-bar-hit` / `.crane-bar-shapes rect.is-on` / `.crane-tip-*` |
| `tests/unit/crane-report.spec.ts` | `axisLabel` 两条、`axisStep` 一条 |
| `tests/unit/device-page.spec.ts` | 报表用例加：横轴 12 个刻度且无前导 0；24 列命中区；点 9 时出「9时 · 2次」、再点收起 |

### ④ 验证点

1. 「总吊次时段分布」横轴是 `0 2 4 6 8 10 12 14 16 18 20 22`，无前导 0、不重叠；
2. 点任一根柱子（含 0 次的那种空列）：顶部出现「N时 · X次」，该柱有亮边；
   再点一次或点柱子上方空白收起；
3. 「峰值载荷分布」「作业时长分布」同样能点，标签是 `0–1t · 126次` 这种；
4. 换机组页签 / 换周期后读数自动收起，不残留上一台车的数字；
5. 「导出分享」的长图横轴刻度与页面一致（12 个、无前导 0）。

> 本轮**未跑用例、未截图、未真机**；`npx vue-tsc --noEmit` 与 `vite build` 均通过。

---

## 六点八十三、峰值载荷分布改 0.5t 一档（7 个区间，左闭右开）（2026-11-25）

现场截图要求把「峰值载荷分布」的 x 轴从 `0–1 / 1–2 / 2–3 / 3–4 / 4–5 / ≥5`
六箱改成：

```
[0,0.5)  [0.5,1)  [1,1.5)  [1.5,2)  [2,2.5)  [2.5,3)  [3,+∞)
0–0.5    0.5–1    1–1.5    1.5–2    2–2.5    2.5–3    ≥3
```

### ① 为什么换成 0.5 一档

原来 1 吨一箱，而现场绝大多数单次吊重落在 0.5–3t，六箱里 `3–4`、`4–5` 常年
是 0、`≥5` 也基本挂零 —— 柱子全挤在左边三根，看不出分布形状。0.5 一档后
前六箱正好覆盖 0–3t 这个主要区间，最后一箱是 3t 及以上的**开区间**（没有上限，
不写 `≥3–∞` 这种半截数学记号）。

### ② 边界归属：统一左闭右开

| 数值 | 落箱 |
|---|---|
| 0 / 0.49 | `[0,0.5)` |
| 0.5 / 0.99 | `[0.5,1)` |
| 1 / 1.49 | `[1,1.5)` |
| 1.5 / 1.99 | `[1.5,2)` |
| 2 / 2.49 | `[2,2.5)` |
| 2.5 / 2.99 | `[2.5,3)` |
| 3 及以上 | `[3,+∞)` |

实现是 `utils/craneReport.ts::loadBinOf`：`w >= 3` 直接进最后一箱，否则
`Math.floor(w / 0.5)`。`0.5` 是二进制精确值，除以它等于乘 2（同样精确），
所以 0.5 / 1 / 1.5 / 2 / 2.5 这些边界值不会因浮点误差掉到前一箱；
负数（脏数据）夹回第 0 箱，不会越界。

同一个数**只会进一个箱**：比如恰好 1.0t 只算 `[1,1.5)`，不会既算 0–1 又算 1–1.5。

### ③ 没有跟着改的东西

| 项 | 口径 | 说明 |
|---|---|---|
| 超重卡「超过额定 5t」 | 单次吊重 `>= CRANE_RATED_T`（5t） | **与分箱无关**，仍是 5t 额定这条线，不是「≥3」 |
| 平均载荷利用率 | 平均吊重 ÷ 5t | 同上，额定值不变 |
| 累计吊重 / 峰值 / 平均载荷 | 明细直算 | 与分箱无关 |
| 图表交互 | 7 根柱子都能点 | 命中区按列铺，0 次的空列也点得到；读数写 `2.5–3t · 1次` |
| 长图 | 同一套 `loads` 数据 | `utils/reportImage.ts` 按 `bins.length` 算柱宽，7 箱自动适配，不需要另改 |

7 格不触发抽稀（`axisStep` 只在 ≥20 格时间隔标），7 个标签全部显示；
页面 340 单位视图里每格约 40 单位、标签 `0.5–1` 约 27 单位，不会互相压。

### ④ 落地文件

| 文件 | 改动 |
|---|---|
| `src/utils/craneReport.ts` | `LOAD_LABELS` 换 7 个标签、新增 `LOAD_STEP_T = 0.5`、`loadBinOf` 改 0.5 一档左闭右开 |
| `tests/unit/crane-report.spec.ts` | 分箱预期改 7 箱；新增边界表（0 / 0.49 / 0.5 / 0.99 / 1 / 1.5 / 2 / 2.5 / 2.99 / 3 / 12.5）；`axisLabel` / `axisStep` 用例跟着换标签 |
| `tests/unit/device-page.spec.ts` | 报表用例加：载荷图 7 个刻度文字、7 列命中区、点 `2.5–3` 出 `2.5–3t · 1次` |

`DeviceReport.vue` 的说明文字（「按单次吊次的最大吊重分箱，单位 t」）本来就
不带箱边界，不用改；样式、结构、交互一行未动。

### ⑤ 验证点

1. 「峰值载荷分布」横轴依次是 `0–0.5 0.5–1 1–1.5 1.5–2 2–2.5 2.5–3 ≥3`，七个标签不重叠；
2. 每根柱子（含 0 次的）都能点，读数如 `2.5–3t · 12次`、`≥3t · 0次`；
3. 七箱次数之和 = 有重量的吊次条数（与「累计吊次」在有重量时的差只来自缺 `weight` 的记录）；
4. 超重卡仍按额定 5t 判（≥3t 不等于超重），利用率分母仍是 5t；
5. 「导出分享」长图里载荷图的七根柱子与刻度与页面一致。

> 本轮**未跑用例、未截图、未真机**；`npx vue-tsc --noEmit` 与 `vite build` 均通过
> （precache 919.48 KiB）。

---

## 六点八十四、作业时长分布改 2 分钟一档（8 个区间，左闭右开）（2026-11-25）

现场截图要求把「作业时长分布」的 x 轴从
`<1 / 1–2 / 2–3 / 3–5 / 5–10 / ≥10`（六箱、档距 1/1/1/2/5/开区间）改成等距 2 分钟：

```
[0,2)  [2,4)  [4,6)  [6,8)  [8,10)  [10,12)  [12,14)  [14,+∞)
0–2    2–4    4–6    6–8    8–10    10–12    12–14    ≥14
```

### ① 为什么换成 2 分钟一档

原档距不齐：`1 / 1 / 1 / 2 / 5 / 开`，`5–10` 一箱顶五档，而现场单次吊次普遍在
1–4 分钟 —— 数据全堆在左边两箱，`5–10` 只剩零头，形状不可读。统一 2 分钟
一档后八箱覆盖 0–14 分钟，中段也能看出层次；最后一箱是 14 分钟及以上的开区间。

### ② 边界归属：左闭右开

| 数值 | 落箱 |
|---|---|
| 0s / 119s | `[0,2)` |
| 120s（2 分）/ 239s | `[2,4)` |
| 240s（4 分） | `[4,6)` |
| 360s / 480s / 600s | 依次进 `[6,8)` / `[8,10)` / `[10,12)` |
| 720s（12 分）/ 839s | `[12,14)` |
| 840s（14 分）及以上 | `[14,+∞)` |

实现是 `utils/craneReport.ts::durBinOf`：`sec >= 840` 直接进最后一箱，否则
`Math.floor(sec / 120)`。**全程按秒算**（120 与 840 都是精确整数），不走
「先除 60 得分钟、再除 2」那条路 —— 后者在恰好 2 / 4 / 6… 分钟这类边界上
容易因浮点误差掉到前一箱。负数（脏数据）夹回第 0 箱。

同一个数**只进一个箱**：恰好 2 分钟只算 `[2,4)`，不会既算 `0–2` 又算 `2–4`。

### ③ 没有跟着改的东西

| 项 | 说明 |
|---|---|
| 数据源 | 仍是 `getWorkCycleInfoHis` 的 `duration`（秒），未换算、未补值 |
| 「平均作业时长」6 格 | 仍按 `Σduration ÷ 有时长的条数` 算，与分箱无关 |
| 载荷分箱（0.5t 一档 7 箱）| 上一节刚改，未动 |
| 夜间 / 超重 / 利用率 | 未动（超重仍 ≥ 额定 5t） |
| 交互 | 8 根柱子都能点（含 0 次的空列），读数如 `2–4分 · 12次` |
| 长图 | 同一份 `durs` 数据，`reportImage.ts` 按 `bins.length` 算柱宽，8 箱自动适配 |

8 格仍不触发抽稀（`axisStep` 只在 ≥20 格时间隔标），8 个标签全部显示：
页面 340 单位视图里每格约 34.5 单位、相邻标签中心距 38.5 单位，最长的
`10–12` 约 32 单位，不重叠。

### ④ 落地文件

| 文件 | 改动 |
|---|---|
| `src/utils/craneReport.ts` | `DUR_LABELS` 换 8 个标签、新增 `DUR_STEP_SEC = 120`、`durBinOf` 改 2 分钟一档左闭右开 |
| `tests/unit/crane-report.spec.ts` | 分箱预期改 8 箱；新增时长边界表（0/119/120/239/240/360/480/600/720/839/840/5400s）；`axisLabel` 用例换 `12–14`/`≥14`；`axisStep` 加 8 |
| `tests/unit/device-page.spec.ts` | 报表用例加：时长图 8 个刻度文字、8 列命中区、点 `2–4` 出 `2–4分 · 2次` |

`DeviceReport.vue` 的说明文字不带箱边界，未改；结构、样式、其余图表一行未动。

### ⑤ 验证点

1. 「作业时长分布」横轴依次是 `0–2 2–4 4–6 6–8 8–10 10–12 12–14 ≥14`，八个标签不重叠；
2. 每根柱子（含 0 次的）都能点，读数如 `10–12分 · 3次`、`≥14分 · 0次`；
3. 八箱次数之和 = 有时长的吊次条数（`<1` 那箱已经并入 `0–2`）；
4. 「平均作业时长」与其余 5 格数字不变；
5. 「导出分享」长图里时长图八根柱与刻度与页面一致。

> 本轮**未跑用例、未截图、未真机**；`npx vue-tsc --noEmit` 与 `vite build` 均通过
> （precache 919.54 KiB）。

---

## 六点八十五、报表读数标签：贴柱显示 + 实底置顶，不再被柱子与数字吃掉（2026-11-25）

现场截图反馈：点柱子后弹出的读数（`≥5t · 0次` 那一类）压在柱子上，字被柱色与
柱顶次数数字干扰，看不清。三张图（时段 / 载荷 / 时长）共用 `components/ui/BarChart.vue`，
所以一处改完全部生效。

### ① 两个原因

| 原因 | 表现 |
|---|---|
| 底色是 12% 透明白（`rgba(255,255,255,.12)`） | 柱子与柱顶数字从标签里透出来，文字与柱色混成一片 |
| 纵向固定在绘图区顶部（`y = PT + 2`） | 高柱子从顶部起，标签正好压在它的柱顶数值上；同一根柱的次数既在柱顶、又在标签里，还互相遮 |

### ② 改法（只动位置与层级）

**位置**——标签跟着选中柱走，不再固定顶部：

1. 优先贴**柱顶上方**，净距 `TIP_GAP = 16` 单位。柱顶次数文字是 `--fs-9`（11px），
   基线在柱顶上方 3、字身高约 11，实际占 `柱顶-14 … 柱顶-3` —— 16 的净距让标签
   底边正好落在文字上方（取 6 会盖住字的上半截，剩半截露着更难看）；
2. 顶部放不下（柱顶已贴近绘图区上沿）改贴**柱顶下方**，压在柱身上：柱身是纯色块，
   盖住不丢信息，柱顶那个次数仍在标签上方露着；
3. 纵向再夹一次，标签整块不进基线、不压横轴标签；
4. 横向不变：以柱心居中、夹进绘图区，最左（0 时）与最右（23 时）都不越界。

**层级**——标签画在柱子、柱顶数值、横轴标签**之后**（最上层），底色换成实底
`--bg-4`（#1B2C44，卡片 `--bg-3` 之上的一层）+ 22% 白描边 + `drop-shadow` 投影；
`pointer-events: none`，标签本身不拦点击（点它下面的柱列照旧切换/收起）。

原先的虚线导向线（`.crane-tip-line`）随「标签贴柱」一并去掉 —— 标签现在紧贴柱子，
再画线只是噪音。

### ③ 没动的东西

| 项 | 状态 |
|---|---|
| 点击逻辑 | 点柱子选中、再点同一根收起、点空白收起、换机组/周期自动收起 —— 全不变 |
| 三张图的数据 | 不变（同一份 `bins`） |
| 标签文案 | 不变：`9时 · 22次` / `2.5–3t · 12次` / `2–4分 · 49次` |
| 字号与配色 | 字号仍是 `--fs-9`；柱色、网格、横轴刻度不变 |
| 长图 | `reportImage.ts` 不画读数标签，无需改 |

### ④ 不同尺寸下为什么不遮挡

`<svg viewBox="0 0 340 168">` 等比缩放，坐标与屏幕宽度无关：同一份几何在 375、
414、768 宽的屏上只缩放不重排，`x` 已夹在 `[PL, W-PR-w]`、`y` 夹在
`[PT+2, 基线-TIP_H-2]`，所以在任何宽度下标签都在绘图区内、不会被卡片裁掉。

### ⑤ 落地文件

| 文件 | 改动 |
|---|---|
| `src/components/ui/BarChart.vue` | `tip` 计算改成「贴柱顶上方 / 放不下折到柱顶下方」+ 纵向夹取；新增 `TIP_GAP`；模板去掉导向线 |
| `src/styles/app.css` | `.crane-tip` 加 `pointer-events:none` 与投影；`.crane-tip-bg` 半透明白 → 实底 `--bg-4` + 22% 描边；文字 650 → 700；删 `.crane-tip-line` |
| `tests/unit/device-page.spec.ts` | 报表用例加：标签整块在绘图区内（x∈[28, 332]、y+20≤142，否则贴边被裁）、`.crane-tip` 在 `.crane-bar-shapes` 之后（层级在柱子之上） |

### ⑥ 验证点

1. 点任一根柱子（三张图都试）：标签紧贴那根柱的柱顶上方，框内文字完整清晰，
   柱子颜色不透出来；
2. 点最高的那根柱（如载荷 190）：标签折到柱顶下方、压在柱身上，柱顶的 `190`
   仍然完整露着；
3. 点最左（0 时）与最右的柱子：标签自动内收，不出画、不被卡片裁；
4. 再点同一根收起、点空白收起、换机组/周期自动收起，与改前一致；
5. 横屏 / 平板 / 分屏等不同宽度下位置关系不变（等比缩放）。

> 本轮**未跑用例、未截图、未真机**；`npx vue-tsc --noEmit` 与 `vite build` 均通过
> （precache 919.39 KiB）。

## 六点八十六、「导出分享」补齐桌面与微信内两条路（2026-11-25）

按钮一直是「当前报表画成一张长图」，但交付只看一种能力（`photoHd.canShareFiles()`
要求 `pointer: coarse`），于是**桌面书签打开只能落文件**、**微信内置浏览器里点了没反应**。
本轮把三个入口分清，并顺手修掉长图里三处会「吃掉字」的地方。

### ① 三条交付路径

| 环境 | 判定 | 结果 |
|---|---|---|
| 手机系统浏览器（iOS Safari / 安卓 Chrome） | `navigator.canShare({files})` 为真 | 弹系统分享面板，选微信 / 存储图像 / 取消 |
| 桌面书签（Windows / macOS 浏览器） | 同上；桌面多数返回 false | 落 PNG 到下载目录，toast「长图已下载到本机」 |
| 微信内置浏览器（含企业微信、小程序 web-view） | UA `MicroMessenger` | 没有面板也吃不了 `a[download]` → **把图摆到页面上**，提示长按保存 / 转发 |

第三条是新增的兜底（`.report-shot` + `utils/env.ts::isWeChatBrowser()`）。
微信内 iOS 长按图片要有系统菜单，`body` 上全局的 `-webkit-touch-callout: none`
必须在这张图上单开回来，否则「点导出 → 出现一张图 → 长按没反应」。

### ② 四个状态与防重复

| 状态 | 按钮 | 说明 |
|---|---|---|
| `idle` | 导出分享 | 可点 |
| `preparing` | 正在生成长图… | 预生成还没落地时点的那一下，现画 |
| `sharing` | 正在分享… | 系统面板已弹出，等用户选；这段时间**再点无效** |
| 生成失败 | 导出分享 | toast「长图生成失败，请重试」，可原地重试（不清已选周期） |

预生成仍是 `imageKey` 变化后 debounce 500ms，数据一变立刻作废上一张（连微信里那张
降级图一起 revoke，防止把旧数字传出去）。

### ③ 手势：为什么交付要「同步」

`shareReportImage()` 里 `navigator.share()` 在第一个 `await` 之前发出，所以
`onShare()` 在**已有文件**时走 `deliver(file)` 同步路径 —— iOS 只在用户手势的同一次
调用栈里认分享面板。没备好文件时先 `await` 生成，手势多半已过期，`share()` 抛
`NotAllowedError` → 归为 `failed` → 自动退到下载/长按，不会出现「点了没反应」。

### ④ 长图不再吃字（三处）

| 位置 | 原问题 | 改法 |
|---|---|---|
| 页眉右侧机组名 | 与左侧区间同一行、各自绝对定位，`2#楼-智能塔机2` 会压在 `2026-11-10 至 11-16` 上 | 先量区间宽度，剩余宽度给机组名，超了才省略 |
| 风险卡说明 / 图表说明 | `clampText` 一律截断加「…」 | 按宽度逐字折行（最多 3 行），卡片高度随行数加高（`RISK_LINE=27` / `NOTE_LINE=26`）；图的绘图区同步下移 |
| 6 格数字 | 34px 固定，长数字顶满卡片 | 34→30→26→22 逐档降，不截断 |

另加 `MAX_H = 16000` 保护：超限直接抛错提示重试，避免浏览器静默给一张黑图。

### ⑤ 落地文件

| 文件 | 改动 |
|---|---|
| `src/utils/reportImage.ts` | 新增 `planOf()`（折行/降字号/量高）与 `wrapText`/`fitFont`/`textWidth`；`draw` 按 plan 画；页眉限宽；`MAX_H`；导出改为 `canShareFile` / `shareReportImage` / `downloadReportImage`（删 `saveReportImage`） |
| `src/utils/env.ts` | 新增 `isWeChatBrowser(ua?)`（`/MicroMessenger/i`，可注入 UA） |
| `src/views/sub/DeviceReport.vue` | `busy` → `phase`（idle/preparing/sharing）；`onShare`/`prepareThenDeliver`/`deliver`/`fallback`；新增 `.report-shot` 降级面板；toast 改中性文案（不再说「已保存到相册」） |
| `src/styles/app.css` | 新增 `.report-shot` / `.report-shot img`（含 `-webkit-touch-callout: default`）/ `figcaption` |

### ⑥ 验证点

1. 桌面书签打开报表 → 点「导出分享」：下载目录多一张 PNG，toast 写明已下载；
2. 手机 Safari / Chrome → 点：弹系统面板，选「微信」可直接发给好友，选「存储图像」进相册；
3. 面板里点取消 → 回到 idle，不额外下载、不报错；
4. 微信里打开链接 → 点：页面下方出现长图，长按能弹「保存图片 / 发送给朋友」；
5. 连续点两次、或面板开着再点：第二次无效，按钮停在「正在分享…」；
6. 切机组 / 换周期后再点：导出的是新数据（旧图已作废）；
7. 长机组名（`2#楼-智能塔机2`）+ 长区间：页眉不重叠；说明文字完整不出现「…」；
8. 断网 / 接口全 500：按钮不出现（空态），不会导出一张全「—」的图。

> 本轮**未跑用例、未截图、未真机**；`npx vue-tsc --noEmit` 与 `vite build` 均通过
> （precache 921.76 KiB）。

## 六点八十七、首页智控面板撤掉电梯网关提示条（2026-11-25）

现场截图红框指向首页智控面板、设备状态卡下方那条
「电梯物联网网关未恢复，请稍后再试 / 凭证失效，请稍后重试 + 重试」。要求首页不再出现，
但**智能电梯子页面的提示（内容 / 样式 / 显示逻辑）必须完整保留**。

### 范围

| 位置 | 处理 |
|---|---|
| `views/home/EquipPanel.vue` | 删 `<section class="dev-auth">` 整块（文案 + 重试按钮）、`needsRetry` computed、`goRetry()`；留注释说明去处 |
| `views/sub/DevicePage.vue` | **未动**（`.dev-auth` / `.dev-auth.is-warn` 两条提示与 `goRetry` 原样） |
| `styles/app.css` | `.dev-auth*` 样式**保留**（子页面在用） |
| `tests/unit/device-page.spec.ts` | 首页两条用例改为断言「不挂提示条」；子页面三条用例（凭证失效 / 网关未恢复 / 缺反代）原样保留 |

### 不动的部分

`lift.refresh()` / `startLive('equip')` / `stopLive` / `isOnline` / `totalSeconds` 全部照旧 ——
首页电梯卡那几格在凭证失效时依然是「—」（不塞 0），只是不再顶一条横幅解释。

> 只跑了 `npx vue-tsc --noEmit`（通过）；**没跑 `vite build`**，避免打断正在使用的 dev 预构建缓存。

## 六点八十八、作业报表三张图的标题与说明改口径（2026-11-25）

现场截图红框圈了三张柱状图的标题 + 说明，要求一次性换成下面三组（一字不改），
排版位置 / 字号 / 颜色 / 对齐 / 图表交互全部不动：

| 图 | 标题 | 说明 |
|---|---|---|
| 1（蓝） | 吊次时段分布 | 按吊次起始时间分时统计，单位：小时（点击图表查看详情） |
| 2（黄） | 吊重区间分布 | 按单次吊重分段统计，单位：吨（点击图表查看详情） |
| 3（绿） | 作业时长分布 | 按单次作业时长分段统计，单位：分钟（点击图表查看详情） |

### 只动文案，没动的东西

- `charts[].key / unit / bins / tone` 全部原样 —— `unit` 仍是 `时 / t / 分`，
  它是**点柱读数标签**的单位（`5 时`、`3.5 t`、`12 分`），与说明里的
  「小时 / 吨 / 分钟」是两种写法，不需要统一；
- `.report-chart-note` 无 `nowrap`，新文案长度（25～28 字）与旧文案（27～29 字）
  基本持平，折行行为不变；
- `BarChart` 组件、tip、命中区、横轴抽稀一概未改。

### 导出长图的一处连带处理

长图里这三张图会把 `note` 原样画上去，而静态图上「（点击图表查看详情）」没有
任何可点的东西。所以 `imageData` 里给长图传的是**剥掉这句后缀**的说明
（`NOTE_HINT`），页面上的文案保持完整。要改回一字不差只删一行即可。

> 只跑了 `npx vue-tsc --noEmit`（通过），未跑 build（避免打断正在用的 dev 预构建）。

## 六点八十九、机组页签三台排成一行（2026-11-25）

截图红框：`2#楼-塔机2` / `3#楼-塔机3` / `酒店-塔机4` 三颗按钮是 2 列网格，
第三颗独占半行、右侧空一块，看着像漏了一台。要求三颗同一行、等宽、间距合理，
**不动文案 / 图标 / 显示内容**。

### 只改样式

| 选择器 | 原来 | 现在 |
|---|---|---|
| `.report-devs` | `repeat(2, minmax(0,1fr))`，`gap: 8px` | `repeat(3, minmax(0,1fr))`，`gap: 6px` |
| `.report-dev` | `padding: 0 8px`，`gap: 6px` | `padding: 0 6px`，`gap: 5px` |
| `.report-dev svg` | 14×14 | 13×13（`flex: none` 保留） |
| `≤359px` | — | 新增一档：`gap: 5px` / 内边距 `0 4px` / 图标 12×12 / 字号 `--fs-10` |

### 为什么要收内边距

最坏一档是 320 屏：内容宽 ≈288，三等分后每颗 ≈90px 内框，而「图标 + `2#楼-塔机2`」
在 13px 字号下要 ~90px，差几像素就会触发 `.report-dev span` 的 `ellipsis` ——
那就等于改了「显示内容」。收 2px 内边距 + 缩 1px 图标即可放下；360 及以上仍按
`--fs-11`（13px）显示，视觉几乎无差。

机组数多于 3 台时 grid 自动折成第二行，不会压成一条；`role="tablist"`、
`aria-selected`、点选逻辑与 `.report-dev.on` 高亮一概未动。

> 未跑用例、未截图；本轮只改 CSS，`vue-tsc` 无需重跑（也未跑 build，避免打断 dev 预构建）。

## 六点九十、无人机「任务下发」占位卡去掉说明小字（2026-11-25）

截图红框圈的是「任务下发」卡片里 `接入中，敬请期待` 下方那段小字：
「航线下发要走原厂控制台通道，平台没有对应接口；目前只做任务与航线只读，二期接入。」

- `views/sub/UavPage.vue`：删掉 `<p>`，卡片只留 `<b>接入中，敬请期待</b>`；
- `styles/app.css`：同步删掉已无使用者的 `.uav-soon p` 规则（`margin/font-size/line-height/color`），
  `.uav-soon` 与 `.uav-soon b` 原样不动 —— 单行文字仍靠 `text-align: center` 居中，
  上下 18px 内边距保持，删文字后不会留下「半行高的空档」（那 6px 间距写在 `p` 的 `margin-top` 上，
  随 `p` 一起消失）。
- 这块本来就是二期占位（平台无下发端点），删小字不改变能力与门禁：`uav` store 里的条件校验、
  `UavRouteSheet` 的「航线下发需在无人机平台操作」提示、`WorkPage` 的「接入中」toast 全部保留。

> 只跑了 `npx vue-tsc --noEmit`（通过）；未跑用例/未截图/未 build。

## 六点九十一、「导出分享」改为悬浮在视口底部（2026-11-25）

截图红框就是报表末尾那颗按钮。报表有三张柱图，滚到下面看图时按钮早已划出屏幕，
想导出得先滚回底部。要求：固定在视口底部常驻、按钮样式/文案/交互不变、
不遮挡内容、必要时补底部占位、移动端与桌面端都要正常。

### 结构

```
<crane-report>
  …三张图…
  <div class="report-share-bar">   ← 新增：position: fixed 的底栏
    <button class="report-share">导出分享</button>   ← 一字未改
  </div>
  <figure class="report-shot">…</figure>   ← 微信内降级大图仍在文档流末尾
</crane-report>
```

### 三个必须算对的数字

| 项 | 值 | 为什么 |
|---|---|---|
| 左右 padding | `32px` | `.subpage-body` 16 + `.dev-block` 16 二者相加才与三张图边缘对齐；只写 16 会宽出一圈 |
| 底部 padding | `calc(10px + var(--safe-bot))` | `.subpage` 向下多延伸了 `--tabbar-h + --safe-bot` 去盖隐藏的 tabbar，而 fixed 贴的是**视口**底，不自己补就会压住 Home Indicator |
| `.crane-report` 的 `padding-bottom` | `calc(112px + var(--safe-bot))` | 见下 |

### 112 是怎么来的（容易算错的一处）

`subpage-body` 的滚动终点在**屏幕下方**：`.subpage` 底边 = 视口底 + `--tabbar-h(52) + --safe-bot`，
而 body 自己留 `14px + --safe-bot` 内边距。滚动到底时内容底边落在屏幕下
`52 - 14 = 38px` 处（safe-bot 相互抵消）。

所以要补的是「浮层高 `12 + 44 + 10 = 66` + safe-bot」再加这 `38`，合计 `104 + safe-bot`，
取 112 留 8px 余量。**不能只补浮层高度** —— 那样滚到底时最后一张图仍会被吃掉 38px。

占位补在 `.crane-report`（section）而非 `.subpage-body`：只有报表页有这条浮层，
别的子页不该多出空白。微信里那张降级大图在同一 section 内、位于浮层之前，
因此同样获得底部空间，不会被压住一截。

### 交互与层级

- 底栏 `pointer-events: none`、按钮 `pointer-events: auto`：顶部 12px 羽化区不拦截，
  手指从那里起手仍能拖动下面内容；
- `z-index: 41` 只在 `.subpage`(40) 内部生效，整条栏仍低于 `.pop-layer`(45) 与 Toast(50)；
- 按钮的 `:disabled` / `aria-busy` / `busy` 文案（「正在生成长图…」/「正在分享…」）
  与点击逻辑一概未动；骨架态与空态不渲染这颗按钮，也就没有浮层。

> 只跑了 `npx vue-tsc --noEmit`（通过）；未跑用例、未截图、未 build（避免打断 dev 预构建）。

## 六点九十二、生产构建与 H5 服务器部署说明（2026-11-25）

> ⚠️ 本条目里的 `/xycDigitalMap/` 是**当时**的 base；同日随后改为
> `/xycMobileDigitalMap/`，现行口径见六点九十三。下文保留原样，不再回改。

本次按要求跑了一遍真实的生产构建，并把部署口径写成 `docs/deploy-h5.md`。

### 构建结果

`npm run build`（= `vue-tsc --noEmit && vite build`）通过：

- 242 个模块，1.86s；`dist/` 5.8 MB / 61 个文件；
- `assets/index-*.js` 519.6 kB（gzip 182.7）、`mpegts-*.js` 272.4 kB、`index-*.css` 142.2 kB；
- PWA `generateSW`：precache 12 项 / 921.72 KiB，`navigateFallback = /xycDigitalMap/index.html`；
- 打包件 `xyc-digital-map-dist-20261125.zip`（4.8 MB，zip 内直接是 dist 根内容）。

### 产物自检（本地起 `server/serve.mjs --port 8099` 逐个 curl）

`/xycDigitalMap/`、`index.html`、两个 `assets/*`、`sw.js`、`manifest.webmanifest`、
图标、`startup/*.png`、`img/*.webp`、`data/scaffold.json` 全 200 且 MIME 正确；
`/` 302 到 `/xycDigitalMap/`；`/crane-api`、`/iot-api` 打回上游业务错误（说明反代通）；
`/mqtt` 握手 **101 Switching Protocols**（说明桥能直连 1883）。

### 三条部署硬约束（文档里都写了做法）

1. **只能放 `/xycDigitalMap/` 子路径** —— `base` 写死，改根路径要动 4 处并重新构建；
2. **`/crane-api`、`/iot-api`、`/mqtt` 必须由服务端提供** —— 纯静态托管缺这三样，
   塔机报表 / 电梯四格 / 塔机实时分别是「全 —」与「不刷新」，页面不报错；
3. **HTTPS 会让 8081/8084/8085/8088/9689/9092 全部失效**（混合内容）——
   当前现场条件下必须 HTTP 部署，或先给这些服务配 HTTPS / 同域反代再改 `VITE_*` 重建。

另记：`sw.js` 与 `index.html` 必须 `no-cache`（否则 PWA 自动更新永远不生效），
`assets/*` 可 `immutable`，`.webmanifest` 的 MIME 必须是 `application/manifest+json`。

## 六点九十三、base 改为 /xycMobileDigitalMap/（2026-11-25）

原前缀是仓库名派生出来的，现在站点要挂在 `/xycMobileDigitalMap/` 下，改 base
**不是改一个字符串**：manifest 的 `id` / `start_url` / `scope` 与 Workbox 的
`navigateFallback` 都各自写死了同一前缀，漏一处就出怪事（PWA 被当成另一个应用、
桌面多出一个图标；SW 的导航回退 404 白屏）。

### 改到的五处（`vite.config.ts`）

| 位置 | 值 |
|---|---|
| `base` | `/xycMobileDigitalMap/` |
| `manifest.id` | `/xycMobileDigitalMap/` |
| `manifest.start_url` | `/xycMobileDigitalMap/?from=homescreen` |
| `manifest.scope` | `/xycMobileDigitalMap/` |
| `workbox.navigateFallback` | `/xycMobileDigitalMap/index.html` |

### 同源的旧前缀（一并更新）

| 文件 | 改动 |
|---|---|
| `server/serve.mjs` | `--base` 默认值 → `/xycMobileDigitalMap/`（否则自托管时 302 到的路径和产物前缀对不上） |
| `server/mqttBridge.mjs` | 注释示例路径（逻辑按后缀匹配 `/mqtt`，未动） |
| `src/utils/pwa.ts` / `src/views/sub/LoginPage.vue` | 注释里的示例路径（实际走 `BASE_URL`，代码未动） |
| `.github/workflows/deploy.yml` | 站点地址注释，并加一句「Pages 路径由仓库名决定」的提醒 |
| `tests/unit/diag.spec.ts` | 用例里模拟的站点 URL |
| `README.md` / `docs/deploy-h5.md` | dev 地址、Pages 地址、`serve.mjs` 地址、nginx 配置、产物文件名 |

### 构建与产物验证（本次实跑）

`npm run build` 通过：242 模块 / 1.61s；`dist/` 61 个文件；precache 12 项 / 921.88 KiB。

| 产物 | 检查结果 |
|---|---|
| `index.html` | 18 条 `src`/`href` 全部 `/xycMobileDigitalMap/…`，无相对路径 |
| `manifest.webmanifest` | `id`/`start_url`/`scope` 三处均为新前缀 |
| `sw.js` | `createHandlerBoundToURL("/xycMobileDigitalMap/index.html")` |
| 全量 grep | `/xycDigitalMap` 命中 **0** 个文件；`/xycMobileDigitalMap/` 命中 32 次 |

本地 `node server/serve.mjs --port 8099` 逐个 curl：页面 / `index.html` / 两个 `assets/*` /
`sw.js` / `manifest.webmanifest` / 图标 / `startup/*.png` / `img/*.webp` / `data/scaffold.json`
全 200 且 MIME 正确；`/` 302 → `/xycMobileDigitalMap/`；旧路径 `/xycDigitalMap/` 为 404（预期）。

### ⚠️ 部署前提变了

**GitHub Pages 的站点路径由仓库名决定**，不读 `base`。仓库仍叫 `xycDigitalMap` 时，
Pages 上线地址还是 `https://yaoyongcheng.github.io/xycDigitalMap/`，而产物里写的是
`/xycMobileDigitalMap/` —— 会整站 404。要么把仓库改名为 `xycMobileDigitalMap`，
要么按 `docs/deploy-h5.md` 自托管到同名目录，二选一，否则先别发 Pages。

> 构建产物已重新打包为 `xyc-digital-map-dist-20261125.zip`（4.80 MB，旧包同样是旧前缀，已覆盖）。

## 六点九十四、Docker 部署落地（2026-11-25）

把「nginx 反代 + /mqtt 桥」那套说法落成仓库里的四个文件，不再是口头方案。

### 文件与职责

| 文件 | 内容 |
|---|---|
| `Dockerfile` | 多阶段三 target：`builder`（`npm ci` + `npm run build`）、`web`（nginx）、`bridge`（Node） |
| `deploy/nginx.conf.template` | 15 个 location：静态 + 缓存策略 + `/crane-api`、`/iot-api` 两段反代 + `/mqtt` 转发（**六点九十五**改成模板，上游可配） |
| `docker-compose.yml` | `web` + `bridge`；端口 `${WEB_PORT:-8080}:80`、`depends_on: service_healthy`、双健康检查 |
| `.dockerignore` | 排除 `node_modules`/`dist`/`legacy`/`.git`/`docs`/`*.zip`/`/*.png`；**保留 `.env`** |

### 五个不能想当然的点

1. **`web` 和 `bridge` 必须两个容器**。`/crane-api`、`/iot-api` 是普通 POST 反代，nginx 能做；
   但 `/mqtt` 的上游不是现成 WS 服务（厂商 `:8084` 自 2026-11-12 起 502/404），是 Node 用
   TCP 连 1883 再包成 WebSocket。nginx 无法把 TCP broker 变成 WS 端点。
2. **`web` 必须等 `bridge` 健康**。nginx 启动时就要解析 `bridge` 这个域名，解析失败会直接退出
   并反复重启；`depends_on.condition: service_healthy` + `restart: unless-stopped` 双保险。
3. **`add_header` 不继承**：子 location 一旦自己写 `add_header`，server 级的头就全丢。
   所以 server 级刻意不写任何 `add_header`，全部按 location 各自声明（注释里写明了）。
4. **端口映射必须加引号**：YAML 会把未加引号的 `8080:80` 当六十进制数。
5. **`bridge` 也带一份 `dist`**：`serve.mjs` 启动时校验 `<dir>/index.html` 存在，缺了直接
   `exit 1`。顺带它单跑也是完整可用的（静态 + 两段反代 + `/mqtt`）。

### 缓存策略落点

| 路径 | Cache-Control |
|---|---|
| `assets/*`、`workbox-<hash>.js` | `public, max-age=31536000, immutable` |
| `/xycMobileDigitalMap/`（目录）、`index.html`、`sw.js`、`manifest.webmanifest`、SPA 回退 | `no-cache` |
| `img/`、`startup/` | `max-age=2592000`（30 天） |
| 根级图标（png/ico/svg） | `max-age=604800`（7 天） |
| 其余静态 | `max-age=3600` |

SPA 回退单独用 `@xyc_fallback` named location 声明 `no-cache` —— 不能给回退出来的 HTML
套上兜底的 1 小时缓存。

### 验证方式（本机没有 docker / nginx）

本机没有 `docker`、`docker compose`、`nginx` 二进制，WSL 也被安全策略拦，**无法执行
`docker compose config` 与 `nginx -t`**。改用结构化解析做等价校验，共三轮：

1. **结构校验 58 项全通过**：nginx 指令逐条闭合（跨行指令按 `;`/`{` 收尾聚合）、大括号平衡、
   location 清单、三段 `proxy_pass` 目标与尾斜杠、`Upgrade`/`Connection` 头、七处缓存策略、
   MIME、`server` 级无 `add_header`；compose 无 TAB / 缩进 / 引号配对 / 按父级路径判重的键树；
   Dockerfile 阶段与 `COPY` 源存在性；`.dockerignore` 未误排除构建必需项。
2. **负向用例 6 个全被抓住**：删 `/mqtt` 的 `Upgrade`、去掉 `/crane-api` 尾斜杠、把 `sw.js`
   改成可缓存、少一个 `}`、删 `proxy_ssl_server_name`、compose 的 `target` 改成不存在的名字。
   （证明校验器不是放水。）
3. **跨文件一致性 12 项**：`vite base` = Dockerfile `COPY` 目标后缀 = nginx 的 15 处子路径 =
   `serve.mjs` 的 `--base` 默认值 = manifest 的 `id/start_url/scope/navigateFallback` =
   `dist/index.html` 的 18 条引用。

### 仍需在真机上确认的三件事

1. `docker compose config` 与 `docker compose build` 能否通过（尤其 `node:22-alpine` 上
   `npm ci` 装 rolldown 原生 binding；builder 用的是 `bookworm-slim`，bridge 才是 alpine）；
2. 容器内 `nginx -t` 是否通过；
3. `bridge` 容器能否出网到 `115.159.67.12:1883`（`docker compose logs -f bridge` 看是否连上）。

> 本轮**未跑 docker、未跑 vitest、未截图**；改动未提交。

## 六点九十五、反代上游改成发布者可配的模板（2026-11-25）

### 起因

「发布者拿到什么配置才能自己部署」——原来的 `deploy/nginx.conf` 把
`tciccs.cscec3bxjy.cn:30400`、`iot.cscec3b-iti.com`、`bridge:8080` 三处上游**写死在镜像里**，
换环境必须改 nginx 语法再重新构建。发布者不懂 nginx，这条路走不通。

### 做法：nginx 官方 envsubst 模板

`deploy/nginx.conf` → **`deploy/nginx.conf.template`**，三处上游改成占位符：

```nginx
proxy_pass https://${CRANE_UPSTREAM}/;
proxy_ssl_name   ${CRANE_HOST};
proxy_set_header Host ${CRANE_HOST};
proxy_pass https://${IOT_UPSTREAM}/;
proxy_pass http://${MQTT_UPSTREAM};
```

Dockerfile 里 `COPY` 目标同步改成 `/etc/nginx/templates/default.conf.template`。
镜像启动时 `/docker-entrypoint.d/20-envsubst-on-templates.sh` 渲染到
`conf.d/default.conf` 再启动 nginx。

**关键点：渲染后是纯文本，proxy_pass 里不存在变量。** 所以
① 不需要 `resolver`（含变量的 `proxy_pass` 才会退化成运行时 DNS 解析）；
② 域名仍在启动期解析一次，解析不到直接起不来，故障是显式的。

### 五个变量，各带兜底

| 变量 | 默认 | 用途 |
|---|---|---|
| `CRANE_UPSTREAM` | `tciccs.cscec3bxjy.cn:30400` | `proxy_pass`（要 host:port） |
| `CRANE_HOST` | `tciccs.cscec3bxjy.cn` | TLS 的 SNI 与 `Host` 头（**只能纯域名**） |
| `IOT_UPSTREAM` | `iot.cscec3b-iti.com` | 同上 |
| `IOT_HOST` | `iot.cscec3b-iti.com` | 同上 |
| `MQTT_UPSTREAM` | `bridge:8080` | 指向 compose 服务名 |

拆成两个变量是因为 `proxy_ssl_name` / `Host` 带 `:30400` 会被上游拒。默认值写在
`docker-compose.yml` 的 `environment` 里（`${X:-默认}`），**这层兜底不能删**：
渲染时环境里没有该变量，占位符会原样留在配置里，nginx 报 `invalid URL prefix` 直接退出。

### 配置只有一处

`.env`（不是 `.env.local`），因为 compose 只自动读同目录 `.env`，而 Vite 构建时也读它，
两边共用一份。`.env.example` 末尾补了 Docker 段，并写明两类变量的差别：

- `VITE_*` —— 构建期写进 JS，改完必须 `--build`
- `WEB_PORT` / `CRANE_*` / `IOT_*` / `MQTT_*` —— 运行期读，`up -d` 即可

### 新增 `deploy/README.md`

给发布者的一页纸：交付清单、三条命令、配置项表、5 条 `curl` 验收（含 MQTT 的 101）、
故障对照表、三条硬约束、以及「服务器不能联网构建」时的 `docker save` 路径。

### 校验

未跑 docker/nginx（本机没有）。做静态等价校验：
① 占位符只出现在 5 个白名单变量上，`$remote_addr`/`$uri`/`$host`/`$http_upgrade`
等 nginx 小写变量**未加花括号**（envsubst 只换环境里存在的名字，小写不受影响）；
② `template` / `compose.environment` / `.env.example` 三处变量名逐字一致，无遗漏无多余；
③ Dockerfile `COPY` 源存在（`deploy/nginx.conf.template`）、旧文件名无残留引用；
④ 渲染模拟：用默认值手工替换后，三条 `proxy_pass` 均为合法绝对 URL。

> 需真机确认：`docker compose up -d --build` 启动后 `conf.d/default.conf` 是否已渲染、
> 容器内 `nginx -t`、以及三条 `curl` 的实际状态码。

## 六点九十六、`queryEvent` 的 400 与「电梯参数对齐 V2」修正（2026-11-26）

### 1. 400 的真实成因（curl 实测，不是反代也不是令牌）

`POST https://iot.cscec3b-iti.com/api/data/v1/tsdb/queryEvent` 这个端点**业务失败也回
HTTP 400**，且 `status` 恒为 10 —— 单看状态码分不清是参数错、设备不认还是产品错，必须看
`msg`：

| HTTP | status | msg | 触发条件 |
|---|---|---|---|
| 200 | 0 | — | 正常（数字毫秒 + 有效 sn） |
| **400** | 10 | `eventItems:待查询事件列表不能为空` | `eventItems` 空/缺 |
| **400** | 10 | `startTime:查询起始时间戳必传` | `startTime` 缺或 `null`（JS 里 `NaN` 经 `JSON.stringify` 就是 `null`） |
| **400** | 10 | `JSON parse error: Cannot deserialize value of type java.lang.Long …` | 时间传字符串（`'yyyy-MM-dd HH:mm:ss'`） |
| **400** | 10 | `endTime大于0时，endTime 必须大于 startTime` | 区间倒置 |
| **400** | 10 | `所选设备您无权操作` | **sn 空串/网关不认**，或 `productCode` 传错产品 |
| 401 | 11 | `权限不足` | 令牌无效 |
| **200** | 2 | `Content-Type错误` | 非 `application/json`（注意不是 4xx） |

**本侧每轮必然产生 2 个 400**：`perSn` 逐台发，`32251222021` / `32251222023` 两台网关
不认（`attr` 每 10s 2 个 + `today` 每 60s 2 个 ≈ 840/小时）。同一无效 sn 走
`queryRealTimeDataV2` 是 **200 空数组**，所以 400 只出现在 `queryEvent`。
V2 侧同样如此（`DeviceSnList` 就是这 4 个串，见下），**属现场设备未注册，不是代码缺陷**。

### 2. 与 V2 的逐项核对（证据：`.workbuddy/tmp/v2dll/HotUpdateScripts.dll`）

| 项 | V2 | 本侧 | 结论 |
|---|---|---|---|
| 换令牌 | `POST https://iot.cscec3b-iti.com/api/webgateway/v1/access/token`，body `{ak,sk}` | 同路径，走 `/iot-api` 反代 | 路径一致；**反代是浏览器 CORS 限制导致的有意差异** |
| 实时数据 | `POST …/api/data/v1/tsdb/queryRealTimeDataV2` | 同 | ✅ |
| 事件 | `POST …/api/data/v1/tsdb/queryEvent` | 同 | ✅ |
| 登出 | `POST …/api/webgateway/v1/auth/api/appUser/logout`（`OnDestroy` 调） | **未实现** | 有意不移植：H5 关页无法保证请求完成，且会让共用同一 ak 的 V2 掉线 |
| 方法 | 全部 POST + `application/json` | 同 | ✅ |
| 鉴权 | `GetAuthHeader()` → `{tokenKey: tokenValue}`，即 `X-APP-USER: <token>`；token 空则**不发请求** | `[tk.tokenKey]: tk.tokenValue`；`requestToken` 拿不到值就抛 | ✅ |
| 事件体 | `QueryEventRequest{startTime, endTime, eventItems}` | 同 | ✅ |
| 事件项 | `EventItems{ProductCode, Sn, EventCode}`（全 string） | `{productCode, sn, eventCode}` | ✅（键名小驼峰，`sn` 为必填键：换 `deviceSn` 实测 400） |
| 实时项 | `QueryListItem{ProductCode, Sn, Field, Code}` | 同 | ✅ |
| 响应 | `IotResponse{status, msg, data}`，`status===0` 成功；行 `{timestamp, metricIndex, uuid, resultMap}` | 同 | ✅ |
| 时间格式 | `long` Unix ms：`start` = 本地当日 0 点，`end` = **现在** | 同类型；`end` 取**当日 23:59:59.999** | 唯一参数差异，**刻意保留**（容忍设备时钟漂移；未来窗口实测不报错），已写进 `dayRange` 注释与用例 |
| sn 来源 | `BuildingElevatorCage.sn` → `RebuildCageCache`（`IsNullOrEmpty` 跳空 + 字典去重，**不 trim**）→ `DeviceSnList` | `data/liftSn.ts` 4 个常量（UnityPy 二次复核逐字节一致） | ✅ |

### 3. 本轮改动（只动电梯事件这条线）

1. `api/iot.ts::EventQueryItem.productCode` **由可选改必填**，`eventBody` 删掉
   `|| SCENE_CODE` 兜底 —— 项目码查电梯换回的是「所选设备您无权操作」，会把配置错误
   伪装成设备故障（实测）。
2. 新增 `usableSn()` / `usableEventItems()`：**空 sn 丢弃、重复 sn 只留第一条**
   （对齐 `RebuildCageCache`），`fetchRealtimeData` / `fetchRealtimeRows` /
   `fetchEvents` / `fetchEventRows` 四个入口统一过一遍；全被滤光就不发请求，直接空态。
3. `iotJson` 上方补错误码对照表（上表），避免再把 400 当网络问题排查。
4. `data/liftSn.ts`：末行「一次查完，不逐台打请求」是 11-13 之前的旧说法，已纠正；
   补 2026-11-26 场景包复核结论与「V2 也会拿到同样 400」。
5. 用例：`iot-weather.spec.ts` 的「缺 productCode 回落项目码」改为「不回落、不发请求」，
   新增「空 sn / 重复 sn 被丢弃」；`lift.spec.ts` 一处 `fetchEventRows` 补 `productCode`。

> 实时侧 `queryList` 的 `productCode || SCENE_CODE` 兜底**保留**（对塔机/大屏成立），
> 只在事件侧收紧 —— 事件目前唯一消费方是电梯。
>
> 验证：`vue-tsc --noEmit` 通过、`npm run build` 通过（`index-aTk95Tdx.js`，precache 922.11 KiB）。
> 未跑 vitest、未开浏览器；改动未提交。

### 4. 那两个 400 已临时屏蔽（2026-11-26，TEMP-BLOCKED）

现场确认这两台轿厢「数据尚未接入」，于是只摘掉**取数**，不摘**展示**：

| 位置 | 改动 |
|---|---|
| `data/liftSn.ts::LiftCage.blocked` | 新增可选字段，`32251222021`（1-2）、`32251222023`（2-1）标 `true` |
| `data/liftSn.ts::LIFT_SNS` | 由 `LIFT_CAGES.map(sn)` 改为 `LIFT_CAGES.filter(c => !c.blocked).map(sn)` |
| `data/liftSn.ts::LIFT_BLOCKED_SNS` | 新增导出，只用于排查时看「谁没在查」，不参与请求 |
| `api/lift.ts` 三处 `perSn` | 各加 `TEMP-BLOCKED` 注释，指明 400 的两个来源是 `EVENT_WORKDATA` / `EVENT_POST_ATTR` 两条 `queryEvent` |

屏蔽的落点是**数据表上的一个字段**，不是散在各处的 `if`：

- 三条线（`queryRealTimeDataV2` 在线 / `queryEvent`+`EVENT_WORKDATA` 今日 /
  `queryEvent`+`EVENT_POST_ATTR` 工况）都读 `LIFT_SNS`，一处改动三处同时生效；
- `LIFT_CAGES` 仍是 4 条 → 电梯子页 4 张卡、首页仍按「x/4」计，那两格照旧「—」；
- 每轮请求数 12 → 6（3 接口 × 2 台），控制台那两条 400 消失；
- **恢复 = 删掉对应那条的 `blocked: true`**，其余代码一行不用动
  （测试断言用的是 `LIFT_SNS.length`，跟着自动变）。

> 恢复前先确认网关侧已注册，否则等于把 400 放回来。
> 验证：`vue-tsc --noEmit` 通过、`npm run build` 通过（`index-DU-7oRNQ.js`，precache 922.19 KiB）。
> 未跑 vitest、未开浏览器；改动未提交。

## 六点九十七、电梯横幅「重试」的重连语义（2026-11-26）

截图那条「电梯物联网网关未恢复，请稍后再试 + 重试」的按钮，之前只是
`void lift.relogin()`：`relogin` 里 `load(true)` 一进来就撞上 `if (inflight) return inflight`，
**把「重连前那一轮」原样复用**，一个请求都没重发；按钮没有加载态，连点会打多轮；
在途的旧请求回来还会把旧数据写回。本轮补齐这四件事。

### 1. 一次「重试」到底做了什么（`stores/lift.ts::relogin`）

顺序不能换，四步对应四个问题：

| 步 | 动作 | 挡的是什么 |
|---|---|---|
| ① | `epoch += 1` | 在途的 `load` / `pollOnce` 回来时对不上代次 → 结果直接丢弃，不许写回 `online/today/attr` |
| ② | `inflight = null` | 否则 `load(true)` 复用旧轮（旧实现在这里等于什么都没做） |
| ③ | `clearToken()` + `clearLiftAuthFailure()` | 缓存令牌、在途令牌请求、失败痕迹一起作废 |
| ④ | `load(true)` | 真发三个接口（在线 / 今日 / 工况） |

`reconnectTask` 单飞：连点只会有一次真实连接，后到的调用复用同一个 Promise。
`reconnecting` 为真期间页面禁用按钮（`goRetry` 里再挡一次，防辅助技术绕过 `disabled`）。

### 2. 「旧连接残留」在三层各挡一次

| 层 | 机制 | 场景 |
|---|---|---|
| 令牌 | `api/iot.ts` 新增 `generation`；`clearToken()` 时 +1，`ensureToken` 的在途请求回来先比对代次，不符就丢弃并抛 `ApiError(0)`，**不写回 `token`** | 重连瞬间还有一次换令牌在飞，回来后把旧令牌写进缓存 → 新一轮见「有令牌未过期」直接复用，点了等于没点 |
| 数据 | `stores/lift.ts` 的 `epoch`，`load` / `pollOnce` 写回前校验 | 旧一轮迟到的空数据把新一轮的结果盖掉（页面「闪一下又变回横杠」） |
| 引用 | `inflight === run` / `if (inflight === run)` 才置 null | 旧轮结束时把**新一轮**的 `inflight` 清掉，导致下一轮叠发 |

### 3. 页面（`views/sub/DevicePage.vue`）

原来两块横幅（`gatewayLost` / `needsRetry`）合成一块，四种＋一种文案：

| 状态 | 文案 | 按钮 |
|---|---|---|
| `reconnecting` | 正在重新连接电梯网关… | 「重连中」，禁用，左侧转圈 `.dev-auth-spin` |
| `gatewayUnreachable` | 电梯网关没连上 —— 部署环境缺「/iot-api」反代，或服务器无法出网 | 「重试」（`is-warn` 警示色） |
| `reconnectFailed` | 电梯网关暂时连不上，请稍后再试 | 「重试」 |
| `gatewayStale` | 电梯物联网网关未恢复，请稍后再试（截图原文） | 「重试」 |
| `authLost` | 电梯物联网网关凭证失效，请稍后重试 | 「重试」 |

- **重连中横幅不撤**：点下去第一件事是清 `authLost`，若只看它，横幅会在点击瞬间消失，屏幕上既没转圈也没说明。
- **失败必留入口**：新增 `reconnectFailed`，专门接「超时 / 5xx / 空响应」这类三种已知原因之外的情况 —— 否则 `authLost` 等全为 false，横幅消失，用户连再点的入口都没有。它在 `load` / `pollOnce` 真拿到数据时自动清掉（轮询自己恢复也会撤），不会长期挂着。
- 模板 `role` 随状态切 `status` / `alert`，重连中带 `aria-busy`。

### 4. 影响面

只动 IOT 令牌与 `stores/lift`：`clearToken()` 只清 `iot.cscec3b-iti.com` 这张令牌，不碰业务 Bearer（`:8081`），
塔机 / 抓拍 / 智眸 / 无人机 / 天气预报 / 台账全部不受影响。电梯卡片仍走 `:8084` 台账，重连期间照常显示（只是格子「—」）。

> 验证：`vue-tsc --noEmit` 通过、`npm run build` 通过（`index-Cqqgk0sI.js`，precache 923.33 KiB）。
> 未跑 vitest、未开浏览器；改动未提交。

## 六点九十八、「设备设施」塔吊调序（2026-11-26）

现场要求：`4#塔吊` 提到设备设施第一位、`2#塔吊` 挪到该组最后，中间两台相对位置不动，
其余两组（材料堆场、出入口管控）一条不动。

### 1. 改动只有一处数组

`data/cams.ts::CAM_POINTS` 的这四条换了位置（`channelId` 与 `name` 逐字不动，只动行序）：

| 位置 | 改前 | 改后 |
|---|---|---|
| 1 | 2#塔吊 `…17` | **4#塔吊 `…16`** |
| 2 | 4#塔吊 `…16` | 地磅全景 `…0003` |
| 3 | 地磅全景 `…0003` | 钢筋加工棚 `…0014` |
| 4 | 钢筋加工棚 `…0014` | **2#塔吊 `…17`** |

组名、组顺序（`CAM_GROUPS`）、芯片样式、分组计数（4 / 1 / 4）都不变；
组件是 `v-for` 直出，没有二次排序，也没有 CSS `order`，所以改数组就等于改页面。

### 2. 唯一的连带效果：默认打开点位变成 4#塔吊

`stores/cam.ts` 的 `camId` 初值是 `CAM_POINTS[0].channelId`，`current` 的回退也是它 ——
按「默认 = 第一个」这条既定规则，打开监控层现在停在 **4#塔吊**（原 2#塔吊）。
没有为「2#塔吊 默认」另写常量：那会让首颗芯片是 4#塔吊、高亮的却是末颗，反而更怪。
顺带一提，`cctv.ts` 里 4#塔吊 2026-11-18 实测 `flv: true`、2#塔吊 `flv: false`，
首屏落在有流的那一路上。

### 3. 没动的两处容易误改

- `CRANE_SHOTS`（智眸设备设施那两张塔吊抓拍）的顺序是**字面量 `['2#塔吊','4#塔吊']`**，
  再按名字去 `CAM_POINTS` 取 channelId，所以**不跟着 CAM_POINTS 变** —— 智眸那边仍是
  2# 在前，本轮保持原样。
- `GATE_SHOTS` 只按名字取通道号，与顺序无关。

### 4. 跟着改的用例（都是断言顺序/默认值的，不改就红）

| 文件 | 改了什么 |
|---|---|
| `tests/unit/stage5.spec.ts` | 9 个点位名数组改成新序；默认点位 `2#塔吊` → `4#塔吊` |
| `tests/unit/stores.spec.ts` | 默认点位同上（注释同步） |
| `tests/unit/cam-player.spec.ts` | 芯片文案数组改成新序；`A`/`B` 注释更新；「切点位」用例点第 2 颗（地磅全景）时索引 2 → 1 |

> 验证：`vue-tsc --noEmit` 通过、`npm run build` 通过。
> 未跑 vitest、未开浏览器；改动未提交。

## 六点九十九、全景横屏提示：文案与位置（2026-11-26）

截图这条「把手机横过来看 / 转不动就关掉系统的『竖屏锁定』」是整屏居中的两行胶囊，
正好压在球面画面的视线焦点上。改成**一句话、贴底边**。

### 1. 文案

| | 改前 | 改后 |
|---|---|---|
| 行数 | 两行（`land-hint-title` + `land-hint-sub`） | 一行 |
| 内容 | `把手机横过来看` / `转不动就关掉系统的「竖屏锁定」` | **`横屏查看，请关闭「竖屏锁定」`** |

`.land-hint-sub` 这条样式随之删掉（全项目只在这里用过）。语义没变：还是
「为什么还竖着 + 关什么」，只是不再先让人竖着读一句废话。

### 2. 位置：从整屏居中改为贴画面底边

`.land-hint`（`components/shell/LandscapeHint.vue` 的外层）：

| 属性 | 改前 | 改后 |
|---|---|---|
| `position` | `absolute` | **`fixed`** |
| `align-items` | `center` | **`flex-end`** |
| `padding` | `0 24px` | **`0 24px 60px`** |
| `justify-content` | `center`（不变） | `center` |

`60px` 是这样算的：`.pano-hint` = 上 padding 18 + 一行 `--fs-11`（13px，行高≈20）
+ 下 padding 8 ≈ **46px**，取 60 → 净间距约 14px，**不压「拖动环视…」那行字**，
也不影响它的位置（`pano-hint` 仍是 `position: absolute; bottom: 0`，一个字没动）。
卡片是浮层、`pointer-events: none`（卡本身 `auto` 只为点击关闭），
**不占布局、不挤压任何文字**，其它交互（4.2s 自动淡、点一下关、转屏即收）全未改。

### 3. 为什么 `fixed` 而不是沿用 `absolute`

铺满时画布是 `.pano-stage.is-land`（`position: fixed; inset: 0`）；卡原先挂在
`.phone-screen` 里按 `absolute` 定位。手机上两者同框，看不出差别；但在大屏 /
平板上手机壳（`.phone` 是 390 宽的居中卡片）比视口矮，卡会落在壳底、比画布底边
高约 40px —— 而说明条是贴画布底边的，两者正好压在一起。祖先链
`.phone` → `.phone-screen` → `.land-hint` 没有任何 `transform`，所以 `fixed` 不会被
包含块改写，卡与画布严格同框。（这也是面板里必须 Teleport 的原因，见 PatrolSheet 注释。）

### 4. 触发范围未变

仍然只有 **智眸 → VR 360 环视 → 项目全景 → 全屏** 一处（`panoLand` 带 `hint: true`），
首页全屏地图 / 监控 / 抓拍大图 / 航拍全景 / 平面照片都不弹。顺带把 5 处
「不再弹『把手机横过来看』」的注释改成「不再弹横屏引导」—— 旧文案已不存在，
留着会让人搜不到。

> 验证：`vue-tsc --noEmit` 通过、`npm run build` 通过（precache 923.21 KiB）。
> 未跑 vitest、未开浏览器；改动未提交。真机待看：竖屏锁定状态下进全景全屏，
> 卡是否贴在「拖动环视 · 双指缩放 · 点『退出』回竖屏」上方、居中、不压字。

## 六点一百、电梯「重试」改为整屏重取：台账 + IOT 三路，全通才撤按钮（2026-11-26）

### 1. 现场现象

电梯详情页点「重试」后，Network 里**只多了一条**
`/iot-api/api/webgateway/v1/access/token`，在线 / 今日作业 / 当前工况一条都没发，
页面依旧四张「—」；而且无论成功与否，横幅与按钮的表现都不对。

### 2. 两条独立的成因（都不是「按钮没接上」）

**① 只重连了 IOT，没重取台账。**
原 `goRetry()` 只调 `lift.relogin()`。而这一屏初始化走的是两条线：
台账 `:8084`（`ledger.load`，提供卡片标题、楼栋归属、「设备信息」入口）
+ IOT 三路（`fetchLiftOnline` / `fetchLiftToday` / `fetchLiftAttr`）。
台账那次失败的话，IOT 刷新成功也还是一屏缺档案的卡片。

**② 三路数据被「废牌自检」短路。**
`api/iot.ts::ensureToken` 有一道自检：换回来的令牌若与被判 401 的那张逐字节相同，
就抛 `IotStaleTokenError`，**6 个数据请求一个都不发**。这正是「只看到 token 请求」
的直接原因 —— 用户主动重试时它不该拦。

### 3. 改动

| 位置 | 改动 |
|---|---|
| `api/iot.ts` | 新增 `releaseStaleGuard()`：只清 `rejectedValue` / `lastAuthFailAt`，放开废牌自检，不动 `token` / `inflight` / `generation` |
| `stores/lift.ts` | 新增 `fullyLoaded`（在线+今日+工况**三路都回**，空表也算回）；`load` 写它；`pollOnce` 只在「三路齐查那一轮（每 6 轮）」都回来时才置真；`relogin` 调 `releaseStaleGuard()`，失败判据由 `state === 'error'` 改为 `!fullyLoaded` |
| `views/sub/DevicePage.vue` | 新增 `loadElevator(force)`（**唯一取数入口**，首屏与重试共用）：台账 + 三路并行；`retrying` / `busy` 覆盖「台账 + 重连」全过程；新增 `retryFailed`（刷新不完整时保住横幅与按钮）；`authText` 区分「台账缺」与「IOT 缺」两条排查线 |
| 空态「重试」 | 电梯也走 `loadElevator(true)`（原先只重取台账） |

**成功判定**：`lift.fullyLoaded && ledgerReady`（台账 `state === 'ok'`，未登录时不计）。
缺任何一路 → `retryFailed` 为真 → 横幅与按钮保留，可反复点。

### 4. 副作用与边界

- `reconnectFailed` 的清除条件同步收紧：以前「拿到一路就清」，会把「还有两格横杠」
  说成已恢复；现在只有三路全通才清。
- `pollOnce` 恢复（60 秒一次三路齐查）也会把 `fullyLoaded` 置真 → 横幅自动消失。
- 废牌自检在**自动自愈**路径（`refreshToken`）上仍然生效，只是用户显式重试时不拦。
- 重试仍只影响电梯：`clearToken` 只动 IOT 令牌，不碰业务 Bearer 与其它模块。

> 验证：`vue-tsc --noEmit` 通过、`npm run build` 通过（precache 923.74 KiB）。
> 未跑 vitest、未开浏览器；改动未提交。真机待看：点「重试」后 Network 应出现
> 1 条 token + 6 条数据（2 台 × 3 路，另 2 台仍临时屏蔽）；三路全通时横幅消失，
> 缺一路时横幅留着且按钮可再点。

## 六点一百零一、电梯「重试」后多出塔机请求：跨机种触发 + 在途未复用（2026-11-26）

### 1. 现象

电梯详情页点「重试」，Network 里除了 `token` / 台账两条 / 电梯 6 条（2 台 × 3 路），
还多出 **3 条 `getWorkCycleInfoHis`**（`towerCrane.ts:241`，即塔机作业报表），
用户读作「重试把塔机也带出来了」。

### 2. 唯一入口

全项目 `getWorkCycleInfoHis` 只有一条链路：

```
DeviceReport.vue  watch(机组 id 串) → report.load()
  → stores/craneReport.ts::load() → api/towerCrane.ts::fetchCraneWorkCycles()
```

`DevicePage.vue` 的 `goRetry()` → `loadElevator(true)` 只碰 `ledger`（台账）与
`lift`（IOT），**没有任何一行调报表**。所以不是「重试调了塔机」，而是报表侧被
两件事触发了：

**① 跨机种的 watch 触发（真问题）。**
`DevicePage` 是塔机/电梯共用的同一个组件实例，两个页签共用一个 `DeviceReport`
（`v-else-if="isCrane"`）。从塔机切到电梯时：`props.kind` 先变 → `set.units`
跟着变成**电梯**机组 → 而 `DeviceReport` 要到同一次 patch 才卸载。watch 的
pre 回调赶在卸载前跑，key 由「塔机 3 个 id」变成「电梯 2 个 id」，**变化即触发**，
于是拿电梯机组又调了一次 `report.load()`。只要 `craneSnOf(楼栋号)` 能解出编号，
就是一轮真实的 `getWorkCycleInfoHis`。

**② 在途未复用（观感放大器）。**
逐台 45s 的 `cache` 只对「已回来」的结果生效。报表页挂载即取数，用户在
「实时状态 ↔ 作业报表」来回切、或点完重试回报表，几十毫秒内就会再叫一次
`load()` —— 上一轮还在飞、`cache` 还没写入，于是同一批 3 条打两遍。

### 3. 改动

| 位置 | 改动 |
|---|---|
| `views/sub/DeviceReport.vue` | 取数 watch 的 key 加机种判断（`props.kind === 'crane'` 才算，否则恒为空串直接 return）；新增 `alive` + `onBeforeUnmount`，卸载后排队中的 flush 一律不再发请求；`picked` 那条 watch 同样加机种守卫（否则会拿电梯机组覆盖塔机选中态） |
| `stores/craneReport.ts` | 新增 `inflightKey` / `inflightRun` 单飞：同一「区间 + 机组组合」在途时直接复用在途那一轮。**判定放在 `++seq` 之前** —— 复用不能再抬序号，否则会把在途那轮判成过期、结果全丢、页面停在骨架屏。`reset()` 一并清空 |

### 4. 为什么不是「重试去重」

重试刷新的是**整份台账**（`:8084` 一次返回塔机 + 电梯），无法只刷电梯。
但台账刷新后 `setLiveUnits('crane', 新数组)` 只换数组引用，`toUnit` 的
`id: String(row.id)` 是稳定的，`units.map(id).join(',')` 不变 → watch 不触发。
所以「台账刷新」本身不会带出塔机请求，只有 ① 那种跨机种瞬间会。

### 5. 边界

- 首次进「作业报表」仍会打 3 条（这是它该做的事），但 45s 内来回切不再重打。
- 切周期 / 选日期必打（区间变了，逐台 key 变化，单飞 key 也不同）。
- 用户主动重试**不会**让已挂载的报表重取：机组 id 串与区间都没变。

> 验证：`vue-tsc --noEmit` 通过、`npm run build` 通过（precache 924.00 KiB）。
> 未跑 vitest、未开浏览器；改动未提交。真机待看：电梯页点「重试」→ Network 里
> 只应有 `token` + `areas` + `deviceInfos` + 6 条电梯请求，**无 `getWorkCycleInfoHis`**；
> 塔机页「实时状态 ↔ 作业报表」连切两次，第二次应命中缓存/在途复用，不再新增请求。

> **更正（2026-11-26 二改）**：上面这一节的结论**只对了一半**。它修的是
> 「跨机种 watch 触发」与「在途未复用」，那两条是真实隐患，但**不是**现场看到的
> 那 3 条请求的来源 —— 电梯页里 `DeviceReport` 本来就已经卸载，那两处守卫对这条
> 完全无效（截图复验仍是 3 条）。真因见下一节。

## 六点一百零二、「重试」带出 3 条塔机请求的真因：台账顺带取塔机日指标（2026-11-26）

### 1. 真因

`stores/deviceLedger.ts::load()` 拿到台账后，会 fire-and-forget 调
`loadCraneDay(list)`，给**每台塔机**打一条 `getWorkCycleInfoHis`
（`stores/deviceLedger.ts:216`，3 台 = 3 条）：

```
DevicePage.goRetry() → loadElevator(true)
  → ledger.load(token, true)                 // :8084 台账，1 条 deviceInfos + 1 条 areas
      → syncLive()
      → void loadCraneDay(list)              // ← 3 条 getWorkCycleInfoHis（fire-and-forget）
  → lift.relogin()                           // IOT：token + 6 条数据
```

这条链路与「作业报表」无关，与 `DeviceReport` 无关，是**台账自己**的附带取数。
它与截图时间线逐条吻合：`deviceInfos` 302~334ms 回来后，3 条塔机请求才发出
（243 / 203 / 222ms），并排在第二个 `token` 之后。

为什么要顺带取：首页智控卡（`equip` 的「今日吊重 / 今日吊次」）与塔机页每张
卡片的今日指标都读它，`loadCraneDay` **一次请求两个口径**（`craneDay` 全场合计、
`craneDayBySn` 逐台），是设计如此，不是 bug。问题只在于：**电梯页一条都用不上，
却照样付这 3 条请求的账**。

### 2. 改动

| 位置 | 改动 |
|---|---|
| `stores/deviceLedger.ts` | `load(token, force, opts)` 新增第三参 `{ craneDay?: boolean }`，缺省 `true`（首页 / 塔机页 / 深链行为不变）；`opts.craneDay === false` 时**不调** `loadCraneDay`。新增 `craneDayAt` 时间戳 + 导出 `ensureCraneDay(maxAge = 5min)`；`loadCraneDay` 发请求前记 `craneDayAt`；`reset()` 一并清 |
| `views/sub/DevicePage.vue` | `loadElevator()` → `ledger.load(token, force, { craneDay: false })`（电梯页永远不需要塔机日指标）；`onMounted` → `{ craneDay: isCrane.value }`；`watch(kind)` 切到 `crane` 时调 `ledger.ensureCraneDay()` 补取 |

### 3. 为什么必须补 `ensureCraneDay`

台账是单例。若只加「跳过」不补：先进电梯页（台账 ok、塔机指标没取）→ 再切塔机页，
`load()` 因 `state === 'ok'` 直接返回 → 塔机卡片今日吊次/吊重整片变「—」，是回归。
所以切到塔机页补一次，用 5 分钟窗口挡住「来回切页反复打 3 条」。

### 4. 边界

- 首页 `EquipPanel` 两处 `ledger.load` / `refresh` 均走缺省 `true`，智控卡数字不受影响。
- 空态「重试」按机种分流：电梯走 `loadElevator(true)`（不带 craneDay），
  其他机种走缺省（要 craneDay）。
- 台账 `inflight` 复用优先级不变：如果首页那一轮正在飞，电梯页 force 会复用它
  —— 那是首页自己的合法请求，不属于「重试带出来」。
- 401（`status:11`）与本改动无关：那是 IOT 网关令牌侧问题，重试能做的只有重换令牌。

> 验证：`vue-tsc --noEmit` 通过、`npm run build` 通过（precache 924.21 KiB）。
> 未跑 vitest、未开浏览器；改动未提交。真机待看：电梯页点「重试」→ Network 只应有
> `token` + `deviceInfos` + `areas` + 6 条电梯请求，**无 `getWorkCycleInfoHis`**；
> 随后切到塔机页 → 应出现 3 条（补取），再切回电梯再切回塔机 → 5 分钟内不再新增。

## 六点一百零六、首次打开「点工作台 → 视频监控」跳回首页：裁剪退穿了根条目（2026-11-27）

### 1. 现象与性质

首次打开首页 → 立刻点「工作台」→ 点「视频监控」→ 页面**跳回首页**。

关键判据：这是**文档级返回 + 整页重载**，不是「覆盖层被关掉」——
`activeTab` 回到 `shell.ts` 的初值 `'home'`，而全仓只有 `TabBar.vue:53` 一处写
`activeTab`，页面里没有任何 `location.reload / href` 调用。所以「回首页」只能
来自「文档重新加载」。

### 2. 三条缺陷叠成一条链

| # | 缺陷 | 位置 |
|---|---|---|
| ① | 裁剪没有下限：只看「条目比层数多」就 `go(-delta)`，退过自己第一条 = 文档级返回 | `sync()` 的 `history.go(-Math.min(delta, MAX_TRIM_DELTA))` |
| ② | 层数会自证清白：`fireBack()` 用 DOM 判断「这层能不能退」，DOM 没提交时必然落空 → 兜底 `setLayer(depth.value)` 往当前条目写一个**比真实条目数更大**的层数 | `fireBack()` + `drive()` |
| ③ | 层数读的是自己写的值：`pushNow()` 按 `history.state.wbLayer` 判断「够不够」，同一帧连开两层时读到滞后值 → 直接 return、不压条目 | `pushNow()` |

链条：③ 让条目数少于层数 → ② 把偏大的层数写进条目 → ① 按它算 delta 并 `go()`
→ 越过根条目 → 文档级返回 → 地址上的 302 重新加载 → `activeTab = 'home'`。

为什么「首次打开 + 立刻操作」才复现：本站 `/xycMobileDigitalMap`（不带尾斜杠）
与 `/` 都会被 **302** 到带尾斜杠版本（`server/serve.mjs:280-284`、
`deploy/nginx.conf.template:68-69`），从外链进站同理 —— 历史里应用条目**之前**
还躺着不属于本文档的条目，才给了「退穿」的空间；同时未登录时挂载即弹登录页，
层数在 80ms 内 0→1→0→1 连跳三次，正好踩在 `scheduleSync` 的窗口上。

### 3. 改动（`src/utils/historyBack.ts`）

| 位置 | 改动 |
|---|---|
| `markRoot()` | 挂载时**把当前条目认定为根**：`owned = 1`，并 `replaceState` 打 `wbRoot` 标记。**不新压条目** |
| `sync()` | `backable = max(0, owned - 1)`；`step = min(delta, MAX_TRIM_DELTA, backable)`；`backable <= 0` 时**不 go**，就地 `setLayer` |
| `pushNow()` | 判据从 `history.state.wbLayer` 换成 `owned`（自己压过的条目数），不再被滞后的 state 骗 |
| `fireBack()` | 返回三态 `done / pending / none`；判据来自 store，DOM 只是「点哪儿」，不是「能不能退」 |
| `drive()` | `pending` → 隔 `BACK_RETRY_MS`(32ms) 重点，最多 `MAX_BACK_RETRIES`(3) 次；`none` → 收口，**兜底不再写 `setLayer(depth)`** |
| `onPop()` ② | 用户退回 `n` 条时把 `owned` 减掉 `n`，否则账偏大、下次裁剪多退 |
| `trim` 验证定时器 | `go` 被吞掉时把 `owned` 还原（`trimLast`），避免越扣越小、条目越积越多 |
| `watch` 升层分支 | 层数「先降后升」时清掉降的那次裁剪状态（`trimTimer` / `trimTries`） |

**为什么不在挂载时多压一条根条目**（分析里曾建议）：那会让首页的第一次浏览器
返回被吞掉（要多按一下才离开站点），是用户可直接感觉到的行为变化。只记账不压
条目同样能挡住越界，且首页返回手感逐帧不变。

### 4. 验证（本轮已实际执行，与以往「只汇报」不同）

`tests/unit/history-back.spec.ts` 新增 3 条用例（均置于「应用条目之前还有一条
外部条目」的栈上）：

| 用例 | 新代码 | 旧代码（HEAD） |
|---|---|---|
| 层数被写大（`wbLayer: 9`）时只退到挂载条目 | 通过（`go(-1)`，cursor 1） | **失败**（`go(-9/-6)` 越界） |
| 返回按钮未渲染时不把层数写进条目 | 通过（无 `go`，条目无 `wbLayer`） | **失败**（`wbLayer: 1`） |
| 未登录 → 工作台 → 视频监控 → 返回一次 → 关监控 | 通过（cursor 1） | **失败**（cursor 0 = 退到本文档之外） |

- 单文件：16 条全通过。
- 全量：新版 25 条失败 / 1267 通过；**HEAD 基线 28 条失败**（同一台机、同一时刻），
  差的正是新增的 3 条。其余失败集中在 `cam-player*` / `device-page` / `patrol` /
  `drone` / `lift` / `guards` / `motion-perf`，改动前就在失败，且每次跑数量抖动，
  与导航无关。
- `vue-tsc --noEmit` 通过；`npm run build` 通过（precache 924.71 KiB）。

### 5. 上机验证清单（真机仍建议走一遍）

| 场景 | 期望 |
|---|---|
| 首次打开（**不带尾斜杠**的地址或外链）→ 工作台 → 视频监控 | 监控层正常打开，不闪首页、不重载 |
| 同上，但先等 1s 再操作 | 同上 |
| 覆盖层里按浏览器返回 / 右滑 | 逐级关闭，语义不变（0.22s 滑出、theme-color 跟随） |
| 首页（无覆盖层）按浏览器返回 | **仍然直接离开站点**（没有多压条目） |
| 子页 → 详情 → 浏览器返回两次 | 先回列表、再回首页，不多退也不少退 |
| 刷新页面 | 不会「跳走 / 重新加载」，顶栏与 tab 保持在首页 |

> 验证：`vue-tsc --noEmit` + `npm run build` 通过（precache 924.71 KiB）；
> `history-back.spec.ts` 16 条通过、全量无新增失败。未开浏览器、改动未提交。

## 六点一百零七、线上「首次点视频监控跳首页」的最后一环：旧壳在内存里不换（2026-11-27 下午）

### 1. 接六点一百零六：修复早就在线上，跑不到而已

六点一百零六改的是「裁剪退穿根条目」，代码侧已闭环。但线上仍复现，且**三个入口
全复现**（桌面 Chrome / iPhone Safari / 主屏书签）、本地 dev 不复现。逐项取证后
定性为**旧壳**（内存里那个已经渲染完的旧文档），不是代码没上线、不是部署错、不是缓存策略错。

| 取证项 | 实测结果 | 结论 |
|---|---|---|
| 线上主包身份 | `index-apDnYpli.js`，把唯一常量差异（CDN 基址 `/xyc-cdn` ↔ `120.26.34.95:9689`）归一化后与本地 `index-CDEZkonC.js` **逐字符相等**（506,544 字符），内含 `owned` 计数器与 `pushNow` 读回校验 | 代码已上线 |
| 部署自洽性 | 线上 `sw.js` 里 `index.html` 的 `revision = a352dcc5821a4887ad999ab8f5a6eb21`，与线上 `index.html` 实际 md5 **完全一致** | 同批构建，不是手工拼装 |
| 旧包残留 | 线上 `sw.js` 预缓存清单里 `index-E_yuS33G.js` 计数 **0**，只有 `index-apDnYpli.js` | 新 SW 已清掉旧壳的燃料 |
| 缓存头 | `index.html` 是 `no-cache`，`assets/*` 是 `immutable` | 配置正确 |
| dev 侧 | `pwa.ts` 里 `if (!import.meta.env.PROD) return` —— **dev 根本不注册 SW** | 本地永远最新源码，故不复现 |

三项合起来：**新 SW 早已接管，只要文档重新加载一次，拿到的必然是新壳**。用户看到
的复现，是「页面从没真正重载过」—— 桌面切 tab、iPhone 切回 Safari、从主屏书签
resume，走的都是**内存恢复（resume）**，不是导航。旧 JS 一直在内存里跑。

### 2. 为什么必须治「不换壳」而不是只治退栈

退栈的加固在**新壳**里，旧壳里没有；而 SW 的 `skipWaiting` + `clientsClaim` 只保证
新 SW 立刻接管，**改变不了当前这个已经渲染完的页面**。于是旧壳能活多久，取决于
用户什么时候手动刷新 —— 现场用户不会刷新，一次会话可以开一整天。

### 3. 改动

| 文件 | 改动 |
|---|---|
| `src/utils/pwa.ts` | 新增 `ReloadBlockers` / `canSilentReload()`（纯函数）/ `setReloadBlockers()`；`controllerchange` 从「只广播」改为三分支：不可见 → 直接刷新；可见且无进行中操作 → 直接刷新；否则 → 只广播给 `UpdateBanner` |
| `src/App.vue` | `onMounted` 注册状态快照读取器（读 store，**不查 DOM**） |
| `src/components/shell/UpdateBanner.vue` | 只改注释：说明触发条件已收窄为「存在进行中的操作」 |
| `tests/unit/pwa-update.spec.ts` | 新增 15 条 |

**阻断项**（任一为真就不自动刷新，改走横幅）：

| 字段 | 判据 | 刷新会丢什么 |
|---|---|---|
| `offHome` | `shell.activeTab !== 'home'` | 无路由，刷新必回 `'home'` —— 等于「又跳回首页」 |
| `subpage` | `sub.isOpen && sub.view.kind !== 'login'` | 子页/详情/工序页的位置 |
| `cam` / `air` / `hazard` | 三个播放器与隐患填报 | 正在播的画面、填了一半的表单 |
| `sheet` | `sheet.isOpen` | 弹层里的选择 |
| `land` | `shell.mapLandOpen` | 全屏与横屏态 |
| `typing` | `document.activeElement` 是输入类 | 输入法里已输入的文字 |

`login` 单独排除：刷新后 `App.vue` 的 `onMounted` 会按 `!isLoggedIn` 自动重新弹出，
观感与没刷一样，而它恰好是「发版后第一次打开」最常见的画面。

**为什么读 store 不读 DOM**：同一帧里「状态已改、DOM 未提交」太常见，用 DOM 反推
会给出错误答案 —— 正是六点一百零六里 `fireBack()` 踩过的坑。

### 4. 边界（必须说清）

这段逻辑**在旧壳里不存在**，所以它救不了「当前正在跑的旧文档」—— 那一次仍需一次
真正的重载（关掉标签页重开 / 下拉刷新 / 主屏书签上滑杀掉再开）。它保证的是**以后每
次发版**：页面在安全窗口内会自己换壳，旧壳不会再长期存活。

### 5. 验证

| 项 | 结果 |
|---|---|
| `canSilentReload` 八个阻断项逐个为真 | 全部返回 false |
| 瞬时不可见 / 可见且安全 | `location.reload()` 各调 1 次 |
| 有进行中的操作 | 不 reload，`xyc:sw-updated` 广播 1 次 |
| 首次安装（注册时无 controller） | 不挂监听，不刷新也不提示 |
| 重复触发 | 只处理一次 |
| 判别力 | 把两条分支临时改回「只广播」，3 条用例如期失败，已还原 |
| 类型与构建 | `vue-tsc --noEmit` + `npm run build` 通过（precache 925.37 KiB，主包 `index-7FDWMh3s.js`） |

> 验证：`pwa-update.spec.ts` 15 条 + `history-back.spec.ts` 17 条共 32 条通过。
> 未开浏览器（SW 换代无法在 happy-dom 里端到端复现，只到单测与产物核对）。改动未提交、未发布。

## 六点一百零八、登录页「记住密码」（2026-11-27）

### 1. 需求与它真正的难点

勾选后：下次打开登录页**仍是勾着的**、账号与口令都填好；取消勾选则一条都不留，
不能出现「没勾却填好了」。**登出与登录失败都不清**（V2 口径，见下）。

表面上是个 UI 开关，实际有两个坑：

- **不能存明文**。现场手机是共用的，一台机器换班上号很常见；Unity 端把账号
  密码明文写进 PlayerPrefs，那套不能沿用。
- **不能存不可解的东西**。降级环境（隐私模式 / 没有 IndexedDB）里若还硬写
  密文，下次解不开 —— 用户看到的就是「勾了但没记住」，比不勾更糟。

### 1.1 与 V2（`UIViewLogin`）的逐条对照

2026-11-27 从 `HotUpdateScripts.dll` 反出 V2 的三个方法，行为很干净：

| V2 | 当前项目 | 状态 |
|---|---|---|
| `CheckLocalLoginState()`：`HasKey(Username) && HasKey(Password)` → `tgRecord.isOn = true` + 两栏回填，否则 `isOn = false` | `onMounted` 里 `loadCredential()`：解出来 → 勾上 + 回填 | ✅ 同 |
| `CheckRecordPassword()`：**只在登录成功后**调用；`isOn` → 写两个 key，否则 `ClearRecordPassword()` | 登录成功分支：勾着 `saveCredential()`，没勾 `clearCredential()` | ✅ 同（本轮把「存账号」改成 `auth.username`，与 `CurLoginModel` 同口径） |
| `ClearRecordPassword()`：`DeleteKey` 两个键 | `clearCredential()`：删密文 + 勾选意愿（**故意不删密钥**） | ✅ 结果同（都解不出东西） |
| 登录失败：只 `loginFailCount++`，**不碰 PlayerPrefs** | 旧版按 `isCredentialRejected()` 清凭据 + 复位勾选 | ❌ → ✅ 本轮改为不动 |
| `LoginOut`：只作废令牌，**不碰 PlayerPrefs** | 旧版 `logout()` 跟手 `clearCredential()` | ❌ → ✅ 本轮改为不动 |
| 口令明文存 `PlayerPrefs` | RSA 密文（密钥 IndexedDB） | 有意保留的安全差异（上一轮要求） |

**那两个 ❌ 就是「效果未达预期」的根因**：用户唯一能验收「记住密码」的路径是
「登录 → 登出 → 再看登录页」，而旧版在这一步自己把凭据删了，于是怎么看都像
没记住。另外错一次密码也清，手滑一下就得重输。

### 2. 存储设计：密文与密钥分开存

| 材料 | 存放位置 | 内容 |
|---|---|---|
| 密文 | `localStorage['xyc.auth.cred']` | `{ v:1, a:账号, c:口令密文 }` |
| 勾选意愿 | `localStorage['xyc.auth.remember']` | `'1'`（见 §3，2026-11-27 补） |
| 密钥 | IndexedDB `xyc-cred` / store `keys` / key `device` | `{ v, publicKey, privateKey }` |

**为什么是 RSA（jsencrypt）不是 AES（`crypto.subtle`）**：`subtle` 只在安全上下文
存在，现场跑的是 `http://115.159.67.12:8080` 与局域网 `http://192.168.x.x:5173`，
`subtle` 直接是 `undefined`（同一个取舍见 `utils/sceneCache.ts` 不用 `subtle.digest`
那一段）。jsencrypt 本来就在包里，纯 JS、不挑协议。做法是本机自签一对 1024 位
密钥（PKCS#1 v1.5 单块上限 117 字节，塞得下任何端口令；实测生成 ~0.09s，2048 位
要 1.5s，登录后卡 1 秒不值得）。

**边界**：同源脚本本就能读 IndexedDB，这挡的是「明文可见 / 顺手被翻到 / 存储被
导出」，挡不住页面里跑的恶意代码。要更强只能后端发 httpOnly Cookie 或系统钥匙串。

**降级**：密钥进不了盘时**不写密文**，只在本会话内存里记着（当次可回填，刷新即
失效），与 `utils/thumbCache.ts` 的口径一致；但勾选意愿照常落盘，否则连勾都会丢。

### 3. 状态一致性：勾选意愿与密码数据分开存

**2026-11-27 修正**。早先的实现用「盘上有没有密文」同时推导勾选态，结果是一条
死路：取消勾选会立即删密文，而重新勾上只预热密钥、**什么都不写**。于是
「取消 → 再勾 → 直接返回」之后，本页看着勾着，盘上早已空 —— 下次进来既不勾
也不回填。用户报的就是这个。

现在两个键各管一件事：

| 键 | 内容 | 谁写 |
|---|---|---|
| `localStorage['xyc.auth.cred']` | `{ v:1, a:账号, c:口令密文 }` | 登录成功 / 用户勾选（表单完整时） |
| `localStorage['xyc.auth.remember']` | `'1'` = 勾选意愿 | 勾选 / `saveCredential` |

打开登录页的判定顺序（`onMounted`）：

1. `loadCredential()` 解出账号口令 → **回填 + 勾上**（此刻不看意愿，数据优先）；
2. 没有数据但 `isRemembered()` 为真（勾了却没登录成功过）→ **勾着、口令留空**；
3. 两者都没有 → 不勾、空表单。

| 时机 | 行为 | 理由 |
|---|---|---|
| 打开登录页 | 见上面三步 | 回填只在用户还没动过表单时做（`seededAccount` 守卫），且用 `hydrating` 抑制 watch，不把「程序勾的」当「用户勾的」 |
| 勾选（表单完整） | `markRemembered(true)` + **立即 `saveCredential()`** | 用户勾上后往往直接返回，不该非得点一次登录；这也让「取消 → 再勾」能把刚删的那组找回来（口令框里还留着） |
| 勾选（表单不全） | `markRemembered(true)` + 预热密钥 | 没有完整一组可存，先把 0.09~0.6s 的密钥生成挪到此处 |
| 取消勾选 | **立即** `clearCredential()`（密文 + 意愿） | 不等提交：关了勾没登录就离开，下次不该又「勾着 + 填好」 |
| 登录成功（勾着） | `await saveCredential()` | 必须 await：用户常登录后立刻划掉应用，写盘没落地就等于没记住 |
| 登录成功（没勾） | `clearCredential()` | 连之前存过的一起清，不留半条 |
| 存不下来（超长/写不进） | 勾选态复位 | 勾选 = 已保存，不能让它骗人（复位会触发 watch 再清一次，两个键一起干净） |
| 登录失败（错口令 / 401 / 400） | **一个字都不动** | 对齐 V2：`CheckRecordPassword` 只在成功分支跑。手滑错一次不该把记好的删掉 |
| 网络不通 / 5xx | 一个字都不动 | 环境问题不是凭据问题，别误删用户记好的口令 |
| 主动登出 | **保留** | 对齐 V2：`LoginOut` 不碰 `PlayerPrefs`。共用手机的顾虑改由「用户主动取消勾选」兜底 |
| 会话过期（`expire()`） | **保留** | 隔天再打开自动填好，正是「记住密码」要服务的场景 |
| 读取时密钥打不开（IDB 故障/超时） | 只本次读不回，**不删密文、不删意愿** | 临时打不开 ≠ 永久失效；`openDb` 也不再缓存失败，下次还会重试 |
| 密钥在手却解不开 | 清密文 + 清意愿 | 密钥真换了或密文损坏，留着只会每次白试 |
| **`clearCredential()` 不删密钥** | 只删密文与意愿 | ①密钥不含用户信息，没有密文解不出任何东西；②删了下次勾选要重新生成；③删除是异步的，用户「取消 → 马上重勾」时迟到的 delete 会干掉刚重建的那对 —— 内存以为落了盘、冷启动却解不开 |

> **与 V2 的两处有意偏离**（都是这一轮补的，也都有代价）：
> ① V2 没有「勾选即保存」，只有登录成功才写；不这么做，「取消 → 再勾 → 返回」
> 必然丢数据。② V2 的取消勾选不动数据（下次冷启动又复活），本项目取消即真删 ——
> 遵循之前「避免不符合预期地自动回填」的要求。
>
> **还没对齐的一条**：V2 的 `OnReturnToLogin` 会把两栏清空、`isOn = false`
> （登出回到登录页时是空表单），但下次冷启动 `CheckLocalLoginState` 又会回填。
> 本项目每次打开登录页都是新挂载（等价于 V2 的 Start），所以登出后直接回填 ——
> 更符合「记住密码」的直觉，不模拟 V2 那个中间态。

### 4. 验证

| 项 | 结果 |
|---|---|
| 密文不含明文 / 能解回 | `credential-vault.spec.ts` 11 条 |
| 降级路径不写密文 | 同上，先看盘再读回 |
| 读失败不销毁密文 | 同上，`密钥拿不到时` 一条 |
| 意愿与数据同生共死 / 只勾未登录 | 同上，两条 |
| 落盘路径 + 「关掉页面再进来」 | `credential-vault-idb.spec.ts` 6 条（fake-indexeddb + `vi.resetModules()` 模拟冷启动） |
| 清除后密钥仍在（直接读 IDB 比公钥） | 同上，`清除只删密文` 一条 |
| 页面决定（回填 / 勾选即存 / 取消即清 / 失败不动 / 登出不动 / 意愿还原） | `login-remember.spec.ts` 11 条 |
| 判别力 | ① 去掉「没勾就清」② 降级分支改成写明文 ③ 不读盘上密钥 ④ 失败时 `remember=false` ⑤ 登出时清凭据 ⑥ 不看 `isRemembered` ⑦ 勾选只预热不保存 —— 七次临时退化，对应用例如期失败，已还原 |
| 类型与构建 | `vue-tsc --noEmit` 通过；precache 929.11 KiB、主包 `index-D7Jy-IyF.js` |

> 相关单测共 59 条（`credential-vault` 11 + `-idb` 6 + `login-remember` 11 + `auth` 18 +
> `auth-guard` 7 + `tokens` 6）全部通过。`fake-indexeddb` 仅测试用，不进产物。
> 未开真机：iOS「划掉应用再进」「刷新」「登出后再进」只能靠单测模拟，真机仍需复测。
> 改动未提交、未发布。
