import { ADMIN_PAGE_SIZE } from "./pagination";
import { PAGINATION_APP_JS } from "./pagination-ui";
import { MCP_ADMIN_HTML, MCP_ADMIN_APP_JS } from "./mcp-ui";
import { MCP_SERVERS_HTML, MCP_SERVERS_JS } from "./mcp-servers-ui";
import { WORKSPACE_CSS, WORKSPACE_HTML, WORKSPACE_APP_JS } from "./workspace-ui";
import { ACCESS_HTML, ACCESS_APP_JS } from "./access-ui";
import { MEMORY_MANAGER_HTML, MEMORY_MANAGER_JS } from "./memory-ui";
import { SESSION_HTML, SESSION_APP_JS } from "./sessions";
import { CONSOLE_CSS, CONSOLE_NAV, CONSOLE_HTML, CONSOLE_APP_JS } from "./console";
// 页面与脚本分开发送：脚本走 script-src 'self'，CSP 不必放开内联脚本。两者都不含数据，数据只经带 Bearer 的接口取得。
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>cs-agent 管理台</title>
<style>
*{box-sizing:border-box}
[hidden]{display:none !important}
body{margin:0;background:#F4F5F7;color:#16181D;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:14px;line-height:1.5}
a{color:#2457D6}a:hover{color:#163A99}
.card{background:#FFFFFF;border:1px solid #E3E6EB;border-radius:10px}
.h2{margin:0;font-size:17px;font-weight:600}
.muted{color:#5B6472}
.small{font-size:12px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.grow{flex:1}
table{border-collapse:collapse;width:100%}
th{text-align:left;font-weight:500;color:#5B6472;font-size:12px;padding:8px 12px;border-bottom:1px solid #E3E6EB;white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid #EEF0F3;vertical-align:top}
tr:last-child td{border-bottom:0}
.wide{min-width:680px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.ok{background:#DFF3E6;color:#13622F}
.warn{background:#FCEBCB;color:#7A4B00}
.bad{background:#FADADA;color:#8C1D1D}
.neutral{background:#E9ECF1;color:#3B4452}
.btn{appearance:none;border:1px solid #CBD1DA;background:#FFFFFF;color:#16181D;border-radius:8px;padding:8px 14px;font-size:13px;min-height:36px;cursor:pointer}
.btn.primary{background:#2457D6;border-color:#2457D6;color:#FFFFFF}
.btn.danger{color:#8C1D1D;border-color:#E6B8B8}
.btn.compact{min-height:28px;padding:2px 10px}
.btn:disabled{opacity:.5;cursor:default}
.chip{appearance:none;border:1px solid #CBD1DA;background:#FFFFFF;border-radius:999px;padding:6px 12px;font-size:13px;min-height:36px;cursor:pointer}
.chip.on{background:#16181D;color:#FFFFFF;border-color:#16181D}
input[type=text],input[type=url],input[type=search],input[type=password],input[type=number],input[type=time],select,textarea{border:1px solid #CBD1DA;border-radius:8px;padding:8px 10px;font-size:13px;min-height:36px;background:#FFFFFF;color:#16181D;font-family:inherit;max-width:100%}
textarea{width:100%;min-height:160px;resize:vertical;line-height:1.5}
label{font-size:12px;color:#5B6472}
.topbar{background:#FFFFFF;border-bottom:1px solid #E3E6EB}
.topbar-inner{max-width:1200px;margin:0 auto;padding:14px 24px;display:flex;flex-wrap:wrap;align-items:center;gap:16px}
.brand{font-size:18px;font-weight:600}
.status-line{max-width:1200px;margin:12px auto 0;padding:8px 14px;border-radius:8px;font-size:13px}
.status-line.error{background:#FADADA;color:#8C1D1D}
.status-line.info{background:#DFF3E6;color:#13622F}
main{max-width:1200px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:28px;width:100%}
.cards{display:flex;flex-wrap:wrap;gap:16px}
.cards>.card{flex:1 1 220px;min-width:0;padding:16px;display:flex;flex-direction:column;gap:6px}
.big{font-size:20px;font-weight:600;overflow-wrap:anywhere}
.section-head{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid #E3E6EB}
.scroll{overflow-x:auto}
.pager{padding:12px 20px;display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:center}
.pair{display:flex;flex-wrap:wrap;gap:16px}
.pair>.card{flex:1 1 420px;min-width:0}
.stack{padding:16px 20px;display:flex;flex-direction:column;gap:14px}
.field{display:flex;flex-direction:column;gap:6px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.note{font-size:12px;color:#5B6472;border-top:1px dashed #E3E6EB;padding-top:10px}
.link-box{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.link-box input{flex:1 1 240px}
.memory-body{display:flex;flex-wrap:wrap}
.memory-profile{flex:2 1 280px;min-width:0;padding:16px 20px;border-right:1px solid #E3E6EB;display:flex;flex-direction:column;gap:10px}
.memory-entries{flex:3 1 380px;min-width:0;overflow-x:auto}
.profile-text{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
.cell-text{overflow-wrap:anywhere;min-width:220px}
.cell-rule{overflow-wrap:anywhere;min-width:160px;max-width:280px}
.source{border:1px solid #E3E6EB;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:10px}
.source summary{cursor:pointer;font-size:13px;color:#2457D6}
.source .field{flex:1 1 150px;min-width:0}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.login-card{width:100%;max-width:360px;padding:24px;display:flex;flex-direction:column;gap:12px}
.login-card h1{margin:0 0 4px;font-size:18px}
@media (max-width:640px){
  main{padding:16px;gap:20px}
  .topbar-inner{padding:12px 16px;gap:10px}
  .status-line{margin:12px 16px 0}
  .memory-profile{border-right:0;border-bottom:1px solid #E3E6EB}
  .section-head{padding:14px 16px}
}
${CONSOLE_CSS}
${WORKSPACE_CSS}
</style>
</head>
<body>
<div id="login" class="login" hidden>
  <form id="login-form" class="card login-card" autocomplete="off">
    <h1>cs-agent 管理台</h1>
    <label for="login-token">管理口令（ADMIN_TOKEN）</label>
    <input id="login-token" type="password" autocomplete="current-password" required>
    <button class="btn primary" type="submit">进入</button>
    <div id="login-message" class="muted small"></div>
  </form>
</div>

<div id="app" hidden>
${CONSOLE_NAV}
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">cs-agent 管理台</div>
    <div id="commit" class="mono muted"></div>
    <span id="health" class="pill neutral">加载中</span>
    <div class="grow"></div>
    <div id="refreshed" class="muted small"></div>
    <button id="logout" class="btn" type="button">登出</button>
  </div>
</header>
<div id="status" class="status-line" role="status" hidden></div>

<main>
${CONSOLE_HTML}
<div id="view-manage" hidden>
<div class="console-head"><div><h1>配置与管理</h1><p>管理模型、连接、记忆与自动任务。</p></div></div>
  <section class="cards">
    <div class="card"><div class="muted small">NapCat</div><div id="card-napcat" class="big">-</div><div id="card-napcat-sub" class="muted small"></div></div>
    <div class="card"><div class="muted small">模型</div><div id="card-model" class="big">-</div><div id="card-model-sub" class="muted small"></div></div>
    <div class="card"><div class="muted small">会话</div><div id="card-threads" class="big">-</div><div id="card-threads-sub" class="muted small"></div><div id="card-threads-extra" class="muted small"></div></div>
    <div class="card"><div class="muted small">发送规则</div><div id="card-rules" class="big">-</div><div id="card-rules-list" class="small"></div></div>
  </section>

  <section class="card">
    <div class="section-head"><h2 class="h2">会话</h2><span class="muted">每个会话键一个 Thread DO</span></div>
    <div class="scroll">
      <table class="wide">
        <thead><tr><th>线程</th><th>状态</th><th>入站 排队 / 完成 / 失败</th><th>出站</th><th>记忆</th><th>子 agent</th><th>最近发送</th><th></th></tr></thead>
        <tbody id="threads"></tbody>
      </table>
    </div>
  </section>

  <section class="card" id="events-section">
    <div class="section-head">
      <h2 class="h2">审计事件</h2>
      <span class="muted">只记元数据，不含正文</span>
      <div class="grow"></div>
      <div id="event-kinds" class="row"></div>
      <label for="ev-thread">线程</label>
      <select id="ev-thread"></select>
    </div>
    <div class="scroll">
      <table class="wide">
        <thead><tr><th>时间</th><th>线程</th><th>类型</th><th>详情</th><th>结果</th></tr></thead>
        <tbody id="events"></tbody>
      </table>
    </div>
    <div class="pager">
      <span id="events-meta" class="muted small"></span>
      <div class="row"><button id="ev-prev" class="btn" type="button">上一页</button><button id="ev-next" class="btn" type="button">下一页</button></div>
    </div>
  </section>

  <section class="card" id="model-section">
    <div class="section-head"><h2 class="h2">模型</h2><span class="muted">存在 Registry 设置里，切换后各会话下一回合生效，不用重新部署</span></div>
    <div class="pair" style="gap:0">
      <div class="stack" style="flex:1 1 420px;min-width:0">
        <div class="row"><span class="muted small">当前</span><span id="m-current" class="mono">-</span></div>
        <div class="field">
          <label for="m-model">模型</label>
          <select id="m-model"></select>
        </div>
        <div class="field">
          <label for="m-effort">推理强度</label>
          <select id="m-effort">
            <option value="">模型默认</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        </div>
        <div class="row"><button id="m-save" class="btn primary" type="button">切换</button><span id="m-meta" class="muted small"></span></div>
      </div>
      <div class="stack" style="flex:1 1 420px;min-width:0">
        <div class="row"><strong>Codex 原生登录</strong><span id="codex-status" class="pill neutral">-</span></div>
        <div id="codex-account" class="muted small"></div>
        <select id="codex-accounts" aria-label="ChatGPT 账号"></select>
        <div class="row">
          <button id="codex-select" class="btn" type="button">使用所选账号</button>
          <button id="codex-start" class="btn primary" type="button">授权所选账号</button>
          <button id="codex-logout" class="btn danger" type="button" hidden>登出当前账号</button>
          <button id="codex-refresh" class="btn" type="button">刷新状态</button>
          <button id="codex-catalog" class="btn" type="button">刷新模型列表</button>
        </div>
        <div id="codex-pending" class="stack" style="padding:0" hidden>
          <div class="muted small">1. 下载授权助手，在下载目录打开终端并运行下方命令（需要 Node.js 24 或更新版本）。</div>
          <a class="btn" href="/admin/model/oauth/codex/helper.mjs" download="chatgpt-login.mjs">下载授权助手</a>
          <input id="codex-command" type="text" readonly aria-label="运行命令">
          <div class="muted small">2. 向助手粘贴配对码，在自动打开的 ChatGPT 页面授权。配对码 10 分钟内有效，仅用于这一次授权。</div>
          <div class="link-box">
            <input id="codex-ticket" type="text" readonly aria-label="配对码">
            <button id="codex-copy" class="btn" type="button">复制配对码</button>
          </div>
          <div class="muted small">3. 助手完成后自动退出，点击“刷新状态”。</div>
        </div>
        <div class="note">凭据加密保存在云端，到期自动续期；DeepSeek 和 GPT 共用此账号的生图能力。本机助手仅授权时运行，需要端口 1455 空闲。旧授权会保留，完成新登录后切换。<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">查看 ChatGPT 用量与授权额度</a></div>
      </div>
    </div>
  </section>

  <section class="pair">
    <div class="card">
      <div class="section-head"><h2 class="h2">MCP 服务</h2><span class="muted">运行时接入，无需重新部署</span></div>
      <div class="stack">
        <div id="mcp-list" class="stack" style="padding:0"></div>
        ${MCP_SERVERS_HTML}
        <div id="mcp-link" class="link-box" hidden>
          <input id="mcp-link-url" type="text" readonly aria-label="一次性登录链接">
          <button id="mcp-link-copy" class="btn" type="button">复制</button>
        </div>
        <div class="note">登录链接 10 分钟内有效、只能打开一次，请私下交给 owner；页面只显示结果分类，不回显 token。</div>
      </div>
    </div>

    <div class="card">
      <div class="section-head"><h2 class="h2">设置</h2><span class="muted">存在 Registry DO，保存后立即推送到 Bridge</span></div>
      <div class="stack">
        <div class="field">
          <label for="s-trigger">群里触发方式</label>
          <select id="s-trigger">
            <option value="mention_or_reply">@机器人 或 回复它</option>
            <option value="mention_only">只 @机器人</option>
            <option value="off">群里不响应</option>
          </select>
        </div>
        <div class="field"><label for="s-groups">允许的群（逗号分隔）</label><input id="s-groups" type="text" inputmode="numeric"></div>
        <div class="field"><label for="s-users">允许私聊的用户（逗号分隔）</label><input id="s-users" type="text" inputmode="numeric"></div>
        <div class="field"><label for="s-extract">开启回合后记忆抽取的命名空间</label><input id="s-extract" type="text"></div>
        <div id="s-defaults" class="muted small"></div>
        <div class="row"><button id="s-save" class="btn primary" type="button">保存</button><span id="s-meta" class="muted small"></span></div>
        <div id="s-secrets" class="note"></div>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="section-head"><h2 class="h2">定时任务</h2><span class="muted">存在 ScheduleDO，时间均为北京时间；连续失败 3 次自动暂停</span></div>
    <div class="scroll">
      <table class="wide">
        <thead><tr><th>名称</th><th>会话</th><th>规则</th><th>状态</th><th>下次触发</th><th>连续失败</th><th>最近运行</th><th></th></tr></thead>
        <tbody id="schedules"></tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <div class="section-head"><h2 class="h2">事件来源</h2><span class="muted">新事件经过滤、合并窗口、安静时段与每小时预算后投给 owner 线程；时间均为北京时间</span></div>
    <div id="sources" class="stack"></div>
  </section>

  <section class="card">
    <div class="section-head">
      <h2 id="mem-title" class="h2">记忆</h2>
      <span id="mem-meta" class="muted"></span>
      <div class="grow"></div>
      <label for="mem-ns">命名空间</label>
      <select id="mem-ns"></select>
      <label for="mem-q">搜索</label>
      <input id="mem-q" type="search" placeholder="关键词或 #id" style="width:220px">
    </div>
    <div class="memory-body">
      <div class="memory-profile">
        <div class="row"><strong>画像</strong><span id="profile-meta" class="muted small"></span></div>
        <div id="profile-text" class="profile-text muted"></div>
        <textarea id="profile-edit" hidden aria-label="编辑画像"></textarea>
        <div class="row">
          <button id="profile-toggle" class="btn" type="button">编辑画像</button>
          <button id="profile-save" class="btn primary" type="button" hidden>保存画像</button>
        </div>
      </div>
      <div class="memory-entries">
        <table>
          <thead><tr><th>#</th><th>类型</th><th>内容</th><th>来源</th><th></th></tr></thead>
          <tbody id="memories"></tbody>
        </table>
      </div>
    </div>
  </section>

  ${MEMORY_MANAGER_HTML}
  <section class="card" id="skills-section">
    <div class="section-head"><h2 class="h2">技能</h2><span class="muted">存在 Registry；启用的技能只以名称与描述进入各会话提示，模型用 read_skill 读正文，改动最迟 60 秒后生效</span></div>
    <div class="scroll">
      <table class="wide">
        <thead><tr><th>名称</th><th>描述</th><th>附件</th><th>状态</th><th></th></tr></thead>
        <tbody id="skills"></tbody>
      </table>
    </div>
    <div class="stack">
      <div class="field">
        <label for="skill-md">SKILL.md（开头的 frontmatter 需要 name 与 description）</label>
        <textarea id="skill-md" class="mono" spellcheck="false"></textarea>
      </div>
      <div class="row">
        <button id="skill-save" class="btn primary" type="button">保存技能</button>
        <button id="skill-new" class="btn" type="button">清空</button>
        <span id="skill-meta" class="muted small"></span>
      </div>
      <div class="note">保存按 frontmatter 的 name 新建或覆盖；覆盖时保留启用状态与已有附件。附件暂无页面入口，经 PUT /admin/skills/:name 的 files 上传。</div>
    </div>
  </section>
${ACCESS_HTML}
${WORKSPACE_HTML}
${MCP_ADMIN_HTML}
</div>
${SESSION_HTML}
</main>
</div>
<script src="/admin/app.js" defer></script>
</body>
</html>
`;

export const ADMIN_APP_JS = String.raw`"use strict";
(() => {
  const ADMIN_PAGE_SIZE = ${ADMIN_PAGE_SIZE};
  ${PAGINATION_APP_JS}
  const TOKEN_KEY = "cs-agent-admin-token";
  const EVENT_KINDS = ["", "mcp_call", "mcp_catalog", "mcp_management", "memory_extract", "memory_write"];
  const MORE_KINDS = ["web_search", "generate_image", "coding_exec", "coding_read", "coding_write", "coding_edit"];
  const LOGIN = { ok: ["已登录", "ok"], needed: ["需要登录", "warn"], error: ["凭据错误", "bad"], unconfigured: ["未配置", "neutral"] };
  const CREDENTIAL = { oauth: "OAuth（CIMD）", static: "静态凭据", none: "无凭据" };
  const ERRORS = {
    busy: "会话正在运行或压缩，请先停止或等待完成后重试",
    invalid_cursor: "历史分页标记已失效，请重新打开历史",
    conflict: "数据已被别处修改，已载入最新值，请确认后再保存",
    invalid_request: "请求格式不正确",
    invalid_json: "请求格式不正确",
    invalid_namespace: "命名空间只能是 owner 或 group:群号",
    invalid_query: "查询参数不正确",
    not_found: "目标不存在",
    unavailable: "服务暂不可用",
    unconfigured: "未配置 OAUTH_STORE_KEY，不能登录",
    server_unavailable: "该服务未启用或不支持此操作",
    internal: "服务内部错误",
    invalid_model: "该模型当前不可用",
    invalid_state: "登录已过期或与本次授权不匹配，请重新开始登录",
    missing_code: "回调地址里没有 code，请粘贴浏览器地址栏里的完整地址",
    authorization_denied: "ChatGPT 授权被拒绝",
    invalid_callback: "回调地址格式不正确",
    token_exchange: "刷新或换取凭据失败，请查看诊断信息",
    invalid_identity: "账号身份校验失败，请重新授权所选账号",
    plan_permission_required: "尚未允许使用 ChatGPT 订阅额度，请重新授权并开启该权限",
    catalog_failed: "读取账号模型列表失败，请稍后重试",
    invalid_name: "技能名只能用小写字母、数字和连字符，以字母或数字开头，最长 64 位",
    missing_frontmatter: "SKILL.md 开头缺少以 --- 包围的 frontmatter",
    name_mismatch: "frontmatter 的 name 与技能名不一致",
    missing_description: "frontmatter 缺少 description",
    description_too_long: "description 超过 500 字",
    skill_too_large: "SKILL.md 超过 256 KiB",
    invalid_path: "附件路径不合法",
    invalid_file: "附件只能是文本",
    file_too_large: "单个附件超过 64 KiB",
    files_too_large: "附件合计超过 512 KiB",
    invalid_settings: "设置不合法：轮询间隔 30～3600 秒、合并窗口 0～600 秒、预算每小时 1～100 次，均为整数；标签不能重复；安静时段写 HH:MM，起止都填或都留空",
  };
  const CODEX_STATUS = { logged_out: "未登录", ready: "凭据有效", refresh_due: "到期待刷新", refresh_failed: "刷新失败", reauth_required: "需要重新授权" };
  function refreshDiagnostic(failure) {
    if (!failure) return "";
    return [failure.kind, failure.status ? "HTTP " + failure.status : "", failure.oauthCode,
      failure.challenge ? "Cloudflare challenge" : "", failure.format, failure.requestId ? "request " + failure.requestId : "",
      failure.cfRay ? "ray " + failure.cfRay : ""].filter(Boolean).join(" · ");
  }
  const MODEL_REASONS = { missing_key: "缺 DEEPSEEK_API_KEY", login_required: "未登录 ChatGPT", unconfigured: "未配置 OAUTH_STORE_KEY",
    unknown_provider: "provider 未注册", unknown_model: "目录里没有这个模型", unavailable: "不可用" };
  const state = { overview: null, settings: null, model: null, eventKind: "", eventThread: "owner", before: undefined, history: [], next: undefined,
    memoryNs: "owner", memoryQuery: "", memoryView: null, profile: null, armedDelete: null, skills: [], armedSkill: null, timer: null, noticeTimer: null,
    subagents: {}, schedules: [], armedSchedule: null, sources: null, editingSource: null, sourceForms: {} };

  const $ = id => document.getElementById(id);
  const readToken = () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
  const writeToken = value => { try { if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY); } catch {} };

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = String(value);
      else if (key === "className") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children || []) if (child !== null && child !== undefined) node.append(child);
    return node;
  }
  const clear = node => node.replaceChildren();
  const pill = (text, tone) => el("span", { className: "pill " + tone, text });
  const pad = n => String(n).padStart(2, "0");
  function time(ms) {
    if (!ms) return "-";
    const d = new Date(ms), now = new Date();
    const clock = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    return d.toDateString() === now.toDateString() ? clock : pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + clock.slice(0, 5);
  }
  const bytes = n => typeof n !== "number" ? "-" : n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
  // 定时与事件都按北京时间计算，这里不跟浏览器时区走。
  const BEIJING = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function bjTime(ms) {
    if (!ms) return "-";
    const p = {};
    for (const part of BEIJING.formatToParts(ms)) p[part.type] = part.value;
    return p.month + "-" + p.day + " " + p.hour + ":" + p.minute;
  }
  const duration = ms => typeof ms !== "number" ? "-" : ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s";

  class ApiError extends Error {
    constructor(status, body) { super("api " + status); this.status = status; this.body = body; }
  }
  async function api(method, path, body) {
    const token = readToken();
    if (!token) { showLogin(""); throw new ApiError(401, null); }
    const headers = { Authorization: "Bearer " + token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    if (response.status === 401) { writeToken(null); showLogin("口令无效或已失效，请重新输入"); throw new ApiError(401, null); }
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: raw.slice(0, 60) }; }
    if (!response.ok) throw new ApiError(response.status, data);
    return data;
  }
  function describe(error) {
    if (error instanceof ApiError) {
      const code = error.body && error.body.error;
      const reason = error.body && error.body.reason;
      const diagnostic = refreshDiagnostic(error.body && error.body.diagnostic);
      return (ERRORS[code] || ("请求失败（" + error.status + (code ? " " + code : "") + "）")) + (reason ? "：" + (MODEL_REASONS[reason] || reason) : "") + (diagnostic ? "：" + diagnostic : "");
    }
    return "网络错误，请稍后再试";
  }
  function show(message, tone) {
    const line = $("status");
    line.textContent = message;
    line.className = "status-line " + tone;
    line.hidden = false;
    clearTimeout(state.noticeTimer);
    if (tone === "info") state.noticeTimer = setTimeout(() => { line.hidden = true; }, 6000);
  }
  const fail = error => { if (!(error instanceof ApiError && error.status === 401)) show(describe(error), "error"); };
  const notice = message => show(message, "info");

  function showLogin(message) {
    resetConsole();
    clearInterval(state.timer);
    state.timer = null;
    $("app").hidden = true;
    $("login").hidden = false;
    $("login-message").textContent = message;
    $("login-token").value = "";
    $("login-token").focus();
  }
  function start() {
    $("login").hidden = true;
    $("app").hidden = false;
    $("status").hidden = true;
    startConsole();
    loadOverview().catch(fail);
    clearInterval(state.timer);
    state.timer = null;
  }
  function refresh() {
    return Promise.all([loadOverview(), loadManagement(cs.view)]).then(() => {
      $("refreshed").textContent = "刷新于 " + time(Date.now());
    }).catch(fail);
  }

  async function loadOverview() {
    const overview = await api("GET", "/admin/overview");
    state.overview = overview;
    renderOverview(overview);
    renderConsoleThreads();
    if(cs.view==="memory")await Promise.all(Object.keys(state.subagents).map(loadSubagents));
  }
  function renderOverview(o) {
    $("commit").textContent = location.host + " · " + o.commit;
    const healthy = !("unavailable" in o.model);
    const health = $("health");
    health.textContent = healthy ? "Worker 正常" : "Worker 异常";
    health.className = "pill " + (healthy ? "ok" : "bad");

    $("card-napcat").textContent = o.bridge.connected ? "已连接" : "未连接";
    $("card-napcat-sub").textContent = "反向 WebSocket" + (o.bridge.selfId ? " · 机器人 " + o.bridge.selfId : "") + " · 忽略 " + o.bridge.ignored;
    $("card-model").textContent = healthy ? o.model.id : "不可用";
    $("card-model-sub").textContent = healthy ? "provider " + o.model.provider + (o.model.reasoningEffort ? " · 推理 " + o.model.reasoningEffort : "") : o.model.unavailable;
    const totals = { queued: 0, done: 0, failed: 0 };
    for (const thread of o.threads) if (thread.stats.inbound) for (const key of Object.keys(totals)) totals[key] += thread.stats.inbound[key];
    $("card-threads").textContent = o.threads.length + " 个线程";
    $("card-threads-sub").textContent = "处理中 " + totals.queued + " · 完成 " + totals.done + " · 失败 " + totals.failed;
    const schedule = "error" in o.schedule ? "定时 不可用" : "定时 " + o.schedule.active + " 个" + (o.schedule.paused ? "（暂停 " + o.schedule.paused + "）" : "");
    $("card-threads-extra").textContent = schedule + " · 事件积压 " + ("error" in o.events ? "不可用" : o.events.held);
    renderRules(o.sendRules);
    renderThreads(o.threads);
    renderMcp(o.mcp);
    renderSecrets(o.configured);
    fillSelect($("ev-thread"), o.threads.map(t => t.key), state.eventThread);
    fillSelect($("mem-ns"), o.threads.filter(t => t.kind !== "private").map(t => t.key), state.memoryNs);
  }
  function fillSelect(select, keys, current) {
    const options = Array.from(new Set(["owner", current].concat(keys)));
    clear(select);
    for (const key of options) select.append(el("option", { value: key, text: key }));
    select.value = current;
  }
  function renderRules(rules) {
    $("card-rules").textContent = rules.length ? rules.length + " 个熔断" : "无熔断";
    const list = $("card-rules-list");
    clear(list);
    if (!rules.length) { list.append(el("span", { className: "muted", text: "每会话 6 条/分 · 60 条/时，全局 30 条/分" })); paginateChildren(list); return; }
    for (const rule of rules) {
      list.append(el("div", { className: "row" }, [
        el("span", { className: "mono", text: (rule.scope === "global" ? "全部会话" : rule.scope) + " · 至 " + time(rule.until) }),
        el("button", { className: "btn compact", type: "button", text: "解除", onclick: () => release(rule.scope) }),
      ]));
    }
    paginateChildren(list);
  }
  const SANDBOX_TEXT = { running: "运行中", stopped: "已停", unavailable: "不可用" };
  function renderThreads(threads) {
    const body = $("threads");
    clear(body);
    if (!threads.length) { body.append(el("tr", {}, [el("td", { colspan: 8, className: "muted", text: "还没有会话" })])); paginateChildren(body,{attachedRows:true}); return; }
    for (const thread of threads) {
      const s = thread.stats, broken = "error" in s;
      const busy = !broken && s.inbound.queued > 0;
      body.append(el("tr", {}, [
        el("td", {}, [el("span", { className: "mono", text: thread.key }), thread.name ? el("div", { className: "muted small", text: thread.name }) : null]),
        el("td", {}, [broken ? pill("不可用", "bad") : busy ? pill("处理中", "warn") : pill("空闲", "ok"),
          thread.sandbox ? el("div", { className: "muted small", text: "沙箱：" + SANDBOX_TEXT[thread.sandbox] }) : null]),
        el("td", { className: "mono", text: broken ? "-" : s.inbound.queued + " / " + s.inbound.done + " / " + s.inbound.failed }),
        el("td", { className: "mono", text: broken ? "-" : s.outbox }),
        el("td", { className: "mono", text: broken ? "-" : s.memory.active + " 条 · 画像 " + bytes(s.memory.profileBytes) }),
        el("td", {}, broken || !s.subagents ? ["-"] : [
          el("button", { className: "btn compact", type: "button", text: s.subagents.running + " 个运行中" + (state.subagents[thread.key] ? " ▲" : " ▼"),
            onclick: () => toggleSubagents(thread.key) }),
        ]),
        el("td", { className: "mono", text: broken ? "-" : time(s.lastSentAt) }),
        el("td", {}, [
          el("button", { className: "btn compact", type: "button", text: "事件", onclick: () => { state.eventThread=thread.key;$("ev-thread").value=thread.key;state.before=undefined;state.history=[];consoleView("operations");$("events-section").scrollIntoView(); } }),
          busy ? el("button", { className: "btn compact danger", type: "button", text: "停止", onclick: () => stop(thread.key) }) : null,
          thread.sandbox === "running" ? el("button", { className: "btn compact danger", type: "button", text: "重置沙箱", onclick: () => resetSandbox(thread.key) }) : null,
        ]),
      ]));
      const open = state.subagents[thread.key];
      if (open) body.append(el("tr", {}, [el("td", { colspan: 8 }, [renderSubagents(thread.key, open.list)])]));
    }
    paginateChildren(body,{attachedRows:true});
  }

  const SUBAGENT_STATUS = { running: ["运行中", "warn"], done: ["已完成", "ok"], failed: ["失败", "bad"], cancelled: ["已取消", "neutral"], timeout: ["已超时", "bad"] };
  function renderSubagents(key, list) {
    if (!list) return el("span", { className: "muted", text: "加载中…" });
    if (!list.length) return el("span", { className: "muted", text: "这个会话没有派出过子 agent" });
    const rows = list.map(sub => {
      const status = SUBAGENT_STATUS[sub.status] || [sub.status, "neutral"];
      return el("tr", {}, [
        el("td", { className: "mono", text: sub.id.slice(0, 8) }),
        el("td", { text: sub.task }),
        el("td", {}, [pill(status[0], status[1])]),
        el("td", { className: "mono", text: time(sub.createdAt) }),
        el("td", { className: "mono", text: sub.status === "running" ? (sub.deadline ? "限时至 " + time(sub.deadline) : "不设自动超时") : time(sub.endedAt) }),
        el("td", { className: "mono", text: time(sub.lastReportAt) }),
        el("td", { className: "muted small", text: sub.spawner || "无法确证" }),
        el("td", {}, [sub.status === "running" ? el("button", { className: "btn compact danger", type: "button", text: "取消", onclick: () => cancelSubagent(key, sub.id) }) : null]),
      ]);
    });
    const table=el("table", { className: "wide" }, [
      el("thead", {}, [el("tr", {}, ["id", "任务", "状态", "派出", "结束", "最近汇报", "派出者", ""].map(text => el("th", { text })))]),
      el("tbody", {}, rows),
    ]);
    const box=el("div",{},[table]);paginateChildren(table.querySelector("tbody"),{key:"subagents:"+key});return box;
  }
  async function loadSubagents(key) {
    const list = await api("GET", "/admin/threads/" + encodeURIComponent(key) + "/subagents");
    if (state.subagents[key]) state.subagents[key].list = list;
    if (state.overview) renderThreads(state.overview.threads);
  }
  function toggleSubagents(key) {
    if (state.subagents[key]) delete state.subagents[key];
    else { state.subagents[key] = { list: null }; loadSubagents(key).catch(fail); }
    if (state.overview) renderThreads(state.overview.threads);
  }
  async function cancelSubagent(key, id) {
    try {
      const result = await api("POST", "/admin/subagents/" + encodeURIComponent(id) + "/cancel?thread=" + encodeURIComponent(key));
      notice("子 agent " + id.slice(0, 8) + "：" + (SUBAGENT_STATUS[result.status] || [result.status])[0]);
    } catch (error) { fail(error); }
    refresh();
  }

  const EVENT_FORMAT = {
    mcp_management: d => ({ parts: [d.server, d.action, d.source], result: "ok" }),
    mcp_call: d => ({ parts: [d.server, d.tool, duration(d.ms), "入 " + bytes(d.inputBytes) + " / 出 " + bytes(d.outputBytes)], result: d.result }),
    mcp_catalog: d => ({ parts: [d.server, typeof d.tools === "number" ? d.tools + " 个工具" : null, typeof d.rejected === "number" ? "拒绝 " + d.rejected : null,
      typeof d.digest === "string" ? "摘要 " + d.digest.slice(0, 8) : null, d.code], result: d.status }),
    web_search: d => ({ parts: [typeof d.results === "number" ? d.results + " 条结果" : null, duration(d.ms)], result: d.result }),
    generate_image: d => ({ parts: [duration(d.ms)], result: d.result }),
    coding_exec: d => ({ parts: ["命令 " + d.commandLength + " 字", d.code === undefined || d.code === null ? null : "退出码 " + d.code, duration(d.ms)], result: d.result }),
    coding_read: d => ({ parts: [duration(d.ms)], result: d.result }),
    coding_write: d => ({ parts: [duration(d.ms)], result: d.result }),
    coding_edit: d => ({ parts: [duration(d.ms)], result: d.result }),
    memory_extract: d => ({ parts: ["候选 " + d.candidates, "写入 " + d.written, d.reason, d.usage && d.usage.totalTokens ? "用量 " + d.usage.totalTokens + " tok" : null, duration(d.ms)], result: d.status }),
  };
  const RESULT_TONE = { ok: "ok", skipped: "neutral" };
  function renderEvents(events) {
    const body = $("events");
    clear(body);
    if (!events.length) { body.append(el("tr", {}, [el("td", { colspan: 5, className: "muted", text: "没有事件" })])); return; }
    for (const event of events) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      const format = EVENT_FORMAT[event.kind];
      const view = format ? format(detail) : { parts: [JSON.stringify(event.detail).slice(0, 160)], result: "" };
      const parts = view.parts.filter(part => part !== null && part !== undefined && part !== "").map(String);
      const result = typeof view.result === "string" ? view.result : "";
      body.append(el("tr", {}, [
        el("td", { className: "mono", text: time(event.at) }),
        el("td", { className: "mono", text: state.eventThread }),
        el("td", {}, [pill(event.kind, "neutral")]),
        el("td", { className: "mono cell-text", text: parts.join(" · ") }),
        el("td", {}, [result ? pill(result, RESULT_TONE[result] || "bad") : null]),
      ]));
    }
  }
  async function loadEvents() {
    let path = "/admin/events?limit=" + ADMIN_PAGE_SIZE + "&thread=" + encodeURIComponent(state.eventThread);
    if (state.eventKind) path += "&kind=" + encodeURIComponent(state.eventKind);
    if (state.before !== undefined) path += "&before=" + state.before;
    const page = await api("GET", path);
    state.next = page.next;
    renderEvents(page.events);
    $("ev-prev").disabled = state.history.length === 0;
    $("ev-next").disabled = page.next === undefined;
    $("events-meta").textContent = "第 " + (state.history.length + 1) + " 页 · 每页 " + ADMIN_PAGE_SIZE + " 条";
  }
  function resetEvents() { state.before = undefined; state.history = []; return loadEvents().catch(fail); }
  function selectThread(key) { state.eventThread = key; $("ev-thread").value = key; resetEvents(); }
  function renderKinds() {
    const box = $("event-kinds");
    clear(box);
    for (const kind of EVENT_KINDS) {
      box.append(el("button", { className: "chip" + (kind === state.eventKind ? " on" : ""), type: "button", text: kind || "全部",
        onclick: () => { state.eventKind = kind; renderKinds(); resetEvents(); } }));
    }
    const more = el("select", { "aria-label": "更多类型", onchange: event => { state.eventKind = event.target.value; renderKinds(); resetEvents(); } },
      [el("option", { value: "", text: "更多…" })].concat(MORE_KINDS.map(kind => el("option", { value: kind, text: kind }))));
    more.value = MORE_KINDS.includes(state.eventKind) ? state.eventKind : "";
    box.append(more);
  }

  const SCHEDULE_STATUS = { active: ["启用", "ok"], paused: ["已暂停", "warn"], completed: ["已结束", "neutral"] };
  const PAUSE_REASON = { manual: "手动暂停", failures: "连续失败自动暂停", error: "规则出错" };
  const RUN_STATUS = { queued: ["排队", "warn"], running: ["执行中", "warn"], sent: ["已发送", "ok"], silent: ["没发消息", "neutral"], failed: ["失败", "bad"], skipped: ["跳过", "neutral"] };
  const RUN_REASON = { stale: "错过触发", overlap: "上一轮未完", interrupted: "输入丢失", backend_failed: "投递失败", timeout: "超时" };
  async function loadSchedules() {
    renderSchedules(await api("GET", "/admin/schedules"));
  }
  function renderSchedules(list) {
    state.schedules = list;
    const body = $("schedules");
    clear(body);
    if (!list.length) { body.append(el("tr", {}, [el("td", { colspan: 8, className: "muted", text: "还没有定时任务，在 QQ 里让它“每天 8 点提醒我…”即可创建" })])); paginateChildren(body); return; }
    for (const s of list) {
      const status = SCHEDULE_STATUS[s.status] || [s.status, "neutral"];
      const last = s.runs[s.runs.length - 1], run = last && (RUN_STATUS[last.status] || [last.status, "neutral"]);
      const armed = state.armedSchedule === s.id;
      const act = (action, text) => el("button", { className: "btn compact", type: "button", text,
        onclick: event => { event.target.disabled = true; scheduleAction(s.id, action); } });
      body.append(el("tr", {}, [
        el("td", { className: "cell-text", text: s.name }),
        el("td", { className: "mono", text: s.conversation }),
        el("td", { className: "mono cell-rule", text: s.rule.kind === "rrule" ? s.rule.rrule : "一次性" }),
        el("td", {}, [pill(status[0], status[1]), s.pause_reason ? el("div", { className: "muted small", text: PAUSE_REASON[s.pause_reason] || s.pause_reason }) : null]),
        el("td", { className: "mono", text: bjTime(s.next_fire_at) }),
        el("td", { className: "mono", text: s.failures }),
        el("td", {}, last ? [pill(run[0], run[1]), el("div", { className: "muted small mono",
          text: bjTime(last.ended_at || last.started_at || last.fire_at) + (last.reason ? " · " + (RUN_REASON[last.reason] || last.reason) : "") })] : ["-"]),
        el("td", {}, [
          s.status === "active" ? act("pause", "暂停") : s.status === "paused" ? act("resume", "恢复") : null,
          act("run-now", "立即运行"),
          el("button", { className: "btn compact danger", type: "button", text: armed ? "确认删除" : "删除", onclick: () => armed ? scheduleAction(s.id, "delete") : armSchedule(s.id) }),
        ]),
      ]));
    }
    paginateChildren(body);
  }
  function armSchedule(id) {
    state.armedSchedule = id;
    renderSchedules(state.schedules);
    setTimeout(() => { if (state.armedSchedule === id) { state.armedSchedule = null; renderSchedules(state.schedules); } }, 5000);
  }
  async function scheduleAction(id, action) {
    state.armedSchedule = null;
    try {
      const result = await api("POST", "/admin/schedules/" + encodeURIComponent(id) + "/" + action);
      notice(action === "delete" ? "已删除定时任务" : action === "run-now" ? "已触发一次：" + (RUN_STATUS[result.status] || [result.status])[0]
        : action === "pause" ? "已暂停「" + result.name + "」" : "已恢复「" + result.name + "」，下次 " + bjTime(result.next_fire_at));
    } catch (error) { fail(error); }
    refresh();
  }

  const SOURCE_PAUSE = { manual: "手动暂停", turn_failures: "连续 3 次事件回合失败" };
  const SOURCE_RUN = { queued: ["处理中", "warn"], sent: ["已发送", "ok"], silent: ["未打扰", "neutral"], failed: ["失败", "bad"] };
  async function loadSources() {
    renderSources(await api("GET", "/admin/event-sources"));
  }
  function renderSources(view) {
    state.sources = view;
    const box = $("sources");
    clear(box);
    if (!view.sources.length) { box.append(el("div", { className: "muted", text: "没有事件来源" })); paginateChildren(box); return; }
    for (const source of view.sources) box.append(renderSource(source, view));
    paginateChildren(box);
  }
  function renderSource(source, view) {
    const status = source.paused ? ["已暂停", "warn"] : source.degraded ? ["降级", "bad"] : ["正常", "ok"];
    const facts = ["游标 " + (source.cursor ? "已建立" : "无"), "上次轮询 " + bjTime(source.lastPollAt), "积压 " + source.held,
      "本小时预算 " + source.budget.used + " / " + source.budget.perHour];
    if (source.id === "gmail") facts.push("watch " + (!view.watch.topic ? "未配置推送" : view.watch.expiration ? "到期 " + bjTime(view.watch.expiration) : "未建立"));
    const problems = [source.paused ? SOURCE_PAUSE[source.pauseReason] || source.pauseReason : null, source.failures ? "连续拉取失败 " + source.failures + " 次" : null,
      source.lastErrorCode ? "最近错误 " + source.lastErrorCode : null].filter(Boolean);
    // 刷新只重画状态；正在编辑的设置表单原样搬回，不覆盖没保存的输入。
    const editing = state.editingSource === source.id && state.sourceForms[source.id];
    const form = editing || (state.sourceForms[source.id] = sourceForm(source));
    const runs = view.runs.filter(run => run.source === source.id);
    const card=el("div", { className: "source" }, [
      el("div", { className: "row" }, [
        el("strong", { className: "mono", text: source.id }), pill(status[0], status[1]), source.configured ? null : pill("未配置凭据", "neutral"),
        el("div", { className: "grow" }),
        el("button", { className: "btn compact", type: "button", text: source.paused ? "恢复" : "暂停", onclick: () => setSourcePaused(source.id, !source.paused) }),
      ]),
      el("div", { className: "muted small", text: facts.join(" · ") }),
      problems.length ? el("div", { className: "small", text: problems.join(" · ") }) : null,
      form,
      runs.length ? el("div", { className: "scroll" }, [el("table", {}, [
        el("thead", {}, [el("tr", {}, ["投递时间", "事件数", "状态", "结束"].map(text => el("th", { text })))]),
        el("tbody", {}, runs.map(run => {
          const tone = SOURCE_RUN[run.status] || [run.status, "neutral"];
          return el("tr", {}, [el("td", { className: "mono", text: bjTime(run.deliveredAt) }), el("td", { className: "mono", text: run.events }),
            el("td", {}, [pill(tone[0], tone[1])]), el("td", { className: "mono", text: bjTime(run.endedAt) })]);
        })),
      ])]) : el("div", { className: "muted small", text: "还没有投递记录" }),
    ]);
    const body=card.querySelector("tbody");if(body)paginateChildren(body,{key:"source-runs:"+source.id});return card;
  }
  function sourceForm(source) {
    const s = source.settings, quiet = s.quietHours || { start: "", end: "" };
    const input = (type, value) => el("input", { type, value, inputmode: type === "number" ? "numeric" : undefined });
    const fields = {
      intervalS: input("number", s.intervalS), mergeWindowS: input("number", s.mergeWindowS), budgetPerHour: input("number", s.budgetPerHour),
      requireLabels: input("text", s.filters.requireLabels.join(", ")), excludeLabels: input("text", s.filters.excludeLabels.join(", ")),
      excludeSenders: input("text", s.filters.excludeSenders.join(", ")), quietStart: input("time", quiet.start), quietEnd: input("time", quiet.end),
    };
    const field = (text, node) => el("label", { className: "field" }, [el("span", { text }), node]);
    const details = el("details", { ontoggle: () => {
      if (details.open) state.editingSource = source.id;
      else if (state.editingSource === source.id) state.editingSource = null;
    } }, [
      el("summary", { text: "设置" }),
      el("div", { className: "stack", style: "padding:10px 0 0" }, [
        el("div", { className: "row" }, [field("轮询间隔（秒）", fields.intervalS), field("合并窗口（秒）", fields.mergeWindowS), field("每小时预算（次）", fields.budgetPerHour)]),
        el("div", { className: "row" }, [field("必须带的标签（逗号分隔）", fields.requireLabels), field("排除的标签（逗号分隔）", fields.excludeLabels)]),
        el("div", { className: "row" }, [field("排除的发件人（逗号分隔，包含即排除）", fields.excludeSenders)]),
        el("div", { className: "row" }, [field("安静时段开始", fields.quietStart), field("安静时段结束（两项都空 = 关闭）", fields.quietEnd)]),
        el("div", { className: "row" }, [el("button", { className: "btn primary", type: "button", text: "保存设置", onclick: () => saveSource(source.id, fields) })]),
      ]),
    ]);
    return details;
  }
  const commaList = value => Array.from(new Set(value.split(/[,，]/).map(item => item.trim()).filter(Boolean)));
  async function saveSource(id, fields) {
    const settings = { intervalS: Number(fields.intervalS.value), mergeWindowS: Number(fields.mergeWindowS.value), budgetPerHour: Number(fields.budgetPerHour.value),
      filters: { requireLabels: commaList(fields.requireLabels.value), excludeLabels: commaList(fields.excludeLabels.value), excludeSenders: commaList(fields.excludeSenders.value) } };
    const start = fields.quietStart.value.trim(), end = fields.quietEnd.value.trim();
    if (start || end) settings.quietHours = { start, end };
    try {
      await api("PUT", "/admin/event-sources/" + encodeURIComponent(id) + "/settings", settings);
      state.editingSource = null;
      notice("已保存 " + id + " 的设置");
    } catch (error) { fail(error); return; }
    loadSources().catch(fail);
  }
  async function setSourcePaused(id, paused) {
    try {
      await api("POST", "/admin/event-sources/" + encodeURIComponent(id) + "/" + (paused ? "pause" : "resume"));
      notice(id + (paused ? " 已暂停" : " 已恢复"));
    } catch (error) { fail(error); }
    refresh();
  }

  function renderMcp(servers) {
    const list = $("mcp-list");
    clear(list);
    for (const server of servers) {
      const login = LOGIN[server.login] || [server.login, "neutral"];
      const oauth = server.credential === "oauth";
      list.append(el("div", { className: "row" }, [
        el("div", { className: "grow", style: "min-width:160px" }, [
          el("div", { style: "font-weight:600", text: server.server }),
          el("div", { className: "muted small", text: CREDENTIAL[server.credential] || server.credential }),
        ]),
        server.enabled ? pill(login[0], login[1]) : pill("已停用", "neutral"),
        el("span", { className: "mono muted", text: server.tools + " 个工具" }),
        server.enabled ? el("button", { className: "btn", type: "button", text: "刷新目录", onclick: () => mcpRefresh(server.server) }) : null,
        server.enabled && oauth && server.login !== "ok" ? el("button", { className: "btn primary", type: "button", text: "生成登录链接", onclick: () => mcpLink(server.server) }) : null,
        server.enabled && oauth && (server.login === "ok" || server.login === "error") ? el("button", { className: "btn danger", type: "button", text: "登出", onclick: () => mcpLogout(server.server) }) : null,
      ]));
    }
    if (!servers.length) list.append(el("div", { className: "muted", text: "尚未接入 MCP 服务" }));
    paginateChildren(list);
  }
  function renderSecrets(configured) {
    const box = $("s-secrets");
    clear(box);
    box.append(el("div", { text: "owner 只来自 secret QQ_OWNER，面板不能修改。secrets（只显示是否已配置）：" }));
    const row = el("div", { className: "row", style: "margin-top:6px;gap:6px" });
    for (const [name, set] of Object.entries(configured)) row.append(pill(name + (set ? " 已配置" : " 未配置"), set ? "ok" : "neutral"));
    box.append(row);
  }

  async function loadSettings() {
    const snapshot = await api("GET", "/admin/settings");
    renderSettings(snapshot);
  }
  const listText = values => values.join(", ");
  const parseList = value => value.split(/[\s,，]+/).filter(Boolean);
  function renderSettings(snapshot) {
    state.settings = snapshot;
    const value = snapshot.value;
    $("s-trigger").value = value.groupTrigger;
    $("s-groups").value = listText(value.allowGroups);
    $("s-users").value = listText(value.allowUsers);
    $("s-extract").value = listText(value.extractNamespaces);
    $("s-meta").textContent = snapshot.overrides ? "上次保存 " + time(snapshot.updatedAt) : "当前沿用 secrets/vars 默认值";
    const d = snapshot.defaults;
    $("s-defaults").textContent = "默认值：群 " + (listText(d.allowGroups) || "无") + "；私聊 " + (listText(d.allowUsers) || "无") + "；抽取 " + (listText(d.extractNamespaces) || "关闭")
      + "；模型 " + d.model.provider + "/" + d.model.id;
  }
  async function saveSettings() {
    // 模型由模型卡片切换，这里原样带回当前值；两张卡片共用一个 revision。
    const value = { groupTrigger: $("s-trigger").value, allowGroups: parseList($("s-groups").value),
      allowUsers: parseList($("s-users").value), extractNamespaces: parseList($("s-extract").value), model: state.settings.value.model };
    try {
      const saved = await api("PUT", "/admin/settings", { value, expectedRevision: state.settings.revision });
      renderSettings(saved);
      notice(saved.applied ? "设置已保存并推送到 Bridge" : "设置已保存，Bridge 暂未确认，最迟在它重启后生效");
      loadModel().catch(fail);
      refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body.current) renderSettings(error.body.current);
      if (error instanceof ApiError && error.status === 400) { show("设置格式不正确：群号与 QQ 号须为 5～16 位数字，命名空间只能是 owner、group:群号 或 private:QQ号", "error"); return; }
      fail(error);
    }
  }

  async function loadModel() {
    renderModel(await api("GET", "/admin/model"));
  }
  function renderModel(view) {
    state.model = view;
    const current = view.current, key = current.provider + "/" + current.id;
    $("m-current").textContent = key + (current.reasoningEffort ? " · 推理 " + current.reasoningEffort : "");
    const select = $("m-model");
    clear(select);
    for (const provider of view.providers) {
      const group = el("optgroup", { label: provider.name + (provider.available ? "" : "（" + (MODEL_REASONS[provider.reason] || provider.reason) + "）") });
      for (const model of provider.models) {
        const value = provider.id + "/" + model.id;
        group.append(el("option", { value, text: model.name + " · " + model.id, disabled: !provider.available && value !== key }));
      }
      select.append(group);
    }
    select.value = key;
    $("m-effort").value = current.reasoningEffort || "";
    if (!Array.from(select.options).some(option => option.value === key)) select.append(el("option", { value: key, text: key + "（当前不可用）" }));
    select.value = key;
    const codex = view.codex, status = $("codex-status");
    status.textContent = CODEX_STATUS[codex.status] || "状态未知";
    status.className = "pill " + (codex.loggedIn ? "ok" : codex.status === "refresh_failed" || codex.needsReauth ? "bad" : "neutral");
    $("codex-account").textContent = [codex.email,
      codex.imageGeneration ? "Codex 订阅生图已接入" : codex.hasCredential && codex.flow !== "codex-native" ? "当前为旧授权，重新授权后可使用订阅生图" : "", codex.expiresAt ? "凭据到期 " + time(codex.expiresAt) : "",
      codex.status === "refresh_due" ? "下次请求将尝试刷新；也可点击刷新模型列表验证" : "",
      codex.refreshFailure ? time(codex.refreshFailure.at) + " · " + refreshDiagnostic(codex.refreshFailure) : "",
      !codex.hasCredential ? "请选择账号授权后使用 GPT" : ""].filter(Boolean).join(" · ");
    const accounts = $("codex-accounts"); clear(accounts);
    accounts.append(el("option", { value: "", text: "添加 ChatGPT 账号" }));
    for (const account of codex.accounts) accounts.append(el("option", { value: account.id,
      text: account.label + (account.id === codex.activeId ? "（当前）" : "") + " · " + (CODEX_STATUS[account.status] || "状态未知") }));
    accounts.value = codex.activeId || "";
    $("codex-logout").hidden = !codex.hasCredential;
  }
  async function saveModel() {
    const value = $("m-model").value, slash = value.indexOf("/"), effort = $("m-effort").value;
    const model = { provider: value.slice(0, slash), id: value.slice(slash + 1) };
    if (effort) model.reasoningEffort = effort;
    try {
      renderModel(await api("PUT", "/admin/model", { model, expectedRevision: state.model.revision }));
      notice("模型已切换，各会话下一回合生效");
      loadSettings().catch(fail);
      refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) loadModel().catch(fail);
      fail(error);
    }
  }
  async function codexStart() {
    try {
      const accountId = $("codex-accounts").value;
      const result = await api("POST", "/admin/model/oauth/codex/start", accountId ? { accountId } : {});
      $("codex-ticket").value = result.ticket;
      $("codex-command").value = "node ./chatgpt-login.mjs " + location.origin;
      $("codex-pending").hidden = false;
      notice("配对码已生成，请运行本机授权助手");
    } catch (error) { fail(error); }
  }
  async function codexRefresh() {
    try {
      await loadModel();
      if (state.model.codex.loggedIn) { $("codex-pending").hidden = true; $("codex-ticket").value = ""; }
      notice(CODEX_STATUS[state.model.codex.status] || "状态未知");
    } catch (error) { fail(error); }
  }
  async function codexSelect() {
    const accountId = $("codex-accounts").value;
    if (!accountId) return notice("请先为新账号完成授权");
    try { renderModel(await api("POST", "/admin/model/oauth/codex/select", { accountId })); notice("账号已切换，下一回合生效"); } catch (error) { fail(error); }
  }
  async function codexCatalog() {
    try { renderModel(await api("POST", "/admin/model/oauth/codex/catalog")); notice("模型列表已刷新"); } catch (error) { fail(error); } finally { await loadModel().catch(fail); }
  }
  async function codexLogout() {
    try {
      const result = await api("POST", "/admin/model/oauth/codex/logout");
      notice(result.revoked ? "ChatGPT 已登出" : "已在本应用登出，但未确认远端撤销，请到 ChatGPT 设置中断开授权");
    } catch (error) { fail(error); }
    loadModel().catch(fail);
    refresh();
  }

  async function loadMemory() {
    if(mm.ns!==state.memoryNs||mm.query!==state.memoryQuery){mm.page=1;mm.ns=state.memoryNs;mm.query=state.memoryQuery;}
    const query="?ns="+encodeURIComponent(state.memoryNs), page=mm.page;
    const [base,list]=await Promise.all([api("GET","/admin/memory"+query),api("GET","/admin/memory/list"+query+"&q="+encodeURIComponent(state.memoryQuery)+"&status="+$("mem-status").value+"&page="+page+"&limit="+ADMIN_PAGE_SIZE)]);
    renderMemory({...base,memories:list.items});
    mm.total=list.total;$("mem-page").textContent="第 "+page+" 页 · 每页 "+ADMIN_PAGE_SIZE+" 条 · 共 "+list.total+" 条";
    $("mem-prev").disabled=page<=1;$("mem-next").disabled=page*ADMIN_PAGE_SIZE>=list.total;
  }
  function renderMemory(view) {
    state.memoryView = view;
    state.profile = view.profile;
    $("mem-title").textContent = "记忆 · " + state.memoryNs;
    $("mem-meta").textContent = (state.memoryQuery ? "匹配 " : "最近活跃 ") + view.memories.length + " 条";
    const profileBytes = new TextEncoder().encode(view.profile.text).byteLength;
    $("profile-meta").textContent = view.profile.revision === "none" ? "未创建" : bytes(profileBytes) + " · " + view.profile.revision;
    $("profile-text").textContent = view.profile.text || "（空）";
    const body = $("memories");
    clear(body);
    if (!view.memories.length) { body.append(el("tr", {}, [el("td", { colspan: 5, className: "muted", text: "没有记忆" })])); return; }
    for (const row of view.memories) {
      const armed = state.armedDelete === row.id;
      const extra = [row.subject ? "主题 " + row.subject : null, row.due_at ? "到期 " + time(row.due_at * 1000) : null, row.status !== "active" ? "状态 " + row.status : null].filter(Boolean);
      body.append(el("tr", {}, [
        el("td", { className: "mono", text: row.id }),
        el("td", {}, [pill(row.kind, "neutral")]),
        el("td", { className: "cell-text" }, [el("div", { text: row.text }), extra.length ? el("div", { className: "muted small", text: extra.join(" · ") }) : null]),
        el("td", { className: "mono muted", text: row.author + " · " + time(row.updated_at * 1000) }),
        el("td", {}, [el("button",{className:"btn compact",type:"button",text:"详情",onclick:()=>memoryDetail(row.id)}), row.status === "active" ? el("button", { className: "btn compact danger", type: "button", text: armed ? "确认删除" : "删除",
          onclick: () => armed ? forget(row.id) : arm(row.id) }) : null]),
      ]));
    }
  }
  function arm(id) {
    state.armedDelete = id;
    renderMemory(state.memoryView);
    setTimeout(() => { if (state.armedDelete === id) { state.armedDelete = null; renderMemory(state.memoryView); } }, 5000);
  }
  async function forget(id) {
    state.armedDelete = null;
    try {
      await api("DELETE", "/admin/memory/" + id + "?ns=" + encodeURIComponent(state.memoryNs));
      notice("已删除记忆 #" + id);
    } catch (error) { fail(error); }
    loadMemory().catch(fail);
    refresh();
  }
  function toggleProfile(editing) {
    $("profile-edit").hidden = !editing;
    $("profile-text").hidden = editing;
    $("profile-save").hidden = !editing;
    $("profile-toggle").textContent = editing ? "取消" : "编辑画像";
    if (editing) $("profile-edit").value = state.profile ? state.profile.text : "";
  }
  async function saveProfile() {
    try {
      await api("PUT", "/admin/memory/profile", { ns: state.memoryNs, text: $("profile-edit").value, expected: state.profile.revision });
      toggleProfile(false);
      notice("画像已保存");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { toggleProfile(false); show("画像已被别处修改，已载入最新内容，请重新编辑", "error"); }
      else fail(error);
    }
    loadMemory().catch(fail);
    refresh();
  }

  async function loadSkills() {
    renderSkills((await api("GET", "/admin/skills")).skills);
  }
  function renderSkills(skills) {
    state.skills = skills;
    const body = $("skills");
    clear(body);
    if (!skills.length) { body.append(el("tr", {}, [el("td", { colspan: 5, className: "muted", text: "还没有技能" })])); paginateChildren(body); return; }
    for (const skill of skills) {
      const armed = state.armedSkill === skill.name;
      body.append(el("tr", {}, [
        el("td", { className: "mono", text: skill.name }),
        el("td", { className: "cell-text", text: skill.description }),
        el("td", { className: "mono", text: skill.files.length ? skill.files.length + " 个" : "-" }),
        el("td", {}, [skill.enabled ? pill("启用", "ok") : pill("停用", "neutral")]),
        el("td", {}, [
          el("button", { className: "btn compact", type: "button", text: skill.enabled ? "停用" : "启用", onclick: () => toggleSkill(skill.name, !skill.enabled) }),
          el("button", { className: "btn compact", type: "button", text: "编辑", onclick: () => editSkill(skill.name) }),
          el("button", { className: "btn compact danger", type: "button", text: armed ? "确认删除" : "删除", onclick: () => armed ? deleteSkill(skill.name) : armSkill(skill.name) }),
        ]),
      ]));
    }
    paginateChildren(body);
  }
  // 名字只用来拼 URL；格式与一致性由服务端校验。
  function skillName(markdown) {
    const front = /^---\r?\n([\s\S]*?)^---/m.exec(markdown);
    const name = front && front.index === 0 ? /^name:\s*["']?([^"'\r\n]*?)["']?\s*$/m.exec(front[1]) : null;
    return name ? name[1] : "";
  }
  async function saveSkill() {
    const markdown = $("skill-md").value, name = skillName(markdown);
    if (!name) { show("SKILL.md 开头的 frontmatter 里需要 name", "error"); return; }
    try {
      await api("PUT", "/admin/skills/" + encodeURIComponent(name), { markdown });
      $("skill-meta").textContent = "正在编辑 " + name;
      notice("技能 " + name + " 已保存，各会话最迟 60 秒后看到");
    } catch (error) { fail(error); }
    loadSkills().catch(fail);
  }
  async function editSkill(name) {
    try {
      const skill = await api("GET", "/admin/skills/" + encodeURIComponent(name));
      $("skill-md").value = skill.body;
      $("skill-meta").textContent = "正在编辑 " + name + (Object.keys(skill.files).length ? " · 附件保留不变" : "");
      $("skill-md").focus();
    } catch (error) { fail(error); }
  }
  async function toggleSkill(name, enabled) {
    try {
      await api("POST", "/admin/skills/" + encodeURIComponent(name) + "/" + (enabled ? "enable" : "disable"));
      notice("技能 " + name + (enabled ? " 已启用" : " 已停用"));
    } catch (error) { fail(error); }
    loadSkills().catch(fail);
  }
  function armSkill(name) {
    state.armedSkill = name;
    renderSkills(state.skills);
    setTimeout(() => { if (state.armedSkill === name) { state.armedSkill = null; renderSkills(state.skills); } }, 5000);
  }
  async function deleteSkill(name) {
    state.armedSkill = null;
    try {
      await api("DELETE", "/admin/skills/" + encodeURIComponent(name));
      notice("已删除技能 " + name);
    } catch (error) { fail(error); }
    loadSkills().catch(fail);
  }

  async function release(scope) {
    try { await api("POST", "/admin/send-rules/release", { scope }); notice("已解除 " + scope + " 的熔断"); } catch (error) { fail(error); }
    refresh();
  }
  async function stop(key) {
    try {
      const result = await api("POST", "/admin/threads/" + encodeURIComponent(key) + "/stop");
      notice(result.stopped ? "已停止 " + key + " 的当前回合" : key + " 没有进行中的回合");
    } catch (error) { fail(error); }
    refresh();
  }
  async function resetSandbox(key) {
    if (!confirm("重置会销毁 " + key + " 的沙箱容器，/work 里的文件都会丢失。继续？")) return;
    try {
      const result = await api("POST", "/admin/threads/" + encodeURIComponent(key) + "/sandbox/reset");
      notice(result.reset ? "已重置 " + key + " 的沙箱" : key + " 的沙箱没有在运行");
    } catch (error) { fail(error); }
    refresh();
  }
  async function mcpLink(server) {
    try {
      const result = await api("POST", "/admin/mcp/" + encodeURIComponent(server) + "/login-link");
      $("mcp-link-url").value = result.url;
      $("mcp-link").hidden = false;
      notice("已生成 " + server + " 的一次性登录链接，旧链接已失效");
    } catch (error) { fail(error); }
  }
  async function mcpLogout(server) {
    try { await api("POST", "/admin/mcp/" + encodeURIComponent(server) + "/logout"); notice(server + " 已登出"); } catch (error) { fail(error); }
    refresh();
  }
  async function mcpRefresh(server) {
    try {
      const result = await api("POST", "/admin/mcp/" + encodeURIComponent(server) + "/refresh");
      notice(result.results.map(r => r.server + "：" + r.status + "，" + r.tools + " 个工具").join("；") || "没有可刷新的服务");
    } catch (error) { fail(error); }
    refresh();
  }

  $("login-form").addEventListener("submit", event => {
    event.preventDefault();
    const value = $("login-token").value.trim();
    $("login-token").value = "";
    if (!value) return;
    writeToken(value);
    start();
  });
  $("logout").addEventListener("click", () => { writeToken(null); showLogin("已登出"); });
  $("ev-thread").addEventListener("change", event => selectThread(event.target.value));
  $("ev-prev").addEventListener("click", () => { state.before = state.history.pop(); loadEvents().catch(fail); });
  $("ev-next").addEventListener("click", () => {
    if (state.next === undefined) return;
    state.history.push(state.before);
    state.before = state.next;
    loadEvents().catch(fail);
  });
  $("s-save").addEventListener("click", saveSettings);
  $("m-save").addEventListener("click", saveModel);
  $("codex-start").addEventListener("click", codexStart);
  $("codex-refresh").addEventListener("click", codexRefresh);
  $("codex-select").addEventListener("click", codexSelect);
  $("codex-catalog").addEventListener("click", codexCatalog);
  $("codex-logout").addEventListener("click", codexLogout);
  $("codex-copy").addEventListener("click", () => { navigator.clipboard.writeText($("codex-ticket").value).then(() => notice("已复制"), () => show("复制失败，请手动选择链接", "error")); });
  $("mem-ns").addEventListener("change", event => { state.memoryNs = event.target.value; toggleProfile(false); loadMemory().catch(fail); });
  $("mem-q").addEventListener("keydown", event => { if (event.key === "Enter") { state.memoryQuery = event.target.value.trim(); loadMemory().catch(fail); } });
  $("mem-q").addEventListener("search", event => { state.memoryQuery = event.target.value.trim(); loadMemory().catch(fail); });
  $("profile-toggle").addEventListener("click", () => toggleProfile($("profile-edit").hidden));
  $("profile-save").addEventListener("click", saveProfile);
  $("skill-save").addEventListener("click", saveSkill);
  $("skill-new").addEventListener("click", () => { $("skill-md").value = ""; $("skill-meta").textContent = ""; });
  $("mcp-link-copy").addEventListener("click", () => { navigator.clipboard.writeText($("mcp-link-url").value).then(() => notice("已复制"), () => show("复制失败，请手动选择链接", "error")); });

  ${CONSOLE_APP_JS}
  ${SESSION_APP_JS}
  ${MEMORY_MANAGER_JS}
  ${ACCESS_APP_JS}
  ${WORKSPACE_APP_JS}
  ${MCP_ADMIN_APP_JS}
  ${MCP_SERVERS_JS}

  renderKinds();
  if (readToken()) start(); else showLogin("");
})();
`;
