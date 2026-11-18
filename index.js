
/**
 * Vue 3 浏览器端组件样式注入与 Scoped CSS 转换。
 *
 * styles 取自组件定义，只识别顶层 <style> / <link rel="stylesheet">；
 * 改写普通选择器与 :deep() / :slotted() / :global()、历史 /deep/ 与 >>>，
 * 递归处理分组 at-rule、跳过 keyframes，扫描时感知字符串、注释、括号与转义。
 *
 * 不替代 @vue/compiler-sfc，不转换规则体内的 CSS nesting；
 * styles 为组件定义级静态配置，实例运行期修改不生效。
 */

const styleCounterName = 'data-vue-component-instances';
const scopePrefix = 'data-scope-';

const componentIds = new WeakMap();
const instanceEntries = new WeakMap();
const styleEntries = new Map();

let id = 0;

const GROUP_AT_RULES = new Set([
  '@media',
  '@supports',
  '@container',
  '@layer',
  '@document',
  '@starting-style',
  '@scope',
]);

const KEYFRAMES_AT_RULES = new Set([
  '@keyframes',
  '@-webkit-keyframes',
  '@-moz-keyframes',
  '@-o-keyframes',
]);

// ---- CSS lexical helpers ----

// 跳过 CSS 转义：普通转义、最多 6 位十六进制转义（含其后可选空白）、转义换行。
function skipCssEscape(text, index) {
  if (text[index] !== '\\') return index + 1;

  let i = index + 1;

  if (i >= text.length) return i;

  if (text[i] === '\n' || text[i] === '\f') {
    return i + 1;
  }

  if (text[i] === '\r') {
    return text[i + 1] === '\n' ? i + 2 : i + 1;
  }

  if (/[0-9a-f]/i.test(text[i])) {
    let count = 0;

    while (
      i < text.length &&
      count < 6 &&
      /[0-9a-f]/i.test(text[i])
    ) {
      i += 1;
      count += 1;
    }

    if (i < text.length && /\s/.test(text[i])) {
      if (text[i] === '\r' && text[i + 1] === '\n') {
        i += 2;
      } else {
        i += 1;
      }
    }

    return i;
  }

  return i + 1;
}

function skipWhitespaceAndComments(css, start) {
  let i = start;

  while (i < css.length) {
    if (/\s/.test(css[i])) {
      i += 1;
    } else if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else {
      break;
    }
  }

  return i;
}

// 按顶层分隔符切分，忽略字符串、注释、函数括号、属性选择器与 CSS 转义。
function splitSelectors(input, delimiter = ',') {
  const parts = [];

  let start = 0;
  let round = 0;
  let square = 0;
  let quote = '';
  let comment = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(input, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(input, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      round += 1;
    } else if (ch === ')') {
      round = Math.max(0, round - 1);
    } else if (ch === '[') {
      square += 1;
    } else if (ch === ']') {
      square = Math.max(0, square - 1);
    } else if (
      ch === delimiter &&
      round === 0 &&
      square === 0
    ) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }

  parts.push(input.slice(start).trim());

  return parts.filter(Boolean);
}

function findMatchingParen(text, openIndex) {
  let depth = 0;
  let quote = '';
  let comment = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(text, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(text, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;

      if (depth === 0) return i;
    }
  }

  return -1;
}

function findMatchingBracket(text, openIndex) {
  let depth = 0;
  let quote = '';
  let comment = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(text, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(text, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;

      if (depth === 0) return i;
    }
  }

  return -1;
}

// ---- Component identity ----

function getComponentKey(vm) {
  const type = vm && vm.$ && vm.$.type;

  return type && (typeof type === 'object' || typeof type === 'function')
    ? type
    : null;
}

function getComponentId(key) {
  let name = componentIds.get(key);

  if (!name) {
    name = `uid_${id++}`;
    componentIds.set(key, name);
  }

  return name;
}

// ---- Scoped selector helpers ----

