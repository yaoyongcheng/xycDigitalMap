/**
 * 极简 MQTT 3.1.1 over WebSocket 客户端
 *
 * ## 为什么要自己写
 *
 * 项目只缺一项能力：**订阅一个主题、收 JSON 推送**。为此引入 `mqtt` / `mqtt.js`
 * 会带来上百 KB 运行时（含 QoS1/2、TLS、遗嘱、会话恢复等本项目永远用不到的分支），
 * 而本项目连 `jsencrypt` 都是能自写就自写。MQTT 3.1.1 的「CONNECT → SUBSCRIBE →
 * 收 PUBLISH → PINGREQ」四件事加起来不到 200 行，写死在这里更可控、可读、可测。
 *
 * ## 为什么是 WebSocket 而不是 1883
 *
 * 浏览器拿不到原始 TCP，只能用 broker 的 WebSocket 监听。本项目现场那台
 * `115.159.67.12:8084/mqtt` 就是 MQTT over WebSocket（与数据服务同端口、不同路径，
 * 2026-11-12 实测可连、可订阅、有真实推送）。
 *
 * ## 只实现到 QoS 0
 *
 * 订阅用 QoS 0（塔机推送本身就是「来了就用、丢了等下一帧」的实时量），
 * 所以不需要 PUBACK、不需要重发队列。收到 QoS>0 的包会把 packetId 读掉再交付，
 * 但**不回复确认** —— 现场 broker 对我们订阅的主题按 QoS 0 投递，够用。
 *
 * ## 有意不做的事
 *
 * · 不做遗嘱、不做会话保持（cleanSession=1，每次连接重建订阅）；
 * · 不解析 topic 通配匹配（只认 broker 投回来的 topic 字符串）；
 * · 不抛异常给上层：连不上就回调 `closed`，由调用方决定重试节奏（见 connect()）。
 */

/** 连接状态（对上层只需要这三种） */
export type MqttState = 'connecting' | 'open' | 'closed'

export interface MqttOptions {
  /** broker 的 WebSocket 地址，如 `ws://host:8084/mqtt` */
  url: string
  /** 客户端标识；同一 broker 上重复会被踢，所以带随机后缀 */
  clientId: string
  username?: string
  password?: string
  /** 要订阅的主题（QoS 0） */
  topics: readonly string[]
  /** 收到消息（payload 按 UTF-8 解出来，二进制帧不处理） */
  onMessage: (topic: string, payload: string) => void
  /** 状态变化；`closed` 之后客户端不再自行重连，交回调用方 */
  onState?: (state: MqttState) => void
  /** 心跳间隔（秒），默认 30 */
  keepalive?: number
}

export interface MqttHandle {
  /** 主动断开；不会触发 onState('closed') 之外的重连 */
  stop: () => void
}

/** 把数字按 MQTT 的「剩余长度」变长编码 */
function encodeLength(n: number): number[] {
  const out: number[] = []
  let v = n
  do {
    let digit = v % 128
    v = Math.floor(v / 128)
    if (v > 0) digit |= 0x80
    out.push(digit)
  } while (v > 0)
  return out
}

function strBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s))
}

/** 定长字段：2 字节长度 + UTF-8 内容 */
function utf8Field(s: string): number[] {
  const b = strBytes(s)
  return [(b.length >> 8) & 0xff, b.length & 0xff, ...b]
}

/** 拼一个完整的报文：首字节 + 剩余长度 + 负载 */
function packet(first: number, body: number[]): Uint8Array {
  return new Uint8Array([first, ...encodeLength(body.length), ...body])
}

/**
 * CONNECT。
 *
 * flags 0x02 = cleanSession；0xC0 = 带用户名 + 密码。
 * 现场 broker 是 `admin / Test@wf.101025`（与 V2 客户端 `CraneRealtimeRequester`
 * 预制体里序列化的值一致，见 docs/api-migration.md）。
 */
function connectPacket(o: MqttOptions): Uint8Array {
  const flags = 0x02 | (o.username ? 0x80 : 0) | (o.password ? 0x40 : 0)
  const keep = o.keepalive ?? 30
  const body = [
    ...utf8Field('MQTT'),
    0x04, // 协议级别 3.1.1
    flags,
    (keep >> 8) & 0xff,
    keep & 0xff,
    ...utf8Field(o.clientId),
  ]
  if (o.username) body.push(...utf8Field(o.username))
  if (o.password) body.push(...utf8Field(o.password))
  return packet(0x10, body)
}

