/**
 * 回合页的聊天视图（/turns）：左侧会话列表（最近活动在前），右侧按时间排列的聊天记录。收到的输入（用户消息、定时任务）是左侧气泡，
 * 本轮发出的消息（send_message）是右侧气泡，同一回合成组；回合的状态、设置、工具与模型请求折叠在组内，展开时读 /turns/:id?part=1。
 * 数据只来自观测事件（chatEvents 批量读取，工具与请求只计数）；所有文本经 esc。
 */
import type { ObsEvent } from '../../shared/trace.js';
import { BACKENDS, TURN_KINDS, empty, esc, fmtMs, fmtTime, stamp, statusStamp, threadLabel, time, uri } from './html.js';
import { conversationHref, turnHref, turnInputs, type InputInfo, type TurnRowView } from './turn-pages.js';

/** target 为空表示发回本会话。 */
export interface ChatSend { ts: number; target: string; text: string; status: string; system: boolean; rejected?: string }
export interface ChatTurn { id: string; ts: number; status: string; kind: string; backend: string; settingsLine: string; duration_ms: number; inputs: InputInfo[]; sends: ChatSend[]; tools: number; requests: number }
export interface ChatThread { thread: string; updated: number; turns: number }

const asObj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const detail = (e: ObsEvent) => { try { return asObj(JSON.parse(e.detail_json)); } catch { return {}; } };
const str = (v: unknown) => typeof v === 'string' ? v : '';
const group = (events: ObsEvent[]) => { const m = new Map<string, ObsEvent[]>(); for (const e of events) { const l = m.get(e.key); if (l) l.push(e); else m.set(e.key, [e]); } return m; };

/** 一页回合（store.turns 的行，最新在前）→ 聊天回合（最早在前）。两次批量读取：回合键，再是这些回合引用的输入键。 */
export function chatTurns(rows: TurnRowView[], chatEvents: (keys: readonly string[]) => ObsEvent[], settingsLine: (s: Record<string, unknown>) => string): ChatTurn[] {
  const byTurn = group(chatEvents(rows.map(r => r.key)));
  const inKeys = new Set<string>();
  for (const evs of byTurn.values()) for (const e of evs) {
    if (!['received', 'dispatched', 'steered'].includes(e.stage)) continue;
    const d = detail(e);
    for (const k of Array.isArray(d.inputs) ? d.inputs : [d.input]) if (typeof k === 'string') inKeys.add('in:' + k);
  }
  const byInput = group(chatEvents([...inKeys]));
  return [...rows].reverse().map(r => {
    const all = byTurn.get(r.key) ?? [];
    const { inputs, settings } = turnInputs(all, k => byInput.get('in:' + k) ?? []);
    // 没有记下入站键的回合（旧数据）用开轮事件里的正文
    const received = all.find(e => e.stage === 'received'), rd = received ? detail(received) : {};
    if (!inputs.length && received && str(rd.text)) inputs.push({ key: '', kind: r.kind === 'scheduled' ? 'scheduled' : '', sender: str(rd.sender), text: str(rd.text), scope: received.scope, ts: received.ts });
    const sends = all.filter(e => e.stage === 'send_message' || e.stage === 'send_rejected').map(e => {
      const d = detail(e), rejected = e.stage === 'send_rejected';
      return { ts: e.ts, target: str(d.target) === `qq:${r.thread}` ? '' : str(d.target), text: str(d.text), status: rejected ? 'rejected' : str(d.status) || 'sent', system: d.system === true, ...(rejected ? { rejected: str(d.error) } : {}) };
    });
    return { id: r.key.slice(5), ts: r.ts, status: r.status, kind: r.kind ?? '', backend: r.backend ?? '', settingsLine: settings ? settingsLine(settings) : '', duration_ms: r.duration_ms,
      inputs, sends, tools: all.filter(e => e.stage.startsWith('tool:')).length, requests: all.filter(e => e.stage === 'model_request').length };
  });
}

