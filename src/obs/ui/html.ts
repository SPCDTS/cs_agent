/** 面板的服务端渲染部件：所有文本先脱敏再转义（esc），结构类名对应 theme.ts。 */
import { redact, redactText } from '../../shared/redact.js';
import { THEME_CSS } from './theme.js';

const escHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const esc = (v: unknown) => escHtml(redactText(String(v ?? ''), 100_000));
/** 同 esc（脱敏 + 转义），但不按 10 万字截断；只用于正文页这类本身已分段限长的大块文本。 */
export const escFull = (v: string) => escHtml(redactText(v, Number.MAX_SAFE_INTEGER));
export const uri = (v: string) => encodeURIComponent(redactText(v, 100_000));
export const json = (v: unknown, limit = 20_000) => `<pre>${esc(typeof v === 'string' ? v : JSON.stringify(redact(v, limit), null, 2))}</pre>`;

/** 顶栏（观测 v2 设计 §1）；日志与配置从设置页进入，旧聊天记录检索归入"记忆"。 */
const NAV: [string, string][] = [['/', '总览'], ['/agents', 'Agent'], ['/memory', '记忆'], ['/context-usage', '上下文监控'], ['/turns', '回合'], ['/live', '实时'], ['/schedules', '定时任务'], ['/skills', '技能'], ['/settings', '设置']];
const NAV_ALIASES: Record<string, string[]> = { '/agents': ['/codex'], '/memory': ['/context'], '/settings': ['/logs', '/config'], '/turns': ['/inputs'], '/live': ['/conversations'] };

export interface PageOptions { title: string; path: string; lead?: string; actions?: string; body: string; nonce: string; scripts?: string[];
  /** 额外的 <head> 内容（同源样式表、带 nonce 的 defer 脚本）；调用方负责其中不含运行数据。 */
  head?: string; flash?: Flash }
/** 操作结果提示；detail 为附加明细（如上传的导入 / 跳过结果），以 <small> 转义显示。 */
export interface Flash { text: string; error?: boolean; detail?: string }

