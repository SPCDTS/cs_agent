import type { ServerResponse } from 'node:http';
import type { SseWriter } from '../http-util.js';
import { redactSessionValue, RESPONSE_BYTES, utf8Slice } from './content.js';
import { validateTraceRef } from './trace-content.js';
import { SessionError, type SessionAdapter, type SessionFilter, type SessionRef, type ThreadTopology } from './types.js';
import { topologyRows } from '../topology.js';

export type SessionAdapters = Partial<Record<SessionRef['backend'], SessionAdapter>>;
const BACKENDS = ['codex', 'pi'] as const;

/** 响应上限按 JSON 编码后的字节计算，不能只计算正文（引号和控制符会膨胀）。 */
export function sessionJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(redactSessionValue(value));
  if (Buffer.byteLength(body) > RESPONSE_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ error: '响应超过 1 MiB，请缩小查询范围' }));
  } else res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
}

function integer(raw: string | null, name: string, fallback?: number): number {
  if (raw === null && fallback !== undefined) return fallback;
  if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) throw new SessionError(400, `${name} 必须是非负整数`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new SessionError(400, `${name} 超出范围`);
  return n;
}

export function segment(raw: string): string {
  let value: string;
  try { value = decodeURIComponent(raw); } catch { throw new SessionError(400, '路径编码无效'); }
  if (!value || value.length > 256 || value === '.' || value === '..' || /[\\/\x00-\x1f\x7f]/.test(value))
    throw new SessionError(400, '会话或回合 ID 无效');
  return value;
}

function filter(q: URLSearchParams): SessionFilter {
  const status = q.get('status') || undefined, scope = q.get('scope') || undefined;
  if (status !== undefined && status !== 'active' && status !== 'archived') throw new SessionError(400, 'status 必须是 active 或 archived');
  if (scope && (scope.length > 256 || /[\x00-\x1f]/.test(scope))) throw new SessionError(400, 'scope 无效');
  const rawSince = q.get('since');
  const isoTime = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/;
  const since = rawSince ? /^\d+$/.test(rawSince) ? Number(rawSince) : isoTime.test(rawSince) ? Date.parse(rawSince) : NaN : undefined;
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) throw new SessionError(400, 'since 必须是时间戳或 ISO 时间');
  const page = integer(q.get('page'), 'page', 0);
  if (page > 1_000_000) throw new SessionError(400, 'page 超出范围');
  return { status, scope, since, page };
}

/** 索引保存的是原文区间；脱敏后的正文可能更短，truncated 仅表示传输上限裁剪。 */
function contentResponse(text: string): { text: string; truncated: boolean } {
  const safe = redactSessionValue(text) as string;
  if (Buffer.byteLength(JSON.stringify({ text: safe, truncated: false })) <= RESPONSE_BYTES) return { text: safe, truncated: false };
  let lo = 0, hi = Buffer.byteLength(safe);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(JSON.stringify({ text: utf8Slice(safe, 0, mid), truncated: true })) <= RESPONSE_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return { text: utf8Slice(safe, 0, lo), truncated: true };
}

export function sessionLookup(adapters: SessionAdapters) {
  const getAdapter = (backend: string) => {
    if (!BACKENDS.includes(backend as SessionRef['backend'])) throw new SessionError(404, '后端不存在');
    return adapters[backend as SessionRef['backend']];
  };
  const findSession = async (adapter: SessionAdapter | undefined, id: string) => {
    const session = (await adapter?.listSessions())?.find(s => s.id === id);
    if (!session || !adapter) throw new SessionError(404, '会话不存在或尚未索引');
    return { session, adapter };
  };
  return { getAdapter, findSession };
}

