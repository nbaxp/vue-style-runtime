import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeCss, setupDom } from './helpers.js';

import styleMixin from '../index.js';

setupDom();

const headNodes = () => Array.from(document.head.children);

const mount = (mixin, options) => {
  const vm = { $options: options, $: { type: options } };
  mixin.created.call(vm);
  mixin.mounted.call(vm);
  return vm;
};

test('属性选择器复合：属性插在末尾复合选择器，不破坏组合器与属性值', () => {
  assert.equal(
    scopeCss('.button[aria-expanded="false"] + .menu { color: red; }'),
    '.button[aria-expanded="false"] + .menu[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss('[data-label="a,b"] .x { color: red; }'),
    '[data-label="a,b"] .x[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss('.icon :deep([class^="vpi-"]) { color: red; }'),
    '.icon[data-scope-test] [class^="vpi-"]{ color: red; }',
  );
});

test('多选择器列表整体作用域化，不是只处理首项', () => {
  assert.equal(
    scopeCss('.a, .b { color: red; }'),
    '.a[data-scope-test], .b[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss('.a::before, .b:hover { color: red; }'),
    '.a[data-scope-test]::before, .b:hover[data-scope-test]{ color: red; }',
  );
});

test('updated 生命周期触发作用域标记，动态节点也能拿到属性', () => {
  const rootEl = document.createElement('div');
  const childEl = document.createElement('span');
  const options = { styles: '<style scoped>.a{color:red}</style>' };
  const internal = { type: options, subTree: null };
  const vm = { $options: options, $: internal, $el: rootEl };

  internal.proxy = vm;

  styleMixin.created.call(vm);

  internal.subTree = {
    type: 'div',
    ctx: internal,
    el: rootEl,
    children: [{ type: 'span', ctx: internal, el: childEl, children: [] }],
  };

  styleMixin.updated.call(vm);

  const attr = `data-scope-${document.head.querySelector('style').className}`;

  assert.equal(rootEl.hasAttribute(attr), true);
  assert.equal(childEl.hasAttribute(attr), true);
});

test('卸载归零后重新挂载能重建样式，且注入顺序按创建顺序', () => {
  const styleA = '<style>.a{color:red}</style>';
  const styleB = '<style>.b{color:blue}</style>';

  const a = mount(styleMixin, { styles: styleA });
  const b = mount(styleMixin, { styles: styleB });

  assert.deepEqual(headNodes().map((node) => node.textContent), ['.a{color:red}', '.b{color:blue}']);

  styleMixin.unmounted.call(a);
  assert.deepEqual(headNodes().map((node) => node.textContent), ['.b{color:blue}']);

  mount(styleMixin, { styles: styleA });
  assert.deepEqual(headNodes().map((node) => node.textContent), ['.b{color:blue}', '.a{color:red}']);
  assert.equal(headNodes()[1].getAttribute('data-vue-component-instances'), '1');

  styleMixin.unmounted.call(b);
});

test('嵌套块内的 & 原样留给 CSS nesting，外层照常作用域化', () => {
  assert.equal(
    scopeCss('.card { &:hover { color: red; } }'),
    '.card[data-scope-test]{ &:hover { color: red; } }',
  );
  assert.equal(
    scopeCss('@media (min-width: 48rem) { .card { &:lang(ja) { font-feature-settings: "palt"; } } }'),
    '@media (min-width: 48rem) { .card[data-scope-test]{ &:lang(ja) { font-feature-settings: "palt"; } } }',
  );
});

test('引号外的反斜杠转义不参与切分', () => {
  assert.equal(
    scopeCss('.a\\,b, .c { color: red; }'),
    '.a\\,b[data-scope-test], .c[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss('.a\\{b { color: red; }'),
    '.a\\{b[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss('.\\31 23 { color: red; }'),
    '.\\31 23[data-scope-test]{ color: red; }',
  );
});

test('空规则块、纯注释与值内花括号/分号不吞掉后续规则', () => {
  assert.equal(
    scopeCss('/* note */ .a { color: red; }'),
    '/* note */ .a[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss('.empty { } .a { color: red; }'),
    '.empty[data-scope-test]{ } .a[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss('.a { content: "{}"; } .b { color: red; }'),
    '.a[data-scope-test]{ content: "{}"; } .b[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss('.a { background: url("a;b.svg"); } .b { color: red; }'),
    '.a[data-scope-test]{ background: url("a;b.svg"); } .b[data-scope-test]{ color: red; }',
  );
});

test(':deep(.b, .c) 多参数展开为多个作用域化选择器', () => {
  assert.equal(
    scopeCss('.a :deep(.b, .c) { }'),
    '.a[data-scope-test] .b, .a[data-scope-test] .c{ }',
  );
});
