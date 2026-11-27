<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { MIXED_CONTENT_HINT, isMixedContent } from '@/api/config'
import { authErrorMessage, useAuthStore } from '@/stores/auth'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'
import {
  clearCredential,
  isRemembered,
  loadCredential,
  markRemembered,
  saveCredential,
  warmCredentialVault,
} from '@/utils/credentialVault'

/**
 * 账号登录（2026-11 新增，「我的」入口）
 *
 * 接口对齐 Unity 端：先取公钥、RSA 加密账号密码、再登录拿 token —— 细节收在
 * src/api/auth.ts，这里只管三件事：输入校验、请求中态、错误文案。
 *
 * 登录成功后立刻返回上一页（我的），会话由 stores/auth.ts 持有并持久化。
 *
 * 「记住密码」：对齐 V2（Unity 端 `UIViewLogin`）的四个动作 ——
 *   · `CheckLocalLoginState()`：打开登录页时，盘上有记录就**勾上 + 回填账号口令**；
 *   · `CheckRecordPassword()`：只在**登录成功后**按当时的勾选态写或删，失败不碰；
 *   · `ClearRecordPassword()`：未勾选时删干净，不留半条；
 *   · `LoginOut` 不碰凭据，所以登出后再进登录页照样回填。
 *
 * 唯一的不同是密码不落明文：V2 写的是 `PlayerPrefs` 原文，这里存的是
 * `utils/credentialVault.ts` 的密文（密钥在 IndexedDB）。
 *
 * 勾选态与密码数据**分开存**（2026-11-27 补，这一条是 V2 没有的）：
 *   · 密码数据（密文）只在有完整一组账号口令时才存在；
 *   · 勾选意愿（`xyc.auth.remember`）是一次点击就能确定的。
 * 之前用「有没有密文」同时推导勾选态，导致「取消 → 再勾 → 直接返回」时：勾选
 * 只是本页的 UI 状态，盘上早就空了，下次进来既不勾也不回填。
 */
const auth = useAuthStore()
const shell = useShellStore()
const subpage = useSubpageStore()

const account = ref(auth.rememberedAccount())
const password = ref('')
const error = ref('')
const pwdVisible = ref(false)
const remember = ref(false)

/** 表单是否已有一整组（账号非空 + 口令非空）：勾选时据此决定能不能立刻存 */
const canSubmit = computed(() => account.value.trim().length > 0 && password.value.length > 0)

/** 挂载时的账号：自动填充只在「用户还没动过表单」时生效，别抢用户已经敲进去的字 */
const seededAccount = account.value

/**
 * 回填期间抑制 watch 的副作用。
 *
 * 程序自己把 `remember` 置 true 不该被当成「用户点了勾选」——否则每次打开
 * 登录页都会白存一次。因为下面的 watch 用 `flush:'sync'`，这个标志能可靠生效。
 */
let hydrating = false

onMounted(async () => {
  const saved = await loadCredential()
  if (saved) {
    if (account.value !== seededAccount || password.value) return
    hydrating = true
    account.value = saved.account
    password.value = saved.password
    remember.value = true
    hydrating = false
    return
  }
  // 盘上没有可用的账号口令，但上次**确实勾着**（勾了却没登录成功过）：
  // 勾选框照样还原。之前这里只认「有密文」，于是「勾着离开 → 再进来」永远是
  // 未勾选，用户以为设置被吞了。
  if (isRemembered()) {
    hydrating = true
    remember.value = true
    hydrating = false
  }
})

/**
 * 勾选 / 取消勾选。
 *
 * 取消：立即清（密文 + 勾选意愿），不等提交 —— 用户关了勾没登录就离开，
 * 下次不该又「勾着 + 填好」。
 *
 * 勾上：先记意愿，再看表单。表单里已经有一整组就直接存下来 —— 用户勾上后
 * 往往直接返回上一页，不该非得点一次登录才生效；这也让「取消 → 再勾 → 返回」
 * 能把刚才那组口令找回来（之前的实现只预热了密钥，什么都没写，等于白勾）。
 */
watch(
  remember,
  (on) => {
    if (hydrating) return
    if (!on) {
      void clearCredential()
      return
    }
    markRemembered(true)
    if (canSubmit.value) void saveCredential(account.value.trim(), password.value)
    else warmCredentialVault()
  },
  { flush: 'sync' },
)

/**
 * 品牌块用**桌面图标本身**（`public/pwa-192x192.png`，PWA manifest 里那颗 192）。
 *
 * 不另拷一份到 `public/img`：同一颗图标只该有一份源，装了 PWA 的用户在桌面上
 * 看到的那张，与登录页上这张必须逐像素一致。路径走 `BASE_URL` 拼，
 * 线上部署在 `/xycMobileDigitalMap/` 子目录下也不会 404。
 */
