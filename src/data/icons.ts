/**
 * SVG 图标定义
 *
 * 图标几何逐字搬运自 js/app.js（原版基线），但改为「结构化描述」：
 * 根 svg 的属性 + 一组形状（path / circle / rect），由 SvgIcon.vue 渲染成
 * 真实的 SVG 元素。
 *
 * 2026-10 重构（原为 HTML 字符串 + 组件侧 v-html）：
 *   1. 全站 9 处静态图标此前都靠 v-html 注入，每处（含 v-for 内可达 24 枚）
 *      都要走一次 innerHTML 解析，拖拽重渲染时还会重复解析；
 *   2. 字符串拼 HTML 天然带属性逃逸面（`d="${d}"` 里出现引号即可越界），
 *      当前参数虽全是模块内常量，但没必要保留这条通路。
 * 改为数据 + 组件后模板直出，静态图标不再有 v-html。
 *
 * 仍走 v-html 的只有 utils/chart.ts 动态生成的图表 SVG（数据驱动的折线与面积），
 * 其几何随数据变化，不在此文件范围内。
 */

/** 单个形状：tag 决定标签名（SvgIcon 里按此三分支直出），其余键值原样作为该元素的属性写出 */
export interface IconShape {
  tag: 'path' | 'circle' | 'rect'
  [attr: string]: string | number | undefined
}

/** 一个图标：根 svg 的 viewBox + 根属性 + 形状列表（顺序即绘制顺序） */
export interface IconDef {
  viewBox: string
  /** 根 <svg> 上的表现属性；调用方在同名属性上可覆盖 */
  attrs?: Record<string, string | number>
  shapes: IconShape[]
}

/** msgIco / work 系列共用的根属性（原字符串里就写在 <svg> 上） */
const WHITE_STROKE = {
  fill: 'none',
  stroke: '#fff',
  'stroke-width': 1.8,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
}

/** 首页模块图标用的根属性 */
const MOD_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.7,
}

/** 日历图标用的根属性 */
const CAL_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.8,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
}

