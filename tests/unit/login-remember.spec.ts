import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LoginPage from '@/views/sub/LoginPage.vue'
import { useAuthStore } from '@/stores/auth'
import {
  clearCredential,
  isRemembered,
  loadCredential,
  markRemembered,
  saveCredential,
  warmCredentialVault,
} from '@/utils/credentialVault'

/**
 * 登录页 · 「记住密码」（2026-11-27）
 *
 * 这里只钉**页面决定**，凭据本身的加解密与降级在 `credential-vault.spec.ts`：
 *   · 打开时有记录 → 账号、口令都填好，勾选框是勾着的（一个真相来源）；
 *   · 勾着登录 → 存；没勾登录 → 清（包括之前存过的）；
 *   · 当场取消勾选 → 立即清，不等提交（否则离开页面就留了个残留口令）；
 *   · 登录失败（错口令 / 网络不通）→ 一个字都不动；登出也不动。
 *
 * 后面两条是 2026-11-27 按 V2 `UIViewLogin` 对齐的：V2 只在**登录成功**的分支里
 * 调 `CheckRecordPassword`，`LoginOut` 也从不碰 `PlayerPrefs`。之前那版「失败就清、
 * 登出就清」会让唯一的验收路径（登录→登出→看登录页）永远是空表单。
 */
vi.mock('@/utils/credentialVault', () => ({
  loadCredential: vi.fn(async () => null),
  saveCredential: vi.fn(async () => true),
  clearCredential: vi.fn(async () => undefined),
  warmCredentialVault: vi.fn(),
  markRemembered: vi.fn(),
  isRemembered: vi.fn(() => false),
}))

const vault = {
  load: vi.mocked(loadCredential),
  save: vi.mocked(saveCredential),
  clear: vi.mocked(clearCredential),
  warm: vi.mocked(warmCredentialVault),
  mark: vi.mocked(markRemembered),
  remembered: vi.mocked(isRemembered),
}

