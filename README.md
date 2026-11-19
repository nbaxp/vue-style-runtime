# vue-style-runtime

Vue 3 运行时组件样式注入与 Scoped CSS 改写。

没有 SFC 编译时，组件里的 `<style scoped>` 不会在构建期被改写。本包在浏览器端完成这件事：把 `styles` 字符串注入 `<head>`，按实例数引用计数，并在挂载/更新时按 VNode 归属给元素打 `data-scope-*` 属性，实现 scoped 隔离。

**只支持 Vue 3**：不兼容 Vue 2 / Vue 2.7，也不再包含对应分支。

**不是** SFC 编译器：不解析 `.vue`、不编译模板，也不编译 `lang="scss"` 等预处理语法。scoped 标记依赖 Vue 内部字段，见「已知限制」。

## 安装与用法

通过 npm 安装，`peerDependencies` 要求宿主提供 Vue `^3.0.0`：

```bash
npm i vue-style-runtime
```

```js
import styleMixin from 'vue-style-runtime';

export default {
  name: 'AppDialog',
  mixins: [styleMixin],

  // 必须是组件 options 上的非空字符串，created 时只读一次
  styles: /* HTML */ `
    <style scoped>
      .app-dialog {
        padding: 12px;
      }
      .app-dialog :deep(.el-button) {
        margin: 0;
      }
    </style>
    <link rel="stylesheet" href="/plugins/app-dialog/style.css" />
  `,

  template: /* HTML */ `<div class="app-dialog"><slot /></div>`,
};
```

`styles` 顶层只识别 `<style>` 与 `<link>`：`<style>` 带 `scoped` 属性才改写，普通 `<style>` 原样注入；`<link>` 的 `rel` 按空白分词后包含 `stylesheet` 才注入；其它标签与其它 `rel` 一律忽略。

## scoped 选择器

改写方式是给选择器追加 `[data-scope-uid_N]`，插槽目标用 `[data-scope-uid_N-s]`。它是属性选择器，不是 `:where()`，会提高优先级。

| 输入                        | 输出                           | 实际行为                                                                          |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| `.a > .b .c`                | `.a > .b .c[data-scope-uid_N]` | 复合选择器与组合器保留，属性追加在最后一个复合选择器末尾                          |
| `.a, .b`                    | `.a[attr], .b[attr]`           | 顶层逗号由 `scopeSelectorList` 拆开逐条改写，再以 `, ` 连接                       |
| `.a:is(.b, .c) .d`          | `.a:is(.b, .c) .d[attr]`       | `:is()` / `:where()` / `:not()` 括号内的逗号不切分                                |
| `[data-label="a,b"] .x`     | `[data-label="a,b"] .x[attr]`  | 属性选择器、引号与注释内的逗号不切分；已存在同名属性时不重复追加                  |
| `.\31 23 .x`                | `.\31 23 .x[attr]`             | 引号外的 CSS 转义整体跳过，不参与切分                                             |
| `&:hover`                   | `&:hover[attr]`                | 原生 `&` 只改写当前复合选择器；嵌套块 body 原样交给浏览器 CSS nesting，不二次改写 |
| `.a > :deep(.b)`            | `.a[attr] > .b`                | 只作用域化左侧，`>` 组合器保留                                                    |
| `.a :deep(.b, .c)`          | `.a[attr] .b, .a[attr] .c`     | `:deep()` 多参数展开为多条                                                        |
| `.a :slotted(.b)`           | `.a .b[attr-s]`                | 只给插槽目标加 `-s`，外层不加普通 scope                                           |
| `.a :global(.x)`            | `.a .x`                        | 本项目自定义语义（非 Vue 官方特性）：保留外层文本、不做任何作用域化               |
| `.a >>> .b`、`.a /deep/ .b` | `.a[attr] .b`                  | 先归一化成 `:deep()`；`.a > /deep/ .b` → `.a[attr] > .b`                          |
| `.a:hover::before`          | `.a:hover[attr]::before`       | 属性插在双冒号伪元素之前；单冒号旧写法 `:before` 不特殊处理                       |

## at-rule

- 分组规则内部的选择器照常作用域化，并递归处理嵌套：`@media`、`@supports`、`@layer`、`@container`、`@starting-style`、`@scope`（代码内另有 `@document`）。
- `@keyframes` 整块跳过，`from` / `to` / 百分比选择器不追加属性；`@-webkit-`、`@-moz-`、`@-o-` 以及任意 `@-*-keyframes` 同样跳过。
- 语句型 `@import`、`@charset`（以 `;` 结束）原样保留，其后的规则继续作用域化。
- 其它 at-rule 声明块（`@font-face`、`@page`、`@property` 等）原样保留，不转换。
- 非法或残缺 CSS（找不到 `{`、大括号不配对）不抛错，从问题位置起原样保留。

