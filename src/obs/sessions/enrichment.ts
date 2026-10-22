import type { ObsStore } from '../store.js';
import type { ObservedTurn, SessionRef, TurnIndex } from './types.js';

/** 只用派发 ID 与时间关联宿主回合（trace 键 turn:<id>）；正文、模型用量与回合边界始终来自后端事实源。 */
export function enrichTurns(store: ObsStore, backend: SessionRef['backend'], id: string, turns: TurnIndex[]): ObservedTurn[] {
  if (store.degraded || !turns.length) return turns.map(turn => ({ ...turn }));
  const field = backend === 'codex' ? 'thread_id' : 'conversation';
  const rows = store.db.prepare(`SELECT key,ts FROM events WHERE stage='dispatched'
    AND json_extract(detail_json,'$.backend')=? AND CAST(json_extract(detail_json,'$.${field}') AS TEXT)=?
    AND ts>=? AND ts<=? ORDER BY ts`).all(backend, id,
      turns.reduce((min, t) => Math.min(min, t.started), Infinity) - 120_000,
      turns.reduce((max, t) => Math.max(max, t.ended ?? t.started), 0) + 120_000) as { key: string; ts: number }[];
  const used = new Set<string>();
  return turns.map((turn, index) => {
    const lower = Math.max(turn.started - 120_000, (turns[index - 1]?.started ?? -Infinity) + 1);
    const upper = Math.min(turn.ended ?? turn.started + 120_000, (turns[index + 1]?.started ?? Infinity) - 1);
    const candidates = rows.filter(row => row.ts >= lower && row.ts <= upper && !used.has(row.key))
      .sort((a, b) => Math.abs(a.ts - turn.started) - Math.abs(b.ts - turn.started));
    const match = candidates[0];
    // 时间同样接近的不同回合不强行归属。
    if (!match || candidates[1] && candidates[1].key !== match.key &&
        Math.abs(candidates[1].ts - turn.started) === Math.abs(match.ts - turn.started)) return { ...turn };
    used.add(match.key);
    const first = store.db.prepare('SELECT MIN(ts) ts,MAX(scope) scope FROM events WHERE key=?')
      .get(match.key) as { ts: number; scope: string };
    const terminal = store.db.prepare(`SELECT stage,ts,detail_json FROM events WHERE key=?
      AND stage IN ('reply_sent','failed') AND json_extract(detail_json,'$.terminal')=1 ORDER BY id DESC LIMIT 1`)
      .get(match.key) as { stage: string; ts: number; detail_json: string } | undefined;
    const recorded = terminal ? JSON.parse(terminal.detail_json).status : undefined;
    const status = typeof recorded === 'string' ? recorded : terminal ? (terminal.stage === 'failed' ? 'failed' : 'completed') : 'processing';
    return { ...turn, traceKey: match.key, delivery: { status,
      scope: first.scope || undefined,
      duration_ms: terminal ? Math.max(0, terminal.ts - first.ts) : undefined } };
  });
}
