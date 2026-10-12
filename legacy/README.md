# legacy/ —— 迁移前原版（冻结，不参与构建）

本目录存放**迁移前的原始静态 H5 实现**，仅作参考，**不会被 Vite 打包，也不应修改**。

## 为什么保留

1. **溯源**：`src/` 下约 120 条注释以 `原 js/app.js:行号` 的形式标注实现出处
   （例如 `src/utils/chart.ts` 的 `alarmTrendSvg` 对应 `原 js/app.js:132-181`）。
   保留原文件可让这些行号随时可核对。
2. **行为对照**：接入后端接口时，需要反复对照原版的取数与渲染行为。

## 文件

| 文件 | 内容 |
|---|---|
| `app.js` | 迁移前的单文件实现，1,730 行 / 193 个顶层声明 / 23 个 `render*` / 22 处 `innerHTML` |

迁移前的 `index.html`（353 行）与 `css/app.css`（4,548 行）未复制到此目录：
- `css/app.css` 已**逐字搬运**到 `src/styles/app.css`（仅 1 行 `url()` 因目录变深而改用根绝对路径）
- `index.html` 已成为 Vite 入口，且其中的静态结构已拆入各 Vue 组件

两者如需查阅，见基线提交：

```bash
git show 4c67882:index.html
git show 4c67882:css/app.css
```

## 完整基线

迁移前的完整状态存档在提交 `4c67882`（`chore: 原版静态 H5 基线（迁移前存档）`），
包含当时的 `index.html` / `js/app.js` / `css/app.css` / `img/` 全部 22 个文件。

```bash
# 查看原版全部文件
git ls-tree -r --name-only 4c67882

# 还原某个文件到指定路径
git show 4c67882:js/app.js > /tmp/app.js.orig
```

## 迁移时已知的原版缺陷（未修复，1:1 复刻）

以下问题在迁移中被**如实保留**（详见各提交说明）：

| 位置 | 问题 |
|---|---|
| `app.js:1729` | `setInterval(tick, 1000)` 句柄未保存，永不停止 |
| `app.js:309` | 轮播回卷的 `setTimeout` 句柄未保存，`stopAlarmFeed` 清不掉 |
| `app.js:875` | `#btnBack` 把事件对象当 `force` 传入 `closeSub`，恒不等于 `true` |
| `app.js:1197` / `1702` | 打开/关闭任意 cam 播放器会无条件清掉地图横屏态 |
| `app.js:1557` | `#btnAirClose` 只 `remove("open")` 未设 `hidden`，与 `#btnShotPop` 不一致 |
| `app.js:1400/1429` | `hazardDesc` 写后不读 —— 隐患描述文本实际不会提交 |
| — | `closeMapLand` 设 `aria-hidden="true"` 时按钮仍持有焦点（浏览器 a11y 警告） |

## 未迁移的死代码

原版中存在大量不可达代码，迁移时**未搬运**（两个独立分析交叉验证）：

- **横屏地图未实现链**：`startLandKpis` 零调用，级联导致 `startLandEq` /
  `renderLandEq` / `startLandQa` / `renderLandQa` / `startLandPg` / `renderLandPg`
  等 12 个函数不可达；其 DOM 目标 `#landEqCard` / `#landQaCard` /
  `#landPgList` / `#landPgDots` 在 HTML 中根本不存在
- `renderScene`(105) 与级联的 `camById`(84)、`renderCamCard`(88)
- `camPosCycle`(29)、`camDayLabel`(1057)、`calMaxMonth`(1086)
- 连带 `homePanels` 委托里处理 `.cam-cfg` / `.cam-star` / `.cam-card` 的三个分支

CSS 侧对应约 20~30% 的孤儿样式（`.land-*` / `.cam-search` / `.ai-*` / `.crew-*` /
`kpi` 等），**本次未删除**，作为后续瘦身空间保留在 `src/styles/app.css` 中。
