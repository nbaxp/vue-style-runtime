/**
 * 性能基准：运行时 scoped CSS 转换与样式注入。
 *
 * 用法：
 *   npm run bench                         首次运行生成基线；之后运行与基线对比并判定回归
 *   npm run bench -- --update-baseline    用当前结果覆盖基线
 *   npm run bench -- --tolerance=0.3      自定义回归阈值（默认 0.2，即 +20%）
 *
 * 覆盖两个维度：
 *   1) scope 状态 —— CSS / 选择器是否已带 scope（决定走完整转换、早退还是透传）
 *   2) 复杂度     —— simple / medium / complex
 *
 * Part 1「核心转换」：直接调内部纯函数 scopeCss，消除 DOM 噪声。
 *   - no-scope：选择器不含 [data-scope-bench]，需要追加作用域属性
 *   - with-scope：选择器已含 [data-scope-bench]，hasScopeAttribute 命中而早退
 *
 * Part 2「端到端注入」：走公共 styleMixin + jsdom。
 *   - scoped：<style scoped> 需要转换 + 注入 + 打属性
 *   - plain ：<style> 无需转换，仅注入
 *
 * 基线保存在 benchmarks/baseline.json（已加入 .gitignore，仅本地）。
 * 跨机器数值不可比：环境指纹不一致时只显示数值、跳过 PASS/FAIL 判定。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { JSDOM } from 'jsdom';

import styleMixin from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'baseline.json');

// ---------- 命令行参数 ----------

const args = process.argv.slice(2);
const UPDATE_BASELINE = args.includes('--update-baseline');
const tolArg = args.find((a) => a.startsWith('--tolerance='));
const TOLERANCE = tolArg ? Number(tolArg.split('=')[1]) : 0.2;

if (!Number.isFinite(TOLERANCE) || TOLERANCE <= 0 || TOLERANCE >= 1) {
  console.error('--tolerance 必须是 0 到 1 之间的数（如 0.2 表示 +20%）');
  process.exit(1);
}

// ---------- 环境指纹 ----------

const ENV = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: os.cpus()?.[0]?.model ?? 'unknown',
};

const CONFIG = {
  tolerance: TOLERANCE,
  minDeltaMs: 0.01, // 绝对噪声地板：低于 10μs 的变化无实际意义，不判回归
  warmup: 120,
  rounds: 7,
  itersPerRound: 300,
};

function envMatches(a, b) {
  return (
    a.node === b.node &&
    a.platform === b.platform &&
    a.arch === b.arch &&
    a.cpu === b.cpu
  );
}

// ---------- 加载内部纯函数 ----------

// 内部函数没有公开导出。这里在内存里给源码追加一条导出，用 data URL 加载，
// 既不修改 index.js，也不改变公共 API；index.js 自身无相对 import，可安全内联。
const src = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const instrumented = `${src}\nexport { scopeCss, scopeSelector, scopeSelectorList, hasScopeAttribute, splitSelectors };\n`;
const kernel = await import(
  `data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`
);

const dom = new JSDOM(
  '<!doctype html><html><head></head><body></body></html>',
);
globalThis.document = dom.window.document;

const ATTR = 'data-scope-bench';

// ---------- 复杂度夹具 ----------

const SIMPLE = '.a { color: red; }';

const MEDIUM = [
  '.a, .b > .c { color: red; }',
  '.d:deep(.e) { color: blue; }',
  ':slotted(.f) { color: green; }',
  ':global(.g) { color: black; }',
].join('\n');

const COMPLEX_UNIT = [
  '/* banner */',
  '.a[data-x="a,b"]:deep(.b > .c) { color: red; background: url("x,y"); }',
  '@media (min-width: 100px) {',
  '  @supports (display: grid) {',
  '    .d /deep/ .e, .f >>> .g { content: "]"; margin: 0; }',
  '    .h\\:i[data-y="/*"] { padding: 1px; }',
  '  }',
  '}',
  '@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }',
  '.j:slotted(.k) > .l + .m { border: 1px solid #fff; }',
].join('\n');

const COMPLEX = Array.from({ length: 8 }, (_, n) =>
  COMPLEX_UNIT.replace(/\.([a-m])/g, `.$1${n}`),
).join('\n');

const FIXTURES = { simple: SIMPLE, medium: MEDIUM, complex: COMPLEX };

// 用转换器自身产出「已带 scope」的 CSS，作为早退路径的真实输入。
// 不用正则硬塞属性：那会破坏转义（.h\:i）并误插进 :deep() 内部。
function withScope(css) {
  return kernel.scopeCss(css, ATTR);
}

// ---------- 计时 ----------

let sink = 0;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(fn) {
  for (let i = 0; i < CONFIG.warmup; i += 1) fn();

  const samples = [];
  for (let r = 0; r < CONFIG.rounds; r += 1) {
    const t0 = performance.now();
    for (let i = 0; i < CONFIG.itersPerRound; i += 1) fn();
    samples.push((performance.now() - t0) / CONFIG.itersPerRound);
  }

  return { ms: median(samples), samples };
}

// ---------- 采集 ----------

const rows = [];

