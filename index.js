// index.js
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
var styleCounterName = "data-vue-component-instances";
var scopePrefix = "data-scope-";
var componentIds = /* @__PURE__ */ new WeakMap();
var instanceEntries = /* @__PURE__ */ new WeakMap();
var styleEntries = /* @__PURE__ */ new Map();
var id = 0;
var GROUP_AT_RULES = /* @__PURE__ */ new Set([
	"@media",
	"@supports",
	"@container",
	"@layer",
	"@document",
	"@starting-style",
	"@scope"
]);
var KEYFRAMES_AT_RULES = /* @__PURE__ */ new Set([
	"@keyframes",
	"@-webkit-keyframes",
	"@-moz-keyframes",
	"@-o-keyframes"
]);
function skipCssEscape(text, index) {
	if (text[index] !== "\\") return index + 1;
	let i = index + 1;
	if (i >= text.length) return i;
	if (text[i] === "\n" || text[i] === "\f") return i + 1;
	if (text[i] === "\r") return text[i + 1] === "\n" ? i + 2 : i + 1;
	if (/[0-9a-f]/i.test(text[i])) {
		let count = 0;
		while (i < text.length && count < 6 && /[0-9a-f]/i.test(text[i])) {
			i += 1;
			count += 1;
		}
		if (i < text.length && /\s/.test(text[i])) {
			if (text[i] === "\r" && text[i + 1] === "\n") i += 2;
			else i += 1;
		}
		return i;
	}
	return i + 1;
}
function scanCss(text, start, visitor, trackDepth = false, clampDepth = true) {
	let quote = "";
	let comment = false;
	let round = 0;
	let square = 0;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		const next = text[i + 1];
		if (comment) {
			if (ch === "*" && next === "/") {
				comment = false;
				i += 1;
			}
			continue;
		}
		if (quote) {
			if (ch === "\\") i = skipCssEscape(text, i) - 1;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === "\\") {
			i = skipCssEscape(text, i) - 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			comment = true;
			i += 1;
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quote = ch;
			continue;
		}
		if (trackDepth) {
			if (ch === "(") round += 1;
			else if (ch === ")") round = clampDepth ? Math.max(0, round - 1) : round - 1;
			else if (ch === "[") square += 1;
			else if (ch === "]") square = clampDepth ? Math.max(0, square - 1) : square - 1;
		}
		if (visitor(i, ch, round, square) === false) return;
	}
}
function skipWhitespaceAndComments(css, start) {
	let i = start;
	while (i < css.length) if (/\s/.test(css[i])) i += 1;
	else if (css[i] === "/" && css[i + 1] === "*") {
		const end = css.indexOf("*/", i + 2);
		i = end < 0 ? css.length : end + 2;
	} else break;
	return i;
}
function splitSelectors(input, delimiter = ",") {
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
		if (ch === ")" && round === 0) {
			result = i;
			return false;
		}
	}, true, false);
	return result;
}
function findMatchingBracket(text, openIndex) {
	let result = -1;
	scanCss(text, openIndex, (i, ch, round, square) => {
		if (ch === "]" && square === 0) {
			result = i;
			return false;
		}
	}, true, false);
	return result;
}
function getComponentKey(vm) {
	const type = vm && vm.$ && vm.$.type;
	return type && (typeof type === "object" || typeof type === "function") ? type : null;
}
function getComponentId(key) {
	let name = componentIds.get(key);
	if (!name) {
		name = `uid_${id++}`;
		componentIds.set(key, name);
	}
	return name;
}
function hasScopeAttribute(selector, attrSelector) {
	const expected = attrSelector.slice(1, -1);
	let found = false;
	let skipUntil = -1;
	scanCss(selector, 0, (i, ch) => {
		if (i <= skipUntil || ch !== "[") return;
		const close = findMatchingBracket(selector, i);
		if (close < 0) return false;
		if (selector.slice(i + 1, close).trim() === expected) {
			found = true;
			return false;
		}
		skipUntil = close;
	});
	return found;
}
function findTrailingPseudoElement(selector) {
	let candidate = -1;
	scanCss(selector, 0, (i, ch, round, square) => {
		const next = selector[i + 1];
		if (square === 0 && round === 0 && ch === ":" && next === ":") candidate = i;
		else if (square === 0 && round === 0 && (ch === ">" || ch === "+" || ch === "~" || /\s/.test(ch))) candidate = -1;
	}, true);
	return candidate;
}
function addScopeAttr(selector, attrSelector) {
	const value = selector.trim();
	if (!value || hasScopeAttribute(value, attrSelector)) return value;
	const pseudoElementIndex = findTrailingPseudoElement(value);
	if (pseudoElementIndex >= 0) return value.slice(0, pseudoElementIndex) + attrSelector + value.slice(pseudoElementIndex);
	return `${value}${attrSelector}`;
}
function findSpecialPseudo(selector, names) {
	let result = null;
	scanCss(selector, 0, (i, ch, round, square) => {
		if (square !== 0 || ch !== ":") return;
		for (const name of names) {
			const token = `:${name}(`;
			if (!selector.startsWith(token, i)) continue;
			const open = i + token.length - 1;
			const close = findMatchingParen(selector, open);
			if (close >= 0) {
				result = {
					name,
					start: i,
					open,
					close
				};
				return false;
			}
		}
	}, true);
	return result;
}
function findLegacyDeep(selector) {
	let result = null;
	scanCss(selector, 0, (i, ch, round, square) => {
		if (square !== 0 || round !== 0) return;
		if (selector.startsWith("/deep/", i)) {
			result = {
				index: i,
				length: 6
			};
			return false;
		}
		if (selector.startsWith(">>>", i)) {
			result = {
				index: i,
				length: 3
			};
			return false;
		}
	}, true);
	return result;
}
function normalizeLegacyDeep(selector, depth = 0) {
	if (depth > 32) return selector;
	const legacy = findLegacyDeep(selector);
	if (!legacy) return selector;
	const before = selector.slice(0, legacy.index).trimEnd();
	const after = selector.slice(legacy.index + legacy.length).trim();
	if (!after) return selector;
	const normalized = `${before} :deep(${after})`;
	if (normalized === selector) return selector;
	return normalizeLegacyDeep(normalized, depth + 1);
}
function splitTrailingCombinator(selector) {
	let candidate = -1;
	scanCss(selector, 0, (i, ch, round, square) => {
		if (square === 0 && round === 0 && (ch === ">" || ch === "+" || ch === "~")) candidate = i;
	}, true);
	if (candidate < 0) return null;
	const head = selector.slice(0, candidate).trimEnd();
	const combinator = selector.slice(candidate).trim();
	if (!head || !/^[>+~]$/.test(combinator)) return null;
	return {
		head,
		combinator
	};
}
function unwrapSpecialText(text, slottedAttrSelector, depth = 0) {
	if (depth > 32) return text;
	const special = findSpecialPseudo(text, [
		"deep",
		"slotted",
		"global"
	]);
	if (!special) return text;
	const before = text.slice(0, special.start);
	const inner = text.slice(special.open + 1, special.close);
	const rest = text.slice(special.close + 1);
	return `${before}${splitSelectors(inner).flatMap((item) => splitSelectors(unwrapSpecialText(item, slottedAttrSelector, depth + 1))).map((item) => special.name === "slotted" ? addScopeAttr(item, slottedAttrSelector) : item).join(", ")}` + unwrapSpecialText(rest, slottedAttrSelector, depth + 1);
}
function transformSelector(selector, attrSelector, slottedAttrSelector) {
	const special = findSpecialPseudo(selector, [
		"deep",
		"slotted",
		"global"
	]);
	if (!special) return addScopeAttr(selector, attrSelector);
	const before = selector.slice(0, special.start);
	const inner = selector.slice(special.open + 1, special.close);
	const tail = unwrapSpecialText(selector.slice(special.close + 1), slottedAttrSelector);
	const innerSelectors = splitSelectors(inner).flatMap((item) => splitSelectors(unwrapSpecialText(item, slottedAttrSelector)));
	if (special.name === "global") return innerSelectors.map((item) => `${before}${item}${tail}`).join(", ");
	if (special.name === "slotted") return innerSelectors.map((item) => {
		const slotted = addScopeAttr(item, slottedAttrSelector);
		return `${before}${slotted}${tail}`;
	}).join(", ");
	const left = before.trimEnd();
	const combinator = splitTrailingCombinator(left);
	let scopedLeft;
	if (combinator) scopedLeft = `${addScopeAttr(combinator.head, attrSelector)} ${combinator.combinator}`;
	else scopedLeft = left ? addScopeAttr(left, attrSelector) : attrSelector;
	return innerSelectors.map((item) => `${scopedLeft} ${item}${tail}`.trim()).join(", ");
}
function scopeSelector(selector, attrSelector, slottedAttrSelector = attrSelector) {
	const value = normalizeLegacyDeep(selector.trim());
	if (!value) return value;
	return transformSelector(value, attrSelector, slottedAttrSelector);
}
function scopeSelectorList(selectorText, attrSelector, slottedAttrSelector = attrSelector) {
	return splitSelectors(selectorText).map((selector) => scopeSelector(selector, attrSelector, slottedAttrSelector)).join(", ");
}
function addNestedScope(selector, attrSelector) {
	const value = selector.trim();
	if (!value) return value;
	let lastStart = 0;
	scanCss(value, 0, (i, ch, round, square) => {
		if (round === 0 && square === 0 && (ch === ">" || ch === "+" || ch === "~" || /\s/.test(ch))) lastStart = i + 1;
	}, true);
	if (value.slice(lastStart).trimStart().startsWith("&")) return value;
	return addScopeAttr(value, attrSelector);
}
function scopeNestedSelector(selector, attrSelector, slottedAttrSelector = attrSelector) {
	const value = normalizeLegacyDeep(selector.trim());
	if (!value) return value;
	const special = findSpecialPseudo(value, [
		"deep",
		"slotted",
		"global"
	]);
	if (!special) return addNestedScope(value, attrSelector);
	const before = value.slice(0, special.start);
	const inner = value.slice(special.open + 1, special.close);
	const tail = unwrapSpecialText(value.slice(special.close + 1), slottedAttrSelector);
	const innerSelectors = splitSelectors(inner).flatMap((item) => splitSelectors(unwrapSpecialText(item, slottedAttrSelector)));
	if (special.name === "global") return innerSelectors.map((item) => `${before}${item}${tail}`).join(", ");
	if (special.name === "slotted") return innerSelectors.map((item) => {
		const slotted = addScopeAttr(item, slottedAttrSelector);
		return `${before}${slotted}${tail}`;
	}).join(", ");
	const left = before.trimEnd();
	const combinator = splitTrailingCombinator(left);
	let scopedLeft;
	if (combinator) scopedLeft = `${addNestedScope(combinator.head, attrSelector)} ${combinator.combinator}`;
	else scopedLeft = left ? addNestedScope(left, attrSelector) : "";
	return innerSelectors.map((item) => `${scopedLeft} ${item}${tail}`.trim()).join(", ");
}
function scopeNestedSelectorList(selectorText, attrSelector, slottedAttrSelector = attrSelector) {
	const trailing = selectorText.match(/\s*$/)[0];
	return splitSelectors(selectorText).map((selector) => scopeNestedSelector(selector, attrSelector, slottedAttrSelector)).join(", ") + trailing;
}
function scanRuleBoundary(css, start) {
	let result = null;
	scanCss(css, start, (i, ch, round, square) => {
		if (round === 0 && square === 0 && (ch === "{" || ch === ";")) {
			result = {
				index: i,
				delimiter: ch
			};
			return false;
		}
	}, true);
	return result ?? {
		index: css.length,
		delimiter: ""
	};
}
function findMatchingBrace(css, openIndex) {
	let depth = 1;
	let result = -1;
	scanCss(css, openIndex + 1, (i, ch) => {
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				result = i;
				return false;
			}
		}
	});
	return result;
}
var CUSTOM_PROPERTY_DECL = new RegExp(`^--(?:[\\w\\u0080-\\uFFFF-]|\\\\(?:[0-9a-fA-F]{1,6}\\s?|.))+\\s*:`);
function isCustomPropertyDeclaration(prelude) {
	return CUSTOM_PROPERTY_DECL.test(prelude.trimStart());
}
function findCustomPropertyEnd(css, braceIndex) {
	let curly = 0;
	let afterOuterBrace = -1;
	let result = -1;
	scanCss(css, braceIndex, (i, ch, round, square) => {
		if (ch === "{") curly += 1;
		else if (ch === "}") {
			curly -= 1;
			if (curly < 0) {
				result = afterOuterBrace >= 0 ? afterOuterBrace : i;
				return false;
			}
			if (curly === 0) afterOuterBrace = i + 1;
		} else if (ch === ";" && round === 0 && square === 0 && curly === 0) {
			result = i + 1;
			return false;
		}
	}, true);
	return result >= 0 ? result : afterOuterBrace;
}
function getAtRuleName(prelude) {
	const match = prelude.trim().match(/^@([\w-]+)/);
	return match ? `@${match[1].toLowerCase()}` : "";
}
function isKeyframesAtRule(name) {
	return KEYFRAMES_AT_RULES.has(name) || /^@-[\w]+-keyframes$/.test(name);
}
function transformRules(css, attrSelector, slottedAttrSelector = attrSelector, nested = false) {
	const scopeList = nested ? scopeNestedSelectorList : scopeSelectorList;
	let output = "";
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
		if (boundary.delimiter === ";") {
			output += `${prelude};`;
			cursor = boundary.index + 1;
			continue;
		}
		if (isCustomPropertyDeclaration(prelude)) {
			const declEnd = findCustomPropertyEnd(css, boundary.index);
			if (declEnd > boundary.index) {
				output += css.slice(start, declEnd);
				cursor = declEnd;
				continue;
			}
		}
		const close = findMatchingBrace(css, boundary.index);
		if (close < 0) {
			output += css.slice(start);
			break;
		}
		const body = css.slice(boundary.index + 1, close);
		const atRule = getAtRuleName(prelude);
		if (GROUP_AT_RULES.has(atRule)) output += `${prelude}{${transformRules(body, attrSelector, slottedAttrSelector, nested)}}`;
		else if (isKeyframesAtRule(atRule)) output += `${prelude}{${body}}`;
		else if (prelude.trimStart().startsWith("@")) output += `${prelude}{${body}}`;
		else output += `${scopeList(prelude, attrSelector, slottedAttrSelector)}{${transformRules(body, attrSelector, slottedAttrSelector, true)}}`;
		cursor = close + 1;
	}
	return output;
}
function scopeCss(css, scopeAttribute) {
	return transformRules(css, `[${scopeAttribute}]`, `[${scopeAttribute}-s]`);
}
function processStyleBlock(node, name) {
	if (!node || node.nodeType !== 1 || node.tagName !== "STYLE" || !node.hasAttribute("scoped")) return node;
	const attr = `${scopePrefix}${name}`;
	const clone = node.cloneNode(false);
	clone.removeAttribute("scoped");
	if (!clone.hasAttribute("type")) clone.setAttribute("type", "text/css");
	clone.setAttribute("data-vue-style-scoped", attr);
	clone.textContent = scopeCss(node.textContent || "", attr);
	return clone;
}
function parseStyles(styleSource, name) {
	const template = document.createElement("template");
	template.innerHTML = styleSource;
	const nodes = [];
	let scoped = false;
	for (const node of Array.from(template.content.children)) if (node.tagName === "STYLE") {
		if (node.hasAttribute("scoped")) scoped = true;
		nodes.push(processStyleBlock(node, name));
	} else if (node.tagName === "LINK") {
		if ((node.getAttribute("rel") || "").toLowerCase().split(/\s+/).includes("stylesheet")) nodes.push(node);
	}
	return {
		nodes,
		scoped
	};
}
function setCounter(nodes, count) {
	for (const node of nodes) node.setAttribute(styleCounterName, String(count));
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
		for (const node of createdNodes) node.remove();
		throw error;
	}
	return {
		nodes: createdNodes,
		scoped
	};
}
function addStyles(name, styleSource) {
	if (typeof document === "undefined" || !document.head) return null;
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
		attr: `${scopePrefix}${name}`
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
	for (const node of entry.nodes) node.remove();
	styleEntries.delete(name);
}
function removeInstanceStyles(instance) {
	const name = instanceEntries.get(instance);
	if (name === void 0) return;
	instanceEntries.delete(instance);
	removeStyles(name);
}
function getVNodeOwner(vnode) {
	return (vnode && vnode.ctx) ?? null;
}
function getParentInstance(instance) {
	return (instance && instance.parent) ?? null;
}
function getRenderTree(instance) {
	return (instance && instance.subTree) ?? null;
}
function getComponentVNode(instance) {
	return (instance && instance.vnode) ?? null;
}
function getPublicInstance(instance) {
	return instance ? instance.proxy ?? instance : null;
}
function isElementVNode(vnode) {
	return Boolean(vnode && typeof vnode.type === "string");
}
function markScopeAttribute(element, attribute) {
	if (element && element.nodeType === 1) element.setAttribute(attribute, "");
}
function getInstanceScopeAttribute(instance) {
	const publicInstance = getPublicInstance(instance);
	if (!publicInstance) return null;
	const name = instanceEntries.get(publicInstance);
	if (name === void 0) return null;
	return styleEntries.get(name)?.attr ?? null;
}
function isComponentRootOfParent(instance) {
	const parent = getParentInstance(instance);
	if (!parent) return false;
	const componentVNode = getComponentVNode(instance);
	const parentTree = getRenderTree(parent);
	return Boolean(componentVNode && parentTree && componentVNode === parentTree);
}
function isFragmentVNode(vnode) {
	return Boolean(vnode) && typeof vnode === "object" && typeof vnode.type === "symbol" && Array.isArray(vnode.children);
}
function getSingleRootVNode(vnode) {
	if (!vnode || typeof vnode !== "object") return null;
	if (isElementVNode(vnode)) return vnode;
	if (vnode.component) return getSingleRootVNode(getRenderTree(vnode.component));
	const meaningful = (Array.isArray(vnode.children) ? vnode.children : []).filter((child) => {
		if (!child || typeof child !== "object") return false;
		if (typeof child.type === "symbol") return isFragmentVNode(child);
		return true;
	});
	if (meaningful.length !== 1) return null;
	return getSingleRootVNode(meaningful[0]);
}
function markInheritedRoot(vnode, attribute, mark) {
	if (!vnode || typeof vnode !== "object") return;
	const root = getSingleRootVNode(vnode);
	if (!root) return;
	if (isElementVNode(root)) mark(root.el, attribute);
}
function markInheritedScopeChain(childRoot, parentComponent, mark) {
	if (!childRoot || !parentComponent) return;
	const seen = /* @__PURE__ */ new Set();
	let current = parentComponent;
	let attribute = getInstanceScopeAttribute(current);
	if (attribute) {
		markInheritedRoot(childRoot, attribute, mark);
		seen.add(current);
	}
	while (current && isComponentRootOfParent(current)) {
		const ancestor = getParentInstance(current);
		if (!ancestor || seen.has(ancestor)) break;
		seen.add(ancestor);
		attribute = getInstanceScopeAttribute(ancestor);
		if (attribute) markInheritedRoot(childRoot, attribute, mark);
		current = ancestor;
	}
}
function isOwnedBy(vnode, self) {
	const owner = getVNodeOwner(vnode);
	return !owner || owner === self;
}
function markScopedVNodes(root, self, attr, slottedAttr = `${attr}-s`, mark = markScopeAttribute) {
	const seen = /* @__PURE__ */ new WeakSet();
	const ancestors = /* @__PURE__ */ new Set();
	for (let parent = getParentInstance(self); parent; parent = getParentInstance(parent)) ancestors.add(parent);
	const visit = (vnode) => {
		if (!vnode || typeof vnode !== "object") return;
		if (Array.isArray(vnode)) {
			for (const child of vnode) visit(child);
			return;
		}
		if (seen.has(vnode)) return;
		seen.add(vnode);
		const component = vnode.component;
		if (component) {
			const subTree = getRenderTree(component);
			if (isOwnedBy(vnode, self) && subTree) markInheritedScopeChain(subTree, self, mark);
			if (subTree) visit(subTree);
			return;
		}
		if (isElementVNode(vnode)) {
			const owner = getVNodeOwner(vnode);
			if (!owner || owner === self) mark(vnode.el, attr);
			else if (ancestors.has(owner)) mark(vnode.el, slottedAttr);
		}
		if (vnode.children) visit(vnode.children);
		if (vnode.dynamicChildren) visit(vnode.dynamicChildren);
		if (vnode.ssContent) visit(vnode.ssContent);
		if (vnode.ssFallback) visit(vnode.ssFallback);
	};
	visit(root);
}
function applyScopeAttr(instance) {
	const name = instanceEntries.get(instance);
	if (name === void 0) return;
	const entry = styleEntries.get(name);
	if (!entry?.scoped) return;
	const self = instance.$ ?? instance;
	markScopedVNodes(getRenderTree(self), self, entry.attr, `${entry.attr}-s`);
	markScopeAttribute(instance.$el, entry.attr);
}
var styleMixin = {
	created() {
		const options = this.$options;
		const styleSource = options && options.styles;
		if (typeof styleSource !== "string" || !styleSource.trim() || instanceEntries.has(this)) return;
		const key = getComponentKey(this);
		if (!key) return;
		const name = getComponentId(key);
		if (addStyles(name, styleSource)) instanceEntries.set(this, name);
	},
	mounted() {
		applyScopeAttr(this);
	},
	updated() {
		applyScopeAttr(this);
	},
	unmounted() {
		removeInstanceStyles(this);
	}
};
export { styleMixin as default, styleMixin };
