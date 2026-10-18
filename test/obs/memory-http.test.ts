import { createServer, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ContextStore } from '../../src/context/store.js';
import { callQQContextTool } from '../../src/mcp/qq-context-server.js';
import type { InboundMessage } from '../../src/qq/types.js';
import { createDashboard } from '../../src/obs/http.js';
import { createMemoryRoutes } from '../../src/obs/memory/http.js';
import type { MemoryDeps, MessageItem, MessagePage } from '../../src/obs/memory/types.js';
import { redactText, registerTemporarySecrets } from '../../src/obs/redact.js';
import { RESPONSE_BYTES } from '../../src/obs/sessions/content.js';
import { ObsStore } from '../../src/obs/store.js';

const DAY = 86400_000, HOUR = 3600_000, NOW = Date.UTC(2026, 9, 18, 12), G = 'group:123', P = 'private:456';
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const fn of clean.splice(0).reverse()) await fn(); });

async function rig(options: Partial<MemoryDeps> = {}, empty = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-memory-api-'));
  const context = new ContextStore(dir, { tzOffsetSec: 0 }), store = new ObsStore(dir);
  clean.push(async () => { context.close(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const add = (id: string, ts: number, text: string, scope = G, sender = '789') => context.ingest({
    message_id: id, time: ts / 1000, message_type: scope.startsWith('group:') ? 'group' : 'private',
    group_id: scope.startsWith('group:') ? scope.slice(6) : null, user_id: scope.startsWith('group:') ? sender : scope.slice(8),
    nickname: '匿名用户', self_id: '999', text, route_text: text, segments: [], images: [],
    truncated: false, mentioned_self: false,
  } satisfies InboundMessage);
  if (!empty) {
    add('m1', NOW - 3 * DAY, 'match 第一日 token=abc');
    add('m2', NOW - 2 * DAY, 'match 第二日');
    for (let i = 0; i < 5; i++) add(`pending${i}`, NOW - DAY + i * 1000, `match 待整理 ${i}`, G, i % 2 ? '790' : '789');
    add('private1', NOW - HOUR, 'match 私聊', P);
    context.writeSummary({ scope: G, level: 'day', period_start: (NOW - 3.5 * DAY) / 1000, period_end: (NOW - 2.5 * DAY) / 1000,
      text: 'match 日摘要 token=abc', msg_count: 9, created_at: NOW / 1000 });
    context.writeSummary({ scope: G, level: 'week', period_start: (NOW - 14.5 * DAY) / 1000, period_end: (NOW - 7.5 * DAY) / 1000,
      text: 'match 周摘要', msg_count: 30, created_at: NOW / 1000 });
    const hit = context.message({ kind: 'all' }, 'm1')!.row;
    context.saveMedia(hit, [{ scope: G, message_id: 'm1', ordinal: 0, sha256: null, path: null,
      status: 'skipped', reason: '匿名 fixture', created_at: NOW / 1000 }], hit.text);
  }
  const deps: MemoryDeps = { context, store, retention: { rawDays: 30, summaryDays: 180, hardMaxDays: 90, dailyHour: 3, tz: 'UTC' },
    now: () => NOW, maxChars: 2500, archives: { codex: path.join(dir, 'codex-threads-archive.jsonl'), pi: path.join(dir, 'pi-threads-archive.jsonl') }, ...options };
  const route = createMemoryRoutes(deps);
  const get = async (url: string) => {
    let text = '', status = 0;
    const res = { writeHead(n: number) { status = n; return res; }, end(body: string) { text = body; } };
    await route(new URL(url, 'http://localhost'), res as unknown as ServerResponse);
    return { status, body: JSON.parse(text), text };
  };
  return { dir, context, store, add, deps, get };
}

async function sameSecondRig() {
  const r = await rig({}, true), messageIds = ['z', 'a', 'y', 'b', 'x', 'c', 'w'];
  r.add('lower', NOW, '其他域的下界', P);
  for (const id of messageIds) {
    r.add(id, NOW, id);
    r.add(`other-${id}`, NOW, '其他域', P);
  }
  const ids = messageIds.map(id => r.context.message({ kind: 'scope', scope: G }, id)!.row.id);
  const lowerId = r.context.message({ kind: 'scope', scope: P }, 'lower')!.row.id;
  return { ...r, messageIds, ids, lowerId };
}

describe('记忆只读 API', () => {
  it('总览汇总消息、日周摘要、真实体量、待整理日和媒体', async () => {
    const r = await rig();
    r.context.setMeta('aging_last_run', String((NOW - HOUR) / 1000));
    const report = { day_summaries: 1, week_summaries: 2, failed: 0, purged_messages: 3, purged_summaries: 4, ms: 50 };
    r.store.append({ ticket: '@aging', scope: '', ts: NOW - HOUR, stage: 'aging', status: 'ok', duration_ms: 50, detail: report });
    r.deps.aging = { config: r.deps.retention, nextRun: () => NOW + HOUR, running: () => true };
    const res = await r.get('/api/memory');
    expect(res.status).toBe(200);
    expect(res.body.scopes.map((s: { scope: string }) => s.scope)).toEqual([G, P]);
    expect(res.body.scopes[0]).toMatchObject({ label: '群 123', messages: 7, summaries: { day: 1, week: 1 },
      pending_day_summaries: 1, media_count: 1, first_ts: NOW - 14.5 * DAY, last_ts: NOW - DAY + 4000 });
    const text = ['match 第一日 token=abc', 'match 第二日', ...Array.from({ length: 5 }, (_, i) => `match 待整理 ${i}`),
      'match 日摘要 token=abc', 'match 周摘要'];
    expect(res.body.scopes[0].bytes_estimate).toBe(text.reduce((n, s) => n + [...s].length, 0));
    expect(res.body.scopes[1].label).toBe('私聊 456');
    expect(res.body.aging).toEqual({ last_run: NOW - HOUR, last_report: report, next_run: NOW + HOUR, running: true, catch_up_needed: false });
    expect(res.body.retention).toEqual(r.deps.retention);
  });

  it('空库和损坏整理标记不伪造记录或运行时间', async () => {
    const r = await rig({}, true);
    expect((await r.get('/api/memory')).body).toMatchObject({ scopes: [], aging: { last_run: null, next_run: null, running: false, catch_up_needed: true } });
    r.context.setMeta('aging_last_run', 'bad');
    expect((await r.get('/api/memory')).body.aging.last_run).toBeNull();
    r.context.setMeta('aging_last_run', String((NOW - DAY) / 1000));
    expect((await r.get('/api/memory')).body.aging.catch_up_needed).toBe(true);
  });

  it('仅摘要的域仍能显示范围和空原文轨', async () => {
    const r = await rig({}, true);
    r.context.writeSummary({ scope: G, level: 'week', period_start: NOW / 1000 - 10, period_end: NOW / 1000, text: '摘要', msg_count: 0 });
    expect((await r.get('/api/memory')).body.scopes[0]).toMatchObject({ messages: 0, summaries: { day: 0, week: 1 }, first_ts: NOW - 10000 });
    const res = await r.get(`/api/memory/scopes/${G}`);
    expect(res.status).toBe(200); expect(res.body.tracks.raw).toEqual([]); expect(res.body.tracks.week[0].source_messages).toBe(0);
    expect((await r.get(`/api/memory/scopes/${G}/messages`)).body.items).toEqual([]);
  });

  it.each([[3, HOUR], [3.01, DAY], [60, DAY], [61, 7 * DAY]])('时间区间 %s 天选择正确桶宽', async (days, width) => {
    const r = await rig();
    const res = await r.get(`/api/memory/scopes/${G}?from=${NOW - days * DAY}&to=${NOW}`);
    expect(res.status).toBe(200); expect(res.body.tracks.raw.length).toBeGreaterThan(0);
    for (const bucket of res.body.tracks.raw) expect(bucket.end - bucket.start).toBe(width);
    expect(res.body.tracks.raw.reduce((n: number, bucket: { count: number }) => n + bucket.count, 0)).toBe(7);
  });

  it('范围过滤、不同发送者、桶内首条预览和日周摘要元数据', async () => {
    const r = await rig();
    const res = await r.get(`/api/memory/scopes/group%3A123?from=${NOW - 20 * DAY}&to=${NOW}`);
    expect(res.body.range).toEqual({ first_ts: NOW - 20 * DAY, last_ts: NOW });
    expect(res.body.tracks.raw.at(-1)).toMatchObject({ count: 5, senders: 2, preview: 'match 待整理 0' });
    expect(res.body.tracks.raw[0].preview).toBe('match 第一日 token=[已隐藏]');
    expect(res.body.tracks.day[0]).toMatchObject({ id: 1, kind: 'day', source_messages: 9, created_at: NOW, chars: 19 });
    expect(res.body.tracks.week[0].source_messages).toBe(30);
    expect((await r.get(`/api/memory/scopes/${G}?from=${NOW - DAY + 1000}&to=${NOW - DAY + 3000}`)).body.tracks.raw[0].count).toBe(2);
    expect((await r.get(`/api/memory/scopes/${G}`)).body.range).toEqual({ first_ts: NOW - 14.5 * DAY, last_ts: NOW - DAY + 4001 });
  });

  it('保留边界与清理策略一致，空白分割且现存过期记录不当作删除', async () => {
    const r = await rig();
    r.add('old', NOW - 250 * DAY, '过期但仍存在');
    const res = await r.get(`/api/memory/scopes/${G}?from=${NOW - 300 * DAY}&to=${NOW}`);
    expect(res.body.retention_edges).toEqual({ raw_until: NOW - 30 * DAY, day_until: NOW - 180 * DAY, week_until: NOW - 180 * DAY });
    expect(res.body.gaps).toContainEqual(expect.objectContaining({ to: NOW - 180 * DAY, reason: 'purged' }));
    expect(res.body.gaps).toContainEqual(expect.objectContaining({ from: NOW - 180 * DAY, reason: 'no_records' }));
    expect(res.body.gaps.some((g: { from: number; to: number }) => g.from <= NOW - 250 * DAY && g.to > NOW - 250 * DAY)).toBe(false);
    r.deps.retention = { ...r.deps.retention, rawDays: 200, hardMaxDays: 5 };
    const second = await r.get(`/api/memory/scopes/${G}?from=${NOW - 300 * DAY}&to=${NOW}`);
    expect(second.body.gaps).toContainEqual(expect.objectContaining({ to: NOW - 200 * DAY, reason: 'purged' }));
  });

  it('ISO 日期与毫秒给出相同结果，时区偏移及周一正确', async () => {
    const r = await rig();
    const a = await r.get(`/api/memory/scopes/${G}?from=2026-10-01&to=2026-10-18T20:00:00%2B08:00`);
    const b = await r.get(`/api/memory/scopes/${G}?from=${Date.UTC(2026, 9, 1)}&to=${NOW}`);
    expect(a.body).toEqual(b.body);
    const week = await r.get(`/api/memory/scopes/${G}?from=${NOW - 61 * DAY}&to=${NOW}`);
    for (const bucket of week.body.tracks.raw) expect(new Date(bucket.start).getUTCDay()).toBe(1);
    const shifted = new ContextStore(r.dir, { readOnly: true, tzOffsetSec: 8 * 3600 });
    clean.push(() => shifted.close()); r.deps.context = shifted;
    const c = await r.get(`/api/memory/scopes/${G}?from=${NOW - 5 * DAY}&to=${NOW}`);
    for (const bucket of c.body.tracks.raw) expect(new Date(bucket.start).getUTCHours()).toBe(16);
  });

  it('消息严格按时间倒序分页，并给出回复、机器人和媒体字段', async () => {
    const r = await rig();
    const first = await r.get(`/api/memory/scopes/${G}/messages?limit=2`);
    expect(first.body.items.map((m: { message_id: string }) => m.message_id)).toEqual(['pending4', 'pending3']);
    expect(first.body.next_before).toBe(NOW - DAY + 3000);
    expect(first.body.next_before_id).toBe(r.context.message({ kind: 'scope', scope: G }, 'pending3')!.row.id);
    const next = await r.get(`/api/memory/scopes/${G}/messages?limit=2&before=${first.body.next_before}`);
    expect(next.body.items.map((m: { message_id: string }) => m.message_id)).toEqual(['pending2', 'pending1']);
    const last = await r.get(`/api/memory/scopes/${G}/messages?before=${NOW - 2 * DAY}`);
    expect(last.body.next_before_id).toBeUndefined();
    expect(last.body.next_before).toBeUndefined(); expect(last.body.items[0]).toMatchObject({ message_id: 'm1', media: 1, text: 'match 第一日 token=[已隐藏]' });
    r.context.recordPending(G, 'bot1', NOW / 1000, { replyTo: 'm1' });
    r.context.completeReply('bot1', { action: 'reply', status: '已回复', excerpt: '匿名回复' });
    expect((await r.get(`/api/memory/scopes/${G}/messages?after=${NOW - 1000}`)).body.items[0]).toMatchObject({
      message_id: 'self:bot1', reply_to: 'm1', bot_status: '已回复', bot_action: 'reply', media: 0 });
  });

  it('先整体脱敏再截断长正文与所有预览，不泄露跨边界凭据', async () => {
    const r = await rig();
    const secret = '跨界秘密'.repeat(100);
    clean.push(registerTemporarySecrets([secret]));
    r.add('long', NOW, 'x'.repeat(1995) + secret + 'token=abc ' + '中'.repeat(100));
    const res = await r.get(`/api/memory/scopes/${G}/messages`);
    expect(res.body.items[0].truncated).toBe(true); expect(res.body.items[0].text.length).toBeLessThanOrEqual(2000);
    expect(res.text).not.toContain('跨界'); expect(res.text).not.toContain('token=abc');
    expect((await r.get(`/api/memory/scopes/${G}`)).text).not.toContain('跨界');
    expect((await r.get('/api/memory/summaries/1')).body.text).toBe('match 日摘要 token=[已隐藏]');
  });

  it.each([false, true])('同秒 7 条以 limit=3 连续三页不重不漏，保留 after_id 下界=%s', async bounded => {
    const r = await sameSecondRig(), seen: string[] = [];
    const base = `/api/memory/scopes/${G}/messages?limit=3` + (bounded ? `&after=${NOW}&after_id=${r.lowerId}` : '');
    let url = base;
    for (const [page, size] of [3, 3, 1].entries()) {
      const res = await r.get(url);
      expect(res.status).toBe(200);
      const body = res.body as MessagePage;
      expect(body.items).toHaveLength(size);
      expect(body.items.every(m => m.ts === NOW)).toBe(true);
      seen.push(...body.items.map(m => m.message_id));
      if (page < 2) {
        expect(body.next_before).toBe(NOW);
        expect(body.next_before_id).toBe(r.ids[6 - page * 3 - 2]);
        url = base + `&before=${body.next_before}&before_id=${body.next_before_id}`;
      } else {
        expect(body).not.toHaveProperty('next_before');
        expect(body).not.toHaveProperty('next_before_id');
      }
    }
    expect(seen).toEqual([...r.messageIds].reverse());
    expect(new Set(seen).size).toBe(7);
    const exhausted = await r.get(base + `&before=${NOW}&before_id=${r.ids[0]}`);
    expect(exhausted.status).toBe(200); expect(exhausted.body).toEqual({ items: [] });
  });

  it('after_id 严格排除同秒游标及更小 ID，并保留较新时间的消息', async () => {
    const r = await sameSecondRig();
    // 先插入较新消息，再插入较旧消息，验证时间优先于主键。
    r.add('newer', NOW + 1000, '较新'); r.add('older', NOW - 1000, '较旧');
    for (const [index, id] of r.ids.entries()) {
      const res = await r.get(`/api/memory/scopes/${G}/messages?after=${new Date(NOW).toISOString()}&after_id=${id}`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((m: MessageItem) => m.message_id)).toEqual(['newer', ...r.messageIds.slice(index + 1).reverse()]);
      expect(res.body).not.toHaveProperty('next_before'); expect(res.body).not.toHaveProperty('next_before_id');
    }
    const before = await r.get(`/api/memory/scopes/${G}/messages?before=${NOW}&before_id=${r.ids[2]}`);
    expect(before.status).toBe(200);
    expect(before.body.items.map((m: MessageItem) => m.message_id)).toEqual([...r.messageIds.slice(0, 2).reverse(), 'older']);
  });

  it('旧式时间游标仍严格过滤，同秒余项跳过但请求成功', async () => {
    const r = await sameSecondRig();
    r.add('older', NOW - 1000, '较旧');
    const first = await r.get(`/api/memory/scopes/${G}/messages?limit=3`);
    expect(first.status).toBe(200); expect(first.body.next_before).toBe(NOW);
    const next = await r.get(`/api/memory/scopes/${G}/messages?limit=3&before=${first.body.next_before}`);
    expect(next.status).toBe(200);
    expect(next.body.items.map((m: MessageItem) => m.message_id)).toEqual(['older']);
    expect(next.body).not.toHaveProperty('next_before'); expect(next.body).not.toHaveProperty('next_before_id');
    const after = await r.get(`/api/memory/scopes/${G}/messages?after=${NOW}`);
    expect(after.status).toBe(200); expect(after.body).toEqual({ items: [] });
  });

  it.each(['before', 'after'])('%s 的毫秒边界不取整，ID 不改变时间比较', async direction => {
    const r = await sameSecondRig();
    const ts = NOW + (direction === 'before' ? 1 : -1);
    for (const idQuery of ['', `&${direction}_id=${r.ids[3]}`]) {
      const res = await r.get(`/api/memory/scopes/${G}/messages?${direction}=${ts}${idQuery}`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((m: MessageItem) => m.message_id)).toEqual([...r.messageIds].reverse());
    }
  });

  it.each(['before', 'after'].flatMap(direction => ['', '0', '-1', '1.5', 'abc', '1e3', '9007199254740992']
    .map(value => [direction, value])))('%s_id 非法值 %s 返回 400', async (direction, value) => {
    const r = await rig();
    const res = await r.get(`/api/memory/scopes/${G}/messages?${direction}=${NOW}&${direction}_id=${value}`);
    expect(res.status).toBe(400); expect(res.body.error).toContain(`${direction}_id`);
  });

  it.each([
    'before_id=1', 'after_id=1', `before_id=1&after=${NOW}`, `after_id=1&before=${NOW}`,
    `before=${NOW}&before_id=1&before_id=2`, `after=${NOW}&after_id=1&after_id=2`,
    `before=${NOW}&after=${NOW}`, `before=${NOW}&after=${NOW}&before_id=2`,
    `before=${NOW}&after=${NOW}&after_id=1`,
    `before=${NOW}&after=${NOW}&before_id=1&after_id=1`,
    `before=${NOW}&after=${NOW}&before_id=1&after_id=2`,
  ])('游标缺少配对、重复或上下界非法时返回 400：%s', async query => {
    const r = await rig();
    const res = await r.get(`/api/memory/scopes/${G}/messages?${query}`);
    expect(res.status).toBe(400); expect(typeof res.body.error).toBe('string');
  });

  it('摘要详情返回区间内现存原文数量和明确的未知血缘', async () => {
    const r = await rig();
    expect((await r.get('/api/memory/summaries/1')).body).toEqual({ id: 1, scope: G, kind: 'day',
      period_start: NOW - 3.5 * DAY, period_end: NOW - 2.5 * DAY, created_at: NOW,
      text: 'match 日摘要 token=[已隐藏]', surviving_raw: 1, lineage: null });
    expect((await r.get('/api/memory/summaries/2')).body.surviving_raw).toBe(0);
  });

  it.each([undefined, G])('检索直接工具路径逐字一致，scope=%s', async scope => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const r = await rig();
    const access = scope ? { kind: 'scope' as const, scope } : { kind: 'all' as const };
    const direct = callQQContextTool({ access, openStore: () => r.context, maxChars: 2500 }, 'qq_search', { query: '待整理', days: 30, limit: 10 });
    const text = direct.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const res = await r.get('/api/memory/search?q=待整理' + (scope ? `&scope=${scope}` : ''));
    expect(res.status).toBe(200); expect(res.body.tool_text).toBe(text); expect(res.body.tool_text_chars).toBe(text.length);
    expect(res.body.hits).toHaveLength(5); expect(res.body.dropped).toBe(0); expect(res.body.max_chars).toBe(2500);
    expect(res.body.hits[0]).toMatchObject({ kind: 'message', id: 'pending4', ts: NOW - DAY + 4000, matched_fields: ['text'] });
  });

  it('检索脱敏对照、混合摘要与消息、真实裁剪数量和全域授权', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const r = await rig({ maxChars: 130 });
    const res = await r.get('/api/memory/search?q=match&days=180&limit=20');
    const direct = callQQContextTool({ access: { kind: 'all' }, openStore: () => r.context, maxChars: 130 }, 'qq_search', { query: 'match', days: 180, limit: 20 });
    const original = direct.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    expect(res.body.tool_text).toBe(redactText(original, Number.MAX_SAFE_INTEGER));
    expect(res.body.tool_text_chars).toBe(res.body.tool_text.length);
    expect(res.body.hits).toHaveLength(10); expect(res.body.dropped).toBe(8);
    expect(res.text).not.toContain('token=abc');
    expect(new Set(res.body.hits.map((h: { scope: string }) => h.scope))).toEqual(new Set([G, P]));
    expect(res.body.hits.filter((h: { kind: string }) => h.kind === 'summary')).toHaveLength(2);
    r.deps.maxChars = 1;
    expect((await r.get('/api/memory/search?q=match')).body.dropped).toBe(10);
  });

  it('命中 detail 和正文末尾时返回正确字段和高亮片段，空匹配保留真实工具文本', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const r = await rig();
    r.context.recordPending(G, 'detail', NOW / 1000);
    r.context.completeReply('detail', { action: 'generate_image', status: '已回复', detail: 'Needle token=abc', excerpt: '成图' });
    expect((await r.get('/api/memory/search?q=needle')).body.hits[0]).toMatchObject({ matched_fields: ['detail'], excerpt: 'Needle token=[已隐藏]' });
    r.add('tail', NOW, '前言'.repeat(500) + 'needle 末尾');
    const tail = (await r.get('/api/memory/search?q=needle')).body.hits.find((h: { id: string }) => h.id === 'tail');
    expect(tail.excerpt).toContain('needle'); expect(tail.excerpt.length).toBeLessThanOrEqual(240);
    expect((await r.get('/api/memory/search?q=nomatch')).body).toMatchObject({ hits: [], tool_text: '（没有匹配的记录）', dropped: 0 });
  });

  it('相同 formatter 行按出现次数统计裁剪', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const r = await rig({ maxChars: 75 }, true);
    for (const ticket of ['a', 'b', 'c']) {
      r.context.recordPending(G, ticket, NOW / 1000);
      r.context.completeReply(ticket, { action: 'reply', status: '已回复', excerpt: 'match 重复正文' });
    }
    const res = await r.get(`/api/memory/search?q=match&scope=${G}`);
    expect(res.body.hits).toHaveLength(3); expect(res.body.dropped).toBe(1);
  });

  it('真实工具先裁剪留下的凭据残片不会从面板泄露', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const r = await rig({}, true), secret = '跨界凭据'.repeat(80);
    clean.push(registerTemporarySecrets([secret]));
    r.add('secret', NOW, 'match ' + 'x'.repeat(80) + secret);
    const res = await r.get('/api/memory/search?q=match');
    expect(res.status).toBe(200); expect(res.text).not.toContain('跨界凭据');
    expect(res.body.tool_text).toBe('[已隐藏：原文含跨裁剪边界的凭据]');
    expect(res.body.dropped).toBe(0); expect(res.body.tool_text_chars).toBe(res.body.tool_text.length);
  });

  it('归档镜像的时间、会话链接和缺失创建时间，压缩按会话去重原因', async () => {
    const r = await rig();
    await fs.writeFile(r.deps.archives!.codex, JSON.stringify({ key: 'owner', thread_id: 'thread-a',
      created_at: new Date(NOW - DAY).toISOString(), archived_at: new Date(NOW).toISOString(), reason: 'token=abc' }) + '\n', 'utf8');
    await fs.writeFile(r.deps.archives!.pi, JSON.stringify({ key: G, conversation: 42,
      archived_at: new Date(NOW).toISOString(), reason: 'dashboard' }), 'utf8');
    for (const [i, reason] of ['background', 'background', 'reserve'].entries()) r.store.append({
      ticket: `@compaction${i}`, scope: G, ts: NOW + i, stage: 'compaction', status: 'ok', duration_ms: null,
      detail: { conversation: 42, reason },
    });
    r.store.append({ ticket: '@other', scope: G, ts: NOW, stage: 'compaction', status: 'ok', duration_ms: null,
      detail: { backend: 'codex', conversation: 42, reason: 'ignored' } });
    const res = await r.get('/api/memory/archives');
    expect(res.status).toBe(200);
    expect(res.body.codex).toEqual([{ key: 'owner', thread_id: 'thread-a', created_at: NOW - DAY, archived_at: NOW,
      reason: 'token=[已隐藏]', session_href: '/agents/codex/sessions/thread-a' }]);
    expect(res.body.pi).toEqual([{ key: G, conversation: 42, created_at: null, archived_at: NOW,
      reason: 'dashboard', session_href: '/agents/pi/sessions/42' }]);
    expect(res.body.compactions).toEqual([{ conversation: 42, attempts: 3, last_at: NOW + 2, reasons: ['background', 'reserve'] }]);
  });

  it('归档缺失为 []，损坏为 503，观测降级仍可读归档', async () => {
    const r = await rig();
    expect((await r.get('/api/memory/archives')).body).toEqual({ codex: [], pi: [], compactions: [] });
    r.store.degrade(); expect((await r.get('/api/memory/archives')).status).toBe(200);
    await fs.writeFile(r.deps.archives!.pi, '{bad', 'utf8');
    expect((await r.get('/api/memory/archives')).status).toBe(503);
  });

  it('归档流式保留末尾 200 行，并限制异常文件体积', async () => {
    const r = await rig();
    const rows = Array.from({ length: 205 }, (_, i) => JSON.stringify({ key: 'owner', thread_id: `t${i}`, reason: '重置',
      updated_at: new Date(NOW - DAY).toISOString(), archived_at: new Date(NOW + i).toISOString() }));
    await fs.writeFile(r.deps.archives!.codex, rows.join('\n'), 'utf8');
    const res = await r.get('/api/memory/archives');
    expect(res.body.codex).toHaveLength(200); expect(res.body.codex[0].thread_id).toBe('t204'); expect(res.body.codex.at(-1).thread_id).toBe('t5');
    expect(res.body.codex[0].created_at).toBe(NOW - DAY);
    await fs.writeFile(r.deps.archives!.pi, ' '.repeat(RESPONSE_BYTES + 1), 'utf8');
    expect((await r.get('/api/memory/archives')).status).toBe(413);
  });

  it('JSON 的 1 MiB 上限按编码后字节判断，中文正文不静默截掉列表', async () => {
    const r = await rig({}, true);
    for (let i = 0; i < 200; i++) r.add(`large${i}`, NOW - i * 1000, '中'.repeat(2000));
    const res = await r.get(`/api/memory/scopes/${G}/messages?limit=200`);
    expect(res.status).toBe(413); expect(res.body.error).toContain('1 MiB'); expect(Buffer.byteLength(res.text)).toBeLessThan(RESPONSE_BYTES);
    expect((await r.get(`/api/memory/scopes/${G}/messages?limit=100`)).status).toBe(200);
  });

  it.each([
    '/api/memory?unknown=1', '/api/memory/archives?limit=1', '/api/memory/summaries/abc', '/api/memory/summaries/0',
    '/api/memory/summaries/1?x=1', '/api/memory/scopes/%GG', '/api/memory/scopes/group%2F123',
    `/api/memory/scopes/${G}?from=2026-02-30`, `/api/memory/scopes/${G}?from=2026-13-01`,
    `/api/memory/scopes/${G}?from=bad`, `/api/memory/scopes/${G}?from=1&to=1`, `/api/memory/scopes/${G}?from=-1`,
    `/api/memory/scopes/${G}?from=8640000000000000`, `/api/memory/scopes/${G}?to=1.5`,
    `/api/memory/scopes/${G}/messages?limit=201`, `/api/memory/scopes/${G}/messages?limit=0`,
    `/api/memory/scopes/${G}/messages?before=x`, `/api/memory/scopes/${G}/messages?after=2&before=1`,
    '/api/memory/search', '/api/memory/search?q=%20', '/api/memory/search?q=x&scope=', '/api/memory/search?q=x&days=181',
    '/api/memory/search?q=x&limit=21', '/api/memory/search?q=x&days=1.5', '/api/memory/search?q=x&q=y',
  ])('参数非法返回 400：%s', async url => {
    const r = await rig(); const res = await r.get(url); expect(res.status).toBe(400); expect(typeof res.body.error).toBe('string');
  });

  it.each(['/api/memory/nope', '/api/memory/scopes/group:404', '/api/memory/scopes/group:404/messages',
    '/api/memory/summaries/404', '/api/memory/search?q=match&scope=group:404', '/api/memory/archives/nope'])('未知资源返回 404：%s', async url => {
    const r = await rig(); expect((await r.get(url)).status).toBe(404);
  });

  it('所有读取不调用存储写方法，关闭的存储错误不泄露路径', async () => {
    const r = await rig();
    const writes = ['ingest', 'writeSummary', 'purge', 'saveMedia', 'replaceWithWeek', 'setMeta'] as const;
    const spies = writes.map(k => vi.spyOn(r.context, k));
    for (const url of ['/api/memory', `/api/memory/scopes/${G}`, `/api/memory/scopes/${G}/messages`,
      '/api/memory/summaries/1', '/api/memory/search?q=match', '/api/memory/archives']) expect((await r.get(url)).status).toBe(200);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    r.context.close(); const failed = await r.get('/api/memory');
    expect(failed.status).toBe(500); expect(failed.text).not.toContain(r.dir);
  });
});

