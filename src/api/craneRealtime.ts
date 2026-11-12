/**
 * 塔机实时工况（MQTT 推送）
 *
 * ## 数据从哪来（2026-11-12 实测，与 V2 客户端同源）
 *
 * V2 `场景 / 塔机2 / 实时数据` 上挂着 `CraneRealtimeRequester`，它序列化的字段是：
 *
 * ```
 * host = 115.159.67.12   port = 1883   userName = admin   password = Test@wf.101025
 * topic = /P000000076/towercranedataservice/pushRealTimeInfo
 * offlineTimeout = 25.0  checkInterval = 3.0
 * ```
 *
 * 注意是 **`115.159.67.12`**（登录/数据服务那台），不是早期排查时连过的
 * `120.26.34.95` —— 那台只有「光谷元箸」4 台车在推，从来没有本项目的消息。
 * 连对了以后本项目三台塔机（EW2/EW3/EW4）每 10 秒左右推一帧真实报文：
 *
 * ```json
 * {"angle":223.79,"range":17.67,"height":6.10,"monitorDateTime":"2026-11-12 16:30:46.951",
 *  "bodyHeight":42.0,"topHeight":56.0,"weight":0.0,"weightRate":0.0,"windSpeed":0.0,
 *  "deviceSn":"…EW2","deviceName":"向阳村2#塔机","siteName":"武汉向阳村项目", …}
 * ```
 *
 * `bodyHeight` 42.0 正好等于 V2 弹层里「塔机高度 42.00m」—— 说明 V2 的塔机高度
 * 取的是实时报文的塔身高度，**不是**台账 `extra_fields` 里的「高度」（10.3m）。
 *
 * ## 浏览器怎么连
 *
 * 原始 TCP 1883 浏览器碰不到，历史上是连厂商网关的 `ws://115.159.67.12:8084/mqtt`。
 * 那条网关路由 2026-11-12 傍晚起间歇 404/502（而 1883 一直正常），所以现在由
 * 我们自己的服务端当 WS 端点、直连 broker（`server/mqttBridge.mjs`）：
 *
 *   · `npm run dev` / `npm run preview` —— 同源 `/mqtt`，可用；
 *   · `npm run deploy:http` —— 同源 `/mqtt`，可用（现场 HTTP 部署就是这条路）；
 *   · GitHub Pages（HTTPS 静态托管，无服务端）—— 连不上，四行回落「—」。
 * 换部署方式时用 `VITE_CRANE_WS` 直接指一个可用的 wss 地址即可。
 *
 * 对这里没有区别：始终按「MQTT over WebSocket」说话，对端是谁由部署方式决定。
 */

import { connectMqtt, type MqttState } from './mqttWs'
import { SCENE_CODE } from './config'

/** 推送主题：`/{项目码}/towercranedataservice/pushRealTimeInfo`（V2 预制体里是这个拼法） */
export const CRANE_MQTT_TOPIC = `/${SCENE_CODE}/towercranedataservice/pushRealTimeInfo`

/** broker 账号（V2 客户端写死的那一组，只读订阅用） */
const MQTT_USER = 'admin'
const MQTT_PASSWORD = 'Test@wf.101025'

/** 一帧实时工况（只取弹层要用的字段，其余留在原始报文里） */
export interface CraneRealtime {
  /** 塔机平台设备编号 */
  sn: string
  /** 平台侧设备名（「向阳村2#塔机」），仅排查用 */
  deviceName: string
  /** 上报时刻，报文原样：`2026-11-12 16:19:16.956` */
  at: string
  /** 回转角度 ° */
  angle: number
  /** 幅度（小车行程）m */
  range: number
  /** 吊钩高度 m */
  height: number
  /** 吊重 t */
  weight: number
  /**
   * 重量利用率（负荷率）—— V2 报文里的 `weightRate`，卡片「当前负荷 36%」就是它。
   *
   * 单位有歧义：协议上是比值（0~1，与 Unity `Image.fillAmount` 同口径），
   * 但现场设备也可能直接给百分数。这里**原样保留**，归一放在
   * `utils/craneLoad.ts: loadPct`，解析层不猜。
   */
  weightRate: number
  /** 是否带载（报文 `hasLoadInfo`）—— V2 `CraneData.HasLoad` 就是它，判「正在吊装」用 */
  hasLoad: boolean
  /** 塔身高度 m —— V2 弹层「塔机高度」就是它 */
  bodyHeight: number
  /** 塔顶高度 m */
  topHeight: number
}

