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

test('转义换行与截断的十六进制转义不抛错', () => {
  assert.equal(
    scopeCss('.a' + '\\' + '\f' + '.b { color: red; }'),
    '.a' + '\\' + '\f' + '.b[data-scope-test]{ color: red; }',
  );
  assert.equal(scopeCss('.a' + '\\' + '0'), '.a' + '\\' + '0');
});

test('未闭合的引号、注释、括号与函数让整条规则原样保留', () => {
  assert.equal(scopeCss('.a[title="x { color: red; }'), '.a[title="x { color: red; }');
  assert.equal(scopeCss('.a /* x { color: red; }'), '.a /* x { color: red; }');
  assert.equal(scopeCss('.a:not(.b { color: red; }'), '.a:not(.b { color: red; }');
  assert.equal(scopeCss('.a[data-x { color: red; }'), '.a[data-x { color: red; }');
  assert.equal(scopeCss('.a :deep(.b { color: red; }'), '.a :deep(.b { color: red; }');
  assert.equal(scopeCss('/* only */'), '/* only */');
});

test('不完整 /deep/ 不加 deep 语义，超深嵌套不递归', () => {
  assert.equal(
    scopeCss('.a /deep/ { color: red; }'),
    '.a /deep/[data-scope-test]{ color: red; }',
  );

  const nested = ':' + 'deep('.repeat(34) + '.a' + ')'.repeat(34);

  assert.match(scopeCss(`${nested} { color: red; }`), /^\[data-scope-test\]/);
});

test(':global 多参数展开，空参数只留规则体', () => {
  assert.equal(scopeCss(':global(.a, .b) { color: red; }'), '.a, .b{ color: red; }');
  assert.equal(scopeCss(':global() { color: red; }'), '{ color: red; }');
  assert.equal(scopeCss(':deep() { color: red; }'), '{ color: red; }');
  assert.equal(scopeCss(':slotted() { color: red; }'), '{ color: red; }');
});

test('缺少组件身份时不注入样式', () => {
  const before = headNodes().length;
  const vm = { $options: { styles: '<style scoped>.a{color:red}</style>' } };

  styleMixin.created.call(vm);
  styleMixin.mounted.call(vm);

  assert.equal(headNodes().length, before);
});

test('未登记实例在 mounted/updated 时不打属性', () => {
  const rootEl = document.createElement('div');
  const vm = { $options: {}, $: { type: {}, subTree: null }, $el: rootEl };

  styleMixin.mounted.call(vm);
  styleMixin.updated.call(vm);

  assert.deepEqual(
    Array.from(rootEl.attributes, (attr) => attr.name),
    [],
  );
});

test('渲染树中的 null、基本类型、嵌套数组与 dynamicChildren 被安全遍历', () => {
  const rootEl = document.createElement('div');
  const childEl = document.createElement('span');
  const dynamicEl = document.createElement('em');
  const options = { styles: '<style scoped>.a{color:red}</style>' };
  const internal = { type: options };
  const vm = { $options: options, $: internal, $el: rootEl };

  internal.proxy = vm;
  styleMixin.created.call(vm);

  internal.subTree = {
    type: 'div',
    ctx: internal,
    el: rootEl,
    children: [
      null,
      42,
      [{ type: 'span', ctx: internal, el: childEl, children: [] }],
    ],
    dynamicChildren: [null, { type: 'em', ctx: internal, el: dynamicEl, children: [] }],
  };

  styleMixin.mounted.call(vm);

  const attr = `data-scope-${document.head.querySelector('style').className}`;

  assert.equal(rootEl.hasAttribute(attr), true);
  assert.equal(childEl.hasAttribute(attr), true);
  assert.equal(dynamicEl.hasAttribute(attr), true);
});

