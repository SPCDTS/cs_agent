/** 面板页面与页面路由；数据经只读契约传入，HTML 保持原样。 */
import { imagesPageBody, imageDetailBody, IMAGES_NOTE } from './images-pages.js';
import type { ImagePage, ImageDetail } from '../memory/types.js';
import { redact, redactText } from '../../shared/redact.js';
import { recallDetailBody, recallFilters, recallQuery, recallsPageBody, turnRecallSection, type RecallDetail, type RecallList } from './recall-pages.js';
import type { ScopeTimeline } from '../memory/types.js';
import { contextBar, ctxLabel } from './context-bar.js';
import { clampPct, fmtInt, fmtPct, ratio, sortUsage, toContextUsage, usageWindow, type ContextUsage, type ContextUsageView } from '../../shared/format.js';
import type { ContextAnalysisOptions, ContextTurn, ThreadContextSeries, TicketBrief } from '../../shared/context-turns.js';
import { BACKENDS, ROUTES, csrfField, empty, epochMs, esc, escFull, fmtBytes, fmtWhen, fmtMs, fmtOffset, fmtTime, json, kv, page, stageLabel, stamp, statusStamp, time, uri, type Flash } from './html.js';
import { scopeLabel } from '../../context/access.js';
import { PRELOAD_TURNS, agentsBody, byNewest, crumbs, dataScript, isBackend, sessionHref, sessionListBody, sessionPageBody, sessionScope, sessionsHref, turnPageBody, type AgentCardInput, type AgentSummary, type ResetTarget } from './agents-pages.js';
import { contentHref, contextBody as contextAnalysisBody, contextError, contextUnavailable, type ContextAnalysis } from './context-view.js';
import type { Block, ObservedTurn, SessionRef } from '../sessions/types.js';
import { vendorAsset } from './vendor.js';
import { MESSAGE_PAGE, archivesPageBody, memoryHomeBody, messageWindow, rangeParams, scopePageBody, searchPageBody, summaryPageBody, type ArchivesResult, type MemoryOverview, type MessagePage, type RecallCount, type SearchResult, type SummaryDetail } from './memory-pages.js';
import type { ObsEvent } from '../../shared/trace.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 页面需要的结构化只读数据；不暴露观测数据库或后端实现。 */
export interface RuntimeSettingsView {
  agentBackend: string; backendOverrides: Record<string, string>; codexReasoningEffort: string; alertOwner: boolean;
  codexModel: string; piModel: string; piThinkingLevel: string;
}
/** 设置页模型下拉的可选清单（启动时读一次）。 */
export interface ModelCatalogView {
  codex(): { slug: string; contextWindow?: number }[];
  pi(): { id: string; contextWindow: number; thinkingLevels: string[] }[];
}
export interface LiveCardView {
  ticket: string; scope: string; sender: string; text: string; state: string; phase: string;
  route: string | null; backend: string | null; thread?: string; started: number; updated: number;
  finished: number | null; outcome: string | null;
  items: { stage: string; status: string | null; ts: number; duration_ms: number | null; summary: string }[];
}
export interface CodexPromptSnapshot { managed: string; custom: string; revision: string; file: string; updatedAt: number | null }
export interface CodexBasePromptSnapshot extends CodexPromptSnapshot { model: string; differs: boolean | null }
export interface DashboardPageOptions {
  grants?: { list(): Promise<{ user: string; caps: string[]; targets: string[]; scopes?: string[]; expires_at?: number; expired: boolean; granted_by: string; created_at: number; updated_at: number }[]> };
  /** 技能页只读契约；上传、下载与删除由 HTTP 层处理。 */
  skills?: {
    list(): Promise<{ name: string; dir: string; description?: string; files: number; bytes: number; diagnostics: string[]; hidden: boolean; mtime: number }[]>;
    readSkillMd(name: string): Promise<string>;
    files(name: string): Promise<{ path: string; size: number }[]>;
  };
  health(): unknown | Promise<unknown>; queue(): unknown; codex(): Promise<unknown>; pi(): Promise<unknown>;
  resetCodex?: unknown; resetPi?: unknown;
  compactCodex?: unknown; compactPi?: unknown;
  live?: { snapshot(): LiveCardView[] };
  context: { scopes(): string[] };
  contextUsage?: ContextUsageView;
  settings?: { current(): Readonly<RuntimeSettingsView>; defaults: RuntimeSettingsView };
  codexPrompt?: { read(): Promise<CodexPromptSnapshot> };
  codexBasePrompt?: { readonly managed: string; read(model: string): Promise<CodexBasePromptSnapshot | undefined> };
  modelCatalog?: ModelCatalogView;
  store: {
    degraded: boolean;
    throughput(since: number): { total: number; failed: number; error_rate: number; no_send_fallback?: number; inbound?: number; no_send_ratio?: number };
    latestMetrics(): { name: string; labels_json: string; value: number; ts: number }[];
    tickets(filters: Record<string, unknown>): { ticket: string; scope: string; ts: number; status: string; sender: string | null; route: string | null; backend: string | null; duration_ms: number }[];
    events(ticket: string, options: { after?: number; limit: number }): ObsEvent[];
    systemEvents(ticket: string, limit: number): ObsEvent[];
    /** 上下文监控（设计 DESIGN-context-monitor §2–3）：按线程的已判定回合序列。 */
    contextSeries(opts: { limit?: number; since?: number; backend?: string; key?: string; analysis?: ContextAnalysisOptions }): ThreadContextSeries[];
    previousContextTurn(backend: ContextUsage['backend'], key: string, beforeTs: number): ContextUsageEventView | undefined;
    /** 票据页：把本票据的 model_request / context_usage 事件交给数据层判定，返回本票据全部请求（按 seq）。 */
    analyzeTicketTurns(ticket: string, ticketEvents: ObsEvent[]): ContextTurn[];
    /** 上下文监控预览面板（§9.2）：一次取页面上全部票据的摘要；过期清理的票据不在结果里。 */
    ticketBriefs(tickets: readonly string[]): Map<string, TicketBrief>;
  };
}
export interface ContextUsageEventView { ts: number; ticket: string; detail: ContextUsage }
export interface DashboardPageDeps {
  opts: DashboardPageOptions;
  config: { owner?: string; imagesDir: string; CODEX_PROVIDER: "magpie" | "openai"; CODEX_MAGPIE_URL: string; CODEX_MODEL?: string; AGENT_MODEL_PROVIDER: string };
  csrf: string; agentMd: string; agentsMd: string;
  api(pathQuery: string): Promise<{ status: number; body: unknown }>;
  contextResult(scope: string, query: string | null): { content: { type: string; text?: string }[] };
  isThreadKey(value: unknown): value is string;
  summarize(event: { stage: string; status: string | null; detail: Record<string, unknown> }): string;
  imageFile(root: string, segments: string[]): Promise<string>;
  readText(file: string): Promise<string>;
  agentMdRevision(st: { mtimeMs: number; size: number } | null): string;
  reasoningEfforts: readonly string[];
  formatBackendOverrides(overrides: Record<string, string>): string;
  agentMdMaxBytes: number;
  settingsTicket: string;
}

type RuntimeSettings = RuntimeSettingsView;
type LiveCard = LiveCardView;
const queryLink = (q: URLSearchParams) => new URLSearchParams([...q].map(([k,v])=>[redactText(k,100_000),redactText(v,100_000)])).toString();

const SETTING_LABELS: Record<string, string> = { agentBackend: '默认后端', backendOverrides: '按会话覆盖', codexModel: 'Codex 模型', codexReasoningEffort: 'Codex 推理强度',
  piModel: 'Pi 模型', piThinkingLevel: 'Pi 思考档位', alertOwner: 'owner 告警' };
/** pi-ai ModelThinkingLevel 全集：模型不在清单里时的档位选项。 */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const AUTO_HINT = 'auto：派发时按消息难度自动选档，结果见票据页。';
const windowK = (n?: number) => n ? ` · 窗口 ${Math.round(n / 1000)}k` : '';
/** 票据快照 → `后端 · 模型 · 档位（来源 auto）`；旧票据缺字段时只拼已有部分。 */
export function dispatchSettingsLine(snap: Record<string, unknown>): string {
  const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
  const backend = str(snap.backend) ?? '';
  const model = backend === 'pi' ? str(snap.piModel) : str(snap.codexModel);
  const effort = backend === 'pi' ? str(snap.piThinkingLevel) : str(snap.codexReasoningEffort);
  const source = str(snap.effortSource);
  const parts = [BACKENDS[backend] ?? backend, model, effort].filter(Boolean);
  return parts.join(' · ') + (source === 'auto' || source === 'auto-fallback' ? `（来源 ${source}）` : '');
}
const showSetting = (v: unknown) => typeof v === 'boolean' ? (v ? '开启' : '关闭') : v && typeof v === 'object' ? (Object.entries(v).map(([k, b]) => `${k}=${String(b)}`).join(', ') || '无') : String(v);
const asObj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** 聊天记录整理灯的说明：观测事件 ts（毫秒）或消息库 meta aging_last_run（秒）统一格式化。 */
export function agingNote(aging: Record<string, unknown>, now = Date.now()): string {
  const raw = aging.ts ?? aging.last_run;
  if (raw === undefined || raw === null || raw === '') return '尚未运行';
  const ms = epochMs(raw);
  return ms === null ? `上次 ${String(raw)}` : `上次 ${fmtWhen(ms, now)}`;
}
/* 上下文监控（DESIGN-context-monitor §3）：标记文案、命中率与说明文字，页面与票据页共用。 */
const MARKS: Record<NonNullable<ContextTurn['mark']>, string> = { miss: '未命中', partial: '部分命中', first: '首轮', compact: '压缩后', reset: '重建' };
/** 本轮输入中缓存命中的百分数（0–100）。 */
const hitPct = (t: { used: number; cached: number }) => t.used > 0 ? t.cached / t.used * 100 : 0;
/** `时间 · 输入 X · 命中 Y（Z%） · 标记：原因` */
function turnTitle(t: ContextTurn): string {
  const parts = [fmtTime(t.ts), `输入 ${fmtInt(t.used)}`, `命中 ${fmtInt(t.cached)}（${fmtPct(hitPct(t))}）`];
  if (t.mark) parts.push(MARKS[t.mark] + (t.reasons.length ? '：' + t.reasons.join('、') : ''));
  return parts.join(' · ');
}
/** 走势条 title：`票据 X · 第 n/N 次请求 · 时间 · 输入 · 命中 · 原因`；压缩记录没有票据，沿用 turnTitle。 */
const barTitle = (t: ContextTurn) => t.source === 'compact' ? turnTitle(t) : `票据 ${t.ticket.slice(0, 12)} · 第 ${t.seq}/${t.requests} 次请求 · ${turnTitle(t)}`;
/** 把序列切成连续的同票据段；压缩记录各自成段。 */
function ticketRuns(turns: ContextTurn[]): ContextTurn[][] {
  const runs: ContextTurn[][] = [];
  for (const t of turns) {
    const last = runs.at(-1)?.at(-1);
    if (last && t.source === 'turn' && last.source === 'turn' && last.ticket === t.ticket) runs.at(-1)!.push(t); else runs.push([t]);
  }
  return runs;
}
/** miss / partial 用 .changed 样式，title 写原因；其他标记不在票据页提示。 */
const missMark = (t: ContextTurn) => t.mark === 'miss' || t.mark === 'partial'
  ? `<span class="changed cu-m-${t.mark}" title="${esc(t.reasons.join('、'))}">${MARKS[t.mark]}</span>` : '';
