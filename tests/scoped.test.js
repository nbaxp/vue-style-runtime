import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import {
  addScopeAttr,
  applyScopeAttr,
  markScopedVNodes,
  processStyleBlock,
  scopeCss,
  scopeSelector,
  splitSelectors,
  styleMixin,
  transformRules,
} from '../index.js';

const ATTR = '[data-scope-test]';
const SLOT = '[data-scope-test-s]';

const makeEl = (name) => ({
  name,
  nodeType: 1,
  attrs: {},
  setAttribute(key, value) {
    this.attrs[key] = value;
  },
});

const markFn = (el, attr) => {
  if (el && el.nodeType === 1) el.setAttribute(attr, '');
};

let dom;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.DOMParser;
  dom?.window.close();
  dom = undefined;
});

const parseStyle = (html) => new dom.window.DOMParser().parseFromString(html, 'text/html').querySelector('style');

test('splitSelectors 只在顶层逗号切分', () => {
  assert.deepEqual(splitSelectors(':not(.a, .b), .c'), [':not(.a, .b)', '.c']);
  assert.deepEqual(splitSelectors(':where(.a, .b) .c'), [':where(.a, .b) .c']);
});

test('addScopeAttr 插在伪元素之前', () => {
  assert.equal(addScopeAttr('.a', ATTR), '.a[data-scope-test]');
  assert.equal(addScopeAttr('.a::before', ATTR), '.a[data-scope-test]::before');
  assert.equal(addScopeAttr('::after', ATTR), '[data-scope-test]::after');
});

test(':deep 基本形式与组合器前的属性注入', () => {
  assert.equal(scopeSelector('.a :deep(.b)', ATTR), '.a[data-scope-test] .b');
  assert.equal(scopeSelector('.a > :deep(.b)', ATTR), '.a[data-scope-test] > .b');
  assert.equal(scopeSelector('.a + :deep(.b)', ATTR), '.a[data-scope-test] + .b');
  assert.equal(scopeSelector('.a ~ :deep(.b)', ATTR), '.a[data-scope-test] ~ .b');
});

test(':deep(> X) 与括号内组合器保持官方形态', () => {
  assert.equal(scopeSelector(':deep(.b)', ATTR), '[data-scope-test] .b');
  assert.equal(scopeSelector(':deep(> .b)', ATTR), '[data-scope-test] > .b');
  assert.equal(scopeSelector(':deep(.a + .b)', ATTR), '[data-scope-test] .a + .b');
});

test(':slotted 只给插槽目标打 -s 属性，外层不打普通作用域', () => {
  assert.equal(scopeSelector(':slotted(.x)', ATTR, SLOT), '.x[data-scope-test-s]');
  assert.equal(scopeSelector('.a :slotted(.x)', ATTR, SLOT), '.a .x[data-scope-test-s]');
  assert.equal(scopeSelector('.a > :slotted(.x)', ATTR, SLOT), '.a > .x[data-scope-test-s]');
  assert.equal(scopeSelector(':slotted(.a + .b)', ATTR, SLOT), '.a + .b[data-scope-test-s]');
});

test('@media 内的 :slotted 与 :deep 正常作用域化', () => {
  const css =
    '@media (min-width: 48rem) { .VPHome :slotted(.VPTeamPageTitle) { margin: 0; } .a > :deep(.b) { color: red; } }';
  const out = transformRules(css, ATTR, SLOT);

  assert.equal(
    out,
    '@media (min-width: 48rem) { .VPHome .VPTeamPageTitle[data-scope-test-s]{ margin: 0; } .a[data-scope-test] > .b{ color: red; } }',
  );
});

test('原生 & 保持原样交给浏览器 nesting', () => {
  // 与官方 compileStyle 一致：保留 `&`，不展开父选择器；属性注入当前复合选择器。
  assert.equal(scopeSelector('&:hover', ATTR), '&:hover[data-scope-test]');
  assert.equal(scopeSelector('& .b', ATTR), '& .b[data-scope-test]');
  assert.equal(scopeSelector('&:lang(ja)', ATTR), '&:lang(ja)[data-scope-test]');
});

test('@keyframes 原样保留，内部选择器不打属性', () => {
  const css = '@keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a { color: red; }';
  const out = scopeCss(css, 'data-scope-test');

  assert.equal(out, '@keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a[data-scope-test]{ color: red; }');
});

test('伪元素插点与 :not()/:where() 括号内逗号', () => {
  assert.equal(
    scopeCss('.a::before { content: "x"; }', 'data-scope-test'),
    '.a[data-scope-test]::before{ content: "x"; }',
  );
  assert.equal(
    scopeCss(':not(.p, .q) { color: red; }', 'data-scope-test'),
    ':not(.p, .q)[data-scope-test]{ color: red; }',
  );
  assert.equal(
    scopeCss(':where(.p, .q) .a { color: red; }', 'data-scope-test'),
    ':where(.p, .q) .a[data-scope-test]{ color: red; }',
  );
});

