/**
 * 观测 v2 回合视图（设计 §3）：服务端渲染回合头与正文块。所有文本经 esc（先脱敏再转义）；
 * 块结构与 agents-client.ts 的客户端渲染保持同一类名，实时追加与懒加载复用同一套样式。
 */
import type { Block, ContentRef, ObservedTurn, Usage } from '../sessions/types.js';
import { fmtInt, fmtPct, ratio } from '../../shared/format.js';
import { esc, fmtBytes, fmtMs, fmtTime, stamp, statusStamp, traceHref, uri, type Tone } from './html.js';
import { scopeLabel } from '../../context/access.js';

export const TURN_STATUS: Record<string, [string, Tone]> = { ok: ['完成', 'ok'], failed: ['失败', 'fail'], running: ['进行中', 'run'] };
export const turnStamp = (status: string) => { const [label, tone] = TURN_STATUS[status] ?? [status || '未知', 'idle' as Tone]; return stamp(label, tone); };

export const KIND_LABEL: Record<string, string> = {
  user: '用户', assistant: '助手', thinking: '思考', tool_call: '工具调用', tool_result: '工具结果', image: '图片',
  event: '事件', compaction: '上下文压缩', system_change: '系统变更',
};

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): string | undefined => typeof v === 'string' && v ? v : undefined;
export const isRequest = (b: Block) => b.kind === 'event' && b.meta?.type === 'model_request';

/** meta.usage 的白名单读取；缺 input 视为无实测。 */
export function usageOf(meta: Record<string, unknown> | undefined): Usage | undefined {
  const u = meta?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const o = u as Record<string, unknown>;
  if (!num(o.input)) return undefined;
  return { input: o.input, output: num(o.output) ? o.output : 0, ...(num(o.cached) ? { cached: o.cached } : {}),
    ...(num(o.reasoning) ? { reasoning: o.reasoning } : {}), measured: o.measured !== false };
}

export interface TurnFacts { model?: string; effort?: string; requests: number; context?: Usage }
/**
 * 上下文占用 = 回合内最后一次带实测 usage 的 model_request 的 input（设计 §9 O1 验收说明）；
 * turn.usage 是全部请求累加，只能作为"回合累计"。
 */
export function turnFacts(blocks: Block[]): TurnFacts {
  const reqs = blocks.filter(isRequest);
  const withModel = reqs.filter(b => str(b.meta?.model)).at(-1);
  const withUsage = reqs.filter(b => usageOf(b.meta)).at(-1);
  return { requests: reqs.length, model: str(withModel?.meta?.model), effort: str(reqs.filter(b => str(b.meta?.effort)).at(-1)?.meta?.effort),
    ...(withUsage ? { context: usageOf(withUsage.meta) } : {}) };
}

export interface SessionCtx { backend: string; session: string; window?: number }
const base = (c: SessionCtx) => `/agents/${uri(c.backend)}/sessions/${uri(c.session)}`;
export const turnHref = (c: SessionCtx, turn: string) => `${base(c)}/turns/${uri(turn)}`;
export const contextHref = (c: SessionCtx, turn: string, phase: 'before' | 'after') => `${base(c)}/context?at=${uri(turn)}&amp;phase=${phase}`;

export const fmtUsage = (u: Usage) => `输入 ${fmtInt(u.input)}${u.cached ? `（缓存 ${fmtInt(u.cached)}）` : ''} · 输出 ${fmtInt(u.output)}${u.reasoning ? `（推理 ${fmtInt(u.reasoning)}）` : ''}`;
export const ctxText = (input: number, window?: number) => `${fmtInt(input)}${window ? ` / ${fmtInt(window)}（${fmtPct(ratio(input, window))}）` : ''} tokens`;

