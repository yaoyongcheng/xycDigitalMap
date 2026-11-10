<script setup lang="ts">
import { computed, ref } from 'vue'

import { MIXED_CONTENT_HINT, isMixedContent } from '@/api/config'
import { authErrorMessage, useAuthStore } from '@/stores/auth'
import { useShellStore } from '@/stores/shell'
import { useSubpageStore } from '@/stores/subpage'

/**
 * 账号登录（2026-11 新增，「我的」入口）
 *
 * 接口对齐 Unity 端：先取公钥、RSA 加密账号密码、再登录拿 token —— 细节收在
 * src/api/auth.ts，这里只管三件事：输入校验、请求中态、错误文案。
 *
 * 登录成功后立刻返回上一页（我的），会话由 stores/auth.ts 持有并持久化。
 */
const auth = useAuthStore()
const shell = useShellStore()
const subpage = useSubpageStore()

const account = ref(auth.rememberedAccount())
const password = ref('')
const error = ref('')
const pwdVisible = ref(false)

/** HTTPS 页面调 HTTP 接口会被拦，提前说清楚，省得把环境问题当成账号问题 */
const mixed = isMixedContent()

const canSubmit = computed(() => account.value.trim().length > 0 && password.value.length > 0)

async function onSubmit(): Promise<void> {
  if (auth.pending || !canSubmit.value) return
  error.value = ''
  try {
    await auth.login(account.value, password.value)
    shell.showToast('登录成功', 'success')
    password.value = ''
    subpage.close()
  } catch (err) {
    // 服务端文案本身可读（账号密码错误 / 必须加密 / 参数错误），直接展示
    error.value = authErrorMessage(err)
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-brand">
      <span class="login-logo" aria-hidden="true">阳</span>
      <h2>欢迎回来</h2>
      <p>向阳村项目智能建造管理平台</p>
    </div>

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