## 作用域归属

`mounted` / `updated` 时遍历组件内部实例的渲染树（`$.subTree`）：

- 本实例创建的元素 → `[data-scope-uid_N]`。
- 模板中的子组件根节点 → 父组件 scope 必加；若该组件自身又是其父组件的直接渲染根（自身组件 VNode 等于父组件渲染树），继续加祖父 scope，逐层向上。
- 祖先组件传入的插槽内容 → `[data-scope-uid_N-s]`。
- 子组件内部的普通元素不加当前组件 scope。
- 最后对 `$el` 兜底打属性；Fragment 的注释锚点因 `nodeType !== 1` 被忽略。

Fragment 单根：过滤 `type` 为 `Symbol` 的子节点（Comment / Text / 内层 Fragment）后只剩一个有效节点才作为继承根，多根不继承。

依赖的 Vue 3 字段：`$.type`、`$.subTree`、`vnode.component`、`vnode.ctx`、`instance.parent`、`instance.proxy`、`vnode.el`、`ssContent` / `ssFallback`、`$el`。

遍历用 `WeakSet` / `Set` 防循环，选择器递归最多 32 层。

## 生命周期与样式注入

- `created`：读 `$options.styles`，非空字符串才继续；按组件身份分配 `uid_N`；样式注入成功才登记实例。
- `mounted` / `updated`：`applyScopeAttr`。未登记，或该组件样式不含 `scoped` 时直接返回；否则遍历渲染树并给 `$el` 兜底。
- `unmounted`：`removeInstanceStyles`，实例计数减一；归零时移除该组件的全部样式节点并删除登记，未归零只更新计数。
- 注入：用 `document.createElement('template')` 解析 `styles`，遍历 `content.children`。scoped `<style>` 克隆后去掉 `scoped`、补 `type="text/css"`、加 `data-vue-style-scoped="data-scope-uid_N"`，`textContent` 换成改写后的 CSS；非 scoped 节点原样使用。
- 每个节点追加 class `uid_N` 和 `data-vue-component-instances="<当前实例数>"`，再 `document.head.appendChild`。构建/追加过程中任意一步出错，移除本次已追加节点并抛出原错误。
- 组件身份取 `$.type`（组件定义对象或函数）；同一身份的所有实例共享一组节点。无 `document` 环境，或解析后没有可注入节点时，视为注入失败，不登记实例。

## 导出

只有 mixin 一个公共 API：默认导出与具名导出 `styleMixin` 是同一个对象，`{ created, mounted, updated, unmounted }`。

```js
import styleMixin from 'vue-style-runtime';
// 或
import { styleMixin } from 'vue-style-runtime';
```

CSS 改写、VNode 标记、样式注入等函数均为内部实现，不再导出。

## 已知限制

- 只扫描 `styles` 顶层直接子元素（`template.content.children`）：顶层文本与注释丢弃，包在其它元素内的 `<style>` / `<link>` 不会被识别。
- `<link>` 不等待加载，首屏可能出现无样式闪烁。
- 原生 `&` 依赖浏览器 CSS nesting，最低版本：Chrome 112+ / Safari 17.2+ / Firefox 121+；更低版本下嵌套规则不生效。
- 依赖 Vue 3 非公开字段：`$.type`、`$.subTree`、`vnode.component`、`vnode.ctx`、`parent`、`proxy`、`vnode.el`、`ssContent` / `ssFallback`、`$el`。升级 Vue 大版本需回归 scoped 用例。
- `styles` 在 `created` 只读一次，实例运行期修改不生效；每次新建 options 对象会得到新的组件身份并重复注入。
- 样式节点被外部移除后不会恢复；实例卸载也不会清除元素上已打的属性，被手工复用的节点会保留旧属性。
- 追加的属性选择器会提高优先级，没有 `:where()` 降权。
- 不做预处理：`lang="scss"` 等属性会保留，但内容不会被编译。

## 从 0.5.x 升级（0.6.0 起，当前 1.0.2）

0.6.0 只保留运行时 mixin：底层函数（`addStyles`、`scopeCss`、`scopeSelector` 等）不再导出，原先单独调用的用法改为挂载 `styleMixin`；同时移除 Vue 2 支持（`destroyed`、Vue 2 VNode 字段与 `constructor.options` 回退全部删除），`peerDependencies` 收紧为 `vue: ^3.0.0`。组件身份现在只认 `$.type`，同一组件定义的实例仍共享样式节点。1.0.0 未改动公共 API，仍只导出默认导出与 `styleMixin`。

## 开发、构建与预览

