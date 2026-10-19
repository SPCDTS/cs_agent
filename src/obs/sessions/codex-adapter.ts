import { isThreadKey } from "../../agent/codex/runner.js";
import { createReadStream, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseRolloutTokenUsage } from '../../agent/codex/context-usage.js';
import { log } from '../../shared/log.js';
import { redactText } from '../../shared/redact.js';
import type { ObsStore } from '../store.js';
import { contentSlice, inlineBlock, redactSessionValue, validRange } from './content.js';
import { enrichTurns } from './enrichment.js';
import { SessionIndex, type SessionIndexFile, type IndexedBlock, type IndexedTurn } from './session-index.js';
import { SessionError, type Block, type BlockFrame, type ContentRef, type SessionAdapter, type SessionFilter, type SessionRef, type Usage } from './types.js';

export const MAX_ROLLOUT_LINE_BYTES = 4 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const safeText = (text: string): string => redactText(text, Number.MAX_SAFE_INTEGER);
const timestamp = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => {
    const p = object(part); return string(p?.text) ?? (p?.type === 'image' || p?.type === 'input_image' ? '[图片]' : '');
  }).filter(Boolean).join('\n');
  return value === undefined ? '' : JSON.stringify(value);
};
/** 工具的字符串参数常是 JSON，需先按字段遮蔽嵌套凭据，再做统一文本脱敏。 */
const toolText = (value: unknown): string => {
  const text = textOf(value);
  try { return JSON.stringify(redactSessionValue(JSON.parse(text))); }
  catch { return safeText(text); }
};

type Line = { offset: number; length: number; end: number; text?: string; oversized?: boolean; partial?: boolean };
/** 64 KiB 读取；超限单行只计字节，不累积字符串。末尾半行留给下一次扫描。 */
export async function* rolloutLines(file: string, start = 0, end?: number): AsyncGenerator<Line> {
  let offset = start, length = 0, chunks: Buffer[] = [], oversized = false;
  const input = createReadStream(file, { start, ...(end !== undefined ? { end: end - 1 } : {}), highWaterMark: 64 * 1024 });
  try {
    for await (const raw of input) {
      const chunk = raw as Buffer;
      let begin = 0;
      for (let i = 0; i <= chunk.length; i++) {
        if (i < chunk.length && chunk[i] !== 10) continue;
        const part = chunk.subarray(begin, i);
        length += part.length;
        if (length > MAX_ROLLOUT_LINE_BYTES) { oversized = true; chunks = []; }
        else if (part.length && !oversized) chunks.push(part);
        if (i < chunk.length) {
          const next = offset + length + 1;
          yield { offset, length, end: next, ...(oversized ? { oversized: true } : { text: Buffer.concat(chunks, length).toString('utf8').replace(/\r$/, '') }) };
          offset = next; length = 0; chunks = []; oversized = false;
        }
        begin = i + 1;
      }
    }
    if (length) yield { offset, length, end: offset + length, partial: true,
      ...(oversized ? { oversized: true } : { text: Buffer.concat(chunks, length).toString('utf8').replace(/\r$/, '') }) };
  } finally { input.destroy(); }
}

/** Codex 将指令和运行环境也写成 user 消息；按文本前缀识别，不能据角色分轮。 */
function inputContextType(text: string): 'agents_md' | 'user_instructions' | 'environment_context' | 'marker' | undefined {
  if (text.startsWith('# AGENTS.md instructions')) return 'agents_md';
  if (text.startsWith('<user_instructions>')) return 'user_instructions';
  if (text.startsWith('<environment_context>')) return 'environment_context';
  if (text.startsWith('<turn_aborted>')) return 'marker';
  return undefined;
}