/** 1024 位公钥（与登录接口下发的同格式，这里只关心能加密） */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCuKt/rONByLZsbJ4SZHomERUsJ
elQL6gd7GEHOOjglU1/I5bK87ZPAjzvUw9OQledkUtLOPs1BpBlj8uNwG8TNMRKc
x1FzGbCfx03GMKW0Dbu8jhU79PfyaLMPtwFPT5gmwUrNqz+ni7BHTHjS51JHDQ0l
2vYUkzsW6T7YfbqzTwIDAQAB
-----END PUBLIC KEY-----
`

function envelope(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

/** 登录成功：公钥 → 登录 → /me 三段都通 */
function stubLoginOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/public-key')) {
        return envelope({ code: 200, message: 'ok', data: { public_key: PUBLIC_KEY } })
      }
      if (String(url).endsWith('/login')) {
        return envelope({ code: 200, message: '登录成功', data: { access_token: 'tok-1', expires_in: 3600 } })
      }
      return envelope({ code: 200, message: 'ok', data: { username: 'u', realName: '张工' } })
    }),
  )
}

function mountPage(): ReturnType<typeof mount> {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(LoginPage, { global: { plugins: [pinia] } })
}

async function submit(w: ReturnType<typeof mount>, account = '13800000000', password = 'p@ss'): Promise<void> {
  await w.find('input[name="username"]').setValue(account)
  await w.find('input[name="password"]').setValue(password)
  await w.find('.login-submit').trigger('click')
  await flushPromises()
}

const checkbox = (w: ReturnType<typeof mount>): HTMLInputElement =>
  w.find('.login-checkbox').element as HTMLInputElement

describe('登录页 · 记住密码', () => {
  beforeEach(() => {
    vault.load.mockReset().mockResolvedValue(null)
    vault.save.mockReset().mockResolvedValue(true)
    vault.clear.mockReset().mockResolvedValue(undefined)
    vault.warm.mockReset()
    vault.mark.mockReset()
    vault.remembered.mockReset().mockReturnValue(false)
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('有记录时打开：账号与口令都回填，勾选框是勾上的', async () => {
    vault.load.mockResolvedValue({ account: '13900000000', password: 'saved-pw' })
    const w = mountPage()
    await flushPromises()

    const account = w.find('input[name="username"]').element as HTMLInputElement
    const password = w.find('input[name="password"]').element as HTMLInputElement
    expect(account.value).toBe('13900000000')
    expect(password.value).toBe('saved-pw')
    expect(checkbox(w).checked).toBe(true)
    // 程序自己勾上的那一下不能被当成用户操作（否则每次打开都白存一遍）
    expect(vault.save).not.toHaveBeenCalled()
  })

  it('没记录时打开：不勾选，口令留空', async () => {
    const w = mountPage()
    await flushPromises()

    expect(checkbox(w).checked).toBe(false)
    expect((w.find('input[name="password"]').element as HTMLInputElement).value).toBe('')
  })

  it('没有口令数据、但上次勾着：进来仍显示勾选（意愿跟密码分开存）', async () => {
    vault.load.mockResolvedValue(null)
    vault.remembered.mockReturnValue(true)
    const w = mountPage()
    await flushPromises()

    expect(checkbox(w).checked).toBe(true)
    expect((w.find('input[name="password"]').element as HTMLInputElement).value).toBe('')
  })

  it('取消后又勾回来（表单还完整）：立刻重新存下来，不必等登录', async () => {
    vault.load.mockResolvedValue({ account: '13900000000', password: 'saved-pw' })
    const w = mountPage()
    await flushPromises()

    await w.find('.login-checkbox').setValue(false)
    expect(vault.clear).toHaveBeenCalled()

    vault.save.mockClear()
    await w.find('.login-checkbox').setValue(true)

    // 之前的实现这里只 warm 了密钥、什么都不写，于是「取消 → 再勾 → 返回」
    // 等于把记录彻底弄丢，再进来既不勾也没密码
    expect(vault.save).toHaveBeenCalledWith('13900000000', 'saved-pw')
    expect(vault.mark).toHaveBeenCalledWith(true)
  })

  it('勾着登录成功：按账号 + 口令存下来', async () => {
    stubLoginOk()
    const w = mountPage()
    await flushPromises()
    await w.find('.login-checkbox').setValue(true)
    await submit(w, '13800000000', 'p@ss')

    expect(vault.save).toHaveBeenCalledWith('13800000000', 'p@ss')
    expect(vault.clear).not.toHaveBeenCalled()
  })

  it('存不下来（口令超长 / 存储写不进）：勾选态复位，不留「勾着却没存上」', async () => {
    stubLoginOk()
    vault.save.mockResolvedValue(false)
    const w = mountPage()
    await flushPromises()
    await w.find('.login-checkbox').setValue(true)
    await submit(w)

    expect(vault.save).toHaveBeenCalled()
    expect(checkbox(w).checked).toBe(false)
  })

  it('没勾登录成功：把之前存过的清掉，不留半条', async () => {
    stubLoginOk()
    const w = mountPage()
    await flushPromises()
    await submit(w, '13800000000', 'p@ss')

    expect(vault.save).not.toHaveBeenCalled()
    expect(vault.clear).toHaveBeenCalled()
  })

  it('当场取消勾选就清，不必等提交', async () => {
    vault.load.mockResolvedValue({ account: '13900000000', password: 'saved-pw' })
    const w = mountPage()
    await flushPromises()

    await w.find('.login-checkbox').setValue(false)

    expect(vault.clear).toHaveBeenCalled()
    expect(checkbox(w).checked).toBe(false)
  })

  it('登录失败（错口令）：已记住的凭据与勾选都不动（V2 同口径）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/public-key')) {
          return envelope({ code: 200, message: 'ok', data: { public_key: PUBLIC_KEY } })
        }
        return envelope({ code: 400, message: '账号或密码错误' }, 400)
      }),
    )
    const w = mountPage()
    await flushPromises()
    await w.find('.login-checkbox').setValue(true)
    await submit(w, '13800000000', 'wrong')

    expect(w.find('.login-error').text()).toContain('账号或密码错误')
    // V2 的 `CheckRecordPassword` 只在登录成功分支里跑，失败只累加 loginFailCount
    expect(vault.clear).not.toHaveBeenCalled()
    expect(checkbox(w).checked).toBe(true)
    expect(vault.save).not.toHaveBeenCalled()
  })

  it('登出只作废会话，不碰记住的凭据（V2 的 LoginOut 也不碰 PlayerPrefs）', async () => {
    stubLoginOk()
    const w = mountPage()
    await flushPromises()
    await w.find('.login-checkbox').setValue(true)
    await submit(w, '13800000000', 'p@ss')
    vault.clear.mockClear()

    await useAuthStore().logout()

    expect(vault.clear).not.toHaveBeenCalled()
  })

  it('网络不通不算「凭据错」：记住的口令一个字都不动', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const w = mountPage()
    await flushPromises()
    await w.find('.login-checkbox').setValue(true)
    await submit(w, '13800000000', 'p@ss')

    expect(w.find('.login-error').exists()).toBe(true)
    expect(vault.clear).not.toHaveBeenCalled()
    expect(checkbox(w).checked).toBe(true)
  })
})