test('多根 Fragment 不继承父组件 scope', () => {
  const parentEl = document.createElement('div');
  const childEl1 = document.createElement('i');
  const childEl2 = document.createElement('b');

  const parentOptions = { name: 'P', styles: '<style scoped>.p{}</style>' };
  const parentInternal = { type: parentOptions, subTree: null };
  const parentVm = { $options: parentOptions, $: parentInternal, $el: parentEl };

  parentInternal.proxy = parentVm;

  const childOptions = { name: 'C', styles: '<style scoped>.c{}</style>' };
  const childInternal = { type: childOptions, parent: parentInternal, subTree: null };
  const childVm = { $options: childOptions, $: childInternal, $el: childEl1 };

  childInternal.proxy = childVm;

  styleMixin.created.call(parentVm);
  styleMixin.created.call(childVm);

  const parentStyle = Array.from(document.head.children).find((node) =>
    node.textContent.includes('.p'),
  );
  const parentAttr = `data-scope-${parentStyle.className}`;

  parentInternal.subTree = {
    type: 'div',
    ctx: parentInternal,
    el: parentEl,
    children: [{ type: { name: 'Child' }, component: childInternal, el: childEl1 }],
  };
  childInternal.subTree = {
    type: Symbol.for('v-fgt'),
    children: [
      { type: 'i', ctx: childInternal, el: childEl1, children: [] },
      { type: 'b', ctx: childInternal, el: childEl2, children: [] },
    ],
  };

  styleMixin.mounted.call(parentVm);

  assert.equal(parentEl.hasAttribute(parentAttr), true);
  assert.equal(childEl1.hasAttribute(parentAttr), false);
  assert.equal(childEl2.hasAttribute(parentAttr), false);
});

test('注释与引号内的逗号、括号不参与切分与识别', () => {
  assert.equal(
    scopeCss('.a/* c */, .b { }'),
    '.a/* c */[data-scope-test], .b[data-scope-test]{ }',
  );
  assert.equal(
    scopeCss('.a[data-x/* c */="v"] .b { }'),
    '.a[data-x/* c */="v"] .b[data-scope-test]{ }',
  );
  assert.equal(
    scopeCss('.a[title="a\\\\"] .b { }'),
    '.a[title="a\\\\"] .b[data-scope-test]{ }',
  );
  assert.equal(scopeCss(':deep(/* c */.b) { }'), '[data-scope-test] /* c */.b{ }');
  assert.equal(
    scopeCss('.a/* c */:hover::before { }'),
    '.a/* c */:hover[data-scope-test]::before{ }',
  );
  assert.equal(
    scopeCss('.a:is(.b/* c */) { }'),
    '.a:is(.b/* c */)[data-scope-test]{ }',
  );
});

test('根组件链上的祖父 scope 逐层继承到子组件根节点', () => {
  const greatEl = document.createElement('div');
  const grandEl = document.createElement('section');
  const parentEl = document.createElement('article');
  const childEl = document.createElement('span');

  const greatOptions = { name: 'Great', styles: '<style scoped>.great{}</style>' };
  const greatInternal = { type: greatOptions, subTree: null };
  const greatVm = { $options: greatOptions, $: greatInternal, $el: greatEl };

  greatInternal.proxy = greatVm;

  const grandOptions = { name: 'Grand', styles: '<style scoped>.grand{}</style>' };
  const grandInternal = { type: grandOptions, parent: greatInternal, subTree: null };
  const grandVm = { $options: grandOptions, $: grandInternal, $el: grandEl };

  grandInternal.proxy = grandVm;

  const parentOptions = { name: 'Parent', styles: '<style scoped>.parent{}</style>' };
  const parentInternal = { type: parentOptions, parent: grandInternal, subTree: null };
  const parentVm = { $options: parentOptions, $: parentInternal, $el: parentEl };

  parentInternal.proxy = parentVm;

  const childOptions = { name: 'Child' };
  const childInternal = { type: childOptions, parent: parentInternal, subTree: null };

  styleMixin.created.call(greatVm);
  styleMixin.created.call(grandVm);
  styleMixin.created.call(parentVm);

  const attrOf = (marker) => {
    const node = Array.from(document.head.children).find((child) =>
      child.textContent.includes(marker),
    );

    return `data-scope-${node.className}`;
  };

  const greatAttr = attrOf('.great');
  const grandAttr = attrOf('.grand');
  const parentAttr = attrOf('.parent');

  const grandVNode = { type: { name: 'GrandComp' }, component: grandInternal, el: grandEl };
  const parentVNode = { type: { name: 'ParentComp' }, component: parentInternal, el: parentEl };
  const childVNode = { type: { name: 'ChildComp' }, component: childInternal, el: childEl };

  greatInternal.subTree = grandVNode;
  grandInternal.vnode = grandVNode;
  grandInternal.subTree = parentVNode;
  parentInternal.vnode = parentVNode;
  parentInternal.subTree = {
    type: 'article',
    ctx: parentInternal,
    el: parentEl,
    children: [childVNode],
  };
  childInternal.subTree = { type: 'span', ctx: childInternal, el: childEl, children: [] };

  styleMixin.mounted.call(parentVm);

  assert.equal(childEl.hasAttribute(parentAttr), true);
  assert.equal(childEl.hasAttribute(grandAttr), true);
  assert.equal(childEl.hasAttribute(greatAttr), true);
});

