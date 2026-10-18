import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CodexSessionAdapter, rolloutLines } from '../sessions/codex-adapter.js';
import { SessionError } from '../sessions/types.js';
import { codexMessage, projectRecord, reconstructCodexHistory, survivingRecords, type HistoryRecord } from './codex-history.js';
import { readCodexTrace } from './codex-trace.js';
import { localFile } from './files.js';
import { estimateTokens, preview } from './tokens.js';
import type { ContextOptions, HistoryMessage, HistoryResult } from './types.js';

type Source = Awaited<ReturnType<CodexSessionAdapter['contextSource']>>;
type Parsed = { records: HistoryRecord[]; notes: string[] };
const caches = new WeakMap<CodexSessionAdapter, Map<string, Parsed>>();

async function parse(adapter: CodexSessionAdapter, source: Source): Promise<Parsed> {
  let cache = caches.get(adapter);
  if (!cache) { cache = new Map(); caches.set(adapter, cache); }
  const key = JSON.stringify(source.files.map(f => [f.file, f.size, f.mtime, f.identity]));
  // 缓存命中前仍核对文件身份；不返回已替换文件的旧预览与定位。
  for (const file of source.files) {
    const name = await localFile(path.join(source.codexHome, 'sessions'), file.file);
    const st = await fs.stat(name);
    if (st.size !== file.size || st.mtimeMs !== file.mtime || `${st.dev}:${st.ino}:${st.birthtimeMs}` !== file.identity)
      throw new SessionError(409, '会话正在变化，请刷新后重试');
  }
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const records: HistoryRecord[] = [], notes: string[] = [];
  for (const file of source.files) {
    const turns = new Map(file.turns.map(t => [t.offset, t.turn]));
    if (!file.lastOffset) continue;
    for await (const line of rolloutLines(file.file, 0, file.lastOffset)) {
      if (!line.text) { notes.push('rollout 含超过 4 MiB 的行，正文不可用。'); continue; }
      let raw: unknown;
      try { raw = JSON.parse(line.text); } catch { notes.push('rollout 含损坏或未完成记录，已跳过。'); continue; }
      const record = await projectRecord(raw, { file: file.file, offset: line.offset });
      record.indexedTurn = turns.get(line.offset);
      records.push(record);
    }
  }
  const value = { records, notes: [...new Set(notes)] };
  // 小 LRU 只缓存投影；超大线程仍流式处理，但不留驻缓存。
  if (Buffer.byteLength(JSON.stringify(value)) <= 4 * 1024 * 1024) {
    cache.set(key, value);
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  return value;
}

async function currentInstructions(home: string, dataDir: string | undefined): Promise<HistoryMessage[]> {
  async function read(root: string, file: string): Promise<string | undefined> {
    try {
      const handle = await fs.open(await localFile(root, file), 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 256 * 1024) return undefined;
        const bytes = Buffer.alloc(info.size);
        await handle.read(bytes, 0, bytes.length, 0);
        return bytes.toString('utf8');
      } finally { await handle.close(); }
    } catch { return undefined; }
  }
  let managed = await read(home, path.join(home, 'AGENTS.md'));
  const custom = dataDir ? await read(dataDir, path.join(dataDir, 'prompts', 'codex.md')) : undefined;
  // 生成的 AGENTS.md 已包含 custom，避免重复收费；变化期间保留磁盘事实并注明当前态。
  if (managed && custom && managed.endsWith(custom)) managed = managed.slice(0, -custom.length).trimEnd();
  const messages: HistoryMessage[] = [];
  for (const [kind, text] of [['managed_instructions', managed], ['custom_instructions', custom]]) {
    if (!text) continue;
    const message = await codexMessage({ type: 'message', role: 'developer', content: text }, { kind, provenance: 'reconstructed' });
    if (message) messages.push(message);
  }
  return messages;
}

