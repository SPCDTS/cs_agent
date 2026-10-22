import { ImageReader, type ImageFilters } from './images.js';
import { summaryLineage } from "./lineage.js";
import { RecallReader, type RecallFilters } from "./recalls.js";
import type { ServerResponse } from 'node:http';
import { parseAccess, type Access } from '../../context/access.js';
import { AGING_LAST_RUN_KEY, type AgingReport } from '../../context/aging.js';
import { DEFAULT_CONTEXT_MAX_CHARS, formatMessage, formatSummary } from '../../context/format.js';
import { callQQContextTool } from '../../context/qq-context-tool.js';
import { sessionJson } from '../sessions/http.js';
import { redactSessionValue } from '../sessions/content.js';
import { SessionError } from '../sessions/types.js';
import { memoryArchives } from './archives.js';
import { MemoryReader, preview, safeText } from './read.js';
import type { AgingStatus, Hit, MemoryDeps } from './types.js';

function integer(raw: string | null, name: string, fallback: number, max: number): number {
  if (raw === null) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max)
    throw new SessionError(400, `${name} 必须是 1 至 ${max} 的整数`);
  return Number(raw);
}

function timestamp(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;
  const parts = iso.exec(raw);
  const n = /^\d+$/.test(raw) ? Number(raw) : parts ? Date.parse(raw) : NaN;
  if (parts && (Number(parts[2]) < 1 || Number(parts[2]) > 12 || Number(parts[3]) < 1 ||
    Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate()))
    throw new SessionError(400, `${name} 日期无效`);
  if (!Number.isSafeInteger(n) || n < 0 || n >= 8.64e15) throw new SessionError(400, `${name} 必须是毫秒时间戳或 ISO 日期`);
  return n;
}

function cursorId(raw: string | null, name: string, time: number | undefined): number | undefined {
  if (raw === null) return undefined;
  if (time === undefined) throw new SessionError(400, `${name} 必须与 ${name.slice(0, -3)} 同时提供`);
  return integer(raw, name, 0, Number.MAX_SAFE_INTEGER);
}

function scopeValue(raw: string): string {
  if (!raw || raw.length > 256 || raw === '.' || raw === '..' || /[\\/\x00-\x1f\x7f]/.test(raw))
    throw new SessionError(400, 'scope 无效');
  return raw;
}
function segment(raw: string): string {
  try { return scopeValue(decodeURIComponent(raw)); }
  catch (error) { if (error instanceof SessionError) throw error; throw new SessionError(400, '路径编码无效'); }
}
function parameters(q: URLSearchParams, allowed: string[]): void {
  for (const key of q.keys()) if (!allowed.includes(key) || q.getAll(key).length !== 1)
    throw new SessionError(400, '查询参数未知或重复');
}

function agingStatus(deps: MemoryDeps, now: number): AgingStatus {
  const meta = deps.context.getMeta(AGING_LAST_RUN_KEY);
  const last = deps.aging?.lastRun ? deps.aging.lastRun() : meta === undefined ? undefined : Number(meta) * 1000;
  const last_run = last !== undefined && Number.isSafeInteger(last) && last >= 0 ? last : null;
  const status: AgingStatus = { last_run, next_run: deps.aging?.nextRun() ?? null,
    running: deps.aging?.running() ?? false, catch_up_needed: last_run === null || now - last_run >= 86400_000 };
  const event = deps.store.latest('aging');
  if (event) {
    const report = JSON.parse(event.detail_json) as Record<string, unknown>;
    const keys = ['day_summaries', 'week_summaries', 'failed', 'purged_messages', 'purged_summaries', 'ms'] as const;
    if (keys.every(k => typeof report[k] === 'number' && Number.isFinite(report[k]) && Number(report[k]) >= 0))
      status.last_report = Object.fromEntries(keys.map(k => [k, report[k]])) as unknown as AgingReport;
  }
  return status;
}

