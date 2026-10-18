import { DatabaseSync } from 'node:sqlite';
import type { ContextStore, MessageRow, SummaryRow } from '../../context/store.js';
import { redactText } from '../redact.js';
import { SessionError } from '../sessions/types.js';
import { scopeLabel } from '../ui/html.js';
import type { MessageItem, Retention, ScopeSummary, ScopeTimeline, SummaryItem, TrackBucket } from './types.js';

const DAY = 86400;
const ROW_LIMIT = 10_000;
export const label = (scope: string) => scopeLabel(scope.replace(/^user:/, 'private:'));
export const safeText = (text: string) => redactText(text, Number.MAX_SAFE_INTEGER);
export const preview = (text: string, size: number) => redactText(safeText(text), size);
function bounded<T>(rows: T[], limit = ROW_LIMIT): T[] {
  if (rows.length > limit) throw new SessionError(413, '记录过多，请缩小查询范围');
  return rows;
}

/** 每次请求独立打开只读连接和读事务；不借用 ContextStore 的私有写连接。 */
export class MemoryReader {
  private readonly db: DatabaseSync;
  constructor(private readonly context: ContextStore) {
    this.db = new DatabaseSync(context.file, { readOnly: true });
    this.db.exec('PRAGMA busy_timeout=5000; BEGIN;');
  }
  close(): void { this.db.close(); }

  extent(scope: string): { first_ts: number; last_ts: number } {
    const row = this.db.prepare(`SELECT MIN(first_ts)*1000 first_ts, MAX(last_ts)*1000 last_ts FROM (
      SELECT MIN(time) first_ts, MAX(time) last_ts FROM messages WHERE scope=?
      UNION ALL SELECT MIN(period_start), MAX(period_end) FROM summaries WHERE scope=?) LIMIT 1`)
      .get(scope, scope) as { first_ts: number | null; last_ts: number | null };
    if (row.first_ts === null || row.last_ts === null) throw new SessionError(404, '会话域不存在');
    return { first_ts: row.first_ts, last_ts: row.last_ts };
  }

  overview(now: number): ScopeSummary[] {
    const rows = bounded(this.db.prepare(`WITH
      m AS (SELECT scope, COUNT(*) messages, MIN(time) first_ts, MAX(time) last_ts, SUM(length(text)) bytes FROM messages GROUP BY scope),
      s AS (SELECT scope, SUM(level='day') day, SUM(level='week') week, MIN(period_start) first_ts,
        MAX(period_end) last_ts, SUM(length(text)) bytes FROM summaries GROUP BY scope),
      scopes AS (SELECT scope FROM m UNION SELECT scope FROM s),
      media AS (SELECT scope, COUNT(*) n FROM message_media GROUP BY scope),
      pending AS (SELECT scope, COUNT(*) n FROM (
        SELECT scope, floor((time+?)/${DAY}.0)*${DAY}-? start FROM messages WHERE time<?
        GROUP BY scope, start HAVING COUNT(*)>=5
      ) p WHERE NOT EXISTS (SELECT 1 FROM summaries s WHERE s.scope=p.scope AND s.period_start<=p.start AND s.period_end>p.start)
        GROUP BY scope)
      SELECT scopes.scope, COALESCE(m.messages,0) messages, COALESCE(s.day,0) day, COALESCE(s.week,0) week,
        MIN(COALESCE(m.first_ts,s.first_ts),COALESCE(s.first_ts,m.first_ts))*1000 first_ts,
        MAX(COALESCE(m.last_ts,s.last_ts),COALESCE(s.last_ts,m.last_ts))*1000 last_ts,
        COALESCE(m.bytes,0)+COALESCE(s.bytes,0) bytes_estimate, COALESCE(pending.n,0) pending_day_summaries,
        COALESCE(media.n,0) media_count FROM scopes LEFT JOIN m USING(scope) LEFT JOIN s USING(scope)
        LEFT JOIN pending USING(scope) LEFT JOIN media USING(scope) ORDER BY scopes.scope LIMIT ?`)
      .all(this.context.tzOffsetSec, this.context.tzOffsetSec, this.context.dayStart(this.context.dayIndex(now / 1000)), ROW_LIMIT + 1) as unknown as
      (Omit<ScopeSummary, 'label' | 'summaries'> & { day: number; week: number })[]);
    return rows.map(({ day, week, ...row }) => ({ ...row, label: label(row.scope), summaries: { day, week } }));
  }

