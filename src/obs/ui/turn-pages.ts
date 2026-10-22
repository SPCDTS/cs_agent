/**
 * 会话与回合的页面（docs/DASHBOARD.md §2、§3）：/live 的每会话一行、/turns 回合列表、/turns/:id 回合详情、
 * /inputs/:key 输入页、/conversations/:thread 会话页。数据经只读视图传入；所有文本先脱敏再转义（esc）。
 */
import type { ObsEvent } from '../../shared/trace.js';
import { BACKENDS, TURN_KINDS, csrfField, empty, esc, fmtMs, fmtOffset, fmtTime, json, kv, stageLabel, stamp, statusStamp, threadLabel, time, uri } from './html.js';

/* ───────── 视图契约（与 src/obs/live.ts 的 LiveConversation 同形） ───────── */

export interface LiveItemView { seq: number; ts: number; stage: string; status: string; duration_ms: number | null; summary: string }
export interface LiveTurnView {
  id: string; kind: string; sender: string; started: number; updated: number; finished: number | null; outcome: string;
  inputs: { key: string; kind: string; sender: string; text: string }[];
  sends: { ts: number; target: string; text: string; status: string; system: boolean }[];
  tools: number; subagent_events: number; phase: string; phase_since: number; items?: LiveItemView[];
}
export interface LiveConversationView {
  thread: string; scope: string; label: string; backend: string; state: string;
  turn: LiveTurnView | null; queued: string[]; subagents: number | null; recent: LiveTurnView[]; updated: number;
}
export interface TurnRowView { key: string; scope: string; thread: string | null; kind: string | null; ts: number; updated: number; backend: string | null; status: string; sender: string | null; duration_ms: number }

const asObj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const detail = (e: ObsEvent) => { try { return asObj(JSON.parse(e.detail_json)); } catch { return {}; } };
const str = (v: unknown) => typeof v === 'string' ? v : '';
export const turnHref = (id: string) => `/turns/${uri(id)}`;
export const conversationHref = (thread: string) => `/conversations/${uri(thread)}`;
const kindText = (kind: string | null | undefined, sender?: string | null) => (kind ? TURN_KINDS[kind] ?? kind : '回合') + (sender ? ` · ${sender}` : '');
const backendName = (b: string | null | undefined) => b ? BACKENDS[b] ?? b : '';

/* ───────── /live ───────── */

function feedHtml(items: LiveItemView[], t0: number): string {
  return items.slice(-30).map(it => `<li class="${it.status === 'failed' ? 'failed' : it.status === 'started' ? 'started' : ''}"><span class="faint">${esc(fmtOffset(Math.max(0, it.ts - t0)))}</span><span class="sum"><b>${esc(stageLabel(it.stage))}${it.status === 'started' ? ' 开始' : it.status === 'failed' ? ' 失败' : ''}</b>  ${esc([fmtMs(it.duration_ms), it.summary].filter(Boolean).join('  '))}</span></li>`).join('');
}

/** 停止按钮（中止当前回合与子 agent）；ret 为停止后返回的页面。 */
export function stopForm(csrf: string, thread: string, ret: string): string {
  return `<form method="post" action="/thread/stop" data-confirm="停止${esc(threadLabel(thread))}当前的回合？子 agent 会一起停止，排队的消息随后照常处理。">${csrfField(csrf)}<input type="hidden" name="key" value="${esc(thread)}"><input type="hidden" name="return" value="${esc(ret)}"><button class="quiet" title="中止当前回合与子 agent">停止</button></form>`;
}

function recentList(recent: LiveTurnView[]): string {
  return `<ul>${recent.map(r => `<li>${statusStamp(r.outcome || 'processing')}<a href="${turnHref(r.id)}">${esc(kindText(r.kind, r.sender))}</a><span class="excerpt">${esc(r.inputs[0]?.text || r.sends[0]?.text || '')}</span><span class="faint">${esc(fmtMs((r.finished ?? r.updated) - r.started))}</span></li>`).join('')}</ul>`;
}