/** 纯解析便于正文重读；不保留 reasoning 的加密体或内部思考正文。 */
function recordBlocks(row: Record<string, unknown>): Block[] {
  const p = object(row.payload) ?? row;
  const ts = timestamp(row.timestamp);
  const base = ts === undefined ? {} : { ts };
  const type = string(p.type);
  if (row.type === 'compacted' || row.type === 'compaction' || type === 'context_compacted' || type === 'compaction') {
    return [{ ...base, kind: 'compaction', text: textOf(p.message ?? p.summary ?? p.text),
      meta: { replacement_history: Array.isArray(p.replacement_history), ...(p.reason ? { reason: p.reason } : {}) } }];
  }
  if (row.type === 'session_meta' || row.type === 'turn_context') {
    const text = string(p.base_instructions) ?? string(object(p.base_instructions)?.text);
    return text ? [{ ...base, kind: 'system_change', text }] : [];
  }
  if (row.type === 'event_msg') {
    if (['turn_aborted', 'error', 'turn.failed'].includes(type ?? '')) return [{ ...base, kind: 'event', text: textOf(p.message ?? p.error ?? type), meta: { type, status: 'failed' } }];
    return [];
  }
  if (row.type !== 'response_item') return [];
  if (type === 'message') {
    const role = p.role;
    if (!['user', 'assistant', 'system', 'developer'].includes(String(role))) return [];
    const text = textOf(p.content);
    const contextType = role === 'user' ? inputContextType(text) : undefined;
    const kind: Block['kind'] = role === 'user' && !contextType ? 'user' : role === 'assistant' ? 'assistant' : 'system_change';
    const items: Block[] = [{ ...base, kind, text,
      ...(p.phase || contextType ? { meta: { ...(p.phase ? { phase: p.phase } : {}), ...(contextType ? { type: contextType } : {}) } } : {}) }];
    for (const part of Array.isArray(p.content) ? p.content : []) {
      const value = object(part);
      if (!['input_image', 'image', 'image_url'].includes(String(value?.type))) continue;
      const url = string(value?.image_url) ?? string(value?.url);
      items.push({ ...base, kind: 'image', text: '[图片]', meta: { source: url?.startsWith('data:') ? '[内嵌图片]' : url ?? '[图片引用]' } });
    }
    return items;
  }
  if (type === 'reasoning') return [{ ...base, kind: 'thinking', text: textOf(p.summary),
    ...(p.encrypted_content ? { meta: { unavailable: true } } : {}) }];
  if (['function_call', 'custom_tool_call', 'mcp_tool_call'].includes(type ?? '')) {
    const callId = string(p.call_id) ?? string(p.id);
    const name = string(p.name) ?? string(p.tool);
    const server = string(p.server) ?? (name?.startsWith('mcp__') ? name.split('__')[1] : undefined);
    const call: Block = { ...base, kind: 'tool_call', ...(callId ? { callId } : {}), text: toolText(p.arguments ?? p.input),
      meta: { name, ...(server ? { server } : {}), status: p.status ?? 'running' } };
    const result = p.result ?? p.output;
    return result === undefined ? [call] : [call, { ...base, kind: 'tool_result', ...(callId ? { callId } : {}), text: toolText(result), meta: { status: p.error ? 'failed' : 'ok' } }];
  }
  if (['function_call_output', 'custom_tool_call_output', 'mcp_tool_call_output'].includes(type ?? '')) {
    const callId = string(p.call_id) ?? string(p.id);
    return [{ ...base, kind: 'tool_result', ...(callId ? { callId } : {}), text: toolText(p.output ?? p.result),
      meta: { status: p.error || p.is_error ? 'failed' : 'ok' } }];
  }
  return [];
}

type Mapping = { scope: string; label: string; status: SessionRef['status'] };
export interface CodexSessionAdapterOptions { store: ObsStore; codexHome: string; dataDir: string; pollMs?: number }

