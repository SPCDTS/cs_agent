import { CHOICES } from "../github/model";
export const GITHUB_APP_JS = String.raw`
  function renderGitHub(source, github) {
    const editing = state.editingSource === "github" && state.sourceForms.github;
    const form = editing || (state.sourceForms.github = githubForm(github));
    return el("div", { className: "source" }, [
      el("strong", { text: "GitHub webhook" }),
      el("div", { className: "muted small", text: (github.configured ? "Secret 已配置" : "Secret 未配置：拒收") +
        " · " + (source.paused ? "已暂停" : "已启用") + " · 收件 " + github.count + "/" + github.capacity + " · 待处理上限 " + github.pendingCapacity }),
      el("p", { text: "保存监听允许列表不等于注册 GitHub webhook；不会自动修改 GitHub。默认仅向 owner 私聊投递，外部正文不是指令。" }),
      el("p", { className: "muted small", text: "在 Worker secrets 配置 GITHUB_WEBHOOK_SECRET，再到仓库 Settings → Webhooks 添加 https://你的域名/github/webhook，选择 application/json 与相同 secret。仅选择下面启用的事件；详见 docs/GITHUB-EVENTS.md。" }),
      form,
      el("div", { className: "small", text: "仓库 ID 为首条通过过滤的已验签事件绑定（不是 GitHub API 验证）；删除后保留绑定，名称重用会被拒绝。当前绑定：" +
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
  }
  function githubForm(snapshot) {
    const value = snapshot.value, settings = value.settings;
    const repositories = el("textarea", { rows: 4, value: value.repositories.join("\n"), placeholder: "owner/repo，每行一个；留空表示不监听" });
    const paused = el("input", { type: "checkbox", checked: value.paused });
    const merge = el("input", { type: "number", min: 0, max: 600, value: settings.mergeWindowS });
    const budget = el("input", { type: "number", min: 1, max: 100, value: settings.budgetPerHour });
    const quietStart = el("input", { type: "time", value: settings.quietHours?.start || "" });
    const quietEnd = el("input", { type: "time", value: settings.quietHours?.end || "" });
    const choices = ${JSON.stringify(CHOICES)}.map(name => ({ name, box: el("input", { type: "checkbox", checked: value.selections.includes(name) }) }));
    const label = (text, node) => el("label", { className: "field" }, [el("span", { text }), node]);
    const form = el("details", { ontoggle: () => {
      if (form.open) state.editingSource = "github";
      else if (state.editingSource === "github") state.editingSource = null;
    } }, [
      el("summary", { text: "GitHub 事件设置" }),
      label("监听仓库（空列表不会恢复默认值）", repositories),
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
            repositories: repositories.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
            selections: choices.filter(choice => choice.box.checked).map(choice => choice.name),
            paused: paused.checked, settings: updatedSettings,
          } });
          state.editingSource = null; notice("已保存允许列表；尚未注册 GitHub webhook"); await loadSources();
        } catch (error) { fail(error); }
      } }),
      el("button", { type: "button", className: "btn", text: "放弃编辑并重新加载（冲突后）", onclick: () => { state.editingSource = null; loadSources().catch(fail); } }),
    ]);
    return form;
  }
`;
