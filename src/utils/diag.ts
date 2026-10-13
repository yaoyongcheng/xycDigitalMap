/**
 * 真机诊断浮层（仅在 URL 带 ?diag 时挂载）
 *
 * 用途：iOS Safari 无法连开发者工具，遇到只在真机上出现的布局问题时，
 * 让用户访问 `<站点>?diag` 就能把关键数值显示在屏幕上并截图回传。
 *
 * 刻意常驻在生产包里：它是排查真机问题的唯一手段，体积可忽略；
 * 正常访问不会挂载，也不产生任何 DOM 与定时器开销（首行即返回）。
 */

/** 读取抽屉定位链路上的关键数值 */
function snapshot(): string {
  const pg = document.querySelector<HTMLElement>('#page-home')
  /*
   * 关键：一律在 #page-home 内部查找。
   * 页面上存在第二个 .home-progress（在横屏地图层 .map-land 里，尺寸恒为 0），
   * 用 document.querySelector 会抓到那个，读出误导性的 0。
   */
  const sheet = pg?.querySelector<HTMLElement>('.home-sheet') ?? null
  const prog = pg?.querySelector<HTMLElement>('.home-progress') ?? null
  const phone = document.querySelector<HTMLElement>('.phone')
  const vv = window.visualViewport
  const rect = (el: HTMLElement | null) => (el ? Math.round(el.getBoundingClientRect().top) : '-')
  const bottom = (el: HTMLElement | null) =>
    el ? Math.round(el.getBoundingClientRect().bottom) : '-'
  const height = (el: HTMLElement | null) =>
    el ? Math.round(el.getBoundingClientRect().height) : '-'

  const isIOS = /iPhone|iPad/.test(navigator.userAgent)
  const isPWA = window.matchMedia('(display-mode: standalone)').matches

  return [
    `innerH=${window.innerHeight} visualH=${Math.round(vv?.height ?? 0)} dpr=${window.devicePixelRatio}`,
    `iOS=${isIOS} mode=${isPWA ? 'PWA' : 'browser'}`,
    `sheetUp=${pg?.classList.contains('is-sheet-up') ?? '-'} active=${pg?.classList.contains('active') ?? '-'}`,
    `--sheet-up-top=[${pg ? getComputedStyle(pg).getPropertyValue('--sheet-up-top').trim() : '-'}] inline=[${pg?.style.getPropertyValue('--sheet-up-top').trim() || '无'}]`,
    `sheet.top=${sheet ? getComputedStyle(sheet).top : '-'} sheetTopPx=${rect(sheet)} sheetH=${height(sheet)}`,
    `pageTop=${rect(pg)} pageH=${height(pg)} phoneH=${height(phone)}`,
    `progBottom(首页内)=${bottom(prog)}`,
    `来源=${pg?.style.getPropertyValue('--sheet-up-top') ? 'JS内联' : 'CSS默认(118px)'}`,
    // 元素计数：用于发现重复节点（多一份就会让定位表现错乱）
    `计数 #page-home=${document.querySelectorAll('#page-home').length} .home-sheet=${document.querySelectorAll('.home-sheet').length} .home-map=${document.querySelectorAll('.home-map').length} .home-progress=${document.querySelectorAll('.home-progress').length}`,
  ].join('\n')
}

export function mountDiag(): void {
  if (!location.search.includes('diag')) return

  const el = document.createElement('div')
  el.style.cssText = [
    'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:99999',
    'background:rgba(0,0,0,.88)', 'color:#4ade80',
    'font:11px/1.6 ui-monospace,Menlo,monospace',
    'padding:6px 8px', 'white-space:pre-wrap', 'word-break:break-all',
    'max-height:50vh', 'overflow:auto', 'pointer-events:auto',
  ].join(';')
  document.body.appendChild(el)

  const render = (): void => {
    el.textContent = snapshot()
  }
  render()
  window.setInterval(render, 600)
}
