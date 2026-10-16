/**
 * 浏览器 API 桩
 *
 * happy-dom 未实现（或不足以做断言）的部分，在此补齐：
 *   - ResizeObserver：组件在 onMounted 里观察容器，测试需要手动触发回调
 *     （真实浏览器由布局引擎触发，happy-dom 不会）
 *   - matchMedia：诊断浮层读取 display-mode
 *   - URL.createObjectURL / revokeObjectURL：隐患上报依赖它做本地预览，
 *     需要能断言「创建了几次、释放了几次」，泄露与否正是要测的点
 */

/* ---------------- ResizeObserver ---------------- */

export class ResizeObserverMock implements ResizeObserver {
  static instances: ResizeObserverMock[] = []

  readonly targets = new Set<Element>()

  constructor(private readonly cb: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this)
  }

  observe(target: Element): void {
    this.targets.add(target)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.targets.clear()
  }

  /** 手动触发一次回调，等价于浏览器检测到尺寸变化 */
  trigger(): void {
    this.cb([], this)
  }

  /** 最近创建的那个实例（组件挂载后的那个） */
  static latest(): ResizeObserverMock | undefined {
    return ResizeObserverMock.instances.at(-1)
  }
}

/* ---------------- ObjectURL 记账 ---------------- */

export const blobUrls = {
  created: [] as string[],
  revoked: [] as string[],
}

let blobSeq = 0

/* ---------------- 安装 ---------------- */

export function installBrowserStubs(): void {
  ResizeObserverMock.instances = []

  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver

  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia

  /*
   * 用可控实现覆盖 happy-dom 自带版本：给定确定的字符串、并记录释放调用，
   * 这样「是否漏释放」可以被断言，而不是只能靠肉眼看代码。
   */
  window.URL.createObjectURL = ((blob: Blob | MediaSource) => {
    void blob
    blobSeq += 1
    const url = `blob:mock/${blobSeq}`
    blobUrls.created.push(url)
    return url
  }) as typeof window.URL.createObjectURL

  window.URL.revokeObjectURL = ((url: string) => {
    blobUrls.revoked.push(url)
  }) as typeof window.URL.revokeObjectURL
}

export function resetBrowserStubs(): void {
  ResizeObserverMock.instances = []
  blobUrls.created = []
  blobUrls.revoked = []
  blobSeq = 0
}