const day = (ts: number) => new Date(ts).toLocaleDateString('zh-CN', { timeZone: process.env.TZ || undefined, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const clock = (ts: number) => `<time datetime="${new Date(ts).toISOString()}" title="${esc(fmtTime(ts))}">${esc(new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, timeZone: process.env.TZ || undefined, hour: '2-digit', minute: '2-digit' }))}</time>`;

function inBubble(i: InputInfo, fallbackTs: number): string {
  const sched = i.kind === 'scheduled';
  return `<div class="bubble in${sched ? ' sched' : ''}"><div class="b-who">${sched ? stamp('定时任务', 'queue') : ''}<b>${esc(i.sender || (sched ? '定时任务' : '—'))}</b>${clock(i.ts ?? fallbackTs)}${i.key ? `<a class="b-key faint mono" href="/inputs/${uri(i.key)}" title="输入详情">${esc(i.key.slice(0, 10))}</a>` : ''}</div><div class="b-text">${esc(i.text || '（无正文）')}</div></div>`;
}
function outBubble(s: ChatSend): string {
  const bad = s.status !== 'sent';
  return `<div class="bubble out${bad ? ' failed' : ''}"><div class="b-who">${bad ? (s.rejected !== undefined ? stamp('被规则拒绝', 'fail') : statusStamp(s.status)) : ''}<b>cs-agent</b>${s.system ? '<span class="pill">系统</span>' : ''}${s.target ? `<span class="mono">→ ${esc(s.target)}</span>` : ''}${clock(s.ts)}</div><div class="b-text">${esc(s.rejected ?? (s.text || '（无正文）'))}</div></div>`;
}

/** 回合折叠块：摘要一行（状态、种类、设置、耗时、计数），正文展开时按需读取。 */
function turnMeta(t: ChatTurn): string {
  const facts = [t.settingsLine || BACKENDS[t.backend] || t.backend, `耗时 ${fmtMs(t.duration_ms) || '0 毫秒'}`, `请求 ${t.requests}`, `工具 ${t.tools}`, `发送 ${t.sends.filter(s => s.status === 'sent').length}`].filter(Boolean);
  return `<details class="chat-meta" data-src="${turnHref(t.id)}?part=1"><summary>${statusStamp(t.status)}${t.kind && t.kind !== 'user' ? `<span class="pill">${esc(TURN_KINDS[t.kind] ?? t.kind)}</span>` : ''}<span class="chat-facts">${esc(facts.join(' · '))}</span><a class="chat-link" href="${turnHref(t.id)}">回合详情</a></summary><div class="chat-meta-body"><p class="faint">读取中…</p></div></details>`;
}

/** 一页回合（最早在前）；prev 为上一组的时间，跨天时插日期分隔。 */
export function chatTurnsHtml(turns: ChatTurn[], prev?: number): string {
  let last = prev, out = '';
  for (const t of turns) {
    if (last === undefined || day(last) !== day(t.ts)) out += `<div class="chat-day"><span>${esc(day(t.ts))}</span></div>`;
    last = t.ts;
    const items = [...t.inputs.map(i => ({ ts: i.ts ?? t.ts, out: false, html: inBubble(i, t.ts) })), ...t.sends.map(s => ({ ts: s.ts, out: true, html: outBubble(s) }))]
      .sort((a, b) => a.ts - b.ts || Number(a.out) - Number(b.out));
    const firstOut = items.findIndex(x => x.out);
    const meta = turnMeta(t);
    const wake = t.kind === 'wake' && !t.inputs.length ? '<div class="chat-note faint">子 agent 完成或后端自行开轮，没有新输入</div>' : '';
    const html = firstOut < 0 ? items.map(x => x.html).join('') + meta : items.slice(0, firstOut).map(x => x.html).join('') + meta + items.slice(firstOut).map(x => x.html).join('');
    out += `<section class="chat-turn${t.kind === 'scheduled' ? ' sched' : ''}" id="turn-${esc(t.id)}" data-turn="${esc(t.id)}">${wake}${html}${t.sends.length ? '' : '<div class="chat-note faint">本轮没有发送消息</div>'}</section>`;
  }
  return out;
}

/** 聊天记录顶部：还有更早的回合时是"加载更早"（无脚本时整页翻到更早一页，有脚本时 chat.js 取 part=1 片段插到顶部），否则是到头提示。 */
export const olderHtml = (thread: string, page: number, more: boolean) => more
  ? `<a class="chat-more btn quiet" href="/turns?thread=${uri(thread)}&amp;page=${page + 1}">加载更早的回合</a>`
  : '<p class="chat-start faint">已到最早的回合（更早的已过保留期）</p>';

export interface ChatPageInput { threads: ChatThread[]; thread: string; names: Record<string, string>; turns: ChatTurn[]; page: number; more: boolean; backend: string }

export function chatBody(i: ChatPageInput): string {
  const label = (t: string) => threadLabel(t, i.names[t]);
  const list = i.threads.map(t => `<a href="/turns?thread=${uri(t.thread)}"${t.thread === i.thread ? ' aria-current="page"' : ''}><b>${esc(label(t.thread))}</b><small>${time(t.updated)} · ${t.turns} 个回合</small></a>`).join('');
  const nav = `<nav class="chat-convs sheet" aria-label="会话">${list || '<p class="faint">还没有回合记录。</p>'}</nav>`;
  if (!i.thread) return `<div class="chat-layout">${nav}<div class="chat-pane sheet">${empty('还没有记录到任何回合。消息到达并开轮后，这里按会话显示聊天记录。')}</div></div>`;
  const head = `<div class="chat-head"><b>${esc(label(i.thread))}</b>${i.backend ? `<span class="pill">${esc(BACKENDS[i.backend] ?? i.backend)}</span>` : ''}<span class="chat-head-links"><a href="${conversationHref(i.thread)}">会话状态</a>${i.backend ? `<a href="/context-usage?backend=${uri(i.backend)}&amp;key=${uri(i.thread)}">上下文监控</a>` : ''}</span></div>`;
  const log = i.turns.length ? `${olderHtml(i.thread, i.page, i.more)}${chatTurnsHtml(i.turns)}${i.page ? `<a class="chat-newer btn quiet" href="/turns?thread=${uri(i.thread)}${i.page > 1 ? `&amp;page=${i.page - 1}` : ''}">较新的回合</a>` : ''}`
    : empty(i.page ? '这一页没有更多回合了。' : '这个会话还没有记录到回合。');
  return `<div class="chat-layout">${nav}<div class="chat-pane sheet">${head}<div class="chat-log" id="chat-log" data-thread="${esc(i.thread)}">${log}</div></div></div>`;
}
