/**
 * 实时视图（docs/DASHBOARD.md §3）：每个会话（owner / group:<id> / private:<qq>）一行，订阅 trace 的进程内总线（trace.tap）
 * 在内存里维护：空闲 / 工作中、当前回合（种类、发送者、输入、本轮已发消息、事件流）、排队输入、在跑的子 agent、
 * 最近完成的回合，并把每次变化以增量推送给 /live 的 SSE 客户端。事件已在 trace 内脱敏，这里只再做摘要与截断。
 *
 * 事件来源：in:<入站键>（收到、入队、送达）、turn:<回合 id>（回合内全部事件，received / dispatched 带会话键）、
 * thr:<会话键>（停滞、面板停止、不属于回合的发送）。回合在知道会话键之前到达的事件先暂存，归属后补入。
 * 会话宿主的只读快照（threads 选项）补齐排队输入、子 agent 数与重启后仍在进行的回合；总线定时刷新快照，
 * 只在有订阅者时刷新。stage=context_usage 的事件另推一条 context 增量（白名单字段），供各页的占用条原地更新。
 */
import { redact, redactText } from '../shared/redact.js';
import type { LiveEvent, Trace } from '../shared/trace.js';
import { fmtPct, fmtShort, ratio, toContextUsage, type ContextUsage } from '../shared/format.js';

export interface LiveItem { seq: number; ts: number; stage: string; status: string; duration_ms: number | null; summary: string }
export interface LiveInput { key: string; kind: string; sender: string; text: string }
export interface LiveSend { ts: number; target: string; text: string; status: string; system: boolean }
export type TurnKind = 'user' | 'scheduled' | 'wake' | '';
/** completed / failed / lost 来自回合终态；superseded 为被后端唤醒回合取代（结果记在宿主，不在这里） */
export type TurnOutcome = '' | 'completed' | 'failed' | 'lost' | 'superseded';
export interface LiveTurn {
  /** 宿主回合 id（trace 键去掉 turn: 前缀） */
  id: string;
  kind: TurnKind; sender: string; started: number; updated: number; finished: number | null; outcome: TurnOutcome;
  inputs: LiveInput[]; sends: LiveSend[]; tools: number; subagent_events: number;
  phase: string; phase_since: number; seq: number; dropped: number; items: LiveItem[];
}
export type LiveTurnHead = Omit<LiveTurn, 'items'>;
export interface LiveConversation {
  thread: string; scope: string; label: string; backend: string;
  state: 'idle' | 'working';
  turn: LiveTurn | null;
  /** 等本轮结束的输入（他人消息、定时任务）的入站键 */
  queued: string[];
  /** 在跑的子 agent 数；后端不提供时为 null（界面不显示） */
  subagents: number | null;
  /** 最近完成的回合，新的在前；不带事件流 */
  recent: LiveTurnHead[];
  updated: number;
}
export type ConversationHead = Omit<LiveConversation, 'turn'> & { turn: LiveTurnHead | null };
export type LiveMessage =
  | { type: 'conversation'; conversation: ConversationHead; item?: LiveItem }
  | { type: 'remove'; thread: string }
  | { type: 'context'; usage: ContextUsage };

/** 会话宿主的只读快照（main.ts 由 ThreadHost 与两个后端求出）。 */
export interface LiveThreadState {
  thread: string; busy: boolean; turnId?: string; turnKind?: string; turnSender?: string;
  /** 排队输入的入站键 */
  pending: string[];
  backend?: string;
  subagents?: number | null;
}