/** 必须从 dashboard 已通过 cookie/Host 鉴权的分支调用。 */
export function createSessionRoutes(adapters: SessionAdapters, sse: (res: ServerResponse) => SseWriter | null, topology?: () => Promise<ThreadTopology[]>) {
  const { getAdapter, findSession } = sessionLookup(adapters);
  return async function handleSessionRoute(url: URL, res: ServerResponse): Promise<void> {
    try {
      const p = url.pathname, q = url.searchParams;
      if (p === '/api/agents') {
        const summaries = await Promise.all(BACKENDS.map(async backend => {
          const adapter = adapters[backend], sessions = await adapter?.listSessions() ?? [];
          return { backend, sessions_active: sessions.filter(s => s.status === 'active').length,
            sessions_archived: sessions.filter(s => s.status === 'archived').length,
            last_turn_at: sessions.length ? sessions.reduce((last, s) => Math.max(last, s.updated), 0) : null,
            indexing: adapter?.progress ?? { indexing: false, files: 0, done: 0 } };
        }));
        sessionJson(res, 200, summaries); return;
      }
      if (p === '/api/agents/topology') {
        if (!topology) throw new SessionError(404, '拓扑数据源未接入');
        const thread = q.get('thread') ?? undefined;
        const rows = await topologyRows(await topology(), adapters, { brief: q.get('brief') === '1', ...(thread !== undefined ? { thread } : {}) });
        if (thread !== undefined && !rows.length) throw new SessionError(404, '没有这个会话的拓扑');
        sessionJson(res, 200, rows); return;
      }
      if (p === '/agents/stream') {
        const id = segment(q.get('session') ?? '');
        const { session, adapter } = await findSession(getAdapter(q.get('backend') ?? ''), id);
        if (session.status !== 'active') throw new SessionError(409, '归档会话不提供实时订阅');
        if (!adapter.subscribe) throw new SessionError(503, '后端实时订阅暂不可用');
        const out = sse(res); if (!out) return;
        const off = adapter.subscribe(id, frame => {
          if (res.destroyed || res.writableEnded) return;
          const body = JSON.stringify(redactSessionValue(frame));
          if (Buffer.byteLength(body) <= RESPONSE_BYTES - 32) out.send(`event: block\ndata: ${body}\n\n`);
          else { out.send('event: error\ndata: {"error":"正文块超过响应上限，请重新读取回合"}\n\n'); res.end(); }
        });
        if (res.destroyed || res.writableEnded) off();
        else res.on('close', off);
        return;
      }
      const parts = p.split('/');
      if (parts[1] !== 'api' || parts[2] !== 'agents' || parts[4] !== 'sessions') throw new SessionError(404, '接口不存在');
      const adapter = getAdapter(segment(parts[3] ?? ''));
      if (parts.length === 5) {
        const filters = filter(q);
        sessionJson(res, 200, await adapter?.listSessions(filters) ?? []); return;
      }
      const id = segment(parts[5] ?? '');
      const found = await findSession(adapter, id);
      if (parts.length === 6) {
        sessionJson(res, 200, { session: found.session, turns: await found.adapter.turns(id) }); return;
      }
      if (parts.length === 8 && parts[6] === 'turns') {
        const turnId = segment(parts[7]!);
        const turn = (await found.adapter.turns(id)).find(t => t.turn === turnId);
        if (!turn) throw new SessionError(404, '回合不存在');
        sessionJson(res, 200, { turn, blocks: await found.adapter.blocks(id, turnId) }); return;
      }
      if (parts.length === 7 && parts[6] === 'trace-content') {
        if (parts[3] !== 'codex' || !found.adapter.traceContent) throw new SessionError(404, '后端不提供 trace 正文');
        if (['bundle', 'payload', 'select'].some(key => q.getAll(key).length !== 1)
          || ['offset', 'length', 'page'].some(key => q.has(key))) throw new SessionError(400, 'trace 正文参数无效');
        const ref = { bundle: q.get('bundle')!, payload: q.get('payload')!, select: q.get('select')! };
        validateTraceRef(id, ref);
        const text = await found.adapter.traceContent(id, ref);
        if (text === undefined) throw new SessionError(404, 'trace 正文不存在');
        sessionJson(res, 200, contentResponse(text)); return;
      }
      if (parts.length === 7 && parts[6] === 'content') {
        const offset = integer(q.get('offset'), 'offset'), length = integer(q.get('length'), 'length');
        if (length === 0 || !Number.isSafeInteger(offset + length)) throw new SessionError(400, '正文范围无效');
        // 大块允许请求整个已索引区间；最终 JSON 会按 1 MiB 上限截断并明确标记。
        const text = await found.adapter.content({ session: id, offset, length, bytes: length });
        sessionJson(res, 200, contentResponse(text)); return;
      }
      throw new SessionError(404, '接口不存在');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      sessionJson(res, error instanceof SessionError ? error.status : 500,
        { error: error instanceof SessionError ? error.message : '会话读取暂不可用' });
    }
  };
}
