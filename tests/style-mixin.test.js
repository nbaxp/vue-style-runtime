import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

const COUNTER = 'data-vue-component-instances';
const STYLE = '<style>.a { color: red; }</style>';
const LINK = '<link rel="stylesheet" href="/x.css" />';

let dom;
let head;
let serial = 0;

// 每个用例一份新的模块实例：包内 state（componentIds / styleEntries）是模块级的，
// 复用会串味。带 query 的 import 在 Node 里会得到独立实例。
const freshMixin = () => import(`../index.js?case=${(serial += 1)}`);

function setupDom() {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  head = dom.window.document.head;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
}

function teardownDom() {
  delete globalThis.document;
  delete globalThis.DOMParser;
  dom?.window.close();
  dom = undefined;
  head = undefined;
}

const injected = () => [...head.children];

const counterOf = (node) => node.getAttribute(COUNTER);

// Vue 3：mixin 的 this 是公开代理，$ 指向内部实例，$.type 是组件定义。
const mount = (mixin, options) => {
  const vm = { $options: options, $: { type: options } };
  mixin.created.call(vm);
  return vm;
};

beforeEach(setupDom);
afterEach(teardownDom);

test('注入 style 到 head：带组件 id class 与实例计数属性', async () => {
  const { default: mixin } = await freshMixin();

  mount(mixin, { styles: STYLE });

  const [node] = injected();
  assert.equal(injected().length, 1);
  assert.equal(node.tagName, 'STYLE');
  assert.equal(counterOf(node), '1');
  assert.equal(node.className, 'uid_0');
  assert.match(node.textContent, /\.a \{ color: red; \}/);
});

test('只处理 style / link[rel="stylesheet"]，其它标签与其它 rel 忽略', async () => {
  const { default: mixin } = await freshMixin();

  mount(mixin, {
    styles: `
      <div class="ignored">x</div>
      <link rel="preload" href="/font.woff2" />
      ${LINK}
      ${STYLE}
    `,
  });

  const nodes = injected();
  assert.deepEqual(
    nodes.map((n) => n.tagName),
    ['LINK', 'STYLE'],
  );
  assert.equal(nodes[0].getAttribute('href'), '/x.css');
  assert.ok(nodes.every((n) => n.className === 'uid_0'));
});

test('同一组件类型的多实例共享节点，计数增减，归零才移除', async () => {
  const { default: mixin } = await freshMixin();
  const options = { styles: STYLE };

  const a = mount(mixin, options);
  const b = mount(mixin, options);

  assert.equal(injected().length, 1);
  assert.equal(counterOf(injected()[0]), '2');

  mixin.unmounted.call(a);
  assert.equal(injected().length, 1);
  assert.equal(counterOf(injected()[0]), '1');

  mixin.unmounted.call(b);
  assert.equal(injected().length, 0);
});

test('重复 created 不会重复计数（同一实例只登记一次）', async () => {
  const { default: mixin } = await freshMixin();
  const options = { styles: STYLE };
  const vm = { $options: options, $: { type: options } };

  mixin.created.call(vm);
  mixin.created.call(vm);

  assert.equal(injected().length, 1);
  assert.equal(counterOf(injected()[0]), '1');

  mixin.unmounted.call(vm);
  assert.equal(injected().length, 0);
});

test('同一组件定义的多个实例共享节点，不同定义各注入一份', async () => {
  const { default: mixin } = await freshMixin();

  mount(mixin, { styles: `<style>.a{color:red}</style>` });
  mount(mixin, { styles: `<style>.b{color:blue}</style>` });

  assert.equal(injected().length, 2);
  assert.deepEqual(
    injected().map((n) => n.className),
    ['uid_0', 'uid_1'],
  );
  assert.ok(injected().every((n) => counterOf(n) === '1'));
});

test('空串 / 空白 / 非字符串的 styles 直接跳过', async () => {
  const { default: mixin } = await freshMixin();

  for (const styles of ['', '   \n ', undefined, null, 0, {}, []]) {
    const vm = mount(mixin, { styles });
    mixin.unmounted.call(vm);
  }

  assert.equal(injected().length, 0);
});

test('没有可注入节点时不算实例（不会产生悬空计数）', async () => {
  const { default: mixin } = await freshMixin();

  const vm = mount(mixin, { styles: 'just text, no tags' });
  assert.equal(injected().length, 0);

  // 未登记 => unmounted 是空操作，不应抛错
  mixin.unmounted.call(vm);
  assert.equal(injected().length, 0);
});

test('无 document 环境（SSR / Node）直接跳过且不抛错', async () => {
  const { default: mixin } = await freshMixin();
  teardownDom();

  const vm = mount(mixin, { styles: STYLE });
  mixin.unmounted.call(vm);

  setupDom();
  assert.equal(injected().length, 0);
});

test('注入中途失败会回滚，不留下半套样式', async () => {
  const { default: mixin } = await freshMixin();
  const { document: doc } = dom.window;
  const original = doc.importNode.bind(doc);
  let calls = 0;

  doc.importNode = (...args) => {
    calls += 1;
    if (calls === 2) throw new Error('import failed');
    return original(...args);
  };

  assert.throws(() => mount(mixin, { styles: `${STYLE}<style>.b{}</style>` }), /import failed/);
  assert.equal(injected().length, 0);

  // 失败未登记实例，后续卸载不应让计数变负
  doc.importNode = original;
  const vm = mount(mixin, { styles: STYLE });
  assert.equal(counterOf(injected()[0]), '1');
  mixin.unmounted.call(vm);
  assert.equal(injected().length, 0);
});

test('样式节点被外部移除后，卸载仍能正常清理且不抛错', async () => {
  const { default: mixin } = await freshMixin();
  const a = mount(mixin, { styles: STYLE });
  const b = mount(mixin, { styles: STYLE });

  injected().forEach((n) => n.remove());

  mixin.unmounted.call(a);
  mixin.unmounted.call(b);
  assert.equal(injected().length, 0);
});
