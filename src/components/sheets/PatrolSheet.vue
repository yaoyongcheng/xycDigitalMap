<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import PanoViewer from '@/components/ui/PanoViewer.vue'
import { PANO_SHEET_ID, PATROL_DETAIL_SCOPE, usePatrolStore } from '@/stores/patrol'
import { useShellStore } from '@/stores/shell'
import { useLandscape } from '@/utils/landscape'
import { isEquirect, panoLabel } from '@/utils/pano'
import { fetchDetailOriginal } from '@/utils/photoOriginal'
import { patchDetailMeta } from '@/utils/photoDetailCache'
import { useImageZoom } from '@/utils/zoom'

/**
 * 巡检大图（2026-11 阶段 8 起是真实航拍照片）
 *
 * ## 详情就是原图（2026-11-23 现场口径，第三次收敛）
 *
 * 真实原图单张 4~8MB。历次口径是：点开就拉原图（白屏十几秒）→「缩略图 + 点按钮
 * 看原图」→ 后台预取一档 3840 预览 → **现在：打开详情直接加载原图，不再有按钮**。
 *
 *   1. 打开的那一帧先铺**缩略图**（370~520KB，列表里加载过，通常命中浏览器缓存，
 *      零请求），不会白屏；
 *   2. 同时就开始拉原图：画布底边一条进度带（真实字节，不是估算动画），
 *      左上角角标写「原图 42%」；
 *   3. 下完先解码再换源 —— 换上去就是现成像素，不闪白、不重置缩放。
 *
 * 进度是真的：`utils/blobFetch.ts` 读流里的已收字节 / `Content-Length`
 * （OSS 两个域名都回 ACAO，实测可跨域读）。拉不到就退回直接把直链塞给 `<img>`
 * —— 慢是慢，但图还是会出来（此时没有进度可报，角标直接写「原图」）。
 *
 * ## 两种「全景」，别搞混
 *
 * 1. **项目全景**（`PANO_SHEET_ID`）：来自重建成果接口的**拼接好的等距圆柱图**
 *    （预览 3162×1581 / 原图 10000×5000），这里只是把它贴到球面上；
 * 2. **照片墙里的单张全景**：万一媒体里出现 2:1 的图，按几何形状认出来
 *    （`utils/pano.ts` 的 `isEquirect`）也进球面 —— 平台目前没有这种图。
 *
 * 两条路最终都是 `ui/PanoViewer.vue`（手写 WebGL 球面，拖拽 / 双指 / 滚轮，
 * 无 WebGL 退成平面 + 双指缩放并补一句说明）。
 */
const props = defineProps<{ id: string }>()

const shell = useShellStore()
const patrol = usePatrolStore()

const photo = computed(() => patrol.photoById(props.id))

/* ---------- 项目全景（平台拼好的等距圆柱成果，2026-11-16） ---------- */

/**
 * 打开的是不是「项目全景」。
 *
 * 全景来自**重建成果**（不是某一张媒体），没有照片 id，所以用保留 id `pano`
 * 打开；真正的内容从 store 的 `pano` 拿。
 */
const isPanoView = computed(() => props.id === PANO_SHEET_ID && Boolean(patrol.pano))

/**
 * 全景的**拼接完成**时间（任务的 `endTime`，不是 `createTime`，见 `api/drone.ts`
 * 的 `DronePano.time`）。V2 的重建成果列表显示的也是这个时刻。
 */
const panoTime = computed(() => (patrol.pano?.time ?? '').slice(0, 16).replace('T', ' '))

/**
 * 2026-11-24：详情里不再显示照片体积。
 *
 * 原来这里还有一个 `panoSize`（全景原图字节数）与 photo 那边的 `sizeText`，
 * 现在是给弹层里那行「大小 11.4MB」用的；那行已按要求删除，两个 computed
 * 随之摘掉 —— 列表卡片上的体积照旧（那是列表信息，不是详情信息）。
 */

/**
 * 这张全景属于哪个项目。
 *
 * 全景按 V2 的口径取**全平台最新**（不按项目筛），所以可能不是本项目拍的 ——
 * 项目名必须显式写出来。服务端没给项目名时退回任务名前段（`光谷元著-全景`）。
 */