export class CodexSessionAdapter implements SessionAdapter {
  readonly progress = { indexing: false, files: 0, done: 0 };
  /** 测试及运行诊断：仅统计流式解析字节，边界指纹不算重新扫描。 */
  readonly diagnostics = { scannedBytes: 0, fullScans: 0, incrementalScans: 0 };
  private readonly index?: SessionIndex;
  private readonly files = new Map<string, SessionIndexFile>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Map<string, Set<(frame: BlockFrame) => void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private closed = false;
  constructor(private readonly opts: CodexSessionAdapterOptions) {
    if (!opts.store.degraded) {
      try {
        this.index = new SessionIndex(opts.store.db);
        for (const row of this.index.all('codex')) this.files.set(row.file, row);
      } catch (error) {
        this.index = undefined; this.files.clear();
        log.warn('codex 会话索引不可用，保留其它观测功能', { error: safeText(error instanceof Error ? error.message : String(error)) });
      }
    }
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, Math.max(10, opts.pollMs ?? 2000));
    this.timer.unref();
    void this.refresh().catch(() => undefined);
  }
  refresh(): Promise<void> {
    if (this.closed || !this.index) return Promise.resolve();
    if (!this.refreshing) this.refreshing = this.scan().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async mapping(): Promise<Map<string, Mapping>> {
    const mappings = new Map<string, Mapping>();
    try {
      for await (const line of rolloutLines(path.join(this.opts.dataDir, 'codex-threads-archive.jsonl'))) {
        try {
          const row = object(JSON.parse(line.text ?? ''));
          if (typeof row?.thread_id === 'string' && typeof row.key === 'string') mappings.set(row.thread_id, { scope: row.key, label: row.key, status: 'archived' });
        } catch { /* 归档坏行不影响其它条目。 */ }
      }
    } catch { /* 首次启动没有归档。 */ }
    try {
      const document = object(JSON.parse(await fs.readFile(path.join(this.opts.dataDir, 'codex-threads.json'), 'utf8')));
      for (const key of Object.keys(document ?? {}).filter(isThreadKey)) {
        const row = object(document?.[key]);
        if (typeof row?.thread_id === 'string') mappings.set(row.thread_id, { scope: key, label: key, status: 'active' });
      }
    } catch { /* 映射缺失仍然展示 rollout 中的真实会话。 */ }
    return mappings;
  }
  private async discover(directory: string): Promise<string[]> {
    const found: string[] = [];
    const root = await fs.lstat(directory).catch(() => undefined);
    if (!root?.isDirectory() || root.isSymbolicLink()) return found;
    const visit = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(file);
      }
    };
    await visit(directory);
    return found.sort();
  }
  private async fingerprint(file: string, size: number, opened?: FileHandle): Promise<{ head: string; tail: string }> {
    const handle = opened ?? await fs.open(file, 'r');
    try {
      const length = Math.min(size, 4096);
      const hashAt = async (position: number) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
      };
      return { head: await hashAt(0), tail: await hashAt(Math.max(0, size - length)) };
    } finally { if (!opened) await handle.close(); }
  }
  private async scan(): Promise<void> {
    this.progress.indexing = true; this.progress.done = 0;
    try {
      const [paths, mappings] = await Promise.all([this.discover(path.join(this.opts.codexHome, 'sessions')), this.mapping()]);
      this.progress.files = paths.length;
      const seen = new Set(paths);
      for (const [file] of this.files) if (!seen.has(file)) { this.files.delete(file); this.index!.remove(file); }
      for (const file of paths) {
        if (this.closed) break;
        try { await this.scanFile(file, mappings); }
        catch { /* 文件轮换或临时不可读，下次轮询重试；保留上次已完成索引。 */ }
        finally { this.progress.done++; }
      }
    } finally { this.progress.indexing = false; }
  }
  private async scanFile(file: string, mappings: Map<string, Mapping>): Promise<void> {
    const st = await fs.stat(file);
    const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
    const previous = this.files.get(file);
    if (previous && !this.dirty.has(file) && previous.size === st.size && previous.mtime === st.mtimeMs && previous.identity === identity) {
      const before = JSON.stringify(previous.session);
      this.applyMapping(previous, mappings);
      if (before !== JSON.stringify(previous.session)) this.index!.save(previous);
      return;
    }
    const boundary = previous && st.size > previous.size && previous.identity === identity ? await this.fingerprint(file, previous.size) : undefined;
    const incremental = !!(previous && !this.dirty.has(file) && boundary && boundary.head === previous.head && boundary.tail === previous.tail);
    const row: SessionIndexFile = incremental ? structuredClone(previous!) : {
      file, size: 0, mtime: 0, identity, head: '', tail: '', lastOffset: 0,
      session: { backend: 'codex', id: '', label: '', status: 'archived', started: 0, updated: 0, turns: 0 },
      state: { version: 4, turns: [], calls: {} },
    };
    const oldCounts = new Map(previous?.state.turns.map(turn => [turn.index.turn, turn.blocks.length]) ?? []);
    if (incremental) this.diagnostics.incrementalScans++; else this.diagnostics.fullScans++;
    if (st.size > row.lastOffset) for await (const line of rolloutLines(file, row.lastOffset, st.size)) {
      this.diagnostics.scannedBytes += line.end - line.offset;
      let parsed: Record<string, unknown> | undefined;
      if (!line.oversized) {
        try { parsed = object(JSON.parse(line.text ?? '')); }
        catch { if (line.partial) break; }
      } else if (line.partial) break;
      row.lastOffset = line.end;
      if (line.oversized) this.addBlocks(row, line, [{ kind: 'event', text: '行过大', meta: { bytes: line.length } }]);
      else if (parsed) this.consume(row, line, parsed);
    }
    // 空文件或未写完 session_meta 时暂不暴露伪造的会话 ID。
    if (!row.session.id) return;
    row.size = st.size; row.mtime = st.mtimeMs; row.identity = identity;
    Object.assign(row, await this.fingerprint(file, st.size));
    row.session.turns = row.state.turns.length;
    this.applyMapping(row, mappings);
    this.index!.save(row); this.files.set(file, row); this.dirty.delete(file);
    if (incremental && row.session.status === 'active' && this.listeners.has(row.session.id)) {
      for (const turn of row.state.turns) for (let i = oldCounts.get(turn.index.turn) ?? 0; i < turn.blocks.length; i++) {
        const block = await this.readBlock(row, turn.blocks[i]!);
        for (const listener of this.listeners.get(row.session.id) ?? []) { try { listener({ session: row.session.id, turn: turn.index.turn, block }); } catch { /* 订阅者互不影响。 */ } }
      }
    }
  }
  private applyMapping(row: SessionIndexFile, mappings: Map<string, Mapping>): void {
    const mapping = mappings.get(row.session.id);
    delete row.session.scope;
    Object.assign(row.session, mapping ?? { label: row.session.id, status: 'archived' });
  }
  private consume(row: SessionIndexFile, line: Line, record: Record<string, unknown>): void {
    const p = object(record.payload) ?? record;
    const ts = timestamp(record.timestamp) ?? row.session.updated;
    if (record.type === 'session_meta') {
      const id = string(p.id) ?? string(p.session_id);
      if (id) { row.session.id = id; row.session.started = timestamp(p.timestamp) ?? ts; row.session.label = id; }
    }
    row.session.updated = Math.max(row.session.updated, ts);
    const blocks = recordBlocks(record);
    if (record.type === 'session_meta' || record.type === 'turn_context') {
      if (record.type === 'turn_context') row.state.context = { model: string(p.model), effort: string(p.effort) ?? string(p.reasoning_effort) ?? string(object(object(p.collaboration_mode)?.settings)?.reasoning_effort) };
      this.addBlocks(row, line, blocks, undefined, true);
      return;
    }
    const user = blocks[0]?.kind === 'user';
    if (user) {
      const previous = row.state.turns.at(-1);
      if (previous && previous.index.status === 'running') { previous.index.status = 'ok'; previous.index.ended = ts; }
      row.state.pendingUsage = false;
      const turn = createHash('sha256').update(row.file).digest('hex').slice(0, 12) + '-' + line.offset;
      const prelude = row.state.prelude ?? [];
      row.state.prelude = undefined;
      row.state.turns.push({ index: { turn, started: ts, preview: redactText(blocks[0]?.text ?? '', 240), tools: prelude.filter(block => block.kind === 'tool_call').length, requests: 0, status: 'running' }, startOffset: line.offset, endOffset: line.end, blocks: prelude });
    }
    this.addBlocks(row, line, blocks);
    const turn = row.state.turns.at(-1);
    if (!turn || (blocks[0]?.kind === 'system_change' && turn.index.status !== 'running')) return;
    turn.endOffset = line.end;
    const parsedUsage = parseRolloutTokenUsage(record);
    if (parsedUsage) this.addUsage(row, turn, line, record, parsedUsage);
    if (record.type === 'event_msg') {
      const terminal = p.type === 'task_complete' || p.type === 'turn.completed' ? 'ok'
        : p.type === 'turn_aborted' || p.type === 'turn.failed' || p.type === 'error' ? 'failed' : undefined;
      if (terminal) {
        turn.index.ended = ts; turn.index.status = terminal;
        this.addBlocks(row, line, [{ kind: 'event', ts, text: terminal === 'ok' ? '回合完成' : '回合失败',
          meta: { type: terminal === 'ok' ? 'turn_complete' : 'turn_failed', status: terminal, ended: ts } }], terminal === 'ok' ? -4 : -5);
      }
    }
  }
  private addUsage(row: SessionIndexFile, turn: IndexedTurn, line: Line, record: Record<string, unknown>, usage: Usage): void {
    const p = object(record.payload) ?? record;
    const cumulative = object(object(p.info)?.total_token_usage);
    const signature = JSON.stringify(cumulative ?? object(p.thread_token_usage) ?? { ...usage, timestamp: record.timestamp });
    // 0.163 同时写 token_usage_record 与 token_count；后者复述同一份实测值。
    if (record.type === 'event_msg' && row.state.pendingUsage) { row.state.pendingUsage = false; row.state.lastUsageRecord = signature; return; }
    if (record.type === 'event_msg' && row.state.lastUsageRecord === signature) return;
    row.state.pendingUsage = record.type === 'token_usage_record'; row.state.lastUsageRecord = signature;
    const before = turn.index.usage;
    turn.index.usage = { input: (before?.input ?? 0) + usage.input, output: (before?.output ?? 0) + usage.output,
      ...(usage.cached !== undefined ? { cached: (before?.cached ?? 0) + usage.cached } : {}),
      ...(usage.reasoning !== undefined ? { reasoning: (before?.reasoning ?? 0) + usage.reasoning } : {}), measured: true };
    let request = turn.blocks.findLast(block => block.meta?.type === 'model_request' && block.meta.usage === undefined);
    if (!request) {
      this.addBlocks(row, line, [{ kind: 'event', ts: timestamp(record.timestamp), text: '模型请求', meta: { type: 'model_request', ...row.state.context } }], -2);
      request = turn.blocks.at(-1)!;
    }
    request.meta = { ...request.meta, usage, request: turn.index.requests };
    this.addBlocks(row, line, [{ kind: 'event', ts: timestamp(record.timestamp), text: '模型用量',
      meta: { type: 'model_usage', request: turn.index.requests, usage } }], -3);
  }
  private addBlocks(row: SessionIndexFile, line: Line, blocks: Block[], synthetic?: number, baseline = false): void {
    const previous = row.state.turns.at(-1);
    // 回合结束后的指令留到下一次真实用户输入；回合中的指令仍留在当前回合。
    const betweenTurns = previous?.index.status !== 'running' && blocks[0]?.kind === 'system_change';
    const turn = baseline || betweenTurns ? undefined : previous;
    const target = baseline ? (row.state.baselines ??= []) : turn?.blocks ?? (row.state.prelude ??= []);
    for (let item = 0; item < blocks.length; item++) {
      const block = blocks[item]!;
      if (turn && ['assistant', 'thinking', 'tool_call'].includes(block.kind)) {
        const request = target.findLast(candidate => candidate.meta?.type === 'model_request');
        if (!request || request.meta?.usage !== undefined) this.addBlocks(row, line, [{ kind: 'event', ts: block.ts,
          text: '模型请求', meta: { type: 'model_request', ...row.state.context } }], -2);
      }
      if (turn && block.meta?.type === 'model_request') {
        turn.index.requests++;
        block.meta.request = turn.index.requests;
      }
      const rawBytes = Buffer.byteLength(block.text ?? '');
      // 工具 JSON 可能已按字段遮蔽；容量取原始行，临时秘密注销后正文恢复长度仍落在同一块。
      const capacity = Math.max(16, line.length * 12, rawBytes * 12);
      const indexed: IndexedBlock = { lineOffset: line.offset, lineLength: line.length, item: synthetic ?? (line.oversized ? -1 : item),
        ...(line.text !== undefined ? { lineHash: createHash('sha256').update(line.text).digest('hex') } : {}),
        offset: this.index!.allocate(capacity), bytes: Buffer.byteLength(safeText(block.text ?? '')), capacity, kind: block.kind,
        ...(block.ts !== undefined ? { ts: block.ts } : {}), ...(block.callId ? { callId: block.callId } : {}),
        ...(block.meta ? { meta: redactSessionValue(block.meta) as Record<string, unknown> } : {}) };
      if (block.kind === 'tool_call') {
        if (turn) turn.index.tools++;
        if (turn && block.callId) row.state.calls['call:' + block.callId] = { turn: row.state.turns.length - 1, block: target.length, ts: block.ts };
      }
      if (block.kind === 'tool_result' && block.callId) {
        const pair = row.state.calls['call:' + block.callId];
        const call = pair && row.state.turns[pair.turn]?.blocks[pair.block];
        if (call) {
          const pairMeta = { paired: true, status: block.meta?.status ?? 'ok', ...(pair.ts !== undefined && block.ts !== undefined ? { duration_ms: Math.max(0, block.ts - pair.ts) } : {}) };
          call.meta = { ...call.meta, ...pairMeta }; indexed.meta = { ...indexed.meta, ...pairMeta, name: call.meta.name, server: call.meta.server };
          delete row.state.calls['call:' + block.callId];
        }
      }
      target.push(indexed);
    }
  }
  private selected(id: string): SessionIndexFile[] {
    const rows = [...this.files.values()].filter(row => row.session.id === id).sort((a, b) => a.session.started - b.session.started || a.file.localeCompare(b.file));
    if (!rows.length) throw new SessionError(404, '会话不存在');
    return rows;
  }
  /** O3 只读定位快照；正文仍经 rolloutLines 流式读取。 */
  async contextSource(id: string) {
    await this.refresh();
    return { codexHome: this.opts.codexHome, dataDir: this.opts.dataDir,
      files: this.selected(id).map(row => ({ file: row.file, size: row.size, mtime: row.mtime, identity: row.identity,
        lastOffset: row.lastOffset, turns: row.state.turns.map(turn => ({ turn: turn.index.turn, offset: turn.startOffset })) })) };
  }
  /** 引用由 O1 已索引块签发，沿用正文校验及脱敏字节数。 */
  async contextRef(id: string, file: string, offset: number, kind: string): Promise<ContentRef | undefined> {
    const row = this.selected(id).find(item => item.file === file);
    // 回合之间的指令/环境及独立保存的基础指令，同样通过已索引块签发引用。
    const block = row && [...row.state.turns.flatMap(turn => turn.blocks), ...row.state.prelude ?? [], ...row.state.baselines ?? []].find(item => item.lineOffset === offset && item.kind === kind && item.item >= 0);
    if (!row || !block) return undefined;
    const raw = await this.rawBlock(row, block);
    if (raw.text === undefined) return undefined;
    const bytes = Buffer.byteLength(safeText(raw.text));
    return { session: id, offset: block.offset, length: bytes, bytes };
  }
  async listSessions(filter: SessionFilter = {}): Promise<SessionRef[]> {
    const sessions = new Map<string, SessionRef>();
    for (const row of this.files.values()) {
      const before = sessions.get(row.session.id);
      sessions.set(row.session.id, before ? { ...row.session, started: Math.min(before.started, row.session.started), updated: Math.max(before.updated, row.session.updated), turns: before.turns + row.session.turns } : { ...row.session });
    }
    let result = [...sessions.values()].filter(s => (!filter.status || s.status === filter.status) && (!filter.scope || s.scope === filter.scope) && (filter.since === undefined || s.updated >= filter.since)).sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    if (filter.page !== undefined) result = result.slice(filter.page * 50, (filter.page + 1) * 50);
    return result;
  }
  async turns(id: string) {
    const turns = this.selected(id).flatMap(row => row.state.turns.map(turn => ({ ...turn.index, preview: safeText(turn.index.preview) }))).sort((a, b) => a.started - b.started);
    return enrichTurns(this.opts.store, 'codex', id, turns);
  }
  async blocks(id: string, turnId: string): Promise<Block[]> {
    for (const row of this.selected(id)) {
      const turn = row.state.turns.find(candidate => candidate.index.turn === turnId);
      if (!turn) continue;
      const blocks: Block[] = [];
      for (const block of turn.blocks) blocks.push(await this.readBlock(row, block));
      return blocks;
    }
    throw new SessionError(404, '回合不存在');
  }
  private async rawBlock(row: SessionIndexFile, indexed: IndexedBlock): Promise<Block> {
    if (indexed.item === -1) return { kind: 'event', text: '行过大', meta: indexed.meta };
    if (indexed.item === -2) return { kind: 'event', text: '模型请求', ts: indexed.ts, meta: indexed.meta };
    if (indexed.item === -3) return { kind: 'event', text: '模型用量', ts: indexed.ts, meta: indexed.meta };
    if (indexed.item === -4 || indexed.item === -5) return { kind: 'event', text: indexed.item === -4 ? '回合完成' : '回合失败', ts: indexed.ts, meta: indexed.meta };
    if (indexed.lineLength > MAX_ROLLOUT_LINE_BYTES) throw new SessionError(400, '行过大');
    const root = path.resolve(this.opts.codexHome, 'sessions');
    const rootStat = await fs.lstat(root).catch(() => undefined);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new SessionError(409, '会话目录已变化');
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(row.file)]).catch(() => { throw new SessionError(404, '会话文件已移除'); });
    const relative = path.relative(realRoot, realFile);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new SessionError(409, '会话文件超出索引目录');
    const handle = await fs.open(realFile, 'r').catch(() => { throw new SessionError(404, '会话文件已移除'); });
    try {
      const st = await handle.stat();
      if (row.identity !== `${st.dev}:${st.ino}:${st.birthtimeMs}` || st.size < row.size || (st.size === row.size && st.mtimeMs !== row.mtime)) throw new Error('索引已过期');
      if (st.size > row.size) {
        const boundary = await this.fingerprint(realFile, row.size, handle);
        if (boundary.head !== row.head || boundary.tail !== row.tail) throw new Error('索引已过期');
      }
      const data = Buffer.alloc(indexed.lineLength);
      const { bytesRead } = await handle.read(data, 0, data.length, indexed.lineOffset);
      if (bytesRead !== data.length) throw new Error('索引已过期');
      const line = data.toString('utf8').replace(/\r$/, '');
      if (indexed.lineHash && indexed.lineHash !== createHash('sha256').update(line).digest('hex')) throw new Error('索引已过期');
      const block = recordBlocks(JSON.parse(line))[indexed.item];
      if (!block || block.kind !== indexed.kind || block.callId !== indexed.callId) throw new Error('索引已过期');
      return { ...block, ...(indexed.meta ? { meta: { ...block.meta, ...indexed.meta } } : {}) };
    } catch { this.dirty.add(row.file); throw new SessionError(409, '会话内容已变化，请刷新索引'); }
    finally { await handle.close(); }
  }
  private async readBlock(row: SessionIndexFile, indexed: IndexedBlock): Promise<Block> {
    const block = await this.rawBlock(row, indexed);
    const bytes = Buffer.byteLength(safeText(block.text ?? ''));
    return inlineBlock(block, { session: row.session.id, offset: indexed.offset, length: bytes, bytes });
  }
  async content(ref: ContentRef): Promise<string> {
    for (const row of this.selected(ref.session)) for (const block of [...row.state.turns.flatMap(turn => turn.blocks), ...row.state.prelude ?? [], ...row.state.baselines ?? []]) {
      const slot = { session: row.session.id, offset: block.offset, length: block.capacity ?? block.bytes, bytes: block.bytes };
      if (!validRange(ref, slot)) continue;
      const source = await this.rawBlock(row, block);
      const bytes = Buffer.byteLength(safeText(source.text ?? ''));
      const indexed = { ...slot, length: bytes, bytes };
      return contentSlice(source.text ?? '', ref, indexed);
    }
    throw new SessionError(400, '范围不在已索引的正文块内');
  }
  subscribe(id: string, cb: (frame: BlockFrame) => void): () => void {
    const rows = this.selected(id);
    if (!rows.some(row => row.session.status === 'active')) throw new SessionError(400, '只能订阅活动会话');
    let subscribers = this.listeners.get(id);
    if (!subscribers) { subscribers = new Set(); this.listeners.set(id, subscribers); }
    subscribers.add(cb);
    return () => { subscribers!.delete(cb); if (!subscribers!.size) this.listeners.delete(id); };
  }
  async close(): Promise<void> { this.closed = true; clearInterval(this.timer); this.listeners.clear(); await this.refreshing; }
}