test('非 scoped 样式块原样返回同一个节点', () => {
  const node = parseStyle('<style>.a { color: red; }</style>');

  assert.equal(processStyleBlock(node, 'uid_test'), node);
});

test('scoped 样式块替换内容并标记属性', () => {
  const node = processStyleBlock(parseStyle('<style scoped>.a{color:red}</style>'), 'uid_test');

  assert.equal(node.tagName, 'STYLE');
  assert.equal(node.hasAttribute('scoped'), false);
  assert.equal(node.getAttribute('type'), 'text/css');
  assert.equal(node.getAttribute('data-vue-style-scoped'), 'data-scope-uid_test');
  assert.equal(node.textContent, '.a[data-scope-uid_test]{color:red}');
});

test('scoped 样式块保留 nonce / media 等原有属性', () => {
  const node = processStyleBlock(
    parseStyle('<style scoped nonce="r4nd0m" media="print">.a{color:red}</style>'),
    'uid_test',
  );

  assert.equal(node.getAttribute('nonce'), 'r4nd0m');
  assert.equal(node.getAttribute('media'), 'print');
  assert.equal(node.getAttribute('type'), 'text/css');
  assert.equal(node.hasAttribute('scoped'), false);
});

test('上一版 ctx === this 失效证据：公开代理与内部实例永不相等', () => {
  const internal = { parent: null }; // vnode.ctx（Vue 3 内部实例）
  const proxy = {}; // 旧实现中的 this（公开组件代理）
  const el = makeEl('div');
  const tree = { type: 'div', ctx: internal, el, children: [] };

  // 旧逻辑用 `vnode.ctx === this`，一个节点都不会命中。
  markScopedVNodes(tree, proxy, 'data-scope-p', 'data-scope-p-s', markFn);
  assert.equal(el.attrs['data-scope-p'], undefined);

  markScopedVNodes(tree, internal, 'data-scope-p', 'data-scope-p-s', markFn);
  assert.equal(el.attrs['data-scope-p'], '');
});

test('Vue 3：父模板节点、插槽内容、子组件根与子内部归属正确', () => {
  const parentInstance = { parent: null };
  const childInstance = { parent: parentInstance };

  const parentEl = makeEl('div');
  const childRootEl = makeEl('section');
  const slotEl = makeEl('span');
  const internalEl = makeEl('p');

  const slotVNode = { type: 'span', ctx: parentInstance, el: slotEl, children: [] };
  const internalVNode = { type: 'p', ctx: childInstance, el: internalEl, children: [] };
  const childRoot = { type: 'section', ctx: childInstance, el: childRootEl, children: [slotVNode, internalVNode] };
  const childCompVNode = { type: 'Child', ctx: parentInstance, component: childInstance, el: null, children: null };

  childInstance.subTree = childRoot;

  const parentRoot = { type: 'div', ctx: parentInstance, el: parentEl, children: [childCompVNode] };

  parentInstance.subTree = parentRoot;

  markScopedVNodes(parentRoot, parentInstance, 'data-scope-parent', 'data-scope-parent-s', markFn);
  assert.equal(parentEl.attrs['data-scope-parent'], '');
  assert.equal(childRootEl.attrs['data-scope-parent'], '');
  assert.equal(slotEl.attrs['data-scope-parent'], '');
  assert.equal(internalEl.attrs['data-scope-parent'], undefined);
  assert.equal(internalEl.attrs['data-scope-parent-s'], undefined);

  markScopedVNodes(childRoot, childInstance, 'data-scope-child', 'data-scope-child-s', markFn);
  assert.equal(childRootEl.attrs['data-scope-child'], '');
  assert.equal(internalEl.attrs['data-scope-child'], '');
  assert.equal(slotEl.attrs['data-scope-child-s'], '');
  assert.equal(slotEl.attrs['data-scope-child'], undefined);
});

test('Vue 2.7 字段（context/$parent/componentInstance/_vnode/elm）同样生效', () => {
  const parentVm = { $parent: null };
  const childVm = { $parent: parentVm };

  const parentEl = makeEl('div');
  const childRootEl = makeEl('section');
  const slotEl = makeEl('span');
  const internalEl = makeEl('p');

  const slotVNode = { tag: 'span', context: parentVm, elm: slotEl, children: [] };
  const internalVNode = { tag: 'p', context: childVm, elm: internalEl, children: [] };
  const childRoot = { tag: 'section', context: childVm, elm: childRootEl, children: [slotVNode, internalVNode] };
  const childCompVNode = {
    tag: 'vue-component-1-Child',
    context: parentVm,
    componentInstance: childVm,
    elm: null,
    children: [],
  };

  childVm._vnode = childRoot;

  const parentRoot = { tag: 'div', context: parentVm, elm: parentEl, children: [childCompVNode] };

  parentVm._vnode = parentRoot;

  markScopedVNodes(parentRoot, parentVm, 'data-scope-parent', 'data-scope-parent-s', markFn);
  assert.equal(parentEl.attrs['data-scope-parent'], '');
  assert.equal(childRootEl.attrs['data-scope-parent'], '');
  assert.equal(slotEl.attrs['data-scope-parent'], '');
  assert.equal(internalEl.attrs['data-scope-parent'], undefined);

  markScopedVNodes(childRoot, childVm, 'data-scope-child', 'data-scope-child-s', markFn);
  assert.equal(childRootEl.attrs['data-scope-child'], '');
  assert.equal(internalEl.attrs['data-scope-child'], '');
  assert.equal(slotEl.attrs['data-scope-child-s'], '');
});