const panoProject = computed(() => {
  const p = patrol.pano
  if (!p) return '—'
  return p.projectName || panoLabel(p.taskName)
})

/**
 * 全景默认显示**预览图**（3162×1581，约 185KB，OSS 缩略图桶）。
 *
 * 原图是 10000×5000（约 13MB）—— 一进页面就拉十几 MB 不合适，做成和照片
 * 一样的「先看预览，要看细节再看高清」。两张都是 2:1 等距圆柱，球面不用变。
 */
const panoHd = ref(false)
/** 高清已切过去、但贴图还没上屏（解码 / 上传中），贴图没到位前旧图继续显示，不闪 */
const panoHdWait = ref(false)
/** 高清那张的本地 objectURL（下载完成后才有；拉不到时为空，退回直链） */
const panoHdUrl = ref('')
/** 高清下载进度 0~100（服务端没给长度时停在 0，按钮显示「高清加载中」） */
const panoHdPct = ref(0)
const panoHdBusy = ref(false)
const panoSrc = computed(() => {
  const p = patrol.pano
  if (!p) return ''
  if (panoHd.value) return panoHdUrl.value || p.full || p.preview
  return p.preview
})

/** 图彻底拉不开（多半是 OSS 签名过期），提示重取 */
const panoBroken = ref(false)

/**
 * 环境不支持 WebGL（已退成平面）。
 *
 * 声明必须放在 `enterPano()` 之前 —— 那个函数在 setup 期间就会被调用
 * （打开的就是全景时），`const` 在初始化前访问会抛 TDZ 错误。
 */
const panoUnsupported = ref(false)

function onPanoError(): void {
  if (panoHd.value) {
    // 高清那张挂了：退回预览，别把整块画面留在纯色上
    releasePanoHd()
    shell.showToast('高清全景加载失败，已退回预览', 'warn')
    return
  }
  panoBroken.value = true
}

function onPanoReady(): void {
  panoHdWait.value = false
  panoBroken.value = false
}

/* ---------- 全景 · 看高清（带真实字节进度） ---------- */

/** 高清那张的 objectURL / 在途请求 / 序号（换图或关弹层后，回来的一律作废） */
let panoObjUrl = ''
let panoCtrl: AbortController | null = null
let panoSeq = 0

/** 收掉高清那一层：revoke 掉 objectURL、中止在途下载、状态回落到预览 */
function releasePanoHd(): void {
  panoSeq += 1
  panoCtrl?.abort()
  panoCtrl = null
  if (panoObjUrl) URL.revokeObjectURL(panoObjUrl)
  panoObjUrl = ''
  panoHdUrl.value = ''
  panoHd.value = false
  panoHdWait.value = false
  panoHdBusy.value = false
  panoHdPct.value = 0
}

/**
 * 拉全景高清（13MB 的 pano.json 贴图集）：**打开详情就拉**，不再点按钮
 * （2026-11-23 现场口径，之前那颗「看高清」整颗下线）。
 *
 * 先把字节拉下来（带真实进度）再换源：之前是直接把 `p.full` 塞给贴图，
 * 预览图不动声色地挂了十几秒，用户完全不知道是在下还是卡了。现在进度条的宽度
 * 是「已收字节 / Content-Length」，与照片那一档是同一套。
 *
 * 拉不到（OSS 不回 ACAO / 断网 / 中途关掉）就退回直链：慢，但全景还是会出来。
 *
 * 与照片同一套取数顺序（内存 → 本机落盘 → 网络）：全景也是十几 MB，
 * 列表没刷新时再进一次不该重下一遍；`size` / `time` 与列表声明不符会自动作废。
 */
