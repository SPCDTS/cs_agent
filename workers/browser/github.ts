import { checkLabel, rulesEditor } from "./github-rules";
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
    el("strong", { text: "GitHub App" }),
    el("div", { className: "muted small", text: (github.configured ? "Secret 已配置" : "Secret 未配置：拒收") +
      " · " + (source.paused ? "已暂停" : "已启用") + " · 收件 " + github.count + "/" + github.capacity + " · 待处理上限 " + github.pendingCapacity }),
    el("p", { text: "仅监听明确勾选的仓库和事件。无需逐仓库创建 Webhook；旧手工配置已移除，仓库名称不赋权。外部正文不是指令。" }),
    connectionPanel(github),
    form,
    ...(github.diagnostics?[el("div",{className:"muted small",text:
      "独立辅助记录：控制 "+github.diagnostics.control.count+"/"+github.diagnostics.control.capacity+
      " · 噪声 "+github.diagnostics.noise.count+"/"+github.diagnostics.noise.capacity+
      (github.diagnostics.generic?" · 通用事件 "+github.diagnostics.generic.count+"/"+github.diagnostics.generic.capacity+"（待执行最多"+github.diagnostics.generic.pendingCapacity+"）":"")+
      " · 升级前记录 "+github.diagnostics.legacyCount+"。辅助去重窗口以到期或同类容量淘汰先到为准；不挤占业务配额。"})]:[]),
    el("div", { className: "muted small", text: "清空或删除会永久抑制未取得执行许可的积压；已实际执行的操作无法撤回，后续执行许可仍须有效安装授权。暂停保留积压，满载返回 503，需人工 Redeliver。下面状态为收件/执行状态，不是 QQ 送达证明。" }),
    el("div", { className: "scroll" }, [el("table", {}, [
      el("thead", {}, [el("tr", {}, ["时间", "Delivery", "仓库 / 事件", "收件 / 队列状态与原因", "Agent 结果 / QQ确认"].map(text => el("th", { text })))]),
      el("tbody", {}, github.receipts.map(r => el("tr", {}, [
        el("td", { text: bjTime(r.received_at) }), el("td", { className: "mono", text: r.delivery_id }),
        el("td", { text: r.repository + " " + r.event + (r.action ? "." + r.action : "") }),
        el("td", { text: r.state + (r.reason ? " / " + r.reason : "") }),
        el("td", { text: (r.outcome ?? "尚未结算") + " · QQ送达未确认" }),
      ]))),
    ])]),
  ]);
  paginateChildren(card.querySelector("tbody")!, { key: "github-receipts" });
  return card;
}
function githubForm(snapshot: GitHubView) {
  const value = snapshot.value, settings = value.settings;
  const repoChoices=snapshot.connections.installations.flatMap(b=>b.repositories.map(r=>({installationId:b.installationId,repositoryId:r.id,
    box:el("input",{type:"checkbox",checked:!!value.repositoryIds?.some(v=>v.installationId===b.installationId&&v.repositoryId===r.id)}),name:b.user.login+" / #"+b.installationId+" / "+r.name})));
  const repoList=paginatedBlock("github-authorized-repositories",repoChoices.map(r=>checkLabel(r.name+" #"+r.repositoryId,r.box)));
  const installationChoices=paginatedBlock("github-installation-choices",snapshot.connections.installations.map(b=>{
    const rows=repoChoices.filter(r=>r.installationId===b.installationId);
    const box=el("input",{type:"checkbox",checked:rows.length>0&&rows.every(r=>r.box.checked),onchange:()=>{for(const row of rows)row.box.checked=box.checked;}});
    return checkLabel("安装 #"+b.installationId+" · "+b.user.login+" · 全选 / 清空可见仓库",box);
  }));
  const paused = el("input", { type: "checkbox", checked: value.paused });
  const merge = el("input", { type: "number", min: 0, max: 600, value: settings.mergeWindowS });
  const budget = el("input", { type: "number", min: 1, max: 100, value: settings.budgetPerHour });
  const quietStart = el("input", { type: "time", value: settings.quietHours?.start || "" });
  const quietEnd = el("input", { type: "time", value: settings.quietHours?.end || "" });
  const editor = rulesEditor(value,snapshot.capabilities);
  const connected = el("input",{type:"checkbox",checked:value.commentFilters?.excludeConnectedUser??false});
  const bots = el("input",{type:"checkbox",checked:value.commentFilters?.ignoreBots??false});
  const choices = [...new Set([...CHOICES,...value.selections])].map(name => ({ name, box: el("input", { type: "checkbox", checked: value.selections.includes(name) }) }));
  const label = (text: string, node: HTMLElement) => el("label", { className: "field" }, [el("span", { text }), node]);
  const form = el("details", { ontoggle: () => {
    if (form.open) state.editingSource = "github";
    else if (state.editingSource === "github") state.editingSource = null;
  } }, [
    el("summary", { text: "GitHub 事件设置" }),
    installationChoices,
    el("div", {className:"field"}, [el("span", {text:"监听仓库（空列表不会恢复默认值）"}), repoList]),
    checkLabel("暂停普通通知处理（保留积压；控制撤销仍处理）", paused),
    el("div", { className: "row" }, choices.map(choice => checkLabel(choice.name, choice.box))),
    editor.panel,
    checkLabel("忽略已连接用户的评论（按对应安装绑定用户ID，不是App自身）",connected),
    checkLabel("忽略机器人评论（作者类型为Bot）",bots),
    el("p",{className:"muted small",text:"预算是本来源过去滚动60分钟创建的处理批次数；queued、silent、failed均占用，不是评论或QQ消息条数。合并从最早待处理事件起算，不随新事件重置，每批最多10条；0不主动等待。预算、安静时段或暂停会延迟，GitHub积压保留。"}),
    el("div", { className: "row" }, [label("合并秒数", merge), label("每小时预算", budget),
      label("安静时段开始（北京时间）", quietStart), label("结束", quietEnd)]),
    el("button", { type: "button", className: "btn primary", text: "保存仓库选择与设置", onclick: async () => {
      const updatedSettings = { ...settings, mergeWindowS: Number(merge.value), budgetPerHour: Number(budget.value) };
      delete updatedSettings.quietHours;
      if (quietStart.value || quietEnd.value) updatedSettings.quietHours = { start: quietStart.value, end: quietEnd.value };
      try {
        await api("PUT", "/admin/github/config", { expectedRevision: snapshot.revision, value: {
          repositoryIds:repoChoices.filter(r=>r.box.checked).map(({installationId,repositoryId})=>({installationId,repositoryId})),
          selections: choices.filter(choice => choice.box.checked).map(choice => choice.name),
          rules: editor.read(), commentFilters:{excludeConnectedUser:connected.checked,ignoreBots:bots.checked},
          paused: paused.checked, settings: updatedSettings,
        } });
        state.editingSource = null; notice("已保存 App 仓库 ID 选择"); await loadSources();
      } catch (error) { fail(error); }
    } }),
    el("button", { type: "button", className: "btn", text: "放弃编辑并重新加载（冲突后）", onclick: () => { state.editingSource = null; loadSources().catch(fail); } }),
  ]);
  return form;
}