for (const level of ['simple', 'medium', 'complex']) {
  const css = FIXTURES[level];

  rows.push({
    key: `p1|no-scope|${level}`,
    part: 'p1',
    scope: 'no-scope',
    level,
    ...bench(() => {
      sink += kernel.scopeCss(css, ATTR).length;
    }),
  });

  const scopedCss = withScope(css);
  rows.push({
    key: `p1|with-scope|${level}`,
    part: 'p1',
    scope: 'with-scope',
    level,
    ...bench(() => {
      sink += kernel.scopeCss(scopedCss, ATTR).length;
    }),
  });
}

function injectionFn(css, scoped) {
  return () => {
    const options = {
      styles: `<style${scoped ? ' scoped' : ''}>${css}</style>`,
    };
    const vm = { $options: options, $: { type: options } };
    styleMixin.created.call(vm);
    styleMixin.unmounted.call(vm);
  };
}

for (const scoped of [true, false]) {
  for (const level of ['simple', 'medium', 'complex']) {
    rows.push({
      key: `p2|${scoped ? 'scoped' : 'plain'}|${level}`,
      part: 'p2',
      scope: scoped ? 'scoped' : 'plain',
      level,
      ...bench(injectionFn(FIXTURES[level], scoped)),
    });
  }
}

// ---------- 基线读写与判定 ----------

function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveBaseline() {
  const cases = {};
  for (const row of rows) {
    cases[row.key] = { ms: row.ms, samples: row.samples };
  }
  const data = {
    version: 1,
    createdAt: new Date().toISOString(),
    env: ENV,
    config: CONFIG,
    cases,
  };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

// 相对阈值 + 绝对噪声地板双门槛；基线自身抖动作为第二重地板。
function judge(current, base) {
  const ratio = current / base.ms;
  const delta = current - base.ms;
  const noise = Math.max(...base.samples) - Math.min(...base.samples);
  const floor = Math.max(CONFIG.minDeltaMs, noise * 2);

  if (ratio > 1 + CONFIG.tolerance && delta > floor) return { ratio, verdict: 'SLOWER' };
  if (ratio < 1 - CONFIG.tolerance && -delta > floor) return { ratio, verdict: 'FASTER' };
  return { ratio, verdict: 'OK' };
}

let baseline = readBaseline();
const firstRun = !baseline || UPDATE_BASELINE;
const envOk = baseline ? envMatches(ENV, baseline.env) : false;

if (firstRun) {
  baseline = saveBaseline();
}

const comparable = !firstRun && envOk;

// ---------- 输出 ----------

function report(title, part) {
  const group = rows.filter((r) => r.part === part);
  const base = group[0]?.ms ?? 1;
  const w = (s, n) => String(s).padEnd(n);

  console.log(`\n=== ${title} ===\n`);
  console.log(
    w('scope', 12) + w('复杂度', 10) + w('中位 ms/op', 13) +
    w('相对第1行', 11) + w('基线 ms', 12) + w('变化', 10) + '判定',
  );
  console.log('-'.repeat(76));

  for (const row of group) {
    let baseMs = '—';
    let change = '—';
    let verdict = firstRun ? '基线已写入' : '';

    if (!firstRun) {
      if (envOk) {
        const b = baseline.cases[row.key];
        if (b) {
          const j = judge(row.ms, b);
          baseMs = b.ms.toFixed(4);
          change = `${j.ratio >= 1 ? '+' : ''}${((j.ratio - 1) * 100).toFixed(1)}%`;
          verdict = j.verdict;
          if (j.verdict === 'SLOWER') process.exitCode = 1;
        } else {
          verdict = '无基线项';
        }
      } else {
        verdict = '环境不符,跳过';
      }
    }

    console.log(
      w(row.scope, 12) +
      w(row.level, 10) +
      w(row.ms.toFixed(4), 13) +
      w(`${(row.ms / base).toFixed(2)}x`, 11) +
      w(baseMs, 12) +
      w(change, 10) +
      verdict,
    );
  }
}

report('Part 1 核心 CSS 转换（scopeCss 纯函数，无 DOM 开销）', 'p1');
report('Part 2 端到端样式注入（styleMixin + jsdom）', 'p2');

console.log(`\n环境：Node ${ENV.node} / ${ENV.platform} ${ENV.arch} / ${ENV.cpu}`);
console.log(
  `判定：相对阈值 +${(CONFIG.tolerance * 100).toFixed(0)}%，绝对噪声地板 ${CONFIG.minDeltaMs}ms；` +
  `变化超过 +${(CONFIG.tolerance * 100).toFixed(0)}% 且增量 > 地板 判为 SLOWER（退出码 1）。`,
);
console.log('FASTER 不算失败；低于地板的亚毫秒变化不判回归。');

if (firstRun) {
  console.log(`\n首次运行：基线已写入 ${path.relative(ROOT, BASELINE_FILE)}，再次运行将进行回归判定。`);
} else if (!envOk) {
  console.log('\n环境指纹与基线不一致（Node / 平台 / 架构 / CPU 任一不同），已跳过 PASS/FAIL。');
  console.log('如需在当前环境建立基线：npm run bench -- --update-baseline');
} else if (process.exitCode === 1) {
  console.log('\n检测到性能回归（存在 SLOWER 项），见上表判定列。');
} else {
  console.log('\n与基线对比：无回归。');
}

globalThis.__benchSink = sink;
dom.window.close();