const turnHit = (t: ContextTurn, prefix = '') => `<span class="muted cu-hit" title="${esc(turnTitle(t))}">${prefix}命中 ${fmtInt(t.cached)} / ${fmtInt(t.used)}（${fmtPct(hitPct(t))}）</span>${missMark(t)}`;
/** 票据页：单请求沿用一行；多请求在行内给总数，下方逐次列出 `第 n 次：命中 X / Y（Z%）` 与标记。 */
const ticketHits = (turns: ContextTurn[]) => turns.length === 1 ? { inline: turnHit(turns[0]!), list: '' } : {
  inline: `<span class="muted cu-hit">${turns.length} 次请求</span>`,
  list: `<ul class="cu-reqs">${turns.map(t => `<li>${turnHit(t, `第 ${t.seq} 次：`)}</li>`).join('')}</ul>`,
};
const usageHref = (backend: string, key: string) => `/context-usage?backend=${uri(backend)}&amp;key=${uri(key)}`;
/* 上下文监控页（§9.3）：纵轴、时间轴、分隔标签与票据预览面板。 */
const SEP_LABELS = { compact: '压缩', reset: '重建' } as const;
/** 明细表 / 预览请求表的标记列：miss / partial 用 missMark，其他标记灰字。 */
const markCell = (t: ContextTurn) => !t.mark ? '—' : missMark(t) || `<span class="muted">${MARKS[t.mark]}</span>`;
/** 纵轴刻度（占窗口比例）；位置由 .cu-y* 类决定。 */
const Y_AXIS = `<div class="cu-y" aria-hidden="true">${[100, 75, 50, 25, 0].map(n => `<span class="cu-y${n}">${n}%</span>`).join('')}</div>`;
const tz = () => process.env.TZ || undefined;
const dayOf = (ts: number) => new Date(ts).toLocaleDateString('zh-CN', { timeZone: tz() });
const axisTime = (ts: number, withDate: boolean) => new Date(ts).toLocaleString('zh-CN',
  { hour12: false, timeZone: tz(), ...(withDate ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' });
/** 时间轴只标首尾：同一天只写 HH:mm，跨天时两端都带日期。 */
function timeAxis(turns: ContextTurn[]): string {
  const a = turns[0], b = turns.at(-1);
  if (!a || !b) return '';
  const withDate = dayOf(a.ts) !== dayOf(b.ts);
  const label = (ts: number) => `<time datetime="${new Date(ts).toISOString()}" title="${esc(fmtTime(ts))}">${esc(axisTime(ts, withDate))}</time>`;
  return `<div class="cu-x">${label(a.ts)}${b === a ? '' : label(b.ts)}</div>`;
}
/** 按字符（码点）截断，超出加 …。 */
const clip = (text: string, n = 120) => { const chars = [...text]; return chars.length > n ? chars.slice(0, n).join('') + '…' : text; };
/** 一个票据组的预览：摘要头、原文 / 回复前 120 字、逐次请求命中表、票据时间线链接。摘要缺失（票据已过期清理）时只留 id、请求表和链接。 */
function ticketPop(id: string, ticket: string, turns: ContextTurn[], brief: TicketBrief | undefined): string {
  const href = `/tickets/${uri(ticket)}`;
  const link = `<a class="mono" href="${href}">${esc(ticket.slice(0, 12))}</a>`;
  const muted = (text: string) => `<span class="muted">${esc(text)}</span>`;
  const head = brief ? [statusStamp(brief.status), link, `<span>${esc(scopeLabel(brief.scope))}</span>`,
    brief.sender ? muted(brief.sender) : '', muted(`收到 ${fmtTime(brief.ts)}`), muted(`总耗时 ${fmtMs(brief.duration_ms) || '0 毫秒'}`),
    brief.settings ? muted(dispatchSettingsLine(brief.settings)) : '', brief.tools > 0 ? muted(`工具调用 ${brief.tools} 次`) : ''].join('') : link;
  const quote = (title: string, text: string, cls = '') => text ? `<p class="cu-pop-label">${title}</p><blockquote class="said${cls}">${esc(clip(text))}</blockquote>` : '';
  const rows = turns.map(t => `<tr><td class="num">第 ${t.seq} 次</td><td>${esc(fmtTime(t.ts))}</td><td class="num">${fmtInt(t.used)}</td><td class="num">${fmtInt(t.cached)}（${fmtPct(hitPct(t))}）</td><td class="num">${t.output === undefined ? '—' : fmtInt(t.output)}</td><td>${markCell(t)}${t.reasons.length ? ` <small>${esc(t.reasons.join('、'))}</small>` : ''}</td></tr>`).join('');
  return `<div class="cu-pop" id="${id}" hidden role="region" aria-label="${esc(`票据 ${ticket.slice(0, 12)} 的请求明细`)}"><div class="cu-pop-head">${head}<button type="button" class="btn quiet cu-close">关闭</button></div>${
    brief ? quote('原文', brief.text) + quote('回复', brief.reply, ' cu-reply') : ''}<div class="wrap"><table class="list"><thead><tr><th class="num">请求</th><th>时间</th><th class="num">输入</th><th class="num">命中</th><th class="num">输出</th><th>标记 / 原因</th></tr></thead><tbody>${rows}</tbody></table></div><p class="cu-pop-foot"><a href="${href}">票据时间线 →</a></p></div>`;
}

const ticketStatus = (events: ObsEvent[]) => {
  const t = events.filter(e => ['reply_sent','failed','fallback'].includes(e.stage) && JSON.parse(e.detail_json).terminal === true).at(-1);
  if (!t) return 'processing';
  if (t.stage === 'failed') return JSON.parse(t.detail_json).failure === 'timeout' ? 'timeout' : 'failed';
  return t.stage === 'fallback' ? 'fallback' : 'sent';
};


export function createDashboardPages(deps: DashboardPageDeps) {
  const { opts, config, csrf, agentMd, agentsMd, api, contextResult, isThreadKey, summarize,
    imageFile, readText, agentMdRevision, formatBackendOverrides,
    reasoningEfforts: REASONING_EFFORTS, agentMdMaxBytes: AGENT_MD_MAX_BYTES, settingsTicket: SETTINGS_TICKET } = deps;
  function usageList(): ContextUsage[] {
    try { return opts.contextUsage ? sortUsage(opts.contextUsage.all()) : []; } catch { return []; }
  }
  function usageOf(backend: ContextUsage['backend'], key: string): ContextUsage | null {
    try { return opts.contextUsage?.get(backend, key) ?? null; } catch { return null; }
  }

  async function render(url: URL, nonce: string, flash?: Flash): Promise<string | null> {
    const q = url.searchParams, p = url.pathname;
    const shell = (title: string, body: string, extra: { lead?: string; actions?: string; scripts?: string[]; head?: string } = {}) => page({ title, path: p, nonce, body, flash, ...extra });
    if (p === '/') return shell('运行总览', await overview(), { lead: '现在在处理什么、各依赖是否正常、最近的吞吐与失败。', scripts: ['/assets/usage.js'] });
    if (p === '/live') return shell('进行中的会话', liveBody(), { lead: '正在处理与排队中的消息，按会话分组；事件由服务器实时推送。完成后收进下方列表。', scripts: ['/assets/live.js'],
      actions: '<span id="conn" class="conn">正在连接…</span>' });
    if (p === '/tickets') return shell('票据列表', tickets(q), { lead: '每条消息一张票据。点开查看从收到到回复的完整流转。' });
    if (p.startsWith('/tickets/')) {
      let ticket: string; try { ticket = decodeURIComponent(p.slice(9)); } catch { return null; }
      const body = await ticketDetail(ticket, q); if (body === null) return null;
      return shell('票据全链路', body);
    }
    if (p === '/logs') {
      return shell('实时日志', `<form class="bar"><label>票据<input name="ticket" placeholder="票据前缀" value="${esc(q.get('ticket'))}"></label><label>级别<select name="level"><option value="">全部级别</option>${['debug','info','warn','error'].map(l=>`<option ${q.get('level')===l?'selected':''}>${l}</option>`).join('')}</select></label><button>过滤</button></form><div id="tail" class="log" role="log" aria-live="polite"></div>`,
        { lead: '最近 1000 行结构化日志，随后实时追加。可按票据或级别过滤。', scripts: ['/assets/logs.js'], actions: '<span id="conn" class="conn">正在连接…</span>' });
    }
    if (p === '/context') return shell('上下文检索', contextBody(q), { lead: '与 Codex / pi 的 qq_context 工具看到的内容一致。留空关键词查看最近记录。时间线、摘要与检索对照见<a href="/memory">记忆</a>。' });
    if (p === '/context-usage') return shell('上下文监控', contextUsageBody(q), { lead: '每条线程最近若干次模型请求的输入占用（一根竖条一次请求，同一票据的请求相邻成组；高度 = 占窗口比例），其中缓存命中与未命中分两色；异常的缓存未命中标红并给出原因推断。点一个票据组查看该票据每次请求的命中；刷新页面更新。', scripts: ['/assets/context-usage.js'] });
    if (p === '/agents') return shell('Agent', await agentsPage(), { lead: '两个执行后端的会话、索引进度与每条线程的上下文占用。点进会话查看每个回合的输入、模型请求、工具调用与回复。', scripts: ['/assets/forms.js', '/assets/usage.js'] });
    if (p.startsWith('/agents/')) return agentsRoute(p, q, nonce, shell);
    if (p === '/memory' || p.startsWith('/memory/')) return memoryPage(p, q, nonce, shell);
    if (p === '/settings') return shell('设置', await settingsBody(), { lead: '修改立即对之后收到的消息生效，无需重启；.env 中的值只是初始默认。', scripts: ['/assets/forms.js'] });
    if (p === '/skills') return shell('技能', await skillsBody(), { lead: 'pi 与 codex 共用的技能目录；上传、删除后下一条消息即生效。' });
    if (p.startsWith('/skills/')) {
      let name: string; try { name = decodeURIComponent(p.slice(8)); } catch { return null; }
      const body = await skillDetail(name); if (body === null) return null;
      return shell(name, body, { lead: 'SKILL.md 原文与目录下的文件。' });
    }
    if (p === '/config') return shell('生效配置', await configBody(), { lead: '启动时从环境变量解析的配置（已脱敏）。运行中可改的项见<a href="/settings">设置</a>。' });
    if (p === '/codex/agents-md') {
      const st = await fs.stat(agentsMd).catch(() => null);
      return shell('全局 AGENTS.md', `<section class="flush"><h2>${esc(agentsMd)} <small>${st ? `修改于 ${esc(fmtTime(st.mtime.getTime()))}` : '文件不存在'}</small></h2>${json(await readText(agentsMd))}<p class="hint">受管规则 + codex.md，保存 codex.md 后重写。在<a href="/settings#codex-prompt">设置页</a>编辑自定义段。</p></section>`,
        { lead: 'codex 每次调用读取的全局规则（只读，已脱敏）。' });
    }
    return null;
  }

  /* ───────── 页面 ───────── */

  async function overview(): Promise<string> {
    const health = asObj(await opts.health());
    const queue = asObj(opts.queue());
    let out = opts.store.degraded ? '<div class="flash err">观测存储已降级（degraded: true）：业务照常运行，但事件与指标暂不落库。</div>' : '';
    // 一行迷你条（悬停看完整数字）；完整条在 Agent 页，走势在上下文监控页。
    const usage = usageList();
    out += `<section><h2>上下文占用 <small>${usage.length ? `${usage.length} 条线程 · ` : ''}<a href="/context-usage">上下文监控 →</a></small></h2>${usage.length
      ? `<div class="sheet pad"><div class="ctx-list ctx-list-mini">${usage.map(u => `<div class="ctx-item"><span class="ctx-item-label">${esc(ctxLabel(u.backend, u.key))}</span>${contextBar(u.backend, u.key, u, { mini: true })}</div>`).join('')}</div></div>`
      : empty(opts.contextUsage ? '还没有线程的占用记录。任一线程完成一个回合后，这里会显示它离上下文窗口还有多远。' : '上下文占用数据源未接入。')}</section>`;

    const bridge = asObj(health.bridge), comfy = asObj(health.comfy), codex = asObj(health.codex), aging = asObj(health.aging);
    const lamp = (name: string, tone: 'ok' | 'fail' | 'warn' | '', note: string) => `<div class="lamp"><b><i class="dot ${tone}" aria-hidden="true"></i>${esc(name)}</b><small>${esc(note)}</small></div>`;
    const lamps = [
      lamp('QQ 连接', bridge.ws_connected === true ? 'ok' : bridge.ws_connected === false ? 'fail' : '', bridge.ws_connected === true ? `在线，累计断线 ${Number(bridge.disconnect_count ?? 0)} 次` : bridge.ws_connected === false ? '离线' : '未知'),
      lamp('ComfyUI', comfy.ok === true ? 'ok' : comfy.ok === false ? 'fail' : 'warn', comfy.ok === true ? String(comfy.comfyui_version ?? comfy.backend ?? '可用') : comfy.ok === false ? '自检失败' : '自检中'),
      lamp('Codex 凭据', codex.ok === true ? 'ok' : codex.ok === false ? 'fail' : 'warn', codex.ok === true ? 'auth.json 就绪' : codex.ok === false ? '缺少或无法读取凭据' : '检查中'),
      lamp('DeepSeek 密钥', health.deepseek_key_present === true ? 'ok' : health.deepseek_key_present === false ? 'fail' : '', health.deepseek_key_present === true ? '已配置' : health.deepseek_key_present === false ? '未配置' : '未知'),
      lamp('聊天记录整理', aging.status === 'ok' ? 'ok' : aging.status === 'failed' ? 'fail' : '', agingNote(aging)),
      lamp('观测存储', opts.store.degraded || health.degraded === true ? 'fail' : 'ok', opts.store.degraded ? '已降级' : `丢弃事件 ${Number(health.dropped_events ?? 0)} 条`),
    ];
    out += `<section><h2>依赖状态</h2><div class="lamps">${lamps.join('')}</div></section>`;

    const tp = (h: number) => opts.store.throughput(Date.now() - h * 3600_000);
    const t1 = tp(1), t24 = tp(24);
    out += `<div class="muted">近 24 小时未调用发送工具而兜底：${t24.no_send_fallback ?? 0} / ${t24.inbound ?? 0} 个入站回合（${((t24.no_send_ratio ?? 0) * 100).toFixed(1)}%）</div>`;
    const fig = (label: string, t: { total: number; failed: number; error_rate: number }) => `<div class="sheet pad"><div class="muted">${label}</div><div class="figure">${t.total}<small class="muted"> 条完成</small></div><div class="${t.failed ? 's-fail' : 'muted'}">失败或兜底 ${t.failed} 条（${(t.error_rate * 100).toFixed(t.error_rate && t.error_rate < .1 ? 1 : 0)}%）</div></div>`;
    const scopes = Object.entries(asObj(queue.scopes)).filter(([, n]) => Number(n) > 0);
    out += `<section><h2>吞吐与队列</h2><div class="grid cols-3">${fig('近 1 小时', t1)}${fig('近 24 小时', t24)}<div class="sheet pad"><div class="muted">并发槽位</div><div class="figure">${Number(queue.active ?? 0)} / ${Number(queue.slots ?? 0)}</div><div class="muted">${scopes.length ? scopes.map(([s, n]) => `${esc(scopeLabel(s))} 排队 ${Number(n)} 条`).join('，') : `排队 ${Math.max(0, Number(queue.waiting ?? 0))} 条`}</div></div></div>`;
    // 在途消息与实时页同一数据源，这里只给计数。
    const live = opts.live?.snapshot().filter(c => c.finished === null);
    const queued = live?.filter(c => c.state === 'queued').length ?? 0;
    out += `<p class="hint mt">${live ? `处理中 ${live.length - queued} · 排队 ${queued} · ` : ''}<a href="/live">实时页查看进行中的会话</a></p></section>`;

    const rows = opts.store.degraded ? [] : opts.store.latestMetrics();
    out += `<section><details><summary>最近一分钟指标（${rows.length} 项，p50 / p95 等）</summary><div class="sheet mt"><div class="wrap"><table class="list"><thead><tr><th>指标</th><th>标签</th><th class="num">值</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="mono">${esc(Object.entries(asObj(JSON.parse(r.labels_json))).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${String(v)}`).join(' '))}</td><td class="num">${esc(Number.isInteger(r.value) ? r.value : r.value.toFixed(3))}</td></tr>`).join('')}</tbody></table></div></div></details></section>`;

    if (opts.settings) {
      const s = opts.settings.current();
      const line = [`默认后端 ${esc(BACKENDS[s.agentBackend] ?? s.agentBackend)}`, `覆盖 ${Object.keys(s.backendOverrides).length} 条`,
        `Codex ${esc(s.codexModel)} / ${esc(s.codexReasoningEffort)}`, `Pi ${esc(s.piModel)} / ${esc(s.piThinkingLevel)}`,
        `owner 告警 ${s.alertOwner ? '开' : '关'}`].join(' · ');
      out += `<section><h2>当前设置</h2><div class="sheet pad settings-line"><span>${line}</span><a href="/settings">修改</a></div></section>`;
    }
    return out;
  }

  function slipHtml(c: LiveCard): string {
    const items = c.items.slice(-30).map(it => `<li class="${it.status === 'failed' ? 'failed' : it.status === 'started' ? 'started' : ''}"><span class="faint">${esc(fmtOffset(Math.max(0, it.ts - c.started)))}</span><span class="sum"><b>${esc(stageLabel(it.stage))}${it.status === 'started' ? ' 开始' : it.status === 'failed' ? ' 失败' : ''}</b>  ${esc([fmtMs(it.duration_ms), it.summary].filter(Boolean).join('  '))}</span></li>`).join('');
    return `<article class="slip${c.state === 'queued' ? ' queued' : ''}" data-ticket="${esc(c.ticket)}"><div class="slip-body"><div class="slip-top">${statusStamp(c.state)}<span class="who">${esc(c.sender || '—')}</span>${c.route ? `<span class="pill">${esc(ROUTES[c.route] ?? c.route)}</span>` : ''}${c.backend ? `<span class="pill">${esc(BACKENDS[c.backend] ?? c.backend)}</span>` : ''}<span class="elapsed">已耗时 ${esc(fmtMs(Date.now() - c.started))}</span>${c.backend && c.thread ? contextBar(c.backend, c.thread, usageOf(c.backend as ContextUsage['backend'], c.thread), { mini: true }) : ''}</div>
<p class="text">${esc(c.text || '（无原文）')}</p><div class="phase">${c.phase ? `<span class="pulse" aria-hidden="true"></span><span>当前：${esc(stageLabel(c.phase))}</span>` : `<span class="faint">${c.state === 'queued' ? '排队等待同一会话的前一条消息' : '阶段之间'}</span>`}</div><ol class="feed">${items}</ol><div class="hint"><a href="/tickets/${uri(c.ticket)}">查看时间线</a></div></div></article>`;
  }

  function liveBody(): string {
    if (!opts.live) return empty('实时总线未启用。');
    const cards = opts.live.snapshot();
    const active = cards.filter(c => c.finished === null), done = cards.filter(c => c.finished !== null);
    const groups = new Map<string, LiveCard[]>();
    for (const c of active) groups.set(c.scope, [...(groups.get(c.scope) ?? []), c]);
    const outcome = (c: LiveCard) => c.outcome === 'reply_sent' ? 'sent' : c.outcome === 'fallback' ? 'fallback' : 'failed';
    return `<section class="flush"><h2 id="live-count">${active.length ? `${active.length} 条进行中` : '没有进行中的消息'}</h2>
<div id="inflight">${[...groups].map(([scope, list]) => `<div class="scope-group" data-scope="${esc(scope)}"><h3><span>${esc(scopeLabel(scope))}</span><span class="pill">${list.length} 条</span></h3><div class="slips">${list.map(slipHtml).join('')}</div></div>`).join('')}</div>
<div id="inflight-empty"${active.length ? ' hidden' : ''}>${empty('眼下没有在处理的消息。新消息到达后，这里会立即出现一张单据，并实时显示它走到哪一步。')}</div></section>
<section><h2>刚刚完成 <small>最近 30 条，保留半小时</small></h2><div id="done" class="done-list">${done.map(c => `<details data-ticket="${esc(c.ticket)}"><summary>${statusStamp(outcome(c))}<span class="excerpt">${esc(c.text || '（无原文）')}</span><span class="faint">${esc(scopeLabel(c.scope))}  ${esc(fmtMs((c.finished ?? c.updated) - c.started))}</span><a href="/tickets/${uri(c.ticket)}">时间线</a></summary></details>`).join('')}</div>
<div id="done-empty"${done.length ? ' hidden' : ''}>${empty('还没有完成的消息。')}</div></section>`;
  }

  function tickets(q: URLSearchParams): string {
    const filters = Object.fromEntries(['status','scope','route','backend'].map(k=>[k,q.get(k) ?? ''])) as Record<string, string>;
    const n = Math.max(0,Math.min(100000,Number(q.get('page'))||0));
    const opt = (name: string, choices: [string, string][]) => `<select name="${name}"><option value="">全部</option>${choices.map(([v, l]) => `<option value="${esc(v)}"${filters[name] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    let body = `<form class="bar"><label>状态${opt('status', [['processing','处理中'],['sent','已回复'],['failed','失败'],['timeout','超时'],['fallback','兜底']])}</label>
<label>会话域<input name="scope" placeholder="group:123 或 private:456" value="${esc(filters.scope)}"></label><label>路由${opt('route', Object.entries(ROUTES))}</label><label>后端${opt('backend', Object.entries(BACKENDS))}</label><button>筛选</button>${Object.values(filters).some(Boolean) ? '<a class="btn quiet" href="/tickets">清除</a>' : ''}</form>`;
    const rows = opts.store.tickets({ ...filters, page: n });
    body += rows.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>状态</th><th>收到</th><th>会话 / 发送者</th><th class="hide-sm">路由 / 后端</th><th class="num">耗时</th><th class="hide-sm">票据</th></tr></thead><tbody>${rows.map(r => `<tr><td>${statusStamp(r.status)}</td><td>${time(r.ts)}</td><td>${esc(scopeLabel(r.scope))}<br><small>${esc(r.sender ?? '')}</small></td><td class="hide-sm">${esc(ROUTES[r.route ?? ''] ?? r.route ?? '—')}<br><small>${esc(BACKENDS[r.backend ?? ''] ?? r.backend ?? '')}</small></td><td class="num">${esc(fmtMs(r.duration_ms))}</td><td class="hide-sm"><a class="mono" href="/tickets/${uri(r.ticket)}">${esc(r.ticket.slice(0, 12))}</a></td></tr>`).join('')}</tbody></table></div></div>`
      : empty(n ? '这一页没有更多票据了。' : '没有符合条件的票据。换个筛选条件，或清除筛选查看全部。');
    const link = (page: number) => { q.set('page', String(page)); return `/tickets?${esc(queryLink(q))}`; };
    body += `<p class="hint mt">${n ? `<a href="${link(n - 1)}">上一页</a>　` : ''}第 ${n + 1} 页${rows.length === 50 ? `　<a href="${link(n + 1)}">下一页</a>` : ''}</p>`;
    return body;
  }

  async function ticketDetail(ticket: string, q: URLSearchParams): Promise<string | null> {
    const after = Math.max(0,Number(q.get('after'))||0), limit = Math.max(1,Math.min(200,Number(q.get('limit'))||100));
    const events = opts.store.events(ticket,{after,limit});
    if (!events.length) return null;
    const all = opts.store.events(ticket, { limit: 2000 });
    const detail = (e: ObsEvent) => asObj(JSON.parse(e.detail_json));
    const received = all.find(e => e.stage === 'received' || (e.stage === 'recovered' && detail(e).text !== undefined));
    const route = all.map(e => detail(e).route).find(v => typeof v === 'string') as string | undefined;
    const backend = all.find(e => e.stage.startsWith('backend:'))?.stage.slice(8) ?? (all.map(e => detail(e).backend).find(v => typeof v === 'string') as string | undefined);
    const status = ticketStatus(all);
    const t0 = all[0]!.ts, t1 = all.at(-1)!.ts;
    // 派发设置快照记在 admitted 事件；旧票据没有时不显示这一行。
    const snap = all.filter(e => e.stage === 'admitted').map(e => asObj(detail(e).settings)).find(v => typeof v.backend === 'string');
    let body = `<div class="sheet pad"><div class="slip-top">${statusStamp(status, true)}<span class="mono faint">${esc(ticket)}</span></div><div class="mt">${kv([
      ['会话', esc(scopeLabel(all.find(e => e.scope)?.scope ?? ''))], ['发送者', esc(received ? detail(received).sender ?? '—' : '—')],
      ['路由', esc(ROUTES[route ?? ''] ?? route ?? '—')], ['后端', esc(BACKENDS[backend ?? ''] ?? backend ?? '—')],
      ...(snap ? [['派发设置', esc(dispatchSettingsLine(snap))] as [string, string]] : []),
      ['收到', esc(fmtTime(t0))], ['总耗时', esc(fmtMs(t1 - t0))]], 'meta')}</div></div>`;
    if (received) body += `<section><h2>原文</h2><blockquote class="said">${esc(detail(received).text ?? '')}</blockquote><p class="hint">正文、提示词和回复只保存脱敏后的前 500 字。历史由工具按需获取，没有自动注入近期上下文。</p></section>`;
    // 缓存命中（DESIGN-context-monitor §3、§8.4）：判定由数据层完成，按请求列在最后一个完成的模型回合行；
    // 没有模型回合时标在最后一条请求 / 占用事件行。
    const ctxTurns = opts.store.analyzeTicketTurns(ticket, all);
    const hits = ctxTurns.length ? ticketHits(ctxTurns) : undefined;
    const hitRowId = hits ? (all.filter(e => e.stage === 'model_turn' && e.status !== 'started').at(-1)
      ?? all.filter(e => e.stage === 'model_request' || (e.stage === 'context_usage' && toContextUsage(detail(e))?.source === 'turn')).at(-1))?.id : undefined;
    body += `<section><h2>流转轨迹 <small>${events.length} 个事件${after ? '（续）' : ''}</small></h2><ol class="trail">${events.map(e => {
      const d = detail(e), terminal = ['reply_sent','failed','fallback'].includes(e.stage) && d.terminal === true;
      const sum = summarize({ stage: e.stage, status: e.status, detail: d });
      return `<li class="${e.status === 'started' ? 'started' : e.status === 'failed' ? 'failed' : 'ok'}${terminal ? ' terminal' : ''}"><div class="row"><span class="t">+${esc(fmtMs(e.ts - t0) || '0 毫秒')}</span><span class="stage">${esc(stageLabel(e.stage))}${e.status === 'started' ? ' 开始' : ''}</span>${hits && e.id === hitRowId ? hits.inline : ''}${e.status === 'failed' ? stamp('失败', 'fail') : ''}${e.duration_ms !== null ? `<span class="muted">${esc(fmtMs(e.duration_ms))}</span>` : ''}<code class="faint">${esc(e.stage)}</code></div>${hits && e.id === hitRowId ? hits.list : ''}${sum ? `<div class="sum">${esc(sum)}</div>` : ''}<details><summary>详情</summary>${json(d)}</details></li>`;
    }).join('')}</ol>`;
    if (events.length === limit) body += `<p><a href="/tickets/${uri(ticket)}?after=${events.at(-1)!.id}&amp;limit=${limit}">下一页事件</a></p>`;
    body += '</section>';
    if (/^[A-Za-z0-9_-]{1,128}$/.test(ticket)) {
      const root = path.join(config.imagesDir,ticket);
      const names = await fs.readdir(root,{recursive:true}).catch(()=>[] as string[]);
      const thumbs: string[] = [];
      for (const name of names.slice(0,200)) {
        try { const parts = [ticket,...name.split(path.sep)]; await imageFile(config.imagesDir,parts);
          const src = '/images/'+parts.map(uri).join('/'); thumbs.push(`<a href="${src}"><img loading="lazy" src="${src}" alt="生成图 ${esc(name)}"></a>`);
        } catch { /* 只展示允许的位图 */ }
      }
      if (thumbs.length) body += `<section><h2>生成图片 <small>${thumbs.length} 张</small></h2><div class="thumbs">${thumbs.join('')}</div></section>`;
    }
    return body;
  }

  function contextBody(q: URLSearchParams): string {
    const scope = q.get('scope') ?? '';
    const scopes = opts.context.scopes();
    let body = `<form class="bar"><label>会话域<select name="scope"><option value="">全部（owner 视角）</option>${scopes.map(s=>`<option value="${esc(s)}" ${s===scope?'selected':''}>${esc(scopeLabel(s))}</option>`).join('')}</select></label><label>关键词<input name="query" placeholder="留空查看最近记录" value="${esc(q.get('query'))}"></label><button>检索</button></form>`;
    const query = q.get('query');
    const result = contextResult(scope, query);
    body += `<p class="muted">${query ? 'qq_search 结果' : 'qq_recent 最近 30 条'}（${esc(scope ? scopeLabel(scope) : '全部会话')}）　${scope ? `<a href="/memory/scopes/${uri(scope)}">在记忆时间线中查看</a>` : '<a href="/memory">记忆总览</a>'}</p>` + json(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
    return body;
  }

  /** /context-usage：汇总表 + 每线程走势条与明细（设计 §3）；判定由数据层完成，这里只渲染。 */
  function contextUsageBody(q: URLSearchParams): string {
    const num = (k: string) => { const v = (q.get(k) ?? '').trim(); const n = v ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
    const rawLimit = num('limit');
    const limit = rawLimit === undefined ? 40 : Math.max(1, Math.min(200, Math.floor(rawLimit)));
    const backend = isBackend(q.get('backend') ?? '') ? q.get('backend')! : '';
    const key = (q.get('key') ?? '').trim();
    const unit = (k: string) => { const n = num(k); return n !== undefined && n >= 0 && n <= 1 ? n : undefined; };
    const missRatio = unit('miss'), partialRatio = unit('partial');
    const analysis: ContextAnalysisOptions = { ...(missRatio !== undefined ? { missRatio } : {}), ...(partialRatio !== undefined ? { partialRatio } : {}) };
    const filtered = !!(backend || key || rawLimit !== undefined || Object.keys(analysis).length);
    const series = opts.store.contextSeries({ limit, ...(backend ? { backend } : {}), ...(key ? { key } : {}), ...(Object.keys(analysis).length ? { analysis } : {}) });

    const field = (name: string, label: string, value: string, attrs: string) => `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
    let body = `<form class="bar"><label>后端<select name="backend"><option value="">全部</option>${Object.entries(BACKENDS).map(([v, l]) => `<option value="${v}"${backend === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>${
      field('key', '线程键', key, 'placeholder="owner 或 group:123"')}${field('limit', '每线程请求', String(limit), 'type="number" min="1" max="200"')}${
      field('miss', '未命中阈值', missRatio === undefined ? '' : String(missRatio), 'type="number" min="0" max="1" step="0.05" placeholder="0.5"')}${
      field('partial', '部分命中阈值', partialRatio === undefined ? '' : String(partialRatio), 'type="number" min="0" max="1" step="0.05" placeholder="0.9"')}<button>筛选</button>${filtered ? '<a class="btn quiet" href="/context-usage">清除</a>' : ''}</form>`;
    if (opts.store.degraded) body += '<div class="flash err">观测存储已降级：读不到上下文占用历史。</div>';
    if (!series.length) return body + empty(filtered ? '没有符合条件的线程。换个筛选条件，或<a href="/context-usage">清除筛选</a>查看全部。' : '还没有上下文占用记录。任一线程完成一个回合后，这里会出现它的走势。');

    const since = Date.now() - 86400_000;
    const summary = series.map((s, i) => {
      const recent = s.turns.filter(t => t.source === 'turn' && t.ts >= since);
      const used = recent.reduce((n, t) => n + t.used, 0), cached = recent.reduce((n, t) => n + t.cached, 0);
      const misses = recent.filter(t => t.mark === 'miss').length;
      const tickets = new Set(recent.map(t => t.ticket)).size;
      const u = usageOf(s.backend, s.key), win = u ? usageWindow(u) : 0;
      const occ = u && win > 0 ? `${fmtPct(ratio(u.usedTokens, win))} · ${fmtInt(u.usedTokens)} / ${fmtInt(win)}` : '—';
      return `<tr><td><a href="#cu-${i}">${esc(ctxLabel(s.backend, s.key))}</a></td><td class="num">${occ}</td><td class="num">${tickets}</td><td class="num">${recent.length}</td><td class="num">${misses ? `<span class="s-fail">${misses}</span>` : '0'}</td><td class="num">${used ? fmtPct(cached / used * 100) : '—'}</td></tr>`;
    }).join('');
    body += `<section><h2>线程汇总 <small>${series.length} 条线程；回合数（票据）、请求数、未命中与平均命中率（按 token 加权）统计最近 24 小时，以本页每线程最多 ${limit} 次请求为限</small></h2><div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>线程</th><th class="num">当前占用（占比 · 已用 / 窗口）</th><th class="num">24 h 回合数</th><th class="num">请求数</th><th class="num">未命中</th><th class="num">平均命中率</th></tr></thead><tbody>${summary}</tbody></table></div></div></section>`;

    const legend = '<span class="cu-legend" aria-hidden="true"><span><i class="cu-key k-c"></i>缓存命中</span><span><i class="cu-key k-u"></i>未命中部分</span><span><i class="cu-key k-miss"></i>未命中</span><span><i class="cu-key k-partial"></i>部分命中</span><span><i class="cu-key k-sep"></i>压缩 / 重建</span><span><i class="cu-key k-g"></i>一个票据（点击看明细）</span></span>';
    // 预览面板的票据摘要一次取齐（数据层上限 300 个）；每线程最新的票据排在前面，超出上限时先舍弃旧票据。
    const briefs = opts.store.ticketBriefs([...new Set(series.flatMap(s => s.turns.filter(t => t.source === 'turn').map(t => t.ticket).reverse()))]);
    body += series.map((s, i) => {
      const label = ctxLabel(s.backend, s.key);
      const runs = ticketRuns(s.turns);
      const byTicket = new Map<string, ContextTurn[]>();
      for (const t of s.turns) if (t.source === 'turn') { const list = byTicket.get(t.ticket) ?? []; if (!list.length) byTicket.set(t.ticket, list); list.push(t); }
      const bar = (t: ContextTurn, prev: ContextTurn | undefined) => {
        // 压缩记录与其后的请求都标 compact；分隔符只画一次，顶部小字由 CSS 取 data-label。
        const sep = (t.mark === 'compact' || t.mark === 'reset') && prev?.source !== 'compact'
          ? `<i class="cu-sep" data-label="${SEP_LABELS[t.mark]}" title="${esc(MARKS[t.mark])}" aria-hidden="true"></i>` : '';
        return { sep, html: `<span class="cu-bar${t.mark ? ` cu-${t.mark}` : ''}" data-h="${clampPct(Math.min(t.pct, 1) * 100)}" title="${esc(barTitle(t))}"><i class="cu-c" data-c="${clampPct(hitPct(t))}"></i></span>` };
      };
      // 同票据的连续请求装进一个 .cu-group 按钮，对应下方面板里同序号的 .cu-pop；压缩记录不进分组。分隔符只会出现在段首。
      const pops: string[] = [];
      const bars = runs.map(run => {
        const first = run[0]!, head = bar(first, s.turns[s.turns.indexOf(first) - 1]);
        if (first.source !== 'turn') return head.sep + head.html;
        const id = `cu-pop-${i}-${pops.length}`, all = byTicket.get(first.ticket) ?? run;
        const worst = run.some(t => t.mark === 'miss') ? 'miss' : run.some(t => t.mark === 'partial') ? 'partial' : undefined;
        pops.push(ticketPop(id, first.ticket, all, briefs.get(first.ticket)));
        const title = `票据 ${first.ticket.slice(0, 12)} · ${all.length} 次请求 · ${fmtTime(first.ts)}${worst ? ` · 含${MARKS[worst]}` : ''} · 点击查看命中明细`;
        return `${head.sep}<button type="button" class="cu-group" aria-controls="${id}" aria-expanded="false"${worst ? ` data-worst="${worst}"` : ''} title="${esc(title)}">${head.html}${run.slice(1).map((t, k) => bar(t, run[k]).html).join('')}</button>`;
      }).join('');
      // 票据段按最新在上排列，段内按请求顺序；同票据只在首行放链接，后续行写 └ 第 n 次。
      const ticketCell = (t: ContextTurn, k: number) => k > 0 ? `<span class="muted">└ 第 ${t.seq} 次</span>`
        : `<a class="mono" href="/tickets/${uri(t.ticket)}">${esc(t.ticket.slice(0, 12))}</a>`;
      const rows = [...runs].reverse().flatMap(run => run.map((t, k) => `<tr><td>${esc(fmtTime(t.ts))}</td><td>${ticketCell(t, k)}</td><td class="num">${t.source === 'turn' ? `${t.seq}/${t.requests}` : '—'}</td><td class="num">${fmtInt(t.used)}</td><td class="num">${fmtInt(t.cached)}</td><td class="num">${fmtInt(t.uncached)}</td><td class="num">${fmtPct(t.pct * 100)}</td><td>${markCell(t)}</td><td>${t.reasons.length ? esc(t.reasons.join('、')) : '—'}</td><td class="num">${t.gapMs === undefined ? '—' : esc(fmtMs(t.gapMs) || '0 毫秒')}</td></tr>`)).join('');
      const count = `最近 ${s.requests} 次请求（${s.tickets} 个票据）`;
      const chart = `<div class="cu-plot">${Y_AXIS}<div class="cu-scroll"><div class="cu-track"><div class="cu-chart" role="group" aria-label="${esc(`${label} ${count}的上下文占用走势，未命中 ${s.misses} 次；每个按钮是一个票据`)}">${bars}</div>${timeAxis(s.turns)}</div></div></div>`;
      return `<section id="cu-${i}" class="cu-sec"><h2>${esc(label)} <small>${count} · 未命中 ${s.misses} 次 · 窗口 ${fmtInt(s.window)} tokens${backend && key ? '' : ` · <a href="${usageHref(s.backend, s.key)}">只看此线程</a>`}</small>${legend}</h2><div class="sheet pad">${chart}<div class="cu-pane" id="cu-pane-${i}">${pops.join('')}</div>
<details class="mt"><summary>明细（${s.turns.length} 条，最新票据在上）</summary><div class="wrap"><table class="list"><thead><tr><th>时间</th><th>票据</th><th class="num">请求</th><th class="num">输入</th><th class="num">缓存命中</th><th class="num">未命中</th><th class="num">占窗口</th><th>标记</th><th>原因</th><th class="num">与上一请求间隔</th></tr></thead><tbody>${rows}</tbody></table></div></details></div></section>`;
    }).join('');
    return body;
  }

  /* ───────── Agent → 会话 → 回合（观测 v2，数据取自 /api/agents/* 的同一路由） ───────── */

  const apiError = (r: { status: number; body: unknown }) => typeof asObj(r.body).error === 'string' ? String(asObj(r.body).error) : `HTTP ${r.status}`;
  const sessionApi = (backend: string, id: string) => `/api/agents/${encodeURIComponent(backend)}/sessions/${encodeURIComponent(id)}`;
  /** 正文页每页字节数，与 agents.js"加载全文"的分段一致。 */
  const CONTENT_PAGE = 256 * 1024;

  async function agentsPage(): Promise<string> {
    const sum = await api('/api/agents');
    const summaries = sum.status === 200 && Array.isArray(sum.body) ? sum.body as AgentSummary[] : [];
    const error = sum.status === 200 ? undefined : `会话索引暂不可用：${apiError(sum)}`;
    const codexStatus = await opts.codex().catch(() => null);
    const threads: Record<string, unknown>[] = Array.isArray(codexStatus) ? codexStatus.map(asObj) : Object.entries(asObj(codexStatus)).map(([thread_key, thread_id]) => ({ thread_key, thread_id }));
    const codexTargets: ResetTarget[] = threads.map(t => String(t.thread_key)).filter(isThreadKey).sort((a, b) => Number(b === "owner") - Number(a === "owner") || a.localeCompare(b)).map(key => ({ key, label: key === 'owner' ? 'owner 线程' : scopeLabel(key),
      compactEnabled: !!opts.compactCodex && !!threads.find(t => String(t.thread_key) === key)?.thread_id,
      enabled: !!opts.resetCodex && !!threads.find(t => String(t.thread_key) === key)?.thread_id }));
    const piStatus = asObj(await opts.pi().catch(() => ({})));
    const piKeys = [...new Set([...Object.keys(asObj(piStatus.threads)), ...(Array.isArray(piStatus.keys) ? piStatus.keys.map(String) : [])])].sort();
    // 有占用记录的按占比降序，没有记录的会话排在后面显示占位条（与旧 /pi 页一致）。
    const piUsage = sortUsage(usageList().filter(u => u.backend === 'pi')).map(u => u.key);
    const cards: Record<'codex' | 'pi', AgentCardInput> = {
      codex: { summary: summaries.find(x => x.backend === 'codex'), error, threads: codexTargets, usage: k => usageOf('codex', k) },
      pi: { summary: summaries.find(x => x.backend === 'pi'), error, usage: k => usageOf('pi', k),
        threads: [...piUsage.filter(k => piKeys.includes(k)), ...piKeys.filter(k => !piUsage.includes(k))].map(key => ({ key, label: ` ${scopeLabel(key)} 的会话`, enabled: !!opts.resetPi, compactEnabled: !!opts.compactPi })),
        extraUsageKeys: piUsage.filter(k => !piKeys.includes(k)) },
    };
    return agentsBody(cards, csrf);
  }

  type Shell = (title: string, body: string, extra?: { lead?: string; actions?: string; scripts?: string[]; head?: string }) => string;

  /** /memory/*（设计 §1、§5）：数据取自 /api/memory/* 的同一路由；未知 scope / 摘要 / 子路由返回 null（404）。 */
  async function memoryPage(p: string, q: URLSearchParams, nonce: string, shell: Shell): Promise<string | null> {
    const now = Date.now();
    const overview = async () => { const r = await api('/api/memory'); return r.status === 200 ? r.body as MemoryOverview : null; };
    if (p === '/memory') {
      const [r, rc] = await Promise.all([api('/api/memory'), api(`/api/memory/recalls?since=${now - 86400_000}`).catch(() => null)]);
      // 一次请求只取一页（50 条），超过时显示 50+；读取失败只让卡片退化为纯链接说明。
      const recalls: RecallCount | null = rc && rc.status === 200 ? { count: (rc.body as RecallList).items.length, more: (rc.body as RecallList).has_more } : null;
      const body = r.status === 200 ? memoryHomeBody(r.body as MemoryOverview, now, recalls) : `<div class="flash err" role="alert">读取记忆总览失败：${esc(apiError(r))}</div>`;
      return shell('记忆', body, { lead: '聊天记录库的会话域、日 / 周摘要、整理与保留期；从这里进入时间线、检索检查器和线程归档。' });
    }
    if (p === '/memory/recalls') {
      const f = recallFilters(q);
      const [scopes, r] = await Promise.all([overview().then(o => o?.scopes ?? []), api(`/api/memory/recalls?${recallQuery(f)}`)]);
      return shell('召回记录', recallsPageBody(f, scopes, r.status === 200 ? r.body as RecallList : { error: apiError(r) }),
        { lead: '模型每次调用 qq_recent / qq_search / qq_message 的参数、返回条数与裁剪，最新在上；详情页给出三级证据（设计 §5.3）。' });
    }
    if (p.startsWith('/memory/recalls/')) {
      const key = p.slice('/memory/recalls/'.length);
      if (!/^\d{1,15}$/.test(key)) return null;
      const r = await api(`/api/memory/recalls/${key}`);
      if (r.status === 404 || r.status === 400) return null;
      if (r.status !== 200) return shell('召回详情', `<div class="flash err" role="alert">读取召回事件失败：${esc(apiError(r))}</div><p class="mt"><a href="/memory/recalls">返回召回记录</a></p>`);
      return shell(`召回 #${key}`, recallDetailBody(r.body as RecallDetail), { lead: '检索命中 → 工具实际返回 → 该回合内的调用证据，三级分别着色；第三级不等于模型采用了内容。' });
    }
    if (p === '/memory/images') {
      const [o, r] = await Promise.all([overview(), api('/api/memory/images?' + q.toString())]);
      return shell('图片记忆', imagesPageBody(q, o?.scopes ?? [], r.status === 200 ? r.body as ImagePage : { error: apiError(r) }, nonce), { lead: IMAGES_NOTE });
    }
    if (p.startsWith('/memory/images/')) {
      const r = await api('/api' + p);
      if (r.status === 404 || r.status === 400) return null;
      return shell('图片详情', r.status === 200 ? imageDetailBody(r.body as ImageDetail, nonce) : '<p class="flash err">图片详情暂不可用</p>', { lead: IMAGES_NOTE });
    }
    if (p === '/memory/archives') {
      const r = await api('/api/memory/archives');
      return shell('线程归档', archivesPageBody(r.status === 200 ? r.body as ArchivesResult : { error: apiError(r) }), { lead: '重置线程时归档的 Codex / Pi 会话，以及 Pi 的上下文压缩记录；点会话 ID 进入回合流。' });
    }
    if (p === '/memory/search') {
      const f = { scope: q.get('scope') ?? '', q: (q.get('q') ?? '').trim(), days: (q.get('days') ?? '').trim(), limit: (q.get('limit') ?? '').trim() };
      const scopes = (await overview())?.scopes ?? [];
      let result: SearchResult | { error: string } | undefined;
      if (f.q) {
        const query = new URLSearchParams({ q: f.q });
        if (f.scope) query.set('scope', f.scope);
        if (f.days) query.set('days', f.days);
        if (f.limit) query.set('limit', f.limit);
        const r = await api(`/api/memory/search?${query}`);
        result = r.status === 200 ? r.body as SearchResult : { error: `检索失败：${apiError(r)}` };
      }
      return shell('检索检查器', searchPageBody(f, scopes, result), { lead: '同一次检索的两级证据：数据库命中了什么，qq_search 工具裁剪后实际会返回什么。' });
    }
    const parts = p.split('/');
    if (parts.length !== 4 || (parts[2] !== 'scopes' && parts[2] !== 'summaries')) return null;
    let key: string;
    try { key = decodeURIComponent(parts[3] ?? ''); } catch { return null; }
    // 与接口相同的 scope 规则：非法值（含斜杠、控制字符、. / ..）没有对应页面。
    if (!key || key.length > 256 || key === '.' || key === '..' || /[\\/\x00-\x1f\x7f]/.test(key)) return null;
    if (parts[2] === 'summaries') {
      if (!/^[1-9]\d{0,15}$/.test(key)) return null;
      const r = await api(`/api/memory/summaries/${encodeURIComponent(key)}`);
      if (r.status === 404 || r.status === 400) return null;
      if (r.status !== 200) return shell('摘要', `<div class="flash err" role="alert">读取摘要失败：${esc(apiError(r))}</div>`);
      const s = r.body as SummaryDetail;
      const label = (await overview())?.scopes.find(x => x.scope === s.scope)?.label ?? scopeLabel(s.scope);
      return shell(`${s.kind === 'week' ? '周摘要' : '日摘要'} #${s.id}`, summaryPageBody(s, label), { lead: '摘要正文与覆盖区间；尚存原文为当前仍在库中的消息数。' });
    }
    const base = `/api/memory/scopes/${encodeURIComponent(key)}`;
    const params = rangeParams(q);
    const tr = await api(`${base}${params.size ? '?' + params : ''}`);
    if (tr.status === 404) return null;
    if (tr.status !== 200) {
      return shell(scopeLabel(key), `<div class="flash err" role="alert">读取时间线失败：${esc(apiError(tr))}</div><p class="mt"><a href="/memory/scopes/${uri(key)}">查看全部区间</a>　<a href="/memory">返回记忆</a></p>`,
        { lead: '区间参数接受毫秒时间戳、YYYY-MM-DD（UTC）或带时区的 ISO 时间，且 from 早于 to。' });
    }
    const timeline = tr.body as ScopeTimeline;
    const win = messageWindow(timeline.range.first_ts, timeline.range.last_ts);
    const mq = new URLSearchParams({ before: String(win.before), limit: String(MESSAGE_PAGE) });
    if (win.after !== undefined) mq.set('after', String(win.after));
    const mr = await api(`${base}/messages?${mq}`);
    const messages = mr.status === 200 ? mr.body as MessagePage : { error: apiError(mr), status: mr.status };
    // vis-timeline 固定版本，同源提供（设计 §5.1）；defer 脚本与模块脚本按文档顺序执行，memory.js 运行时 vis 已就绪。
    const vendor = !!vendorAsset('vis-timeline.js') && !!vendorAsset('vis-timeline.css');
    const head = vendor ? `<link rel="stylesheet" href="/assets/vendor/vis-timeline.css"><script nonce="${nonce}" defer src="/assets/vendor/vis-timeline.js"></script>` : '';
    return shell(timeline.label, scopePageBody({ timeline, messages, nonce, now, params, vendor }),
      { lead: '原文 / 日摘要 / 周摘要三条轨、空白区间与保留期边界；下方列出所选窗口内的消息。', scripts: ['/assets/memory.js'], head });
  }
  /** /agents/:backend/sessions[/:id[/turns/:turn | /context | /content]]；未知后端、会话或回合返回 null（404）。 */
  async function agentsRoute(p: string, q: URLSearchParams, nonce: string, shell: Shell): Promise<string | null> {
    const parts = p.split('/');
    const backend = parts[2] ?? '';
    if (!isBackend(backend) || parts[3] !== 'sessions' || parts.length > 7) return null;
    const name = BACKENDS[backend] ?? backend;
    if (parts.length === 4) {
      const f = { status: q.get('status') ?? '', scope: q.get('scope') ?? '', since: q.get('since') ?? '', page: Math.max(0, Math.min(1_000_000, Math.floor(Number(q.get('page')) || 0))) };
      if (f.status !== 'active' && f.status !== 'archived') f.status = '';
      const query = new URLSearchParams();
      if (f.status) query.set('status', f.status);
      if (f.scope) query.set('scope', f.scope);
      if (f.since) query.set('since', f.since);
      query.set('page', String(f.page));
      const r = await api(`/api/agents/${backend}/sessions?${query}`);
      const rows = r.status === 200 && Array.isArray(r.body) ? r.body as SessionRef[] : null;
      return shell(`${name} 会话`, sessionListBody(backend, rows, f, rows ? undefined : `读取会话失败：${apiError(r)}`),
        { lead: '活动与归档会话，按更新时间倒序。ID 为后端真实会话 ID。', scripts: ['/assets/agents.js'] });
    }
    let id: string, turnId = '';
    try { id = decodeURIComponent(parts[4] ?? ''); if (parts[6] !== undefined) turnId = decodeURIComponent(parts[6]); } catch { return null; }
    if (!id || (parts.length === 6 && parts[5] !== 'context' && parts[5] !== 'content') ||(parts.length === 7 && (parts[5] !== 'turns' || !turnId))) return null;
    const sr = await api(sessionApi(backend, id));
    if (sr.status === 404 || sr.status === 400) return null;
    if (sr.status !== 200) return shell(`${name} 会话`, `<div class="flash err" role="alert">读取会话失败：${esc(apiError(sr))}</div>`);
    const { session, turns } = sr.body as { session: SessionRef; turns: ObservedTurn[] };
    const window = session.scope ? usageOf(backend, session.scope)?.windowTokens : undefined;
    const ctx = { backend, session: session.id, ...(window ? { window } : {}) };
    const title = session.label && session.label !== session.id ? session.label : sessionScope(backend, session.scope);
    const newest = byNewest(turns);
    const dataTail = dataScript('agents-data', nonce, { backend, session: session.id, active: false, window: window ?? null, base: 0 });
    if (parts.length === 5) {
      const pageNo = Math.max(0, Math.min(100_000, Math.floor(Number(q.get('page')) || 0)));
      const preload = new Map<string, Block[]>();
      await Promise.all(newest.slice(pageNo * 50, pageNo * 50 + PRELOAD_TURNS).map(async t => {
        const r = await api(`${sessionApi(backend, id)}/turns/${encodeURIComponent(t.turn)}`);
        if (r.status === 200) preload.set(t.turn, (asObj(r.body).blocks as Block[] | undefined) ?? []);
      }));
      return shell(`${name} · ${title}`, sessionPageBody({ ctx, session, turns, page: pageNo, preload, usage: session.scope ? usageOf(backend, session.scope) : null, nonce }),
        { lead: '左侧回合目录，右侧回合流（最新在上，默认展开）。上下文占用取每个回合最后一次模型请求的实测输入。', scripts: ['/assets/agents.js', '/assets/usage.js'] });
    }
    if (parts[5] === 'turns') {
      const tr = await api(`${sessionApi(backend, id)}/turns/${encodeURIComponent(turnId)}`);
      if (tr.status === 404 || tr.status === 400) return null;
      if (tr.status !== 200) return shell('回合详情', `<div class="flash err" role="alert">读取回合失败：${esc(apiError(tr))}</div>`);
      const { turn, blocks } = tr.body as { turn: ObservedTurn; blocks: Block[] };
      const k = newest.findIndex(t => t.turn === turn.turn);
      // 记忆调用（设计 §5.2）：召回接口出错或抛异常都只降级为一行提示，回合页照常渲染。
      const mq = new URLSearchParams({ backend, session: session.id, turn: turn.turn });
      const rr = await api(`/api/memory/recalls?${mq}`).catch((e: unknown) => ({ status: 500, body: { error: e instanceof Error ? e.message : String(e) } }));
      const memory = turnRecallSection(rr.status === 200 && rr.body && Array.isArray((rr.body as RecallList).items) ? rr.body as RecallList : { error: apiError(rr) },
        { backend, session: session.id, turn: turn.turn });
      return shell('回合详情', turnPageBody(ctx, session, turn, blocks, { newer: k > 0 ? newest[k - 1]?.turn : undefined, older: k >= 0 ? newest[k + 1]?.turn : undefined }, memory) + dataTail,
        { lead: '输入 → 模型请求（可多次）→ 工具调用（参数与结果折叠）→ 助手文本 → 送达。', scripts: ['/assets/agents.js'] });
    }
    if (parts[5] === 'content') return contentPage(backend, id, session, title, q, shell);
    // 上下文结构分析（设计 §4）：分析接口由 O3 提供；缺席（404/501/503）时给出不可用状态。
    const at = q.get('at') || newest[0]?.turn || '';
    const phase = q.get('phase') === 'before' ? 'before' : 'after';
    const head = crumbs([['Agent', '/agents'], [name, sessionsHref(backend)], [title, sessionHref(backend, session.id)], ['上下文分析']]);
    const lead = `回合 <span class="mono">${esc(at ? at.slice(0, 40) : '—')}</span> ${phase === 'before' ? '请求发出前' : '结束后'}的上下文窗口构成。实测与估算分开标注，未解释差额单列。`;
    if (!at) return shell('上下文分析', head + empty('这个会话还没有回合，无法分析。') + dataTail, { lead });
    const ar = await api(`${sessionApi(backend, id)}/context?${new URLSearchParams({ at, phase })}`);
    const body = ar.status === 200 && ar.body && typeof ar.body === 'object' ? contextAnalysisBody(ctx, ar.body as ContextAnalysis)
      : [404, 501, 503].includes(ar.status) ? contextUnavailable(ctx, at, phase, ar.status, typeof asObj(ar.body).error === 'string' ? String(asObj(ar.body).error) : undefined)
        : contextError(ctx, at, phase, ar.status, apiError(ar));
    return shell('上下文分析', head + body + dataTail, { lead, scripts: ['/assets/agents.js'] });
  }

  /**
   * /agents/:backend/sessions/:id/content?offset=&length=[&page=]：会话文件正文区间的全文页。
   * 每页一次请求 [offset + page×256 KiB, min(256 KiB, 剩余))：服务端在固定步长下把跨界字符归前一段、
   * 后一段跳过续字节，因此按页码寻址既不丢也不重；末页与"是否还有下一段"按实际返回的 UTF-8 字节数判断。
   */
  async function contentPage(backend: string, id: string, session: SessionRef, title: string, q: URLSearchParams, shell: Shell): Promise<string | null> {
    if (['bundle', 'payload', 'select'].some(key => q.has(key))) {
      if (backend !== 'codex' || ['offset', 'length', 'page'].some(key => q.has(key))
        || ['bundle', 'payload', 'select'].some(key => q.getAll(key).length !== 1 || !q.get(key))) return null;
      const ref = { bundle: q.get('bundle')!, payload: q.get('payload')!, select: q.get('select')! };
      const head = crumbs([['Agent', '/agents'], [BACKENDS[backend], sessionsHref(backend)], [title, sessionHref(backend, session.id)], ['正文']]);
      const lead = '官方 trace 中的正文（已按会话脱敏规则处理），单次响应最多 1 MiB。';
      const r = await api(`${sessionApi(backend, id)}/trace-content?${new URLSearchParams(ref)}`);
      if (r.status === 404 || r.status === 400) return null;
      if (r.status !== 200) return shell('正文', `${head}<div class="flash err" role="alert">读取正文失败：${esc(apiError(r))}</div>`, { lead });
      const body = asObj(r.body), text = typeof body.text === 'string' ? body.text : '';
      const meta = kv([
        ['bundle', `<code class="mono">${esc(ref.bundle)}</code>`],
        ['payload', `<code class="mono">${esc(ref.payload)}</code>`],
        ['select', `<code class="mono">${esc(ref.select)}</code>`],
        ['来源会话', `<a href="${sessionHref(backend, session.id)}">${esc(title)}</a> <code class="mono">${esc(session.id)}</code>`],
      ]);
      const warn = body.truncated === true ? '<div class="flash err" role="alert">正文超出单次响应上限，已被服务端截断。</div>' : '';
      return shell('正文', `${head}<section class="sheet pad">${meta}</section>${warn}<section><pre class="mono wrap full">${escFull(text)}</pre></section>`, { lead });
    }
    const int = (v: string | null) => v !== null && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
    const offset = int(q.get('offset')), length = int(q.get('length'));
    const page = q.get('page') === null || q.get('page') === '' ? 0 : int(q.get('page'));
    if (![offset, length, page].every(Number.isSafeInteger) || length <= 0 || !Number.isSafeInteger(offset + length)
      || !Number.isSafeInteger(page * CONTENT_PAGE) || page * CONTENT_PAGE >= length) return null;
    const start = offset + page * CONTENT_PAGE, size = Math.min(CONTENT_PAGE, length - page * CONTENT_PAGE);
    const pages = Math.ceil(length / CONTENT_PAGE);
    const name = BACKENDS[backend] ?? backend;
    const head = crumbs([['Agent', '/agents'], [name, sessionsHref(backend)], [title, sessionHref(backend, session.id)], ['正文']]);
    const lead = '会话文件中的一段正文（已按会话脱敏规则处理），每页最多 256 KiB。';
    const r = await api(`${sessionApi(backend, id)}/content?offset=${start}&length=${size}`);
    if (r.status === 404 || r.status === 400) return null;
    if (r.status !== 200) return shell('正文', `${head}<div class="flash err" role="alert">读取正文失败：${esc(apiError(r))}</div>`, { lead });
    const body = asObj(r.body), text = typeof body.text === 'string' ? body.text : '';
    const got = Buffer.byteLength(text);
    const meta = kv([
      ['区间', `offset <span class="mono">${esc(fmtInt(offset))}</span> · length <span class="mono">${esc(fmtInt(length))}</span>`],
      ['字节数', `${esc(fmtBytes(length))}${pages > 1 ? ` · 第 ${page + 1} / ${pages} 段，本段 ${esc(fmtBytes(got))}` : ''}`],
      ['来源会话', `<a href="${sessionHref(backend, session.id)}">${esc(title)}</a> <code class="mono">${esc(session.id)}</code>`],
    ]);
    // 下一段：本段确实读到了正文（返回 0 字节说明文件里已没有更多内容），且区间还没读完。
    const next = got > 0 && page + 1 < pages, prev = page > 0;
    const nav = prev || next ? `<p class="hint mt">${prev ? `<a href="${contentHref(backend, id, offset, length, page - 1)}">上一段</a>` : ''}${prev && next ? '　' : ''}${next ? `<a href="${contentHref(backend, id, offset, length, page + 1)}">下一段</a>` : ''}</p>` : '';
    const warn = body.truncated === true ? '<div class="flash err" role="alert">本段超出单次响应上限，已被服务端截断。</div>' : '';
    const pre = got ? `<pre class="mono wrap full">${escFull(text)}</pre>` : empty('这一段没有正文（可能已超出会话文件的实际长度）。');
    return shell('正文', `${head}<section class="sheet pad">${meta}</section>${warn}<section>${pre}</section>${nav}`, { lead });
  }

  /** 设置页按 agent 分两组：模型下拉（magpie 目录）+ 思考档位（auto + 支持的档位），设计 §5。 */
  function agentModelFieldsets(s: Readonly<RuntimeSettings>, d: RuntimeSettingsView | undefined, diff: (k: keyof RuntimeSettings) => string): string {
    const catalog = <T,>(read: (() => T[]) | undefined): T[] => { try { return read?.() ?? []; } catch { return []; } };
    const option = (value: string, current: string, label = value) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
    // 当前值不在清单里时仍作为选项保留，保存其它字段不会意外改掉它。
    const keep = (values: readonly string[], current: string) => values.includes(current) ? [...values] : [current, ...values];
    const defaultsHint = (model?: string, effort?: string) => d ? `<div class="hint">.env 默认：模型 ${esc(model)}，档位 ${esc(effort)}。</div>` : '';

    const codexModels = catalog(opts.modelCatalog?.codex);
    const codexModelControl = codexModels.length
      ? `<select name="codexModel">${keep(codexModels.map(m => m.slug), s.codexModel).map(slug => {
        const m = codexModels.find(x => x.slug === slug);
        return option(slug, s.codexModel, m ? slug + windowK(m.contextWindow) : `${slug}（不在目录中）`);
      }).join('')}</select>`
      : `<input name="codexModel" value="${esc(s.codexModel)}" spellcheck="false" autocomplete="off"><small>模型目录不可用，请手动填写模型 slug。</small>`;
    const codexEffort = `<select name="codexReasoningEffort">${keep(['auto', ...REASONING_EFFORTS], s.codexReasoningEffort).map(e => option(e, s.codexReasoningEffort)).join('')}</select>`;
    const codex = `<fieldset><legend>Codex 模型与推理强度</legend><div class="choices"><label><span>模型${diff('codexModel')}</span>${codexModelControl}</label><label><span>推理强度${diff('codexReasoningEffort')}</span>${codexEffort}</label></div>
<div class="hint">每轮以 -c 参数传给 codex，下一条消息即生效，不换线程。${AUTO_HINT}</div>${defaultsHint(d?.codexModel, d?.codexReasoningEffort)}</fieldset>`;

    const piModels = catalog(opts.modelCatalog?.pi);
    const selectable = config.AGENT_MODEL_PROVIDER === 'magpie' && piModels.length > 0;
    const piModelControl = selectable
      ? `<select name="piModel">${keep(piModels.map(m => m.id), s.piModel).map(id => {
        const m = piModels.find(x => x.id === id);
        return option(id, s.piModel, m ? id + windowK(m.contextWindow) : `${id}（不在目录中）`);
      }).join('')}</select>`
      : `<input type="hidden" name="piModel" value="${esc(s.piModel)}"><span class="mono">${esc(s.piModel)}</span><small>提供者 ${esc(config.AGENT_MODEL_PROVIDER)} 下只读；切换模型需 magpie 提供者。</small>`;
    // 档位按当前所选模型过滤（服务端渲染）；模型不在清单里时给全集，由 pi 后端就近收敛。
    const levels = piModels.find(m => m.id === s.piModel)?.thinkingLevels ?? PI_THINKING_LEVELS;
    const piLevel = `<select name="piThinkingLevel">${keep(['auto', ...levels.filter(l => l !== 'auto')], s.piThinkingLevel).map(l => option(l, s.piThinkingLevel)).join('')}</select>`;
    const pi = `<fieldset><legend>Pi 模型与思考档位</legend><div class="choices"><label><span>模型${diff('piModel')}</span>${piModelControl}</label><label><span>思考档位${diff('piThinkingLevel')}</span>${piLevel}</label></div>
<div class="hint">每次提交读取，下一条消息即生效。档位列表按当前已保存的模型过滤；换模型后保存一次再选档。${AUTO_HINT}</div>${defaultsHint(d?.piModel, d?.piThinkingLevel)}</fieldset>`;
    return codex + '\n' + pi;
  }

  async function settingsBody(): Promise<string> {
    const codexProvider = config.CODEX_PROVIDER === 'magpie' ? `经 magpie（${config.CODEX_MAGPIE_URL}）` : '直连';
    const piProvider = config.AGENT_MODEL_PROVIDER === 'magpie' ? `magpie（${config.CODEX_MAGPIE_URL}）` : `直连 ${config.AGENT_MODEL_PROVIDER}`;
    let body = `<section class="sheet pad"><p>codex：${esc(redactText(codexProvider, 2000))}</p><p>pi：${esc(redactText(piProvider, 2000))}</p><p class="hint">提供者为只读启动配置；修改 .env 后重启生效。</p></section>`;
    if (!opts.settings) body += '<div class="flash err">运行时设置不可用，以下为只读的启动配置。</div>';
    const s = opts.settings?.current();
    const d = opts.settings?.defaults;
    const diff = (k: keyof RuntimeSettings) => s && d && JSON.stringify(s[k]) !== JSON.stringify(d[k]) ? ' <span class="changed">与 .env 不同</span>' : '';
    if (s) {
      const radio = (name: string, value: string, label: string, note: string) => `<label class="choice"><input type="radio" name="${name}" value="${esc(value)}"${(s as unknown as Record<string, unknown>)[name] === value ? ' checked' : ''}><span>${esc(label)}<small>${note}</small></span></label>`;
      body += `<section class="flush"><form method="post" action="/settings" class="sheet pad">${csrfField(csrf)}
<fieldset><legend>执行后端${diff('agentBackend')}</legend><div class="choices">${radio('agentBackend', 'codex', 'Codex', '容器内 codex CLI，owner 与共享两条长期线程，可用浏览器与命令。')}${radio('agentBackend', 'pi', 'Pi', '进程内 pi 会话，每个会话域独立记忆，联网检索走 DeepSeek。')}</div></fieldset>
<fieldset><legend>按会话覆盖${diff('backendOverrides')}</legend><label>每行一项，例如 group:200000001=pi<textarea name="backendOverrides" rows="4" spellcheck="false">${esc(formatBackendOverrides(s.backendOverrides))}</textarea></label><div class="hint">留空表示全部使用上面的默认后端。会话域格式为 group:群号 或 private:QQ号。</div></fieldset>
${agentModelFieldsets(s, d, diff)}
<fieldset><legend>owner 告警${diff('alertOwner')}</legend><label class="choice"><input type="checkbox" name="alertOwner"${s.alertOwner ? ' checked' : ''}><span>向 owner 私聊发送告警<small>QQ 离线超过五分钟、模型鉴权失败、连续三条失败时发送，30 分钟内最多一条。${config.owner ? '' : '（当前没有配置 owner，开关不会生效）'}</small></span></label></fieldset>
<button>保存设置</button></form></section>`;
    }
    body += await grantsCard();
    body += await codexPromptCard();
    body += await codexBasePromptCard(s?.codexModel ?? config.CODEX_MODEL);
    let prompt = '';
    try { const st = await fs.lstat(agentMd); prompt = st.isFile() && !st.isSymbolicLink() && st.size <= 256_000 ? await fs.readFile(agentMd, 'utf8') : ''; } catch { /* 不存在：pi 启动时会播种 */ }
    const promptStat = await fs.lstat(agentMd).catch(() => null);
    const mtime = promptStat?.mtime;
    // 编辑框显示原文以便保存时不破坏内容；但若其中出现已注册的秘密则只读展示脱敏版。
    const secretInside = redactText(prompt, 1_000_000) !== prompt;
    body += `<section id="prompt"><h2>pi 系统提示 agent.md <small>${mtime ? `修改于 ${esc(fmtTime(mtime.getTime()))}` : '尚未创建'}</small></h2>${secretInside
      ? `<div class="flash err">文件中包含凭据样式的内容，面板只读展示脱敏版本；请在容器内直接编辑。</div>${json(prompt)}`
      : `<form method="post" action="/settings/agent-md" class="sheet pad">${csrfField(csrf)}<input type="hidden" name="revision" value="${esc(agentMdRevision(promptStat))}"><label>每轮对话前热加载，保存后 pi 下一轮即使用新内容。<textarea name="content" rows="18" spellcheck="false" data-count="agent-md-count">${esc(prompt)}</textarea></label><div class="hint"><span id="agent-md-count"></span>，上限 ${AGENT_MD_MAX_BYTES / 1024} KB</div><p class="mt"><button>保存 agent.md</button></p></form>`}</section>`;
    const changes = opts.store.systemEvents(SETTINGS_TICKET, 15);
    body += `<section><h2>最近变更</h2>${changes.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>时间</th><th>内容</th><th>来源</th></tr></thead><tbody>${changes.map(e => { const dd = asObj(JSON.parse(e.detail_json));
      const bytes = (v: unknown) => typeof v === 'number' ? fmtBytes(v) : '—';
      const what = e.stage === 'prompt_changed' ? `${dd.target === 'codex-base' ? `codex 基础指令（${dd.model}）` : dd.target === 'codex' ? 'codex.md' : 'agent.md'} ${bytes(dd.bytes_before)} → ${bytes(dd.bytes_after)}` : Object.keys(asObj(dd.after)).map(k => `${SETTING_LABELS[k] ?? k}：${showSetting(asObj(dd.before)[k])} → ${showSetting(asObj(dd.after)[k])}`).join('；');
      return `<tr><td>${time(e.ts)}</td><td>${esc(what)}</td><td>${esc(dd.source === 'dashboard' ? '面板' : dd.source ?? '')}</td></tr>`; }).join('')}</tbody></table></div></div>` : empty('还没有通过面板修改过设置。')}</section>`;
    body += `<section><p class="hint">完整的生效配置见<a href="/config">配置页</a>；结构化日志见<a href="/logs">实时日志</a>。</p></section>`;
    return body;
  }

  async function grantsCard(): Promise<string> {
    if (!opts.grants) return '';
    const grants = await opts.grants.list();
    const rows = grants.map(g => `<tr><td class="mono">${esc(g.user)}</td><td>${esc(g.caps.join('、'))}</td><td>${g.targets.map(esc).join('<br>') || '不能主动发送'}</td><td>${g.scopes === undefined ? '任何会话' : g.scopes.map(esc).join('<br>') || '无'}</td><td>${g.expired ? '<span class="changed">已过期</span>' : '有效'}<br>${g.expires_at === undefined ? '长期' : esc(fmtTime(g.expires_at))}</td><td>${esc(g.granted_by)}</td><td>${config.owner ? `<form method="post" action="/settings/grants/revoke">${csrfField(csrf)}<input type="hidden" name="user" value="${esc(g.user)}"><button class="danger">撤销</button></form>` : ''}</td></tr>`).join('');
    return `<section id="grants"><h2>授权</h2><p class="hint">由 owner 管理。添加会替换该用户的现有授权；schedule 当前仅存储，尚不执行定时任务。</p>
<div class="sheet wrap"><table class="list"><thead><tr><th>用户</th><th>能力</th><th>发送目标</th><th>来源范围</th><th>状态 / 到期</th><th>授权人</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>
${config.owner ? `<form method="post" action="/settings/grants/add" class="sheet pad mt">${csrfField(csrf)}
<label>用户（qq:QQ号）<input name="user" placeholder="qq:10001" required></label>
<div class="choices"><label class="choice"><input type="checkbox" name="caps" value="send" checked>send</label><label class="choice"><input type="checkbox" name="caps" value="schedule">schedule（仅存储）</label></div>
<label>发送目标（每行一个 qq:group:群号 或 qq:private:QQ号；留空不能主动发往别处）<textarea name="targets" rows="3"></textarea></label>
<label>来源会话（group:群号 或 private:QQ号；留空为任何会话）<textarea name="scopes" rows="2"></textarea></label>
<label>有效小时数（留空为长期）<input type="number" name="expires_in_hours" min="0.001" step="any" max="876000"></label><p class="mt"><button>添加 / 替换授权</button></p></form>` : '<p class="hint">未配置 owner，授权只读。</p>'}</section>`;
  }

  async function codexBasePromptCard(model: string | undefined): Promise<string> {
    const head = `<section id="codex-base-prompt"><h2>codex 基础指令（${esc(model ?? '未配置')}）</h2>`;
    const store = opts.codexBasePrompt;
    if (!store || !model) return head + empty('codex 基础指令存储未接入。') + '</section>';
    const preview = `<details class="mt"><summary>自动追加的 QQ 受管规则（只读）</summary>${json(redactText(store.managed, 1_000_000))}</details>`;
    let snap: CodexBasePromptSnapshot | undefined;
    try { snap = await store.read(model); }
    catch { return head + '<div class="flash err">读取基础指令失败，请检查文件编码、大小及权限。</div>' + preview + '</section>'; }
    if (!snap) return head + empty('目录模板暂不可用；本轮使用 Codex 默认基础指令。') + preview + '</section>';
    const diff = snap.differs === null ? '<span class="hint">目录模板暂不可用，无法比较。</span>'
      : snap.differs ? '<span class="changed">与目录默认不同</span>' : '<span class="hint">与目录默认一致</span>';
    const fields = `${csrfField(csrf)}<input type="hidden" name="model" value="${esc(model)}"><input type="hidden" name="revision" value="${esc(snap.revision)}">`;
    const editor = redactText(snap.custom, 1_000_000) !== snap.custom
      ? `<div class="flash err">基础指令包含凭据样式的内容，面板只读展示脱敏版本；请在容器内直接编辑。</div>${json(redactText(snap.custom, 1_000_000))}`
      : `<form method="post" action="/settings/codex-base-prompt" class="sheet pad">${fields}<label>下一轮生效，包含已有线程续聊；自动追加 QQ 受管规则。<textarea name="content" rows="18" spellcheck="false" data-count="codex-base-count">${esc(snap.custom)}</textarea></label><div class="hint"><span id="codex-base-count"></span>，上限 64 KB。Codex 升级不会更新已播种文件。</div><p class="mt"><button>保存基础指令</button></p></form><form method="post" action="/settings/codex-base-prompt/restore" class="mt">${fields}<button class="quiet"${snap.differs === null ? ' disabled' : ''}>恢复目录默认</button></form>`;
    return head + `<p>${diff} <small>修改于 ${esc(fmtTime(snap.updatedAt ?? 0))}</small></p>` + editor + preview + '</section>';
  }

  async function codexPromptCard(): Promise<string> {
    const head = (note: string) => `<section id="codex-prompt"><h2>codex 系统提示 codex.md <small>${note}</small></h2>`;
    const link = '<p class="hint"><a href="/codex/agents-md">查看完整 AGENTS.md</a>（受管规则 + codex.md，只读）</p>';
    if (!opts.codexPrompt) return `${head('')}${empty('codex 系统提示存储未接入。')}${link}</section>`;
    let snap: CodexPromptSnapshot;
    try { snap = await opts.codexPrompt.read(); } catch { return `${head('')}<div class="flash err">读取 codex.md 失败，详见日志。</div>${link}</section>`; }
    const secretInside = redactText(snap.custom, 1_000_000) !== snap.custom;
    const editor = secretInside
      ? `<div class="flash err">codex.md 中包含凭据样式的内容，面板只读展示脱敏版本；请在容器内直接编辑。</div>${json(redactText(snap.custom, 1_000_000))}`
      : `<form method="post" action="/settings/codex-prompt" class="sheet pad">${csrfField(csrf)}<input type="hidden" name="revision" value="${esc(snap.revision)}"><label>拼接在受管规则之后写入全局 AGENTS.md，codex 下一条消息即使用新内容。<textarea name="content" rows="18" spellcheck="false" data-count="codex-md-count">${esc(snap.custom)}</textarea></label><div class="hint"><span id="codex-md-count"></span>，上限 ${AGENT_MD_MAX_BYTES / 1024} KB</div><p class="mt"><button>保存 codex.md</button></p></form>`;
    return `${head(snap.updatedAt ? `修改于 ${esc(fmtTime(snap.updatedAt))}` : '尚未修改')}${editor}<details class="mt"><summary>受管规则（程序生成，不可编辑）</summary>${json(redactText(snap.managed, 1_000_000))}</details>${link}</section>`;
  }

  /* ───────── 技能（设计 skills-admin §3）：上传、下载与删除由 HTTP 层处理，这里只渲染 ───────── */

  const skillOps = (name: string) => `<div class="ops"><a class="btn quiet" href="/skills/${uri(name)}.zip">下载</a><form method="post" action="/skills/${uri(name)}/delete">${csrfField(csrf)}<button class="danger">删除</button></form></div>`;

  async function skillsBody(): Promise<string> {
    if (!opts.skills) return empty('技能目录已禁用（PI_SKILLS_DIR=off）。');
    let body = `<form method="post" action="/skills/upload" enctype="multipart/form-data" class="sheet pad">${csrfField(csrf)}<div class="choices"><label><span>技能文件</span><input type="file" name="file" accept=".zip,.md" required></label><label class="choice"><input type="checkbox" name="overwrite"><span>覆盖同名技能</span></label></div><div class="hint">zip 内每个技能为 <code>&lt;name&gt;/SKILL.md</code>，或直接上传单个 SKILL.md；上限 20 MiB。</div><p class="mt"><button>上传</button></p></form>`;
    const list = await opts.skills.list();
    const clip = (s: string) => { const chars = Array.from(s); return chars.length > 120 ? chars.slice(0, 120).join('') + '…' : s; };
    const notes = (s: { diagnostics: string[]; hidden: boolean }) => [...(s.hidden ? ['<span class="muted">不列入提示</span>'] : []), ...s.diagnostics.map(d => `<span class="changed">${esc(d)}</span>`)].join('<br>') || '—';
    body += `<section><h2>已安装 <small>${list.length ? `${list.length} 个` : ''}</small></h2>${list.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>名称</th><th>描述</th><th class="num">文件 / 大小</th><th>诊断</th><th class="hide-sm">修改时间</th><th>操作</th></tr></thead><tbody>${list.map(s => `<tr><td><a class="mono" href="/skills/${uri(s.name)}">${esc(s.name)}</a></td><td>${s.description ? esc(clip(s.description)) : '<span class="faint">—</span>'}</td><td class="num">${s.files} 个 / ${esc(fmtBytes(s.bytes))}</td><td>${notes(s)}</td><td class="hide-sm">${esc(fmtTime(s.mtime))}</td><td>${skillOps(s.name)}</td></tr>`).join('')}</tbody></table></div></div>`
      : empty('技能目录还是空的。上传一个 zip 或 SKILL.md 开始。')}</section>`;
    body += '<section><p class="hint">技能目录位于宿主机 <code>SKILLS_DIR</code>，pi 与 codex 共用；owner 本人发来的消息也可让 agent 自行写入技能。</p></section>';
    return body;
  }

  /** 名称非法或技能不存在（SkillsStoreError）返回 null（404）。 */
  async function skillDetail(name: string): Promise<string | null> {
    if (!opts.skills) return null;
    let files: { path: string; size: number }[], md: string;
    try { [files, md] = await Promise.all([opts.skills.files(name), opts.skills.readSkillMd(name)]); }
    // UI 层不引入 agent 模块：按 SkillsStoreError 的形状（带 status 的 Error）判定，见 agent/skills-store.ts。
    catch (e) { if (e instanceof Error && typeof (e as { status?: unknown }).status === 'number') return null; throw e; }
    let body = crumbs([['技能', '/skills'], [name]]);
    body += `<section class="flush"><h2>SKILL.md</h2><pre class="mono">${esc(md)}</pre></section>`;
    body += `<section><h2>文件 <small>${files.length} 个</small></h2><div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>相对路径</th><th class="num">大小</th></tr></thead><tbody>${files.map(f => `<tr><td class="mono">${esc(f.path)}</td><td class="num">${esc(fmtBytes(f.size))}</td></tr>`).join('')}</tbody></table></div></div></section>`;
    body += `<section>${skillOps(name)}</section>`;
    return body;
  }

  async function configBody(): Promise<string> {
    const cfg = asObj(redact(config, 2_000));
    const rows = Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b));
    let body = `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>项</th><th>值</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('')}</tbody></table></div></div>`;
    const st = await fs.stat(agentMd).catch(() => null);
    body += `<section><h2>agent.md <small>${st ? `修改于 ${esc(fmtTime(st.mtime.getTime()))}` : '文件不存在'}</small></h2>${json(await readText(agentMd))}<p class="hint">在<a href="/settings#prompt">设置页</a>编辑。</p></section>`;
    return body;
  }

  return { render, usageList };
}
