<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import PanoViewer from '@/components/ui/PanoViewer.vue'
import { PANO_SHEET_ID, usePatrolStore } from '@/stores/patrol'
import { useShellStore } from '@/stores/shell'
import { fetchBlobWithProgress } from '@/utils/blobFetch'
import { isEquirect, panoLabel } from '@/utils/pano'
import { savePhoto } from '@/utils/photoHd'
import { useImageZoom } from '@/utils/zoom'

/**
 * 巡检大图（2026-11 阶段 8 起是真实航拍照片；2026-11-16 改「缩略图 → 原图」两层）
 *
 * ## 为什么改成两层（用户要求：像微信那样）
 *
 * 真实原图单张 4~8MB。原来的实现是点开就加载原图 —— 手机上一次十几秒白屏，
 * 用户不知道是在下还是卡了。现在：
 *
 *   1. 打开先显示**缩略图**（370~520KB，列表里已经加载过，通常在缓存里，秒开）；
 *   2. 底部给「查看原图 · 7.5MB」，点了才 `fetch` 原图，按钮上显示真实下载百分比；
 *   3. 下完先解码再换源，避免"换上去一瞬间白一下再出来"。
 *
 * 进度是真的：`utils/blobFetch.ts` 读流里的已收字节 / `Content-Length`
 * （OSS 两个域名都回 ACAO，实测可跨域读）。拉不到就退回直接塞给 `<img>`
 * —— 慢是慢，但图还是能出来。
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

const photo = computed(() => patrol.photos.find((p) => p.id === props.id))

/* ---------- 项目全景（平台拼好的等距圆柱成果，2026-11-16） ---------- */

/**
 * 打开的是不是「项目全景」。
 *
 * 全景来自**重建成果**（不是某一张媒体），没有照片 id，所以用保留 id `pano`
 * 打开；真正的内容从 store 的 `pano` 拿。
 */
const isPanoView = computed(() => props.id === PANO_SHEET_ID && Boolean(patrol.pano))

/** 全景的拍摄/生成时间（服务端给 `YYYY-MM-DDTHH:mm:ss`，截到分钟） */
const panoTime = computed(() => (patrol.pano?.time ?? '').slice(0, 16).replace('T', ' '))

/** 全景原图体积（真实字节数） */
const panoSize = computed(() => patrol.sizeText(patrol.pano?.size ?? 0))

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
/** 点了高清但还没上屏（按钮文案用），贴图没到位前旧图继续显示，不闪 */
const panoHdWait = ref(false)
const panoSrc = computed(() => {
  const p = patrol.pano
  if (!p) return ''
  return panoHd.value && p.full ? p.full : p.preview
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
    panoHd.value = false
    panoHdWait.value = false
    shell.showToast('高清全景加载失败，已退回预览', 'warn')
    return
  }
  panoBroken.value = true
}

function onPanoReady(): void {
  panoHdWait.value = false
  panoBroken.value = false
}

function onPanoHd(): void {
  if (panoHd.value || panoHdWait.value || !patrol.pano?.full) return
  panoHdWait.value = true
  panoHd.value = true
}

const panoHdLabel = computed(() => {
  if (panoHd.value) return '已是高清'
  if (panoHdWait.value) return '高清加载中'
  return `看高清 · ${panoSize.value}`
})

/** 签名过期后重取一次（store 会换一组新直链，弹层里的图跟着换） */
async function onPanoRetry(): Promise<void> {
  panoBroken.value = false
  await patrol.loadPano(true)
  if (!patrol.pano) shell.showToast('暂时取不到项目全景', 'warn')
}

/** 存进手机相册的是**高清那张**（预览只是列表用的低清） */
async function onPanoDownload(): Promise<void> {
  const p = patrol.pano
  if (!p) return
  const name = (p.name || p.taskName).replace(/\.[^.]+$/, '')
  try {
    const res = await savePhoto(p.full || p.preview, name)
    if (res === 'album') shell.showToast('已保存到相册', 'success')
    else if (res === 'download') shell.showToast('已开始下载', 'success')
  } catch {
    shell.showToast('保存失败', 'warn')
  }
}

/**
 * 进入全景视图：复位高清状态 + **每次重新取一次最新成果**。
 *
 * 弹层是单实例（`SheetHost` 里 `<PatrolSheet v-if="sheet.kind === 'patrol'">`），
 * 从照片换到全景只改 `props.id`、组件不重建，所以「打开时取一次」不能只写在
 * setup 里 —— 那样第二次点开就再也不取了，永远停在内存里那张（用户实测：想看
 * 最新的向阳村全景，结果还是几小时前那张）。两个入口都指向这里。
 */
