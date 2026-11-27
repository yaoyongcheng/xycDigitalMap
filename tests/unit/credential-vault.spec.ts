import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CRED_KEY,
  MAX_PLAIN_BYTES,
  clearCredential,
  createDeviceKey,
  decryptPassword,
  encryptPassword,
  isRemembered,
  loadCredential,
  markRemembered,
  saveCredential,
} from '@/utils/credentialVault'

/**
 * 记住密码 · 本机凭据（2026-11-27）
 *
 * 这一层的契约只有两条，但错一条就是安全事故或者「勾了没记住」：
 *   ① 口令**不以明文落地**：落盘的只有密文，解密要另一份材料（私钥在 IndexedDB）；
 *   ② 勾选态与存储同源：有记录 = 会回填，没记录 = 不回填，不存在第三种状态。
 *
 * happy-dom 没有 IndexedDB，所以存取走的是**内存降级路径**（与隐私模式下现场
 * 的表现一致：当次有效、刷新即失效、localStorage 一个字节都不写）。加解密
 * 这部分不依赖 IDB，直接用导出的纯函数验。
 */
describe('记住密码：密钥与密文', () => {
  it('公钥加密后能解回，密文里不含明文', () => {
    const key = createDeviceKey()
    const cipher = encryptPassword(key.publicKey, 'p@ssw0rd-123456')

    expect(cipher).not.toBe('')
    expect(cipher).not.toContain('p@ssw0rd')
    expect(decryptPassword(key.privateKey, cipher)).toBe('p@ssw0rd-123456')
  })

  it('换一对密钥解不出来（私钥与密文必须配套）', () => {
    const a = createDeviceKey()
    const b = createDeviceKey()
    const cipher = encryptPassword(a.publicKey, 'secret-1')

    expect(decryptPassword(a.privateKey, cipher)).toBe('secret-1')
    expect(decryptPassword(b.privateKey, cipher)).toBe('')
  })

  it(`超过 ${MAX_PLAIN_BYTES} 字节的口令拒绝加密，返回空串（不留半条）`, () => {
    const key = createDeviceKey()

    expect(encryptPassword(key.publicKey, 'p'.repeat(MAX_PLAIN_BYTES + 1))).toBe('')
    expect(encryptPassword(key.publicKey, 'p'.repeat(100))).not.toBe('')
  })

  it('密文损坏 / 不是密文，都解成空串而不是抛错', () => {
    const key = createDeviceKey()
    expect(decryptPassword(key.privateKey, 'not-a-cipher')).toBe('')
    expect(decryptPassword('', 'x')).toBe('')
  })
})

describe('记住密码：存取（无 IndexedDB，走内存降级）', () => {
  /** 把 localStorage 整个倒出来（`JSON.stringify(localStorage)` 在 happy-dom 里是 `{}`，靠不住） */
  function dumpStorage(): string {
    const parts: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i) as string
      parts.push(`${k}=${localStorage.getItem(k) ?? ''}`)
    }
    return parts.join(';')
  }

  beforeEach(async () => {
    localStorage.clear()
    await clearCredential()
  })

  afterEach(async () => {
    await clearCredential()
    localStorage.clear()
  })

  it('没存过时读回 null', async () => {
    expect(await loadCredential()).toBeNull()
  })

  it('存了能读回；密钥进不了盘时，localStorage 一个字节都不写', async () => {
    expect(await saveCredential('13800000000', 'p@ssw0rd')).toBe(true)

    // 先看盘上再读回：读不到密钥时只返回空，不会改盘上的东西，但这个顺序更保险
    expect(localStorage.getItem(CRED_KEY)).toBeNull()
    expect(dumpStorage()).not.toContain('p@ssw0rd')
    expect(await loadCredential()).toEqual({ account: '13800000000', password: 'p@ssw0rd' })
  })

  it('清除之后读不回，连账号也不回填', async () => {
    await saveCredential('13800000000', 'p@ssw0rd')
    await clearCredential()

    expect(await loadCredential()).toBeNull()
  })

  it('密钥拿不到时：这次读不回，但**不销毁**密文（临时打不开 ≠ 永久失效）', async () => {
    const key = createDeviceKey()
    localStorage.setItem(
      CRED_KEY,
      JSON.stringify({ v: 1, a: '13800000000', c: encryptPassword(key.publicKey, 'p@ssw0rd') }),
    )

    expect(await loadCredential()).toBeNull()
    // 删了就把「这次 IDB 打不开」变成「以后永远没有密码」—— 那才是用户看到的
    // 「明明勾了，重开却没记住」。V2 也没有「读失败即销毁」这种行为。
    expect(localStorage.getItem(CRED_KEY)).not.toBeNull()
  })

  it('账号为空 / 口令为空都不记，且不覆盖已有记录', async () => {
    expect(await saveCredential('   ', 'p@ssw0rd')).toBe(false)
    expect(await saveCredential('13800000000', '')).toBe(false)
    expect(await loadCredential()).toBeNull()

    await saveCredential('13800000000', 'p@ssw0rd')
    expect(await saveCredential('', '')).toBe(false)
    expect(await loadCredential()).toEqual({ account: '13800000000', password: 'p@ssw0rd' })
  })

  it('勾选意愿与账号口令同生共死：有记录=勾选，清掉=不勾', async () => {
    expect(isRemembered()).toBe(false)

    expect(await saveCredential('13800000000', 'p@ssw0rd')).toBe(true)
    expect(isRemembered()).toBe(true)

    await clearCredential()
    expect(isRemembered()).toBe(false)
  })

  it('只勾了、还没登录成功：意愿还在，但没有可回填的口令', async () => {
    markRemembered(true)

    expect(await loadCredential()).toBeNull()
    // 登录页据此把勾选框还原成「勾着」，口令留空 —— 而不是把用户的选择吞掉
    expect(isRemembered()).toBe(true)
  })
})