export function page(o: PageOptions): string {
  const under = (url: string) => o.path === url || o.path.startsWith(url + '/');
  const active = (url: string) => url === '/' ? o.path === '/' : under(url) || (NAV_ALIASES[url] ?? []).some(under);
  const nav = NAV.map(([url, label]) => `<a href="${url}"${active(url) ? ' aria-current="page"' : ''}>${url === '/live' ? '<i class="live-dot" aria-hidden="true"></i>' : ''}${label}</a>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.ico"><meta name="color-scheme" content="light dark"><title>${esc(o.title)} · cs-agent 值守台</title>${o.head ?? ''}<style nonce="${o.nonce}">${THEME_CSS}</style></head>
<body><header class="top"><div class="top-in"><a class="mark" href="/"><i aria-hidden="true"></i>cs-agent <span>值守台</span></a><nav class="tabs" aria-label="主导航">${nav}</nav></div></header>
<main><div class="head"><div><h1>${esc(o.title)}</h1>${o.lead ? `<p>${o.lead}</p>` : ''}</div>${o.actions ? `<div class="actions">${o.actions}</div>` : ''}</div>
${o.flash ? `<div class="flash${o.flash.error ? ' err' : ''}" role="status">${esc(o.flash.text)}${o.flash.detail ? ` <small>${esc(o.flash.detail)}</small>` : ''}</div>` : ''}${o.body}</main>
${(o.scripts ?? []).map(src => `<script type="module" nonce="${o.nonce}" src="${src}"></script>`).join('')}</body></html>`;
}

export type Tone = 'ok' | 'fail' | 'warn' | 'run' | 'queue' | 'idle';
export const stamp = (label: string, tone: Tone, big = false) => `<span class="stamp s-${tone}${big ? ' big' : ''}">${esc(label)}</span>`;

/**
 * 回合 / 会话状态 → 印章文字与色调：回合结果 completed / failed / lost / processing，会话 working / idle，
 * 输入 queued / delivered / done；sent / timeout / fallback 只出现在保留期内的旧版数据。
 */
export const STATUS: Record<string, [string, Tone]> = {
  completed: ['已完成', 'ok'], failed: ['失败', 'fail'], lost: ['中断', 'fail'], superseded: ['被唤醒取代', 'warn'], processing: ['进行中', 'run'],
  working: ['工作中', 'run'], idle: ['空闲', 'idle'], queued: ['排队', 'queue'], delivered: ['已送达', 'run'], done: ['已结束', 'ok'],
  sent: ['已回复', 'ok'], timeout: ['超时', 'fail'], fallback: ['兜底', 'warn'],
};
export const statusStamp = (status: string, big = false) => { const [label, tone] = STATUS[status] ?? [status || '未知', 'idle' as Tone]; return stamp(label, tone, big); };
/** 回合种类 → 文字。 */
export const TURN_KINDS: Record<string, string> = { user: '用户消息', scheduled: '定时任务', wake: '唤醒' };


export const STAGES: Record<string, string> = {
  received: '收到', recovered: '重启后接管', queued: '入队', admitted: '开轮', delivered: '已送达', ignored: '已忽略', effort_route: '选档',
  dispatched: '开始处理', steered: '插话', subagent: '子 agent', stalled: '停滞', thread_stopped: '面板停止', schedule_run: '定时运行',
  model_turn: '模型回合', model_usage: '用量', model_request: '模型请求', model_error: '模型错误', final_answer: '最终回答（未发送）', send_message: '发送消息', send_rejected: '发送被规则拒绝', send_breaker: '发送熔断', auth_changed: '授权变更',
  reply_sent: '回合结束', failed: '回合失败',
  compaction: '上下文压缩', context_usage: '上下文占用', events_dropped: '事件超出上限', settings_changed: '设置变更', thread_reset: '重置线程',
};
export function stageLabel(stage: string): string {
  if (STAGES[stage]) return STAGES[stage]!;
  if (stage.startsWith('backend:')) return stage.slice(8) === 'codex' ? 'Codex 回合' : stage.slice(8) === 'pi' ? 'Pi 回合' : '后端 ' + stage.slice(8);
  if (stage.startsWith('tool:')) return '工具 ' + stage.slice(5);
  return stage;
}

export const BACKENDS: Record<string, string> = { codex: 'Codex', pi: 'Pi' };

/**
 * trace 键 → 面板页：turn:<id> 回合页、in:<入站键> 输入页、thr:<会话键> 会话页；
 * 旧版键（入站键本身，或 run_ 定时键）进输入页，输入页同时读取旧键下的事件。@ 系统键没有页面。
 */
export function traceHref(key: string): string | undefined {
  if (key.startsWith('turn:')) return '/turns/' + uri(key.slice(5));
  if (key.startsWith('in:')) return '/inputs/' + uri(key.slice(3));
  if (key.startsWith('thr:')) return '/conversations/' + uri(key.slice(4));
  return key && !key.startsWith('@') ? '/inputs/' + uri(key) : undefined;
}
/** 会话键 → 显示文字（owner / 群 / 私聊），name 为群名。 */
export function threadLabel(thread: string, name?: string): string {
  if (thread === 'owner') return 'owner 私聊';
  const m = /^(group|private):(\d+)$/.exec(thread);
  if (!m) return thread || '未知会话';
  return m[1] === 'group' ? (name ? `群 ${name}(${m[2]})` : `群 ${m[2]}`) : `私聊 ${m[2]}`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  const m = Math.floor(ms / 60_000), s = Math.round((ms % 60_000) / 1000);
  return m < 60 ? `${m} 分 ${s} 秒` : `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}
/** 事件流里的短偏移：+0.4秒 / +12秒 / +3分05秒 */
export function fmtOffset(ms: number): string {
  if (ms < 60_000) return `+${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}秒`;
  return `+${Math.floor(ms / 60_000)}分${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}秒`;
}
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, timeZone: process.env.TZ || undefined });
}
function fmtAgo(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return `${Math.floor(d / 86400_000)} 天前`;
}
/** 秒或毫秒时间戳（数字或数字字符串）→ 毫秒；小于 1e12 视为秒。无效返回 null。 */
export function epochMs(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}
/** 完整日期时间 + 相对时间，例如 "2026/10/18 16:00:00（3 小时前）"。 */
export const fmtWhen = (ms: number, now = Date.now()) => `${fmtTime(ms)}（${fmtAgo(ms, now)}）`;
export const time = (ts: number) => `<time datetime="${new Date(ts).toISOString()}" title="${esc(fmtTime(ts))}">${esc(fmtAgo(ts))}</time>`;
export const empty = (text: string) => `<div class="empty">${text}</div>`;
export const kv = (rows: [string, string][], cls = '') => `<dl class="kv${cls ? ' ' + cls : ''}">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
export const csrfField = (token: string) => `<input type="hidden" name="_csrf" value="${esc(token)}">`;
