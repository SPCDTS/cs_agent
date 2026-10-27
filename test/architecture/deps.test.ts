import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LAYERS = { shared: 0, config: 1, sidecar: 1, media: 2, channel: 3, qq: 4, context: 5, agent: 6, obs: 7, mcp: 8, main: 9 } as const;
type Package = keyof typeof LAYERS;
type Edge = [from: string, to: string];

/** P2 已清空例外；保留过期与重复检查，禁止后续按包豁免。 */
const ALLOWED_EXCEPTIONS: Array<[from: string, to: string]> = [];

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
  if (['agent', 'context', 'obs', 'mcp'].includes(a) && b === 'qq') reasons.push('上层不可依赖 qq 实现');
  if (a === 'channel' && ['qq', 'context', 'agent'].includes(b)) reasons.push('channel 不可依赖通道实现或上层');
  if (a === 'sidecar' && b !== 'shared' && !to.startsWith(path.posix.dirname(from) + '/')) reasons.push('sidecar 只依赖 shared 与本目录');
  if (b === 'sidecar' && a !== 'sidecar') reasons.push('其他包不可依赖 sidecar');
  if (a === 'media' && ['channel', 'qq'].includes(b)) reasons.push('media 不可依赖 channel 或 qq');
  if (from.startsWith('src/obs/ui/') && !to.startsWith('src/obs/ui/') && b !== 'shared' &&
      !['src/obs/sessions/types.ts', 'src/obs/memory/types.ts', 'src/obs/context/types.ts',
        // P0 第 6 项明确要求 scopeLabel 归 context；这是 §1 UI 白名单的必要补充。
        'src/context/access.ts'].includes(to)) reasons.push('UI 依赖了非契约模块');
  if (/^src\/obs\/(memory|sessions|context)\//.test(from) &&
      (to.startsWith('src/obs/ui/') || to === 'src/obs/http.ts')) reasons.push('观测子层反向依赖 UI/HTTP 入口');
  if (from.startsWith('src/obs/sessions/') && to.startsWith('src/obs/context/')) reasons.push('sessions 反向依赖 context');
  if (['src/agent/backends/types.ts', 'src/agent/backends/select.ts'].includes(from) && b === 'agent' &&
      !to.endsWith('/types.ts')) reasons.push('后端接口/选择器依赖实现文件');
  // 记忆层（docs/MEMORY-DESIGN.md §3）：存储只依赖 shared 与本目录，与消息库互不 import；服务不依赖任何后端实现。
  if (from.startsWith('src/context/memory/') && !to.startsWith('src/context/memory/') && b !== 'shared') reasons.push('context/memory 只依赖 shared 与本目录');
  if (b === 'context' && a === 'context' && !from.startsWith('src/context/memory/') && to.startsWith('src/context/memory/')) reasons.push('消息库不依赖记忆库');
  if (from.startsWith('src/agent/memory/') && /^src\/agent\/(backends|pi-tools|pi-mcp|codex)\//.test(to)) reasons.push('记忆服务不依赖后端实现');
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
    ['src/sidecar/gmail/new.ts', 'src/config.ts'],
    ['src/sidecar/gmail/new.ts', 'src/agent/pi-mcp/schema.ts'],
    ['src/sidecar/gmail/new.ts', 'src/sidecar/other/new.ts'],
    ['src/main.ts', 'src/sidecar/gmail/main.ts'],
    ['src/agent/new.ts', 'src/sidecar/gmail/server.ts'],
    ['src/media/new.ts', 'src/qq/image.ts'],
    ['src/media/new.ts', 'src/qq/types.ts'],
    ['src/media/new.ts', 'src/channel/types.ts'],
    ['src/channel/new.ts', 'src/qq/types.ts'],
    ['src/channel/new.ts', 'src/context/access.ts'],
    ['src/channel/new.ts', 'src/agent/tasks.ts'],
    ['src/agent/new.ts', 'src/qq/types.ts'],
    ['src/context/new.ts', 'src/qq/onebot.ts'],
    ['src/obs/new.ts', 'src/qq/bridge.ts'],
    ['src/mcp/new.ts', 'src/qq/policy.ts'],
    ['src/obs/ui/new.ts', 'src/obs/store.ts'],
    ['src/obs/memory/new.ts', 'src/obs/ui/html.ts'],
    ['src/obs/sessions/new.ts', 'src/obs/context/types.ts'],
    ['src/agent/backends/select.ts', 'src/agent/backends/codex.ts'],
    ['src/context/memory/store.ts', 'src/context/store.ts'],
    ['src/context/memory/store.ts', 'src/context/access.ts'],
    ['src/context/memory/new.ts', 'src/agent/memory/service.ts'],
    ['src/context/store.ts', 'src/context/memory/store.ts'],
    ['src/agent/memory/new.ts', 'src/agent/pi-tools/memory.ts'],
    ['src/agent/memory/new.ts', 'src/agent/codex/runner.ts'],
    ['src/agent/memory/new.ts', 'src/agent/backends/pi.ts'],
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

  it('记忆层两个目录存在，且实际依赖符合层级：context/memory 只到 shared，agent/memory 只到 context 与 agent 的非后端模块', () => {
    const memoryEdges = edges.filter(([from]) => from.startsWith('src/context/memory/') || from.startsWith('src/agent/memory/'));
    expect(sourceFiles.filter(f => f.startsWith('src/context/memory/'))).toEqual(['src/context/memory/profile.ts', 'src/context/memory/store.ts', 'src/context/memory/types.ts']);
    expect(sourceFiles.filter(f => f.startsWith('src/agent/memory/'))).toEqual(['src/agent/memory/consolidate.ts', 'src/agent/memory/extractor.ts', 'src/agent/memory/render.ts', 'src/agent/memory/service.ts', 'src/agent/memory/tools.ts']);
    // 回合后抽取不改画像、不发消息（docs/MEMORY-DESIGN.md §8.0）：不依赖画像存储与发送服务
    expect(edges.filter(([from, to]) => from === 'src/agent/memory/extractor.ts' &&
      (to === 'src/context/memory/profile.ts' || to === 'src/agent/send-service.ts' || packageOf(to) === 'qq')).map(edgeKey)).toEqual([]);
    // 夜间整理（§9）不发消息、不直接读消息库：来源是否尚存经 main 注入的 messageExists 查询
    expect(edges.filter(([from, to]) => from === 'src/agent/memory/consolidate.ts' &&
      (to === 'src/agent/send-service.ts' || to === 'src/context/store.ts' || packageOf(to) === 'qq' || packageOf(to) === 'channel')).map(edgeKey)).toEqual([]);
    for (const [from, to] of memoryEdges) {
      const ok = from.startsWith('src/context/memory/') ? to.startsWith('src/context/memory/') || packageOf(to) === 'shared'
        : ['shared', 'channel', 'context', 'agent'].includes(packageOf(to)) && !violations([from, to]).length;
      expect(ok, `${from} → ${to}`).toBe(true);
    }
    // 两个后端都只经 agent/memory 使用记忆（mcp 层只取工具契约）；运行时设置只取命名空间校验
    expect(edges.filter(([from, to]) => to.startsWith('src/context/memory/') && !/^src\/(context|agent)\/memory\//.test(from) && from !== 'src/main.ts' && !from.startsWith('src/obs/')
      && !(from === 'src/agent/settings.ts' && to === 'src/context/memory/types.ts'))
      .map(edgeKey)).toEqual([]);
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

  it('HTTP 组合入口不超过 300 行', () => {
    const lines = readFileSync(path.join(ROOT, 'src/obs/http.ts'), 'utf8').trimEnd().split('\n').length;
    expect(lines).toBeLessThanOrEqual(300);
  });

  it('设计层级的包间依赖没有环', () => {
    const graph = new Map<Package, Set<Package>>();
    for (const [from, to] of edges) {
      const a = packageOf(from), b = packageOf(to);
      if (a === b) continue;
      if (!graph.has(a)) graph.set(a, new Set());
      graph.get(a)!.add(b);
    }
    const done = new Set<Package>();
    const visit = (name: Package, trail: Package[]) => {
      if (trail.includes(name)) throw new Error('分层包依赖环：' + [...trail, name].join(' → '));
      if (done.has(name)) return;
      for (const target of graph.get(name) ?? []) visit(target, [...trail, name]);
      done.add(name);
    };
    for (const name of graph.keys()) visit(name, []);
  });

  it('记录物理目录双向依赖数，保留 P0 的 10 对上限', () => {
    // 与设计现状统计同口径：物理目录为包（含 obs 子目录、agent/backends 等），根文件归根目录。
    const packages = new Set(edges.filter(([from, to]) => path.posix.dirname(from) !== path.posix.dirname(to))
      .map(([from, to]) => `${path.posix.dirname(from)} → ${path.posix.dirname(to)}`));
    const cycles = [...packages].flatMap(edge => {
      const [from, to] = edge.split(' → ');
      return from < to && packages.has(`${to} → ${from}`) ? [`${from} ↔ ${to}`] : [];
    }).sort();
    console.info(`物理目录双向依赖：${cycles.length} 对\n${cycles.join('\n')}`);
    expect(cycles.length, cycles.join('\n')).toBeLessThanOrEqual(10);
  });
});
