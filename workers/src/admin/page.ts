// 页面与脚本分开发送：脚本走 script-src 'self'，CSP 不必放开内联脚本。两者都不含数据，数据只经带 Bearer 的接口取得。
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>cs-agent 面板</title>
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
input[type=text],input[type=search],input[type=password],select,textarea{border:1px solid #CBD1DA;border-radius:8px;padding:8px 10px;font-size:13px;min-height:36px;background:#FFFFFF;color:#16181D;font-family:inherit;max-width:100%}
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
</style>
</head>
<body>
<div id="login" class="login" hidden>
  <form id="login-form" class="card login-card" autocomplete="off">
    <h1>cs-agent 面板</h1>
    <label for="login-token">管理口令（ADMIN_TOKEN）</label>
    <input id="login-token" type="password" autocomplete="current-password" required>
    <button class="btn primary" type="submit">进入</button>
    <div id="login-message" class="muted small"></div>
  </form>
</div>

<div id="app" hidden>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">cs-agent 面板</div>
    <div id="commit" class="mono muted"></div>
    <span id="health" class="pill neutral">加载中</span>
    <div class="grow"></div>
    <div id="refreshed" class="muted small"></div>
    <button id="logout" class="btn" type="button">登出</button>
  </div>
</header>
<div id="status" class="status-line" role="status" hidden></div>

<main>
  <section class="cards">
    <div class="card"><div class="muted small">NapCat</div><div id="card-napcat" class="big">-</div><div id="card-napcat-sub" class="muted small"></div></div>
    <div class="card"><div class="muted small">模型</div><div id="card-model" class="big">-</div><div id="card-model-sub" class="muted small"></div></div>
    <div class="card"><div class="muted small">会话</div><div id="card-threads" class="big">-</div><div id="card-threads-sub" class="muted small"></div></div>
    <div class="card"><div class="muted small">发送规则</div><div id="card-rules" class="big">-</div><div id="card-rules-list" class="small"></div></div>
  </section>

  <section class="card">
    <div class="section-head"><h2 class="h2">会话</h2><span class="muted">每个会话键一个 Thread DO</span></div>
    <div class="scroll">
      <table class="wide">
        <thead><tr><th>线程</th><th>状态</th><th>入站 排队 / 完成 / 失败</th><th>出站</th><th>记忆</th><th>最近发送</th><th></th></tr></thead>
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
        <div class="row"><strong>ChatGPT 订阅登录</strong><span id="codex-status" class="pill neutral">-</span></div>
        <div id="codex-account" class="muted small"></div>
        <div class="row">
          <button id="codex-start" class="btn primary" type="button">开始登录</button>
          <button id="codex-logout" class="btn danger" type="button" hidden>登出</button>
        </div>
        <div id="codex-pending" class="stack" style="padding:0" hidden>
          <div class="muted small">1. 打开授权链接并登录 ChatGPT；授权后浏览器会跳到一个打不开的 localhost:1455 地址，这是正常的。</div>
          <div class="link-box">
            <input id="codex-url" type="text" readonly aria-label="ChatGPT 授权链接">
            <a id="codex-open" class="btn" target="_blank" rel="noopener noreferrer">打开</a>
            <button id="codex-copy" class="btn" type="button">复制</button>
          </div>
          <div class="muted small">2. 把地址栏里的整串回调地址粘贴到这里，再点完成登录（10 分钟内有效，只能用一次）。</div>
          <div class="link-box">
            <input id="codex-callback" type="text" autocomplete="off" placeholder="http://localhost:1455/auth/callback?code=…&amp;state=…" aria-label="回调地址">
            <button id="codex-complete" class="btn primary" type="button">完成登录</button>
          </div>
        </div>
        <div class="note">token 加密存在 Registry，到期前自动续期；页面只显示结果分类，不回显 code 或 token。</div>
      </div>
    </div>
  </section>

  <section class="pair">
    <div class="card">
      <div class="section-head"><h2 class="h2">MCP 服务</h2><span class="muted">来自 mcp.json，改服务要重新部署</span></div>
      <div class="stack">
        <div id="mcp-list" class="stack" style="padding:0"></div>
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
</main>
</div>
<script src="/admin/app.js" defer></script>
</body>
</html>
`;

export const ADMIN_APP_JS = String.raw`"use strict";
(() => {
  const TOKEN_KEY = "cs-agent-admin-token";
  const EVENT_KINDS = ["", "mcp_call", "mcp_catalog", "memory_extract", "memory_write"];
  const LOGIN = { ok: ["已登录", "ok"], needed: ["需要登录", "warn"], error: ["凭据错误", "bad"], unconfigured: ["未配置", "neutral"] };
  const CREDENTIAL = { oauth: "OAuth（CIMD）", static: "静态凭据", none: "无凭据" };
  const ERRORS = {
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
    token_exchange: "换取 token 失败，请重新开始登录",
  };
  const MODEL_REASONS = { missing_key: "缺 DEEPSEEK_API_KEY", login_required: "未登录 ChatGPT", unconfigured: "未配置 OAUTH_STORE_KEY",
    unknown_provider: "provider 未注册", unknown_model: "目录里没有这个模型", unavailable: "不可用" };
  const state = { overview: null, settings: null, model: null, eventKind: "", eventThread: "owner", before: undefined, history: [], next: undefined,
    memoryNs: "owner", memoryQuery: "", memoryView: null, profile: null, armedDelete: null, timer: null, noticeTimer: null };

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
      return (ERRORS[code] || ("请求失败（" + error.status + (code ? " " + code : "") + "）")) + (reason ? "：" + (MODEL_REASONS[reason] || reason) : "");
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
    refresh();
    loadSettings().catch(fail);
    loadModel().catch(fail);
    loadMemory().catch(fail);
    clearInterval(state.timer);
    state.timer = setInterval(refresh, 30000);
  }
  function refresh() {
    return Promise.all([loadOverview(), loadEvents()]).then(() => {
      $("refreshed").textContent = "刷新于 " + time(Date.now());
    }).catch(fail);
  }

  async function loadOverview() {
    const overview = await api("GET", "/admin/overview");
    state.overview = overview;
    renderOverview(overview);
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
    if (!rules.length) { list.append(el("span", { className: "muted", text: "每会话 6 条/分 · 60 条/时，全局 30 条/分" })); return; }
    for (const rule of rules) {
      list.append(el("div", { className: "row" }, [
        el("span", { className: "mono", text: (rule.scope === "global" ? "全部会话" : rule.scope) + " · 至 " + time(rule.until) }),
        el("button", { className: "btn compact", type: "button", text: "解除", onclick: () => release(rule.scope) }),
      ]));
    }
  }
  function renderThreads(threads) {
    const body = $("threads");
    clear(body);
    if (!threads.length) { body.append(el("tr", {}, [el("td", { colspan: 7, className: "muted", text: "还没有会话" })])); return; }
    for (const thread of threads) {
      const s = thread.stats, broken = "error" in s;
      const busy = !broken && s.inbound.queued > 0;
      body.append(el("tr", {}, [
        el("td", {}, [el("span", { className: "mono", text: thread.key }), thread.name ? el("div", { className: "muted small", text: thread.name }) : null]),
        el("td", {}, [broken ? pill("不可用", "bad") : busy ? pill("处理中", "warn") : pill("空闲", "ok")]),
        el("td", { className: "mono", text: broken ? "-" : s.inbound.queued + " / " + s.inbound.done + " / " + s.inbound.failed }),
        el("td", { className: "mono", text: broken ? "-" : s.outbox }),
        el("td", { className: "mono", text: broken ? "-" : s.memory.active + " 条 · 画像 " + bytes(s.memory.profileBytes) }),
        el("td", { className: "mono", text: broken ? "-" : time(s.lastSentAt) }),
        el("td", {}, [
          el("button", { className: "btn compact", type: "button", text: "事件", onclick: () => { selectThread(thread.key); $("events-section").scrollIntoView(); } }),
          busy ? el("button", { className: "btn compact danger", type: "button", text: "停止", onclick: () => stop(thread.key) }) : null,
        ]),
      ]));
    }
  }

  const EVENT_FORMAT = {
    mcp_call: d => ({ parts: [d.server, d.tool, duration(d.ms), "入 " + bytes(d.inputBytes) + " / 出 " + bytes(d.outputBytes)], result: d.result }),
    mcp_catalog: d => ({ parts: [d.server, typeof d.tools === "number" ? d.tools + " 个工具" : null, typeof d.rejected === "number" ? "拒绝 " + d.rejected : null,
      typeof d.digest === "string" ? "摘要 " + d.digest.slice(0, 8) : null, d.code], result: d.status }),
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
    let path = "/admin/events?limit=50&thread=" + encodeURIComponent(state.eventThread);
    if (state.eventKind) path += "&kind=" + encodeURIComponent(state.eventKind);
    if (state.before !== undefined) path += "&before=" + state.before;
    const page = await api("GET", path);
    state.next = page.next;
    renderEvents(page.events);
    $("ev-prev").disabled = state.history.length === 0;
    $("ev-next").disabled = page.next === undefined;
    $("events-meta").textContent = "第 " + (state.history.length + 1) + " 页 · 每页 50 条";
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
    if (!servers.length) list.append(el("div", { className: "muted", text: "mcp.json 中没有服务" }));
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
    const codex = view.codex;
    const status = $("codex-status");
    status.textContent = codex.loggedIn ? "已登录" : "未登录";
    status.className = "pill " + (codex.loggedIn ? "ok" : "neutral");
    $("codex-account").textContent = codex.loggedIn ? (codex.email || "账号邮箱未知") + (codex.expiresAt ? " · access token 到期 " + time(codex.expiresAt) + "（会自动续期）" : "") : "";
    $("codex-start").textContent = codex.loggedIn ? "重新登录" : "开始登录";
    $("codex-logout").hidden = !codex.loggedIn;
    if (codex.loggedIn) $("codex-pending").hidden = true;
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
      const result = await api("POST", "/admin/model/oauth/codex/start");
      $("codex-url").value = result.url;
      $("codex-open").setAttribute("href", result.url);
      $("codex-callback").value = "";
      $("codex-pending").hidden = false;
      notice("已生成 ChatGPT 授权链接，旧链接已失效");
    } catch (error) { fail(error); }
  }
  async function codexComplete() {
    const callbackUrl = $("codex-callback").value.trim();
    if (!callbackUrl) return;
    try {
      const result = await api("POST", "/admin/model/oauth/codex/complete", { callbackUrl });
      $("codex-callback").value = "";
      $("codex-url").value = "";
      $("codex-pending").hidden = true;
      notice("ChatGPT 已登录" + (result.email ? "：" + result.email : ""));
    } catch (error) {
      // state 已消费，同一个回调地址不能再用，清掉免得重复提交。
      $("codex-callback").value = "";
      fail(error);
    }
    loadModel().catch(fail);
    refresh();
  }
  async function codexLogout() {
    try { await api("POST", "/admin/model/oauth/codex/logout"); notice("ChatGPT 已登出"); } catch (error) { fail(error); }
    loadModel().catch(fail);
    refresh();
  }

  async function loadMemory() {
    const view = await api("GET", "/admin/memory?ns=" + encodeURIComponent(state.memoryNs) + "&q=" + encodeURIComponent(state.memoryQuery));
    renderMemory(view);
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
        el("td", {}, [row.status === "active" ? el("button", { className: "btn compact danger", type: "button", text: armed ? "确认删除" : "删除",
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
  $("codex-complete").addEventListener("click", codexComplete);
  $("codex-logout").addEventListener("click", codexLogout);
  $("codex-copy").addEventListener("click", () => { navigator.clipboard.writeText($("codex-url").value).then(() => notice("已复制"), () => show("复制失败，请手动选择链接", "error")); });
  $("mem-ns").addEventListener("change", event => { state.memoryNs = event.target.value; toggleProfile(false); loadMemory().catch(fail); });
  $("mem-q").addEventListener("keydown", event => { if (event.key === "Enter") { state.memoryQuery = event.target.value.trim(); loadMemory().catch(fail); } });
  $("mem-q").addEventListener("search", event => { state.memoryQuery = event.target.value.trim(); loadMemory().catch(fail); });
  $("profile-toggle").addEventListener("click", () => toggleProfile($("profile-edit").hidden));
  $("profile-save").addEventListener("click", saveProfile);
  $("mcp-link-copy").addEventListener("click", () => { navigator.clipboard.writeText($("mcp-link-url").value).then(() => notice("已复制"), () => show("复制失败，请手动选择链接", "error")); });

  renderKinds();
  if (readToken()) start(); else showLogin("");
})();
`;