describe('dashboard 记忆路由接入', () => {
  it.each(['/api/memory', `/api/memory/scopes/${G}`, `/api/memory/scopes/${G}/messages`,
    '/api/memory/summaries/1', '/api/memory/search?q=match', '/api/memory/archives'])('%s 沿用鉴权、安全头且拒绝 POST', async url => {
    const r = await rig(); const token = 'memory-dashboard-fixture';
    const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: r.dir, OBS_TOKEN: token }), store: r.store, context: r.context,
      codex: async () => [], pi: async () => ({}), health: () => ({}), queue: () => ({}), sessionAdapters: {}, archives: r.deps.archives });
    const server = createServer(dashboard.handle);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    clean.push(async () => { await dashboard.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await fetch(base + url)).status).toBe(401);
    const login = await fetch(base + url + (url.includes('?') ? '&' : '?') + `token=${token}`, { redirect: 'manual' });
    expect(login.status).toBe(303); expect(login.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    const res = await fetch(base + url, { headers: { Cookie: `obs_token=${token}` } });
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('referrer-policy')).toBe('same-origin'); expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const post = await fetch(base + url, { method: 'POST', headers: { Cookie: `obs_token=${token}` } });
    expect(post.status).toBe(405); expect(post.headers.get('allow')).toBe('GET'); expect((await post.json()).error).toContain('GET');
  });
});
