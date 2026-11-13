import { ADMIN_PAGE_SIZE } from "./pagination";

import { MCP_ADMIN_HTML } from "./mcp-ui";
import { MCP_SERVERS_HTML } from "./mcp-servers-ui";
import { WORKSPACE_CSS, WORKSPACE_HTML } from "./workspace-ui";
import { ACCESS_HTML } from "./access-ui";
import { MEMORY_MANAGER_HTML } from "./memory-ui";
import { SESSION_HTML } from "./sessions";
import { CONSOLE_CSS, CONSOLE_NAV, CONSOLE_HTML } from "./console";
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
.github-check{display:inline-flex!important;align-items:center;justify-content:flex-start;gap:6px;margin:4px 12px 4px 0;max-width:100%}
.github-check input[type=checkbox]{width:auto!important;min-width:0;flex:0 0 auto;margin:0;padding:0}
.github-check span{flex:0 1 auto;overflow-wrap:anywhere}
.github-rules .row{align-items:end;border-bottom:1px solid var(--line);padding:8px 0}
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
    <span id="health-qq" class="pill neutral">QQ 待检测</span>
    <span id="health-model" class="pill neutral">模型待检测</span>
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
