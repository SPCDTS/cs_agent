/**
 * 记忆条目接口（docs/DASHBOARD.md §8.4、docs/MEMORY-DESIGN.md §10）：
 * GET /api/memory/entries?ns=&kind=&status=&q=&page= 与 /api/memory/entries/<id>（经 memory/http.ts 的只读路由，统一脱敏）；
 * POST /api/memory/entries/<id>/{forget,restore}（JSON，同源 + CSRF，与 /api/schedules 相同的写入约束）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MEMORY_KINDS, MEMORY_STATUSES, isMemoryNs, type MemoryRow } from '../../context/memory/types.js';
import { scopeLabel } from '../../context/access.js';
import { equal, guardDashboardOrigin, HttpError } from '../dashboard-io.js';
import { sessionJson } from '../sessions/http.js';
import { SessionError } from '../sessions/types.js';
import { log } from '../../shared/log.js';
import type { MemoryEntriesSource, MemoryEntry, MemoryEntryDetail, MemoryEntryPage } from './types.js';

export const MEMORY_ENTRY_PAGE = 50;
const HOUR = 3600_000;
const ms = (sec: number | null) => sec === null ? null : sec * 1000;

function toEntry(src: MemoryEntriesSource, row: MemoryRow): MemoryEntry {
  const label = (scope: string) => src.scopeLabel?.(scope) ?? scopeLabel(scope);
  const at = row.created_at * 1000;
  return { id: row.id, ns: row.ns, ns_label: row.ns === 'owner' ? 'owner 私聊' : label(row.ns), kind: row.kind, subject: row.subject, text: row.text,
    status: row.status, author: row.author, since: ms(row.since), until: ms(row.until), due_at: ms(row.due_at), done_at: ms(row.done_at),
    confidence: row.confidence, created_at: at, updated_at: row.updated_at * 1000, last_recalled_at: ms(row.last_recalled_at), recall_count: row.recall_count,
    source: row.source_scope ? { scope: row.source_scope, label: label(row.source_scope), message_id: row.source_message_id, turn_id: row.source_turn_id,
      timeline_href: `/memory/scopes/${encodeURIComponent(row.source_scope)}?from=${at - HOUR}&to=${at + HOUR}` } : null };
}

function parameters(q: URLSearchParams, allowed: string[]): void {
  for (const key of q.keys()) if (!allowed.includes(key) || q.getAll(key).length !== 1) throw new SessionError(400, '查询参数未知或重复');
}

/** GET /api/memory/entries：面板管理员视角，可见全部命名空间与状态；最近更新在前，每页 50 条。 */
export function memoryEntryList(src: MemoryEntriesSource, q: URLSearchParams): MemoryEntryPage {
  parameters(q, ['ns', 'kind', 'status', 'q', 'page']);
  const ns = q.get('ns') || undefined, kind = q.get('kind') || undefined, status = q.get('status') || undefined;
  if (ns !== undefined && !isMemoryNs(ns)) throw new SessionError(400, 'ns 必须是 owner、group:<群号> 或 private:<QQ号>');
  if (kind !== undefined && !(MEMORY_KINDS as readonly string[]).includes(kind)) throw new SessionError(400, 'kind 无效');
  if (status !== undefined && !(MEMORY_STATUSES as readonly string[]).includes(status)) throw new SessionError(400, 'status 无效');
  const rawPage = q.get('page') || '0';
  if (!/^(0|[1-9]\d{0,5})$/.test(rawPage)) throw new SessionError(400, 'page 必须是非负整数');
  const page = Number(rawPage), query = (q.get('q') ?? '').trim().slice(0, 100);
  const { items, total } = src.store.browse({ ns, kind: kind as MemoryRow['kind'] | undefined, status: status as MemoryRow['status'] | undefined,
    query, limit: MEMORY_ENTRY_PAGE, offset: page * MEMORY_ENTRY_PAGE });
  const label = (scope: string) => scope === 'owner' ? 'owner 私聊' : src.scopeLabel?.(scope) ?? scopeLabel(scope);
  return { items: items.map(row => toEntry(src, row)), total, page, has_more: (page + 1) * MEMORY_ENTRY_PAGE < total,
    namespaces: src.store.namespaces().map(n => ({ ns: n, label: label(n) })) };
}