async function loadPanoHd(): Promise<void> {
  const p = patrol.pano
  if (!p?.full || panoHd.value || panoHdBusy.value) return
  const key = panoSeq
  panoHdBusy.value = true
  panoHdPct.value = 0
  panoCtrl = new AbortController()
  try {
    const blob = await fetchDetailOriginal(p.full, {
      signal: panoCtrl.signal,
      scope: PATROL_DETAIL_SCOPE,
      meta: { id: `pano-${p.id}`, time: p.time, size: p.size, group: 'pano' },
      onProgress: (loaded, total) => {
        if (key !== panoSeq) return
        panoHdPct.value = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0
      },
    })
    const url = URL.createObjectURL(blob)
    // 先解码再换源：避免切过去那一瞬间空一帧（上万像素的图解码要几百毫秒）
    await preload(url)
    if (key !== panoSeq) {
      URL.revokeObjectURL(url)
      return
    }
    if (panoObjUrl) URL.revokeObjectURL(panoObjUrl)
    panoObjUrl = url
    panoHdUrl.value = url
  } catch {
    if (key === panoSeq) panoHdUrl.value = ''
  } finally {
    if (key === panoSeq) {
      panoCtrl = null
      panoHdBusy.value = false
      panoHdPct.value = 0
      panoHdWait.value = true
      panoHd.value = true
    }
  }
}

/** 角标：全景 · 可环视（还在预览贴图上）→ 全景 · 高清 42% → 全景 · 高清 */
const panoTag = computed(() => {
  if (panoHd.value) return panoHdWait.value ? '全景 · 高清加载中' : '全景 · 高清'
  if (panoHdBusy.value) {
    return panoHdPct.value ? `全景 · 高清 ${panoHdPct.value}%` : '全景 · 高清加载中'
  }
  return '全景 · 可环视'
})

/* ---------- 全屏 ---------- */

/**
 * 两块画布各一套全屏开关（逻辑在 `utils/landscape.ts`，`page` 模式）：
 *
 *   · `panoLand`  —— VR 360 环视 / 项目全景那块球面画布；
 *   · `photoLand` —— 单张航拍照片（全景航拍 / 照片墙）的平面大图。
 *
 * 两套必须**互相独立**：在照片里全屏着再换一张全景，不该把全景也顶进全屏。
 * 但交互与状态完全一致（按钮写「全屏 / 退出」、`aria-pressed`、退出全屏时
 * 自动收回），因为走的是同一段代码。
 *
 * `page: true` —— 与首页背景图那颗「全屏」同一套：对 `documentElement`
 * 申请系统全屏 + 锁横屏，整页一起进全屏（画布 Teleport 到 body 后铺满，
 * 横屏提示卡在 `.phone-screen` 里也就跟着进得去）。
 *
 * `hint` **只给 `panoLand`**（2026-11-24 现场口径）：「把手机横过来看」是
 * VR 360 环视专用的一句引导 —— 球面全景在竖屏里只剩一条窄缝，不转屏基本没法看；
 * 平面照片全屏哪怕没转过去也照样能看清，就不再打断（`photoLand` 不带 `hint`）。
 */
const {
  land: panoLand,
  setStage: setPanoStage,
  toggle: togglePanoLand,
  exit: exitPanoLand,
} = useLandscape({ page: true, hint: true })

const {
  land: photoLand,
  setStage: setPhotoStage,
  toggle: togglePhotoLand,
  exit: exitPhotoLand,
} = useLandscape({ page: true })

/**
 * 全屏时点画布空白处（contain 留出的黑边）＝ 退出全屏。
 *
 * 全屏只有「右上角一颗 26px 胶囊」一个出口太险 —— 手指点不中、或者那颗按钮
 * 落在横屏刘海 / 圆角的边缘手势区里，就变成「怎么都关不掉」。黑边是整块画布，
 * 闭着眼睛也点得到。
 *
 * **只有平面图那条有效**（照片 `<img>` 是 contain，四周留出的就是这块 figure）：
 * 全景的 WebGL canvas 铺满 `.pano-host`，`click.self` 不会被触发 —— 所以全景
 * 全屏的唯一出口就是右上那颗「退出」。它的可靠性别指望这层兜着：
 * 命中区已撑到 44pt（`app.css` 的 `.pano-tool::after`），状态机在
 * `utils/landscape.ts` 里也不再会因为旋转误读把按钮提前拆掉。
 */
function onPhotoBackdrop(): void {
  if (photoLand.value) void togglePhotoLand()
}

function onPanoBackdrop(): void {
  if (panoLand.value) void togglePanoLand()
}