const ICON_MAP = {
  /* ---------------- 底部标签栏（原 index.html:327-345，配色由 .tab svg 提供） ---------------- */

  'tab-home': {
    viewBox: '0 0 24 24',
    shapes: [{ tag: 'path', d: 'M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z' }],
  },
  'tab-work': {
    viewBox: '0 0 24 24',
    shapes: [
      { tag: 'rect', x: 4, y: 4, width: 7, height: 7, rx: 1.4 },
      { tag: 'rect', x: 13, y: 4, width: 7, height: 7, rx: 1.4 },
      { tag: 'rect', x: 4, y: 13, width: 7, height: 7, rx: 1.4 },
      { tag: 'rect', x: 13, y: 13, width: 7, height: 7, rx: 1.4 },
    ],
  },
  'tab-msg': {
    viewBox: '0 0 24 24',
    shapes: [{ tag: 'path', d: 'M5 5.5h14v10.5H8.5L5 19.5V5.5z' }],
  },
  'tab-mine': {
    viewBox: '0 0 24 24',
    shapes: [
      { tag: 'circle', cx: 12, cy: 8, r: 3 },
      { tag: 'path', d: 'M5.5 19.5c1.2-3.2 3.6-4.7 6.5-4.7s5.3 1.5 6.5 4.7' },
    ],
  },

  /* ---------------- 首页四大模块（HomeSheet） ---------------- */

  'mod-safety': {
    viewBox: '0 0 24 24',
    attrs: MOD_STROKE,
    shapes: [
      { tag: 'path', d: 'M12 3.5 19 6.2v5.4c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V6.2z' },
      { tag: 'path', d: 'M8.8 12.2 11 14.4l4.4-4.6' },
    ],
  },
  'mod-quality': {
    viewBox: '0 0 24 24',
    attrs: MOD_STROKE,
    shapes: [
      { tag: 'rect', x: 6.2, y: 3.8, width: 11.6, height: 16.4, rx: 2 },
      { tag: 'path', d: 'M9 3.8h6v2.6H9z' },
      { tag: 'path', d: 'M8.7 12.4 10.8 14.5l4.6-4.8' },
    ],
  },
  'mod-progress': {
    viewBox: '0 0 24 24',
    attrs: MOD_STROKE,
    shapes: [
      { tag: 'circle', cx: 12, cy: 12, r: 8 },
      { tag: 'path', d: 'M12 8v4.2l3 1.6' },
    ],
  },
  'mod-equip': {
    viewBox: '0 0 24 24',
    attrs: MOD_STROKE,
    shapes: [
      { tag: 'path', d: 'M4.5 20h15' },
      { tag: 'path', d: 'M7 20V7.5h3.2V20' },
      { tag: 'path', d: 'M8.6 7.5H20l-3.2 6.2' },
      { tag: 'path', d: 'M16.8 13.7V20' },
      { tag: 'circle', cx: 16.8, cy: 11.2, r: 1.1 },
    ],
  },

  /* ---------------- 「我的」菜单（原 app.js:17-21，配色由 .menu-ico svg 提供） ---------------- */

  'menu-sites': {
    viewBox: '0 0 24 24',
    shapes: [{ tag: 'path', d: 'M5 20V7.5L12 4l7 3.5V20 M9.5 20v-5h5v5' }],
  },
  'menu-setting': {
    viewBox: '0 0 24 24',
    shapes: [
      {
        tag: 'path',
        d: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M4.5 12h2 M17.5 12h2 M6.2 6.2l1.5 1.5 M16.3 16.3l1.5 1.5 M6.2 17.8l1.5-1.5 M16.3 7.7l1.5-1.5',
      },
    ],
  },
  'menu-about': {
    viewBox: '0 0 24 24',
    shapes: [{ tag: 'path', d: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 11v5 M12 8v.5' }],
  },

  /* ---------------- 消息页图标（原 msgIco） ---------------- */

  'msg-people': {
    viewBox: '0 0 24 24',
    attrs: WHITE_STROKE,
    shapes: [
      { tag: 'circle', cx: 12, cy: 8.2, r: 2.8 },
      { tag: 'path', d: 'M5.8 19.2c.8-3.2 3.1-4.8 6.2-4.8s5.4 1.6 6.2 4.8' },
    ],
  },

  /* ---------------- 工作台快捷入口与工具卡 ---------------- */

  'work-cam': {
    viewBox: '0 0 24 24',
    attrs: WHITE_STROKE,
    shapes: [
      { tag: 'path', d: 'M4.5 8.2h10.2v9.2H4.5z' },
      { tag: 'path', d: 'M14.7 11.2 19.5 8.8v8.2l-4.8-2.4z' },
    ],
  },
  'work-hazard': {
    viewBox: '0 0 24 24',
    attrs: WHITE_STROKE,
    shapes: [
      { tag: 'path', d: 'M4.4 9.2h3.1l1.3-2.2h6.4l1.3 2.2h3.1v9.2H4.4z' },
      { tag: 'circle', cx: 12, cy: 13.9, r: 3.1 },
    ],
  },
  'work-todo': {
    viewBox: '0 0 24 24',
    attrs: WHITE_STROKE,
    shapes: [
      { tag: 'rect', x: 4.5, y: 4.5, width: 15, height: 15, rx: 3, 'stroke-dasharray': '3 3' },
      { tag: 'path', d: 'M12 9v6M9 12h6' },
    ],
  },
  'tool-vertical': {
    viewBox: '0 0 24 24',
    attrs: WHITE_STROKE,
    shapes: [
      { tag: 'rect', x: 4.5, y: 3.5, width: 6.2, height: 17, rx: 1.2 },
      { tag: 'rect', x: 13.3, y: 3.5, width: 6.2, height: 17, rx: 1.2 },
      {
        tag: 'path',
        d: 'M7.6 9.2v-2.4M7.6 9.2l-1.2-1.2M7.6 9.2l1.2-1.2M16.4 14.8v2.4M16.4 14.8l-1.2 1.2M16.4 14.8l1.2 1.2',
      },
    ],
  },
  'tool-horizontal': {
    viewBox: '0 0 24 24',
    attrs: WHITE_STROKE,
    shapes: [
      { tag: 'path', d: 'M4 14.5h2.2l1.6-4.2h8.2L18 14.5h2' },
      { tag: 'path', d: 'M5 14.5v3.2h14V14.5' },
      { tag: 'circle', cx: 8, cy: 18.2, r: 1.4 },
      { tag: 'circle', cx: 16, cy: 18.2, r: 1.4 },
      { tag: 'path', d: 'M7.8 10.3 9 7.8h6.2' },
    ],
  },
  'tool-nav': {
    viewBox: '0 0 24 24',
    attrs: WHITE_STROKE,
    shapes: [
      { tag: 'path', d: 'M21 4 3.8 11.2l7.4 1.6L12.8 20z' },
      { tag: 'path', d: 'M11.2 12.8 21 4' },
    ],
  },

  /* ---------------- 通用 ---------------- */

  /** 四轴飞行器 / 巡检：消息页 inspect 与工作台「航拍照片」共用同一几何 */
  drone: {
    viewBox: '0 0 24 24',
    attrs: WHITE_STROKE,
    shapes: [
      { tag: 'circle', cx: 6.2, cy: 6.2, r: 2 },
      { tag: 'circle', cx: 17.8, cy: 6.2, r: 2 },
      { tag: 'circle', cx: 6.2, cy: 17.8, r: 2 },
      { tag: 'circle', cx: 17.8, cy: 17.8, r: 2 },
      { tag: 'path', d: 'M8.2 6.2h7.6M8.2 17.8h7.6M6.2 8.2v7.6M17.8 8.2v7.6' },
      { tag: 'rect', x: 10, y: 10, width: 4, height: 4, rx: 0.8 },
    ],
  },

  /** 里程碑旗帜（原 app.js:489，两条 path 自带表现属性） */
  'ms-flag': {
    viewBox: '0 0 24 24',
    shapes: [
      {
        tag: 'path',
        d: 'M7 21V4',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.8,
        'stroke-linecap': 'round',
      },
      { tag: 'path', d: 'M8 4.4h10.2l-2.6 3.6 2.6 3.6H8z', fill: 'currentColor' },
    ],
  },

  /** 日历（原 app.js:1077） */
  cal: {
    viewBox: '0 0 24 24',
    attrs: CAL_STROKE,
    shapes: [
      { tag: 'rect', x: 4, y: 5, width: 16, height: 15, rx: 2 },
      { tag: 'path', d: 'M4 10h16M8 3v4M16 3v4' },
    ],
  },
} satisfies Record<string, IconDef>

/**
 * 可用图标名（由 ICON_MAP 的键推导，SvgIcon 的 name 属性即取此联合类型）。
 * 注意先推导键、再统一收敛成 IconDef —— 若直接导出 satisfies 的结果，
 * 类型会停留在「各图标字面量形状的联合」，取不到可选的 attrs 字段。
 */
export type IconName = keyof typeof ICON_MAP

/** 图标表（对外统一按 IconDef 读取） */
export const ICONS: Record<IconName, IconDef> = ICON_MAP
