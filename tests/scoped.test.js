import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dom, scopeCss, setupDom } from './helpers.js';

import styleMixin from '../index.js';

setupDom();

const makeEl = (name) => ({
  name,
  nodeType: 1,
  attrs: {},
  setAttribute(key, value) {
    this.attrs[key] = value;
  },
});

test(':deep 基本形式与组合器前的属性注入', () => {
  assert.equal(scopeCss('.a :deep(.b) { }'), '.a[data-scope-test] .b{ }');
  assert.equal(scopeCss('.a > :deep(.b) { }'), '.a[data-scope-test] > .b{ }');
  assert.equal(scopeCss('.a + :deep(.b) { }'), '.a[data-scope-test] + .b{ }');
  assert.equal(scopeCss('.a ~ :deep(.b) { }'), '.a[data-scope-test] ~ .b{ }');
});

test(':deep(> X) 与括号内组合器保持官方形态', () => {
  assert.equal(scopeCss(':deep(.b) { }'), '[data-scope-test] .b{ }');
  assert.equal(scopeCss(':deep(> .b) { }'), '[data-scope-test] > .b{ }');
  assert.equal(scopeCss(':deep(.a + .b) { }'), '[data-scope-test] .a + .b{ }');
});

test(':slotted 只给插槽目标打 -s 属性，外层不打普通作用域', () => {
  assert.equal(scopeCss(':slotted(.x) { }'), '.x[data-scope-test-s]{ }');
  assert.equal(scopeCss('.a :slotted(.x) { }'), '.a .x[data-scope-test-s]{ }');
  assert.equal(scopeCss('.a > :slotted(.x) { }'), '.a > .x[data-scope-test-s]{ }');
  assert.equal(scopeCss(':slotted(.a + .b) { }'), '.a + .b[data-scope-test-s]{ }');
});

test('@media 内的 :slotted 与 :deep 正常作用域化', () => {
  const css =
    '@media (min-width: 48rem) { .VPHome :slotted(.VPTeamPageTitle) { margin: 0; } .a > :deep(.b) { color: red; } }';

  assert.equal(
    scopeCss(css),
    '@media (min-width: 48rem) { .VPHome .VPTeamPageTitle[data-scope-test-s]{ margin: 0; } .a[data-scope-test] > .b{ color: red; } }',
  );
});

test('原生 & 保持原样交给浏览器 nesting', () => {
  assert.equal(scopeCss('&:hover { }'), '&:hover[data-scope-test]{ }');
  assert.equal(scopeCss('& .b { }'), '& .b[data-scope-test]{ }');
  assert.equal(scopeCss('&:lang(ja) { }'), '&:lang(ja)[data-scope-test]{ }');
});

test('@keyframes 原样保留，内部选择器不打属性', () => {
  const css = '@keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a { color: red; }';

  assert.equal(
    scopeCss(css),
    '@keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a[data-scope-test]{ color: red; }',
  );
});

test('伪元素插点与 :not()/:where() 括号内逗号', () => {
  assert.equal(
    scopeCss('.a::before { content: "x"; }'),
    '.a[data-scope-test]::before{ content: "x"; }',
  );
  assert.equal(
    scopeCss(':not(.p, .q) { color: red; }'),
    ':not(.p, .q)[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss(':where(.p, .q) .a { color: red; }'),
    ':where(.p, .q) .a[data-scope-test]{ color: red; }',
  );
});

test('普通 <style> 原样注入，不带 scoped 标记', () => {
  const options = { styles: '<style>.a { color: red; }</style>' };
  const vm = { $options: options, $: { type: options } };

  styleMixin.created.call(vm);

  const [node] = document.head.children;

  assert.equal(node.tagName, 'STYLE');
  assert.equal(node.textContent, '.a { color: red; }');
  assert.equal(node.hasAttribute('scoped'), false);
  assert.equal(node.hasAttribute('data-vue-style-scoped'), false);

  styleMixin.unmounted.call(vm);
});

test('scoped <style> 改写内容并保留 nonce / media 等原有属性', () => {
  const options = {
    styles: '<style scoped nonce="r4nd0m" media="print">.a{color:red}</style>',
  };
  const vm = { $options: options, $: { type: options } };

  styleMixin.created.call(vm);

  const node = document.head.querySelector('style');
  const name = node.className;

  assert.equal(name.startsWith('uid_'), true);
  assert.equal(node.hasAttribute('scoped'), false);
  assert.equal(node.getAttribute('type'), 'text/css');
  assert.equal(node.getAttribute('nonce'), 'r4nd0m');
  assert.equal(node.getAttribute('media'), 'print');
  assert.equal(node.getAttribute('data-vue-style-scoped'), `data-scope-${name}`);
  assert.equal(node.textContent, `.a[data-scope-${name}]{color:red}`);

  styleMixin.unmounted.call(vm);
});