/** SUBSCRIBE：packetId 固定 1（一个连接只订阅一次，不存在复用冲突） */
function subscribePacket(topics: readonly string[]): Uint8Array {
  const body: number[] = [0x00, 0x01]
  for (const t of topics) body.push(...utf8Field(t), 0x00) // QoS 0
  return packet(0x82, body)
}

const PINGREQ = new Uint8Array([0xc0, 0x00])

/**
 * 连接并订阅。
 *
 * 返回值为句柄；连接失败 / 断开时只通过 onState 通知，不 throw。
 */
export function connectMqtt(o: MqttOptions): MqttHandle {
  let ws: WebSocket | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  /**
   * 连接协商状态。
   *
   * 注意不能「收到数据后回头再看缓冲区」判断 CONNACK —— `feed()` 会把已消费的
   * 字节从缓冲区切掉，回头再看就只剩空数组了（首版就栽在这里：握手成功却从不订阅）。
   * 所以在解析函数里就地记下返回码。
   */
  let connack: number | null = null
  let subscribed = false

  const emit = (s: MqttState) => o.onState?.(s)

  /** 解析一个完整报文；返回已消费的字节数，不够一个包时返回 -1 */
  function readPacket(buf: Uint8Array, from: number): number {
    if (buf.length - from < 2) return -1
    const first = buf[from]
    // 剩余长度：最多 4 字节，每字节 7 位
    let len = 0
    let mul = 1
    let i = from + 1
    for (let n = 0; n < 4; n++) {
      if (i >= buf.length) return -1
      const d = buf[i++]
      len += (d & 0x7f) * mul
      mul *= 128
      if ((d & 0x80) === 0) break
    }
    if (buf.length - i < len) return -1

    const type = first >> 4
    const body = buf.subarray(i, i + len)

    if (type === 2 && body.length >= 2) {
      // CONNACK：body[0] 是 ack flags，body[1] 是返回码（0 = 接受）
      connack = body[1]
    } else if (type === 3 && body.length >= 4) {
      // PUBLISH：2 字节主题长度 + 主题 + [QoS>0 时 2 字节 packetId] + 负载
      const qos = (first >> 1) & 0x03
      const tLen = (body[0] << 8) | body[1]
      let p = 2
      const topic = new TextDecoder().decode(body.subarray(p, p + tLen))
      p += tLen
      if (qos > 0) p += 2
      const payload = new TextDecoder().decode(body.subarray(p))
      if (topic) o.onMessage(topic, payload)
    }
    return i + len - from
  }

  /** 字节流可能把多个报文粘在一起，也可能把一个报文切开 —— 用缓冲区累加 */
  let acc = new Uint8Array(0)
  function feed(chunk: ArrayBuffer): void {
    const incoming = new Uint8Array(chunk)
    const merged = new Uint8Array(acc.length + incoming.length)
    merged.set(acc, 0)
    merged.set(incoming, acc.length)
    acc = merged
    let offset = 0
    for (;;) {
      const used = readPacket(acc, offset)
      if (used <= 0) break
      offset += used
    }
    if (offset > 0) acc = acc.subarray(offset)
  }

  function start(): void {
    if (stopped) return
    emit('connecting')
    acc = new Uint8Array(0)
    connack = null
    subscribed = false
    let socket: WebSocket
    try {
      // 子协议必须是 mqtt，否则多数 broker 直接拒绝握手
      socket = new WebSocket(o.url, 'mqtt')
    } catch {
      emit('closed')
      return
    }
    socket.binaryType = 'arraybuffer'
    ws = socket

    socket.onopen = () => {
      socket.send(connectPacket(o))
    }
    socket.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return
      feed(ev.data)
      // 握手回执到了且还没订阅过：校验返回码、订阅、置为 open
      if (connack !== null && !subscribed) {
        if (connack !== 0) {
          emit('closed')
          socket.close()
          return
        }
        subscribed = true
        socket.send(subscribePacket(o.topics))
        emit('open')
        if (timer) clearInterval(timer)
        timer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(PINGREQ)
        }, (o.keepalive ?? 30) * 1000)
      }
    }
    socket.onclose = () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (ws === socket) ws = null
      emit('closed')
    }
    socket.onerror = () => {
      // 交给 onclose 统一收口；这里只避免控制台抛未处理错误
    }
  }

  start()

  return {
    stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      const s = ws
      ws = null
      try {
        s?.close()
      } catch {
        // 已经关掉了，忽略
      }
    },
  }
}
