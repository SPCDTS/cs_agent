/** 插入管理视图；不含授权数据，读取与提交均走现有 Bearer API。 */
export const MCP_ADMIN_HTML = `
<section class="card" id="mcp-access-section">
  <div class="section-head"><h2 class="h2">MCP 群授权与逐次审批</h2><span class="muted small">默认仅 owner 私聊可用；群必须明确授权</span></div>
  <div class="stack">
    <div class="row">
      <label for="mcp-access-thread">线程</label><select id="mcp-access-thread"><option value="owner">owner</option></select>
      <label for="mcp-access-server">服务</label><select id="mcp-access-server"></select>
      <button type="button" class="btn" id="mcp-access-threads">加载线程</button>
      <button type="button" class="btn" id="mcp-access-refresh">刷新授权与审批</button>
    </div>
    <div id="mcp-access-note" class="muted small">选择群线程后加载授权。所有刷新均由按钮触发。</div>
    <div id="mcp-access-editor" hidden>
      <div class="field"><label>明确允许的工具（未勾选即禁止）</label><div id="mcp-access-tools" class="row"></div></div>
      <div class="pair">
        <div class="field" style="flex:1"><label for="mcp-access-actors">允许成员，每行一个 QQ；* 表示全部成员</label><textarea id="mcp-access-actors" rows="3" style="min-height:90px" placeholder="10000003"></textarea></div>
        <div class="field" style="flex:1"><label for="mcp-access-resources">允许资源前缀，每行一个；留空即不开放资源</label><textarea id="mcp-access-resources" rows="3" style="min-height:90px" placeholder="notion://docs/"></textarea></div>
      </div>
      <div class="row">
        <label for="mcp-access-expires">授权到期（留空长期有效）</label><input id="mcp-access-expires" type="datetime-local">
        <span id="mcp-access-revision" class="mono muted small">revision=none</span>
        <button type="button" id="mcp-access-save" class="btn primary">保存明确授权</button>
        <button type="button" id="mcp-access-revoke" class="btn danger">撤销本服务授权</button>
      </div>
      <p class="note">成员对 owner 账号的写操作仍须每次批准。更改授权会使该服务未执行的旧审批失效。</p>
    </div>
    <div class="row"><h3 style="margin:0">调用审批</h3><label><input type="checkbox" id="mcp-approvals-pending" checked>只看待审批</label><span class="muted small">批准仅执行下方固定参数一次；默认在本面板显示结果</span></div>
    <div id="mcp-approvals-list" class="stack" style="padding:0"><div class="muted">点击刷新加载审批。</div></div>
    <div id="mcp-approval-result" class="source" hidden></div>
  </div>
</section>
`;