```bash
npm install
npm run dev      # 开发服务器，入口是根目录 index.html，引用 src/demo.js 与源码 index.js
npm run build    # 先构建演示页，再构建库产物
npm run preview  # 本地预览 dist 里的演示页（需先 npm run build）
```

`npm run build` 依次执行：

- `vite build`：以根目录 `index.html` 为入口构建演示页，输出 `dist/index.html` 与 `dist/assets/*`。
- `npm run build:lib`：Vite 库构建依次输出未压缩的 `dist/index.js` 与经 Oxc 压缩的 `dist/index.min.js`，不清空上一步的演示产物。

`dist` 分层如下：

| 路径                             | 用途                         | 体积（gzip）        | 是否发布到 npm |
| -------------------------------- | ---------------------------- | ------------------- | -------------- |
| `dist/index.js`                  | 库产物（未压缩 ESM）         | 22.96 kB（5.16 kB） | 是             |
| `dist/index.min.js`              | 库产物（压缩 ESM）           | 13.48 kB（3.84 kB） | 是             |
| `dist/index.html`、`dist/assets/` | 演示页（preview / gh-pages） | —                   | 否             |

库产物无外部依赖，只导出 `default` 与 `styleMixin`，可直接用 `<script type="module">` 或 importmap 引入：

```html
<script type="module">
  import styleMixin from './dist/index.js';
</script>
```

压缩版通过子路径单独暴露，既可按包名 import，也可让 CDN 按文件路径直接取：

```js
import styleMixin from 'vue-style-runtime/index.min.js';
```

```html
<script type="module">
  import styleMixin from 'https://cdn.jsdelivr.net/npm/vue-style-runtime/dist/index.min.js';
</script>
```

`dist` 已在 `.gitignore` 中忽略。`main`、`module`、`exports["."]` 均指向 `dist/index.js`；`exports["./index.min.js"]` 指向 `dist/index.min.js`；`files` 发布这两份库产物，所以 `dist/index.html`、`dist/assets/` 等演示产物不会进入 npm tarball。`prepack` 运行 `npm run build:lib`（两份都会重新生成），`prepublishOnly` 运行测试。

## 在线演示

根目录 [`index.html`](index.html) 是演示页：左侧编辑 SFC 风格的 `<template>` 与 `<style>`（可带 `scoped`），右侧约 300ms 防抖后真实重新挂载组件；页面底部实时展示 `<head>` 中被改写的 CSS、实例计数与作用域标记。内置示例同时用到基础 scoped、`:deep` 穿透与 `:slotted` 插槽，可随时“重置示例”。

演示逻辑在 [`src/demo.js`](src/demo.js)，直接 `import styleMixin from '../index.js'`（源码入口，不是 dist）；Vue 来自本地开发依赖 `vue/dist/vue.esm-bundler.js`（完整构建，页面内可运行时编译模板），编译期特性开关在 `vite.config.js` 的 `define` 中声明。本地开发与预览命令见「开发、构建与预览」，开发服务器默认 `http://localhost:5173/`。

### GitHub Pages

打 `v*` Tag 时，[`.github/workflows/pages.yml`](.github/workflows/pages.yml) 会安装依赖，执行 `npm run build`（演示页运行时按同目录地址加载库入口，因此 `dist/index.js` 必须一并构建），并通过 `peaceiris/actions-gh-pages` 把 `dist` 内容推送到 `gh-pages` 分支（该 action 默认生成 `.nojekyll`，避免 Vue 模板中的 `{{ }}` 被 Jekyll/Liquid 解析）。

1. 仓库 Settings → Pages → Build and deployment，Source 选择 **Deploy from a branch**。
2. Branch 选 `gh-pages`，目录选 `/ (root)`，保存。
3. 部署完成后访问 `https://<user>.github.io/vue-style-runtime/`。

构建使用 `base: './'`，页面内资源全部是相对路径，因此部署在项目子路径 `/vue-style-runtime/` 下也能正确加载。

## 测试

```bash
npm test   # node --test "tests/**/*.test.js"，jsdom 环境
```

覆盖注入与计数、回滚、选择器改写、at-rule、转义与容错、Vue 3 VNode 归属与生命周期。测试只通过 `styleMixin` 的公共入口驱动。`tests/` 与 jsdom 只用于开发；发布 `files` 为 `dist/index.js` 与 `dist/index.min.js`（README 由 npm 自动包含）。

## 性能基准

```bash
npm run bench   # node benchmarks/css.bench.mjs
```

微基准，分两部分：

| 部分 | 测什么 | scope 维度 | 复杂度维度 |
| ---- | ------ | ---------- | ---------- |
| Part 1 核心转换 | 内部 `scopeCss` 纯函数，无 DOM 开销 | `no-scope`（需追加作用域）/ `with-scope`（已带属性、早退） | simple / medium / complex |
| Part 2 端到端注入 | `styleMixin` 公共入口 + jsdom | `scoped` / `plain` | simple / medium / complex |

