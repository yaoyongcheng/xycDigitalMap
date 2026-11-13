#!/usr/bin/env node
/**
 * 纯 HTTP 静态部署（零依赖）
 *
 * 为什么需要它：GitHub Pages 对 *.github.io 强制 HTTPS，控制台里没有关闭开关，
 * 而现场接口只开了 http://115.159.67.12:8081 —— HTTPS 页面调 HTTP 接口会被浏览器
 * 按「混合内容」拦掉（登录页上那条橙色提示即此意）。要真正消除这个组合，
 * 只能把页面也放到 HTTP 下，也就是用本脚本自托管。
 *
 * 刻意与 vite preview 分开写：
 *   - vite preview 是开发工具，证书、缓存、目录穿越这些都不管；
 *   - 这里要能直接扔到内网机器上长期跑（工地一台小主机 / 现场服务器）。
 *
 * 用法：
 *   node server/serve.mjs                    # 默认 8080，目录 dist
 *   node server/serve.mjs --port 80          # 80 端口（可能需管理员权限）
 *   node server/serve.mjs --dir dist --base /xycDigitalMap/
 *
 * 也可以 npm run serve:http / npm run deploy:http（先构建再起服务）。
 *
 * 注意（浏览器规范，非本脚本能绕过）：纯 HTTP 访问的是「非安全上下文」，
 * 以下能力会失效 —— 这是 HTTP 部署的固有代价，不是 bug：
 *   ① Service Worker 不注册 → 没有离线缓存、不能「添加到主屏幕」当 App 用；
 *   ② navigator.share 不可用 → 航拍/巡检的「下载」回退成 a[download] 落文件，
 *      不再弹系统分享面板存相册；
 *   ③ 剪贴板、地理位置等 API 受限。
 * 若要保留这些能力，只能回到 HTTPS（给接口配 HTTPS，或在同域加一层反代），
 * 后者的做法见 README「部署」一节。
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { attachMqttBridge, MQTT_BRIDGE_DEFAULT } from './mqttBridge.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 命令行参数：--port / --dir / --base / --host */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return fallback
}

const PORT = Number(arg('port', process.env.PORT ?? 8080))
const HOST = arg('host', '0.0.0.0')

/**
 * 站点挂载路径。
 *
 * 与 vite.config.ts 的 base 保持一致（构建产物里的资源引用写死了
 * /xycDigitalMap/），所以直接复用同一份 dist 即可，不需要为 HTTP 再构建一次。
 * 根路径 / 会 302 到这里。
 */
const RAW_BASE = arg('base', '/xycDigitalMap/')
const BASE = `/${RAW_BASE.replace(/^\/+|\/+$/g, '')}/`

const DIR = path.resolve(ROOT, arg('dir', 'dist'))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/**
 * 缓存策略：
 *   assets/ 下是带内容哈希的文件名，可永久缓存；
 *   sw.js 必须每次回源，否则新版本永远发现不了；
 *   HTML 同理（它决定引用哪几个哈希文件）。
 */
function cacheControl(rel) {
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable'
  if (rel === 'sw.js' || rel === 'index.html' || rel.endsWith('.html')) return 'no-cache'
  return 'public, max-age=3600'
}

function send(res, status, body, headers = {}, method = 'GET') {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
  if (method === 'HEAD') res.end()
  else res.end(body)
}

function serveFile(req, res, file, rel) {
  const stat = statSync(file)
  const ext = path.extname(file).toLowerCase()
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControl(rel),
    // 站点是纯静态资源，禁掉 MIME 嗅探；同时给字体/图片留跨源余地
    'X-Content-Type-Options': 'nosniff',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
}

