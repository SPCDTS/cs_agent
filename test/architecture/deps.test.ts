import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LAYERS = { shared: 0, config: 1, media: 2, qq: 3, context: 4, agent: 5, obs: 6, mcp: 7, main: 8 } as const;
type Package = keyof typeof LAYERS;
type Edge = [from: string, to: string];

/** 只放 P2 尚未消除的具体文件边；禁止按整个包豁免新增依赖。 */
const ALLOWED_EXCEPTIONS: Array<[from: string, to: string]> = [
  // P2：后端契约、配置解析与观察者接口。
  ['src/obs/ui/memory-pages.ts', 'src/context/aging.ts'],
];

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(file) : entry.isFile() && file.endsWith('.ts') ? [file] : [];
  }).sort();
}

/** 先遮蔽注释和字符串内容，再匹配声明及静态 import()，避免把 HTML/示例文本当作依赖。 */
function imports(text: string): string[] {
  const strings: string[] = [], result = new Set<string>();
  const masked = text.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, token => {
    if (token.startsWith('/')) return ' ';
    const value = token.slice(1, -1);
    strings.push(token.startsWith('`') && value.includes('${') ? '' : value);
    return `__module_string_${strings.length - 1}__`;
  });
  const pattern = /\b(?:import|export)\s+(?:[\w$*{},\s]+?\s+from\s+)?__module_string_(\d+)__|\bimport\s*\(\s*__module_string_(\d+)__\s*[,)]/g;
  for (const match of masked.matchAll(pattern)) {
    const value = strings[Number(match[1] ?? match[2])];
    if (value.startsWith('.')) result.add(value);
  }
  return [...result];
}

function packageOf(file: string): Package {
  if (file === 'src/config.ts') return 'config';
  if (file === 'src/main.ts') return 'main';
  // 根目录的文件系统探测是底层工具，P0 未要求搬动其路径。
  if (file === 'src/fs-check.ts') return 'shared';
  const name = file.split('/')[1];
  if (name in LAYERS) return name as Package;
  throw new Error(`未归层的源文件：${file}`);
}

function violations([from, to]: Edge): string[] {
  const a = packageOf(from), b = packageOf(to), reasons: string[] = [];
  if (a !== b && LAYERS[b] > LAYERS[a]) reasons.push('跨包向上依赖');
  if (a === 'media' && b === 'qq') reasons.push('media 不可依赖 qq');
  if (from.startsWith('src/obs/ui/') && !to.startsWith('src/obs/ui/') && b !== 'shared' &&
      !['src/obs/sessions/types.ts', 'src/obs/memory/types.ts', 'src/obs/context/types.ts',
        // P0 第 6 项明确要求 scopeLabel 归 context；这是 §1 UI 白名单的必要补充。
        'src/context/access.ts'].includes(to)) reasons.push('UI 依赖了非契约模块');
  if (/^src\/obs\/(memory|sessions|context)\//.test(from) &&
      (to.startsWith('src/obs/ui/') || to === 'src/obs/http.ts')) reasons.push('观测子层反向依赖 UI/HTTP 入口');
  if (from.startsWith('src/obs/sessions/') && to.startsWith('src/obs/context/')) reasons.push('sessions 反向依赖 context');
  if (['src/agent/backends/types.ts', 'src/agent/backends/select.ts'].includes(from) && b === 'agent' &&
      !to.endsWith('/types.ts')) reasons.push('后端接口/选择器依赖实现文件');
  return reasons;
}

