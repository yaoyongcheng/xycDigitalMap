import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { Message } from '@/types'

/**
 * 消息
 *
 * 原 js/app.js:12-15。虽为单域数据，但会随接口变化（消息列表必然来自后端），
 * 故仍进 store。
 *
 * 注：迁移方案的 6 个 store 清单遗漏了 messages（该清单由跨域共享点推导，
 * 而 messages 是单域数据），此处补为第 7 个 store。
 */
export const useMsgStore = defineStore('msg', () => {
  const messages = ref<Message[]>([
    { kind: 'people', title: '人员预警', desc: '这是一条人员预警消息', time: '15:51:45', unread: 1 },
    { kind: 'inspect', title: '巡检预警', desc: '无人机巡检识别到道路垃圾、电缆拖地等现场风险', time: '1分钟前', unread: 1 },
  ])

  /** 底部 tabbar 的消息角标数（index.html:339 的 <b class="badge">2</b> 为硬编码，此处保持同值） */
  const unreadTotal = computed(() => messages.value.reduce((sum, m) => sum + (m.unread || 0), 0))

  return { messages, unreadTotal }
})
