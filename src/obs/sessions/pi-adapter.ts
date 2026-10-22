import type { PiConversation, PiEntryPage, PiSessionSource } from '../../agent/backends/pi-session-types.js';
import { AssistantEntry, CompactionEntry, ResetEntry, SystemEntry, UserEntry,
  type ContextView, type EntryRecord } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
import { redactText } from '../../shared/redact.js';
import type { ObsStore } from '../store.js';
import { usageCost } from '../../shared/usage.js';
import { contentSlice, inlineBlock, redactSessionValue, validRange } from './content.js';
import { enrichTurns } from './enrichment.js';
import { SessionError, type Block, type BlockFrame, type ContentRef, type ObservedTurn,
  type SessionAdapter, type SessionFilter, type SessionRef, type TurnIndex } from './types.js';

type StoredBlock = { block: Block; ref: ContentRef };
type PiTurn = { index: TurnIndex; blocks: StoredBlock[] };
type SessionState = {
  session: SessionRef; cursor?: string; lastEntry: number; nextOffset: number;
  turns: PiTurn[]; prelude: StoredBlock[]; calls: Map<string, StoredBlock>;
};
const PAGE_SIZE = 256;
const timestamp = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const textContent = (message: Message): string => typeof message.content === 'string' ? message.content
  : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');