test('Suspense 的 ssContent / ssFallback 分支参与遍历', () => {
  const rootEl = document.createElement('div');
  const contentEl = document.createElement('p');
  const fallbackEl = document.createElement('em');
  const options = { styles: '<style scoped>.a{color:red}</style>' };
  const internal = { type: options };
  const vm = { $options: options, $: internal, $el: rootEl };

  internal.proxy = vm;
  styleMixin.created.call(vm);

  internal.subTree = {
    type: Symbol.for('v-suspense'),
    ctx: internal,
    el: rootEl,
    ssContent: { type: 'p', ctx: internal, el: contentEl, children: [] },
    ssFallback: { type: 'em', ctx: internal, el: fallbackEl, children: [] },
  };

  styleMixin.mounted.call(vm);

  const style = Array.from(document.head.children)
    .filter((node) => node.tagName === 'STYLE')
    .pop();
  const attr = `data-scope-${style.className}`;

  assert.equal(contentEl.hasAttribute(attr), true);
  assert.equal(fallbackEl.hasAttribute(attr), true);

  styleMixin.unmounted.call(vm);
});

test('重复 created 与非字符串 styles 不注入', () => {
  const options = { styles: '<style scoped>.a{color:red}</style>' };
  const vm = { $options: options, $: { type: options } };

  styleMixin.created.call(vm);

  const afterFirst = document.head.children.length;

  styleMixin.created.call(vm);
  assert.equal(document.head.children.length, afterFirst);

  styleMixin.unmounted.call(vm);

  const badOptions = { styles: {} };
  const badVm = { $options: badOptions, $: { type: badOptions } };

  styleMixin.created.call(badVm);

  assert.equal(document.head.children.length, afterFirst - 1);
});

test('祖先传入的插槽元素只打 -s，本组件元素打普通 scope', () => {
  const rootEl = document.createElement('div');
  const slotEl = document.createElement('span');
  const ownEl = document.createElement('em');

  const options = { styles: '<style scoped>.a{color:red}</style>' };
  const internal = { type: options };
  const vm = { $options: options, $: internal, $el: rootEl };
  const parentInternal = { type: { name: 'Parent' }, subTree: null };

  internal.proxy = vm;
  internal.parent = parentInternal;

  styleMixin.created.call(vm);

  internal.subTree = {
    type: 'div',
    ctx: internal,
    el: rootEl,
    children: [
      { type: 'span', ctx: parentInternal, el: slotEl, children: [] },
      { type: 'em', ctx: internal, el: ownEl, children: [] },
    ],
  };

  styleMixin.mounted.call(vm);

  const style = Array.from(document.head.children)
    .filter((node) => node.tagName === 'STYLE')
    .pop();
  const attr = `data-scope-${style.className}`;

  assert.equal(ownEl.hasAttribute(attr), true);
  assert.equal(slotEl.hasAttribute(attr), false);
  assert.equal(slotEl.hasAttribute(`${attr}-s`), true);

  styleMixin.unmounted.call(vm);
});
