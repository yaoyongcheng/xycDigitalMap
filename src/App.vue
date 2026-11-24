<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch, watchEffect } from 'vue'

import { useAirHazardStore } from '@/stores/airHazard'
import { useAuthStore } from '@/stores/auth'
import { useCamStore } from '@/stores/cam'
import { useDroneAlarmStore } from '@/stores/droneAlarm'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { setThemeColor, THEME_COLORS } from '@/utils/themeColor'
import { onFullscreenExit, settleViewport } from '@/utils/orientation'
import { useHistoryBack } from '@/utils/historyBack'
import { useSwipeBack } from '@/utils/swipeBack'
import StatusBar from '@/components/shell/StatusBar.vue'
import NavBar from '@/components/shell/NavBar.vue'
import TabBar from '@/components/shell/TabBar.vue'
import Toast from '@/components/shell/Toast.vue'
import UpdateBanner from '@/components/shell/UpdateBanner.vue'
import LandscapeHint from '@/components/shell/LandscapeHint.vue'
import MapLand from '@/components/overlays/MapLand.vue'
import CamPlayer from '@/components/overlays/CamPlayer.vue'
import AirPlayer from '@/components/overlays/AirPlayer.vue'
import HazardPage from '@/components/overlays/HazardPage.vue'
import SubPage from '@/components/overlays/SubPage.vue'
import SheetHost from '@/components/overlays/SheetHost.vue'
import HomePage from '@/views/HomePage.vue'
import WorkPage from '@/views/WorkPage.vue'
import MsgPage from '@/views/MsgPage.vue'
import MinePage from '@/views/MinePage.vue'

/**
 * 应用外壳
 *
 * 对应原 index.html:11-350 的三层壳结构：
 *   .stage > .phone > .phone-screen
 *
 * 结构要点：
 *   - .phone-screen 的直接子元素顺序：status-bar → 4 个覆盖层 → .app → .toast
 *     status-bar 仅剩底色条（模拟的时间/信号内容已移除），但必须保留：
 *     它承担 32px 顶部留白，且底色随视图切换（首页透明 / 全屏层白底 /
 *     横屏黑底），规则见 app.css 的 5 组 .phone-screen:has(...) 选择器
 *   - 4 个覆盖层与 .subpage 常驻 DOM，靠 .open class 切换显隐。
 *     注：移除状态栏前，其 5 组 :has() 深浅色联动规则强制覆盖层必须常驻；
 *     移除后仅剩 3 条作用于 .subpage.open 的 :has() 规则
 *     （app.css:4333/4338/4339，使抽屉打开时标签栏变灰），其匹配条件在
 *     v-if 下依然成立，故不再构成阻碍。若真要改用 v-if，需重新评估
 *     .phone.is-landscape 相关规则（原 app.css:3124-3216）。
 *   - .app.home-mode 由当前 tab 决定（原 app.js:66）
 */
const shell = useShellStore()
const cam = useCamStore()
const air = useAirHazardStore()
const sub = useSubpageStore()
const auth = useAuthStore()
const droneAlarm = useDroneAlarmStore()

/** 全局右滑返回手势（微信式）：见 utils/swipeBack.ts 的约束说明 */
useSwipeBack()

/**
 * 接管浏览器 / 系统导航的返回（2026-11）。
 *
 * 手机上的边缘侧滑是浏览器级手势，页面拦不住 —— 不接管时右滑会直接退出当前
 * 地址，用户以为「应用内返回没生效」。这里让返回落到同一套返回动作上。
 */
useHistoryBack()

/**
 * 启动时检查登录态（2026-11 新增）。
 *
 * 全站数据都来自需要鉴权的接口：未登录时首页只有空态，用户看不出「为什么
 * 什么都没有」。所以启动即把登录页摆出来并写明原因，而不是等他自己翻到
 * 「我的」去找入口。会话已过期的情况在 `restore()` 里就被丢掉了，同样落到
 * 这里；请求过程中才失效的 401 由 auth store 的 `expire()` 处理。
 *
 * 用户仍可关掉登录页浏览界面（登录页与其它子页一样有返回）。
 */
onMounted(() => {
  if (!auth.isLoggedIn) sub.openLogin('当前未登录，请先登录后查看现场数据')
  else void droneAlarm.load()
})

/**
 * 系统侧退出全屏（Android 返回键 / 桌面 Esc / 系统手势）时把「横屏态」收回来。
 *
 * 全屏是页面自己申请的（`utils/orientation.ts`），退出却可能是系统干的：
 * 不收的话 `isLandscape` 还停在 true，页面留在横屏版式里、屏幕已经转回竖的，
 * 直接错位。全屏地图走「收层」（`closeMapLand` 顺带解锁方向），
 * 监控只收横屏态、播放器本身留着。
 */
let offFullscreenExit: (() => void) | null = null

onMounted(() => {
  offFullscreenExit = onFullscreenExit(() => {
    /*
     * 先落定视口，再收状态（2026-11-23）。
     *
     * 系统方式退出全屏时，尺寸已经变了但页面还没意识到：iOS 会留下几十 px 的
     * scrollY，`dvh` / `env(safe-area-inset-*)` 也要一次重排才刷新。放在这里
     * 兜住所有退出路径（含智眸照片的全屏 —— 它不经过下面两个 store 开关）。
     */
    settleViewport()
    if (shell.mapLandOpen) shell.closeMapLand()
    else if (cam.isOpen && shell.isLand) cam.setCamLand(false)
  })
})

onBeforeUnmount(() => {
  offFullscreenExit?.()
  offFullscreenExit = null
})