function search(deps: MemoryDeps, q: URLSearchParams, reader: MemoryReader) {
  parameters(q, ['scope', 'q', 'days', 'limit']);
  const query = (q.get('q') ?? '').trim().slice(0, 100);
  if (!query) throw new SessionError(400, 'q 不能为空');
  const scope = q.has('scope') ? scopeValue(q.get('scope')!) : undefined;
  if (scope) reader.extent(scope);
  // 面板管理员可见全部域；scope 只收窄本次检索，与真实对话 QQ_ACCESS 无关。
  const access: Access = scope ? { kind: 'scope', scope } : parseAccess('all')!;
  const days = integer(q.get('days'), 'days', 30, 180), limit = integer(q.get('limit'), 'limit', 10, 20);
  const max_chars = deps.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const items = deps.context.search(access, { query, days, limit });
  const result = callQQContextTool({ access, openStore: () => deps.context, maxChars: max_chars }, 'qq_search', { query, days, limit });
  if (result.isError) throw new SessionError(503, '记忆检索暂不可用');
  const rawText = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  // 逐行按实际 formatter 输出匹配，重复行消耗一次；不能靠字符预算猜测，也不能解析省略说明。
  const lines = rawText.split('\n'), safeLines = lines.map(safeText), consumed = new Set<number>();
  const fmt = { ids: true, showScope: access.kind === 'all' };
  let included = 0;
  for (const item of items) {
    const line = item.kind === 'message' ? formatMessage(item.row, fmt) : formatSummary(item.row, fmt);
    const index = lines.findIndex((value, i) => value === line && !consumed.has(i));
    if (index !== -1) {
      included++; consumed.add(index);
      const safeLine = item.kind === 'message'
        ? formatMessage(redactSessionValue(item.row) as typeof item.row, fmt)
        : formatSummary(redactSessionValue(item.row) as typeof item.row, fmt);
      // 工具先裁剪可能只留下已注册秘密的前半段；两种顺序不一致时遮蔽整行，不能泄露残片。
      if (safeLines[index] !== safeText(safeLine)) safeLines[index] = '[已隐藏：原文含跨裁剪边界的凭据]';
    }
  }
  const terms = query.split(/\s+/).map(t => t.replace(/[%_\\]/g, '')).filter(Boolean).slice(0, 5);
  const hits: Hit[] = items.map(item => {
    const fields = item.kind === 'message' ? { text: item.row.text, detail: item.row.detail ?? '' } : { text: item.row.text };
    // 与 SQLite LIKE 相同，ASCII 大小写不敏感，非 ASCII 保持原样。
    const fold = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());
    const matched = Object.entries(fields).filter(([, text]) => terms.some(t => fold(text).includes(fold(t))));
    const text = safeText(matched[0]?.[1] ?? item.row.text);
    const at = Math.min(...terms.map(t => fold(text).indexOf(fold(t))).filter(i => i >= 0));
    const start = Number.isFinite(at) ? Math.max(0, at - 60) : 0;
    return { kind: item.kind, id: item.kind === 'message' ? item.row.message_id : item.row.id,
      ts: (item.kind === 'message' ? item.row.time : item.row.period_end) * 1000, scope: item.row.scope,
      excerpt: preview(text.slice(start), 240), matched_fields: matched.map(([field]) => field) };
  });
  const tool_text = safeText(safeLines.join('\n'));
  return { hits, tool_text, tool_text_chars: tool_text.length, max_chars, dropped: items.length - included };
}