每格为 7 轮、每轮 300 次调用的中位数，计时前预热。输入分三档：simple 为单条规则，medium 含 `:deep` / `:slotted` / `:global` 与多选择器，complex 含属性选择器、字符串、注释、CSS 转义、历史 `/deep/` 与 `>>>`、分组 at-rule 嵌套和 `@keyframes`。

读数的几个要点：

- **绝对值受机器与负载影响**，跨次运行、跨机器不可直接比；同一份输出内的倍率和组间对比更可参考。
- **DOM 注入主导端到端成本**：jsdom 下 `scoped` 的 simple 规则里，绝大部分耗时是 `importNode` / `appendChild`，CSS 转换本身只占很小一部分；复杂度升高后转换成本才逐步显现。
- **`with-scope` 不比 `no-scope` 快**：早退只省掉"追加属性"这一步，输入文本更长、仍须全量扫描，差异通常淹没在噪声里。
- **`plain` 仍需注入**：无 `scoped` 时跳过 CSS 转换，但大文本节点的 DOM 开销仍在，complex 下与 `scoped` 差距会缩小。

### 判定标准

脚本带基线回归判定，命令：

```bash
npm run bench                          # 首轮：生成基线；之后：与基线对比并判定
npm run bench -- --update-baseline     # 用当前结果覆盖基线（代码或环境变化后重建）
npm run bench -- --tolerance=0.3       # 自定义阈值，默认 0.2（+20%）
```

基线存于 `benchmarks/baseline.json`，已加入 `.gitignore`，只在本地生成、不入库。它记录每个用例的中位值与各轮采样，并附带环境指纹（Node 版本、平台、架构、CPU）和阈值配置。

判定采用**相对阈值 + 绝对噪声地板**双门槛，逐用例独立判断：

- **SLOWER**（回归）：当前值比基线慢超过 `tolerance`（默认 +20%）**且**绝对增量大于噪声地板（默认 0.01ms，并取基线自身抖动范围的两倍作为第二重地板）。出现任一 SLOWER，进程退出码为 1，便于接入脚本或 CI。
- **FASTER**：快超过阈值，仅记录，不算失败。
- **OK**：其余情况。亚毫秒级、低于地板的波动一律判 OK，不因噪声误报。

之所以用双门槛：simple 用例本身只有几微秒，纯百分比会让 ±10% 的抖动触发误报；绝对地板过滤掉这类无实际意义的差异。

**环境指纹不一致时（Node / 平台 / 架构 / CPU 任一不同）只显示数值、跳过 PASS/FAIL**——跨机器绝对值不可比，换机器需先 `--update-baseline` 重建基线。基线只用于同一环境下的纵向对比，不要拿它比较不同机器。

参考区间（本机 Node v22.22.2 / win32 x64 / i7-12700H，7 轮 × 300 次中位数，仅供量级参照，**不是合格线**）：

| 部分 | 场景 | simple | medium | complex |
| ---- | ---- | ------ | ------ | ------- |
| Part 1 核心转换 | no-scope | ~0.002 ms | ~0.009 ms | ~0.13 ms |
| Part 1 核心转换 | with-scope | ~0.003 ms | ~0.008 ms | ~0.14 ms |
| Part 2 端到端注入 | scoped | ~0.12–0.52 ms | ~0.14–0.50 ms | ~1.6–4.2 ms |
| Part 2 端到端注入 | plain | ~0.05–0.19 ms | ~0.08–0.31 ms | ~1.3–3.8 ms |

这些区间跨轮波动明显（端到端场景受 jsdom 与机器负载影响可达数倍），因此判定依赖本地基线而非写死的绝对数值。

实现上，内部函数未公开导出，基准脚本在内存中给源码追加一条导出、以 data URL 加载，**不修改 `index.js`，也不改变公共 API**。`benchmarks/` 与 jsdom 只用于开发，不进入 npm 发布内容。

## 发布

1. 首次发布：包在 npm 上尚不存在，无法配置 Trusted Publisher；本地 `npm login` 后执行 `npm publish`（需 npm 账号 2FA）。
2. 首次发布完成后，到 npm 包页面 Settings → Trusted publishing 绑定本仓库与工作流（`.github/workflows/publish.yml`）。
3. 后续版本：修改 `package.json` 的 `version` 并提交，然后 `git tag vX.Y.Z && git push origin vX.Y.Z`。工作流会安装依赖、构建、测试，再执行 `npm publish`；发布内容由 `files` 字段决定，只含 `dist/index.js` 与 `dist/index.min.js`。