/** 一个会话一行：页头（状态、会话、后端、回合种类与发送者、已耗时、占用条）、数字、本轮输入、事件流、已发消息、停止、最近回合。 */
export function conversationRow(c: LiveConversationView, o: { csrf: string; stop: boolean; ctxBar: (backend: string, thread: string) => string; now?: number }): string {
  const t = c.turn, now = o.now ?? Date.now();
  const facts: [string, number][] = t ? [['本轮输入', t.inputs.length], ['已发消息', t.sends.length], ['工具调用', t.tools]] : [];
  if (c.subagents !== null) facts.push(['子 agent', c.subagents]);
  facts.push(['排队', c.queued.length]);
  const top = `<div class="slip-top">${statusStamp(c.state)}<a class="who" href="${conversationHref(c.thread)}">${esc(threadLabel(c.thread, c.label))}</a>${c.backend ? `<span class="pill">${esc(backendName(c.backend))}</span>` : ''}${t ? `<span class="pill">${esc(kindText(t.kind, t.sender))}</span>` : ''}<span class="elapsed">${t ? `已耗时 ${esc(fmtMs(now - t.started))}` : `空闲 ${esc(fmtMs(now - c.updated))}`}</span>${c.backend ? o.ctxBar(c.backend, c.thread) : ''}</div>`;
  const body = t ? `<ol class="conv-inputs">${t.inputs.map(i => `<li>${i.sender ? `<b>${esc(i.sender)}：</b>` : ''}${esc(i.text || '（无正文）')}</li>`).join('')}</ol>
<div class="phase">${t.phase ? `<span class="pulse" aria-hidden="true"></span><span>当前：${esc(stageLabel(t.phase))}</span>` : '<span class="faint">阶段之间</span>'}</div><ol class="feed">${feedHtml(t.items ?? [], t.started)}</ol>${
  t.sends.length ? `<ol class="conv-sends">${t.sends.map(s => `<li class="${s.status === 'sent' ? '' : 'failed'}"><span class="faint">${esc((s.system ? '系统 ' : '') + s.target)}</span> ${esc(s.text || '（无正文）')}</li>`).join('')}</ol>` : ''}
<div class="hint conv-foot"><a href="${turnHref(t.id)}">回合详情</a>${o.stop ? stopForm(o.csrf, c.thread, '/live') : ''}</div>` : '';
  return `<article class="slip conv${t ? '' : ' idle'}" data-thread="${esc(c.thread)}"><div class="slip-body">${top}<div class="conv-facts">${facts.map(([k, v]) => `<span class="pill${k === '排队' && v ? ' queued' : ''}">${esc(k)} ${v}</span>`).join('')}</div>${body}${
    c.recent.length ? `<details class="conv-recent"><summary>最近完成 ${c.recent.length} 个回合</summary>${recentList(c.recent)}</details>` : ''}</div></article>`;
}

export function liveBody(convs: LiveConversationView[] | undefined, o: { csrf: string; stop: boolean; ctxBar: (backend: string, thread: string) => string }): string {
  if (!convs) return empty('实时总线未启用。');
  const working = convs.filter(c => c.turn).length;
  return `<section class="flush"><h2 id="live-count">${working ? `${working} 个会话工作中` : convs.length ? '所有会话空闲' : '没有活动的会话'}</h2>
<div id="convs" class="slips" data-csrf="${esc(o.csrf)}" data-stop="${o.stop ? '1' : ''}">${convs.map(c => conversationRow(c, o)).join('')}</div>
<div id="convs-empty"${convs.length ? ' hidden' : ''}>${empty('眼下没有活动的会话。消息到达后，所在会话会立即出现一行，并实时显示当前回合走到哪一步。')}</div>
<p class="hint mt">每个会话（群、私聊、owner）一行。空闲会话在最后一个回合结束后保留半小时；全部回合见<a href="/turns">回合列表</a>。</p></section>`;
}

/* ───────── /turns ───────── */

export interface TurnListFilters { status: string; thread: string; backend: string; kind: string }

