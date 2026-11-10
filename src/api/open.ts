/**
 * 智慧工地「大屏 open」接口客户端（`https://dw.yzw.cn/open`）
 *
 * 这是现场平台的**只读数据源**，与 `src/api/http.ts`（:8081 的用户/业务接口）是两
 * 套完全不同的鉴权：
 *
 *   1. :8081 那条走用户登录拿 token，请求头 `Authorization: Bearer {token}`；
 *   2. 这里走「项目级 accessKey + RSA 签名」，没有用户概念，也不需要登录。
 *
 * 签名规则（与 Unity 端 `PersonApiHelper.GetTargetUrl` 逐字节一致，已用同一输入
 * 比对过 JSEncrypt 与 OpenSSL 的签名结果）：
 *
 *   timestamp = 当前 Unix 毫秒（字符串）
 *   nonce     = 32 位十六进制（Guid.ToString("N")）
 *   sign      = Base64( RSA-SHA256( accessKey + timestamp + nonce ) )，PKCS#1 v1.5
 *   最终 URL  = baseUrl + apiPath
 *             + "?projectKey=..&accessKey=..&timestamp=..&nonce=..&sign=<urlencode>"
 *
 * 关于私钥：原厂方案就是把私钥内嵌在客户端（桌面端同样如此），这里照搬只是
 * 为了数据能出来。它保护的是「不被公开抓取」，而不是「不可伪造」—— 任何拿到
 * 包体的人都能签。真要做到可控，应当由服务端代理签名（把 key 放服务器），
 * 前端只调 `/proxy/yzw/...`。这一点记在 docs/api-migration.md 的遗留项里。
 */

import JSEncrypt from 'jsencrypt'

/** 项目级 accessKey（原 PersonApiHelper.AccessKey） */
const ACCESS_KEY = 'be69162bdd4e46619ac95824a88b1ec2'

/** 项目 key（原 PersonApiHelper.ProjectKey） */
const PROJECT_KEY = 'b35df2e91ed642c595ca96d0bc2d9ed9'

/** 签名私钥（原 PersonApiHelper.PrivateKey，PKCS#8） */
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAwggJcAgEAAoGBAMjBwnRaM3p+uDJQ0WsESmaOIbgNOtvkIMacRuJK+okoIqJFeWQhjPvimnTaQdvHFuYemaLllkH5tWNTlxM4cwSDw7OISc/2wGcfn8jX+QWu46MohsfNGudBG+/izia3I3QtwZmlSDBRjOYK2KbmO853zMxZnyj2b5lLCo/nixnjAgMBAAECgYAPbPf2MCu7DCHQiyFneDDUhYC1kp3eevGolFlL/QsYK+A3y/loxlbKnSq7sz0scbVJB4cYzn+HrUDEE46AGK4zQt5B4EAqtDsyC0Lwjpo2O4ObrLPeSN+CehUZ4fnXqnPq+/+vwjflzysYPh8ij7FYGOhme2QpPgBlVNX9zYlQgQJBAOMFE3jN2WazdXZfmfQIJPjC6F0fIEhXgSyhqpxeB5iMOyu5jmI2HhMVmqUogvj3WNjwxeuO87DpoMDehoBBQIECQQDiYmt9UMEEIw3ko6zklUM6KOJuf4CuniCplW9B7W14QgSYF/fjQ+5J6MHSPIR5n4JSc5ih72qgfobSHtj+uyhjAkB8iLlQyKNcyk9CW1lJ2/nkGI99HekIpi/vOtQrqQ1DqpF+//BSgdtnnq9RsHKAfrdXcmUwPiACSXbstmVUD/eBAkBHNPnmcu4jZPtLvYf2ZlS9CHsgko5hXm+bp9tU+1+BghJ73J4mKAndyY6dmFd7Agc19BJAbVQ2o1W45ecPSMNNAkEAmxqzT4nt0pujXBP5XsLuta0WT9XszMNC1yJef1kcTCMHQGntmNHhD/oOheGyFGc+hOB6AfZbAim9GyCgBxQDMQ==
-----END PRIVATE KEY-----`

/** 开放接口根地址 */
const OPEN_BASE = 'https://dw.yzw.cn/open'

/** 单次请求超时：现场 4G 抖动时不要一直挂着 loading */
const TIMEOUT = 10_000

/** 开放接口统一信封（注意 `success` / `successful` 两种拼写都存在，实测如此） */
interface OpenEnvelope<T> {
  statusCode?: number
  success?: boolean
  successful?: boolean
  message?: string
  data?: T
}

/** 签名器只建一次：RSA 密钥解析是纯 CPU 活，每次请求重建会明显拖慢首屏 */
let signer: JSEncrypt | null = null

function getSigner(): JSEncrypt {
  if (!signer) {
    signer = new JSEncrypt()
    signer.setPrivateKey(PRIVATE_KEY)
  }
  return signer
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    // 极老的 WebView 没有 getRandomValues；nonce 只用于防重放，弱随机也可接受
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 生成带签名的完整 URL。
 *
 * 导出仅为单测可直接断言签名串，业务侧请用 `openGet`。
 */
export function signedUrl(apiPath: string, params: Record<string, string | number | undefined> = {}): string {
  const timestamp = String(Date.now())
  const nonce = randomNonce()
  // signSha256 = RSA(PKCS#1 v1.5) + SHA-256 + Base64，与 Unity 的 "SHA256withRSA" 一致
  const signature = getSigner().signSha256(ACCESS_KEY + timestamp + nonce)
  if (!signature) throw new Error('签名失败')

  const url = new URL(OPEN_BASE + apiPath)
  url.searchParams.set('projectKey', PROJECT_KEY)
  url.searchParams.set('accessKey', ACCESS_KEY)
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('sign', signature)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
  }
  return url.toString()
}

/**
 * 只读 GET。`statusCode` 不是 20000 视为业务失败（实测 57007 = 接口权限未获取）。
 */
export async function openGet<T>(
  apiPath: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(signedUrl(apiPath, params), { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as OpenEnvelope<T>
    if (body.statusCode !== 20000) {
      throw new Error(body.message || `接口返回 ${body.statusCode ?? '未知'} `)
    }
    return body.data as T
  } finally {
    window.clearTimeout(timer)
  }
}
