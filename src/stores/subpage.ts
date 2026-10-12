import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { useAlarmStore } from './alarm'

/**
 * 子页栈
 *
 * 对应原 js/app.js 的 paintSub(803) / openSub(824) / openAlarmDetail(816)
 * / openInspectList(809) / closeSub(830) / pageHtml(846) / subBack(801)。
 *
 * 与原版的差异（行为等同，实现更明确）：
 *   原版 subBack 存的是「函数」（openInspectList 的引用），靠参数收到
 *   undefined 时的 if 守卫保持 inspTab 不变。这里改存「目标视图描述符」，
 *   语义相同但不再依赖参数巧合。
 *   原版该参数巧合还导致 closeSub(force) 被 #btnBack 传入事件对象时
 *   恒不等于 true（app.js:875）—— 这里 force 显式声明为 boolean，行为不变。
 */

/** 子页可显示的视图 */
export type SubView =
  | { kind: 'none' }
  | { kind: 'inspect-list' }
  | { kind: 'alarm-detail'; id: string }
  | { kind: 'placeholder'; name: string }

export const useSubpageStore = defineStore('subpage', () => {
  const alarm = useAlarmStore()

  const view = ref<SubView>({ kind: 'none' })

  /** 上一级视图，对应原 subBack */
  const back = ref<SubView | null>(null)

  /** .subpage.is-alarm —— 控制深色导航栏与通栏 hero（CSS app.css:2357-2369） */
  const isAlarm = ref(false)

  /** .subpage.open */
  const isOpen = computed(() => view.value.kind !== 'none')

  /** 原 subTitle.textContent */
  const title = computed(() => {
    switch (view.value.kind) {
      case 'inspect-list':
        return '巡检预警'
      case 'alarm-detail':
        return '预警详情'
      case 'placeholder':
        return view.value.name
      default:
        return ''
    }
  })

  /**
   * 原 openInspectList(tab)
   * 不传参时保持当前 inspTab（对应原版 tab 收到 undefined 时的守卫分支）
   */
  function openInspectList(tab?: 'today' | 'hist'): void {
    if (tab === 'today' || tab === 'hist') alarm.inspTab = tab
    back.value = null
    isAlarm.value = false
    alarm.inspCalOpen = false
    view.value = { kind: 'inspect-list' }
  }

  /**
   * 原 openAlarmDetail(id, fromList)
   * fromList=true 时返回键回到列表；原版该分支为唯一实际调用路径
   */
  function openAlarmDetail(id: string, fromList = true): void {
    if (!alarm.byId(id)) return
    back.value = fromList ? { kind: 'inspect-list' } : null
    isAlarm.value = true
    view.value = { kind: 'alarm-detail', id }
  }

  /** 原 openSub(title, html) —— 「我的」菜单入口，内容为占位文案 */
  function openSub(name: string): void {
    back.value = null
    isAlarm.value = false
    view.value = { kind: 'placeholder', name }
  }

  /**
   * 原 closeSub(force) —— 三级优先返回：
   *   ① 巡检日历展开时先收日历
   *   ② 有上一级则回退一级
   *   ③ 否则关闭子页
   */
  function close(force = false): void {
    if (!force && alarm.inspCalOpen) {
      alarm.inspCalOpen = false
      return
    }
    if (!force && back.value) {
      view.value = back.value
      back.value = null
      return
    }
    back.value = null
    view.value = { kind: 'none' }
  }

  return { view, back, isAlarm, isOpen, title, openInspectList, openAlarmDetail, openSub, close }
})
