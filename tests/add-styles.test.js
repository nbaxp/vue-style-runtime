import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

import { addStyles } from '../index.js';

test('addStyles 返回 entry 对象（可作真值判断），无节点时返回 null', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const previous = globalThis.document;

  globalThis.document = dom.window.document;

  try {
    const entry = addStyles('uid_entry', '<style scoped>.a{color:red}</style>');

    assert.ok(entry);
    assert.equal(entry.count, 1);
    assert.equal(entry.scoped, true);
    assert.equal(entry.attr, 'data-scope-uid_entry');
    assert.equal(entry.nodes.length, 1);
    assert.equal(globalThis.document.head.querySelectorAll('style.uid_entry').length, 1);

    assert.equal(addStyles('uid_empty', '<div></div>'), null);
  } finally {
    globalThis.document = previous;
  }
});