export function turnListBody(rows: TurnRowView[], f: TurnListFilters, page: number, link: (page: number) => string, names: Record<string, string> = {}): string {
  const opt = (name: keyof TurnListFilters, choices: [string, string][]) => `<select name="${name}"><option value="">全部</option>${choices.map(([v, l]) => `<option value="${esc(v)}"${f[name] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  let body = `<form class="bar"><label>状态${opt('status', [['processing', '进行中'], ['completed', '已完成'], ['failed', '失败'], ['lost', '中断']])}</label>
<label>会话<input name="thread" placeholder="owner、group:123 或 private:456" value="${esc(f.thread)}"></label><label>种类${opt('kind', Object.entries(TURN_KINDS))}</label><label>后端${opt('backend', Object.entries(BACKENDS))}</label><button>筛选</button>${Object.values(f).some(Boolean) ? '<a class="btn quiet" href="/turns">清除</a>' : ''}</form>`;
  body += rows.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>状态</th><th>开始</th><th>会话 / 发送者</th><th class="hide-sm">种类 / 后端</th><th class="num">耗时</th><th class="hide-sm">回合</th></tr></thead><tbody>${rows.map(r => {
    const id = r.key.slice(5);
    return `<tr><td>${statusStamp(r.status)}</td><td>${time(r.ts)}</td><td>${r.thread ? `<a href="${conversationHref(r.thread)}">${esc(threadLabel(r.thread, names[r.thread]))}</a>` : esc(threadLabel(r.scope))}<br><small>${esc(r.sender ?? '')}</small></td><td class="hide-sm">${esc(kindText(r.kind))}<br><small>${esc(backendName(r.backend))}</small></td><td class="num">${esc(fmtMs(r.duration_ms))}</td><td class="hide-sm"><a class="mono" href="${turnHref(id)}">${esc(id.slice(0, 24))}</a></td></tr>`;
  }).join('')}</tbody></table></div></div>`
    : empty(page ? '这一页没有更多回合了。' : '没有符合条件的回合。换个筛选条件，或清除筛选查看全部。');
  body += `<p class="hint mt">${page ? `<a href="${link(page - 1)}">上一页</a>　` : ''}第 ${page + 1} 页${rows.length === 50 ? `　<a href="${link(page + 1)}">下一页</a>` : ''}</p>`;
  return body;
}

/* ───────── 事件时间线（回合页、输入页共用） ───────── */

export interface TrailOptions {
  summarize(event: { stage: string; status: string | null; detail: Record<string, unknown> }): string;
  /** 在某个事件行内追加的内容（缓存命中） */
  extra?: (e: ObsEvent) => { inline: string; list: string } | undefined;
}
export function trail(events: ObsEvent[], t0: number, o: TrailOptions): string {
  return `<ol class="trail">${events.map(e => {
    const d = detail(e), terminal = ['reply_sent', 'failed', 'fallback'].includes(e.stage) && d.terminal === true;
    const sum = o.summarize({ stage: e.stage, status: e.status, detail: d });
    const extra = o.extra?.(e);
    return `<li class="${e.status === 'started' ? 'started' : e.status === 'failed' ? 'failed' : 'ok'}${terminal ? ' terminal' : ''}"><div class="row"><span class="t">+${esc(fmtMs(e.ts - t0) || '0 毫秒')}</span><span class="stage">${esc(stageLabel(e.stage))}${e.status === 'started' ? ' 开始' : ''}</span>${extra?.inline ?? ''}${e.status === 'failed' ? stamp('失败', 'fail') : ''}${e.duration_ms !== null ? `<span class="muted">${esc(fmtMs(e.duration_ms))}</span>` : ''}<code class="faint">${esc(e.stage)}</code></div>${extra?.list ?? ''}${sum ? `<div class="sum">${esc(sum)}</div>` : ''}<details><summary>详情</summary>${json(d)}</details></li>`;
  }).join('')}</ol>`;
}

/* ───────── /turns/:id ───────── */

export interface InputInfo { key: string; kind: string; sender: string; text: string; scope: string }
export interface TurnPageData {
  id: string;
  /** 本回合全部事件（最多 2000 条），用于汇总 */
  all: ObsEvent[];
  /** 本页的时间线事件（分页） */
  page: ObsEvent[];
  after: number; limit: number;
  inputs: InputInfo[];
  /** 会话显示名（群名） */
  names: Record<string, string>;
  settingsLine?: string;
  /** 当前回合仍在进行时，会话的实时状态（排队、子 agent），以及能否停止 */
  live?: { queued: number; subagents: number | null; stop: boolean; csrf: string };
}

/** 回合结果：终态事件的 detail.status，缺省按 stage；没有终态为 processing。 */
export function turnStatus(events: ObsEvent[]): { status: string; reason: string } {
  const t = events.filter(e => (e.stage === 'reply_sent' || e.stage === 'failed') && detail(e).terminal === true).at(-1);
  if (!t) return { status: 'processing', reason: '' };
  const d = detail(t);
  return { status: str(d.status) || (t.stage === 'failed' ? 'failed' : 'completed'), reason: str(d.reason) };
}

export function turnPage(data: TurnPageData, o: TrailOptions): string {
  const { all, id } = data;
  const received = all.find(e => e.stage === 'received'), dispatched = all.find(e => e.stage === 'dispatched');
  const terminal = all.filter(e => (e.stage === 'reply_sent' || e.stage === 'failed') && detail(e).terminal === true).at(-1);
  const rd = received ? detail(received) : {}, dd = dispatched ? detail(dispatched) : {}, td = terminal ? detail(terminal) : {};
  const thread = str(td.thread_key) || str(rd.thread_key) || str(dd.thread_key) || str(dd.conversation_key);
  const kind = str(td.kind) || str(dd.kind) || str(rd.kind);
  const { status, reason } = turnStatus(all);
  const t0 = all[0]!.ts, t1 = all.at(-1)!.ts;
  const scope = all.find(e => e.scope)?.scope ?? '';
  const live = status === 'processing' ? data.live : undefined;
  let body = `<div class="sheet pad"><div class="slip-top">${statusStamp(status, true)}<span class="mono faint">${esc(id)}</span>${live?.stop && thread ? stopForm(live.csrf, thread, conversationHref(thread)) : ''}</div><div class="mt">${kv([
    ['会话', thread ? `<a href="${conversationHref(thread)}">${esc(threadLabel(thread, data.names[thread]))}</a>` : esc(threadLabel(scope))],
    ['种类', esc(kindText(kind))], ['发送者', esc(str(rd.sender) || '—')],
    ['后端', esc(backendName(str(dd.backend)) || '—')],
    ...(data.settingsLine ? [['设置', esc(data.settingsLine)] as [string, string]] : []),
    ['开始', esc(fmtTime(t0))], [status === 'processing' ? '已进行' : '总耗时', esc(fmtMs(t1 - t0) || '0 毫秒')],
    ...(live ? [['排队输入', String(live.queued)] as [string, string], ...(live.subagents !== null ? [['在跑子 agent', String(live.subagents)] as [string, string]] : [])] : []),
    ...(reason ? [['原因', esc(reason)] as [string, string]] : []),
  ], 'meta')}</div></div>`;

  body += `<section><h2>输入 <small>${data.inputs.length} 条${kind === 'wake' && !data.inputs.length ? '（唤醒回合没有新输入）' : ''}</small></h2>${data.inputs.length ? `<ol class="conv-inputs said-list">${data.inputs.map(i =>
    `<li><div class="slip-top">${i.kind ? `<span class="pill">${esc(TURN_KINDS[i.kind] ?? i.kind)}</span>` : ''}<b>${esc(i.sender || '—')}</b><a class="mono faint" href="/inputs/${uri(i.key)}">${esc(i.key.slice(0, 16))}</a></div><blockquote class="said">${esc(i.text || '（无正文）')}</blockquote></li>`).join('')}</ol>`
    : str(rd.text) ? `<blockquote class="said">${esc(str(rd.text))}</blockquote>` : empty(kind === 'wake' ? '子 agent 完成或后端自己开的回合，没有新输入。' : '没有记录到输入。')}<p class="hint">正文只保存脱敏后的前 500 字。</p></section>`;

  const sends = all.filter(e => e.stage === 'send_message' || e.stage === 'send_rejected');
  body += `<section><h2>发送 <small>${sends.filter(e => e.stage === 'send_message').length} 条</small></h2>${sends.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>时间</th><th>目标</th><th>状态</th><th>正文</th></tr></thead><tbody>${sends.map(e => {
    const d = detail(e), rejected = e.stage === 'send_rejected';
    return `<tr><td>+${esc(fmtMs(e.ts - t0) || '0 毫秒')}</td><td class="mono">${esc(str(d.target) || '—')}${d.system === true ? ' <small class="muted">系统</small>' : ''}</td><td>${rejected ? stamp('被规则拒绝', 'fail') : statusStamp(str(d.status) || 'sent')}</td><td>${esc(rejected ? str(d.error) : str(d.text) || (d.message_id ? `消息 #${String(d.message_id)}` : '—'))}</td></tr>`;
  }).join('')}</tbody></table></div></div>` : empty('这一轮没有发送消息。')}</section>`;

  const tools = all.filter(e => e.stage.startsWith('tool:') && e.status !== 'started');
  const running = all.filter(e => e.stage.startsWith('tool:') && e.status === 'started' && !tools.some(t => t.stage === e.stage && t.ts >= e.ts));
  body += `<section><h2>工具调用 <small>${tools.length} 次${running.length ? `，${running.length} 次进行中` : ''}</small></h2>${tools.length || running.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>时间</th><th>工具</th><th>结果</th><th class="num">耗时</th><th>摘要</th></tr></thead><tbody>${[...tools, ...running].sort((a, b) => a.id - b.id).map(e => {
    const sum = o.summarize({ stage: e.stage, status: e.status, detail: detail(e) });
    return `<tr><td>+${esc(fmtMs(e.ts - t0) || '0 毫秒')}</td><td class="mono">${esc(e.stage.slice(5))}</td><td>${e.status === 'started' ? stamp('进行中', 'run') : e.status === 'failed' ? stamp('失败', 'fail') : stamp('完成', 'ok')}</td><td class="num">${esc(fmtMs(e.duration_ms) || '—')}</td><td>${esc(sum)}</td></tr>`;
  }).join('')}</tbody></table></div></div>` : empty('这一轮没有调用工具。')}</section>`;

  const subagents = all.filter(e => e.stage === 'subagent' || (e.stage === 'tool:subagent' && e.status !== 'started'));
  if (subagents.length) body += `<section><h2>子 agent 活动 <small>${subagents.length} 条</small></h2><ol class="feed">${subagents.map(e => `<li><span class="faint">+${esc(fmtMs(e.ts - t0) || '0 毫秒')}</span><span class="sum"><b>${esc(stageLabel(e.stage))}</b>  ${esc(o.summarize({ stage: e.stage, status: e.status, detail: detail(e) }))}</span></li>`).join('')}</ol></section>`;

  const errors = all.filter(e => e.status === 'failed' || e.stage === 'model_error');
  if (errors.length) body += `<section><h2>错误 <small>${errors.length} 条</small></h2><div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>时间</th><th>阶段</th><th>说明</th></tr></thead><tbody>${errors.map(e => {
    const d = detail(e);
    return `<tr class="rc-err"><td>+${esc(fmtMs(e.ts - t0) || '0 毫秒')}</td><td>${esc(stageLabel(e.stage))}</td><td>${esc(o.summarize({ stage: e.stage, status: e.status, detail: d }) || str(d.error) || str(d.reason) || str(d.error_category) || '—')}</td></tr>`;
  }).join('')}</tbody></table></div></div></section>`;

  body += `<section><h2>时间线 <small>${data.page.length} 个事件${data.after ? '（续）' : ''}</small></h2>${trail(data.page, t0, o)}`;
  if (data.page.length === data.limit) body += `<p><a href="${turnHref(id)}?after=${data.page.at(-1)!.id}&amp;limit=${data.limit}">下一页事件</a></p>`;
  return body + '</section>';
}

/* ───────── /inputs/:key ───────── */

export function inputPage(key: string, events: ObsEvent[], o: TrailOptions & { settingsLine?: (settings: Record<string, unknown>) => string }): string {
  const t0 = events[0]!.ts;
  const received = events.find(e => e.stage === 'received' || e.stage === 'recovered');
  const queued = events.find(e => e.stage === 'queued'), delivered = events.filter(e => e.stage === 'delivered').at(-1);
  const admitted = events.find(e => e.stage === 'admitted');
  const rd = received ? detail(received) : {}, qd = queued ? detail(queued) : {};
  const turn = delivered ? str(detail(delivered).turn) : '';
  const thread = str(qd.thread_key) || (admitted ? str(detail(admitted).thread_key) : '');
  const settings = admitted ? asObj(detail(admitted).settings) : {};
  const state = events.some(e => e.stage === 'ignored') ? ['已忽略', 'idle'] as const : turn ? ['已送达', 'run'] as const : queued ? ['排队', 'queue'] as const : ['已收到', 'idle'] as const;
  const legacy = events.some(e => !e.key.startsWith('in:'));
  let body = `<div class="sheet pad"><div class="slip-top">${stamp(state[0], state[1], true)}<span class="mono faint">${esc(key)}</span></div><div class="mt">${kv([
    ['会话', thread ? `<a href="${conversationHref(thread)}">${esc(threadLabel(thread))}</a>` : esc(threadLabel(events.find(e => e.scope)?.scope ?? ''))],
    ['种类', esc(TURN_KINDS[str(qd.kind)] ?? (key.startsWith('run_') ? TURN_KINDS.scheduled : TURN_KINDS.user))], ['发送者', esc(str(rd.sender) || '—')],
    ['所在回合', turn ? `<a class="mono" href="${turnHref(turn)}">${esc(turn)}</a>` : '<span class="faint">尚未开轮</span>'],
    ...(typeof settings.backend === 'string' && o.settingsLine ? [['开轮设置', esc(o.settingsLine(settings))] as [string, string]] : []),
    ['收到', esc(fmtTime(t0))],
  ], 'meta')}</div></div>`;
  if (str(rd.text)) body += `<section><h2>正文</h2><blockquote class="said">${esc(str(rd.text))}</blockquote><p class="hint">正文只保存脱敏后的前 500 字。</p></section>`;
  body += `<section><h2>流转 <small>${events.length} 个事件${legacy ? '，含旧版票据记录' : ''}</small></h2>${trail(events, t0, o)}</section>`;
  return body;
}

/* ───────── /conversations/:thread ───────── */

export function conversationPage(thread: string, o: { name?: string; live?: LiveConversationView; rows: TurnRowView[]; page: number; link: (page: number) => string;
  csrf: string; stop: boolean; ctxBar: (backend: string, thread: string) => string }): string {
  const c = o.live, t = c?.turn;
  const backend = c?.backend || o.rows.find(r => r.backend)?.backend || '';
  let body = `<div class="sheet pad"><div class="slip-top">${statusStamp(c?.state ?? 'idle', true)}<b>${esc(threadLabel(thread, o.name))}</b>${backend ? `<span class="pill">${esc(backendName(backend))}</span>` : ''}${t && o.stop ? stopForm(o.csrf, thread, conversationHref(thread)) : ''}${backend ? o.ctxBar(backend, thread) : ''}</div><div class="mt">${kv([
    ['会话键', `<span class="mono">${esc(thread)}</span>`],
    ['当前回合', t ? `<a href="${turnHref(t.id)}">${esc(kindText(t.kind, t.sender))}</a>，已耗时 ${esc(fmtMs(Date.now() - t.started))}` : '<span class="faint">空闲</span>'],
    ['排队输入', String(c?.queued.length ?? 0)],
    ...(c && c.subagents !== null ? [['在跑子 agent', String(c.subagents)] as [string, string]] : []),
  ], 'meta')}</div><p class="hint mt">${backend ? `<a href="/context-usage?backend=${uri(backend)}&amp;key=${uri(thread)}">上下文监控</a>　` : ''}<a href="/turns?thread=${uri(thread)}">在回合列表中筛选</a>　<a href="/live">实时页</a></p></div>`;
  if (c?.queued.length) body += `<section><h2>排队中的输入 <small>${c.queued.length} 条，等本轮结束后依次开轮</small></h2><ul>${c.queued.map(k => `<li><a class="mono" href="/inputs/${uri(k)}">${esc(k.slice(0, 16))}</a></li>`).join('')}</ul></section>`;
  body += `<section><h2>最近回合 <small>最新在上</small></h2>${o.rows.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>状态</th><th>开始</th><th>种类 / 发送者</th><th class="hide-sm">后端</th><th class="num">耗时</th><th>回合</th></tr></thead><tbody>${o.rows.map(r => {
    const id = r.key.slice(5);
    return `<tr><td>${statusStamp(r.status)}</td><td>${time(r.ts)}</td><td>${esc(kindText(r.kind))}<br><small>${esc(r.sender ?? '')}</small></td><td class="hide-sm">${esc(backendName(r.backend))}</td><td class="num">${esc(fmtMs(r.duration_ms))}</td><td><a class="mono" href="${turnHref(id)}">${esc(id.slice(0, 24))}</a></td></tr>`;
  }).join('')}</tbody></table></div></div>` : empty(o.page ? '这一页没有更多回合了。' : '还没有记录到这个会话的回合。')}<p class="hint mt">${o.page ? `<a href="${o.link(o.page - 1)}">上一页</a>　` : ''}第 ${o.page + 1} 页${o.rows.length === 50 ? `　<a href="${o.link(o.page + 1)}">下一页</a>` : ''}</p></section>`;
  return body;
}

