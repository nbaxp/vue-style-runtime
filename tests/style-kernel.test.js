import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeCss, setupDom } from './helpers.js';

setupDom();

test('嵌套规则内的 :deep() 脱壳，穿透目标不加 scope', () => {
  const css = '.card { :deep(.icon) { color: red; } }';
  assert.equal(
    scopeCss(css),
    '.card[data-scope-test]{ .icon { color: red; } }',
  );
});

test('嵌套规则内的普通类选择器也加 scope，避免穿透子组件', () => {
  const css = '.card { .title { color: red; } }';
  assert.equal(
    scopeCss(css),
    '.card[data-scope-test]{ .title[data-scope-test] { color: red; } }',
  );
});

test(':global() 整条规则不参与作用域', () => {
  assert.equal(scopeCss(':global(.x) { }'), '.x{ }');
  assert.equal(scopeCss('.a :global(.x) { }'), '.a .x{ }');
});

test('/deep/ 与 >>> 旧写法：左侧作用域化，右侧不再标记', () => {
  assert.equal(scopeCss('.a /deep/ .b { }'), '.a[data-scope-test] .b{ }');
  assert.equal(scopeCss('.a >>> .b { }'), '.a[data-scope-test] .b{ }');
  assert.equal(scopeCss('/deep/ .b { }'), '[data-scope-test] .b{ }');
  assert.equal(
    scopeCss('.a /deep/ .b::before { }'),
    '.a[data-scope-test] .b::before{ }',
  );
});

test('@layer / @container / @starting-style 内部选择器作用域化', () => {
  assert.equal(
    scopeCss('@layer base { .a { color: red; } }'),
    '@layer base { .a[data-scope-test]{ color: red; } }',
  );
  assert.equal(
    scopeCss('@container (min-width: 30rem) { .a { color: red; } }'),
    '@container (min-width: 30rem) { .a[data-scope-test]{ color: red; } }',
  );
  assert.equal(
    scopeCss('@starting-style { .a { opacity: 0; } }'),
    '@starting-style { .a[data-scope-test]{ opacity: 0; } }',
  );
});

test('语句型 at-rule 原样保留，后续规则继续作用域化', () => {
  assert.equal(
    scopeCss('@import url("x.css"); .a { color: red; }'),
    '@import url("x.css"); .a[data-scope-test]{ color: red; }',
  );
  assert.equal(scopeCss('@charset "utf-8";'), '@charset "utf-8";');
});

test('@-webkit-keyframes 整块跳过，后续规则照常作用域化', () => {
  const css =
    '@-webkit-keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a { color: red; }';
  assert.equal(
    scopeCss(css),
    '@-webkit-keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a[data-scope-test]{ color: red; }',
  );
});

test('非法 / 不完整 CSS 原样保留且不吞掉后续规则', () => {
  assert.equal(scopeCss('.a { color: red'), '.a { color: red');
  assert.equal(
    scopeCss('.a { color: red; } .b {'),
    '.a[data-scope-test]{ color: red; } .b {',
  );
});

// ---- CSS nesting：规则体内的选择器 ----------------------------------------

test('嵌套 :deep() 左侧保留 scope，右侧穿透目标保持原样', () => {
  assert.equal(
    scopeCss('.card { .head :deep(.icon) { color: red; } }'),
    '.card[data-scope-test]{ .head[data-scope-test] .icon { color: red; } }',
  );
});

test('嵌套 :deep() 多参数展开为多条', () => {
  assert.equal(
    scopeCss('.card { :deep(.a, .b) { color: red; } }'),
    '.card[data-scope-test]{ .a, .b { color: red; } }',
  );
});

test('嵌套 :slotted() 只给插槽目标加 -s，:global() 完全脱壳', () => {
  assert.equal(
    scopeCss('.card { :slotted(.item) { color: red; } }'),
    '.card[data-scope-test]{ .item[data-scope-test-s] { color: red; } }',
  );
  assert.equal(
    scopeCss('.card { :global(.x) { color: red; } }'),
    '.card[data-scope-test]{ .x { color: red; } }',
  );
});

test('嵌套历史 /deep/ 与 >>> 归一后脱壳', () => {
  assert.equal(
    scopeCss('.card { .head >>> .icon { color: red; } }'),
    '.card[data-scope-test]{ .head[data-scope-test] .icon { color: red; } }',
  );
  assert.equal(
    scopeCss('.card { /deep/ .icon { color: red; } }'),
    '.card[data-scope-test]{ .icon { color: red; } }',
  );
});

