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
  ]);

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
              { group: grant.group, enabled: false },
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
          pill("已授权共享状态", "ok"),
          el("div", { className: "grow" }),
          revokeBtn,
        ]);
      })
    : [el("div", { className: "muted small", text: "尚未授权任何群。" })];

  const groupSelect = el("select", { "aria-label": `${item.skill} 目标群` }, [
    ...groups.map(g => el("option", { value: g.key, text: g.name ? `${g.name} · ${g.key}` : g.key })),
    el("option", { value: "__custom__", text: "手动输入 group:群号…" }),
  ]);
  const customInput = el("input", {
    type: "text",
    placeholder: "group:群号",
    hidden: groups.length > 0,
  });
  const saveBtn = el("button", { type: "submit", className: "btn primary compact", text: "授权给该群" });
  const grantHint = el("span", { className: "muted small", text: "仅限完全信任群：授权后群可通过 skill_bash 共享该技能登录态" });

  const syncTargetState = () => {
    const target = (groupSelect.value === "__custom__" ? customInput.value : groupSelect.value).trim();
    const granted = item.grants.some(g => g.group === target);
    saveBtn.textContent = granted ? "刷新群授权" : "授权给该群";
  };
  groupSelect.addEventListener("change", () => {
    customInput.hidden = groupSelect.value !== "__custom__";
    syncTargetState();
  });
  customInput.addEventListener("input", syncTargetState);
  syncTargetState();

  const grantForm = el("form", { className: "stack flat-stack" }, [
    el("div", { className: "row" }, [groupSelect, customInput, saveBtn]),
    grantHint,
  ]);
  grantForm.addEventListener("submit", async event => {
    event.preventDefault();
    const group = (groupSelect.value === "__custom__" ? customInput.value : groupSelect.value).trim();
    if (!/^group:[1-9][0-9]{0,19}$/.test(group)) {
      show("请选择群或输入有效的 group:群号", "error");
      return;
    }
    saveBtn.disabled = true;
    try {
      await readApi(
        SkillRuntimeGrantSavedSchema,
        "PUT",
        `/admin/skill-runtime/${encodeURIComponent(item.skill)}/grants`,
        { group, enabled: true },
      );
      show(`已授权 ${group} 使用 ${item.skill} 共享登录态`, "info");
      await loadSkillRuntime();
    } catch (error) {
      saveBtn.disabled = false;
      fail(error);
    }
  });

  return el("article", { className: "source stack" }, [
    header,
    el("div", { className: "muted small", text: item.description }),
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
      container.append(el("div", { className: "muted", text: "暂无已创建的技能。请先在「会话与记忆 → 技能目录」添加技能后刷新。" }));
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
