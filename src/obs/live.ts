/**
 * 进行中会话的实时视图（设计 §8.4）：订阅 trace 的进程内总线（trace.tap），按票据维护内存卡片，
 * 并把每个事件以增量推送给 /live 的 SSE 客户端。不读数据库、不轮询；事件已在 trace 内脱敏，
 * 这里只再做摘要与截断。卡片在终态后标记完成，保留最近若干张供页面收起显示；超出数量或过期的
 * 完成卡片在终态事件后与定时器里即时淘汰，并推送 remove 增量。每张卡片内的事件带单调递增的 seq，
 * 客户端据此增量渲染（事件环形截断后仍能续接）。stage=context_usage 的事件（设计 §8.5）另推一条
 * context 增量（白名单字段），供各页的上下文占用条原地更新；卡片记下线程键（thread）以便查找。
 */
import { redact, redactText } from './redact.js';
import type { LiveEvent, Trace } from './trace.js';
import { fmtPct, fmtShort, ratio, toContextUsage, type ContextUsage } from './ui/context-bar.js';

type CardState = 'queued' | 'running' | 'done' | 'failed';
interface LiveItem { seq: number; ts: number; stage: string; status: string; duration_ms: number | null; summary: string }
export interface LiveCard {
  ticket: string; scope: string; text: string; sender: string; route: string; backend: string;
  /** 线程键：codex 为 owner | shared，pi 为 owner | 会话域；来自 thread_wait / dispatched / model_turn 事件 */
  thread: string;
  state: CardState; phase: string; phase_since: number; started: number; updated: number; finished: number | null;
  outcome: string; late_images: number; dropped: number; seq: number; items: LiveItem[];
}
export type CardHead = Omit<LiveCard, 'items'>;
export type LiveMessage = { type: 'event'; card: CardHead; item: LiveItem } | { type: 'remove'; ticket: string } | { type: 'context'; usage: ContextUsage };

const TERMINAL = new Set(['reply_sent', 'failed', 'fallback']);
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
  if (e.stage === 'received' || e.stage === 'recovered') { add('', d.text, 80); add('来自 ', d.sender, 40); add('', d.operation); }
  else if (e.stage === 'routed') { add('路由 ', d.route); add('前缀 ', d.prefix, 20); }
  else if (e.stage === 'dispatched') { add('后端 ', d.backend); add('第 ', d.attempts !== undefined ? `${String(d.attempts)} 次` : undefined); add('会话 ', d.conversation_key ?? d.thread_id); }
  else if (e.stage === 'thread_wait') { add('线程 ', d.thread_key ?? d.conversation_key); }
  else if (e.stage === 'model_turn') {
    add('', d.provider && d.model ? `${String(d.provider)}/${String(d.model)}` : d.backend);
    add('强度 ', d.effort);
    if (typeof d.input_tokens === 'number') parts.push(`输入 ${d.input_tokens} / 输出 ${String(d.output_tokens ?? 0)} tokens`);
    if (e.status !== 'started') add('', d.raw_reply ?? d.reply, 100);
  }
  else if (e.stage === 'model_usage') { if (typeof d.input_tokens === 'number') parts.push(`输入 ${d.input_tokens} / 输出 ${String(d.output_tokens ?? 0)} tokens`); }
  else if (e.stage.startsWith('tool:')) { add('', d.command ?? d.query ?? d.input, 140); if (e.status !== 'started') add('→ ', d.error ?? (typeof d.exit_code === 'number' ? `exit ${d.exit_code}` : undefined), 80); add('', d.server); }
  else if (e.stage.startsWith('image:')) { add('', d.prompt, 100); add('任务 ', d.prompt_id, 40); if (Array.isArray(d.images)) parts.push(`${d.images.length} 张图`); }
  else if (e.stage === 'postprocess') { add('模式 ', d.mode); if (d.relayed !== undefined) parts.push(d.relayed ? '已整理' : '仅清洗'); }
  else if (TERMINAL.has(e.stage)) { add('', d.reply, 100); add('', d.reason ?? d.failure); }
  else if (e.stage === 'settings_changed') add('', d.changed);
  else if (e.stage === 'context_usage' && typeof d.usedTokens === 'number' && typeof d.windowTokens === 'number')
    parts.push(`上下文 ${fmtShort(d.usedTokens)} / ${fmtShort(d.windowTokens)}（${fmtPct(ratio(d.usedTokens, d.windowTokens))}）`);
  if (e.status === 'failed' && typeof d.error_category === 'string' && !parts.some(p => p.includes('error'))) parts.push(`错误类别 ${d.error_category}`);
  return parts.join(' · ').slice(0, 240);
}

export interface LiveBusOptions { maxItems?: number; maxFinished?: number; finishedTtlMs?: number; maxCards?: number; pruneIntervalMs?: number; now?: () => number }

export class LiveBus {
  private readonly cards = new Map<string, LiveCard & { open: { stage: string; ts: number }[] }>();
  private readonly subscribers = new Set<(m: LiveMessage) => void>();
  private readonly off: () => void;
  private readonly o: Required<LiveBusOptions>;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(trace: Pick<Trace, 'tap'>, options: LiveBusOptions = {}) {
    this.o = { maxItems: 80, maxFinished: 30, finishedTtlMs: 30 * 60_000, maxCards: 300, pruneIntervalMs: 60_000, now: Date.now, ...options };
    this.off = trace.tap(e => this.ingest(e));
    // 完成卡片的过期淘汰不依赖有人打开页面
    this.timer = setInterval(() => this.prune(), this.o.pruneIntervalMs); this.timer.unref();
  }