/**
 * broker 的 WebSocket 地址。
 *
 * 默认同源：页面在 5173 / 8080 上时，同源 `/mqtt` 由反代转发到 broker。
 * 页面在 HTTPS 而反代不存在时，`wss://<host>/mqtt` 会握手失败 —— 上层按
 * 「没数据」处理，不报错、不弹窗。
 */
export function craneRealtimeUrl(): string {
  const override = (import.meta.env.VITE_CRANE_WS as string | undefined)?.trim()
  if (override) return override
  if (typeof window === 'undefined') return ''
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/mqtt`
}

/** 宽松取数：报文里数字有时是字符串，取不到就 0（不让一行脏值毁掉整帧） */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 解析一帧推送。
 *
 * 脏帧返回 null（**不抛**）—— MQTT 主题上可能混入别的设备的报文，
 * 静默丢弃比让弹层崩掉好。缺 `deviceSn` 的帧一律丢：没有 key 就没法归到某台设备。
 */
export function parseCraneRealtime(payload: string): CraneRealtime | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const sn = String(raw.deviceSn ?? '').trim()
  if (!sn) return null
  return {
    sn,
    deviceName: String(raw.deviceName ?? ''),
    at: String(raw.monitorDateTime ?? ''),
    angle: num(raw.angle),
    range: num(raw.range),
    height: num(raw.height),
    weight: num(raw.weight),
    weightRate: num(raw.weightRate),
    hasLoad: raw.hasLoadInfo === true || raw.hasLoadInfo === 1 || raw.hasLoadInfo === 'true',
    bodyHeight: num(raw.bodyHeight),
    topHeight: num(raw.topHeight),
  }
}

export interface CraneRealtimeHandlers {
  onData: (frame: CraneRealtime) => void
  onState?: (state: MqttState) => void
}

/**
 * 订阅塔机实时推送，返回停止函数。
 *
 * 断线自愈放在这里而不是 mqttWs：客户端只管一次连接的生命周期，
 * 重试节奏（2s → 4s → 8s → 15s 封顶）属于业务策略。
 * `stop()` 之后不再重连（`stopped` 置位，正在排的定时器也会被清掉）。
 */
export function subscribeCraneRealtime(h: CraneRealtimeHandlers): () => void {
  const url = craneRealtimeUrl()
  if (!url) return () => {}

  let stopped = false
  let handle: { stop: () => void } | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let delay = 2000

  const open = () => {
    if (stopped) return
    // clientId 带随机后缀：同 id 会把上一个连接踢下线，多标签页会互相打架
    const clientId = `xyc-web-${Math.random().toString(36).slice(2, 10)}`
    handle = connectMqtt({
      url,
      clientId,
      username: MQTT_USER,
      password: MQTT_PASSWORD,
      topics: [CRANE_MQTT_TOPIC],
      onMessage: (_topic, payload) => {
        const frame = parseCraneRealtime(payload)
        if (frame) h.onData(frame)
      },
      onState: (state) => {
        h.onState?.(state)
        if (state === 'open') {
          delay = 2000
          return
        }
        if (state === 'closed' && !stopped) {
          if (retry) clearTimeout(retry)
          retry = setTimeout(open, delay)
          delay = Math.min(delay * 2, 15000)
        }
      },
    })
  }

  open()

  return () => {
    stopped = true
    if (retry) {
      clearTimeout(retry)
      retry = null
    }
    handle?.stop()
    handle = null
  }
}
