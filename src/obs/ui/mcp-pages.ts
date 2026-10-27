/**
 * 外部账号页（docs/DASHBOARD.md §11）：/mcp/accounts。
 * 数据来自 /api/mcp/accounts 的同一份 JSON（本身不含 token）；登录与退出是同源表单 POST + CSRF，结果经 ?ok / ?error 回到本页。
 */
import { fmtUntil } from './memory-pages.js';
import { csrfField, empty, esc, fmtTime, fmtWhen, kv, stamp, uri, type Tone } from './html.js';

export interface McpAccountView {
  serverId: string; accountId: string; revision: string; issuer?: string; loggedIn: boolean;
  expiresAt?: number; scope?: string; hasRefresh: boolean; lastError?: string; lastErrorAt?: number;
}
export interface McpAccountsView { accounts: McpAccountView[]; redirectUrl: string }

/** 后端只回固定错误码（不回显第三方描述），这里只做中文映射；未知码原样显示。 */
const ERRORS: Record<string, string> = { auth_required: '需要登录', refresh_failed: '刷新失败，需重新登录', invalid_state: '登录链接已失效，请重新发起登录', server_unavailable: '服务未启用' };
const errorText = (code: string) => ERRORS[code] ?? code;
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** 过期且无 refresh token 时后端也记 auth_required，单独标"已过期"便于区分"从未登录"。 */
function accountStamp(a: McpAccountView, now: number): string {
  const [label, tone]: [string, Tone] = a.loggedIn ? ['已登录', 'ok'] : a.lastError === 'refresh_failed' ? ['刷新失败', 'fail']
    : a.expiresAt !== undefined && a.expiresAt <= now ? ['已过期', 'warn'] : ['需要登录', 'warn'];
  return stamp(label, tone);
}

function accountCard(a: McpAccountView, csrf: string, now: number): string {
  const faint = (t: string) => `<span class="faint">${t}</span>`;
  const expires = a.expiresAt === undefined ? faint(a.loggedIn ? '未声明' : '—') : esc(a.expiresAt > now ? fmtUntil(a.expiresAt, now) : `${fmtTime(a.expiresAt)}（已过期）`);
  const action = `/mcp/oauth/%s/${uri(a.serverId)}`;
  return `<section class="sheet pad flush"><h2>${esc(a.serverId)} ${accountStamp(a, now)}</h2>
${kv([['账号', `${esc(a.accountId)} <small class="mono">revision ${esc(a.revision)}</small>`],
    ['授权服务器', a.issuer ? `<span class="mono" title="${esc(a.issuer)}">${esc(host(a.issuer))}</span>` : faint('—')],
    ['access token 到期', expires],
    ['scope', a.scope ? `<span class="mono">${esc(a.scope)}</span>` : faint('—')],
    ['refresh token', a.hasRefresh ? '有' : '无'],
    ['最近错误', a.lastError ? `${esc(errorText(a.lastError))} <small class="mono">${esc(a.lastError)}</small>${a.lastErrorAt ? ` <small>${esc(fmtWhen(a.lastErrorAt, now))}</small>` : ''}` : faint('无')]], 'meta')}
<div class="ops mt"><form method="post" action="${action.replace('%s', 'start')}">${csrfField(csrf)}<button>${a.loggedIn ? '重新登录' : '登录'}</button></form>${a.loggedIn || a.hasRefresh
    ? `<form method="post" action="${action.replace('%s', 'logout')}" data-confirm="${esc(`退出 ${a.serverId}？会尽力撤销并删除本地 token，之后需重新登录。`)}">${csrfField(csrf)}<button class="danger">退出</button></form>` : ''}</div></section>`;
}

/** ?ok=login&server=<id> / ?ok=logout / ?error=<code> → 一条 flash。 */
function flash(q: URLSearchParams): string {
  const ok = q.get('ok'), error = q.get('error');
  if (error) return `<div class="flash err" role="alert">登录未完成：${esc(errorText(error))}</div>`;
  if (ok === 'login') return `<div class="flash" role="status">${esc(`服务 ${q.get('server') ?? ''} 已有有效授权，无需重新登录。`)}</div>`;
  if (ok === 'logout') return '<div class="flash" role="status">已退出并删除本地 token。</div>';
  return '';
}

export const mcpAccountsLead = (redirectUrl?: string) => '登录只能在面板发起（聊天与模型工具不提供入口），token 保存在数据目录的 mcp-oauth.sqlite；修改服务配置里账号的 revision 需重新登录。'
  + (redirectUrl ? ` 回调地址 <span class="mono">${esc(redirectUrl)}</span>，须与公开的客户端元数据一致。` : '');

/** r 为 /api/mcp/accounts 的结果；503 表示没有配置 OAuth 服务，其余非 200 为读取失败。 */
export function mcpAccountsBody(r: { status: number; body: unknown; error?: string }, q: URLSearchParams, csrf: string, now = Date.now()): string {
  // 面板不托管仓库文档，给出文档路径与章节名，不放会 404 的链接。
  if (r.status === 503) return empty('未启用外部账号：Pi MCP 配置里没有使用 OAuth 凭据（<span class="mono">credential.kind: "oauth"</span>）的服务。配置方法见仓库 <span class="mono">docs/PI-MCP.md</span>「OAuth 登录（CIMD）」。');
  if (r.status !== 200) return `<div class="flash err" role="alert">读取外部账号失败：${esc(r.error ?? `HTTP ${r.status}`)}</div>`;
  const v = r.body as McpAccountsView;
  return flash(q) + (v.accounts.length ? v.accounts.map(a => accountCard(a, csrf, now)).join('') : empty('没有配置 OAuth 服务。'));
}