  close(): void { clearInterval(this.timer); this.off(); this.subscribers.clear(); }
  subscribe(fn: (m: LiveMessage) => void): () => void { this.subscribers.add(fn); return () => { this.subscribers.delete(fn); }; }

  /** 当前全部卡片（进行中在前，按开始时间）；用于页面首屏与 SSE 首帧。 */
  snapshot(): LiveCard[] {
    this.prune();
    const order = (c: LiveCard) => (c.finished === null ? 0 : 1);
    return [...this.cards.values()].map(({ open: _open, ...card }) => ({ ...card, items: [...card.items] }))
      .sort((a, b) => order(a) - order(b) || (a.finished === null ? a.started - b.started : (b.finished ?? 0) - (a.finished ?? 0)));
  }

  private head(card: LiveCard & { open?: unknown }): CardHead { const { items: _items, open: _open, ...head } = card; return head; }

  ingest(e: LiveEvent): void {
    if (e.stage === 'context_usage') {
      const usage = toContextUsage(e.detail);
      if (usage) this.publish({ type: 'context', usage });
    }
    if (e.ticket.startsWith('@')) return; // 设置变更、压缩等系统事件不是会话
    const terminal = TERMINAL.has(e.stage) && e.detail.terminal === true;
    let card = this.cards.get(e.ticket);
    if (!card) {
      if (terminal) return; // 重启前的票据只剩终态：不凭空造卡
      card = { ticket: e.ticket, scope: e.scope, text: '', sender: '', route: '', backend: '', thread: '', state: 'queued', phase: '', phase_since: e.ts,
        started: e.ts, updated: e.ts, finished: null, outcome: '', late_images: 0, dropped: 0, seq: 0, items: [], open: [] };
      this.cards.set(e.ticket, card);
      if (this.cards.size > this.o.maxCards) this.prune(true);
    }
    const d = e.detail;
    if (e.scope && !card.scope) card.scope = e.scope;
    if (e.stage === 'received' || (e.stage === 'recovered' && d.text !== undefined)) {
      card.text = s(d.text, 500); card.sender = s(d.sender, 60);
      if (typeof d.route === 'string') card.route = d.route;
    }
    if (e.stage === 'routed' && typeof d.route === 'string') card.route = d.route;
    if (e.stage === 'dispatched' && card.state === 'queued') card.state = 'running';
    if (typeof d.backend === 'string' && (e.stage.startsWith('backend:') || e.stage === 'dispatched' || (!card.backend && e.stage.startsWith('image:')))) card.backend = d.backend;
    if (e.stage.startsWith('backend:')) card.backend = e.stage.slice(8);
    if (e.stage === 'thread_wait' || e.stage === 'dispatched' || e.stage === 'model_turn') {
      const k = d.thread_key ?? d.conversation_key;
      if (typeof k === 'string' && /^(owner|shared|(?:group|private):\d+)$/.test(k)) card.thread = k;
    }
    if (e.stage === 'late_images' && e.status === 'started') card.late_images++;
    if (card.state === 'queued' && e.status === 'started') card.state = 'running';
    // 阶段栈：started 入栈；结束事件弹出该阶段及其之后打开的子阶段
    if (e.status === 'started') {
      if (!card.open.some(o => o.stage === e.stage)) card.open.push({ stage: e.stage, ts: e.ts });
    } else {
      const i = card.open.map(o => o.stage).lastIndexOf(e.stage);
      if (i >= 0) card.open.splice(i);
    }
    const top = card.open.at(-1);
    if ((top?.stage ?? '') !== card.phase) { card.phase = top?.stage ?? ''; card.phase_since = top?.ts ?? e.ts; }
    if (terminal) {
      card.finished = e.ts; card.outcome = e.stage; card.state = e.stage === 'reply_sent' ? 'done' : 'failed';
      card.open = []; card.phase = ''; card.phase_since = e.ts;
    }
    card.updated = e.ts;
    const item: LiveItem = { seq: ++card.seq, ts: e.ts, stage: e.stage, status: e.status, duration_ms: e.duration_ms, summary: summarize(e) };
    card.items.push(item);
    if (card.items.length > this.o.maxItems) { card.items.splice(0, card.items.length - this.o.maxItems); card.dropped++; }
    this.publish({ type: 'event', card: this.head(card), item });
    if (terminal) this.prune();
  }

  private prune(force = false): void {
    const now = this.o.now();
    const finished = [...this.cards.values()].filter(c => c.finished !== null).sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0));
    finished.forEach((c, i) => {
      if (i >= this.o.maxFinished || now - (c.finished ?? 0) > this.o.finishedTtlMs) this.drop(c.ticket);
    });
    if (force && this.cards.size > this.o.maxCards) {
      // 极端情况下（大量未终态票据）按最久未更新淘汰
      const stale = [...this.cards.values()].sort((a, b) => a.updated - b.updated).slice(0, this.cards.size - this.o.maxCards);
      for (const c of stale) this.drop(c.ticket);
    }
  }

  private publish(msg: LiveMessage): void {
    for (const fn of this.subscribers) { try { fn(msg); } catch { /* 慢客户端由 SSE 层断开 */ } }
  }

  private drop(ticket: string): void {
    this.cards.delete(ticket);
    this.publish({ type: 'remove', ticket });
  }
}
