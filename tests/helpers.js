import { afterEach, beforeEach } from 'node:test';

import { JSDOM } from 'jsdom';

import styleMixin from '../index.js';

// 每个用例独立 DOM。`dom` 以活绑定导出，用例里可直接读取 dom.window。
export let dom;

export function setupDom() {
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    globalThis.document = dom.window.document;
  });

  afterEach(() => {
    delete globalThis.document;
    dom?.window.close();
    dom = undefined;
  });
}

// 只通过公共 mixin 注入 scoped 样式，再读取改写结果；uid 归一化成 test。
export function scopeCss(css) {
  const options = { styles: `<style scoped>${css}</style>` };
  const vm = { $options: options, $: { type: options } };

  styleMixin.created.call(vm);

  const node = document.head.querySelector('style');
  const output = node.textContent
    .split(`data-scope-${node.className}`)
    .join('data-scope-test');

  styleMixin.unmounted.call(vm);

  return output;
}