/** entries 是正文事实源，ObsStore 只用于关联宿主回合和送达补充。 */
export class PiSessionAdapter implements SessionAdapter {
  readonly progress = { indexing: false, files: 0, done: 0 };
  private readonly states = new Map<string, SessionState>();
  private readonly listeners = new Map<string, Set<(frame: BlockFrame) => void>>();
  private readonly stops = new Map<string, () => void>();
  private readonly pending = new Map<string, Promise<void>>();
  private refreshWork?: Promise<void>;
  private closed = false;
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: { source: PiSessionSource; store?: ObsStore; pollMs?: number }) {
    void this.refresh().catch(() => undefined);
    this.refreshTimer = setInterval(() => { void this.refresh().catch(() => undefined); }, 2000);
    this.refreshTimer.unref();
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshWork) return this.refreshWork;
    this.refreshWork = this.rebuildList().finally(() => { this.refreshWork = undefined; });
    return this.refreshWork;
  }

  private async rebuildList(): Promise<void> {
    this.progress.indexing = true;
    this.progress.done = 0;
    try {
      const conversations = await this.options.source.listConversations();
      if (this.closed) return;
      this.progress.files = conversations.length;
      const ids = new Set(conversations.map(item => item.id));
      for (const id of this.states.keys()) if (!ids.has(id)) {
        this.states.delete(id);
        this.stops.get(id)?.();
        this.stops.delete(id);
      }
      for (const item of conversations) {
        if (this.closed) return;
        let state = this.states.get(item.id);
        if (!state) {
          state = { session: { ...item, backend: 'pi', started: item.started ?? 0, updated: item.updated ?? 0, turns: 0 },
            lastEntry: 0, nextOffset: 0, turns: [], prelude: [], calls: new Map() };
          this.states.set(item.id, state);
        } else {
          Object.assign(state.session, item, { started: state.session.started || item.started || 0,
            updated: Math.max(state.session.updated, item.updated ?? 0) });
        }
        await this.scan(state);
        this.progress.done++;
      }
    } finally { this.progress.indexing = false; }
  }

  private scan(state: SessionState): Promise<void> {
    if (this.closed) return Promise.resolve();
    const id = state.session.id;
    const existing = this.pending.get(id);
    if (existing) return existing;
    const work = (async () => {
      let more: boolean;
      do {
        const page = await this.options.source.entries(id, state.cursor, PAGE_SIZE);
        if (this.closed) return;
        const before = state.lastEntry;
        for (const entry of page.items) {
          if (entry.id <= state.lastEntry) continue;
          this.appendEntry(state, entry);
          state.lastEntry = entry.id;
        }
        state.cursor = page.cursor ?? (state.lastEntry ? String(state.lastEntry) : undefined);
        more = page.hasMore;
        if (more && state.lastEntry <= before) throw new Error('Pi entries 游标未前进');
      } while (more && !this.closed);
    })().finally(() => { this.pending.delete(id); });
    this.pending.set(id, work);
    return work;
  }

  private appendEntry(state: SessionState, entry: EntryRecord): void {
    const ts = entry.model?.map(message => timestamp(message.timestamp)).find(value => value !== undefined);
    if (ts !== undefined) {
      if (!state.session.started || ts < state.session.started) state.session.started = ts;
      state.session.updated = Math.max(state.session.updated, ts);
    }
    const user = UserEntry.is(entry) || (!CompactionEntry.is(entry) && !ResetEntry.is(entry)
      && entry.model?.some(message => message.role === 'user'));
    if (user) {
      const previous = state.turns.at(-1)?.index;
      if (previous && previous.ended === undefined && ts !== undefined) previous.ended = ts;
      const preview = entry.model?.filter(message => message.role === 'user').map(textContent).join('\n') ?? '';
      state.turns.push({ index: { turn: String(entry.id), started: ts ?? 0,
        preview: redactText(preview, 200), tools: 0, requests: 0, status: 'running' }, blocks: state.prelude });
      state.prelude = [];
      state.session.turns = state.turns.length;
    }
    const turn = state.turns.at(-1);
    const meta = { entry: String(entry.id), ...(entry.head !== undefined ? { head: String(entry.head) } : {}) };
    const add = (block: Block): StoredBlock => {
      // 分配脱敏后的虚拟 UTF-8 范围，任何 content 子范围都不能还原原始秘密。
      const safe = redactSessionValue(block) as Block;
      const length = Buffer.byteLength(safe.text ?? '');
      const stored = { block: safe, ref: { session: state.session.id, offset: state.nextOffset, length, bytes: length } };
      state.nextOffset += length + 1;
      (turn?.blocks ?? state.prelude).push(stored);
      if (turn) for (const cb of this.listeners.get(state.session.id) ?? []) {
        try { cb({ session: state.session.id, turn: turn.index.turn, block: inlineBlock(safe, stored.ref) }); } catch { /* 一个已关闭订阅不影响其余连接 */ }
      }
      return stored;
    };
    if (CompactionEntry.is(entry)) {
      add({ kind: 'compaction', ts, text: entry.model?.map(textContent).join('\n') ?? '',
        meta: { ...meta, reason: entry.data?.reason } });
      return;
    }
    if (ResetEntry.is(entry)) {
      add({ kind: 'system_change', ts, text: entry.model?.map(textContent).join('\n') || '上下文已重置', meta: { ...meta, reset: true } });
      return;
    }
    for (const message of entry.model ?? []) {
      const messageTs = timestamp(message.timestamp);
      if (message.role === 'system' || SystemEntry.is(entry)) {
        if (message.role !== 'system') continue;
        add({ kind: 'system_change', ts: messageTs,
          text: JSON.stringify(redactSessionValue({ content: message.content, sections: message.sections,
            toolsAdded: message.toolsAdded, toolsRemoved: message.toolsRemoved })), meta });
      } else if (message.role === 'user') {
        if (typeof message.content === 'string') add({ kind: 'user', ts: messageTs, text: message.content, meta });
        else for (const part of message.content) {
          if (part.type === 'text') add({ kind: 'user', ts: messageTs, text: part.text, meta });
          else add({ kind: 'image', ts: messageTs, text: '图片', meta: { ...meta, mimeType: part.mimeType, unavailable: true } });
        }
      } else if (message.role === 'assistant') {
        const usage = { input: usageCost(message.usage).input, output: message.usage.output,
          cached: message.usage.cacheRead, ...(message.usage.reasoning !== undefined ? { reasoning: message.usage.reasoning } : {}), measured: true };
        if (turn && AssistantEntry.is(entry)) {
          turn.index.requests++;
          const previous = turn.index.usage;
          turn.index.usage = { input: (previous?.input ?? 0) + usage.input, output: (previous?.output ?? 0) + usage.output,
            cached: (previous?.cached ?? 0) + usage.cached, measured: true,
            ...(usage.reasoning !== undefined || previous?.reasoning !== undefined
              ? { reasoning: (previous?.reasoning ?? 0) + (usage.reasoning ?? 0) } : {}) };
          if (message.stopReason === 'error' || message.stopReason === 'aborted') turn.index.status = 'failed';
          else if (message.stopReason === 'stop' || message.stopReason === 'length') turn.index.status = 'ok';
          else turn.index.status = 'running';
          if (turn.index.status !== 'running' && messageTs !== undefined) turn.index.ended = messageTs + Math.max(0, message.durationMs ?? 0);
          state.session.updated = Math.max(state.session.updated, turn.index.ended ?? messageTs ?? 0);
        }
        add({ kind: 'event', ts: messageTs, text: '模型请求', meta: { ...meta, type: 'model_request', model: message.model,
          provider: message.provider, effort: message.providerThinkingLevel ?? message.thinkingLevel,
          usage, duration_ms: message.durationMs, stopReason: message.stopReason } });
        for (const part of message.content) {
          if (part.type === 'text') add({ kind: 'assistant', ts: messageTs, text: part.text, meta });
          else if (part.type === 'thinking') add({ kind: 'thinking', ts: messageTs,
            text: part.redacted ? undefined : part.thinking, meta: { ...meta, ...(part.redacted ? { unavailable: true } : {}) } });
          else if (part.type === 'toolCall') {
            if (turn) turn.index.tools++;
            const stored = add({ kind: 'tool_call', ts: messageTs, callId: part.id,
              text: JSON.stringify(redactSessionValue(part.arguments)),
              meta: { ...meta, name: part.name, namespace: part.namespace, status: 'running' } });
            state.calls.set(part.id, stored);
          }
        }
        if (message.errorMessage) add({ kind: 'event', ts: messageTs, text: message.errorMessage, meta: { ...meta, status: 'failed' } });
      } else if (message.role === 'toolResult') {
        const called = state.calls.get(message.toolCallId);
        const status = message.isError ? 'failed' : 'ok';
        if (called) called.block.meta = { ...called.block.meta, status, resultEntry: String(entry.id),
          ...(message.durationMs !== undefined ? { duration_ms: message.durationMs } : {}) };
        add({ kind: 'tool_result', ts: messageTs, callId: message.toolCallId, text: textContent(message),
          meta: { ...meta, name: message.toolName, status, paired: !!called,
            duration_ms: message.durationMs, ...(called ? { callEntry: called.block.meta?.entry } : {}) } });
        for (const part of message.content) if (part.type === 'image') {
          add({ kind: 'image', ts: messageTs, callId: message.toolCallId, text: '工具返回图片',
            meta: { ...meta, mimeType: part.mimeType, unavailable: true } });
        }
      }
    }
    if (!entry.model?.length) add({ kind: 'event', ts, text: entry.kind, meta });
  }

  async listSessions(filter: SessionFilter = {}): Promise<SessionRef[]> {
    let sessions = [...this.states.values()].map(state => state.session).filter(session =>
      (!filter.status || session.status === filter.status) && (!filter.scope || session.scope === filter.scope)
      && (filter.since === undefined || session.updated >= filter.since))
      .sort((left, right) => right.updated - left.updated || left.id.localeCompare(right.id));
    if (filter.page !== undefined) sessions = sessions.slice(filter.page * 50, (filter.page + 1) * 50);
    return redactSessionValue(sessions) as SessionRef[];
  }

  private async state(id: string): Promise<SessionState> {
    if (this.closed) throw new SessionError(503, 'Pi 会话索引已关闭');
    if (!this.states.has(id)) await this.refresh();
    const state = this.states.get(id);
    if (!state) throw new SessionError(404, '会话不存在');
    await this.scan(state);
    if (this.closed) throw new SessionError(503, 'Pi 会话索引已关闭');
    return state;
  }

  async turns(id: string): Promise<ObservedTurn[]> {
    const state = await this.state(id);
    const turns = state.turns.map(turn => ({ ...turn.index }));
    return redactSessionValue(this.options.store ? enrichTurns(this.options.store, 'pi', id, turns) : turns) as ObservedTurn[];
  }

  async blocks(id: string, turnId: string): Promise<Block[]> {
    const state = await this.state(id);
    const turn = state.turns.find(item => item.index.turn === turnId);
    if (!turn) throw new SessionError(404, '回合不存在');
    return turn.blocks.map(item => inlineBlock(item.block, item.ref));
  }

  async content(ref: ContentRef): Promise<string> {
    const state = await this.state(ref.session);
    const item = state.turns.flatMap(turn => turn.blocks).find(block => validRange(ref, block.ref));
    if (!item || item.block.text === undefined) throw new SessionError(400, '范围不在已索引的正文块内');
    return contentSlice(item.block.text, ref, item.ref);
  }

  /** 回合后的边界是下一次 UserEntry 之前的最后一个已提交条目。 */
  async contextBoundary(id: string, turnId: string, phase: 'before' | 'after'): Promise<string> {
    const state = await this.state(id);
    const index = state.turns.findIndex(turn => turn.index.turn === turnId);
    if (index < 0) throw new SessionError(404, '回合不存在');
    if (phase === 'before') return turnId;
    const turn = state.turns[index];
    return index === state.turns.length - 1 ? String(state.lastEntry)
      : String(turn.blocks.at(-1)?.block.meta?.entry ?? turnId);
  }
  /** 留给 O3 的公开历史上下文入口；不会自己重建 pi 内部上下文。 */
  async context(id: string, at?: string): Promise<ContextView> {
    await this.state(id);
    return this.options.source.context(id, at);
  }
  async contextRef(id: string, entry: string, kind: string): Promise<ContentRef | undefined> {
    const state = await this.state(id);
    const matches = state.turns.flatMap(turn => turn.blocks).filter(item => item.block.meta?.entry === entry && item.block.kind === kind && item.block.text !== undefined);
    // 一个上下文消息可能包含多个内容块；不能给组合正文签发其中一块的引用。
    return matches.length === 1 ? { ...matches[0].ref } : undefined;
  }

  subscribe(id: string, cb: (frame: BlockFrame) => void): () => void {
    let disposed = false;
    let attached: Set<(frame: BlockFrame) => void> | undefined;
    const attach = (state: SessionState) => {
      if (disposed || this.closed || state.session.status !== 'active') return;
      // 已缓存会话必须同步注册；否则 await 扫描可能在监听生效前消费刚到达的首批块。
      attached = this.listeners.get(id) ?? new Set();
      attached.add(cb);
      this.listeners.set(id, attached);
      if (this.stops.has(id)) return;
      let stopped = false;
      let stopLive: (() => void) | undefined;
      const poll = async () => {
        const current = this.states.get(id);
        if (!stopped && current?.session.status === 'active') await this.scan(current);
      };
      let timer: ReturnType<typeof setInterval> | undefined;
      this.stops.set(id, () => { stopped = true; if (timer) clearInterval(timer); stopLive?.(); });
      // 轮询兜底也负责总线断开后的继续读取；同一会话 scan 会合并并发请求。
      timer = setInterval(() => { void poll().catch(() => undefined); }, this.options.pollMs ?? 2000);
      timer.unref();
      void (async () => {
        if (this.options.source.subscribe) {
          stopLive = await this.options.source.subscribe(id, () => { void poll().catch(() => undefined); });
          if (stopped) { stopLive(); return; }
        }
        await poll();
      })().catch(() => undefined);
    };
    const cached = this.states.get(id);
    if (cached) attach(cached);
    else void this.state(id).then(attach).catch(() => undefined);
    return () => {
      disposed = true;
      attached?.delete(cb);
      if (attached && !attached.size) {
        this.listeners.delete(id);
        this.stops.get(id)?.();
        this.stops.delete(id);
      }
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.refreshTimer);
    for (const stop of this.stops.values()) stop();
    this.stops.clear();
    this.listeners.clear();
    await Promise.allSettled([...this.pending.values(), ...(this.refreshWork ? [this.refreshWork] : [])]);
    this.states.clear();
  }
}