/** 仅由 dashboard 的已鉴权 GET 分支调用；所有输出复用会话脱敏器与 1 MiB 上限。 */
export function createMemoryRoutes(deps: MemoryDeps) {
  return async function handleMemoryRoute(url: URL, res: ServerResponse): Promise<void> {
    let reader: MemoryReader | undefined;
    let images: ImageReader | undefined;
    try {
      const p = url.pathname, q = url.searchParams, now = deps.now?.() ?? Date.now();
      const retention = deps.aging?.config ?? deps.retention;
      if (p === '/api/memory/images' || /^\/api\/memory\/images\/[^/]+\/[^/]+\/[^/]+$/.test(p)) {
        images = new ImageReader(deps.context);
        if (p === '/api/memory/images') {
          parameters(q, ['scope', 'status', 'since', 'page']);
          const filters: ImageFilters = { page: q.get('page') === '0' ? 0 : integer(q.get('page') || null, 'page', 0, 1_000_000),
            since: timestamp(q.get('since') || null, 'since') };
          if (q.get('scope')) filters.scope = scopeValue(q.get('scope')!);
          if (q.get('status')) {
            const status = q.get('status');
            if (status !== 'ok' && status !== 'skipped') throw new SessionError(400, 'status 必须是 ok 或 skipped');
            filters.status = status;
          }
          sessionJson(res, 200, await images.list(filters)); return;
        }
        parameters(q, []);
        const parts = p.split('/'), ordinal = segment(parts[6]);
        sessionJson(res, 200, await images.detail(segment(parts[4]), segment(parts[5]),
          ordinal === '0' ? 0 : integer(ordinal, 'ordinal', 0, Number.MAX_SAFE_INTEGER))); return;
      }
      if (p === '/api/memory/archives') {
        parameters(q, []); sessionJson(res, 200, await memoryArchives(deps.archives, deps.store)); return;
      }
      if (p === '/api/memory/recalls' || /^\/api\/memory\/recalls\/[^/]+$/.test(p)) {
        const recalls = new RecallReader(deps);
        if (p === '/api/memory/recalls') {
          parameters(q, ['scope', 'session', 'turn_id', 'backend', 'tool', 'since', 'page', 'turn']);
          const filters: RecallFilters = { page: 0, since: timestamp(q.get('since'), 'since') };
          for (const key of ['scope', 'session', 'turn_id', 'turn'] as const) if (q.has(key)) filters[key] = scopeValue(q.get(key)!);
          if (q.has('backend')) {
            const backend = q.get('backend');
            if (backend !== 'pi' && backend !== 'codex') throw new SessionError(400, 'backend 必须是 codex 或 pi');
            filters.backend = backend;
          }
          if (q.has('tool')) {
            const tool = q.get('tool')!;
            if (!['qq_recent', 'qq_search', 'qq_message'].includes(tool)) throw new SessionError(400, 'tool 无效');
            filters.tool = tool;
          }
          if (q.has('page')) filters.page = q.get('page') === '0' ? 0 : integer(q.get('page'), 'page', 0, 1_000_000);
          sessionJson(res, 200, await recalls.list(filters)); return;
        }
        parameters(q, []);
        const id = integer(segment(p.split('/')[4]), 'id', 0, Number.MAX_SAFE_INTEGER);
        reader = new MemoryReader(deps.context);
        sessionJson(res, 200, await recalls.detail(id, reader)); return;
      }
      if (p !== '/api/memory' && p !== '/api/memory/search' && !/^\/api\/memory\/(?:scopes\/[^/]+(?:\/messages)?|summaries\/[^/]+)$/.test(p))
        throw new SessionError(404, '接口不存在');
      reader = new MemoryReader(deps.context);
      if (p === '/api/memory') {
        parameters(q, []);
        sessionJson(res, 200, { scopes: reader.overview(now), aging: agingStatus(deps, now), retention }); return;
      }
      if (p === '/api/memory/search') { sessionJson(res, 200, search(deps, q, reader)); return; }
      const parts = p.split('/');
      if (parts[3] === 'summaries') {
        parameters(q, []); const id = integer(segment(parts[4]), 'id', 0, Number.MAX_SAFE_INTEGER);
        const { lineage, snapshot } = summaryLineage(deps.store, id);
        sessionJson(res, 200, { ...reader.summary(id, snapshot), lineage }); return;
      }
      const scope = segment(parts[4]), extent = reader.extent(scope);
      if (parts[5] === 'messages') {
        parameters(q, ['before', 'before_id', 'after', 'after_id', 'limit']);
        const before = timestamp(q.get('before'), 'before'), after = timestamp(q.get('after'), 'after');
        const beforeId = cursorId(q.get('before_id'), 'before_id', before), afterId = cursorId(q.get('after_id'), 'after_id', after);
        if (before !== undefined && after !== undefined && (before < after ||
          (before === after && (beforeId === undefined || afterId === undefined || beforeId <= afterId))))
          throw new SessionError(400, 'before 游标必须晚于 after 游标');
        sessionJson(res, 200, reader.messages(scope, before, after, integer(q.get('limit'), 'limit', 50, 200), beforeId, afterId)); return;
      }
      parameters(q, ['from', 'to']);
      const from = timestamp(q.get('from'), 'from') ?? extent.first_ts;
      const to = timestamp(q.get('to'), 'to') ?? extent.last_ts + 1;
      if (from >= to) throw new SessionError(400, 'from 必须早于 to');
      sessionJson(res, 200, reader.timeline(scope, from, to, retention, now));
    } catch (error) {
      sessionJson(res, error instanceof SessionError ? error.status : 500,
        { error: error instanceof SessionError ? error.message : '记忆读取暂不可用' });
    } finally { reader?.close(); images?.close(); }
  };
}
