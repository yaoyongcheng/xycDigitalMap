/**
 * 场景截图「本地兜底图」的持久化层（2026-11-18）
 *
 * 这层是「刷新后以最新兜底图为基准」的落点，所以两条路都要钉住：
 *   ① 有 IndexedDB：写进去的图能原样读回来，覆盖写只留一条（不会越攒越多）；
 *   ② 没有 IndexedDB（隐私模式 / 老 WebView / 测试环境）：降级成会话内存，
 *      本次刷新仍然按缓存逻辑跑，只是下次打开会丢 —— 不能因此崩或不显示图。
 *
 * 事务与 open 都带超时（见 `utils/sceneCache.ts`），这里用一个假 IDB 走通
 * 真实代码路径；happy-dom 本身没有 indexedDB，正好也顺带验了降级分支。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/* ---------------- 极简 IndexedDB 假实现（只覆盖本模块用到的 API） ---------------- */

type Handler = ((e: Event) => void) | null

class FakeRequest<T = unknown> {
  result: T | undefined
  error: unknown = null
  onsuccess: Handler = null
  onerror: Handler = null
  onupgradeneeded: Handler = null
  onblocked: Handler = null
}

/** 把这个请求「排在宏任务里成功」，值和事务完成顺序都可控 */
function settle<T>(req: FakeRequest<T>, run: () => T): FakeRequest<T> {
  setTimeout(() => {
    req.result = run()
    req.onsuccess?.(new Event('success'))
  }, 0)
  return req
}

function createFakeIndexedDB(): { factory: IDBFactory; data: Map<string, unknown> } {
  const data = new Map<string, unknown>()

  const store = {
    put(value: unknown, key: string) {
      return settle(new FakeRequest<undefined>(), () => {
        data.set(key, value)
        return undefined
      })
    },
    get(key: string) {
      return settle(new FakeRequest<unknown>(), () => data.get(key))
    },
    delete(key: string) {
      return settle(new FakeRequest<undefined>(), () => {
        data.delete(key)
        return undefined
      })
    },
    clear() {
      return settle(new FakeRequest<undefined>(), () => {
        data.clear()
        return undefined
      })
    },
  }

  const factory = {
    open() {
      const req = new FakeRequest<IDBDatabase>()
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => store,
        transaction: () => {
          const tx = {
            objectStore: () => store,
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onabort: null as (() => void) | null,
          }
          // 事务在所有 put/get 的宏任务之后才算完成（嵌套一层保证顺序）
          setTimeout(() => {
            setTimeout(() => tx.oncomplete?.(), 0)
          }, 0)
          return tx
        },
        close: () => undefined,
      } as unknown as IDBDatabase
      setTimeout(() => {
        req.result = db
        req.onsuccess?.(new Event('success'))
      }, 0)
      return req
    },
  }

  return { factory: factory as unknown as IDBFactory, data }
}

/** 每个用例都要一份全新的模块实例：`openDb` 会把结果缓存起来 */
async function loadCacheModule(): Promise<typeof import('@/utils/sceneCache')> {
  vi.resetModules()
  return import('@/utils/sceneCache')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('本地兜底图存储', () => {
  it('有 IndexedDB：写进去的图能读回来；覆盖写只留一条记录', async () => {
    const { factory, data } = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', factory)
    const cache = await loadCacheModule()

    const first = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    expect(await cache.writeSceneCache('3d', first, 'hash-a')).toBe(true)

    const got = await cache.readSceneCache('3d')
    expect(got?.hash).toBe('hash-a')
    expect(got?.blob.size).toBe(3)

    // 换一版：同一个 key 覆盖，库里始终只有一条
    const second = new Blob([new Uint8Array([4, 5, 6, 7])], { type: 'image/png' })
    expect(await cache.writeSceneCache('3d', second, 'hash-b')).toBe(true)
    expect(data.size).toBe(1)
    expect((await cache.readSceneCache('3d'))?.hash).toBe('hash-b')
    expect((await cache.readSceneCache('3d'))?.blob.size).toBe(4)

    // 两个类型各存各的
    await cache.writeSceneCache('2d', first, 'hash-2d')
    expect(data.size).toBe(2)
    expect((await cache.readSceneCache('2d'))?.hash).toBe('hash-2d')

    await cache.clearSceneCache()
    expect(await cache.readSceneCache('3d')).toBeNull()
    expect(await cache.readSceneCache('2d')).toBeNull()
  })

  it('没有 IndexedDB：降级成会话内存，照样能读回刚写的那张', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const cache = await loadCacheModule()

    const blob = new Blob([new Uint8Array([9])], { type: 'image/png' })
    // 落盘失败要如实返回 false（调用方据此知道「只能撑到本次刷新」）
    expect(await cache.writeSceneCache('2d', blob, 'mem-hash')).toBe(false)

    const got = await cache.readSceneCache('2d')
    expect(got?.hash).toBe('mem-hash')
    expect(got?.blob.size).toBe(1)

    await cache.clearSceneCache('2d')
    expect(await cache.readSceneCache('2d')).toBeNull()
  })

  it('库里没有记录 / 记录被写坏：一律当作「没有兜底图」，不抛错', async () => {
    const { factory, data } = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', factory)
    const cache = await loadCacheModule()

    expect(await cache.readSceneCache('3d')).toBeNull()

    // 手工塞一条坏记录（没有 blob）：normalize 要把它挡下来
    data.set('3d', { hash: 'broken', savedAt: 1 })
    expect(await cache.readSceneCache('3d')).toBeNull()

    // 空 Blob 同样不算有效兜底
    data.set('3d', { blob: new Blob([]), hash: 'empty', savedAt: 1 })
    expect(await cache.readSceneCache('3d')).toBeNull()
  })
})