/** 签名过期后重取一次（store 会换一组新直链，弹层里的图跟着换） */async function onPanoRetry(): Promise<void> {
  panoBroken.value = false
  releasePanoHd()
  await patrol.loadPano(true)
  if (!patrol.pano) shell.showToast('暂时取不到项目全景', 'warn')
}

/**
 * 进入全景视图：复位高清状态 + **每次重新取一次最新成果**。
 *
 * 弹层是单实例（`SheetHost` 里 `<PatrolSheet v-if="sheet.kind === 'patrol'">`），
 * 从照片换到全景只改 `props.id`、组件不重建，所以「打开时取一次」不能只写在
 * setup 里 —— 那样第二次点开就再也不取了，永远停在内存里那张（用户实测：想看
 * 最新的向阳村全景，结果还是几小时前那张）。两个入口都指向这里。
 */
async function enterPano(): Promise<void> {
  releasePanoHd()
  if (photoLand.value) void exitPhotoLand()
  if (panoLand.value) void exitPanoLand()
  panoBroken.value = false
  panoUnsupported.value = false
  await patrol.loadPano(true)
  // 数据到位就拉高清：打开详情即高清，不再点「看高清」
  if (props.id === PANO_SHEET_ID) await loadPanoHd()
}

if (props.id === PANO_SHEET_ID) void enterPano()

watch(
  () => props.id,
  (id) => {
    // 从全景换到某张照片：把还在跑的 13MB 高清贴图掐掉，别留在后台白烧
    if (id === PANO_SHEET_ID) void enterPano()
    else releasePanoHd()
  },
)

/** 缩略图（低清）与原图直链 */
const thumb = computed(() => photo.value?.thumbnail ?? '')
const original = computed(() => photo.value?.url ?? '')

/* ---------- 详情即原图：打开就自动拉，带真实字节进度 ---------- */

/**
 * 已经在用原图。
 *
 * 字节没拉到（CORS / 断网）时也置 true —— 那时 `shown` 直接给原图直链，
 * 浏览器自己加载，画面仍然是原图，只是没有进度可报。
 */
const hd = ref(false)
/** 原图的本地 objectURL（下载完成后才有；为空时走直链） */
const hdUrl = ref('')
/** 下载进度 0~100（服务端没给长度时停在 0，角标写「原图加载中」） */
const hdPct = ref(0)
const hdBusy = ref(false)
/** 当前 objectURL，换图 / 关闭时 revoke */
let objUrl = ''
let ctrl: AbortController | null = null
/** 下载序号：关弹层 / 换图后，在途下载回来的一律作废（否则会把旧图盖上去） */
let seq = 0

/**
 * 当前该显示哪一版：原图（含直链兜底）→ 缩略图。
 *
 * 打开的一瞬间还没有原图字节，先用列表里那张缩略图顶住（通常已在浏览器缓存里，
 * 零请求），避免白屏；原图到手是**无声换源**：不重置缩放、不重开弹层。
 */
const shown = computed(() => {
  if (hd.value) return hdUrl.value || original.value
  return thumb.value || original.value
})

/**
 * 画面左上角角标：压缩预览（还在缩略图上）→ 原图 42% → 原图。
 *
 * 与画布底边那条进度带同一个数据源（`hdPct`）：进度带说「到哪了」，角标说
 * 「这是在加载原图」—— 加载中不会有人误以为图坏了。
 */
const viewTag = computed(() => {
  if (hd.value) return '原图'
  if (hdBusy.value) return hdPct.value ? `原图 ${hdPct.value}%` : '原图加载中'
  return '压缩预览'
})

function dropHd(): void {
  seq += 1
  ctrl?.abort()
  ctrl = null
  if (objUrl) URL.revokeObjectURL(objUrl)
  objUrl = ''
  hdUrl.value = ''
  hd.value = false
  hdBusy.value = false
  hdPct.value = 0
}

/**
 * 等这张图解码完成（最多 1.2s）。
 *
 * 目的是"换源不闪白"：把 objectURL 交给浏览器解码一遍，再换到可见的
 * `<img>` 上，切过去就是现成的像素。解码失败或环境不解码（无合成器的
 * WebView / 单测环境）都会在超时后照常换 —— 这条路径不能把图卡住。
 */
function preload(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    const done = (): void => {
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(done, 1200)
    img.onload = done
    img.onerror = done
    img.src = url
  })
}

