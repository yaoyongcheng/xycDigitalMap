import { JSEncrypt } from 'jsencrypt'

import { ApiError } from './http'

/**
 * 登录载荷加密（对齐 Unity 端 RsaEncryptUtil）
 *
 * 原实现：BouncyCastle `Pkcs1Encoding(RsaEngine)`，UTF-8 取明文，输出 Base64。
 * 这里必须用 PKCS#1 v1.5 而不是 OAEP —— WebCrypto 只给 RSA-OAEP 做加密，
 * PKCS#1 v1.5 的 encrypt 已被规范移除，所以走 jsencrypt（纯 JS 大数实现）。
 *
 * 密钥 1024 位（服务端 public-key 接口下发的是 1024 位 PEM），单块明文上限
 * 128 − 11 = 117 字节，超了服务端也解不了；在本地先拦一次，给出可读提示。
 */

/** RSA 1024 + PKCS#1 v1.5 的单块明文上限 */
export const MAX_PLAIN_BYTES = 117

/** 把对象序列化成 JSON 并加密成 Base64 密文 */
export function encryptLoginPayload(pem: string, payload: unknown): string {
  const json = JSON.stringify(payload)
  const size = new TextEncoder().encode(json).length
  if (size > MAX_PLAIN_BYTES) {
    throw new ApiError(
      0,
      `账号或密码过长（${size}/${MAX_PLAIN_BYTES} 字节），请缩短后重试`,
    )
  }

  const rsa = new JSEncrypt()
  rsa.setPublicKey(pem)
  const cipher = rsa.encrypt(json)
  if (!cipher) throw new ApiError(0, '登录请求加密失败，请稍后重试')
  return cipher
}