/** 插入现有 ADMIN_APP_JS 的 IIFE，复用 api/el/readToken/show/fail/time，不新增轮询。 */
export const MCP_ADMIN_APP_JS = String.raw`
  let mcpUiServers = [];
  const mcpUi = { revision: "none", approvals: [], version: 0, loaded: false };
  const mcpUiNode = id => document.getElementById(id);
  const mcpUiLines = value => [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  const mcpUiSelection = () => ({ scope: mcpUiNode("mcp-access-thread").value, server: mcpUiNode("mcp-access-server").value });
  const mcpUiQuery = selection => "?scope=" + encodeURIComponent(selection.scope) + "&server=" + encodeURIComponent(selection.server);
  const mcpUiPretty = raw => { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw || ""; } };
  function mcpUiResult(result) {
    if (!result) return "";
    if (result.output) return result.output.map(content => content.type === "text" ? content.text : "[图片：" + content.mimeType + "，保留在原工具结果中]").join("\n");
    return JSON.stringify(result, null, 2);
  }
  function mcpUiTools(grant) {
    const selection = mcpUiSelection(), server = mcpUiServers.find(item => item.id === selection.server);
    const list = mcpUiNode("mcp-access-tools"); list.replaceChildren();
    for (const name of server ? server.tools : []) {
      const checkbox = el("input", { type: "checkbox", value: name }); checkbox.checked = !!grant && grant.tools.includes(name);
      list.append(el("label", { className: "row", style: "gap:5px" }, [checkbox, el("span", { className: "mono", text: name }),
        el("span", { className: "small muted", text: server.readOnly.includes(name) ? "只读" : "成员逐次审批" })]));
    }
    paginateChildren(list,{key:"mcp-access-tools:"+selection.scope+":"+selection.server});
  }
  function mcpUiGrant(grant) {
    mcpUi.revision = grant ? grant.revision : "none";
    mcpUiNode("mcp-access-editor").hidden = !mcpUiSelection().scope.startsWith("group:");
    mcpUiNode("mcp-access-note").textContent = grant ? "已加载当前授权；保存使用 revision 防止覆盖别人的修改。" : "尚无群授权。owner 私聊沿用默认策略。";
    mcpUiNode("mcp-access-actors").value = grant ? grant.actors.join("\n") : "";
    mcpUiNode("mcp-access-resources").value = grant ? grant.resourceAllow.join("\n") : "";
    mcpUiNode("mcp-access-revision").textContent = "revision=" + mcpUi.revision;
    mcpUiNode("mcp-access-revoke").disabled = !grant;
    const expiry = grant && grant.expiresAt ? new Date(grant.expiresAt) : null;
    mcpUiNode("mcp-access-expires").value = expiry ? new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
    mcpUiTools(grant);
  }
  function mcpUiApprovals() {
    const list = mcpUiNode("mcp-approvals-list"); list.replaceChildren();
    const rows = mcpUi.approvals.filter(row => !mcpUiNode("mcp-approvals-pending").checked || row.status === "pending");
    for (const row of rows) {
      const exact = el("details", {}, [el("summary", { text: "查看固定参数与调用摘要" }),
        el("div", { className: "mono small", text: "operation=" + row.operation_id + " · contract=" + row.contract }),
        el("pre", { className: "profile-text mono", text: mcpUiPretty(row.args_json) })]);
      const actions = row.status === "pending" ? el("div", { className: "row" }, [
        el("button", { className: "btn primary", type: "button", text: "批准并执行一次", onclick: event => mcpUiDecide(row, "approve", event.currentTarget) }),
        el("button", { className: "btn danger", type: "button", text: "拒绝", onclick: event => mcpUiDecide(row, "reject", event.currentTarget) }),
      ]) : null;
      list.append(el("article", { className: "source" }, [
        el("div", { className: "row" }, [el("strong", { text: row.server_id + " · " + row.tool_name }), el("span", { className: "pill neutral", text: row.status })]),
        el("div", { className: "muted small", text: "申请人 " + row.actor + " · " + row.scope + " · 代次 " + row.generation + " · 来源 " + row.reply_channel +
          " · 创建 " + time(row.created_at) + " · 到期 " + time(row.expires_at) }),
        exact, actions,
        row.result_json ? el("details", {}, [el("summary", { text: "查看执行回执" }), el("pre", { className: "profile-text mono", text: mcpUiPretty(row.result_json) })]) : null,
      ]));
    }
    if (!rows.length) list.append(el("div", { className: "muted", text: mcpUiNode("mcp-approvals-pending").checked ? "当前没有待审批调用。" : "当前没有调用审批记录。" }));
    paginateChildren(list,{key:"mcp-approvals:"+mcpUiNode("mcp-approvals-pending").checked});
  }
  async function mcpUiLoad() {
    if (!readToken()) return;
    const version = ++mcpUi.version; mcpUi.loaded = false;
    try {
      const data = await api("GET", "/admin/mcp/servers");
      if (version !== mcpUi.version) return;
      const select = mcpUiNode("mcp-access-server"), selected = select.value;
      mcpUiServers = data.servers.filter(row => row.server.enabled).map(({server}) => ({id:server.id, tools:server.tools.allow, readOnly:server.tools.readOnly, resourceAllow:server.resourceAllow, revision:server.access.revision}));
      select.replaceChildren(...mcpUiServers.map(server => el("option", {value:server.id,text:server.id})));
      if(mcpUiServers.some(server=>server.id===selected))select.value=selected;
      const selection = mcpUiSelection();
      if(!selection.server){mcpUiGrant(null);mcpUiNode("mcp-access-note").textContent="请先在模型与连接页启用 MCP 服务。";return;}
      const result = await Promise.all([api("GET", "/admin/mcp/access" + mcpUiQuery(selection)), api("GET", "/admin/mcp/approvals?scope=" + encodeURIComponent(selection.scope))]);
      if (version !== mcpUi.version) return;
      mcpUiGrant(result[0].grant); mcpUi.loaded = true; mcpUi.approvals = result[1].approvals || []; mcpUiApprovals();
      if(result[0].grant && result[0].grant.serverRevision!==mcpUiServers.find(server=>server.id===selection.server)?.revision)mcpUiNode("mcp-access-note").textContent="连接或凭据已更换，旧群授权已失效；请核实并重新保存授权。";
    } catch (error) { fail(error); }
  }
  async function mcpUiThreads() {
    if (!readToken()) return;
    try {
      const overview = await api("GET", "/admin/overview"), select = mcpUiNode("mcp-access-thread"), selected = select.value;
      select.replaceChildren(el("option", { value: "owner", text: "owner（默认私聊策略）" }));
      for (const thread of overview.threads || []) if (thread.key.startsWith("group:")) select.append(el("option", { value: thread.key, text: (thread.name ? thread.name + " · " : "") + thread.key }));
      if ([...select.options].some(option => option.value === selected)) select.value = selected;
      await mcpUiLoad();
    } catch (error) { fail(error); }
  }
  async function mcpUiSave(revoke, button) {
    const selection = mcpUiSelection(); if (!selection.scope.startsWith("group:")) return;
    if (!mcpUi.loaded) { show("请先刷新当前线程的授权。", "error"); return; }
    const actors = mcpUiLines(mcpUiNode("mcp-access-actors").value);
    if (!revoke && !actors.length) { show("请明确填写允许成员；* 表示全部成员。", "error"); return; }
    const rawExpiry = mcpUiNode("mcp-access-expires").value;
    const expiresAt = rawExpiry ? new Date(rawExpiry).getTime() : null;
    if (!revoke && expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) { show("请选择未来的授权到期时间。", "error"); return; }
    const input = { tools: revoke ? [] : listInputs(mcpUiNode("mcp-access-tools"),"input:checked").map(node => node.value),
      resourceAllow: revoke ? [] : mcpUiLines(mcpUiNode("mcp-access-resources").value), actors: actors.length ? actors : ["*"], expiresAt: revoke ? null : expiresAt };
    button.disabled = true;
    try {
      await api("PUT", "/admin/mcp/access" + mcpUiQuery(selection), { server: selection.server, expected: mcpUi.revision, input });
      show(revoke ? "已撤销本服务授权，旧的未执行审批已失效。" : "已保存明确授权；成员写操作仍须逐次批准。", "info");
      await mcpUiLoad();
    } catch (error) { fail(error); } finally { button.disabled = false; }
  }
  async function mcpUiDecide(row, decision, button) {
    button.disabled = true;
    try {
      const result = await api("POST", "/admin/mcp/approvals/" + encodeURIComponent(row.id) + "/" + decision + "?scope=" + encodeURIComponent(row.scope));
      const target = mcpUiNode("mcp-approval-result"); target.hidden = false;
      target.replaceChildren(el("strong", { text: decision === "approve" ? "审批执行结果" : "已拒绝调用" }),
        el("pre", { className: "profile-text mono", text: result.result ? mcpUiResult(result.result) : JSON.stringify(result, null, 2) }));
      show(decision === "approve" ? "审批已处理；结果显示在本面板，不另发 QQ 通知。" : "已拒绝，原调用不会执行。", "info");
      await mcpUiLoad();
    } catch (error) { fail(error); } finally { button.disabled = false; }
  }
  mcpUiNode("mcp-access-threads").addEventListener("click", mcpUiThreads);
  mcpUiNode("mcp-access-refresh").addEventListener("click", mcpUiLoad);
  mcpUiNode("mcp-access-thread").addEventListener("change", mcpUiLoad);
  mcpUiNode("mcp-access-server").addEventListener("change", mcpUiLoad);
  mcpUiNode("mcp-approvals-pending").addEventListener("change", mcpUiApprovals);
  mcpUiNode("mcp-access-save").addEventListener("click", event => mcpUiSave(false, event.currentTarget));
  mcpUiNode("mcp-access-revoke").addEventListener("click", event => mcpUiSave(true, event.currentTarget));
  mcpUiGrant(null);
`;