const logoSrc = `${import.meta.env.BASE_URL}pwa-192x192.png`

/**
 * 打开登录页的原因（未登录 / 登录已过期），由 `subpage.openLogin(notice)` 带进来。
 * 没有原因时（从「我的」主动进入）不显示提示条。
 */
const notice = computed(() => subpage.loginNotice)

/** HTTPS 页面调 HTTP 接口会被拦，提前说清楚，省得把环境问题当成账号问题 */
const mixed = isMixedContent()

async function onSubmit(): Promise<void> {
  if (auth.pending || !canSubmit.value) return
  error.value = ''
  // 登录成功后要清空输入框，先把口令留一份给「记住密码」用
  const typed = password.value
  try {
    await auth.login(account.value, password.value)
    shell.showToast('登录成功', 'success')
    // 勾了就存（账号 + 口令密文），没勾就把之前存过的清掉 —— 同一处决定，不留半条。
    // 存的是**登录成功后的账号**（`auth.username`），与 V2 存 `CurLoginModel` 同口径。
    // 必须 await：用户常常「登录成功后立刻把应用划掉」，写盘没落地就关掉，下次
    // 打开既不勾也不回填，看起来就是「又没记住」。密钥在勾选时已预热，正常只花几毫秒。
    if (remember.value) {
      const kept = await saveCredential(auth.username || account.value, typed)
      // 存不下来（口令超过单块上限 / 存储写不进）就不留这个勾：勾选 = 已保存，
      // 不能让它骗人 —— 否则下次进来是「没勾也没填」，用户以为功能坏了
      if (!kept) remember.value = false
    } else {
      await clearCredential()
    }

    password.value = ''
    // 支付宝式：登录前想看的页面（被守卫拦下来的那个）在这里恢复，
    // 没有目标就关掉登录页回到原 tab。
    subpage.resumeAfterLogin()
  } catch (err) {
    // 服务端文案本身可读（账号密码错误 / 必须加密 / 参数错误），直接展示。
    //
    // 这里**不碰**已记住的凭据（V2 亦如此：`CheckRecordPassword` 只在登录成功的
    // 分支里跑，失败只累加 loginFailCount）。之前那版错一次密码就把勾选和口令一起
    // 清掉，用户手滑一下就得重输，还把「记住密码」判成了坏的。
    error.value = authErrorMessage(err)
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-brand">
      <!-- 桌面图标（与 PWA manifest 同一颗）：原先那个「阳」字方块已下线 -->
      <img class="login-logo" :src="logoSrc" alt="" width="56" height="56" />
      <h2>欢迎回来</h2>
      <p>向阳村项目智能建造管理平台</p>
    </div>

    <p v-if="notice" class="login-notice" role="status">{{ notice }}</p>

    <label class="login-field">
      <span>账号</span>
      <input
        v-model="account"
        class="login-input"
        type="text"
        name="username"
        autocomplete="username"
        autocapitalize="off"
        spellcheck="false"
        placeholder="请输入账号 / 手机号"
        @keydown.enter.prevent="onSubmit"
      />
    </label>

    <label class="login-field">
      <span>密码</span>
      <span class="login-pwd">
        <input
          v-model="password"
          class="login-input"
          :type="pwdVisible ? 'text' : 'password'"
          name="password"
          autocomplete="current-password"
          placeholder="请输入密码"
          @keydown.enter.prevent="onSubmit"
        />
        <button
          class="login-eye"
          type="button"
          :aria-label="pwdVisible ? '隐藏密码' : '显示密码'"
          :aria-pressed="pwdVisible"
          @click="pwdVisible = !pwdVisible"
        >
          {{ pwdVisible ? '隐藏' : '显示' }}
        </button>
      </span>
    </label>

    <label class="login-remember">
      <input v-model="remember" class="login-checkbox" type="checkbox" />
      <span>记住密码</span>
    </label>

    <p v-if="error" class="login-error" role="alert">{{ error }}</p>
    <p v-if="mixed" class="login-warn">{{ MIXED_CONTENT_HINT }}</p>

    <button
      class="login-submit"
      type="button"
      :disabled="auth.pending || !canSubmit"
      @click="onSubmit"
    >
      {{ auth.pending ? '登录中…' : '登录' }}
    </button>

    <p class="login-tip">账号由项目管理员分配；忘记密码请联系管理员重置。</p>
  </div>
</template>
