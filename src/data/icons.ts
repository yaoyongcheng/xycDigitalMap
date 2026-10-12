/**
 * SVG 图标常量
 *
 * 逐字搬运自 js/app.js（原版基线）。
 * 原版把这些图标作为 HTML 字符串拼进运行时模板，这里保留相同的字符串形态，
 * 组件侧通过 v-html 渲染，保证输出 DOM 逐字节一致。
 */

/** 原 js/app.js:4-5 —— 把 path 的 d 属性包成 svg 的辅助函数 */
export const icon = (d: string): string => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`

/** 原 js/app.js:7-10 —— 消息图标（白描边） */
export const msgIco: Record<string, string> = {
  people: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.2" r="2.8"/><path d="M5.8 19.2c.8-3.2 3.1-4.8 6.2-4.8s5.4 1.6 6.2 4.8"/></svg>`,
  inspect: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.2" cy="6.2" r="2"/><circle cx="17.8" cy="6.2" r="2"/><circle cx="6.2" cy="17.8" r="2"/><circle cx="17.8" cy="17.8" r="2"/><path d="M8.2 6.2h7.6M8.2 17.8h7.6M6.2 8.2v7.6M17.8 8.2v7.6"/><rect x="10" y="10" width="4" height="4" rx="0.8"/></svg>`,
}

/** 原 js/app.js:17-21 —— 「我的」菜单图标 path（需经 icon() 包裹） */
export const menuSvg: Record<string, string> = {
  sites: 'M5 20V7.5L12 4l7 3.5V20 M9.5 20v-5h5v5',
  setting:
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M4.5 12h2 M17.5 12h2 M6.2 6.2l1.5 1.5 M16.3 16.3l1.5 1.5 M6.2 17.8l1.5-1.5 M16.3 7.7l1.5-1.5',
  about: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 11v5 M12 8v.5',
}

/**
 * 原 js/app.js:81
 * 注意：原字符串外层自带 <span class="cam-ico">，搬运时保持原样，
 * 由调用方决定是否复用该 span —— 1:1 复刻下不拆。
 */
export const camIco = `<span class="cam-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 8.2h10.2v9.2H4.5z"/><path d="M14.7 11.2 19.5 8.8v8.2l-4.8-2.4z"/></svg></span>`

/** 原 js/app.js:82 */
export const starSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 4.6 14.2 9l5 .7-3.6 3.5.9 5L12 16.1 7.5 18.2l.9-5L4.8 9.7 9.8 9z"/></svg>`

/** 原 js/app.js:489 —— 里程碑旗帜 */
export const msFlag = `<svg viewBox="0 0 24 24"><path d="M7 21V4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 4.4h10.2l-2.6 3.6 2.6 3.6H8z" fill="currentColor"/></svg>`

/** 原 js/app.js:1077 —— 日历图标 */
export const calIco = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/></svg>`