/**
 * 登录态变化时补拉无人机预警。
 *
 * 两条用途，都不是底栏角标（角标只算监控，2026-11-24）：
 *   · 消息页「无人机预警」卡要显示「今日几条」，不预热就只会写「—」；
 *   · 首页报警轮播 / 报警预警历史页都读同一份 `droneAlarm.items`，
 *     而它们可能一直没被打开过（这台 PWA 是常驻的，启动后一直停在首页）。
 *
 * 登录成功后拉一次，退出登录由 `droneAlarm` 自己的 token watch 清空。
 * `load()` 自带 2 分钟保鲜与并发保护，与消息页同时挂载也只跑一趟。
 */
watch(
  () => auth.token,
  (t) => {
    if (t) void droneAlarm.load()
  },
)

/**
 * 系统状态栏区域的底色
 *
 * PWA 独立窗口下，屏幕最顶端约 43~59pt 是系统状态栏区，**不属于网页内容**，
 * 其底色由 theme-color 决定；iOS 还会按该底色亮度自动选状态栏文字颜色
 * （深底配白字、浅底配黑字）。
 *
 * 这里按当前视图动态取值，判断顺序与 src/styles/app.css 中
 * .phone-screen:has(...) .status-bar 的 5 组规则逐一对应，后写的覆盖先写的。
 */
watchEffect(() => {
  let color: string = THEME_COLORS.light // ① 基类白底

  // ② 首页：home-mode 深色主题
  if (shell.activeTab === 'home') color = THEME_COLORS.home

  // ③ 子页（非预警详情）
  if (sub.isOpen && !sub.isAlarm) color = THEME_COLORS.light

  // ④ 各全屏覆盖层打开
  if (cam.isOpen || air.isOpen || air.hazardOpen || (sub.isOpen && sub.isAlarm)) {
    color = THEME_COLORS.light
  }

  // ④' 深色子页（设备详情 / 日报 / 无人机）
  if (sub.isOpen && sub.isDark) color = THEME_COLORS.dark

  // ⑤ 子页正在退出：提前按“目标页面”取色。
  //    iPhone 的系统状态栏区域不属于网页内容，只认 theme-color ——
  //    等动画结束再切，顶上就会白一条。
  if (sub.leaving && shell.activeTab === 'home') color = THEME_COLORS.home

  // ⑥ 监控横屏（后于 ⑤，故横屏时取黑）
  if (cam.isOpen && shell.isLand) color = THEME_COLORS.camLandscape

  // ⑦ 横屏地图（最后，优先级最高）
  if (shell.mapLandOpen) color = THEME_COLORS.mapLand

  setThemeColor(color)
})
</script>

<template>
  <div class="stage">
    <div class="stage-title">向阳村项目智能建造管理平台</div>
    <div class="phone" :class="{ 'is-landscape': shell.isLandscape }">
      <!--
        has-home-top / has-land-top：给不支持 :has() 的旧内核兜住「顶部色条」。
        支持 :has() 的设备走 app.css 那 5 组 :has() 规则，这两个 class 只在
        `.no-has` 前缀下被使用，对正常设备零影响。
        刻意只兜首页透明与横屏深色两条 —— 它们不生效时最显眼（深色画面上顶一条白边）；
        其余白底场景本来就和默认白底一致，不需要额外规则。
      -->
      <div
        class="phone-screen"
        :class="{ 'has-home-top': shell.activeTab === 'home', 'has-land-top': shell.isLand }"
      >
        <StatusBar />

        <MapLand />
        <CamPlayer />
        <AirPlayer />
        <HazardPage />

        <!--
          has-subpage 是给「不支持 :has() 的旧内核」用的等价标记（2026-11-19）。
          app.css 里底栏显隐原本只靠 `.app:has(.subpage.open)`，而 :has() 需要
          Chrome 105+ / Safari 15.4+；小米、华为、OPPO、vivo 自带浏览器里仍有一批
          老内核，命中不了就会「子页开着、底栏还在下面露着」。
          CSS 侧用 `.no-has`（由 utils/standalone.ts 检测后打到 <html>）把这条规则
          用 class 再写一遍，不改支持 :has() 的设备的任何行为。
        -->
        <div
          class="app"
          id="app"
          :class="{ 'home-mode': shell.activeTab === 'home', 'has-subpage': sub.isOpen }"
        >
          <div class="stack">
            <NavBar />

            <!--
              data-dir 驱动页面转场方向：向右推进的 tab 从右侧滑入，退回时
              从左侧滑入（见 shell.navDir 与 app.css 的 .pages[data-dir]）。
            -->
            <main class="pages" :data-dir="shell.navDir">
              <HomePage />
              <WorkPage />
              <MsgPage />
              <MinePage />
            </main>

            <SubPage />
          </div>

          <TabBar />
        </div>

        <Toast />
        <!--
          底部弹层（2026-10 版本同步·第一批）：挂在 .app 之外、Toast 之前。
          层级 app(无) < 子页(40) < 弹层(45) < Toast(50)：弹层要盖住子页与底栏，
          但不能盖住提示 —— 弹层里点「下发航线」后那条 toast 必须看得见。
        -->
        <SheetHost />
        <UpdateBanner />
        <!--
          横屏引导：压在所有层之上（z-index 220 > toast 210）。
          只有一个触发点 —— 智眸 VR 360 环视的项目全景点「全屏」（2026-11-24），
          其它全屏场景不再弹，见 utils/landscapeHint.ts。
        -->
        <LandscapeHint />
      </div>
    </div>
  </div>
</template>
