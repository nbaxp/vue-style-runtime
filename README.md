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

## 从 0.5.x 升级（0.6.0 起，当前 1.0.0）

0.6.0 只保留运行时 mixin：底层函数（`addStyles`、`scopeCss`、`scopeSelector` 等）不再导出，原先单独调用的用法改为挂载 `styleMixin`；同时移除 Vue 2 支持（`destroyed`、Vue 2 VNode 字段与 `constructor.options` 回退全部删除），`peerDependencies` 收紧为 `vue: ^3.0.0`。组件身份现在只认 `$.type`，同一组件定义的实例仍共享样式节点。1.0.0 未改动公共 API，仍只导出默认导出与 `styleMixin`。

## 开发、构建与预览

```bash
npm install
npm run dev      # 开发服务器，入口是根目录 index.html，引用 src/demo.js 与源码 index.js
npm run build    # 先构建演示页，再构建库产物
npm run preview  # 本地预览 dist 里的演示页（需先 npm run build）
```

`npm run build` 依次执行：

- `npm run build:demo`：Vite 以根目录 `index.html` 为入口构建演示页，输出 `dist/index.html` 与 `dist/assets/*`。
- `npm run build:lib`：Vite 库构建依次输出未压缩的 `dist/index.js` 与经 terser 压缩的 `dist/index.min.js`，不清空上一步的演示产物。

`dist` 分层如下：

| 路径                             | 用途                         | 体积（gzip）        | 是否发布到 npm |
| -------------------------------- | ---------------------------- | ------------------- | -------------- |
| `dist/index.js`                  | 库产物（未压缩 ESM）         | 25.32 kB（4.81 kB） | 是             |
| `dist/index.min.js`              | 库产物（压缩 ESM）           | 10.14 kB（3.44 kB） | 是             |
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

根目录 [`index.html`](index.html) 是演示页：左侧编辑 SFC 风格的 `<template>` 与 `<style>`（可带 `scoped`），右侧约 300ms 防抖后真实重新挂载组件；页面底部实时展示 `<head>` 中被改写的 CSS、实例计数与作用域标记。内置“基础 scoped / `:deep` 穿透 / `:slotted` 插槽”预设，并提供“重新挂载”“卸载预览”验证 `unmounted` 清理。

演示逻辑在 [`src/demo.js`](src/demo.js)，直接 `import styleMixin from '../index.js'`（源码入口，不是 dist）；Vue 通过 esm.sh 的完整浏览器构建引入（页面内可运行时编译模板）。本地开发与预览命令见「开发、构建与预览」，开发服务器默认 `http://localhost:5173/`。

### GitHub Pages

打 `v*` Tag 时，[`.github/workflows/pages.yml`](.github/workflows/pages.yml) 会安装依赖、执行 `npm run build:demo`，并通过 `peaceiris/actions-gh-pages` 把 `dist` 内容推送到 `gh-pages` 分支（该 action 默认生成 `.nojekyll`，避免 Vue 模板中的 `{{ }}` 被 Jekyll/Liquid 解析）。

1. 仓库 Settings → Pages → Build and deployment，Source 选择 **Deploy from a branch**。
2. Branch 选 `gh-pages`，目录选 `/ (root)`，保存。
3. 部署完成后访问 `https://<user>.github.io/vue-style-runtime/`。

构建使用 `base: './'`，页面内资源全部是相对路径，因此部署在项目子路径 `/vue-style-runtime/` 下也能正确加载。

## 测试

```bash
npm test   # node --test "tests/**/*.test.js"，jsdom 环境
```

覆盖注入与计数、回滚、选择器改写、at-rule、转义与容错、Vue 3 VNode 归属与生命周期。测试只通过 `styleMixin` 的公共入口驱动。`tests/` 与 jsdom 只用于开发；发布 `files` 为 `dist/index.js` 与 `dist/index.min.js`（README 由 npm 自动包含）。

## 发布

1. 首次发布：包在 npm 上尚不存在，无法配置 Trusted Publisher；本地 `npm login` 后执行 `npm publish`（需 npm 账号 2FA）。
2. 首次发布完成后，到 npm 包页面 Settings → Trusted publishing 绑定本仓库与工作流（`.github/workflows/publish.yml`），此后由 CI 通过 OIDC 发布，无需长期 token。
3. 后续版本：修改 `package.json` 的 `version` 并提交，然后 `git tag vX.Y.Z && git push origin vX.Y.Z`；工作流依次校验标签与版本、安装依赖、测试、`npm pack`、`npm publish`，并创建同名 GitHub Release 附 `.tgz`。发布的是 `npm pack` 生成的 tarball，其中包含 `dist/index.js` 与 `dist/index.min.js`；`npm pack` 会触发 `prepack` 构建这两份库产物，因此工作流不再单独执行构建。
4. 工作流也可手工触发，默认 `dry_run=true` 只执行 `npm publish --dry-run`；手动正式发布须选择 `v*` Tag 并设置 `dry_run=false`。
