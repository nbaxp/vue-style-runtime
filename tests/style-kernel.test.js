import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addScopeAttr, scopeSelector, transformRules } from '../index.js';

const ATTR = '[data-scope-test]';

test('嵌套规则内的 :deep() 交给 CSS nesting，不再二次改写', () => {
  const css = '.card { :deep(.icon) { color: red; } }';
  assert.equal(
    transformRules(css, ATTR),
    '.card[data-scope-test]{ :deep(.icon) { color: red; } }',
  );
});

test('嵌套规则内的普通类选择器只作用域化外层', () => {
  const css = '.card { .title { color: red; } }';
  assert.equal(
    transformRules(css, ATTR),
    '.card[data-scope-test]{ .title { color: red; } }',
  );
});

test(':global() 整条规则不参与作用域', () => {
  assert.equal(scopeSelector(':global(.x)', ATTR), '.x');
  assert.equal(scopeSelector('.a :global(.x)', ATTR), '.a .x');
});

test('/deep/ 与 >>> 旧写法：左侧作用域化，右侧不再标记', () => {
  assert.equal(scopeSelector('.a /deep/ .b', ATTR), '.a[data-scope-test] .b');
  assert.equal(scopeSelector('.a >>> .b', ATTR), '.a[data-scope-test] .b');
  assert.equal(scopeSelector('/deep/ .b', ATTR), '[data-scope-test] .b');
  assert.equal(scopeSelector('.a /deep/ .b::before', ATTR), '.a[data-scope-test] .b::before');
});

test('@layer / @container / @starting-style 内部选择器作用域化', () => {
  assert.equal(
    transformRules('@layer base { .a { color: red; } }', ATTR),
    '@layer base { .a[data-scope-test]{ color: red; } }',
  );
  assert.equal(
    transformRules('@container (min-width: 30rem) { .a { color: red; } }', ATTR),
    '@container (min-width: 30rem) { .a[data-scope-test]{ color: red; } }',
  );
  assert.equal(
    transformRules('@starting-style { .a { opacity: 0; } }', ATTR),
    '@starting-style { .a[data-scope-test]{ opacity: 0; } }',
  );
});

test('语句型 at-rule 原样保留，后续规则继续作用域化', () => {
  assert.equal(
    transformRules('@import url("x.css"); .a { color: red; }', ATTR),
    '@import url("x.css"); .a[data-scope-test]{ color: red; }',
  );
  assert.equal(transformRules('@charset "utf-8";', ATTR), '@charset "utf-8";');
});

test('@-webkit-keyframes 整块跳过，后续规则照常作用域化', () => {
  const css =
    '@-webkit-keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a { color: red; }';
  assert.equal(
    transformRules(css, ATTR),
    '@-webkit-keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a[data-scope-test]{ color: red; }',
  );
});

test('非法 / 不完整 CSS 原样保留且不吞掉后续规则', () => {
  assert.equal(transformRules('.a { color: red', ATTR), '.a { color: red');
  assert.equal(
    transformRules('.a { color: red; } .b {', ATTR),
    '.a[data-scope-test]{ color: red; } .b {',
  );
});

test('addScopeAttr 幂等：已含同一属性不重复追加', () => {
  assert.equal(addScopeAttr('.a[data-scope-test]', ATTR), '.a[data-scope-test]');
  assert.equal(addScopeAttr('.a[data-scope-test]::before', ATTR), '.a[data-scope-test]::before');
});