/** GET /api/memory/entries/<id>：条目、版本历史（只给状态变化与正文是否改动）、取代链。 */
export function memoryEntryDetail(src: MemoryEntriesSource, rawId: string): MemoryEntryDetail {
  if (!/^[1-9]\d{0,15}$/.test(rawId)) throw new SessionError(400, 'id 必须是正整数');
  const row = src.store.get(Number(rawId));
  if (!row) throw new SessionError(404, '记忆条目不存在');
  const versions = src.store.versions(row.id).map(v => {
    const after = JSON.parse(v.after_json) as Partial<MemoryRow>, before = v.before_json ? JSON.parse(v.before_json) as Partial<MemoryRow> : null;
    return { id: v.id, at: v.at * 1000, by: v.by, reason: v.reason, status_before: before?.status ?? null, status_after: after.status ?? '',
      text_changed: !!before && before.text !== after.text };
  });
  return { entry: toEntry(src, row), versions, links: src.store.links(row.id).map(l => ({ ...l, created_at: l.created_at * 1000 })) };
}

export const MEMORY_ENTRY_ACTION = /^\/api\/memory\/entries\/([1-9]\d{0,15})\/(forget|restore)$/;

/** 面板遗忘 / 恢复（表单与 JSON 接口共用）；未知 id 为 404，恢复非遗忘条目为 409。 */
export function applyMemoryEntryAction(src: MemoryEntriesSource, id: number, action: 'forget' | 'restore'): void {
  const row = src.store.get(id);
  if (!row) throw new HttpError(404, '记忆条目不存在');
  if (action === 'restore' && row.status !== 'forgotten') throw new HttpError(409, '该条目未被遗忘，无需恢复');
  if (action === 'forget') src.forget(id); else src.restore(id);
}

/**
 * 记忆写接口的公共校验（条目、画像、整理共用）：同源、只接受 application/json、请求体有界且为 JSON 对象、
 * CSRF 放 X-CSRF-Token 头或 _csrf 字段（与 /api/schedules 相同）。返回去掉 _csrf 的请求体。
 */
export async function readMemoryJsonPost(req: IncomingMessage, host: string, csrf: string, maxBytes = 4096): Promise<Record<string, unknown>> {
  guardDashboardOrigin(req, host);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, '只接受 application/json');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) { req.resume(); throw new HttpError(413, '提交内容过大'); }
    chunks.push(bytes);
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch { throw new HttpError(400, '请求体必须是 JSON 对象'); }
  const supplied = req.headers['x-csrf-token'] ?? body._csrf;
  if (!csrf || typeof supplied !== 'string' || !equal(supplied, csrf)) throw new HttpError(403, 'CSRF 令牌无效，请刷新页面后重试');
  delete body._csrf;
  return body;
}

/** POST /api/memory/entries/<id>/{forget,restore}：只接受 application/json，CSRF 放 X-CSRF-Token 头或 _csrf 字段。 */
export function createMemoryEntryActions(src: MemoryEntriesSource | undefined, csrf: string) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, host: string): Promise<void> => {
    try {
      if (!src) throw new HttpError(404, '记忆条目未启用');
      const match = MEMORY_ENTRY_ACTION.exec(url.pathname);
      if (!match) throw new HttpError(404, '接口不存在');
      const body = await readMemoryJsonPost(req, host, csrf);
      if (Object.keys(body).length) throw new HttpError(400, '此操作不接受额外字段');
      const id = Number(match[1]);
      applyMemoryEntryAction(src, id, match[2] as 'forget' | 'restore');
      sessionJson(res, 200, memoryEntryDetail(src, String(id)));
    } catch (error) {
      const expected = error instanceof HttpError || error instanceof SessionError;
      if (!expected) log.error('memory entry action failed', { error });
      sessionJson(res, expected ? error.status : 500, { error: expected ? error.message : '操作失败，详见日志' });
    }
  };
}
