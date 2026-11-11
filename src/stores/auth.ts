import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchProfile, login as loginRequest, logout as logoutRequest } from '@/api/auth'
import { clearPictureCache } from '@/api/video'
import { ApiError, bindSession } from '@/api/http'
import { useAlarmStore } from './alarm'
import { useDeviceLedgerStore } from './deviceLedger'
import { usePatrolStore } from './patrol'
import { useShellStore } from './shell'
import { useSubpageStore } from './subpage'
import { useUavStore } from './uav'

/**
 * 登录会话
 *
 * 对应 Unity 端 LoginRequestHelper：`CurLoginModel` 里存 token 与过期时间，
 * 发请求时用 GetTokenHeader() 拼 `Authorization: Bearer {token}`。
 * 这里把那份单例状态换成 Pinia store，并由 src/api/http.ts 统一注入请求头。
 *
 * 关于持久化：
 *   服务端只发 access_token + expires_in，没有 refresh token 端点，本页又是纯静态
 *   PWA —— 不落盘就得每次刷新重登，现场用手套操作时几乎不可用。所以 token 存
 *   localStorage（键见 STORAGE_KEY），但**不存密码**（Unity 端把账号密码明文
 *   写进 PlayerPrefs，这里不沿用）。401 / 过期即清，登出即清。
 *   更严格的做法是服务端发 httpOnly + SameSite Cookie，那是后端的改造项。
 */

const STORAGE_KEY = 'xyc.auth.session'
const ACCOUNT_KEY = 'xyc.auth.account'

/** 存取 localStorage 一律包一层：iOS 隐私模式 / 存储配额满都会抛异常 */
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // 存不下就算了，本次会话仍然是登录态
  }
}

interface StoredSession {
  token: string
  expiresAt: number
  username: string
  displayName: string
  role: string
}

