/**
 * 塔机实时推送的同源桥（MQTT-over-WebSocket ↔ 原始 MQTT/TCP）
 *
 * ## 为什么不再转发到厂商的 WS 网关
 *
 * 塔机实时工况原本挂 `ws://115.159.67.12:8084/mqtt`（厂商网关把 MQTT 1883
 * 包了一层 WebSocket）。2026-11-12 17:30 起这条网关路由**持续 502 / 404**，
 * 而同一时刻 `115.159.67.12:1883` 的原始 TCP 端口完全正常、订阅立刻收到三台车
 * 的推送 —— 也就是说数据一直在，坏的是那层 WS 包装。
 *
 * 所以这里改成**自己去连 1883，并对外提供 WebSocket 服务**：
 *
 * ```text
 * 浏览器  ──WS(/mqtt)──▶  本桥  ──TCP(1883)──▶  115.159.67.12
 *          MQTT 字节流                   MQTT 字节流（原样）
 * ```
 *
 * 对前端是零改动的：`src/api/mqttWs.ts` 仍然按「MQTT over WebSocket」说话，
 * 只是对端从厂商网关换成了我们自己。厂商网关哪天修好了也不再依赖它。
 *
 * ## 边界
 *
 * · 只接管一个路径（默认 `/mqtt`，同时兼容带 base 的 `/xycDigitalMap/mqtt`）；
 * · 握手后整条连接只做字节搬运，不解析 MQTT —— 桥不懂协议就不会坏在协议上；
 * · 不校验 Origin：它只在本机/内网网关后面跑，且订阅用的是一次性只读账号。
 *
 * 使用方：`vite.config.ts`（dev / preview）与 `server/serve.mjs`（HTTP 部署）。
 * 两边共用这一份，避免「开发期能用、部署后失效」这类只有上线才发现的问题。
 */

import { createHash } from 'node:crypto'
import { connect as netConnect } from 'node:net'

/** WebSocket 握手固定魔术串（RFC 6455 §1.3） */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 默认上游：塔机平台的 MQTT broker（V2 客户端 `CraneRealtimeRequester` 里写的就是它） */
const DEFAULT_HOST = '115.159.67.12'
const DEFAULT_PORT = 1883

/** 上游 TCP 建连超时 —— 建不上就别把浏览器吊在这儿 */
const CONNECT_TIMEOUT = 10_000