const TERMINAL = new Set(['reply_sent', 'failed']);
const THREAD_KEY = /^(owner|(?:group|private):\d+)$/;
/** 字符串原样；对象展开为 `键 值` 对（工具参数），避免在界面上出现 JSON 括号与引号。 */
const s = (v: unknown, n = 160): string => {
  if (typeof v === 'string') return redactText(v, n);
  if (v === undefined || v === null) return '';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const r = redact(v, n) as Record<string, unknown>;
    return redactText(Object.entries(r).map(([k, x]) => `${k} ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('，'), n);
  }
  return redactText(JSON.stringify(redact(v, n)), n);
};

/** 把一个事件压成一行中文摘要（只取白名单字段）。 */
export function summarize(e: Pick<LiveEvent, 'stage' | 'status' | 'detail'>): string {
  const d = e.detail;
  const parts: string[] = [];
  const add = (label: string, v: unknown, n = 120) => { const t = s(v, n); if (t && t !== '{}' && t !== '""') parts.push(`${label}${t}`); };
  if (e.stage === 'received' || e.stage === 'recovered') { add('', d.text, 80); add('来自 ', d.sender, 40); }
  else if (e.stage === 'steered') add('', d.text ?? d.input, 80);
  else if (e.stage === 'queued') { add('会话 ', d.thread_key); add('', d.result === 'queued' ? '排队等本轮结束' : d.result === 'steered' ? '插话进当前回合' : d.result); }
  else if (e.stage === 'dispatched') { add('后端 ', d.backend); add('会话 ', d.conversation_key ?? d.thread_id); add('', d.kind === 'wake' ? '唤醒回合' : undefined); }
  else if (e.stage === 'model_turn') {
    add('', d.provider && d.model ? `${String(d.provider)}/${String(d.model)}` : d.backend);
    add('强度 ', d.effort);
    if (typeof d.input_tokens === 'number') parts.push(`输入 ${d.input_tokens} / 输出 ${String(d.output_tokens ?? 0)} tokens`);
    if (e.status !== 'started') add('', d.raw_reply ?? d.reply, 100);
  }
  else if (e.stage === 'model_usage') {
    if (typeof d.total_input_tokens === 'number') parts.push(`线程累计输入 ${d.total_input_tokens} / 输出 ${String(d.total_output_tokens ?? 0)} tokens`);
    else if (typeof d.input_tokens === 'number') parts.push(`输入 ${d.input_tokens} / 输出 ${String(d.output_tokens ?? 0)} tokens`);
  }
  else if (e.stage.startsWith('tool:')) { add('', d.command ?? d.query ?? d.input, 140); if (e.status !== 'started') add('→ ', d.error ?? (typeof d.exit_code === 'number' ? `exit ${d.exit_code}` : undefined), 80); add('', d.server); }
  else if (e.stage === 'subagent') { add('', d.kind); add('子线程 ', d.agent, 40); }
  else if (e.stage === 'final_answer') { add('留存：', d.text, 100); }
  else if (e.stage === 'send_message') { add('→ ', d.text, 100); add('消息 #', d.message_id, 100); add('目标 ', d.target, 100); }
  else if (TERMINAL.has(e.stage)) { add('', d.reply, 100); add('', d.reason ?? d.failure); }
  else if (e.stage === 'settings_changed') add('', d.changed);
  else if (e.stage === 'context_usage' && typeof d.usedTokens === 'number' && typeof d.windowTokens === 'number')
    parts.push(`上下文 ${fmtShort(d.usedTokens)} / ${fmtShort(d.windowTokens)}（${fmtPct(ratio(d.usedTokens, d.windowTokens))}）`);
  if (e.status === 'failed' && typeof d.error_category === 'string' && !parts.some(p => p.includes('error'))) parts.push(`错误类别 ${d.error_category}`);
  return parts.join(' · ').slice(0, 240);
}

export interface LiveBusOptions {
  maxItems?: number;
  /** 每个会话保留的最近完成回合数 */
  maxRecent?: number;
  /** 空闲会话在最后一个回合结束后保留多久 */
  idleTtlMs?: number;
  maxConversations?: number;
  pruneIntervalMs?: number;
  /** 会话宿主快照的刷新间隔（只在有订阅者时刷新） */
  refreshIntervalMs?: number;
  threads?: () => LiveThreadState[] | Promise<LiveThreadState[]>;
  /** 会话显示名（群名）；缺省不显示 */
  label?: (thread: string) => string | undefined;
  now?: () => number;
}

type Conv = LiveConversation & { turnOpen: { stage: string; ts: number }[]; pending: Set<string> };
type Orphan = { events: LiveEvent[]; ts: number };

export class LiveBus {
  private readonly conversations = new Map<string, Conv>();
  /** 回合 id → 会话键 */
  private readonly turnThread = new Map<string, string>();
  /** 会话键未知的回合事件 */
  private readonly orphans = new Map<string, Orphan>();
  /** 入站键 → 正文、发送者与会话键（来自 in: 事件） */
  private readonly inputs = new Map<string, { text: string; sender: string; kind: string; thread?: string; delivered?: boolean }>();
  private readonly subscribers = new Set<(m: LiveMessage) => void>();
  private readonly off: () => void;
  private readonly o: Required<Omit<LiveBusOptions, 'threads' | 'label'>> & Pick<LiveBusOptions, 'threads' | 'label'>;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private refreshing?: Promise<void>;

  constructor(trace: Pick<Trace, 'tap'>, options: LiveBusOptions = {}) {
    this.o = { maxItems: 80, maxRecent: 5, idleTtlMs: 30 * 60_000, maxConversations: 300, pruneIntervalMs: 60_000, refreshIntervalMs: 5_000, now: Date.now, ...options };
    this.off = trace.tap(e => this.ingest(e));
    // 过期淘汰不依赖有人打开页面；快照刷新只在有订阅者时进行
    this.timers.push(setInterval(() => this.prune(), this.o.pruneIntervalMs));
    if (this.o.threads) this.timers.push(setInterval(() => { if (this.subscribers.size) void this.refresh(); }, this.o.refreshIntervalMs));
    for (const t of this.timers) t.unref();
  }

  close(): void { for (const t of this.timers) clearInterval(t); this.off(); this.subscribers.clear(); }
  subscribe(fn: (m: LiveMessage) => void): () => void { this.subscribers.add(fn); return () => { this.subscribers.delete(fn); }; }

  /** 当前全部会话：工作中在前（按回合开始时间），空闲的按最近活动倒序；用于页面首屏与 SSE 首帧。 */
  snapshot(): LiveConversation[] {
    this.prune();
    return [...this.conversations.values()].map(c => this.view(c))
      .sort((a, b) => Number(b.state === 'working') - Number(a.state === 'working')
        || (a.state === 'working' ? (a.turn?.started ?? a.updated) - (b.turn?.started ?? b.updated) : b.updated - a.updated));
  }

  /** 读一次会话宿主快照并合并（页面渲染与 SSE 首帧前调用）；快照失败只保留 trace 推出的状态。 */
  refresh(): Promise<void> {
    if (!this.o.threads) return Promise.resolve();
    this.refreshing ??= (async () => {
      try {
        for (const state of await this.o.threads!()) this.merge(state);
      } catch { /* 宿主快照不可用时只用 trace */ }
      finally { this.refreshing = undefined; }
    })();
    return this.refreshing;
  }

  private view(c: Conv): LiveConversation {
    const { turnOpen: _open, pending: _pending, ...rest } = c;
    return { ...rest, queued: [...c.pending], recent: c.recent.map(t => ({ ...t })), turn: c.turn ? { ...c.turn, items: [...c.turn.items] } : null };
  }

  private head(c: Conv): ConversationHead {
    const { turn, ...rest } = this.view(c);
    if (!turn) return { ...rest, turn: null };
    const { items: _items, ...turnHead } = turn;
    return { ...rest, turn: turnHead };
  }

  private conversation(thread: string, scope = '', ts = this.o.now()): Conv {
    let c = this.conversations.get(thread);
    if (!c) {
      let label = '';
      try { label = this.o.label?.(thread) ?? ''; } catch { /* 显示名可缺省 */ }
      c = { thread, scope: scope || (thread === 'owner' ? '' : thread), label, backend: '', state: 'idle', turn: null, queued: [], subagents: null,
        recent: [], updated: ts, turnOpen: [], pending: new Set() };
      this.conversations.set(thread, c);
      if (this.conversations.size > this.o.maxConversations) this.prune(true);
    }
    if (scope && !c.scope) c.scope = scope;
    return c;
  }

  private newTurn(id: string, ts: number): LiveTurn {
    return { id, kind: '', sender: '', started: ts, updated: ts, finished: null, outcome: '', inputs: [], sends: [], tools: 0, subagent_events: 0,
      phase: '', phase_since: ts, seq: 0, dropped: 0, items: [] };
  }

  /** 当前回合结束，收进最近完成（不带事件流）。 */
  private finish(c: Conv, outcome: TurnOutcome, ts: number): void {
    const turn = c.turn;
    if (!turn) return;
    turn.finished = ts; turn.outcome = outcome; turn.phase = ''; turn.phase_since = ts;
    const { items: _items, ...head } = turn;
    c.recent = [head, ...c.recent.filter(t => t.id !== turn.id)].slice(0, this.o.maxRecent);
    c.turn = null; c.turnOpen = []; c.state = 'idle';
  }

  private addInputs(turn: LiveTurn, keys: unknown, fallbackText?: unknown, c?: Conv): void {
    if (!Array.isArray(keys)) return;
    for (const key of keys) {
      if (typeof key !== 'string' || turn.inputs.some(i => i.key === key)) continue;
      const known = this.inputs.get(key);
      turn.inputs.push({ key, kind: known?.kind ?? '', sender: known?.sender ?? '', text: known?.text ?? (keys.length === 1 ? s(fallbackText, 500) : '') });
      c?.pending.delete(key);
    }
  }

  ingest(e: LiveEvent): void {
    if (e.stage === 'context_usage') {
      const usage = toContextUsage(e.detail);
      if (usage) this.publish({ type: 'context', usage });
    }
    const d = e.detail;
    if (e.key.startsWith('in:')) return this.input(e.key.slice(3), e);
    if (e.key.startsWith('thr:')) {
      const c = this.conversations.get(e.key.slice(4));
      if (c?.turn) this.item(c, e);
      return;
    }
    if (!e.key.startsWith('turn:')) return; // @ 系统事件与旧版键不进实时视图
    const id = e.key.slice(5);
    const hinted = d.thread_key ?? d.conversation_key;
    const thread = this.turnThread.get(id) ?? (typeof hinted === 'string' && THREAD_KEY.test(hinted) ? hinted : undefined);
    if (!thread) {
      // 会话键未知：先暂存（有界），归属后补入
      const orphan = this.orphans.get(id) ?? { events: [], ts: e.ts };
      if (orphan.events.length < this.o.maxItems) orphan.events.push(e);
      this.orphans.set(id, orphan);
      if (this.orphans.size > 100) this.orphans.delete(this.orphans.keys().next().value!);
      return;
    }
    if (!this.turnThread.has(id)) {
      this.turnThread.set(id, thread);
      if (this.turnThread.size > 2000) this.turnThread.delete(this.turnThread.keys().next().value!);
    }
    const queued = this.orphans.get(id);
    this.orphans.delete(id);
    for (const early of queued?.events ?? []) this.turnEvent(thread, id, early);
    this.turnEvent(thread, id, e);
  }

  private input(key: string, e: LiveEvent): void {
    const d = e.detail;
    const known = this.inputs.get(key);
    if (e.stage === 'received' || e.stage === 'recovered') {
      this.inputs.set(key, { ...known, text: s(d.text, 500), sender: s(d.sender, 60), kind: known?.kind ?? 'user' });
      if (this.inputs.size > 1000) this.inputs.delete(this.inputs.keys().next().value!);
      return;
    }
    const thread = typeof d.thread_key === 'string' ? d.thread_key : known?.thread;
    if (e.stage === 'queued' && thread && THREAD_KEY.test(thread)) {
      this.inputs.set(key, { ...known, text: known?.text ?? '', sender: known?.sender ?? '', kind: typeof d.kind === 'string' ? d.kind : known?.kind ?? '', thread });
      const c = this.conversation(thread, e.scope, e.ts);
      // 空闲会话的输入也是先入队再开轮：送达（delivered）可能先于这条 queued 到达
      if (d.result === 'queued' && !known?.delivered && !c.turn?.inputs.some(i => i.key === key)) c.pending.add(key);
      c.updated = e.ts;
      this.publish({ type: 'conversation', conversation: this.head(c) });
      return;
    }
    if (e.stage === 'delivered') {
      this.inputs.set(key, { text: '', sender: '', kind: '', ...known, delivered: true });
      if (this.inputs.size > 1000) this.inputs.delete(this.inputs.keys().next().value!);
      const c = thread ? this.conversations.get(thread) : undefined;
      if (c?.pending.delete(key)) { c.updated = e.ts; this.publish({ type: 'conversation', conversation: this.head(c) }); }
    }
  }

  private turnEvent(thread: string, id: string, e: LiveEvent): void {
    const d = e.detail;
    const terminal = TERMINAL.has(e.stage) && d.terminal === true;
    const known = this.conversations.get(thread);
    // 重启前的回合只剩终态、或已收进最近完成的回合的迟到事件：不凭空开行
    if (known?.turn?.id !== id && (terminal || known?.recent.some(t => t.id === id))) return;
    const c = this.conversation(thread, e.scope, e.ts);
    if (c.turn?.id !== id) {
      if (c.turn) this.finish(c, 'superseded', e.ts);
      c.turn = this.newTurn(id, e.ts);
      c.state = 'working';
    }
    const turn = c.turn!;
    if (e.stage === 'received') {
      if (typeof d.kind === 'string' && !turn.kind) turn.kind = d.kind as TurnKind;
      if (typeof d.sender === 'string' && d.sender) turn.sender = s(d.sender, 60);
      if (Array.isArray(d.inputs)) this.addInputs(turn, d.inputs, d.text, c);
      else if (!turn.inputs.length && typeof d.text === 'string') turn.inputs.push({ key: '', kind: turn.kind, sender: turn.sender, text: s(d.text, 500) });
    }
    if (e.stage === 'dispatched') {
      if (typeof d.backend === 'string') c.backend = d.backend;
      if (d.kind === 'wake') turn.kind = 'wake';
      else if (typeof d.kind === 'string' && !turn.kind) turn.kind = d.kind as TurnKind;
      this.addInputs(turn, d.inputs, undefined, c);
    }
    if (e.stage === 'steered') this.addInputs(turn, d.inputs ?? (typeof d.input === 'string' ? [d.input] : undefined), d.text, c);
    if (e.stage === 'send_message') {
      turn.sends.push({ ts: e.ts, target: s(d.target, 80), text: s(d.text, 200), status: s(d.status, 20), system: d.system === true });
      if (turn.sends.length > 20) turn.sends.shift();
    }
    if (e.stage.startsWith('tool:') && e.status !== 'started') turn.tools++;
    if (e.stage === 'subagent' || e.stage === 'tool:subagent') turn.subagent_events++;
    if (terminal) {
      const status = d.status === 'completed' || d.status === 'failed' || d.status === 'lost' ? d.status : e.stage === 'failed' ? 'failed' : 'completed';
      this.item(c, e, false);
      this.finish(c, status, e.ts);
      c.updated = e.ts;
      this.publish({ type: 'conversation', conversation: this.head(c) });
      this.prune();
      return;
    }
    this.item(c, e);
  }

  /** 事件进当前回合的事件流（阶段栈、截断、推送）。 */
  private item(c: Conv, e: LiveEvent, publish = true): void {
    const turn = c.turn;
    if (!turn) return;
    // 阶段栈：started 入栈；结束事件弹出该阶段及其之后打开的子阶段
    if (e.status === 'started') {
      if (!c.turnOpen.some(o => o.stage === e.stage)) c.turnOpen.push({ stage: e.stage, ts: e.ts });
    } else {
      const i = c.turnOpen.map(o => o.stage).lastIndexOf(e.stage);
      if (i >= 0) c.turnOpen.splice(i);
    }
    const top = c.turnOpen.at(-1);
    if ((top?.stage ?? '') !== turn.phase) { turn.phase = top?.stage ?? ''; turn.phase_since = top?.ts ?? e.ts; }
    turn.updated = e.ts; c.updated = e.ts;
    const item: LiveItem = { seq: ++turn.seq, ts: e.ts, stage: e.stage, status: e.status, duration_ms: e.duration_ms, summary: summarize(e) };
    turn.items.push(item);
    if (turn.items.length > this.o.maxItems) { turn.items.splice(0, turn.items.length - this.o.maxItems); turn.dropped++; }
    if (publish) this.publish({ type: 'conversation', conversation: this.head(c), item });
  }

  /** 合并宿主快照：排队输入、子 agent 数、会话后端；重启后仍在进行、但 trace 里没见过的回合补一个占位。 */
  private merge(state: LiveThreadState): void {
    if (!THREAD_KEY.test(state.thread)) return;
    const known = this.conversations.get(state.thread);
    if (!known && !state.busy && !state.pending.length) return;
    const c = known ?? this.conversation(state.thread);
    const before = JSON.stringify([[...c.pending], c.subagents, c.backend, c.turn?.id ?? null]);
    c.pending = new Set(state.pending.filter(key => !c.turn?.inputs.some(i => i.key === key)));
    if (state.subagents !== undefined) c.subagents = state.subagents;
    if (state.backend) c.backend = state.backend;
    if (state.busy && state.turnId && !c.turn && !c.recent.some(t => t.id === state.turnId)) {
      const now = this.o.now();
      c.turn = this.newTurn(state.turnId, now);
      c.turn.kind = state.turnKind === 'user' || state.turnKind === 'scheduled' || state.turnKind === 'wake' ? state.turnKind : '';
      c.turn.sender = state.turnSender ?? '';
      c.state = 'working';
      this.turnThread.set(state.turnId, state.thread);
    }
    if (JSON.stringify([[...c.pending], c.subagents, c.backend, c.turn?.id ?? null]) !== before) this.publish({ type: 'conversation', conversation: this.head(c) });
  }

  private prune(force = false): void {
    const now = this.o.now();
    for (const [thread, c] of this.conversations) {
      if (c.turn || c.pending.size || (c.subagents ?? 0) > 0) continue;
      if (now - c.updated > this.o.idleTtlMs) this.drop(thread);
    }
    for (const [id, orphan] of this.orphans) if (now - orphan.ts > this.o.idleTtlMs) this.orphans.delete(id);
    if (force && this.conversations.size > this.o.maxConversations) {
      // 极端情况下按最久未更新淘汰
      const stale = [...this.conversations.values()].sort((a, b) => a.updated - b.updated).slice(0, this.conversations.size - this.o.maxConversations);
      for (const c of stale) this.drop(c.thread);
    }
  }

  private publish(msg: LiveMessage): void {
    for (const fn of this.subscribers) { try { fn(msg); } catch { /* 慢客户端由 SSE 层断开 */ } }
  }

  private drop(thread: string): void {
    this.conversations.delete(thread);
    this.publish({ type: 'remove', thread });
  }
}
