import type { ObsEvent } from '../shared/trace.js';
import { toContextUsage } from '../shared/format.js';
import { SETTINGS_TICKET } from '../agent/settings.js';
import { analyzeContextTurns, type ContextEvent, type ContextRequestEvent, type ContextTurn, type SystemEvent, type ThreadContextSeries } from './context-turns.js';

const asObj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** 票据页判定所需的最小存储接口（ObsStore 满足）。 */
export interface TicketTurnStore {
  previousContextTurn(backend: 'codex' | 'pi', key: string, beforeTs: number): ContextEvent | undefined;
  contextSeries(opts: { backend?: string; key?: string; since?: number; limit?: number }): ThreadContextSeries[];
  systemEvents(ticket: string, limit?: number): ObsEvent[];
}

/** model_request 事件 detail → 分析输入；字段校验与 ObsStore 的序列读取一致，不合格返回 undefined。 */
function requestEvent(ticket: string, d: Record<string, unknown>): ContextRequestEvent | undefined {
  const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const int = (v: unknown): v is number => n(v) && Number.isInteger(v) && v >= 1;
  if ((d.backend !== 'codex' && d.backend !== 'pi') || typeof d.key !== 'string' || !d.key || d.key.length > 64 ||
      !n(d.input) || !n(d.window) || d.window === 0 || !n(d.at) || !int(d.seq) || !int(d.turn)) return;
  return { ts: d.at, ticket, kind: 'request', detail: {
    backend: d.backend, key: d.key, ticket, seq: d.seq, turn: d.turn, input: d.input, window: d.window, at: d.at,
    ...(n(d.cached) ? { cached: d.cached } : {}), ...(n(d.output) ? { output: d.output } : {}),
    ...(n(d.effective_window) && d.effective_window > 0 ? { effective_window: d.effective_window } : {}),
  } };
}

/**
 * 票据页的命中判定（设计 §3、§8.4）：本票据的 model_request（旧票据退回 context_usage 的 turn 记录）按请求判定，
 * 基准取该线程此票据之前最近一条请求。优先用与 /context-usage 同一条序列（从基准起，含期间压缩记录与
 * @settings 原因）；基准不在该有界序列开头或请求不全时，退回只分析"基准 + 本票据记录"。返回本票据全部请求，按 seq。
 */
export function ticketContextTurns(store: TicketTurnStore, ticket: string, events: ObsEvent[]): ContextTurn[] {
  const parsed = events.flatMap((e): ContextEvent[] => {
    if (e.ticket !== ticket || (e.stage !== 'model_request' && e.stage !== 'context_usage')) return [];
    let d: Record<string, unknown>;
    try { d = asObj(JSON.parse(e.detail_json)); } catch { return []; }
    if (e.stage === 'model_request') { const r = requestEvent(ticket, d); return r ? [r] : []; }
    const u = toContextUsage(d);
    return u && u.source !== 'estimate' ? [{ ts: e.ts, ticket, kind: 'usage', detail: u }] : [];
  });
  const isTurn = (e: ContextEvent) => e.kind === 'request' || e.detail.source === 'turn';
  const hasRequests = parsed.some(e => e.kind === 'request');
  const anchor = parsed.filter(e => hasRequests ? e.kind === 'request' : isTurn(e)).at(-1);
  if (!anchor) return [];
  const { backend, key } = anchor.detail;
  const own = parsed.filter(e => e.detail.backend === backend && e.detail.key === key).sort((a, b) => a.ts - b.ts);
  const expected = own.filter(e => hasRequests ? e.kind === 'request' : isTurn(e)).length;
  const mine = (turns: ContextTurn[]) => turns.filter(t => t.ticket === ticket && t.source === 'turn').sort((a, b) => a.seq - b.seq || a.ts - b.ts);
  const prev = store.previousContextTurn(backend, key, own[0]!.ts);
  if (prev) {
    const turns = store.contextSeries({ backend, key, since: prev.ts, limit: 200 })[0]?.turns ?? [];
    const hits = mine(turns);
    if (hits.length === expected && turns[0]?.ts === prev.ts) return hits;
  }
  const system: SystemEvent[] = store.systemEvents(SETTINGS_TICKET, 200)
    .filter(e => e.stage === 'settings_changed' || e.stage === 'prompt_changed')
    .map(e => ({ ts: e.ts, stage: e.stage, detail: asObj(JSON.parse(e.detail_json)) }));
  return mine(analyzeContextTurns([...(prev ? [prev] : []), ...own], system));
}