test('Vue 3：父模板节点、插槽内容、子组件根与子内部归属正确', () => {
  const { document } = dom.window;
  const parentEl = makeEl('div');
  const childRootEl = makeEl('section');
  const slotEl = makeEl('span');
  const internalEl = makeEl('p');

  const parentOptions = { styles: '<style scoped>.p{}</style>' };
  const childOptions = { styles: '<style scoped>.c{}</style>' };
  const parentInstance = { type: parentOptions, subTree: null, parent: null };
  const childInstance = { type: childOptions, subTree: null, parent: parentInstance };
  const parentVm = { $options: parentOptions, $: parentInstance, $el: parentEl };
  const childVm = { $options: childOptions, $: childInstance, $el: childRootEl };

  parentInstance.proxy = parentVm;
  childInstance.proxy = childVm;

  styleMixin.created.call(parentVm);
  styleMixin.created.call(childVm);

  const [parentStyle, childStyle] = document.head.children;
  const parentAttr = `data-scope-${parentStyle.className}`;
  const childAttr = `data-scope-${childStyle.className}`;

  const slotVNode = { type: 'span', ctx: parentInstance, el: slotEl, children: [] };
  const internalVNode = { type: 'p', ctx: childInstance, el: internalEl, children: [] };
  const childRoot = { type: 'section', ctx: childInstance, el: childRootEl, children: [slotVNode, internalVNode] };
  const childCompVNode = { type: { name: 'Child' }, ctx: parentInstance, component: childInstance, el: null, children: null };

  childInstance.subTree = childRoot;

  parentInstance.subTree = { type: 'div', ctx: parentInstance, el: parentEl, children: [childCompVNode] };

  styleMixin.mounted.call(parentVm);
  assert.equal(parentEl.attrs[parentAttr], '');
  assert.equal(childRootEl.attrs[parentAttr], '');
  assert.equal(slotEl.attrs[parentAttr], '');
  assert.equal(internalEl.attrs[parentAttr], undefined);
  assert.equal(internalEl.attrs[`${parentAttr}-s`], undefined);

  styleMixin.mounted.call(childVm);
  assert.equal(childRootEl.attrs[childAttr], '');
  assert.equal(internalEl.attrs[childAttr], '');
  assert.equal(slotEl.attrs[`${childAttr}-s`], '');
  assert.equal(slotEl.attrs[childAttr], undefined);

  styleMixin.unmounted.call(parentVm);
  styleMixin.unmounted.call(childVm);
});

test('祖父链上的插槽内容：祖先打普通属性，当前组件打 -s', () => {
  const { document } = dom.window;
  const grandEl = makeEl('div');
  const childRootEl = makeEl('section');
  const slotEl = makeEl('span');

  const grandOptions = { styles: '<style scoped>.g{}</style>' };
  const parentOptions = { styles: '<style scoped>.p{}</style>' };
  const childOptions = { styles: '<style scoped>.c{}</style>' };
  const grandInstance = { type: grandOptions, subTree: null, parent: null };
  const parentInstance = { type: parentOptions, subTree: null, parent: grandInstance };
  const childInstance = { type: childOptions, subTree: null, parent: parentInstance };
  const grandVm = { $options: grandOptions, $: grandInstance, $el: grandEl };
  const parentVm = { $options: parentOptions, $: parentInstance, $el: makeEl('parent') };
  const childVm = { $options: childOptions, $: childInstance, $el: childRootEl };

  grandInstance.proxy = grandVm;
  parentInstance.proxy = parentVm;
  childInstance.proxy = childVm;

  styleMixin.created.call(grandVm);
  styleMixin.created.call(parentVm);
  styleMixin.created.call(childVm);

  const [grandStyle, , childStyle] = document.head.children;
  const grandAttr = `data-scope-${grandStyle.className}`;
  const childAttr = `data-scope-${childStyle.className}`;

  const slotVNode = { type: 'span', ctx: grandInstance, el: slotEl, children: [] };
  const childRoot = { type: 'section', ctx: childInstance, el: childRootEl, children: [slotVNode] };
  const childCompVNode = { type: { name: 'Child' }, ctx: parentInstance, component: childInstance, el: null, children: null };
  const parentCompVNode = { type: { name: 'Parent' }, ctx: grandInstance, component: parentInstance, el: null, children: null };

  childInstance.subTree = childRoot;
  parentInstance.subTree = childCompVNode;
  grandInstance.subTree = { type: 'div', ctx: grandInstance, el: grandEl, children: [parentCompVNode] };

  styleMixin.mounted.call(grandVm);
  assert.equal(grandEl.attrs[grandAttr], '');
  // 组件根链继承：Parent 的渲染根是 Child 组件，其根节点继续接收祖父 scope。
  assert.equal(childRootEl.attrs[grandAttr], '');
  assert.equal(slotEl.attrs[grandAttr], '');
  assert.equal(slotEl.attrs[`${grandAttr}-s`], undefined);

  styleMixin.mounted.call(childVm);
  assert.equal(slotEl.attrs[`${childAttr}-s`], '');

  styleMixin.unmounted.call(grandVm);
  styleMixin.unmounted.call(parentVm);
  styleMixin.unmounted.call(childVm);
});