test('祖父链上的插槽内容：祖先打普通属性，当前组件打 -s', () => {
  const grandInstance = { parent: null };
  const parentInstance = { parent: grandInstance };
  const childInstance = { parent: parentInstance };

  const grandEl = makeEl('div');
  const childRootEl = makeEl('section');
  const slotEl = makeEl('span');

  const slotVNode = { type: 'span', ctx: grandInstance, el: slotEl, children: [] };
  const childRoot = { type: 'section', ctx: childInstance, el: childRootEl, children: [slotVNode] };
  const childCompVNode = { type: 'Child', ctx: parentInstance, component: childInstance, el: null, children: null };
  const parentCompVNode = { type: 'Parent', ctx: grandInstance, component: parentInstance, el: null, children: null };

  childInstance.subTree = childRoot;
  parentInstance.subTree = childCompVNode;
  grandInstance.subTree = { type: 'div', ctx: grandInstance, el: grandEl, children: [parentCompVNode] };

  markScopedVNodes(grandInstance.subTree, grandInstance, 'data-scope-grand', 'data-scope-grand-s', markFn);
  assert.equal(grandEl.attrs['data-scope-grand'], '');
  // 根节点继承只沿“父子组件根链”传播；Parent 不是祖父 subTree 的根，故 Child 根不带祖父属性。
  assert.equal(childRootEl.attrs['data-scope-grand'], undefined);
  assert.equal(slotEl.attrs['data-scope-grand'], '');
  assert.equal(slotEl.attrs['data-scope-grand-s'], undefined);

  markScopedVNodes(childRoot, childInstance, 'data-scope-child', 'data-scope-child-s', markFn);
  assert.equal(slotEl.attrs['data-scope-child-s'], '');
});

test('WeakSet 防止重复标记与循环递归', () => {
  const self = { parent: null };
  const el = makeEl('div');
  const vnode = { type: 'div', ctx: self, el, children: [] };

  vnode.children.push(vnode);

  markScopedVNodes(vnode, self, 'data-scope-p', 'data-scope-p-s', markFn);
  assert.equal(el.attrs['data-scope-p'], '');
});

test('Fragment/Teleport 的 el 不当作元素标记，内容节点照常标记', () => {
  const self = { parent: null };
  const firstEl = makeEl('div');
  const commentNode = { nodeType: 8, name: '#comment' };

  const fragment = {
    type: Symbol('Fragment'),
    ctx: self,
    el: firstEl,
    children: [{ type: 'div', ctx: self, el: firstEl, children: [] }],
  };
  const teleport = {
    type: { __isTeleport: true },
    ctx: self,
    el: commentNode,
    children: [{ type: 'span', ctx: self, el: makeEl('span'), children: [] }],
  };

  markScopedVNodes([fragment, teleport], self, 'data-scope-p', 'data-scope-p-s', markFn);
  assert.equal(firstEl.attrs['data-scope-p'], '');
  assert.equal(commentNode.attrs, undefined);
  assert.equal(teleport.children[0].el.attrs['data-scope-p'], '');
});

test('端到端：scoped 组件注入改写后的样式，applyScopeAttr 给根节点打属性', () => {
  const { document } = dom.window;
  const rootEl = document.createElement('div');
  const options = { styles: '<style scoped>.a{color:red}</style><p>ignored</p>' };
  const vm = { $options: options, $el: rootEl };

  styleMixin.created.call(vm);
  vm.subTree = { type: 'div', ctx: vm, el: rootEl, children: [] };

  const node = document.head.querySelector('style');
  const name = node.className;

  assert.match(name, /^uid_\d+$/);
  assert.equal(node.getAttribute('data-vue-style-scoped'), `data-scope-${name}`);
  assert.equal(node.textContent, `.a[data-scope-${name}]{color:red}`);
  assert.equal(document.head.children.length, 1);

  applyScopeAttr(vm);
  assert.equal(rootEl.hasAttribute(`data-scope-${name}`), true);

  styleMixin.unmounted.call(vm);
  assert.equal(document.head.children.length, 0);
});

test('端到端：非 scoped 组件即使遍历 vnode 也不打属性', () => {
  const { document } = dom.window;
  const rootEl = document.createElement('div');
  const vm = { $options: { styles: '<style>.a{color:red}</style>' }, $el: rootEl };

  styleMixin.created.call(vm);
  vm.subTree = { type: 'div', ctx: vm, el: rootEl, children: [] };

  applyScopeAttr(vm);

  assert.equal(rootEl.attributes.length, 0);
  assert.equal(document.head.querySelector('style').hasAttribute('data-vue-style-scoped'), false);
});