/**
 * 塔机数据服务反代（`/crane-api/*` → `tciccs:30400`）
 *
 * 为什么非反代不可：那台主机**没有放行任何跨域来源** —— 带 `Origin` 的预检
 * `OPTIONS` 一律 `403 Invalid CORS request`，正常 POST 的响应里也没有
 * `Access-Control-Allow-Origin`。浏览器因此读不到响应体，而 Postman / curl
 * 不执行同源策略，看上去就成了「Postman 能调、页面调不通」。
 *
 * 边界收得很紧：只转发这一个前缀、只接受 POST、请求体上限 64KB ——
 * 它不是一个通用开放代理。前端侧对应 `src/api/towerCrane.ts` 的 `CRANE_BASE`；
 * 开发期由 vite.config.ts 的 `server.proxy` 承担同一件事。
 */
const CRANE_PREFIX = '/crane-api'
const CRANE_UPSTREAM = 'https://tciccs.cscec3bxjy.cn:30400'
const PROXY_MAX_BODY = 64 * 1024

/**
 * 物联网网关「换令牌」接口的反代（`/iot-api/*` → `iot.cscec3b-iti.com`）
 *
 * 与塔机不同，这里**只有换令牌那一跳有问题**：这个云网关的
 * `POST /api/webgateway/v1/access/token` 没进 CORS 过滤链 ——
 * 预检 `OPTIONS` 一律 403 且不回任何 `Access-Control-*` 头，
 * 实际响应的 `Access-Control-Allow-Origin` 也是空的（2026-11-13 实测，
 * localhost / *.github.io / null 各种 Origin 全试过）。
 *
 * 而它的数据接口 `/api/data/v1/tsdb/*` CORS 是好的：预检 200、
 * `allow-headers: content-type, x-app-user`、响应回显 origin 且
 * `allow-credentials: true`。所以**数据查询继续让浏览器直连**，
 * 只有换令牌走这层反代 —— 几百 KB 的工况帧没必要绕一圈。
 *
 * 不反代会怎样：`fetch` 在预检阶段就被浏览器拦掉，抛 TypeError，
 * 连 HTTP 状态码都拿不到 → 页面既没有数据也无法判定「凭证失效」。
 * 这正是「curl 能查、页面全横杠」的成因。
 *
 * ⚠️ 前提：GitHub Pages 是纯静态托管，没有这层反代 —— 那种部署下
 * 电梯数据拿不到，除非原厂给 token 接口补上 CORS。
 */
const IOT_PREFIX = '/iot-api'
const IOT_UPSTREAM = 'https://iot.cscec3b-iti.com'

/** 读请求体（带大小上限，超了直接掐掉连接） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > PROXY_MAX_BODY) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function proxyPost(req, res, url, prefix, upstream, timeoutMs = 20_000) {
  const method = req.method ?? 'POST'
  if (method !== 'POST') {
    send(res, 405, 'Method Not Allowed', { Allow: 'POST' }, method)
    return
  }

  let body
  try {
    body = await readBody(req)
  } catch {
    send(res, 413, 'Payload Too Large', {}, method)
    return
  }

  const target = upstream + url.pathname.slice(prefix.length) + url.search
  try {
    const up = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] ?? 'application/json; charset=UTF-8',
        Accept: 'application/json',
      },
      body,
      // 上游是公网 + 网关，给宽一点；超时按 502 回报，页面按「没数据」处理
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await up.text()
    res.writeHead(up.status, {
      'Content-Type': up.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(text)
  } catch (e) {
    send(res, 502, `Bad Gateway: ${e?.message ?? e}`, {}, method)
  }
}

/**
 * 塔机实时推送的同源桥（`/mqtt`）
 *
 * 页面的基址是另一台主机，直连 `115.159.67.12:8084/mqtt` 就是跨源 + 混合内容，
 * 统一挂到同源 `/mqtt`。桥本身见 `server/mqttBridge.mjs`：
 * **本机直连 broker 的 TCP 1883，对外提供 WebSocket**，不再经厂商的 WS 网关
 * （那条路由 2026-11-12 傍晚起持续 502/404，而 1883 一直正常）。
 *
 * 只接管 `/mqtt` 一条路径，别的 upgrade 请求直接放过。
 */