// 判断选择器中是否已存在目标属性；不用 includes()，避免值/字符串/注释里的同文本误判。
function hasScopeAttribute(selector, attrSelector) {
  const expected = attrSelector.slice(1, -1);

  let quote = '';
  let comment = false;

  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    const next = selector[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(selector, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(selector, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      const close = findMatchingBracket(selector, i);

      if (close < 0) return false;

      if (selector.slice(i + 1, close).trim() === expected) {
        return true;
      }

      i = close;
    }
  }

  return false;
}

// 定位最后一个复合选择器中的伪元素；参数里的括号、字符串、属性选择器不干扰定位。
function findTrailingPseudoElement(selector) {
  let quote = '';
  let comment = false;
  let square = 0;
  let round = 0;
  let candidate = -1;

  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    const next = selector[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(selector, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(selector, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      square += 1;
    } else if (ch === ']') {
      square = Math.max(0, square - 1);
    } else if (ch === '(') {
      round += 1;
    } else if (ch === ')') {
      round = Math.max(0, round - 1);
    } else if (
      square === 0 &&
      round === 0 &&
      ch === ':' &&
      next === ':'
    ) {
      candidate = i;
    } else if (
      square === 0 &&
      round === 0 &&
      (ch === '>' || ch === '+' || ch === '~' || /\s/.test(ch))
    ) {
      candidate = -1;
    }
  }

  return candidate;
}

function addScopeAttr(selector, attrSelector) {
  const value = selector.trim();

  if (!value || hasScopeAttribute(value, attrSelector)) {
    return value;
  }

  const pseudoElementIndex = findTrailingPseudoElement(value);

  if (pseudoElementIndex >= 0) {
    return (
      value.slice(0, pseudoElementIndex) +
      attrSelector +
      value.slice(pseudoElementIndex)
    );
  }

  return `${value}${attrSelector}`;
}

// 查找特殊伪类；字符串、注释和属性选择器内不识别。
function findSpecialPseudo(selector, names) {
  let quote = '';
  let comment = false;
  let square = 0;

  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    const next = selector[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(selector, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(selector, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      square += 1;
    } else if (ch === ']') {
      square = Math.max(0, square - 1);
    } else if (square === 0 && ch === ':') {
      for (const name of names) {
        const token = `:${name}(`;

        if (!selector.startsWith(token, i)) continue;

        const open = i + token.length - 1;
        const close = findMatchingParen(selector, open);

        if (close >= 0) {
          return { name, start: i, open, close };
        }
      }
    }
  }

  return null;
}

// 查找顶层历史 deep 组合符；字符串、注释、属性选择器和函数参数内不识别。
function findLegacyDeep(selector) {
  let quote = '';
  let comment = false;
  let square = 0;
  let round = 0;

  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    const next = selector[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(selector, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(selector, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      square += 1;
    } else if (ch === ']') {
      square = Math.max(0, square - 1);
    } else if (ch === '(') {
      round += 1;
    } else if (ch === ')') {
      round = Math.max(0, round - 1);
    } else if (square === 0 && round === 0) {
      if (selector.startsWith('/deep/', i)) {
        return { index: i, length: 6 };
      }

      if (selector.startsWith('>>>', i)) {
        return { index: i, length: 3 };
      }
    }
  }

  return null;
}

// 历史 deep 组合符统一成 :deep()：右侧整体作为参数，避免 scope 落到右边。
// .a /deep/ .b -> .a :deep(.b)；.a > /deep/ .b -> .a > :deep(.b)
function normalizeLegacyDeep(selector, depth = 0) {
  if (depth > 32) return selector;

  const legacy = findLegacyDeep(selector);

  if (!legacy) return selector;

  const before = selector.slice(0, legacy.index).trimEnd();
  const after = selector.slice(legacy.index + legacy.length).trim();

  if (!after) {
    // 不完整的历史语法不主动改写。
    return selector;
  }

  const normalized = `${before} :deep(${after})`;

  // 防止异常输入造成无意义的递归。
  if (normalized === selector) return selector;

  return normalizeLegacyDeep(normalized, depth + 1);
}

// 查找选择器末尾的显式组合器。
function splitTrailingCombinator(selector) {
  let quote = '';
  let comment = false;
  let square = 0;
  let round = 0;
  let candidate = -1;

  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    const next = selector[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(selector, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(selector, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      square += 1;
    } else if (ch === ']') {
      square = Math.max(0, square - 1);
    } else if (ch === '(') {
      round += 1;
    } else if (ch === ')') {
      round = Math.max(0, round - 1);
    } else if (
      square === 0 &&
      round === 0 &&
      (ch === '>' || ch === '+' || ch === '~')
    ) {
      candidate = i;
    }
  }

  if (candidate < 0) return null;

  const head = selector.slice(0, candidate).trimEnd();
  const combinator = selector.slice(candidate).trim();

  if (!head || !/^[>+~]$/.test(combinator)) {
    return null;
  }

  return { head, combinator };
}

// 单个选择器：普通选择器加普通 scope；:deep(X) 只作用域化左侧；
// :slotted(X) 只给 X 加 -s；:global(X) 展开且不加 scope（本项目扩展）。
function transformSelector(
  selector,
  attrSelector,
  slottedAttrSelector,
  depth = 0,
) {
  if (depth > 32) {
    return addScopeAttr(selector, attrSelector);
  }

  const special = findSpecialPseudo(
    selector,
    ['deep', 'slotted', 'global'],
  );

  if (!special) {
    return addScopeAttr(selector, attrSelector);
  }

  const before = selector.slice(0, special.start);
  const inner = selector.slice(special.open + 1, special.close);
  const after = selector.slice(special.close + 1);

  const innerSelectors = splitSelectors(inner);

  if (special.name === 'global') {
    // 项目约定：保留外层文本，但不添加普通 scope。
    return innerSelectors
      .map((item) => `${before}${item}${after}`)
      .join(', ');
  }

  if (special.name === 'slotted') {
    // 官方语义：只给插槽目标添加 -s，外层不加普通 scope。
    return innerSelectors
      .map((item) => {
        const slotted = addScopeAttr(item, slottedAttrSelector);

        return `${before}${slotted}${after}`;
      })
      .join(', ');
  }

  // :deep()：只作用域化左侧。
  const left = before.trimEnd();
  const combinator = splitTrailingCombinator(left);

  let scopedLeft;

  if (combinator) {
    scopedLeft =
      `${addScopeAttr(combinator.head, attrSelector)} ${combinator.combinator}`;
  } else {
    scopedLeft = left
      ? addScopeAttr(left, attrSelector)
      : attrSelector;
  }

  return innerSelectors
    .map((item) => `${scopedLeft} ${item}${after}`.trim())
    .join(', ');
}

function scopeSelector(
  selector,
  attrSelector,
  slottedAttrSelector = attrSelector,
) {
  const value = normalizeLegacyDeep(selector.trim());

  if (!value) return value;

  return transformSelector(
    value,
    attrSelector,
    slottedAttrSelector,
  );
}

function scopeSelectorList(
  selectorText,
  attrSelector,
  slottedAttrSelector = attrSelector,
) {
  return splitSelectors(selectorText)
    .map((selector) =>
      scopeSelector(selector, attrSelector, slottedAttrSelector),
    )
    .join(', ');
}

// ---- CSS rule scanner ----

// 查找顶层规则边界。
function scanRuleBoundary(css, start) {
  let quote = '';
  let comment = false;
  let round = 0;
  let square = 0;

  for (let i = start; i < css.length; i += 1) {
    const ch = css[i];
    const next = css[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(css, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(css, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      round += 1;
    } else if (ch === ')') {
      round = Math.max(0, round - 1);
    } else if (ch === '[') {
      square += 1;
    } else if (ch === ']') {
      square = Math.max(0, square - 1);
    } else if (
      round === 0 &&
      square === 0 &&
      (ch === '{' || ch === ';')
    ) {
      return { index: i, delimiter: ch };
    }
  }

  return { index: css.length, delimiter: '' };
}

function findMatchingBrace(css, openIndex) {
  let depth = 1;
  let quote = '';
  let comment = false;

  for (let i = openIndex + 1; i < css.length; i += 1) {
    const ch = css[i];
    const next = css[i + 1];

    if (comment) {
      if (ch === '*' && next === '/') {
        comment = false;
        i += 1;
      }

      continue;
    }

    if (quote) {
      if (ch === '\\') {
        i = skipCssEscape(css, i) - 1;
      } else if (ch === quote) {
        quote = '';
      }

      continue;
    }

    if (ch === '\\') {
      i = skipCssEscape(css, i) - 1;
    } else if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;

      if (depth === 0) return i;
    }
  }

  return -1;
}

function getAtRuleName(prelude) {
  const match = prelude.trim().match(/^@([\w-]+)/);

  return match ? `@${match[1].toLowerCase()}` : '';
}

function isKeyframesAtRule(name) {
  return (
    KEYFRAMES_AT_RULES.has(name) ||
    /^@-[\w]+-keyframes$/.test(name)
  );
}

// 递归处理分组 at-rule；规则体内的 CSS nesting 不转换。
function transformRules(
  css,
  attrSelector,
  slottedAttrSelector = attrSelector,
) {
  let output = '';
  let cursor = 0;

  while (cursor < css.length) {
    const start = skipWhitespaceAndComments(css, cursor);

    output += css.slice(cursor, start);

    if (start >= css.length) break;

    const boundary = scanRuleBoundary(css, start);

    if (!boundary.delimiter) {
      output += css.slice(start);
      break;
    }

    const prelude = css.slice(start, boundary.index);

    if (boundary.delimiter === ';') {
      output += `${prelude};`;
      cursor = boundary.index + 1;
      continue;
    }

    const close = findMatchingBrace(css, boundary.index);

    if (close < 0) {
      // 非法或不完整 CSS：保留剩余原文。
      output += css.slice(start);
      break;
    }

    const body = css.slice(boundary.index + 1, close);
    const atRule = getAtRuleName(prelude);

    if (GROUP_AT_RULES.has(atRule)) {
      output +=
        `${prelude}{${transformRules(body, attrSelector, slottedAttrSelector)}}`;
    } else if (isKeyframesAtRule(atRule)) {
      // from / to / 百分比选择器不能添加作用域属性。
      output += `${prelude}{${body}}`;
    } else if (prelude.trimStart().startsWith('@')) {
      // @font-face、@page、@property 等声明块不转换。
      output += `${prelude}{${body}}`;
    } else {
      output +=
        `${scopeSelectorList(prelude, attrSelector, slottedAttrSelector)}{${body}}`;
    }

    cursor = close + 1;
  }

  return output;
}

function scopeCss(css, scopeAttribute) {
  const attrSelector = `[${scopeAttribute}]`;

  return transformRules(
    css,
    attrSelector,
    `[${scopeAttribute}-s]`,
  );
}

// ---- Style parsing and injection ----

function processStyleBlock(node, name) {
  if (
    !node ||
    node.nodeType !== 1 ||
    node.tagName !== 'STYLE' ||
    !node.hasAttribute('scoped')
  ) {
    return node;
  }

  const attr = `${scopePrefix}${name}`;
  const clone = node.cloneNode(false);

  clone.removeAttribute('scoped');

  if (!clone.hasAttribute('type')) {
    clone.setAttribute('type', 'text/css');
  }

  clone.setAttribute('data-vue-style-scoped', attr);
  clone.textContent = scopeCss(node.textContent || '', attr);

  return clone;
}

function parseStyles(styleSource, name) {
  const template = document.createElement('template');

  template.innerHTML = styleSource;

  const nodes = [];
  let scoped = false;

  for (const node of Array.from(template.content.children)) {
    if (node.tagName === 'STYLE') {
      if (node.hasAttribute('scoped')) {
        scoped = true;
      }

      nodes.push(processStyleBlock(node, name));
    } else if (node.tagName === 'LINK') {
      const rel = node.getAttribute('rel') || '';

      if (rel.toLowerCase().split(/\s+/).includes('stylesheet')) {
        nodes.push(node);
      }
    }
  }

  return { nodes, scoped };
}

function setCounter(nodes, count) {
  for (const node of nodes) {
    node.setAttribute(styleCounterName, String(count));
  }
}

function createStyleNodes(name, styleSource, count) {
  const { nodes: sourceNodes, scoped } = parseStyles(styleSource, name);
  const createdNodes = [];

  try {
    for (const source of sourceNodes) {
      const node = document.importNode(source, true);

      node.classList.add(name);
      node.setAttribute(styleCounterName, String(count));

      document.head.appendChild(node);
      createdNodes.push(node);
    }
  } catch (error) {
    for (const node of createdNodes) {
      node.remove();
    }

    throw error;
  }

  return { nodes: createdNodes, scoped };
}

function addStyles(name, styleSource) {
  if (typeof document === 'undefined' || !document.head) {
    return null;
  }

  const entry = styleEntries.get(name);

  if (entry) {
    entry.count += 1;
    setCounter(entry.nodes, entry.count);

    return entry;
  }

  const { nodes, scoped } = createStyleNodes(name, styleSource, 1);

  if (nodes.length === 0) return null;

  const created = {
    count: 1,
    nodes,
    scoped,
    attr: `${scopePrefix}${name}`,
  };

  styleEntries.set(name, created);

  return created;
}

function removeStyles(name) {
  const entry = styleEntries.get(name);

  if (!entry) return;

  entry.count -= 1;

  if (entry.count > 0) {
    setCounter(entry.nodes, entry.count);
    return;
  }

  for (const node of entry.nodes) {
    node.remove();
  }

  styleEntries.delete(name);
}

function removeInstanceStyles(instance) {
  const name = instanceEntries.get(instance);

  if (name === undefined) return;

  instanceEntries.delete(instance);
  removeStyles(name);
}

// ---- Vue instance / VNode helpers ----

function getVNodeOwner(vnode) {
  return (vnode && vnode.ctx) ?? null;
}

function getParentInstance(instance) {
  return (instance && instance.parent) ?? null;
}

function getRenderTree(instance) {
  return (instance && instance.subTree) ?? null;
}

// 组件实例对应的组件 VNode。
function getComponentVNode(instance) {
  return (instance && instance.vnode) ?? null;
}

// 公开实例：内部实例的 proxy。
function getPublicInstance(instance) {
  return instance
    ? (instance.proxy ?? instance)
    : null;
}

function isElementVNode(vnode) {
  return Boolean(vnode && typeof vnode.type === 'string');
}

function markScopeAttribute(element, attribute) {
  if (element && element.nodeType === 1) {
    element.setAttribute(attribute, '');
  }
}

// 取已注册的 scope 属性；需经 proxy 找到 mixin 保存的公开实例。
function getInstanceScopeAttribute(instance) {
  const publicInstance = getPublicInstance(instance);

  if (!publicInstance) return null;

  const name = instanceEntries.get(publicInstance);

  if (name === undefined) return null;

  return styleEntries.get(name)?.attr ?? null;
}

// instance 是否为父组件的直接渲染根：比的是它自己的组件 VNode 与父组件 subTree。
function isComponentRootOfParent(instance) {
  const parent = getParentInstance(instance);

  if (!parent) return false;

  const componentVNode = getComponentVNode(instance);
  const parentTree = getRenderTree(parent);

  return Boolean(
    componentVNode &&
    parentTree &&
    componentVNode === parentTree
  );
}

// Fragment 的唯一有效根；多根不继承根 scope，Symbol 类型的注释/文本节点不算。
function getSingleRootVNode(vnode) {
  if (!vnode || typeof vnode !== 'object') {
    return null;
  }

  if (isElementVNode(vnode)) {
    return vnode;
  }

  if (vnode.component) {
    return getSingleRootVNode(getRenderTree(vnode.component));
  }

  const children = Array.isArray(vnode.children)
    ? vnode.children
    : [];

  const meaningful = children.filter((child) => {
    if (!child || typeof child !== 'object') return false;

    // Vue 3 的 Comment / Text / 内层 Fragment 等 VNode 的 type 是 Symbol。
    return typeof child.type !== 'symbol';
  });

  if (meaningful.length !== 1) {
    return null;
  }

  return getSingleRootVNode(meaningful[0]);
}

// 给组件渲染根打属性：普通元素、单根 Fragment、根为子组件；多根 Fragment 不展开。
function markInheritedRoot(vnode, attribute, mark) {
  if (!vnode || typeof vnode !== 'object') return;

  const root = getSingleRootVNode(vnode);

  if (!root) return;

  if (isElementVNode(root)) {
    mark(root.el, attribute);
  }
}

// 父 scope 必加；只有父组件自身也是祖辈的直接渲染根，才沿根链继续上溯祖父 scope。
function markInheritedScopeChain(
  childRoot,
  parentComponent,
  mark,
) {
  if (!childRoot || !parentComponent) return;

  const seen = new Set();

  // 父 scope 必须继承。
  let current = parentComponent;
  let attribute = getInstanceScopeAttribute(current);

  if (attribute) {
    markInheritedRoot(childRoot, attribute, mark);
    seen.add(current);
  }

  // 祖先 scope 只沿组件根节点继承链继续传递。
  while (current && isComponentRootOfParent(current)) {
    const ancestor = getParentInstance(current);

    if (!ancestor || seen.has(ancestor)) {
      break;
    }

    seen.add(ancestor);

    attribute = getInstanceScopeAttribute(ancestor);

    if (attribute) {
      markInheritedRoot(childRoot, attribute, mark);
    }

    current = ancestor;
  }
}

// 组件 VNode 是否属于当前组件；vnode.ctx 是内部实例，与 self 同类型可比。
function isOwnedBy(vnode, self) {
  const owner = getVNodeOwner(vnode);

  return !owner || owner === self;
}

// 遍历 VNode 树：本组件创建的元素与子组件根打普通 scope，
// 祖先传入的插槽元素打 -s，子组件内部的普通元素不打。
function markScopedVNodes(
  root,
  self,
  attr,
  slottedAttr = `${attr}-s`,
  mark = markScopeAttribute,
) {
  const seen = new WeakSet();

  // 祖先链在一次遍历期间不变，预先建 Set，避免每个元素都从 self 上溯。
  const ancestors = new Set();

  for (
    let parent = getParentInstance(self);
    parent;
    parent = getParentInstance(parent)
  ) {
    ancestors.add(parent);
  }

  const visit = (vnode) => {
    if (!vnode || typeof vnode !== 'object') return;

    if (Array.isArray(vnode)) {
      for (const child of vnode) {
        visit(child);
      }

      return;
    }

    if (seen.has(vnode)) return;
    seen.add(vnode);

    const component = vnode.component;

    if (component) {
      const subTree = getRenderTree(component);

      // 当前组件模板中的子组件根节点必须继承当前 scope。
      if (isOwnedBy(vnode, self) && subTree) {
        // 当前组件及符合条件的祖先 scope 统一沿根节点继承链传播。
        markInheritedScopeChain(subTree, self, mark);
      }

      // 进入子组件渲染树，以便发现当前组件传入的插槽 VNode。
      // 普通子组件内部节点的 owner 不属于 self，不会被误标记。
      if (subTree) {
        visit(subTree);
      }

      return;
    }

    if (isElementVNode(vnode)) {
      const owner = getVNodeOwner(vnode);

      if (!owner || owner === self) {
        mark(vnode.el, attr);
      } else if (ancestors.has(owner)) {
        // 祖先提供的插槽内容只标记 slotted scope。
        mark(vnode.el, slottedAttr);
      }
    }

    if (vnode.children) {
      visit(vnode.children);
    }

    if (vnode.dynamicChildren) {
      visit(vnode.dynamicChildren);
    }

    if (vnode.ssContent) {
      visit(vnode.ssContent);
    }

    if (vnode.ssFallback) {
      visit(vnode.ssFallback);
    }
  };

  visit(root);
}

function applyScopeAttr(instance) {
  const name = instanceEntries.get(instance);

  if (name === undefined) return;

  const entry = styleEntries.get(name);

  if (!entry?.scoped) return;

  const self = instance.$ ?? instance;

  markScopedVNodes(
    getRenderTree(self),
    self,
    entry.attr,
    `${entry.attr}-s`,
  );

  // 单根组件的根元素兜底。
  // Fragment 的 $el 可能是注释节点，markScopeAttribute 会自动忽略。
  markScopeAttribute(instance.$el, entry.attr);
}

// ---- Vue mixin ----

const styleMixin = {
  created() {
    const options = this.$options;
    const styleSource = options && options.styles;

    if (
      typeof styleSource !== 'string' ||
      !styleSource.trim() ||
      instanceEntries.has(this)
    ) {
      return;
    }

    const key = getComponentKey(this);

    if (!key) {
      return;
    }

    const name = getComponentId(key);

    if (addStyles(name, styleSource)) {
      instanceEntries.set(this, name);
    }
  },

  mounted() {
    applyScopeAttr(this);
  },

  updated() {
    applyScopeAttr(this);
  },

  // Vue 3
  unmounted() {
    removeInstanceStyles(this);
  },
};

export { styleMixin };

export default styleMixin;