test('嵌套 & 复合不重复加 scope，& 后代目标仍加 scope', () => {
  assert.equal(
    scopeCss('.card { &:hover { color: red; } }'),
    '.card[data-scope-test]{ &:hover { color: red; } }',
  );
  assert.equal(
    scopeCss('.card { & .title { color: red; } }'),
    '.card[data-scope-test]{ & .title[data-scope-test] { color: red; } }',
  );
});

test('深层嵌套逐层作用域化', () => {
  const css = '.a { .b { .c { color: red; } } }';
  assert.equal(
    scopeCss(css),
    '.a[data-scope-test]{ .b[data-scope-test] { .c[data-scope-test] { color: red; } } }',
  );
});

test('多层 nesting 混合 & 复合、普通目标与 :deep()', () => {
  const css = '.a { .b { &.active {} .c {} :deep(.d) {} } }';
  assert.equal(
    scopeCss(css),
    '.a[data-scope-test]{ .b[data-scope-test] { &.active {} .c[data-scope-test] {} .d {} } }',
  );
});

test('nesting 内 :global() 只脱壳不给目标加 scope（父选择器仍参与组合）', () => {
  // 浏览器按原生 nesting 组合后等价于 .a[data-scope-test] .external，
  // 并非全局 .external —— 本改写器不改变 nesting 结构（见 README 语义边界）。
  assert.equal(
    scopeCss('.a { :global(.external) {} }'),
    '.a[data-scope-test]{ .external {} }',
  );
});

test('分组 at-rule 内的规则体同样处理嵌套', () => {
  assert.equal(
    scopeCss('@media (min-width: 48rem) { .card { .title { color: red; } } }'),
    '@media (min-width: 48rem) { .card[data-scope-test]{ .title[data-scope-test] { color: red; } } }',
  );
});

test('嵌套 keyframes 不改写 from / to', () => {
  assert.equal(
    scopeCss('.card { @keyframes fade { from { opacity: 0; } to { opacity: 1; } } }'),
    '.card[data-scope-test]{ @keyframes fade { from { opacity: 0; } to { opacity: 1; } } }',
  );
});

test('嵌套选择器里字符串与注释中的伪类文本不误伤', () => {
  assert.equal(
    scopeCss('.card { .title::after { content: ":deep(.x)"; } }'),
    '.card[data-scope-test]{ .title[data-scope-test]::after { content: ":deep(.x)"; } }',
  );
});

// ---- CSS 自定义属性值中的花括号 -------------------------------------------

test('自定义属性的值含花括号时整段原样保留（顶层）', () => {
  assert.equal(
    scopeCss(':root { --custom: { color: red; }; color: blue; }'),
    ':root[data-scope-test]{ --custom: { color: red; }; color: blue; }',
  );
});

test('自定义属性的值含花括号时整段原样保留（嵌套）', () => {
  assert.equal(
    scopeCss('.parent { --custom: { color: red; }; color: blue; }'),
    '.parent[data-scope-test]{ --custom: { color: red; }; color: blue; }',
  );
});

test('自定义属性的值含多个花括号块', () => {
  assert.equal(
    scopeCss('.parent { --x: { a: 1; } { b: 2; }; color: red; }'),
    '.parent[data-scope-test]{ --x: { a: 1; } { b: 2; }; color: red; }',
  );
});

test('自定义属性作为声明块最后一项且无结尾分号', () => {
  assert.equal(
    scopeCss('.parent { color: red; --x: { a: 1; } }'),
    '.parent[data-scope-test]{ color: red; --x: { a: 1; } }',
  );
});

test('自定义属性值内嵌套更深的花括号', () => {
  assert.equal(
    scopeCss('.parent { --x: { a: { b: 1; } }; color: red; }'),
    '.parent[data-scope-test]{ --x: { a: { b: 1; } }; color: red; }',
  );
});

// 花括号计数与分号终止分开判定：圆/方括号内的分号不能结束声明。
test('自定义属性值中函数圆括号内的分号不误判为声明结束', () => {
  assert.equal(
    scopeCss('.a { --tokens: { value: fn(a; b); color: red; }; }'),
    '.a[data-scope-test]{ --tokens: { value: fn(a; b); color: red; }; }',
  );
});

test('自定义属性值中方括号内的分号不误判为声明结束', () => {
  assert.equal(
    scopeCss('.a { --tokens: { value: [a; b]; color: red; }; }'),
    '.a[data-scope-test]{ --tokens: { value: [a; b]; color: red; }; }',
  );
});

test('自定义属性值为函数且其圆括号内带分号（无花括号包裹）', () => {
  assert.equal(
    scopeCss('.a { --x: fn(a; b); color: red; }'),
    '.a[data-scope-test]{ --x: fn(a; b); color: red; }',
  );
});

// ---- 多重特殊伪类全部脱壳 --------------------------------------------------