test('WeakSet 防止重复标记与循环递归', () => {
  const el = makeEl('div');
  const options = { styles: '<style scoped>.a{}</style>' };
  const internal = { type: options, subTree: null };
  const vm = { $options: options, $: internal, $el: makeEl('root') };

  internal.proxy = vm;

  styleMixin.created.call(vm);

  const vnode = { type: 'div', ctx: internal, el, children: [] };
  vnode.children.push(vnode);
  internal.subTree = vnode;

  styleMixin.mounted.call(vm);

  const attr = `data-scope-${document.head.querySelector('style').className}`;
  assert.equal(el.attrs[attr], '');

  styleMixin.unmounted.call(vm);
});

test('Fragment 锚点不当作元素标记，内容节点照常标记', () => {
  const commentNode = { nodeType: 8 };
  const childEl = makeEl('div');
  const options = { styles: '<style scoped>.a{}</style>' };
  const internal = { type: options, subTree: null };
  const vm = { $options: options, $: internal, $el: commentNode };

  internal.proxy = vm;

  styleMixin.created.call(vm);

  internal.subTree = {
    type: Symbol('Fragment'),
    ctx: internal,
    el: commentNode,
    children: [{ type: 'div', ctx: internal, el: childEl, children: [] }],
  };

  styleMixin.mounted.call(vm);

  const attr = `data-scope-${document.head.querySelector('style').className}`;
  assert.equal(childEl.attrs[attr], '');
  assert.equal(commentNode.attrs, undefined);

  styleMixin.unmounted.call(vm);
});

test('端到端：scoped 组件注入改写后的样式，mounted 给根节点打属性', () => {
  const { document } = dom.window;
  const rootEl = document.createElement('div');
  const options = { styles: '<style scoped>.a{color:red}</style><p>ignored</p>' };
  const internal = { type: options, subTree: null };
  const vm = { $options: options, $: internal, $el: rootEl };

  internal.proxy = vm;

  styleMixin.created.call(vm);
  internal.subTree = { type: 'div', ctx: internal, el: rootEl, children: [] };

  const node = document.head.querySelector('style');
  const name = node.className;

  assert.match(name, /^uid_\d+$/);
  assert.equal(node.getAttribute('data-vue-style-scoped'), `data-scope-${name}`);
  assert.equal(node.textContent, `.a[data-scope-${name}]{color:red}`);
  assert.equal(document.head.children.length, 1);

  styleMixin.mounted.call(vm);
  assert.equal(rootEl.hasAttribute(`data-scope-${name}`), true);

  styleMixin.unmounted.call(vm);
  assert.equal(document.head.children.length, 0);
});

test('端到端：非 scoped 组件即使遍历 vnode 也不打属性', () => {
  const { document } = dom.window;
  const rootEl = document.createElement('div');
  const options = { styles: '<style>.a{color:red}</style>' };
  const internal = { type: options, subTree: null };
  const vm = { $options: options, $: internal, $el: rootEl };

  internal.proxy = vm;

  styleMixin.created.call(vm);
  internal.subTree = { type: 'div', ctx: internal, el: rootEl, children: [] };

  styleMixin.mounted.call(vm);

  assert.equal(rootEl.attributes.length, 0);
  assert.equal(document.head.querySelector('style').hasAttribute('data-vue-style-scoped'), false);

  styleMixin.unmounted.call(vm);
});
