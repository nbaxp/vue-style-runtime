/**
 * Vue 3 浏览器端组件样式注入与 Scoped CSS 转换。
 *
 * styles 取自组件定义，只识别顶层 <style> / <link rel="stylesheet">；
 * 改写普通选择器与 :deep() / :slotted() / :global()、历史 /deep/ 与 >>>，
 * 递归处理分组 at-rule、跳过 keyframes，扫描时感知字符串、注释、括号与转义。
 *
 * 不替代 @vue/compiler-sfc；规则体内的 CSS nesting 会就地处理：特殊伪类脱壳、
 * 普通嵌套选择器追加 scope、& 主导的复合沿用父作用域；
 * styles 为组件定义级静态配置，实例运行期修改不生效。
 *
 * 设计边界（供静态审查参考）：
 * 1. 这是一个选择器改写器，不是 CSS 解析器。递归只用于分组 at-rule 与规则体
 *    nesting；自定义属性值里允许出现配对花括号，遇到时整段原样保留（见
 *    isCustomPropertyDeclaration / findCustomPropertyEnd），不当作规则体。
 * 2. 作用域采用"给每个目标复合选择器追加属性"的策略，不做祖先限定；
 *    nesting 中内层选择器同样追加 scope，避免穿透命中未标记的后代元素。
 *    该策略仅针对普通选择器；:slotted()/:global() 的左侧刻意不加 scope，
 *    :deep() 只作用域化左侧——与 Vue 官方编译器语义一致（见 nesting helpers）。
 * 3. :deep() / :slotted() / :global() 是编译期伪类，浏览器不识别，必须全部
 *    脱壳——残留任意一个都会导致整条规则被浏览器丢弃。脱壳同时覆盖串联、
 *    参数内部嵌套（:deep(:global(.x))）两种形态，由 unwrapSpecialText 递归完成。
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

// CSS 词法扫描器：只负责识别普通词法字符，不承担查找结果或跳转协议。
// visitor 返回 false 可提前终止；trackDepth=false 时不维护括号深度。
function scanCss(text, start, visitor, trackDepth = false, clampDepth = true) {
  let quote = '';
  let comment = false;
  let round = 0;
  let square = 0;

  for (let i = start; i < text.length; i += 1) {
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
      continue;
    }

    if (ch === '/' && next === '*') {
      comment = true;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (trackDepth) {
      if (ch === '(') {
        round += 1;
      } else if (ch === ')') {
        round = clampDepth ? Math.max(0, round - 1) : round - 1;
      } else if (ch === '[') {
        square += 1;
      } else if (ch === ']') {
        square = clampDepth ? Math.max(0, square - 1) : square - 1;
      }
    }

    if (visitor(i, ch, round, square) === false) {
      return;
    }
  }
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

  scanCss(input, 0, (i, ch, round, square) => {
    if (ch === delimiter && round === 0 && square === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }, true);

  parts.push(input.slice(start).trim());
  return parts.filter(Boolean);
}

function findMatchingParen(text, openIndex) {
  let result = -1;

  scanCss(text, openIndex, (i, ch, round) => {
    if (ch === ')' && round === 0) {
      result = i;
      return false;
    }
  }, true, false);

  return result;
}

function findMatchingBracket(text, openIndex) {
  let result = -1;

  scanCss(text, openIndex, (i, ch, round, square) => {
    if (ch === ']' && square === 0) {
      result = i;
      return false;
    }
  }, true, false);

  return result;
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
  let found = false;
  let skipUntil = -1;

  scanCss(selector, 0, (i, ch) => {
    if (i <= skipUntil || ch !== '[') return;

    const close = findMatchingBracket(selector, i);

    // 保留原实现语义：遇到未闭合的属性选择器，放弃整个判断。
    if (close < 0) {
      return false;
    }

    if (selector.slice(i + 1, close).trim() === expected) {
      found = true;
      return false;
    }

    skipUntil = close;
  });

  return found;
}

// 定位最后一个复合选择器中的伪元素；参数里的括号、字符串、属性选择器不干扰定位。
function findTrailingPseudoElement(selector) {
  let candidate = -1;

  scanCss(selector, 0, (i, ch, round, square) => {
    const next = selector[i + 1];

    if (square === 0 && round === 0 && ch === ':' && next === ':') {
      candidate = i;
    } else if (
      square === 0 &&
      round === 0 &&
      (ch === '>' || ch === '+' || ch === '~' || /\s/.test(ch))
    ) {
      candidate = -1;
    }
  }, true);

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
  let result = null;

  scanCss(selector, 0, (i, ch, round, square) => {
    if (square !== 0 || ch !== ':') return;

    for (const name of names) {
      const token = `:${name}(`;

      if (!selector.startsWith(token, i)) continue;

      const open = i + token.length - 1;
      const close = findMatchingParen(selector, open);

      if (close >= 0) {
        result = { name, start: i, open, close };
        return false;
      }
    }
  }, true);

  return result;
}

// 查找顶层历史 deep 组合符；字符串、注释、属性选择器和函数参数内不识别。
function findLegacyDeep(selector) {
  let result = null;

  scanCss(selector, 0, (i, ch, round, square) => {
    if (square !== 0 || round !== 0) return;

    if (selector.startsWith('/deep/', i)) {
      result = { index: i, length: 6 };
      return false;
    }

    if (selector.startsWith('>>>', i)) {
      result = { index: i, length: 3 };
      return false;
    }
  }, true);

  return result;
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
  let candidate = -1;

  scanCss(selector, 0, (i, ch, round, square) => {
    if (
      square === 0 &&
      round === 0 &&
      (ch === '>' || ch === '+' || ch === '~')
    ) {
      candidate = i;
    }
  }, true);

  if (candidate < 0) return null;

  const head = selector.slice(0, candidate).trimEnd();
  const combinator = selector.slice(candidate).trim();

  if (!head || !/^[>+~]$/.test(combinator)) {
    return null;
  }

  return { head, combinator };
}

// 递归脱壳一段选择器中出现的全部特殊伪类（顶层与 nesting 共用），包括
// 参数内部嵌套的情况，例如 :deep(:global(.item)) -> .item。
// 背景：:deep() / :slotted() / :global() 是 Vue 的编译期伪类，浏览器不认识；
// 只要有一个残留在输出里，整条规则会被浏览器丢弃（不是局部失效）。
// 这里只做脱壳，不追加普通 scope：调用方位于穿透/逃逸区，普通选择器原样保留；
// :slotted() 例外，仍给其目标加 -s。before 与 rest 同样递归，覆盖同一层串联
// 和参数内部嵌套两种形态。depth 是递归护栏（异常输入下防止无限脱壳）。
function unwrapSpecialText(text, slottedAttrSelector, depth = 0) {
  if (depth > 32) return text;

  const special = findSpecialPseudo(text, ['deep', 'slotted', 'global']);

  if (!special) return text;

  const before = text.slice(0, special.start);
  const inner = text.slice(special.open + 1, special.close);
  const rest = text.slice(special.close + 1);
  // inner 内部还可能再嵌特殊伪类；对每一段递归脱壳后重新按逗号拆分，
  // 保证参数展开出的多个目标都能各自参与外层的 scope 策略。
  const unwrapped = splitSelectors(inner)
    .flatMap((item) =>
      splitSelectors(unwrapSpecialText(item, slottedAttrSelector, depth + 1)),
    )
    .map((item) =>
      special.name === 'slotted'
        ? addScopeAttr(item, slottedAttrSelector)
        : item,
    )
    .join(', ');

  return (
    `${before}${unwrapped}` +
    unwrapSpecialText(rest, slottedAttrSelector, depth + 1)
  );
}

// 单个选择器：普通选择器加普通 scope；:deep(X) 只作用域化左侧；
// :slotted(X) 只给 X 加 -s；:global(X) 展开且不加 scope（本项目扩展）。
// 特殊伪类可串联或参数内嵌套，inner / after 都交给 unwrapSpecialText 递归脱壳。
// 左侧作用域策略与 Vue 官方一致：deep 作用域化左侧、slotted 左侧不加普通 scope、
// global 整条规则不参与作用域——仅指顶层规则（nesting 内的限制见下方 nesting helpers：
// 父选择器仍参与浏览器组合，:global() 只能做到不给目标追加 scope）。
function transformSelector(selector, attrSelector, slottedAttrSelector) {
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
  // 递归脱壳尾部与参数内部剩余的特殊伪类，避免残留伪类导致整条规则被丢弃。
  const tail = unwrapSpecialText(after, slottedAttrSelector);
  // inner 里的参数可能再嵌特殊伪类（如 :deep(:global(.item))），先递归脱壳。
  const innerSelectors = splitSelectors(inner).flatMap((item) =>
    splitSelectors(unwrapSpecialText(item, slottedAttrSelector)),
  );

  if (special.name === 'global') {
    // 项目约定：保留外层文本，但不添加普通 scope。
    return innerSelectors
      .map((item) => `${before}${item}${tail}`)
      .join(', ');
  }

  if (special.name === 'slotted') {
    // 官方语义：只给插槽目标添加 -s，左侧不加普通 scope（与 Vue 一致）。
    return innerSelectors
      .map((item) => {
        const slotted = addScopeAttr(item, slottedAttrSelector);

        return `${before}${slotted}${tail}`;
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
    .map((item) => `${scopedLeft} ${item}${tail}`.trim())
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

// ---- Nested rule (CSS nesting) helpers ----
// 嵌套 body 内的选择器由浏览器原生 CSS Nesting 机制与父选择器组合。
// 父选择器已经添加组件 scope，因此这里仅处理嵌套选择器自身需要的 scope。
// 注意：浏览器只按 CSS Nesting 规则做选择器组合（& 展开为父、否则视为后代），
// 它并不理解"组件 scope"这个概念，scope 全靠改写后的选择器文本本身携带。
//
// 左侧作用域策略与 Vue 官方（@vue/compiler-sfc）对齐，三类特殊伪类各有语义：
//   - :deep(X)      只作用域化左侧（.w :deep(.x) -> .w[attr] .x）；
//   - :slotted(X)   只给插槽目标加 -s，左侧不加普通 scope（官方行为）；
//   - :global(X)    只不给 X 追加组件 scope、参数脱壳（项目扩展）。注意这里
//                   不能让整条规则脱离作用域：原生 CSS nesting 下父选择器仍会
//                   参与浏览器的选择器组合，故 .p { :global(.x) {} } 脱壳后是
//                   .p[attr] { .x {} }，浏览器组合为 .p[attr] .x，并非全局 .x。
//                   要真正脱离父作用域只能提升为顶层规则，本改写器不改变 nesting
//                   结构，故不提供该能力。
// 因此"普通复合追加 scope"仅适用于没有特殊伪类的普通嵌套选择器，以及
// :deep() 的左侧；:slotted()/:global() 的左侧刻意不加 scope，并非遗漏。
// & 主导的复合不重复追加（& 展开后已带父级 scope）。

// 最后一个复合选择器若以 & 开头，& 展开为已带 scope 的父选择器，不再重复追加。
function addNestedScope(selector, attrSelector) {
  const value = selector.trim();

  if (!value) return value;

  let lastStart = 0;

  scanCss(value, 0, (i, ch, round, square) => {
    if (
      round === 0 &&
      square === 0 &&
      (ch === '>' || ch === '+' || ch === '~' || /\s/.test(ch))
    ) {
      lastStart = i + 1;
    }
  }, true);

  if (value.slice(lastStart).trimStart().startsWith('&')) {
    return value;
  }

  return addScopeAttr(value, attrSelector);
}

// 嵌套 body 中的单个选择器。与顶层 transformSelector 的处理规则一致，
// 差别只在左侧 scoping 用 addNestedScope（& 主导时不重复加 scope）。
function scopeNestedSelector(
  selector,
  attrSelector,
  slottedAttrSelector = attrSelector,
) {
  const value = normalizeLegacyDeep(selector.trim());

  if (!value) return value;

  const special = findSpecialPseudo(value, ['deep', 'slotted', 'global']);

  if (!special) {
    return addNestedScope(value, attrSelector);
  }

  const before = value.slice(0, special.start);
  const inner = value.slice(special.open + 1, special.close);
  const after = value.slice(special.close + 1);
  // 与顶层共用同一套递归脱壳逻辑，保证串联与参数内嵌套行为一致。
  const tail = unwrapSpecialText(after, slottedAttrSelector);
  const innerSelectors = splitSelectors(inner).flatMap((item) =>
    splitSelectors(unwrapSpecialText(item, slottedAttrSelector)),
  );

  if (special.name === 'global') {
    return innerSelectors
      .map((item) => `${before}${item}${tail}`)
      .join(', ');
  }

  if (special.name === 'slotted') {
    return innerSelectors
      .map((item) => {
        const slotted = addScopeAttr(item, slottedAttrSelector);
        return `${before}${slotted}${tail}`;
      })
      .join(', ');
  }

  // :deep()：脱壳。左侧带 scope，内部选择器作为穿透目标保持原样。
  // 与顶层 transformSelector 的区别：左侧为空时不补 attr（父规则已提供作用域）。
  const left = before.trimEnd();
  const combinator = splitTrailingCombinator(left);

  let scopedLeft;

  if (combinator) {
    scopedLeft =
      `${addNestedScope(combinator.head, attrSelector)} ${combinator.combinator}`;
  } else {
    scopedLeft = left ? addNestedScope(left, attrSelector) : '';
  }

  return innerSelectors
    .map((item) => `${scopedLeft} ${item}${tail}`.trim())
    .join(', ');
}

function scopeNestedSelectorList(
  selectorText,
  attrSelector,
  slottedAttrSelector = attrSelector,
) {
  // 保留 prelude 尾部空白，避免改写后选择器与 { 之间的格式噪音。
  const trailing = selectorText.match(/\s*$/)[0];

  return (
    splitSelectors(selectorText)
      .map((selector) =>
        scopeNestedSelector(selector, attrSelector, slottedAttrSelector),
      )
      .join(', ') + trailing
  );
}

// ---- CSS rule scanner ----

// 查找顶层规则边界。
function scanRuleBoundary(css, start) {
  let result = null;

  scanCss(css, start, (i, ch, round, square) => {
    if (
      round === 0 &&
      square === 0 &&
      (ch === '{' || ch === ';')
    ) {
      result = { index: i, delimiter: ch };
      return false;
    }
  }, true);

  return result ?? { index: css.length, delimiter: '' };
}

function findMatchingBrace(css, openIndex) {
  let depth = 1;
  let result = -1;

  scanCss(css, openIndex + 1, (i, ch) => {
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;

      if (depth === 0) {
        result = i;
        return false;
      }
    }
  });

  return result;
}

// 判断一条 statement 的 prelude 是否为 CSS 自定义属性声明（`--name: value`）。
// 关键区别：自定义属性的值可以合法包含配对的花括号（规范里值是一串 token），
// 例如 CSS-in-JS 主题对象 `--tokens: { color: red; }`。这些花括号属于值，
// 不是规则体；若当规则递归解析，会把 `--tokens:` 误当选择器追加 scope。
// 普通属性（如 `color`）的值不含花括号，不受此规则影响。
//
// 名称识别遵循 CSS <ident> 的常见形态：ASCII 字母数字、-、_，非 ASCII 字符，
// 以及反斜杠转义（`\u00e9`、`\:` 等）。这是保守匹配而非完整 ident 解析器：
// 名称必须紧跟 `--` 且非空、冒号前除空白外只能是上述字符。前置注释或
// 其它装饰性内容不在识别范围内——这类 prelude 本就不会被当成规则体改写，
// 交由下方通用分支原样保留即可，无需放宽此处正则。
const CUSTOM_PROPERTY_NAME = '(?:[\\w\\u0080-\\uFFFF-]|\\\\(?:[0-9a-fA-F]{1,6}\\s?|.))';
const CUSTOM_PROPERTY_DECL = new RegExp(
  `^--${CUSTOM_PROPERTY_NAME}+\\s*:`,
);
function isCustomPropertyDeclaration(prelude) {
  return CUSTOM_PROPERTY_DECL.test(prelude.trimStart());
}

// 找到自定义属性声明的结束位置：花括号可嵌套，只有回到最外层后遇到的 `;` 才结束声明；
// 若值里没有花括号（如 `--x: red`），由 transformRules 的普通 `;` 分支处理。
// 返回分号在 css 中的索引；找不到配对结构时返回 -1，交给调用方保留原文。
function findCustomPropertyEnd(css, braceIndex) {
  let curly = 0;
  let afterOuterBrace = -1;
  let result = -1;

  // 花括号计数与分号终止判断分开处理：
  // - curly 只数花括号（自定义属性值里函数/方括号内的花括号也算配对结构）；
  // - 分号只有在 round/square/curly 均为 0（即真正的最外层）才结束声明。
  // 必须显式传 trackDepth=true，否则 scanCss 回调的 round/square 恒为 0，
  // 圆括号/方括号内的分号（如 fn(a; b)、[a; b]）会被当成声明结束符。
  scanCss(css, braceIndex, (i, ch, round, square) => {
    if (ch === '{') {
      curly += 1;
    } else if (ch === '}') {
      curly -= 1;
      if (curly < 0) {
        // 遇到多余的 `}`（外层规则闭合）：声明无结尾分号，到此为止。
        result = afterOuterBrace >= 0 ? afterOuterBrace : i;
        return false;
      }
      if (curly === 0) afterOuterBrace = i + 1;
    } else if (ch === ';' && round === 0 && square === 0 && curly === 0) {
      result = i + 1;
      return false;
    }
  }, true);

  // 值里的花括号闭合后没有分号（声明块最后一项）时，退回到闭合括号之后。
  return result >= 0 ? result : afterOuterBrace;
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

// 递归处理分组 at-rule 与规则体内的 CSS nesting。
// nested=false 处理顶层规则；true 表示 current css 是某条规则体的内容，
// 其中的选择器按 CSS nesting 语义处理（scope 由父选择器继承）。
function transformRules(
  css,
  attrSelector,
  slottedAttrSelector = attrSelector,
  nested = false,
) {
  const scopeList = nested ? scopeNestedSelectorList : scopeSelectorList;

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

    // 自定义属性的值允许含配对花括号（`--x: { a: b; }`）。这里扫描到的 `{`
    // 属于值而非规则体，整段声明原样保留，不递归、不加 scope。
    // 否则会把 `--x:` 误当选择器、把值误当规则体（历史回归）。
    if (isCustomPropertyDeclaration(prelude)) {
      const declEnd = findCustomPropertyEnd(css, boundary.index);

      if (declEnd > boundary.index) {
        output += css.slice(start, declEnd);
        cursor = declEnd;
        continue;
      }
      // 配对失败时落到下方通用分支，按不完整 CSS 保留原文。
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
      // 分组 at-rule 不改变 nesting 上下文，沿用当前的 nested 值。
      output +=
        `${prelude}{${transformRules(body, attrSelector, slottedAttrSelector, nested)}}`;
    } else if (isKeyframesAtRule(atRule)) {
      // from / to / 百分比选择器不能添加作用域属性。
      output += `${prelude}{${body}}`;
    } else if (prelude.trimStart().startsWith('@')) {
      // @font-face、@page、@property 等声明块不转换。
      output += `${prelude}{${body}}`;
    } else {
      // 规则体交给下一层递归：声明原样保留，嵌套规则按 nesting 语义处理。
      output +=
        `${scopeList(prelude, attrSelector, slottedAttrSelector)}{${transformRules(body, attrSelector, slottedAttrSelector, true)}}`;
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

// Vue 3 里 Comment / Text / Fragment 的 type 都是 Symbol，不能一律过滤。
// 结构差异：Fragment 的 children 是 VNode 数组；Comment / Text 的 children 是字符串。
// 只按 type 是否 Symbol 判断会把嵌套 Fragment 一并丢掉，导致唯一根识别失败。
function isFragmentVNode(vnode) {
  return Boolean(vnode) &&
    typeof vnode === 'object' &&
    typeof vnode.type === 'symbol' &&
    Array.isArray(vnode.children);
}

// Fragment 的唯一有效根；多根不继承根 scope，Comment / Text 等符号节点不算。
// Fragment 本身递归下钻，因此嵌套 Fragment（<><><span/></></>）也能找到唯一根。
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

    // Fragment 递归下钻；Comment / Text 等符号节点（children 非数组）跳过。
    if (typeof child.type === 'symbol') {
      return isFragmentVNode(child);
    }

    return true;
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
