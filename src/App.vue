<script setup lang="ts">
import { useShellStore } from '@/stores/shell'
import StatusBar from '@/components/shell/StatusBar.vue'
import NavBar from '@/components/shell/NavBar.vue'
import TabBar from '@/components/shell/TabBar.vue'
import Toast from '@/components/shell/Toast.vue'
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
 * 结构要点（均为 CSS 强依赖，不可调整）：
 *   - .phone-screen 的 7 个直接子元素顺序：status-bar、4 个覆盖层、.app、.toast
 *   - 4 个覆盖层与 .subpage 都常驻 DOM，靠 .open class 切换显隐
 *     （禁止改 v-if —— 会打破 app.css:132-163 的 :has() 与 :has() 依赖的常驻性）
 *   - .app.home-mode 由当前 tab 决定（原 app.js:66）
 *
 * 当前进度：外壳已迁移；4 个 tab 页、7 个覆盖层、4 个首页面板为占位，
 * 将在后续提交中按模块逐个替换。
 */
const shell = useShellStore()
</script>

<template>
  <div class="stage">
    <div class="stage-title">工地数字地图 · 移动端标准版</div>
    <div class="phone" :class="{ 'is-landscape': shell.isLandscape }">
      <div class="phone-screen">
        <StatusBar />

        <!-- 覆盖层 1：横屏地图（待迁移 MapLand.vue） -->
        <div class="map-land" id="mapLand" aria-hidden="true" hidden></div>

        <!-- 覆盖层 2：监控播放器（待迁移 CamPlayer.vue） -->
        <div class="cam-player" id="camPlayer" hidden></div>

        <!-- 覆盖层 3：无人机巡检（待迁移 AirPlayer.vue） -->
        <div class="air-player" id="airPlayer" hidden></div>

        <!-- 覆盖层 4：隐患上报（待迁移 HazardPage.vue） -->
        <div class="hazard-page" id="hazardPage" hidden></div>

        <div class="app" id="app" :class="{ 'home-mode': shell.activeTab === 'home' }">
          <div class="stack">
            <NavBar />

            <main class="pages">
              <HomePage />
              <WorkPage />
              <MsgPage />
              <MinePage />
            </main>

            <!-- 覆盖层 5：子页栈（待迁移 SubPage.vue） -->
            <section class="subpage" id="subpage"></section>
          </div>

          <TabBar />
        </div>

        <Toast />
      </div>
    </div>
  </div>
</template>
