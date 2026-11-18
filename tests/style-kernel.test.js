import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeCss, setupDom } from './helpers.js';

setupDom();

test('嵌套规则内的 :deep() 交给 CSS nesting，不再二次改写', () => {
  const css = '.card { :deep(.icon) { color: red; } }';
  assert.equal(
    scopeCss(css),
    '.card[data-scope-test]{ :deep(.icon) { color: red; } }',
  );
});

test('嵌套规则内的普通类选择器只作用域化外层', () => {
  const css = '.card { .title { color: red; } }';
  assert.equal(
    scopeCss(css),
    '.card[data-scope-test]{ .title { color: red; } }',
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