function enterPano(): void {
  panoHd.value = false
  panoHdWait.value = false
  panoBroken.value = false
  panoUnsupported.value = false
  void patrol.loadPano(true)
}

if (props.id === PANO_SHEET_ID) enterPano()

watch(
  () => props.id,
  (id) => {
    if (id === PANO_SHEET_ID) enterPano()
  },
)

/** 缩略图（低清）与原图直链 */
const thumb = computed(() => photo.value?.thumbnail ?? '')
const original = computed(() => photo.value?.url ?? '')
const sizeText = computed(() => patrol.sizeText(photo.value?.size ?? 0))
/** 存盘用的文件名：去掉服务端带的后缀（`xxx.jpeg`），savePhoto 自己会补 .jpg */
const baseName = computed(() => (photo.value?.name ?? '').replace(/\.[^.]+$/, ''))

/* ---------- 两层：缩略图 → 原图 ---------- */

/** 是否已切到原图 */
const hd = ref(false)
/** 原图的本地 objectURL（下载完成后才有；失败时为空，直接走直链） */
const hdUrl = ref('')
/** 下载进度 0~100（服务端没给长度时停在 0，按钮显示「下载中」） */
const hdPct = ref(0)
const hdBusy = ref(false)
/** 原图已拿到，供「下载」直接用（省掉一次 6MB 的重下 + canvas 转码） */
let hdBlob: Blob | null = null
/** 当前 objectURL，换图 / 关闭时 revoke */
let objUrl = ''
let ctrl: AbortController | null = null
/** 下载序号：关弹层 / 换图后，在途下载回来的一律作废（否则会把旧图盖上去） */
let seq = 0

/**
 * 当前该显示哪一版。
 *
 * 有缩略图就先用缩略图；没有缩略图（服务端没给）时原图是唯一选择 ——
 * 这时 `canHd` 为 false，按钮写「无压缩版」，不会让用户点了没反应。
 */
const shown = computed(() => {
  if (hd.value) return hdUrl.value || original.value
  return thumb.value || original.value
})

/** 还能不能点「查看原图」 */
const canHd = computed(() => Boolean(thumb.value && original.value) && !hd.value)

/** 按钮文案：四态（下载中带真实百分比） */
const hdLabel = computed(() => {
  if (hd.value) return '已是原图'
  if (!thumb.value) return '无压缩版'
  if (hdBusy.value) return hdPct.value ? `原图 ${hdPct.value}%` : '原图下载中'
  return `查看原图 · ${sizeText.value}`
})

function dropHd(): void {
  seq += 1
  ctrl?.abort()
  ctrl = null
  if (objUrl) URL.revokeObjectURL(objUrl)
  objUrl = ''
  hdBlob = null
  hdUrl.value = ''
  hd.value = false
  hdBusy.value = false
  hdPct.value = 0
}

/** 换照片时全部复位（否则会带着上一张的原图与进度） */
function resetForNext(): void {
  dropHd()
  dims.value = null
  panoUnsupported.value = false
  zoomReset()
  probeDims()
}

/** 先把图下到内存里 → 解码完成 → 再换源，避免切源瞬间空一帧 */
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

async function onHd(): Promise<void> {
  if (!canHd.value || hdBusy.value) return
  const key = seq
  hdBusy.value = true
  hdPct.value = 0
  ctrl = new AbortController()
  try {
    const blob = await fetchBlobWithProgress(
      original.value,
      (loaded, total) => {
        if (key !== seq) return
        hdPct.value = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0
      },
      ctrl.signal,
    )
    const url = URL.createObjectURL(blob)
    await preload(url)
    if (key !== seq) {
      URL.revokeObjectURL(url)
      return
    }
    if (objUrl) URL.revokeObjectURL(objUrl)
    objUrl = url
    hdBlob = blob
    hdUrl.value = url
  } catch {
    // 拉不到（CORS / 断网 / 被取消）：交给浏览器直接加载直链，慢但能看
    if (key === seq) hdUrl.value = ''
  } finally {
    if (key === seq) {
      ctrl = null
      hdBusy.value = false
      hdPct.value = 0
      hd.value = true
    }
  }
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
  }
  img.src = patrol.previewOf(p)
}

/** 首次进入即取尺寸（列表里加载过就直接命中缓存）；换图见下一行的 watch */
probeDims()
watch(() => props.id, resetForNext)

/* ---------- 下载 = 存进手机相册 ---------- */

