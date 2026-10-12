<script setup lang="ts">
import { useShellStore } from '@/stores/shell'
import StatusBar from '@/components/shell/StatusBar.vue'
import NavBar from '@/components/shell/NavBar.vue'
import TabBar from '@/components/shell/TabBar.vue'
import Toast from '@/components/shell/Toast.vue'
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

            <main class="pages">
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
      </div>
    </div>
  </div>
</template>