/** 回合头的事实行（时间、耗时、模型、上下文、累计、QQ 来源）；facts 缺省时（懒加载回合）只给索引字段，客户端补齐。 */
export function turnMeta(c: SessionCtx, t: ObservedTurn, facts?: TurnFacts): string {
  const parts: string[] = [`<span class="tm-time">${esc(fmtTime(t.started))}</span>`];
  if (t.ended !== undefined) parts.push(`<span>耗时 ${esc(fmtMs(t.ended - t.started) || '0 毫秒')}</span>`);
  const model = facts ? [facts.model, facts.effort].filter(Boolean).join(' · ') : '';
  parts.push(`<span class="tm-model">${model ? esc(model) : ''}</span>`);
  parts.push(`<span class="tm-ctx" title="最后一次模型请求的实测输入，即该回合结束时窗口里的内容">${facts?.context ? `上下文 ${esc(ctxText(facts.context.input, c.window))}` : ''}</span>`);
  if (t.usage) parts.push(`<span class="tm-sum" title="回合内全部模型请求的 usage 之和，不代表上下文占用">回合累计 ${esc(fmtUsage(t.usage))}${t.requests > 1 ? `，${t.requests} 次请求` : ''}</span>`);
  return parts.join('');
}

export function qqLine(t: ObservedTurn): string {
  const href = t.traceKey ? traceHref(t.traceKey) : undefined;
  if (!t.traceKey || !href) return '';
  const d = t.delivery;
  return `<span class="tm-qq">QQ 回合 <a class="mono" href="${href}">${esc(t.traceKey.replace(/^turn:/, '').slice(0, 24))}</a>${d ? ` ${statusStamp(d.status)}${d.scope ? ` ${esc(scopeLabel(d.scope))}` : ''}${num(d.duration_ms) ? ` ${esc(fmtMs(d.duration_ms))}` : ''}` : ''}</span>`;
}

export const contextLinks = (c: SessionCtx, turn: string) =>
  `<span class="tm-links"><a href="${contextHref(c, turn, 'before')}">分析此回合前的上下文</a><a href="${contextHref(c, turn, 'after')}">分析此回合后的上下文</a></span>`;

/* ───────── 正文块 ───────── */

const refAttrs = (r: ContentRef) => `data-session="${esc(r.session)}" data-offset="${Number(r.offset)}" data-length="${Number(r.length)}"`;
const loadButton = (r: ContentRef) => `<button type="button" class="quiet load-full" ${refAttrs(r)}>加载全文（${esc(fmtBytes(r.bytes ?? r.length))}）</button><span class="load-note" role="status"></span>`;

function prettyJson(text: string): string {
  try { const v = JSON.parse(text); return typeof v === 'object' && v !== null ? JSON.stringify(v, null, 2) : text; } catch { return text; }
}

/** 正文：内联文本，或预览 + 加载全文。pre=true 时使用等宽块。 */
function body(b: Block, o: { pre?: boolean; json?: boolean } = {}): string {
  const tag = o.pre ? 'pre' : 'div', cls = o.pre ? 'bt' : 'bt prose';
  const json = o.json ? ' data-json="1"' : '';
  if (b.text !== undefined) return `<${tag} class="${cls}"${json}>${esc(o.json ? prettyJson(b.text) : b.text)}</${tag}>`;
  if (b.ref) return `<${tag} class="${cls} partial"${json}>${esc(b.preview ?? '')}</${tag}><div class="load-row">${loadButton(b.ref)}</div>`;
  return `<${tag} class="${cls} faint">（无正文）</${tag}>`;
}

const toolName = (m: Record<string, unknown> | undefined) => str(m?.name) ?? '未知工具';
const toolServer = (m: Record<string, unknown> | undefined) => str(m?.server) ?? str(m?.namespace);
const resultStamp = (status: unknown) => status === 'failed' ? stamp('失败', 'fail') : status === 'running' ? stamp('进行中', 'run') : stamp('成功', 'ok');
const tsAttr = (b: Block) => num(b.ts) ? ` data-ts="${b.ts}"` : '';

export function requestRow(b: Block): string {
  const m = b.meta ?? {}, u = usageOf(m);
  const bits = [num(m.request) ? `模型请求 #${m.request}` : '模型请求', str(m.model), str(m.effort), u ? fmtUsage(u) : '', num(m.duration_ms) ? `耗时 ${fmtMs(m.duration_ms)}` : ''].filter(Boolean);
  return `<div class="blk req"${u ? ' data-usage="1"' : ''}${tsAttr(b)}><span>${esc(bits.join(' · '))}</span></div>`;
}

function resultHtml(r: Block): string {
  return `<details class="tc-res"><summary>结果 ${resultStamp(r.meta?.status)}</summary>${body(r, { pre: true })}</details>`;
}