/**
 * 拉原图（2026-11-23 现场口径：详情页**不做二次点击**）。
 *
 * 与之前「点查看原图才拉」的区别只有触发时机，那条链的其它性质一条没改：
 *   · 进度是已收字节 / `Content-Length`，不是估算动画；
 *   · 下完先解码再换源，切过去不闪白；
 *   · 关弹层 / 换照片直接 abort，几 MB 的流量不留在后台白烧；
 *   · 拉不到就退回直链（浏览器自己加载，慢但能看）。
 *
 * 取数顺序（2026-11-24）：内存 → **本机落盘** → 网络。看一眼就关、过一会儿再打开
 * 同一张，列表没刷新时直接读本地字节，不再下第二遍；尺寸也从缓存里一并恢复，
 * 连「探宽高」那次缩略图解码都省了。
 */
async function loadHd(): Promise<void> {
  const p = photo.value
  const src = original.value
  if (!p || !src) return
  const key = ++seq
  hdBusy.value = true
  hdPct.value = 0
  ctrl = new AbortController()
  try {
    const blob = await fetchDetailOriginal(src, {
      signal: ctrl.signal,
      // 作用域与 `stores/patrol.ts::load()` 的对账字符串一致
      scope: PATROL_DETAIL_SCOPE,
      meta: { id: p.id, time: p.time, size: p.size, group: patrol.catOfPhoto(p.id) },
      onLocal: (row) => {
        if (key !== seq || !row.width || !row.height) return
        dims.value = { w: row.width, h: row.height }
        patrol.setDims(p.id, row.width, row.height)
      },
      onProgress: (loaded, total) => {
        if (key !== seq) return
        hdPct.value = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0
      },
    })
    const url = URL.createObjectURL(blob)
    await preload(url)
    if (key !== seq) {
      URL.revokeObjectURL(url)
      return
    }
    if (objUrl) URL.revokeObjectURL(objUrl)
    objUrl = url
    hdUrl.value = url
  } catch {
    // 拉不到（CORS / 断网 / 被取消）：交给浏览器直接加载直链，慢但能看
  } finally {
    if (key === seq) {
      ctrl = null
      hdBusy.value = false
      hdPct.value = 0
      hd.value = true
    }
  }
}

/** 换照片时全部复位（否则会带着上一张的原图、进度与全屏态） */
function resetForNext(): void {
  dropHd()
  if (photoLand.value) void exitPhotoLand()
  dims.value = null
  panoUnsupported.value = false
  zoomReset()
  probeDims()
}

/* ---------- 平面大图的缩放 ---------- */

const {
  zoomed: imgZoomed,
  label: zoomLabel,
  imgStyle,
  animating: zoomAnim,
  handlers: zoomHandlers,
  reset: zoomReset,
} = useImageZoom()

/* ---------- 全景 ---------- */

/** 原图尺寸（判断是不是 2:1 全景用；列表里加载过就有缓存） */
const dims = ref<{ w: number; h: number } | null>(null)
const panoRef = ref<InstanceType<typeof PanoViewer> | null>(null)

const isPano = computed(() => isEquirect(dims.value?.w ?? 0, dims.value?.h ?? 0))

/**
 * 拿到尺寸。
 *
 * 列表里显示过这张缩略图时 store 已有记录（`patrol.setDims`），直接用；
 * 没显示过（比如刷新后直接开弹层）就拿缩略图再加载一次 —— 浏览器缓存里
 * 已有这份字节，等同于本地读取。
 */
function probeDims(): void {
  const p = photo.value
  if (!p) return
  const known = patrol.dims[p.id]
  if (known) {
    dims.value = known
    return
  }
  const img = new Image()
  img.onload = () => {
    if (photo.value?.id !== p.id) return
    patrol.setDims(p.id, img.naturalWidth, img.naturalHeight)
    dims.value = { w: img.naturalWidth, h: img.naturalHeight }
    // 尺寸也写进详情缓存：下次打开这张直接从本地读，连缩略图都不用再解码一遍
    void patchDetailMeta(p.url, { width: img.naturalWidth, height: img.naturalHeight })
  }
  img.src = patrol.previewOf(p)
}

