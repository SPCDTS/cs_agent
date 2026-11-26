import { $, el, fail, pill, readToken, show, time } from "./app";
import { readApi } from "./api";
import {
  SkillRuntimeClearedSchema,
  SkillRuntimeGrantSavedSchema,
  SkillRuntimeOverviewSchema,
  type SkillRuntimeOverview,
} from "./integration-contracts";

let loadingVersion = 0;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function renderSkillCard(
  item: SkillRuntimeOverview["skills"][number],
  groups: SkillRuntimeOverview["groups"],
): HTMLElement {
  const header = el("div", { className: "row" }, [
    el("strong", { text: item.skill }),
    pill(item.enabled ? "已启用" : "已停用", item.enabled ? "ok" : "neutral"),
    item.deps ? el("span", { className: "pill neutral", text: `deps=${item.deps}` }) : null,
    el("span", { className: "muted small", text: `登录失效退出码 ${item.authExitCode}` }),
  ]);

  const actionNodes = item.actions.map(action =>
    el("div", { className: "row", style: "gap:6px" }, [
      el("span", { className: "mono", text: action.name }),
      action.ownerOnly ? el("span", { className: "pill warn", text: "仅主人" }) : el("span", { className: "pill neutral", text: "可授权群" }),
      el("span", { className: "muted small", text: `${action.timeoutSec}s · ${action.description}` }),
    ]),
  );

  let stateBox: HTMLElement;
  if ("error" in item.state) {
    stateBox = el("div", { className: "muted small", text: "加密登录态：暂时不可用" });
  } else {
    const clearBtn = el("button", { type: "button", className: "btn danger compact", text: "清空登录态" });
    clearBtn.disabled = item.state.fileCount === 0;
    clearBtn.addEventListener("click", async () => {
      if (clearBtn.dataset.confirming !== "1") {
        clearBtn.dataset.confirming = "1";
        clearBtn.textContent = "确认清空登录态？";
        return;
      }
      clearBtn.disabled = true;
      try {
        await readApi(SkillRuntimeClearedSchema, "POST", `/admin/skill-runtime/${encodeURIComponent(item.skill)}/state/clear`);
        show(`已清空 ${item.skill} 的加密登录态`, "info");
        await loadSkillRuntime();
      } catch (error) {
        clearBtn.dataset.confirming = "";
        clearBtn.textContent = "清空登录态";
        clearBtn.disabled = false;
        fail(error);
      }
    });
    const filesDetail = item.state.files.length
      ? el("details", {}, [
          el("summary", { text: `查看已加密状态文件（${item.state.fileCount} 个）` }),
          el("ul", { className: "stack flat-stack" }, item.state.files.map(file =>
            el("li", { className: "mono small", text: `${file.path} (${formatBytes(file.bytes)})` }),
          )),
        ])
      : el("div", { className: "muted small", text: "尚无已保存的登录态文件。" });
    stateBox = el("div", { className: "stack flat-stack" }, [
      el("div", { className: "row" }, [
        el("span", {
          className: "small",
          text: `加密登录态：${item.state.fileCount} 个文件 · ${formatBytes(item.state.totalBytes)}${item.state.updatedAt ? " · 更新于 " + time(item.state.updatedAt) : ""}`,
        }),
        el("div", { className: "grow" }),
        clearBtn,
      ]),
      filesDetail,
    ]);
  }

  const grantRows = item.grants.length
    ? item.grants.map(grant => {
        const groupLabel = groups.find(g => g.key === grant.group)?.name;
        const revokeBtn = el("button", { type: "button", className: "btn danger compact", text: "撤销" });
        revokeBtn.addEventListener("click", async () => {
          revokeBtn.disabled = true;
          try {
            await readApi(
              SkillRuntimeGrantSavedSchema,
              "PUT",
              `/admin/skill-runtime/${encodeURIComponent(item.skill)}/grants`,
              { group: grant.group, actions: [] },
            );
            show(`已撤销 ${grant.group} 对 ${item.skill} 的授权`, "info");
            await loadSkillRuntime();
          } catch (error) {
            revokeBtn.disabled = false;
            fail(error);
          }
        });
        return el("div", { className: "row" }, [
          el("span", { className: "mono", text: groupLabel ? `${groupLabel} (${grant.group})` : grant.group }),
          el("span", { className: "muted small", text: `动作：${grant.actions.join("、")}` }),
          el("div", { className: "grow" }),
          revokeBtn,
        ]);
      })
    : [el("div", { className: "muted small", text: "尚未授权任何群。" })];

  const shareableActions = item.actions.filter(a => !a.ownerOnly);
  const groupSelect = el("select", { "aria-label": `${item.skill} 目标群` }, [
    ...groups.map(g => el("option", { value: g.key, text: g.name ? `${g.name} · ${g.key}` : g.key })),
    el("option", { value: "__custom__", text: "手动输入 group:群号…" }),
  ]);
  const customInput = el("input", {
    type: "text",
    placeholder: "group:群号",
    hidden: groups.length > 0,
  });
  groupSelect.addEventListener("change", () => {
    customInput.hidden = groupSelect.value !== "__custom__";
  });

  const actionChecks = shareableActions.map(action => {
    const checkbox = el("input", { type: "checkbox", value: action.name });
    return {
      name: action.name,
      checkbox,
      label: el("label", { className: "row", style: "gap:4px" }, [checkbox, el("span", { className: "mono", text: action.name })]),
    };
  });

  const syncSelectedActions = () => {
    const target = groupSelect.value === "__custom__" ? customInput.value.trim() : groupSelect.value;
    const existing = item.grants.find(g => g.group === target);
    for (const check of actionChecks) {
      check.checkbox.checked = Boolean(existing?.actions.includes(check.name));
    }
  };
  groupSelect.addEventListener("change", syncSelectedActions);
  customInput.addEventListener("input", syncSelectedActions);
  syncSelectedActions();

  const saveBtn = el("button", { type: "submit", className: "btn primary compact", text: "保存群授权" });
  saveBtn.disabled = shareableActions.length === 0;
  const grantForm = el("form", { className: "stack flat-stack" }, [
    el("div", { className: "row" }, [groupSelect, customInput]),
    shareableActions.length
      ? el("div", { className: "row" }, actionChecks.map(c => c.label))
      : el("div", { className: "muted small", text: "该技能所有动作均标记为仅主人，不可授权给群。" }),
    el("div", { className: "row" }, [saveBtn]),
  ]);
  grantForm.addEventListener("submit", async event => {
    event.preventDefault();
    const group = (groupSelect.value === "__custom__" ? customInput.value : groupSelect.value).trim();
    if (!/^group:[1-9][0-9]{0,19}$/.test(group)) {
      show("请选择群或输入有效的 group:群号", "error");
      return;
    }
    const actions = actionChecks.filter(c => c.checkbox.checked).map(c => c.name);
    saveBtn.disabled = true;
    try {
      await readApi(
        SkillRuntimeGrantSavedSchema,
        "PUT",
        `/admin/skill-runtime/${encodeURIComponent(item.skill)}/grants`,
        { group, actions },
      );
      show(actions.length ? `已保存 ${group} 对 ${item.skill} 的授权` : `已撤销 ${group} 对 ${item.skill} 的授权`, "info");
      await loadSkillRuntime();
    } catch (error) {
      saveBtn.disabled = false;
      fail(error);
    }
  });

  return el("article", { className: "source stack" }, [
    header,
    el("div", { className: "muted small", text: item.description }),
    el("div", { className: "stack flat-stack" }, actionNodes),
    stateBox,
    el("div", { className: "stack flat-stack" }, [
      el("h3", { className: "sub-h3", text: "已授权群" }),
      ...grantRows,
      grantForm,
    ]),
  ]);
}

export async function loadSkillRuntime(): Promise<void> {
  if (!readToken() || !$("skill-runtime-list")) return;
  const version = ++loadingVersion;
  try {
    const data = await readApi(SkillRuntimeOverviewSchema, "GET", "/admin/skill-runtime");
    if (version !== loadingVersion) return;
    const container = $("skill-runtime-list");
    container.replaceChildren();
    if (!data.skills.length) {
      container.append(el("div", { className: "muted", text: "暂无配置了 runner.json 的受控技能。请在技能附件中添加 runner.json 后刷新。" }));
      return;
    }
    for (const item of data.skills) {
      container.append(renderSkillCard(item, data.groups));
    }
  } catch (error) {
    fail(error);
  }
}

export function initSkillRuntime(): void {
  const refresh = document.getElementById("skill-runtime-refresh");
  if (!refresh) return;
  refresh.addEventListener("click", () => { void loadSkillRuntime(); });
}
