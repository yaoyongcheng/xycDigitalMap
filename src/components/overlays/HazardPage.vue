<script setup lang="ts">
import { ref } from 'vue'

import BackBar from '@/components/ui/BackBar.vue'
import { hazardKindList } from '@/data/config'
import { useAirHazardStore } from '@/stores/airHazard'
import { useShellStore } from '@/stores/shell'

/**
 * 隐患上报全屏层
 *
 * 对应原 index.html:151-175 + 事件处理（app.js:1452-1493）
 * + renderHazardTypes / renderHazardPhotos（app.js:1405-1423）。
 *
 * 已保留的原版行为：
 *   - 照片上限 6 张、仅 image/*
 *   - #hazardDesc 的文本被清空但提交时完全不读取（原版缺陷，见 store 注释）
 */
const air = useAirHazardStore()
const shell = useShellStore()

const fileEl = ref<HTMLInputElement | null>(null)

function onBack(): void {
  air.closeHazard()
}

function onAdd(): void {
  fileEl.value?.click()
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  air.addHazardFiles(input.files || [])
  // 原 app.js:1475 —— 清空 input 以便重复选择同一文件
  input.value = ''
}

function onDelete(i: number): void {
  air.removeHazardImg(i)
}

function onPickKind(k: string): void {
  air.hazardKind = k
}

function onSubmit(): void {
  const r = air.submitHazard()
  shell.showToast(r.message)
  if (r.ok) air.closeHazard()
}
</script>

<template>
  <div
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
            <img :src="src" :alt="`隐患照片 ${i + 1}`" />
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

      <button class="hazard-submit" id="btnHazardSubmit" type="button" @click="onSubmit">提交上报</button>
    </div>
  </div>
</template>
