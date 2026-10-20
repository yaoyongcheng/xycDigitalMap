<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import BackBar from '@/components/ui/BackBar.vue'
import SmartImg from '@/components/ui/SmartImg.vue'
import { hazardKindList } from '@/data/config'
import { useAirHazardStore } from '@/stores/airHazard'
import { useShellStore } from '@/stores/shell'
import { useSlideOverlay } from '@/utils/slideOverlay'

/**
 * 隐患上报全屏层
 *
 * 对应原 index.html:151-175 + 事件处理（app.js:1452-1493）
 * + renderHazardTypes / renderHazardPhotos（app.js:1405-1423）。
 *
 * 已保留的原版行为：
 *   - 照片上限 6 张、仅 image/*
 *
 * 2026-10 交互优化（均属「操作繁琐 / 反馈缺失」类问题）：
 *   ① 选图被拒（超额 / 非图片）原先静默丢弃，现在明确提示拒了几张、为什么
 *   ② 描述文本原先填了不提交，现在进入载荷并在成功反馈里回显（见 store 注释）
 *   ③ 提交补 loading 态 + 防连点，按钮文案随状态机变化
 *   ④ 返回键二次确认：填了内容时首点只提示，2.5s 内再点才真的丢弃
 */
const air = useAirHazardStore()

/** 全屏层转场（进入左滑入 / 返回右滑出），见 utils/slideOverlay.ts */
const pageEl = ref<HTMLElement | null>(null)
const overlay = useSlideOverlay(() => pageEl.value)
watch(() => air.hazardOpen, (open) => overlay.syncOpen(open), { flush: 'post' })
const shell = useShellStore()

const fileEl = ref<HTMLInputElement | null>(null)

/** 「点过一次返回」的待确认窗口句柄 */
let backArmTimer = 0
/** 是否已进入待确认窗口（再点一次返回即丢弃） */
const backArmed = ref(false)

/** 表单是否有内容（决定是否值得拦一次返回） */
const hasDraft = computed(
  () => air.hazardImgs.length > 0 || air.hazardDesc.trim().length > 0,
)

function disarmBack(): void {
  window.clearTimeout(backArmTimer)
  backArmed.value = false
}

function onBack(): void {
  // 空表单直接走，不打扰
  if (!hasDraft.value) {
    disarmBack()
    overlay.leave(() => air.closeHazard())
    return
  }
  if (!backArmed.value) {
    backArmed.value = true
    window.clearTimeout(backArmTimer)
    backArmTimer = window.setTimeout(disarmBack, 2500)
    shell.showToast('已填内容将丢失，再按一次返回确认', 'warn', 2500)
    return
  }
  disarmBack()
  overlay.leave(() => air.closeHazard())
}

function onAdd(): void {
  fileEl.value?.click()
}

/**
 * 选图结果反馈。
 * 上限与格式限制仍在 store 里（唯一裁决点），这里只负责把结果说清楚。
 */
function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  const r = air.addHazardFiles(input.files || [])
  // 原 app.js:1475 —— 清空 input 以便重复选择同一文件
  input.value = ''

  if (r.rejectedLimit) {
    shell.showToast(`最多 6 张，已忽略 ${r.rejectedLimit} 张`, 'warn')
  } else if (r.rejectedType) {
    shell.showToast(`已忽略 ${r.rejectedType} 个非图片文件`, 'warn')
  } else if (r.added) {
    shell.showToast(`已添加 ${r.added} 张，共 ${air.hazardImgs.length}/6`, 'success')
  }
}

function onDelete(i: number): void {
  air.removeHazardImg(i)
}

function onPickKind(k: string): void {
  air.hazardKind = k
}

/** 提交：loading + 防连点，成功后关闭并复位确认窗口 */
async function onSubmit(): Promise<void> {
  if (air.hazardSubmitting) return
  const r = await air.commitHazard()
  if (r.ok) {
    disarmBack()
    shell.showToast(r.message, 'success', 2600)
    air.closeHazard()
  } else {
    shell.showToast(r.message, 'error')
  }
}
</script>

<template>
  <div
    ref="pageEl"
    class="hazard-page"
    id="hazardPage"
    :class="{ open: air.hazardOpen }"
    :hidden="!air.hazardOpen"
    :aria-hidden="!air.hazardOpen"
  >
    <BackBar title="隐患上报" back-id="btnHazardBack" @back="onBack" />

    <div class="hazard-body">
      <section class="hazard-sec">
        <h4>现场照片 <em>最多 6 张，可拍照或从相册选择</em></h4>
        <div class="hazard-photos" id="hazardPhotos">
          <div v-for="(src, i) in air.hazardImgs" :key="src" class="hazard-thumb">
            <SmartImg :src="src" :alt="`隐患照片 ${i + 1}`" />
            <button class="hazard-del" type="button" :data-hazard-del="i" aria-label="删除" @click="onDelete(i)">×</button>
          </div>
          <button v-if="air.hazardImgs.length < 6" class="hazard-add" id="btnHazardAdd" type="button" @click="onAdd">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 7v10M7 12h10"/><rect x="4" y="5" width="16" height="14" rx="2"/></svg>
            拍照/相册
          </button>
        </div>
        <input id="hazardFile" ref="fileEl" type="file" accept="image/*" multiple hidden @change="onFileChange" />
      </section>

      <section class="hazard-sec">
        <h4>隐患类型</h4>
        <div class="hazard-types" id="hazardTypes">
          <button
            v-for="k in hazardKindList"
            :key="k"
            class="hazard-type"
            :class="{ on: k === air.hazardKind }"
            type="button"
            :data-hazard-type="k"
            @click="onPickKind(k)"
          >
            {{ k }}
          </button>
        </div>
      </section>

      <section class="hazard-sec">
        <h4>问题描述</h4>
        <textarea
          v-model="air.hazardDesc"
          class="hazard-area"
          id="hazardDesc"
          rows="4"
          placeholder="补充隐患说明，便于整改跟进"
        ></textarea>
      </section>

      <button
        class="hazard-submit"
        id="btnHazardSubmit"
        type="button"
        :class="{ 'is-busy': air.hazardSubmitting }"
        :disabled="air.hazardSubmitting"
        @click="onSubmit"
      >
        <span v-if="air.hazardSubmitting" class="hazard-spin" aria-hidden="true"></span>
        {{ air.hazardSubmitting ? '提交中…' : '提交上报' }}
      </button>
    </div>
  </div>
</template>