  timeline(scope: string, from: number, to: number, retention: Retention, now: number): ScopeTimeline {
    const span = to - from, width = span <= 3 * DAY * 1000 ? 3600 : span <= 60 * DAY * 1000 ? DAY : 7 * DAY;
    // 日桶按存储的本地日界，周桶按周一；小时桶沿用同一时区偏移。
    const origin = (width === 7 * DAY ? -3 * DAY : 0) - this.context.tzOffsetSec;
    const groups = bounded(this.db.prepare(`SELECT floor((time-?)/?) * ? + ? start,
      COUNT(*) count, COUNT(DISTINCT user_id) senders FROM messages WHERE scope=? AND time>=? AND time<?
      GROUP BY start ORDER BY start LIMIT ?`).all(origin, width, width, origin, scope, from / 1000, to / 1000, ROW_LIMIT + 1) as
      { start: number; count: number; senders: number }[]);
    const first = this.db.prepare('SELECT text FROM messages WHERE scope=? AND time>=? AND time<? ORDER BY time,id LIMIT 1');
    const raw: TrackBucket[] = groups.map(g => ({ start: g.start * 1000, end: (g.start + width) * 1000,
      count: g.count, senders: g.senders, preview: preview((first.get(scope, Math.max(g.start, from / 1000),
        Math.min(g.start + width, to / 1000)) as { text: string }).text, 80) }));
    const rows = bounded(this.db.prepare(`SELECT * FROM summaries WHERE scope=? AND period_start<? AND period_end>?
      ORDER BY period_start,id LIMIT ?`).all(scope, to / 1000, from / 1000, ROW_LIMIT + 1) as unknown as SummaryRow[]);
    const items: SummaryItem[] = rows.map(s => ({ id: s.id, kind: s.level, period_start: s.period_start * 1000,
      period_end: s.period_end * 1000, created_at: s.created_at * 1000, chars: [...s.text].length,
      preview: preview(s.text, 120), source_messages: s.msg_count ?? null }));
    const retention_edges = { raw_until: now - retention.rawDays * DAY * 1000,
      day_until: now - retention.summaryDays * DAY * 1000, week_until: now - retention.summaryDays * DAY * 1000 };
    const gaps: ScopeTimeline['gaps'] = [];
    // 没有删除日志：purged 只表示所有存储层均已超保留期，不能证明历史上确有记录。
    const purgedBefore = Math.min(now - Math.max(retention.rawDays, retention.hardMaxDays) * DAY * 1000, retention_edges.week_until);
    const gap = (start: number, end: number) => {
      if (start < Math.min(end, purgedBefore)) gaps.push({ from: start, to: Math.min(end, purgedBefore), reason: 'purged' });
      if (Math.max(start, purgedBefore) < end) gaps.push({ from: Math.max(start, purgedBefore), to: end, reason: 'no_records' });
    };
    const coverage = [...raw.map(r => [r.start, r.end]), ...items.map(s => [s.period_start, s.period_end])].sort((a, b) => a[0] - b[0]);
    let cursor = from;
    for (const [start, end] of coverage) { if (start > cursor) gap(cursor, Math.min(start, to)); cursor = Math.max(cursor, Math.min(end, to)); }
    if (cursor < to) gap(cursor, to);
    return { scope, label: label(scope), range: { first_ts: from, last_ts: to }, retention_edges,
      tracks: { raw, day: items.filter(s => s.kind === 'day'), week: items.filter(s => s.kind === 'week') }, gaps };
  }

  messages(scope: string, before: number | undefined, after: number | undefined, limit: number): { items: MessageItem[]; next_before?: number } {
    const rows = this.db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM message_media x WHERE x.scope=m.scope AND x.message_id=m.message_id) media
      FROM messages m WHERE scope=? AND time<? AND time>? ORDER BY time DESC,id DESC LIMIT ?`)
      .all(scope, (before ?? 8.64e15) / 1000, (after ?? -1) / 1000, limit + 1) as unknown as (MessageRow & { media: number })[];
    const items = rows.slice(0, limit).map(r => {
      const text = safeText(r.text);
      return { message_id: r.message_id, ts: r.time * 1000, sender: r.user_id, sender_name: r.nickname,
        text: preview(text, 2000), ...(text.length > 2000 ? { truncated: true as const } : {}),
        ...(r.reply_to_id !== null ? { reply_to: r.reply_to_id } : {}), ...(r.status !== null ? { bot_status: r.status } : {}),
        ...(r.action !== null ? { bot_action: r.action } : {}), media: r.media };
    });
    // 毫秒时间游标无法表达同秒内的位置；遇到跨页同秒时明确拒绝，避免悄悄丢消息。
    if (rows.length > limit && rows[limit].time === rows[limit - 1].time)
      throw new SessionError(400, '分页边界有同秒消息，请增大 limit 或缩小 after/before 区间');
    return { items, ...(rows.length > limit ? { next_before: items.at(-1)!.ts } : {}) };
  }

  summary(id: number) {
    const row = this.db.prepare('SELECT * FROM summaries WHERE id=? LIMIT 1').get(id) as SummaryRow | undefined;
    if (!row) throw new SessionError(404, '摘要不存在');
    const { n } = this.db.prepare('SELECT COUNT(*) n FROM messages WHERE scope=? AND time>=? AND time<? LIMIT 1')
      .get(row.scope, row.period_start, row.period_end) as { n: number };
    return { id, scope: row.scope, kind: row.level, period_start: row.period_start * 1000, period_end: row.period_end * 1000,
      created_at: row.created_at * 1000, text: row.text, surviving_raw: n, lineage: null };
  }
}