/** 握手失败时的最小响应，省得浏览器一直等 */
function reject(socket, status, text) {
  const body = Buffer.from(text, 'utf8')
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n\r\n` +
      text,
  )
  socket.destroy()
}

/**
 * 服务端 → 浏览器的一帧（服务端帧不加掩码）。
 *
 * 只发 FIN=1 的单帧：MQTT 报文最大也就几百字节，不做分片。
 */
function serverFrame(opcode, payload) {
  const len = payload.length
  let head
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

/**
 * 增量解析浏览器发来的帧（客户端帧一定带掩码，必须解）。
 *
 * 分出 `onMessage`（数据帧，含 continuation 拼包）与 `onControl`
 * （ping / close）。解析出错时返回 false，调用方据此掐断连接。
 */
function makeReader(onMessage, onControl) {
  let buf = Buffer.alloc(0)
  let frag = Buffer.alloc(0)
  let fragOp = 0

  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return true
      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2

      if (len === 126) {
        if (buf.length < 4) return true
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return true
        len = Number(buf.readBigUInt64BE(2))
        off = 10
      }

      const maskLen = masked ? 4 : 0
      if (buf.length < off + maskLen + len) return true
      const mask = masked ? buf.subarray(off, off + 4) : null
      off += maskLen
      const payload = Buffer.from(buf.subarray(off, off + len))
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      }
      buf = buf.subarray(off + len)

      if (opcode === 0x8) {
        onControl('close', payload)
        return true
      }
      if (opcode === 0x9) {
        onControl('ping', payload)
        continue
      }
      if (opcode === 0xa) continue // pong：桥不主动 ping，收到就忽略

      // 数据帧：0x1 文本 / 0x2 二进制 / 0x0 续帧
      if (opcode === 0x0) {
        frag = Buffer.concat([frag, payload])
      } else {
        fragOp = opcode
        frag = payload
      }
      if (fin) {
        if (frag.length) onMessage(fragOp, frag)
        frag = Buffer.alloc(0)
        fragOp = 0
      }
    }
  }
}

/**
 * 在已有的 http.Server 上挂 `/mqtt` 桥。
 *
 * @param {import('node:http').Server} httpServer
 * @param {{ path?: string, host?: string, port?: number, log?: (msg: string) => void }} [opts]
 * @returns {() => void} 卸载函数
 */
export function attachMqttBridge(httpServer, opts = {}) {
  const path = opts.path ?? '/mqtt'
  const suffix = path // 兼容带 base 的路径（/xycDigitalMap/mqtt）
  const host = opts.host ?? DEFAULT_HOST
  const port = opts.port ?? DEFAULT_PORT
  const log = opts.log ?? (() => {})

  const onUpgrade = (req, socket, head) => {
    const pathname = (req.url ?? '/').split('?')[0]
    const mine = pathname === path || pathname.endsWith(suffix)
    if (!mine) return // 其它 upgrade（Vite 的 HMR 等）原样放过

    const key = req.headers['sec-websocket-key']
    if (!key) {
      reject(socket, 400, 'Bad Request')
      return
    }

    // 协议协商：前端带 Sec-WebSocket-Protocol: mqtt，回同样的值，
    // 否则部分实现（含我们自己的客户端）会认为握手不合规
    const asked = String(req.headers['sec-websocket-protocol'] ?? '')
    const proto = asked.split(',').map((s) => s.trim()).includes('mqtt') ? 'mqtt' : ''

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : '') +
        '\r\n',
    )
    // 关掉 Nagle：MQTT 报文小，攒包会让「实时」看起来卡半秒
    socket.setNoDelay?.(true)

    let closed = false
    const pending = [] // 上游还没连上时，浏览器发来的字节先攒着

    const up = netConnect(port, host)
    up.setNoDelay?.(true)
    up.setTimeout(CONNECT_TIMEOUT, () => {
      log(`mqtt bridge: 上游 ${host}:${port} 连接超时`)
      teardown()
    })

    const teardown = () => {
      if (closed) return
      closed = true
      up.destroy()
      socket.destroy()
    }

    up.on('connect', () => {
      up.setTimeout(0) // 连上后不再限时，交给 MQTT 自己的 keepalive
      for (const chunk of pending.splice(0)) up.write(chunk)
    })
    // 上游 → 浏览器：改成二进制帧
    up.on('data', (chunk) => {
      if (!closed) socket.write(serverFrame(0x2, chunk))
    })
    up.on('error', (e) => {
      log(`mqtt bridge: 上游错误 ${e?.code ?? ''} ${e?.message ?? e}`)
      teardown()
    })
    up.on('close', teardown)

    const read = makeReader(
      (_op, payload) => {
        if (closed) return
        if (up.connecting) pending.push(payload)
        else up.write(payload)
      },
      (kind, payload) => {
        if (kind === 'ping') {
          socket.write(serverFrame(0xa, payload))
          return
        }
        // close：回一帧 close 再断，浏览器才不会报 1006
        socket.write(serverFrame(0x8, payload.length ? payload : Buffer.from([0x03, 0xe8])))
        teardown()
      },
    )

    socket.on('data', (chunk) => {
      if (!read(chunk)) teardown()
    })
    socket.on('error', teardown)
    socket.on('close', teardown)

    // 握手包里可能已经带了起始字节（HTTP Upgrade 的 head）
    if (head?.length) read(head)
  }

  // prepend：Vite 自己也监听 upgrade（HMR），排在它前面才拿得到 socket
  httpServer.prependListener('upgrade', onUpgrade)
  return () => httpServer.off('upgrade', onUpgrade)
}

export const MQTT_BRIDGE_DEFAULT = { host: DEFAULT_HOST, port: DEFAULT_PORT }
