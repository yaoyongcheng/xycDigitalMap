import { JSEncrypt } from 'jsencrypt'

/**
 * 「记住密码」的本地凭据（2026-11-27）
 *
 * ## 为什么不存明文
 *
 * 现场手机是**共用的**：一台机器上换班上号很常见，明文落盘等于把几个人的口令
 * 写在公示板上（Unity 端把账号密码明文写进 PlayerPrefs，这里不沿用）。所以
 * 落盘只有密文，而且**密钥与密文分开存放**：
 *
 *   · 密文 → `localStorage['xyc.auth.cred']`，只含账号与口令密文；
 *   · 密钥 → IndexedDB（`xyc-cred`）。导一份 localStorage、或者只看 DevTools
 *     的 Application 面板，都拿不到能还原口令的东西。
 *
 * ## 为什么是 RSA（jsencrypt）而不是 AES（crypto.subtle）
 *
 * `crypto.subtle` **只在安全上下文存在**，而现场跑的是 `http://115.159.67.12:8080`
 * 与局域网 `http://192.168.x.x:5173` —— 两个都不是安全上下文，`subtle` 直接是
 * `undefined`（同一个取舍见 `utils/sceneCache.ts` 里为什么不用 `subtle.digest`）。
 * jsencrypt 本来就在包里（登录载荷加密用的就是它），纯 JS、不挑协议。
 *
 * 做法是**本机自签一对密钥**：公钥加密口令、私钥解回填，私钥只进 IndexedDB。
 * 1024 位是权衡结果：PKCS#1 v1.5 单块明文上限 117 字节（塞得下任何端口令），
 * 生成耗时实测 ~0.1s（2048 位要 1.5s，手机上更久，登录后卡 1 秒不值得）。
 *
 * ## 边界（别当系统钥匙串看）
 *
 * 同源脚本本来就能读到 IndexedDB，所以这挡的是「明文可见 / 顺手被翻到 / 存储被
 * 导出」，挡不住「已经在页面上跑的恶意代码」。真要更强只能后端发 httpOnly
 * Cookie 或用系统钥匙串，那是后端的改造项。
 *
 * ## 存不下就退回内存
 *
 * 隐私模式 / 配额满 / 没有 IndexedDB：密钥进不了盘，密文就成了永远解不开的
 * 垃圾。这种情况**不写密文**，只在本会话内存里记着（自动填充当次有效），
 * 与 `utils/thumbCache.ts` 的降级口径一致。
 *
 * 但「勾选意愿」（`REMEMBER_KEY`）照常落盘 —— 它是用户一次点击的意图，不该
 * 因为存储能力不足就被吞掉，否则下次进来连勾都没了。
 */

/** 一条可回填的凭据（明文口令只在内存里出现，绝不落盘） */
export interface SavedCredential {
  /** 账号（手机号 / 工号） */
  account: string
  /** 口令明文 */
  password: string
}

/** 密文落在 localStorage 的这个键下 */
export const CRED_KEY = 'xyc.auth.cred'

/**
 * 「记住密码」的**勾选意愿**（2026-11-27 补）
 *
 * 之前勾选态完全由「盘上有没有密文」推导，结果是一条死路：取消勾选会立即删
 * 密文，而重新勾上只预热密钥、不写任何东西 —— 用户「取消 → 再勾 → 直接返回」
 * 之后，本页看着是勾着的，盘上却是空的。下次进登录页自然又不勾、也不回填。
 *
 * 勾选意愿必须与密码数据分开存：
 *   · 密码数据（密文）只在**有完整的一组账号口令**时才有，登录成功或用户勾选
 *     时写入；
 *   · 勾选意愿是一次点击就能确定的，勾上就该记住，与有没有登录成功无关。
 *
 * 两者都清 = 用户取消勾选（或登录成功但没勾）。
 */
export const REMEMBER_KEY = 'xyc.auth.remember'

const BLOB_VERSION = 1
const DB_NAME = 'xyc-cred'
const DB_VERSION = 1
const STORE = 'keys'
const KEY_ID = 'device'
const KEY_BITS = '1024'
/** RSA 1024 + PKCS#1 v1.5 的单块明文上限：128 − 11 */
export const MAX_PLAIN_BYTES = 117

/** 打不开库（Safari 隐私模式 / 配额耗尽 / WebView 实现问题）时的等待上限 */
const OPEN_TIMEOUT = 1500
const TX_TIMEOUT = 1200

interface DeviceKey {
  v: number
  publicKey: string
  privateKey: string
}

/** localStorage 里的形状：账号 + 口令密文 */
interface CredBlob {
  v: number
  a: string
  c: string
}

/** 内存副本：IDB 不可用时的唯一后端，也是「本会话内的真相」 */
let keyPair: DeviceKey | null = null
/** 密钥是否真的进了盘。false = 只有内存，此时密文没有意义，不能写 localStorage */
let keyPersisted = false
let keyTask: Promise<boolean> | null = null
let memRecord: SavedCredential | null = null