/** 首次进入即取尺寸（列表里加载过就直接命中缓存）；换图见下面的 watch */
probeDims()
/** 打开就是原图：首帧先铺缩略图，原图字节带进度到位后无声换源 */
loadHd()
watch(
  () => props.id,
  () => {
    resetForNext()
    loadHd()
  },
)

/** 拍摄时间：服务端给的是 'YYYY-MM-DD HH:mm:ss'，截到分钟 */
const timeText = computed(() => {
  const t = photo.value?.time ?? ''
  if (!t) return '—'
  return t.slice(0, 16).replace('T', ' ')
})

/*
 * 「下载 = 存进手机相册」那颗按钮 2026-11-18 下线（用户要求）：
 * 平面照片的画布工具条现在只剩「全屏」（原图自动加载，见 `loadHd`），
 * 要存图走长按图片 / 系统菜单 —— 与 VR 360 环视的做法一致，别在这里
 * 再长出一颗按钮。`utils/photoHd.ts` 的 savePhoto 仍被 AirPlayer 使用，没删。
 */

onBeforeUnmount(() => {
  releasePanoHd()
  dropHd()
})
</script>

<template>
  <div v-if="isPanoView || photo">
    <!-- 项目全景：平台拼好的等距圆柱成果，贴到球面内壁环视（手机 / 电脑同一套手势） -->
    <template v-if="isPanoView">
      <!--
        全屏时整块画布 Teleport 到 body：弹层面板带 transform（popRise 的
        translateY 收尾态会留下 matrix），position:fixed 会被它当成包含块，
        铺不满视口。Teleport 只挪 DOM，PanoViewer 的实例 / 贴图 / 视角都保留，
        所以进出全屏不会重新下载 13MB、也不会把看到一半的角度丢掉。
      -->
      <Teleport to="body" :disabled="!panoLand">
        <figure
          :ref="setPanoStage"
          class="pano-stage"
          :class="{ 'is-land': panoLand }"
          @click.self="onPanoBackdrop"
        >
          <PanoViewer
            ref="panoRef"
            :src="panoSrc"
            :alt="`${patrol.pano?.taskName ?? ''} 项目全景`"
            @unsupported="panoUnsupported = true"
            @error="onPanoError"
            @ready="onPanoReady"
          />
          <span class="patrol-view-tag is-pano">{{ panoTag }}</span>

          <!--
            画布右上角工具条：复位 / 全屏。
            「看高清」已下线（2026-11-23）：高清贴图打开就自动拉，进度见底边那条。
          -->
          <div class="pano-tools">
            <button
              v-if="!panoUnsupported"
              class="pano-tool"
              type="button"
              aria-label="复位视角"
              @click="panoRef?.reset()"
            >
              复位
            </button>
            <button
              class="pano-tool"
              type="button"
              :aria-pressed="panoLand"
              :aria-label="panoLand ? '退出全屏，回到竖屏' : '全屏查看'"
              @click="togglePanoLand"
            >
              {{ panoLand ? '退出' : '全屏' }}
            </button>
          </div>

          <!--
            高清贴图的真实字节进度：与照片那条同一条 .hd-progress（宽度是
            已收字节 / Content-Length，不是估算）。压在画布底边而不是画布下方：
            不占版面高度，全屏时也还在视野里。
          -->
          <div
            v-if="panoHdBusy"
            class="hd-progress is-in-stage"
            role="progressbar"
            :aria-valuenow="panoHdPct"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="`高清全景加载 ${panoHdPct}%`"
          >
            <i :style="{ width: `${panoHdPct}%` }"></i>
          </div>

          <p class="pano-hint">
            {{
              panoUnsupported
                ? '当前环境不支持全景渲染，已切换为平面查看'
                : panoLand
                  ? '拖动环视 · 双指缩放 · 点「退出」回竖屏'
                  : '拖动环视 · 双指或滚轮缩放'
            }}
          </p>
        </figure>
      </Teleport>

      <!-- 签名过期（OSS 预签名 2 小时）：给一个明确的重取入口，而不是干瞪黑屏 -->
      <div v-if="panoBroken" class="pano-expired">
        <span>全景图链接已过期</span>
        <button type="button" @click="onPanoRetry">重新获取</button>
      </div>

      <div class="patrol-meta">
        <!-- 项目名必须写出来：全景按本项目 pid 过滤，但用户仍要知道这是哪片工地 -->
        <div><span>项目</span><b>{{ panoProject }}</b></div>
        <div><span>时间</span><b>{{ panoTime || '—' }}</b></div>
        <div>
          <span>来源</span>
          <span class="alarm-src alarm-src-drone">无人机</span>
        </div>
      </div>
    </template>

    <template v-else-if="photo">
    <!-- 单张照片：等距圆柱投影（2:1）才进球面，球面环视（拖拽 / 双指 / 滚轮） -->
    <figure v-if="isPano" class="pano-stage">
      <PanoViewer
        ref="panoRef"
        :src="shown"
        :alt="`${photo.taskName} 全景`"
        @unsupported="panoUnsupported = true"
      />
      <span class="patrol-view-tag is-pano">全景 · 可环视</span>
      <button
        v-if="!panoUnsupported"
        class="pano-tool pano-reset"
        type="button"
        aria-label="复位视角"
        @click="panoRef?.reset()"
      >
        复位
      </button>
      <p class="pano-hint">
        {{ panoUnsupported ? '当前环境不支持全景渲染，已切换为平面查看' : '拖动环视 · 双指或滚轮缩放' }}
      </p>
    </figure>

    <!--
      平面照片：打开即原图。首帧先铺缩略图（零请求），原图字节带进度到位后
      无声换源 —— 不再有「查看原图」那颗按钮（2026-11-23 现场口径）。

      全屏时与上方全景一样 Teleport 到 body —— 弹层面板带 transform，会让
      position:fixed 以面板为包含块，DOM 不挪就永远铺不满视口。
    -->
    <Teleport v-else to="body" :disabled="!photoLand">
      <figure
        :ref="setPhotoStage"
        class="patrol-view"
        :class="{ 'is-land': photoLand }"
        @click.self="onPhotoBackdrop"
      >
        <img
          class="zoomable"
          :class="{ 'is-zoomed': imgZoomed, 'is-anim': zoomAnim }"
          :src="shown"
          :alt="photo.taskName"
          :style="imgStyle"
          v-on="zoomHandlers"
        />
        <span v-if="imgZoomed" class="zoom-badge">{{ zoomLabel }}</span>
        <!-- 角标：压缩预览（还在缩略图上）→ 原图 42% → 原图 -->
        <span class="patrol-view-tag">{{ viewTag }}</span>

        <!--
          画布右上角工具条只剩「全屏」：原图是自动加载的，不需要再点一次
          （2026-11-23 现场口径，原来那颗「查看原图」整颗下线）。
        -->
        <div class="pano-tools">
          <button
            class="pano-tool"
            type="button"
            :aria-pressed="photoLand"
            :aria-label="photoLand ? '退出全屏，回到竖屏' : '全屏查看'"
            @click="togglePhotoLand"
          >
            {{ photoLand ? '退出' : '全屏' }}
          </button>
        </div>

        <!--
          原图的真实字节进度：压在画布底边，不占版面（全屏时也还在视野里）。
          宽度 = 已收字节 / Content-Length，不是估算动画。
        -->
        <div
          v-if="hdBusy"
          class="hd-progress is-in-stage"
          data-state="patrol-hd-progress"
          role="progressbar"
          :aria-valuenow="hdPct"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`原图加载 ${hdPct}%`"
        >
          <i :style="{ width: `${hdPct}%` }"></i>
        </div>
      </figure>
    </Teleport>

    <div class="patrol-meta">
      <!-- 抓拍（视频监控）写「点位」，航拍写「任务」—— 一张快照没有航线可言 -->
      <div><span>{{ photo.snap ? '点位' : '任务' }}</span><b>{{ photo.taskName }}</b></div>
      <div>
        <span>来源</span>
        <span class="alarm-src" :class="photo.snap ? 'alarm-src-cam' : 'alarm-src-drone'">
          {{ photo.snap ? '视频监控' : '无人机' }}
        </span>
      </div>
      <div><span>时间</span><b>{{ timeText }}</b></div>
    </div>
    </template>
  </div>
</template>