const sourceFiles = files('src'), sourceSet = new Set(sourceFiles), edges: Edge[] = [], unresolved: string[] = [];
for (const from of sourceFiles) {
  packageOf(from);
  const targets = new Set<string>();
  for (const specifier of imports(readFileSync(path.join(ROOT, from), 'utf8'))) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    const to = [base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`].find(candidate => sourceSet.has(candidate));
    if (to) targets.add(to); else unresolved.push(`${from} → ${specifier}`);
  }
  for (const to of targets) edges.push([from, to]);
}

const edgeKey = ([from, to]: Edge) => `${from} → ${to}`;
const badEdges = edges.filter(edge => violations(edge).length);
const exceptions = new Set(ALLOWED_EXCEPTIONS.map(edgeKey));

describe('包结构与分层', () => {
  it('扫描静态导入、重导出和 import()，类型边与值边一致', () => {
    expect(imports(`
      import type { A } from './types.js';
      import { B,
        C } from './values.js';
      import './init.js';
      export type { D } from './exports.js';
      export * from './all.js';
      const lazy = import('./lazy.js');
      type E = import('./type-query.js').E;
      const computed = import(variable);
      // import { Fake } from './comment.js';
      const text = "import('./text.js')";
      import { readFile } from 'node:fs';
    `)).toEqual(['./types.js', './values.js', './init.js', './exports.js', './all.js', './lazy.js', './type-query.js']);
  });

  it('所有相对路径都解析到 src 中的文件', () => {
    expect(unresolved, unresolved.join('\n')).toEqual([]);
  });

  it.each<Edge>([
    ['src/shared/new.ts', 'src/config.ts'],
    ['src/media/new.ts', 'src/qq/image.ts'],
    ['src/media/new.ts', 'src/qq/types.ts'],
    ['src/obs/ui/new.ts', 'src/obs/store.ts'],
    ['src/obs/memory/new.ts', 'src/obs/ui/html.ts'],
    ['src/obs/sessions/new.ts', 'src/obs/context/types.ts'],
    ['src/agent/backends/select.ts', 'src/agent/backends/codex.ts'],
  ])('拒绝新增的违规边 %s → %s', (from, to) => {
    expect(violations([from, to]).length).toBeGreaterThan(0);
    expect(exceptions.has(edgeKey([from, to]))).toBe(false);
  });

  it('跨包方向与 obs/agent/media 内部分层遵守设计', () => {
    const unexpected = badEdges.filter(edge => !exceptions.has(edgeKey(edge)))
      .map(edge => `${edgeKey(edge)}：${violations(edge).join('；')}`);
    expect(unexpected, `未获准的依赖：\n${unexpected.join('\n')}`).toEqual([]);
  });

  it('每条例外仍存在且仍违反规则，消除后必须同步删去', () => {
    const remaining = new Set(badEdges.map(edgeKey));
    const stale = ALLOWED_EXCEPTIONS.filter(edge => !remaining.has(edgeKey(edge))).map(edgeKey);
    expect(exceptions.size, '例外不可重复').toBe(ALLOWED_EXCEPTIONS.length);
    expect(stale, `过期例外：\n${stale.join('\n')}`).toEqual([]);
  });

  it('P0 清除的边不能通过临时例外重新引入', () => {
    const forbidden = edges.filter(([from, to]) =>
      (from.startsWith('src/shared/') && !to.startsWith('src/shared/')) ||
      (from.startsWith('src/qq/') && /src\/(agent|context|obs|mcp)\//.test(to)) ||
      (from.startsWith('src/obs/sessions/') && (to.startsWith('src/obs/context/') || to === 'src/obs/http.ts')) ||
      (from.startsWith('src/obs/') && to.startsWith('src/mcp/')) ||
      (from === 'src/obs/store.ts' && to.startsWith('src/obs/memory/')));
    expect(forbidden.map(edgeKey)).toEqual([]);
  });

  it('shared 内部没有文件级依赖环', () => {
    const graph = new Map<string, string[]>();
    for (const [from, to] of edges.filter(([from]) => from.startsWith('src/shared/'))) {
      graph.set(from, [...(graph.get(from) ?? []), to]);
    }
    const done = new Set<string>();
    const visit = (file: string, trail: string[]) => {
      if (trail.includes(file)) throw new Error(`shared 依赖环：${[...trail, file].join(' → ')}`);
      if (done.has(file)) return;
      for (const target of graph.get(file) ?? []) visit(target, [...trail, file]);
      done.add(file);
    };
    for (const file of graph.keys()) visit(file, []);
  });

  it('记录包级双向依赖数，P0 不超过 10 对', () => {
    // 与设计现状统计同口径：物理目录为包（含 obs 子目录、agent/backends 等），根文件归根目录。
    const packages = new Set(edges.filter(([from, to]) => path.posix.dirname(from) !== path.posix.dirname(to))
      .map(([from, to]) => `${path.posix.dirname(from)} → ${path.posix.dirname(to)}`));
    const cycles = [...packages].flatMap(edge => {
      const [from, to] = edge.split(' → ');
      return from < to && packages.has(`${to} → ${from}`) ? [`${from} ↔ ${to}`] : [];
    }).sort();
    console.info(`P0 包级环：${cycles.length} 对\n${cycles.join('\n')}`);
    expect(cycles.length, cycles.join('\n')).toBeLessThanOrEqual(10);
  });
});