/* ---------- localStorage（一律包一层：iOS 隐私模式下 setItem 会抛） ---------- */

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/* ---------- IndexedDB（密钥专用；读不到就按「只有内存」处理） ---------- */

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  const task = new Promise<IDBDatabase | null>((resolve) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (!idb) {
      resolve(null)
      return
    }
    let done = false
    const fin = (db: IDBDatabase | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(db)
    }
    const timer = setTimeout(() => fin(null), OPEN_TIMEOUT)
    try {
      const req = idb.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => {
        if (done) {
          req.result.close()
          return
        }
        fin(req.result)
      }
      req.onerror = () => fin(null)
      req.onblocked = () => fin(null)
    } catch {
      fin(null)
    }
  })
  dbPromise = task
  // 打不开（隐私模式 / 首次超时 / 被别的标签页阻塞）时**不要把失败记一辈子**：
  // 清掉缓存，下次勾选或读回还愿意再试一次。否则一次抖动 = 整个会话都降级成
  // 「只有内存」，表现就是「明明勾了，重开却没记住」。
  void task.then((db) => {
    if (!db && dbPromise === task) dbPromise = null
  })
  return task
}

function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false
    const fin = (v: T): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => fin(fallback), ms)
    task.then(fin, () => fin(fallback))
  })
}

function normalizeKey(raw: unknown): DeviceKey | null {
  const k = raw as Partial<DeviceKey> | null | undefined
  if (!k || typeof k.publicKey !== 'string' || typeof k.privateKey !== 'string') return null
  if (!k.publicKey || !k.privateKey) return null
  return { v: typeof k.v === 'number' ? k.v : BLOB_VERSION, publicKey: k.publicKey, privateKey: k.privateKey }
}

async function readKeyRecord(db: IDBDatabase): Promise<DeviceKey | null> {
  return withTimeout(
    new Promise<DeviceKey | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY_ID)
      req.onsuccess = () => resolve(normalizeKey(req.result))
      req.onerror = () => reject(req.error)
    }),
    TX_TIMEOUT,
    null,
  )
}

async function writeKeyRecord(db: IDBDatabase, key: DeviceKey): Promise<boolean> {
  return withTimeout(
    new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(key, KEY_ID)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    }).catch(() => false),
    TX_TIMEOUT,
    false,
  )
}

/* ---------- 密钥 / 加解密（导出给单测用：环境里没有 IDB，落盘路径跑不到） ---------- */

/** 本机自签一对 RSA 密钥（同步，1024 位约 0.1s） */
export function createDeviceKey(): DeviceKey {
  const rsa = new JSEncrypt({ default_key_size: KEY_BITS })
  const publicKey = rsa.getPublicKey()
  const privateKey = rsa.getPrivateKey()
  if (!publicKey || !privateKey) throw new Error('本机密钥生成失败')
  return { v: BLOB_VERSION, publicKey, privateKey }
}

/** 用公钥加密口令；超长 / 失败返回空串（调用方据此放弃保存，不写半条） */
export function encryptPassword(publicKey: string, password: string): string {
  if (new TextEncoder().encode(password).length > MAX_PLAIN_BYTES) return ''
  try {
    const rsa = new JSEncrypt()
    rsa.setPublicKey(publicKey)
    const cipher = rsa.encrypt(password)
    return typeof cipher === 'string' ? cipher : ''
  } catch {
    return ''
  }
}

/** 用私钥解回口令；密钥不对 / 密文损坏都返回空串 */
export function decryptPassword(privateKey: string, cipher: string): string {
  try {
    const rsa = new JSEncrypt()
    rsa.setPrivateKey(privateKey)
    const plain = rsa.decrypt(cipher)
    return typeof plain === 'string' ? plain : ''
  } catch {
    return ''
  }
}

/* ---------- 对外 API ---------- */

/**
 * 把密钥准备好，返回「是否已进盘」。
 *
 * 三种情况：内存里已有；盘里有（上次存的）；都没有就现生成再尝试写盘。
 * 写盘失败（隐私模式 / 配额满）只留在内存，返回值 false 让调用方别写密文。
 */
async function ensureKeys(): Promise<boolean> {
  if (keyPair) return keyPersisted
  if (keyTask) return keyTask
  keyTask = (async (): Promise<boolean> => {
    const db = await openDb()
    const saved = db ? await readKeyRecord(db) : null
    if (saved) {
      keyPair = saved
      keyPersisted = true
      return true
    }
    let fresh: DeviceKey
    try {
      fresh = createDeviceKey()
    } catch {
      return false
    }
    keyPair = fresh
    keyPersisted = db ? await writeKeyRecord(db, fresh) : false
    return keyPersisted
  })()
  try {
    return await keyTask
  } finally {
    keyTask = null
  }
}