export async function codexHistory(adapter: CodexSessionAdapter, session: string, turn: string, phase: 'before' | 'after', options: ContextOptions): Promise<HistoryResult> {
  const source = await adapter.contextSource(session), parsed = await parse(adapter, source), records = parsed.records;
  const start = records.findIndex(r => r.indexedTurn === turn);
  if (turn && start < 0) throw new SessionError(404, '回合不存在');
  const next = start < 0 ? -1 : records.findIndex((r, i) => i > start && !!r.indexedTurn);
  let end = next < 0 ? records.length : next;
  // 下一回合的 task_started/上下文前缀不能泄入前一回合 after。
  if (next >= 0) {
    const boundary = records.findIndex((r, i) => i > start && i <= next && (r.event === 'task_started' || r.event === 'turn_started'));
    if (boundary >= 0) end = boundary;
  }
  let cut = end;
  if (phase === 'before' && start >= 0) {
    const response = records.findIndex((r, i) => i > start && i < end && (r.messages?.some(m =>
      m.role === 'assistant' || m.kind === 'thinking' || m.kind === 'tool_call' || m.kind === 'tool_result') || !!r.usage));
    cut = response >= 0 ? response : end;
  }
  const prefix = records.slice(0, cut), notes = [...parsed.notes];
  let messages = await reconstructCodexHistory(prefix);
  const surviving = survivingRecords(prefix);
  const withinTurn = records.slice(Math.max(0, start), end);
  let turnId = withinTurn.find(r => r.turnId)?.turnId;
  if (!turnId && start >= 0) turnId = records.slice(0, start).findLast(r => r.turnId)?.turnId;
  const home = options.codexHome ?? source.codexHome;
  const trace = await readCodexTrace(home, session, turnId, phase);
  // 压缩或回滚若在最后请求之后发生，trace 的请求不再代表 after 窗口。
  const invalidated = trace && phase === 'after' && prefix.some(r =>
    (r.type === 'compacted' || r.event === 'thread_rolled_back') && (r.ts === undefined || r.ts >= trace.at));
  let measured: HistoryResult['measured'];
  if (trace && !invalidated) {
    const byId = new Map(messages.filter(m => m.id).map(m => [m.id, m]));
    const byCall = new Map(messages.filter(m => m.callId).map(m => [`${m.kind}:${m.callId}`, m]));
    messages = trace.messages.map(m => ({ ...m, location: (m.id ? byId.get(m.id) : undefined)?.location
      ?? (m.callId ? byCall.get(`${m.kind}:${m.callId}`) : undefined)?.location }));
    if (phase === 'after' && trace.completed !== undefined) {
      const tail = prefix.filter(r => (r.ts ?? 0) > trace.completed!).flatMap(r => r.messages ?? []);
      messages.push(...tail.filter(m => !messages.some(other => m.id && other.id === m.id)));
    }
    measured = trace.measured; notes.push(...trace.notes);
  } else {
    notes.push('官方 trace 不可用：未找到匹配请求、布局未知、载荷不完整，或请求后已压缩/回滚；当前窗口按 rollout 重建。');
    const instructions = await currentInstructions(home, options.dataDir ?? source.dataDir);
    const baseline = surviving.findLast(r => r.baseline)?.baseline;
    // 已落盘的 AGENTS 注入优先，避免把当前提示与其历史版本重复估算。
    const hasManaged = messages.some(m => m.contextual && m.role === 'user' && m.preview.startsWith('# AGENTS.md'));
    messages = [...(baseline ? [baseline] : []), ...(!hasManaged ? instructions : []), ...messages];
    notes.push(hasManaged ? '受管指令已由 rollout 的 AGENTS 注入记录提供。'
      : '受管 AGENTS.md 与 codex.md 使用当前磁盘版本重建，可能与回合当时不同；缺失文件不计为零。');
    const tools = [...prefix.findLast(r => r.tools)?.tools ?? []];
    const names = new Set(tools.map(m => m.toolName));
    for (const name of prefix.flatMap(r => r.messages ?? []).map(m => m.toolName).filter((x): x is string => !!x)) {
      if (names.has(name)) continue;
      names.add(name); const count = await estimateTokens(name, 'tool');
      tools.push({ kind: 'tool_definition', category: 'tools', provenance: 'estimated', toolName: name,
        preview: preview(name), tokens: { estimated: count.tokens } });
    }
    messages = [...tools, ...messages];
    notes.push('工具定义仅由已观察到的工具名和 thread_settings_applied 列表估算，未记录的完整 schema 不可用。');
  }
  if (!measured) {
    // before 的实测在首次响应后才落盘；after 优先该边界之后最近一次，缺失再取此前最后一次。
    let at = records.findIndex((r, i) => i >= cut && !!r.usage);
    if (at < 0) at = records.findLastIndex((r, i) => i < cut && !!r.usage);
    const usage = records[at]?.usage;
    if (usage) {
      const usageTurn = records.slice(0, at + 1).findLast(r => r.indexedTurn)?.indexedTurn;
      const rewritten = records.slice(Math.min(at + 1, cut), Math.max(at + 1, cut))
        .some(r => r.type === 'compacted' || r.event === 'thread_rolled_back');
      measured = { ...usage, at: records[at].ts ?? 0, stale: usageTurn !== turn || rewritten, source: 'codex.token_count.last_token_usage' };
    }
  }
  const originalItems = new Map(prefix.flatMap(r => r.messages ?? []).filter(m => m.id).map(m => [m.id, m]));
  // replacement_history 保留了原始 item ID 时，仍能定位到 O1 的原始内容块。
  messages = messages.map(m => ({ ...m, location: m.location ?? (m.id ? originalItems.get(m.id)?.location : undefined) }));
  for (const m of messages) if (m.location) {
    const blockKind = m.kind === 'system' || m.kind === 'developer' ? 'system_change' : m.kind;
    m.ref = await adapter.contextRef(session, m.location.file, m.location.offset, blockKind);
  }
  const window = surviving.findLast(r => r.window)?.window;
  return { messages, measured, notes, window: window ? { tokens: window, source: 'codex.rollout.model_context_window' } : undefined };
}
