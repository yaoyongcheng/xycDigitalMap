<script setup lang="ts">
import { watchEffect } from 'vue'

import { useAirHazardStore } from '@/stores/airHazard'
import { useCamStore } from '@/stores/cam'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import { setThemeColor, THEME_COLORS } from '@/utils/themeColor'
import { useSwipeBack } from '@/utils/swipeBack'
import StatusBar from '@/components/shell/StatusBar.vue'
import NavBar from '@/components/shell/NavBar.vue'
import TabBar from '@/components/shell/TabBar.vue'
import Toast from '@/components/shell/Toast.vue'
import UpdateBanner from '@/components/shell/UpdateBanner.vue'
import MapLand from '@/components/overlays/MapLand.vue'
import CamPlayer from '@/components/overlays/CamPlayer.vue'
import AirPlayer from '@/components/overlays/AirPlayer.vue'
import HazardPage from '@/components/overlays/HazardPage.vue'
import SubPage from '@/components/overlays/SubPage.vue'
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

/** 全局右滑返回手势（微信式）：见 utils/swipeBack.ts 的约束说明 */
useSwipeBack()

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

  // ⑤ 监控横屏（后于 ④，故横屏时取黑）
  if (cam.isOpen && shell.isLand) color = THEME_COLORS.camLandscape

  // ⑥ 横屏地图（最后，优先级最高）
  if (shell.mapLandOpen) color = THEME_COLORS.mapLand

  setThemeColor(color)
})
</script>

<template>
  <div class="stage">
    <div class="stage-title">工地数字地图 · 移动端标准版</div>
    <div class="phone" :class="{ 'is-landscape': shell.isLandscape }">
      <div class="phone-screen">
        <StatusBar />

        <MapLand />
        <CamPlayer />
        <AirPlayer />
        <HazardPage />

        <div class="app" id="app" :class="{ 'home-mode': shell.activeTab === 'home' }">
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
        <UpdateBanner />
      </div>
    </div>
  </div>
</template>
