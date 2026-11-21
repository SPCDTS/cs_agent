import { $, el, loadEvents, loadMemory, loadModel, loadSchedules, loadSettings, loadSkills, loadSources } from "./app";
import { loadMcpServers } from "./mcp-servers";
import { loadAccess, loadAccessPersona } from "./access";

export const managementPages: Record<string, readonly [string, string] | undefined> = {
  models: ["模型与接入", "模型、账号、MCP 服务与 QQ 响应设置。"],
  memory: ["会话与记忆", "会话状态、人格、长期记忆与技能。"],
  operations: ["任务与事件", "定时任务、事件来源与审计记录。"],
  access: ["权限与运维", "发送授权、额度、保留期、告警与发送记录。"],
  workspace: ["工作区", "按需查看文件与子任务产物。"],
};

export const managementSubtabs: Record<string, ReadonlyArray<readonly [string, string]>> = {
  models: [["models-core", "模型与账号"], ["models-mcp", "MCP 与设备"], ["models-qq", "QQ 响应与状态"]],
  memory: [["memory-entries", "长期记忆"], ["memory-threads", "活跃会话"], ["memory-skills", "技能目录"], ["memory-persona", "全局人格"]],
  operations: [["ops-schedules", "定时任务"], ["ops-sources", "事件来源"], ["ops-events", "审计事件"]],
  access: [["access-grants-tab", "跨会话授权"], ["access-mcp-tab", "MCP 群授权与审批"], ["access-ops-tab", "额度与保留期"], ["access-logs-tab", "告警与发送账本"]],
};

const activeSubtabs: Record<string, string> = {
  models: "models-core",
  memory: "memory-entries",
  operations: "ops-schedules",
  access: "access-grants-tab",
};

const subtabTargets: Record<string, readonly [string, string]> = {
  "model-section": ["models", "models-core"],
  "mcp-section": ["models", "models-mcp"],
  "settings-section": ["models", "models-qq"],
  "overview-cards": ["models", "models-qq"],
  "memory-section": ["memory", "memory-entries"],
  "threads-section": ["memory", "memory-threads"],
  "skills-section": ["memory", "memory-skills"],
  "persona-section": ["memory", "memory-persona"],
  "schedules-section": ["operations", "ops-schedules"],
  "sources-section": ["operations", "ops-sources"],
  "events-section": ["operations", "ops-events"],
  "access-panel": ["access", "*"],
  "grants-section": ["access", "access-grants-tab"],
  "mcp-access-section": ["access", "access-mcp-tab"],
  "ops-section": ["access", "access-ops-tab"],
  "logs-section": ["access", "access-logs-tab"],
  "workspace-panel": ["workspace", "*"],
};

function applySubtab(view: string) {
  const tabs = managementSubtabs[view] || [];
  const active = activeSubtabs[view] || tabs[0]?.[0] || "*";
  const bar = $("manage-subtabs");
  bar.hidden = !tabs.length;
  bar.replaceChildren(...tabs.map(([id, label]) => el("button", {
    type: "button",
    className: "subtab",
    role: "tab",
    "aria-selected": String(id === active),
    text: label,
    onclick: () => {
      activeSubtabs[view] = id;
      applySubtab(view);
    },
  })));
  const page = document.querySelector<HTMLElement>(`.manage-page[data-management="${view}"]`);
  if (!page) return;
  for (const child of page.children) {
    if (child instanceof HTMLElement) {
      const target = child.dataset.subtab;
      child.hidden = Boolean(target && target !== "*" && target !== active);
    }
  }
}

export function selectManagementSubtab(view: string, subtab: string) {
  const tabs = managementSubtabs[view];
  if (!tabs || !tabs.some(([id]) => id === subtab)) return;
  activeSubtabs[view] = subtab;
  const page = document.querySelector<HTMLElement>(`.manage-page[data-management="${view}"]`);
  if (page && !page.hidden) applySubtab(view);
}

export function splitManagement() {
  const root = $("view-manage"), header = root.querySelector(".console-head");
  const pages = new Map(Object.keys(managementPages).map(key => [key, el("section", { className: "manage-page", "data-management": key, hidden: true })]));
  for (const node of [...root.children]) {
    if (node === header) continue;
    const mapped = subtabTargets[node.id] || ["models", "models-core"];
    if (node instanceof HTMLElement) node.dataset.subtab = mapped[1];
    pages.get(mapped[0])!.append(node);
  }
  root.append(...pages.values());
}

export function showManagement(view: string, subtab?: string) {
  const current = managementPages[view];
  $("view-manage").hidden = !current;
  if (subtab) selectManagementSubtab(view, subtab);
  for (const page of document.querySelectorAll<HTMLElement>("[data-management]")) page.hidden = page.dataset.management !== view;
  if (current) {
    $("view-manage").querySelector(".console-head h1")!.textContent = current[0];
    $("view-manage").querySelector(".console-head p")!.textContent = current[1];
    applySubtab(view);
  }
}

export function loadManagement(view: string) {
  if (view === "models") return Promise.all([loadSettings(), loadModel(), loadMcpServers()]);
  if (view === "memory") return Promise.all([loadMemory(), loadSkills(), loadAccessPersona()]);
  if (view === "operations") return Promise.all([loadEvents(), loadSchedules(), loadSources()]);
  if (view === "access") return loadAccess();
  return Promise.resolve();
}

export function initManagement() {
  splitManagement();
}