const MQTT_PATH = '/mqtt'
const MQTT_HOST = MQTT_BRIDGE_DEFAULT.host
const MQTT_PORT = MQTT_BRIDGE_DEFAULT.port

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET'

  // 用固定 base 解析，避免 req.url 里的绝对形式（代理场景）被当成外部地址
  let url
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    send(res, 400, 'Bad Request', {}, method)
    return
  }

  // 反代要排在「只接受 GET/HEAD」之前 —— 它本身就是 POST
  if (url.pathname === CRANE_PREFIX || url.pathname.startsWith(`${CRANE_PREFIX}/`)) {
    await proxyPost(req, res, url, CRANE_PREFIX, CRANE_UPSTREAM)
    return
  }

  // 物联网网关换令牌（只有这一跳缺 CORS，数据接口仍由浏览器直连）
  if (url.pathname === IOT_PREFIX || url.pathname.startsWith(`${IOT_PREFIX}/`)) {
    await proxyPost(req, res, url, IOT_PREFIX, IOT_UPSTREAM, 25_000)
    return
  }

  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' }, method)
    return
  }

  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    send(res, 400, 'Bad Request', {}, method)
    return
  }

  // 根路径与裸目录跳到站点入口，省得用户手打子路径
  if (pathname === '/' || pathname === BASE.slice(0, -1)) {
    res.writeHead(302, { Location: BASE })
    res.end()
    return
  }

  if (!pathname.startsWith(BASE)) {
    send(res, 404, 'Not Found', {}, method)
    return
  }

  let rel = pathname.slice(BASE.length)
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'

  // 目录穿越防护：解析后必须仍在 dist 内
  const target = path.resolve(DIR, rel)
  if (target !== DIR && !target.startsWith(DIR + path.sep)) {
    send(res, 403, 'Forbidden', {}, method)
    return
  }

  if (existsSync(target) && statSync(target).isFile()) {
    serveFile(req, res, target, rel)
    return
  }

  // 单页应用回退：不带扩展名的路径一律交给 index.html（本项目其实就是单页，
  // 但保留这条以免以后加路由就 404）
  if (!path.extname(rel)) {
    const index = path.join(DIR, 'index.html')
    if (existsSync(index)) {
      serveFile(req, res, index, 'index.html')
      return
    }
  }

  send(res, 404, 'Not Found', {}, method)
})

/** 局域网 IPv4 地址：手机要在同一 WiFi 下用它访问 */
function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

if (!existsSync(path.join(DIR, 'index.html'))) {
  console.error(`\n找不到构建产物：${path.join(DIR, 'index.html')}`)
  console.error('请先执行 npm run build（或直接 npm run deploy:http，它会先构建再起服务）。\n')
  process.exit(1)
}

// 塔机实时推送走 WebSocket upgrade，必须在 listen 之前挂上
attachMqttBridge(server)

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用，换一个：node server/serve.mjs --port 8081\n`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, HOST, () => {
  const urls = [`http://localhost:${PORT}${BASE}`]
  for (const ip of lanAddresses()) urls.push(`http://${ip}:${PORT}${BASE}`)

  console.log('\nHTTP 部署已启动（非 HTTPS，接口可直接用 http://）\n')
  console.log(`  本机     ${urls[0]}`)
  urls.slice(1).forEach((u, i) => {
    console.log(`  ${i === 0 ? '局域网  ' : '        '} ${u}${i === 0 ? '   ← 手机同 WiFi 用这个' : ''}`)
  })
  console.log(`\n  静态目录 ${DIR}`)
  console.log(`  接口地址 ${process.env.VITE_API_BASE || 'http://115.159.67.12:8081'}（构建时写入）`)
  console.log(`  同源反代 ${CRANE_PREFIX}/* → ${CRANE_UPSTREAM}（塔机工作循环，那边不放行跨域）`)
  console.log(`  同源桥   ${MQTT_PATH} → mqtt://${MQTT_HOST}:${MQTT_PORT}（塔机实时工况推送，本机直连 broker）`)
  console.log('\n  提示：HTTP 属非安全上下文，Service Worker 不注册（无离线/PWA 安装）、')
  console.log('        navigator.share 不可用（「存相册」回退为下载文件）。\n')
})