test('顶层多个 :deep() 全部脱壳', () => {
  assert.equal(
    scopeCss('.a :deep(.b) :deep(.c) { color: red; }'),
    '.a[data-scope-test] .b .c{ color: red; }',
  );
});

test('嵌套多个 :deep() 全部脱壳', () => {
  assert.equal(
    scopeCss('.card { :deep(.a) :deep(.b) { color: red; } }'),
    '.card[data-scope-test]{ .a .b { color: red; } }',
  );
});

test('三个 :deep() 连续出现全部脱壳', () => {
  assert.equal(
    scopeCss('.card { :deep(.a) :deep(.b) :deep(.c) { color: red; } }'),
    '.card[data-scope-test]{ .a .b .c { color: red; } }',
  );
});

test('嵌套 :deep() 后接 :slotted()，slotted 目标加 -s', () => {
  assert.equal(
    scopeCss('.card { :deep(.a) :slotted(.b) { color: red; } }'),
    '.card[data-scope-test]{ .a .b[data-scope-test-s] { color: red; } }',
  );
});

test('顶层 :deep() 后接 :global() 全部脱壳', () => {
  assert.equal(
    scopeCss('.a :deep(.b) :global(.c) { color: red; }'),
    '.a[data-scope-test] .b .c{ color: red; }',
  );
});

test(':deep() 多参数后再接 :deep() 做笛卡尔展开', () => {
  assert.equal(
    scopeCss('.card { :deep(.a, .b) :deep(.c) { color: red; } }'),
    '.card[data-scope-test]{ .a .c, .b .c { color: red; } }',
  );
});

test('三类特殊伪类串联全部脱壳，各自 scope 策略独立', () => {
  assert.equal(
    scopeCss('.a :deep(.b) :global(.c) :slotted(.d) {}'),
    '.a[data-scope-test] .b .c .d[data-scope-test-s]{}',
  );
});

test('左侧带复合时伪类参数内嵌套仍递归脱壳', () => {
  assert.equal(
    scopeCss('.a :deep(:global(.b)) {}'),
    '.a[data-scope-test] .b{}',
  );
});

// ---- 特殊伪类参数内部再嵌特殊伪类 ----------------------------------------

test('顶层 :deep(:global(.x)) 内层伪类递归脱壳', () => {
  assert.equal(
    scopeCss(':deep(:global(.item)) { color: red; }'),
    '[data-scope-test] .item{ color: red; }',
  );
});

test('顶层 :slotted(:deep(.x)) 内层脱壳且目标保留 -s', () => {
  assert.equal(
    scopeCss(':slotted(:deep(.item)) { color: red; }'),
    '.item[data-scope-test-s]{ color: red; }',
  );
});

test('nesting :deep(:global(.x)) 内层伪类递归脱壳', () => {
  assert.equal(
    scopeCss('.card { :deep(:global(.item)) { color: red; } }'),
    '.card[data-scope-test]{ .item { color: red; } }',
  );
});

test('伪类参数内多参数含嵌套伪类，各自脱壳并参与笛卡尔展开', () => {
  assert.equal(
    scopeCss(':deep(.a, :global(.b)) { color: red; }'),
    '[data-scope-test] .a, [data-scope-test] .b{ color: red; }',
  );
});

test('串联 deep 的参数内部嵌套伪类全部脱壳', () => {
  assert.equal(
    scopeCss(':deep(.a) :deep(:global(.b)) { color: red; }'),
    '[data-scope-test] .a .b{ color: red; }',
  );
});

// ---- 自定义属性名的转义与非 ASCII 标识符 ---------------------------------

test('自定义属性名为 CSS 转义标识符时整段原样保留', () => {
  assert.equal(
    scopeCss('.a { --x\\:esc: { color: red; }; color: blue; }'),
    '.a[data-scope-test]{ --x\\:esc: { color: red; }; color: blue; }',
  );
});

test('自定义属性名为非 ASCII 标识符时整段原样保留', () => {
  assert.equal(
    scopeCss('.a { --变量: { color: red; }; color: blue; }'),
    '.a[data-scope-test]{ --变量: { color: red; }; color: blue; }',
  );
});

// ---- P0 语义回归：global/slotted 左侧不加 scope 对齐 Vue 官方 ----------------

test(':slotted() 左侧不加普通 scope（对齐 Vue 官方语义）', () => {
  assert.equal(
    scopeCss('.wrapper :slotted(.item) { color: red; }'),
    '.wrapper .item[data-scope-test-s]{ color: red; }',
  );
});

test(':global() 左侧不追加 scope（原样，由 Vue 语义决定）', () => {
  assert.equal(
    scopeCss('.wrapper :global(.external) { color: red; }'),
    '.wrapper .external{ color: red; }',
  );
});
