import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 记住密码 · 落盘路径（IndexedDB 可用时的真实行为）
 *
 * `credential-vault.spec.ts` 跑的是「没有 IndexedDB」的降级路径；这里用
 * fake-indexeddb 把**真实的落盘 / 读回 / 清除**跑一遍，并用 `vi.resetModules()`
 * 模拟「关掉页面再进来」：模块级内存（`keyPair` / `memRecord`）全部清空，
 * 只剩 IndexedDB 与 localStorage —— 这正是用户要求的「刷新、关闭再进也一致」。
 *
 * 四件事必须钉住：
 *   ① 盘上只有密文（localStorage 里搜不到明文口令）；
 *   ② 冷启动能解回来（密钥确实取到了 IndexedDB 里那份，不是内存里蒙出来的）；
 *   ③ 清除是彻底的（密文 + 密钥都删，冷启动读回 null）；
 *   ④ 同一账号换口令是覆盖，不是留两条。
 */

type Vault = typeof import('@/utils/credentialVault')

/** 拿一份「刚启动」的模块实例（内存态为空，盘上的东西还在） */
async function coldStart(): Promise<Vault> {
  vi.resetModules()
  return import('@/utils/credentialVault')
}

/** 直接读 IndexedDB 里那对密钥的公钥（判断「清除」有没有把它一并删掉） */
function readDevicePublicKey(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open('xyc-cred', 1)
    req.onsuccess = () => {
      const db = req.result
      try {
        const get = db.transaction('keys', 'readonly').objectStore('keys').get('device')
        get.onsuccess = () => {
          const rec = get.result as { publicKey?: string } | undefined
          db.close()
          resolve(rec?.publicKey ?? null)
        }
        get.onerror = () => {
          db.close()
          resolve(null)
        }
      } catch {
        db.close()
        resolve(null)
      }
    }
    req.onerror = () => resolve(null)
  })
}

describe('记住密码 · 落盘路径（IndexedDB 可用）', () => {
  beforeEach(async () => {
    const vault = await coldStart()
    await vault.clearCredential()
    localStorage.clear()
  })

  it('存盘后：localStorage 里只有密文，搜不到明文口令', async () => {
    const vault = await coldStart()
    expect(await vault.saveCredential('13800000000', 'p@ssw0rd-123456')).toBe(true)

    const raw = localStorage.getItem(vault.CRED_KEY) ?? ''
    const blob = JSON.parse(raw) as { v: number; a: string; c: string }
    // 账号本来就以明文存在（与 ACCOUNT_KEY 同口径），口令只以密文出现
    expect(blob.a).toBe('13800000000')
    expect(blob.c).not.toBe('p@ssw0rd-123456')
    expect(raw).not.toContain('p@ssw0rd')
    // RSA 1024 的 Base64 密文是 172 字符；太短就说明存了别的东西
    expect(blob.c.length).toBeGreaterThan(100)
  })

  it('关掉页面再进来：账号与口令照样回填（密钥来自 IndexedDB）', async () => {
    const first = await coldStart()
    await first.saveCredential('13800000000', 'p@ssw0rd')

    const second = await coldStart()
    expect(await second.loadCredential()).toEqual({ account: '13800000000', password: 'p@ssw0rd' })
  })

  it('清除后读回 null，盘上不留密文（密钥留着也解不出东西）', async () => {
    const first = await coldStart()
    await first.saveCredential('13800000000', 'p@ssw0rd')
    await first.clearCredential()

    expect(localStorage.getItem(first.CRED_KEY)).toBeNull()

    const second = await coldStart()
    expect(await second.loadCredential()).toBeNull()
  })

  it('清除只删密文，密钥留在盘上（下次勾选不必再生成 ~0.1s）', async () => {
    const vault = await coldStart()
    await vault.saveCredential('13800000000', 'p@ssw0rd')
    const before = await readDevicePublicKey()
    expect(before).toBeTruthy()

    await vault.clearCredential()

    // 早先的实现把密钥一起删；而删除是异步的，用户「取消 → 马上重勾」时
    // 迟到的 delete 会干掉刚重建的那对 —— 内存以为落了盘，冷启动却解不开。
    expect(await readDevicePublicKey()).toBe(before)
  })

  it('同一账号换口令是覆盖，不是留两条', async () => {
    const first = await coldStart()
    await first.saveCredential('13800000000', 'old-pw')
    await first.saveCredential('13800000000', 'new-pw')

    const second = await coldStart()
    expect(await second.loadCredential()).toEqual({ account: '13800000000', password: 'new-pw' })
  })

  it('换个人登录：回填的是新的那位，不是上一位', async () => {
    const first = await coldStart()
    await first.saveCredential('13800000000', 'pw-a')
    await first.saveCredential('13900000000', 'pw-b')

    const second = await coldStart()
    expect(await second.loadCredential()).toEqual({ account: '13900000000', password: 'pw-b' })
  })
})
