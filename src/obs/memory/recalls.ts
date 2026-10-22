import { isDeepStrictEqual } from 'node:util';
import type { SQLInputValue } from 'node:sqlite';
import { RESPONSE_BYTES } from '../sessions/content.js';
import { SessionError, type ObservedTurn, type SessionRef } from '../sessions/types.js';
import type { MemoryDeps, RecallEvent, RequestEvidence } from './types.js';
import type { MemoryReader } from './read.js';

type RecallRow = Omit<RecallEvent, 'args' | 'returned' | 'is_error' | 'turn_href'> & {
  args_json: string; returned_json: string; is_error: number;
};
export interface RecallFilters {
  scope?: string; session?: string; turn_id?: string; backend?: 'codex' | 'pi'; tool?: string; since?: number; page: number; turn?: string;
}
const backendOf = (backend: string): backend is SessionRef['backend'] => backend === 'codex' || backend === 'pi';
function window(turns: ObservedTurn[], index: number) {
  const turn = turns[index];
  return { lower: Math.max(turn.started - 120_000, (turns[index - 1]?.started ?? -Infinity) + 1),
    upper: Math.min(turn.ended ?? turn.started + 120_000, (turns[index + 1]?.started ?? Infinity) - 1) };
}

/** 每个 HTTP 请求缓存会话的 O1 回合索引；不调用 O3 重建或扫描其它会话。 */
export class RecallReader {
  private cache = new Map<string, Promise<ObservedTurn[]>>();
  constructor(private deps: MemoryDeps) {}
  private turns(backend: string, session: string): Promise<ObservedTurn[]> {
    const key = JSON.stringify([backend, session]);
    if (!this.cache.has(key)) this.cache.set(key, (async () => {
      try { return backendOf(backend) ? [...await this.deps.sessionAdapters?.[backend]?.turns(session) ?? []].sort((a, b) => a.started - b.started) : []; }
      catch { return []; }
    })());
    return this.cache.get(key)!;
  }
  private async locate(row: RecallRow): Promise<ObservedTurn | undefined> {
    if (!row.session) return undefined;
    const turns = await this.turns(row.backend, row.session);
    const candidates = turns.filter((_, i) => { const w = window(turns, i); return row.ts >= w.lower && row.ts <= w.upper; })
      .sort((a, b) => {
        const contains = (t: ObservedTurn) => Number(row.ts >= t.started && row.ts <= (t.ended ?? t.started + 120_000));
        return contains(b) - contains(a) || Math.abs(row.ts - a.started) - Math.abs(row.ts - b.started);
      });
    if (candidates.length > 1 && candidates[0].started === candidates[1].started) return undefined;
    return candidates[0];
  }
  private event(row: RecallRow, turn?: ObservedTurn): RecallEvent {
    const { args_json, returned_json, is_error, ...fields } = row;
    return { ...fields, args: JSON.parse(args_json), returned: JSON.parse(returned_json), is_error: !!is_error,
      turn_href: turn && row.session ? `/agents/${row.backend}/sessions/${encodeURIComponent(row.session)}/turns/${encodeURIComponent(turn.turn)}` : null };
  }
  private db() {
    if (this.deps.store.degraded) throw new SessionError(503, '记忆观测暂不可用');
    return this.deps.store.db;
  }
  async list(filters: RecallFilters) {
    const clauses: string[] = [], args: SQLInputValue[] = [];
    for (const key of ['scope', 'session', 'turn_id', 'backend', 'tool'] as const) if (filters[key] !== undefined) {
      clauses.push(`${key === 'scope' ? 'scope_hint' : key}=?`); args.push(filters[key]!);
    }
    if (filters.since !== undefined) { clauses.push('ts>=?'); args.push(filters.since); }
    if (filters.turn !== undefined) {
      if (!filters.session) throw new SessionError(400, 'turn 必须同时提供 session');
      const windows: string[] = [];
      for (const backend of filters.backend ? [filters.backend] : ['codex', 'pi']) {
        const turns = await this.turns(backend, filters.session), index = turns.findIndex(t => t.turn === filters.turn);
        if (index === -1) continue;
        const w = window(turns, index);
        windows.push('(backend=? AND ts>=? AND ts<=?)'); args.push(backend, w.lower, w.upper);
      }
      clauses.push(windows.length ? `(${windows.join(' OR ')})` : '0');
    }
    const rows = this.db().prepare(`SELECT * FROM recall_events WHERE ${clauses.join(' AND ') || '1'} ORDER BY ts DESC,id DESC LIMIT 51 OFFSET ?`)
      .all(...args, filters.page * 50) as unknown as RecallRow[];
    const items = await Promise.all(rows.slice(0, 50).map(async row => this.event(row, await this.locate(row))));
    return { items, page: filters.page, has_more: rows.length > 50 };
  }
  private async evidence(row: RecallRow, turn?: ObservedTurn): Promise<RequestEvidence> {
    if (!turn || !row.session || !backendOf(row.backend)) return { status: 'unavailable', note: '无法定位 O1 回合；新线程可能尚无 session。' };
    const adapter = this.deps.sessionAdapters?.[row.backend];
    if (!adapter) return { status: 'unavailable', note: 'O1 适配器不可用。' };
    try {
      const tool = row.tool.startsWith('qq_') ? row.tool : `qq_${row.tool}`;
      const names = row.backend === 'codex' ? [tool, `mcp__qq_context__${tool}`, `mcp__qq_context__${tool.slice(3)}`] : [tool];
      const expected: unknown = JSON.parse(row.args_json);
      const blocks = await adapter.blocks(row.session, turn.turn);
      const matching = [];
      for (const block of blocks) {
        if (block.kind !== 'tool_call' || !names.includes(String(block.meta?.name)) || block.ts === undefined || Math.abs(block.ts - row.ts) > 120_000 || !block.callId) continue;
        const text = block.text ?? (block.ref && block.ref.bytes <= RESPONSE_BYTES ? await adapter.content(block.ref) : undefined);
        if (text === undefined) continue;
        let actual: unknown;
        try { actual = JSON.parse(text); } catch { continue; }
        // O1 已脱敏时严格比较可能不命中；不能把两个不同秘密脱敏成同一占位符后误报 confirmed。
        if (isDeepStrictEqual(actual, expected)) matching.push(block);
      }
      matching.sort((a, b) => Math.abs(a.ts! - row.ts) - Math.abs(b.ts! - row.ts));
      const match = matching[0];
      if (match) return { status: 'confirmed', turn: turn.turn, call_id: match.callId,
        note: 'O1 存在同名、同参数且时间差不超过 120 秒的工具调用；不证明结果进入后续请求或被模型采用。' };
      return { status: 'not_found', turn: turn.turn, note: '回合存在，未找到满足名称、原参数和时间窗的工具调用；脱敏或缺失正文也可能导致未匹配。' };
    } catch { return { status: 'unavailable', turn: turn.turn, note: 'O1 回合正文暂不可读取。' }; }
  }
  async detail(id: number, memory: MemoryReader) {
    const row = this.db().prepare('SELECT * FROM recall_events WHERE id=?').get(id) as RecallRow | undefined;
    if (!row) throw new SessionError(404, '召回事件不存在');
    const turn = await this.locate(row), event = this.event(row, turn);
    return { ...event, evidence: { hits: event.returned.map(hit => memory.recallHit(hit, row.access)),
      tool_returned: { count: row.returned_count, chars: row.chars, dropped: row.dropped_count },
      in_request: await this.evidence(row, turn) } };
  }
}