function readBlob(): CredBlob | null {
  const raw = readRaw(CRED_KEY)
  if (!raw) return null
  try {
    const b = JSON.parse(raw) as Partial<CredBlob>
    if (!b || b.v !== BLOB_VERSION) return null
    if (typeof b.a !== 'string' || !b.a) return null
    if (typeof b.c !== 'string' || !b.c) return null
    return { v: BLOB_VERSION, a: b.a, c: b.c }
  } catch {
    return null
  }
}

/**
 * 记下/清掉「用户勾了记住密码」这个意愿本身。
 *
 * 与密码数据分开：勾选是一次点击就能确定的事，不该等到登录成功才有记录；
 * 反过来，取消勾选要连意愿一起清，否则下次进来会出现「勾着但没密码」。
 */
export function markRemembered(on: boolean): void {
  writeRaw(REMEMBER_KEY, on ? '1' : null)
}

/** 上次是不是勾着「记住密码」（没有密码数据时也能据此把勾选框还原） */
export function isRemembered(): boolean {
  return readRaw(REMEMBER_KEY) === '1'
}

/**
 * 勾选的瞬间先备好密钥（登录页 watch 调用）。
 *
 * 密钥生成是同步且要几十到几百毫秒，放在提交按钮里会让「登录成功 → 回上一页」
 * 之间卡一下；提前到用户点勾选时就做掉，提交路径就只剩一次加密。
 */
export function warmCredentialVault(): void {
  void ensureKeys()
}

/**
 * 保存账号与口令（口令只以密文落盘）。
 *
 * 返回是否真的记住了：`false` 表示连内存都没留下（口令为空 / 加密失败），
 * 调用方不需因此报错 —— 最坏情况就是「这次勾了但没记住」。
 */
export async function saveCredential(account: string, password: string): Promise<boolean> {
  const name = account.trim()
  if (!name || !password) return false
  // 意愿先落：哪怕密文没写成（超长 / 配额满），下次进来也该是勾着的
  markRemembered(true)

  const persisted = await ensureKeys().catch(() => false)
  if (!persisted) {
    // 密钥进不了盘：写密文只会留下一堆解不开的字节，宁可只在本会话记着。
    // 这是「用户明确要保存」的路径，写不进就把旧记录一并清掉，不留半条。
    writeRaw(CRED_KEY, null)
    memRecord = { account: name, password }
    return true
  }

  const cipher = keyPair ? encryptPassword(keyPair.publicKey, password) : ''
  if (!cipher) {
    await clearCredential()
    return false
  }
  const ok = writeRaw(CRED_KEY, JSON.stringify({ v: BLOB_VERSION, a: name, c: cipher } satisfies CredBlob))
  if (!ok) {
    memRecord = { account: name, password }
    return true
  }
  memRecord = null
  return true
}

/**
 * 读回上次记住的凭据。
 *
 * 解不出来（密钥被清掉 / 密文损坏 / 换了机器）就把残渣删掉并返回 null ——
 * 留着只会让下次又白试一遍。
 */
export async function loadCredential(): Promise<SavedCredential | null> {
  const blob = readBlob()
  if (!blob) return memRecord

  const persisted = await ensureKeys().catch(() => false)
  if (!persisted || !keyPair) {
    // 只是**这次**拿不到密钥（IDB 打不开 / 首次超时 / 隐私模式）：别删密文。
    // 删了就真回不来了 —— 下次环境正常时本来还能解开。V2 那边也不存在这种
    // 「读失败即销毁」的行为（它就是两个 PlayerPrefs 键）。
    return memRecord
  }
  const password = decryptPassword(keyPair.privateKey, blob.c)
  if (!password) {
    // 密钥在手却解不开：密钥真换了（清了站点数据又重建）或密文损坏，
    // 留着每次都是白试，删掉残渣；意愿也一起清，别让勾选框空着勾一辈子
    writeRaw(CRED_KEY, null)
    markRemembered(false)
    return null
  }
  return { account: blob.a, password }
}

/**
 * 清除记住的凭据（连同勾选意愿）。
 *
 * **密钥不删**（2026-11-27 改）：
 *   · 它不含任何用户信息，只是一对随机密钥；没有密文，它解不出任何东西；
 *   · 删了下次勾选要重新生成（0.1~0.6s），手机上是能感觉到的停顿；
 *   · 更要紧的是竞态 —— 删密钥是异步的。用户「取消勾选 → 马上又勾上」时，
 *     `ensureKeys()` 可能刚重建了一对，这条迟到的删除会把它删掉：内存以为
 *     已经落盘，冷启动却解不开，表现就是「勾了、也存了，重开却没有」。
 *
 * 所以真正的「清除」只需要密文消失：留着密钥也解不出任何东西。
 */
export async function clearCredential(): Promise<void> {
  memRecord = null
  writeRaw(CRED_KEY, null)
  writeRaw(REMEMBER_KEY, null)
}