export const useAuthStore = defineStore('auth', () => {
  const shell = useShellStore()

  const token = ref('')
  const expiresAt = ref(0)
  /** 登录用的账号（手机号/工号） */
  const username = ref('')
  /** 展示名（/me 给的姓名，取不到就等于账号） */
  const displayName = ref('')
  const role = ref('')
  /** 登录中（登录页按钮态） */
  const pending = ref(false)

  let expiryTimer = 0

  /** 有 token 且没过期。过期的判定依赖 expiresAt 的变化，另有定时器到点清理 */
  const isLoggedIn = computed(() => !!token.value && (expiresAt.value === 0 || expiresAt.value > Date.now()))

  function clearExpiryTimer(): void {
    window.clearTimeout(expiryTimer)
    expiryTimer = 0
  }

  /** 到点自动退出，避免页面挂着过期 token 一直 401 */
  function scheduleExpiry(): void {
    clearExpiryTimer()
    if (!expiresAt.value) return
    const delay = expiresAt.value - Date.now()
    if (delay <= 0) return
    // setTimeout 的上限约 24.8 天，超了就分段（这里够用，仍按上限截断）
    expiryTimer = window.setTimeout(() => {
      expire('登录已过期，请重新登录')
    }, Math.min(delay, 2 ** 31 - 1))
  }

  /**
   * 会话失效的统一出口：清本地会话 + 提示 + 把用户带到登录页。
   *
   * 2026-11 新增「带到登录页」：只弹一条 toast 的话，用户留在首页看到的
   * 全是空态，不知道该去哪；而且过期常常发生在后台切回来的一瞬间，toast
   * 一闪就没了。这里直接打开登录页，页顶写着原因。
   */
  function expire(notice: string): void {
    const sub = useSubpageStore()
    // 先取当前视图，再清会话 —— 清完数据后详情页就找不到这条报警了
    const cur = sub.view
    clear()
    shell.showToast(notice, 'warn')
    // 详情页登录后回到巡检列表：报警数据已随会话清空，回详情会是一页空白
    const next = cur.kind === 'alarm-detail' ? ({ kind: 'inspect-list' } as const) : cur
    sub.openLogin(notice, next)
  }

  function persist(): void {
    if (!token.value) {
      writeStorage(STORAGE_KEY, null)
      return
    }
    const payload: StoredSession = {
      token: token.value,
      expiresAt: expiresAt.value,
      username: username.value,
      displayName: displayName.value,
      role: role.value,
    }
    writeStorage(STORAGE_KEY, JSON.stringify(payload))
  }

  /** 清空会话（不改存储里的「记住的账号」） */
  function clear(): void {
    token.value = ''
    expiresAt.value = 0
    username.value = ''
    displayName.value = ''
    role.value = ''
    clearExpiryTimer()
    writeStorage(STORAGE_KEY, null)
    // 真实报警是「谁的现场」相关的数据，会话一清就一起清 ——
    // 否则换个人登录前，首页还挂着上一个人拉到的报警
    useAlarmStore().clearLive()
    // 设备台账同理（:8084 也要 Bearer）：不清的话智控面板会继续显示
    // 上一个账号/上一个项目拉到的机组
    useDeviceLedgerStore().reset()
    // 无人机任务与巡检照片：keehang 用的是项目级服务凭据（不随用户会话走），
    // 但仍要清缓存 —— 换账号后继续看旧任务会串项目
    useUavStore().reset()
    usePatrolStore().reset()
    // 抓拍图缓存在模块级 Map 里，不跟着 store 走；不清的话下一个人
    // 点开同一条报警会看到上一个人的现场照片
    clearPictureCache()
  }

  /** 启动时从本地恢复；已过期则直接丢掉 */
  function restore(): void {
    const raw = readStorage(STORAGE_KEY)
    if (!raw) return
    try {
      const saved = JSON.parse(raw) as Partial<StoredSession>
      if (!saved?.token) return
      if (saved.expiresAt && saved.expiresAt <= Date.now()) {
        writeStorage(STORAGE_KEY, null)
        return
      }
      token.value = saved.token
      expiresAt.value = saved.expiresAt ?? 0
      username.value = saved.username ?? ''
      displayName.value = saved.displayName ?? saved.username ?? ''
      role.value = saved.role ?? ''
      scheduleExpiry()
    } catch {
      writeStorage(STORAGE_KEY, null)
    }
  }

  /**
   * 登录。
   *
   * 抛 ApiError 给页面展示（服务端中文文案可直接用：账号密码错误 / 必须加密 /
   * 参数错误都在 message 里）。成功后 best-effort 拉一次 /me 补全姓名与角色 ——
   * 这个请求同时验证了 token 能通过服务端校验，失败不影响登录态（除非 401，
   * 那时 http 层已回调 unauthorized 清会话）。
   */
  async function login(account: string, password: string): Promise<void> {
    pending.value = true
    try {
      const session = await loginRequest(account.trim(), password)
      token.value = session.token
      expiresAt.value = session.expiresAt
      username.value = account.trim()
      displayName.value = account.trim()
      role.value = ''
      scheduleExpiry()
      persist()
      // 记住账号（只记账号，不记密码）
      writeStorage(ACCOUNT_KEY, username.value)

      try {
        const me = await fetchProfile(username.value)
        displayName.value = me.displayName || username.value
        role.value = me.role
        persist()
      } catch {
        // /me 不可用或字段对不上：仍然算登录成功，展示名回落到账号
      }
    } finally {
      pending.value = false
    }
  }

  /**
   * 退出登录。
   *
   * **本地先清、再通知服务端**（顺序不能反）：
   *   用户点下确认的那一瞬间就该离开登录态，不能因为服务端慢或不可达而卡在
   *   「正在退出…」；而服务端注销要用的 token 此时已被清掉，所以显式带过去。
   *
   * 服务端失败一律吞掉：登出是「本地意图」，服务端只是顺带把这张票作废。
   * 反过来（等成功才清本地）会让网络一抖就退不出去，是更糟的体验。
   */
  async function logout(): Promise<void> {
    const t = token.value
    clear()
    if (!t) return
    try {
      await logoutRequest(t)
    } catch {
      // 服务端不可达 / 令牌已过期 / 该端点未开放 —— 都不影响已经完成的本地登出
    }
  }

  /** 上次登录过的账号（登录页预填） */
  function rememberedAccount(): string {
    return readStorage(ACCOUNT_KEY) ?? ''
  }

  /** 401 时由 http 层回调：清会话并引导重新登录 */
  bindSession({
    token: () => token.value,
    unauthorized: () => {
      if (!token.value) return
      expire('登录已过期，请重新登录')
    },
  })

  restore()

  return {
    token,
    expiresAt,
    username,
    displayName,
    role,
    pending,
    isLoggedIn,
    login,
    logout,
    rememberedAccount,
    /** 供测试与「会话失效」场景手动清空 */
    clear,
  }
})

export { ACCOUNT_KEY, STORAGE_KEY }

/** 把任意异常转成可展示文案（页面只关心 message） */
export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return '登录失败，请稍后重试'
}
