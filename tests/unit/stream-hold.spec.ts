import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'

import { useStreamHold } from '@/utils/streamHold'

/**
 * 任务结束后的画面宽限（2026-11-24）
 *
 * 无人机页的实时画面按「有没有执行中的任务」开关，但飞机收尾时往往还在推流，
 * 所以任务结束要再留一段（默认 2 分钟）。这里用短窗口 + 手动拨表来钉规则，
 * 不依赖真实定时器。
 *
 * 规则三条：
 *   ① 页面初开就没有任务 → **不宽限**（那不是「刚结束」）；
 *   ② 任务结束 → `on` 继续为真，到点自动收；
 *   ③ 宽限里又有任务起飞 → 立刻收回窗口，下次结束重新计。
 */
describe('useStreamHold', () => {
  it('页面初开就没有任务：不宽限，画面不连', () => {
    const running = ref(false)
    const now = ref(Date.now())
    const { on } = useStreamHold(running, now, 60_000)
    expect(on.value).toBe(false)
  })

  it('任务结束：窗口内继续上屏，到点自动收', async () => {
    const running = ref(true)
    const now = ref(Date.now())
    const { on, minutes } = useStreamHold(running, now, 60_000)
    expect(on.value).toBe(true)
    expect(minutes).toBe(1)

    running.value = false
    await nextTick()
    // 刚结束那一刻仍在窗口里 —— 落地那几秒不能被切掉
    expect(on.value).toBe(true)

    // 拨到窗口边界外（判据是共享时钟，不是内部定时器）
    now.value = Date.now() + 60_001
    expect(on.value).toBe(false)
  })

  it('宽限里又有任务起飞：立刻收回窗口，结束时间重新计', async () => {
    const running = ref(true)
    const now = ref(Date.now())
    const { on, until } = useStreamHold(running, now, 60_000)

    running.value = false
    await nextTick()
    const first = until.value
    expect(first).toBeGreaterThan(0)
    expect(on.value).toBe(true)

    running.value = true
    await nextTick()
    expect(until.value).toBe(0)
    expect(on.value).toBe(true)

    running.value = false
    await nextTick()
    expect(until.value).toBeGreaterThanOrEqual(first)
  })

  it('默认窗口是 2 分钟', () => {
    const running = ref(true)
    const now = ref(Date.now())
    const { minutes } = useStreamHold(running, now)
    expect(minutes).toBe(2)
  })
})
