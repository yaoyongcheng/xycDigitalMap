import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchProfile, login } from '@/api/auth'
import { encryptLoginPayload, MAX_PLAIN_BYTES } from '@/api/crypto'
import { ApiError, bindSession, request } from '@/api/http'
import { ACCOUNT_KEY, STORAGE_KEY, useAuthStore } from '@/stores/auth'

/**
 * 登录域（2026-11 新增）
 *
 * 这一层的契约是拿真实服务端对齐过的，改错不会报错、但现场会直接登不进去：
 *   · 登录必须两步（取公钥 → RSA 加密），且载荷字段叫 encrypted_data
 *   · 请求头必须是 `Authorization: Bearer {token}`（Unity 端 GetTokenHeader 同款）
 *   · 401 要清会话，否则页面会挂着废 token 一直重试
 * 所以即使 UI 变了，这几条也要钉死。
 */

/** 1024 位公钥（与 /api/user/auth/public-key 下发的同格式，测试只关心可加密） */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCuKt/rONByLZsbJ4SZHomERUsJ
elQL6gd7GEHOOjglU1/I5bK87ZPAjzvUw9OQledkUtLOPs1BpBlj8uNwG8TNMRKc
x1FzGbCfx03GMKW0Dbu8jhU79PfyaLMPtwFPT5gmwUrNqz+ni7BHTHjS51JHDQ0l
2vYUkzsW6T7YfbqzTwIDAQAB
-----END PUBLIC KEY-----
`

/** 最小 Response 替身：api 层只用到 status / ok / text() */
function envelope(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function resetSession(): void {
  bindSession({ token: () => '', unauthorized: () => {} })
}

describe('登录加密（对齐 Unity RsaEncryptUtil）', () => {
  it('输出 1024 位密文的 Base64（128 字节）', () => {
    const cipher = encryptLoginPayload(PUBLIC_KEY, { username: 'u1', password: 'p1' })
    expect(cipher).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(atob(cipher)).toHaveLength(128)
  })

  it('明文超过 117 字节直接拦下，并给出可读提示', () => {
    const long = { username: 'u'.repeat(80), password: 'p'.repeat(80) }
    expect(() => encryptLoginPayload(PUBLIC_KEY, long)).toThrow(ApiError)
    expect(() => encryptLoginPayload(PUBLIC_KEY, long)).toThrow(
      new RegExp(String(MAX_PLAIN_BYTES)),
    )
  })
})

describe('HTTP 客户端', () => {
  beforeEach(() => {
    resetSession()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('需要鉴权的请求自动带 Bearer token', async () => {
    bindSession({ token: () => 'tok-123', unauthorized: () => {} })
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => envelope({ code: 200, message: 'ok', data: { a: 1 } }))
    vi.stubGlobal('fetch', fetchMock)

    await request('/api/user/auth/me')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
  })

  it('登录接口不带头（此刻还没有 token），body 序列化成 JSON', async () => {
    bindSession({ token: () => 'tok-123', unauthorized: () => {} })
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => envelope({ code: 200, message: 'ok', data: {} }))
    vi.stubGlobal('fetch', fetchMock)

    await request('/api/user/auth/login', { method: 'POST', auth: false, body: { encrypted_data: 'x' } })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(init.body).toBe('{"encrypted_data":"x"}')
  })

  it('业务码非 200 抛 ApiError，message 用服务端文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 400, message: '为了安全起见，登录请求必须加密' }, 400)))
    await expect(request('/api/user/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 400,
      message: '为了安全起见，登录请求必须加密',
    })
  })

  it('401 触发清会话回调', async () => {
    const unauthorized = vi.fn()
    bindSession({ token: () => 'stale', unauthorized })
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 401, message: '认证令牌无效' }, 401)))

    await expect(request('/api/user/auth/me')).rejects.toMatchObject({ code: 401 })
    expect(unauthorized).toHaveBeenCalledTimes(1)
  })

  it('网络异常收敛成 code=0，不把原始 TypeError 抛给页面', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(request('/api/user/auth/me')).rejects.toMatchObject({ code: 0 })
  })
})

describe('登录流程', () => {
  beforeEach(() => {
    resetSession()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('先取公钥再用 encrypted_data 登录，返回 token 与过期时间', async () => {
    const calls: { url: string; body?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body as string })
        if (String(url).endsWith('/public-key')) {
          return envelope({ code: 200, message: '获取成功', data: { public_key: PUBLIC_KEY } })
        }
        return envelope({ code: 200, message: '登录成功', data: { access_token: 'tok-9', expires_in: 7200 } })
      }),
    )

    const before = Date.now()
    const session = await login('13800000000', 'secret')

    expect(calls[0].url).toContain('/api/user/auth/public-key')
    expect(calls[1].url).toContain('/api/user/auth/login')
    // 明文口令绝不能出现在请求体里
    expect(calls[1].body).not.toContain('secret')
    const sent = JSON.parse(calls[1].body ?? '{}') as { encrypted_data?: string }
    expect(atob(sent.encrypted_data ?? '')).toHaveLength(128)

    expect(session.token).toBe('tok-9')
    expect(session.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000)
  })

  it('/me 的字段名兜底：取不到姓名与角色就用账号', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 200, message: 'ok', data: {} })))
    const profile = await fetchProfile('13900000000')
    expect(profile).toEqual({ username: '13900000000', displayName: '13900000000', role: '' })
  })
})

describe('会话 store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    resetSession()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('默认未登录', () => {
    const auth = useAuthStore()
    expect(auth.isLoggedIn).toBe(false)
    expect(auth.displayName).toBe('')
  })

  it('登录成功后写入本地，可被下个会话恢复', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/public-key')) {
          return envelope({ code: 200, message: 'ok', data: { public_key: PUBLIC_KEY } })
        }
        if (String(url).endsWith('/login')) {
          return envelope({ code: 200, message: 'ok', data: { access_token: 'tok-a', expires_in: 3600 } })
        }
        return envelope({ code: 200, message: 'ok', data: { username: 'u9', realName: '张工', roleName: '安全员' } })
      }),
    )

    const auth = useAuthStore()
    await auth.login('u9', 'pwd')

    expect(auth.isLoggedIn).toBe(true)
    expect(auth.displayName).toBe('张工')
    expect(auth.role).toBe('安全员')
    expect(localStorage.getItem(STORAGE_KEY)).toContain('tok-a')
    // 只记账号，不记密码
    expect(localStorage.getItem(ACCOUNT_KEY)).toBe('u9')
    expect(JSON.stringify(localStorage)).not.toContain('pwd')

    // 新会话（重新创建 pinia）能恢复
    setActivePinia(createPinia())
    const restored = useAuthStore()
    expect(restored.token).toBe('tok-a')
    expect(restored.isLoggedIn).toBe(true)
  })

  it('过期的本地会话在恢复时被丢掉', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: 'old', expiresAt: Date.now() - 1000, username: 'u9' }),
    )
    const auth = useAuthStore()
    expect(auth.isLoggedIn).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('退出登录清空会话与本地存储', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'tok', expiresAt: 0, username: 'u9' }))
    const auth = useAuthStore()
    expect(auth.isLoggedIn).toBe(true)

    auth.logout()
    expect(auth.isLoggedIn).toBe(false)
    expect(auth.token).toBe('')
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('http 层 401 回调会清掉会话并提示重新登录', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'tok', expiresAt: 0, username: 'u9' }))
    const auth = useAuthStore()
    const shell = (await import('@/stores/shell')).useShellStore()

    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 401, message: '认证令牌无效' }, 401)))
    await expect(request('/api/user/auth/me')).rejects.toBeInstanceOf(ApiError)

    expect(auth.token).toBe('')
    expect(shell.toast).toBe('登录已过期，请重新登录')
  })
})
