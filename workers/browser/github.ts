import { connectionPanel } from "./github-connect";
import { paginatedBlock } from "./pagination";
import { CHOICES } from "../src/github/choices";
import type { GitHubView } from "./app-contracts";
import { el } from "./dom";
import { state, bjTime, notice, fail, loadSources } from "./app";
import { api } from "./api";
import { paginateChildren } from "./pagination";
export function renderGitHub(source: { paused: boolean }, github: GitHubView) {
  const editing = state.editingSource === "github" && state.sourceForms.github;
  const form = editing || (state.sourceForms.github = githubForm(github));
  const card = el("div", { className: "source" }, [
    el("strong", { text: "GitHub webhook" }),
    el("div", { className: "muted small", text: (github.configured ? "Secret 已配置" : "Secret 未配置：拒收") +
      " · " + (source.paused ? "已暂停" : "已启用") + " · 收件 " + github.count + "/" + github.capacity + " · 待处理上限 " + github.pendingCapacity }),
    el("p", { text: "仅监听明确勾选的仓库和事件。App 模式无需逐仓库创建 Webhook；旧手工列表不会转换为 App 授权。外部正文不是指令。" }),
    el("p", { hidden: github.mode === "app", className: "muted small", text: "保存手工允许列表不等于注册 GitHub webhook。在 Worker secrets 配置 GITHUB_WEBHOOK_SECRET，再到仓库 Settings → Webhooks 添加 https://你的域名/github/webhook，选择 application/json 与相同 secret。仅选择下面启用的事件；详见 docs/GITHUB-EVENTS.md。" }),
    ...(github.mode === "app" ? [connectionPanel(github)] : []),
    form,
    el("div", { hidden: github.mode === "app", className: "small", text: "仓库 ID 为首条通过过滤的已验签事件绑定（不是 GitHub API 验证）；删除后保留绑定，名称重用会被拒绝。当前绑定：" +
      github.pins.map(pin => pin.name + "=" + pin.repository_id).join(", ") }),
    el("div", { className: "muted small", text: "清空或删除会永久抑制未取得执行许可的积压；已获许可的执行不能撤回。暂停保留积压，满载返回 503，需人工 Redeliver。下面状态为收件/执行状态，不是 QQ 送达证明。" }),
    el("div", { className: "scroll" }, [el("table", {}, [
      el("thead", {}, [el("tr", {}, ["时间", "Delivery", "仓库 / 事件", "状态 / 原因"].map(text => el("th", { text })))]),
      el("tbody", {}, github.receipts.map(r => el("tr", {}, [
        el("td", { text: bjTime(r.received_at) }), el("td", { className: "mono", text: r.delivery_id }),
        el("td", { text: r.repository + " " + r.event + (r.action ? "." + r.action : "") }),
        el("td", { text: r.state + (r.reason ? " / " + r.reason : "") + (r.outcome ? " / " + r.outcome : "") }),
      ]))),
    ])]),
  ]);
  paginateChildren(card.querySelector("tbody")!, { key: "github-receipts" });
  return card;
}
function githubForm(snapshot: GitHubView) {
  const value = snapshot.value, settings = value.settings;
  const repositories = el("textarea", { rows: 4, placeholder: "owner/repo，每行一个；留空表示不监听" });
  repositories.value = value.repositories.join("\n");
  const repoChoices=snapshot.connections.installations.flatMap(b=>b.repositories.map(r=>({installationId:b.installationId,repositoryId:r.id,
    box:el("input",{type:"checkbox",checked:!!value.repositoryIds?.some(v=>v.installationId===b.installationId&&v.repositoryId===r.id)}),name:b.user.login+" / #"+b.installationId+" / "+r.name})));
  const repoList=paginatedBlock("github-authorized-repositories",repoChoices.map(r=>el("label",{},[r.box,el("span",{text:r.name+" #"+r.repositoryId})])));
  const installationChoices=paginatedBlock("github-installation-choices",snapshot.connections.installations.map(b=>{
    const rows=repoChoices.filter(r=>r.installationId===b.installationId);
    const box=el("input",{type:"checkbox",checked:rows.length>0&&rows.every(r=>r.box.checked),onchange:()=>{for(const row of rows)row.box.checked=box.checked;}});
    return el("label",{},[box,el("span",{text:"安装 #"+b.installationId+" · "+b.user.login+" · 全选 / 清空可见仓库"})]);
  }));
  const paused = el("input", { type: "checkbox", checked: value.paused });
  const merge = el("input", { type: "number", min: 0, max: 600, value: settings.mergeWindowS });
  const budget = el("input", { type: "number", min: 1, max: 100, value: settings.budgetPerHour });
  const quietStart = el("input", { type: "time", value: settings.quietHours?.start || "" });
  const quietEnd = el("input", { type: "time", value: settings.quietHours?.end || "" });
  const choices = CHOICES.map(name => ({ name, box: el("input", { type: "checkbox", checked: value.selections.includes(name) }) }));
  const label = (text: string, node: HTMLElement) => el("label", { className: "field" }, [el("span", { text }), node]);
  const form = el("details", { ontoggle: () => {
    if (form.open) state.editingSource = "github";
    else if (state.editingSource === "github") state.editingSource = null;
  } }, [
    el("summary", { text: "GitHub 事件设置" }),
    ...(snapshot.mode === "app" ? [installationChoices] : []),
    snapshot.mode === "app" ? repoList : label("监听仓库（空列表不会恢复默认值）", repositories),
    label("暂停", paused),
    el("div", { className: "row" }, choices.map(choice => label(choice.name, choice.box))),
    el("div", { className: "row" }, [label("合并秒数", merge), label("每小时预算", budget),
      label("安静时段开始（北京时间）", quietStart), label("结束", quietEnd)]),
    el("button", { type: "button", className: "btn primary", text: "保存允许列表与设置", onclick: async () => {
      const updatedSettings = { ...settings, mergeWindowS: Number(merge.value), budgetPerHour: Number(budget.value) };
      delete updatedSettings.quietHours;
      if (quietStart.value || quietEnd.value) updatedSettings.quietHours = { start: quietStart.value, end: quietEnd.value };
      try {
        await api("PUT", "/admin/github/config", { expectedRevision: snapshot.revision, value: {
          ...(snapshot.mode === "app" ? {repositoryIds:repoChoices.filter(r=>r.box.checked).map(({installationId,repositoryId})=>({installationId,repositoryId}))} : {}),
          repositories: repositories.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
          selections: choices.filter(choice => choice.box.checked).map(choice => choice.name),
          paused: paused.checked, settings: updatedSettings,
        } });
        state.editingSource = null; notice(snapshot.mode === "app" ? "已保存 App 仓库 ID 选择" : "已保存手工允许列表"); await loadSources();
      } catch (error) { fail(error); }
    } }),
    el("button", { type: "button", className: "btn", text: "放弃编辑并重新加载（冲突后）", onclick: () => { state.editingSource = null; loadSources().catch(fail); } }),
  ]);
  return form;
}