async function onDownload(): Promise<void> {
  const p = photo.value
  if (!p) return
  try {
    // 已经点过「原图」：字节在手上，直接包成 jpg File，不用再下一次
    const ready = hdBlob ? new File([hdBlob], `${baseName.value}.jpg`, { type: 'image/jpeg' }) : null
    const res = await savePhoto(p.url, baseName.value || p.name, ready)
    if (res === 'album') shell.showToast('已保存到相册', 'success')
    else if (res === 'download') shell.showToast('已开始下载', 'success')
  } catch {
    shell.showToast('保存失败', 'warn')
  }
}

/** 拍摄时间：服务端给的是 'YYYY-MM-DD HH:mm:ss'，截到分钟 */
const timeText = computed(() => {
  const t = photo.value?.time ?? ''
  if (!t) return '—'
  return t.slice(0, 16).replace('T', ' ')
})

onBeforeUnmount(dropHd)
</script>

<template>
  <div v-if="isPanoView || photo">
    <!-- 项目全景：平台拼好的等距圆柱成果，贴到球面内壁环视（手机 / 电脑同一套手势） -->
    <template v-if="isPanoView">
      <figure class="pano-stage">
        <PanoViewer
          ref="panoRef"
          :src="panoSrc"
          :alt="`${patrol.pano?.taskName ?? ''} 项目全景`"
          @unsupported="panoUnsupported = true"
          @error="onPanoError"
          @ready="onPanoReady"
        />
        <span class="patrol-view-tag is-pano">{{ panoHd ? '全景 · 高清' : '全景 · 可环视' }}</span>
        <button
          v-if="!panoUnsupported"
          class="pano-reset"
          type="button"
          aria-label="复位视角"
          @click="panoRef?.reset()"
        >
          复位
        </button>
        <p class="pano-hint">
          {{
            panoUnsupported
              ? '当前环境不支持全景渲染，已切换为平面查看'
              : '拖动环视 · 双指或滚轮缩放'
          }}
        </p>
      </figure>

      <!-- 签名过期（OSS 预签名 2 小时）：给一个明确的重取入口，而不是干瞪黑屏 -->
      <div v-if="panoBroken" class="pano-expired">
        <span>全景图链接已过期</span>
        <button type="button" @click="onPanoRetry">重新获取</button>
      </div>

      <div class="patrol-meta">
        <!-- 全景**不按项目筛**（照 V2：全平台最新），所以项目名必须写出来，
             否则用户会以为这张是向阳村自己拍的 -->
        <div><span>项目</span><b>{{ panoProject }}</b></div>
        <div><span>时间</span><b>{{ panoTime || '—' }}</b></div>
        <div><span>大小</span><b>{{ panoSize || '—' }}</b></div>
        <div>
          <span>来源</span>
          <span class="alarm-src alarm-src-drone">无人机</span>
        </div>
      </div>

      <div class="photo-actions">
        <button class="photo-btn" type="button" :disabled="panoHd || panoHdWait" @click="onPanoHd">
          {{ panoHdLabel }}
        </button>
        <button class="photo-btn" type="button" @click="onPanoDownload">下载</button>
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
        class="pano-reset"
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

    <!-- 平面照片：低清缩略图起步，点「查看原图」才换高清 -->
    <figure v-else class="patrol-view">
      <img
        class="zoomable"
        :class="{ 'is-zoomed': imgZoomed, 'is-anim': zoomAnim }"
        :src="shown"
        :alt="photo.taskName"
        :style="imgStyle"
        v-on="zoomHandlers"
      />
      <span v-if="imgZoomed" class="zoom-badge">{{ zoomLabel }}</span>
      <span class="patrol-view-tag">{{ hd ? '原图' : '压缩预览' }}</span>
    </figure>

    <!-- 下载原图时的真实进度条 -->
    <div v-if="hdBusy" class="hd-progress" role="progressbar" :aria-valuenow="hdPct" aria-valuemin="0" aria-valuemax="100">
      <i :style="{ width: `${hdPct}%` }"></i>
    </div>

    <div class="patrol-meta">
      <div><span>任务</span><b>{{ photo.taskName }}</b></div>
      <div>
        <span>来源</span>
        <span class="alarm-src alarm-src-drone">无人机</span>
      </div>
      <div><span>时间</span><b>{{ timeText }}</b></div>
      <div><span>大小</span><b>{{ sizeText || '—' }}</b></div>
    </div>

    <div class="photo-actions">
      <button class="photo-btn" type="button" :disabled="!canHd || hdBusy" @click="onHd">
        {{ hdLabel }}
      </button>
      <button class="photo-btn" type="button" @click="onDownload">下载</button>
    </div>
    </template>
  </div>
</template>