function toolCard(b: Block, result?: Block): string {
  const m = b.meta ?? {}, server = toolServer(m);
  const status = result ? result.meta?.status ?? m.status : m.status;
  return `<div class="blk tc"${b.callId ? ` data-call="${esc(b.callId)}"` : ''}${tsAttr(b)}><div class="tc-head"><b class="tc-name">${esc(toolName(m))}</b>${server ? `<span class="pill">${esc(server)}</span>` : ''}<span class="tc-status">${resultStamp(status)}</span><span class="tc-dur faint">${num(m.duration_ms) ? esc(fmtMs(m.duration_ms)) : ''}</span></div>
<details class="tc-args"><summary>参数</summary>${body(b, { pre: true, json: true })}</details><div class="tc-slot">${result ? resultHtml(result) : ''}</div></div>`;
}

export function blockHtml(b: Block, result?: Block): string {
  const m = b.meta ?? {};
  switch (b.kind) {
    case 'user': return `<div class="blk user"${tsAttr(b)}><div class="bk">用户</div>${body(b)}</div>`;
    case 'assistant': return `<div class="blk assistant"${tsAttr(b)}><div class="bk">助手</div>${body(b)}</div>`;
    case 'image': return `<div class="blk image"${tsAttr(b)}><span class="img-ph" aria-label="图片占位">▣</span><span>${esc(b.text || '图片')}</span>${str(m.mimeType) ? `<span class="faint">${esc(m.mimeType)}</span>` : ''}${str(m.source) ? `<span class="faint mono">${esc(String(m.source).slice(0, 120))}</span>` : ''}</div>`;
    case 'thinking': return m.unavailable && b.text === undefined && !b.ref
      ? `<div class="blk thinking"${tsAttr(b)}><span class="bk">思考</span> <span class="faint">不可用（加密或已省略）</span></div>`
      : `<details class="blk thinking"${tsAttr(b)}><summary>思考${m.unavailable ? '（部分不可用）' : ''}</summary>${body(b)}</details>`;
    case 'tool_call': return toolCard(b, result);
    case 'tool_result': return `<div class="blk tc orphan"${b.callId ? ` data-call="${esc(b.callId)}"` : ''}${tsAttr(b)}><div class="tc-head"><b class="tc-name">${esc(str(m.name) ?? '工具结果')}</b></div><div class="tc-slot">${resultHtml(b)}</div></div>`;
    case 'compaction': return `<details class="blk compaction"${tsAttr(b)}><summary>上下文压缩${str(m.reason) ? ` · ${esc(m.reason)}` : ''}</summary>${body(b)}</details>`;
    case 'system_change': return `<details class="blk sysch"${tsAttr(b)}><summary>系统变更${m.reset ? '（上下文重置）' : ''}</summary>${body(b, { pre: true })}</details>`;
    case 'event': {
      if (m.type === 'model_request') return requestRow(b);
      if (m.type === 'model_usage') return '';
      if (m.type === 'turn_complete' || m.type === 'turn_failed') return `<div class="blk end"${tsAttr(b)}>${m.type === 'turn_complete' ? stamp('回合完成', 'ok') : stamp('回合失败', 'fail')}</div>`;
      return `<div class="blk ev${m.status === 'failed' ? ' failed' : ''}"${tsAttr(b)}>${m.status === 'failed' ? stamp('错误', 'fail') : ''}<span>${esc(b.text ?? b.preview ?? str(m.type) ?? '事件')}</span></div>`;
    }
    default: return `<div class="blk ev"${tsAttr(b)}>${body(b)}</div>`;
  }
}

/** 工具结果按 callId 挂到对应调用卡片下；找不到调用的结果单独成卡。 */
export function blocksHtml(blocks: Block[]): string {
  const calls = new Set(blocks.filter(b => b.kind === 'tool_call' && b.callId).map(b => b.callId!));
  const results = new Map<string, Block>();
  for (const b of blocks) if (b.kind === 'tool_result' && b.callId && calls.has(b.callId) && !results.has(b.callId)) results.set(b.callId, b);
  const used = new Set<Block>(results.values());
  return blocks.map(b => used.has(b) ? '' : blockHtml(b, b.kind === 'tool_call' && b.callId ? results.get(b.callId) : undefined)).join('');
}
