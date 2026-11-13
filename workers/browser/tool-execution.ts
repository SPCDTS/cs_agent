import { el, duration, fail } from "./app";
import { cs, requestPill } from "./console";
import { readApi } from "./api";
import * as C from "./request-contracts";
import { openRequest, structuredPart, toolCache, toolPayload } from "./request-detail";
import { paginatedBlock } from "./pagination";
import { executionReference, executionTools, toolChildren, type ExecutionReference, ToolExecution } from "../src/requests/tool-types";

export function toolRoots(tools: C.ToolSummary[]) {
  return tools.filter(tool => !tools.some(parent => parent.callId === tool.parentCallId && parent.binding.turnId === tool.binding.turnId
    && (parent.actor ?? "thread") === (tool.actor ?? "thread")));
}
async function readTool(tool: C.ToolSummary) {
  const data = toolCache.get(tool.id) ?? await readApi(C.ToolDetail, "GET", "/admin/tools/" + encodeURIComponent(tool.id));
  if (data.status !== "running") toolCache.set(tool.id, data);
  return data;
}
function toolSection(tool: C.ToolSummary, title: string, render: (detail: C.ToolDetail) => Node) {
  const content = el("div", { className: "message-block-content" }), box = el("details", { className: "message-block tool-section" }, [el("summary", { text: title }), content]);
  let loaded = false;
  box.addEventListener("toggle", async () => {
    if (!box.open || loaded) return;
    loaded = true; const epoch = cs.epoch;
    content.replaceChildren(el("p", { className: "muted small", text: "正在读取…" }));
    try {
      const data = await readTool(tool);
      if (box.isConnected && epoch === cs.epoch) content.replaceChildren(data.detailAvailable === false
        ? el("p", { className: "muted small", text: "正文已清理，执行状态仍可查看。" }) : render(data));
    } catch { loaded = false; if (box.isConnected) content.replaceChildren(el("p", { text: "读取失败，折叠后可重试。" })); }
  });
  return box;
}
function scriptSource(detail: C.ToolDetail) {
  if (detail.arguments && !detail.arguments.truncated) {
    try {
      const value: unknown = JSON.parse(detail.arguments.text);
      if (value && typeof value === "object" && "code" in value && typeof value.code === "string") return el("pre", { className: "tool-source", text: value.code });
    } catch { /* 脱敏或截断后的参数按已保存的文本展示。 */ }
  }
  return structuredPart(detail.arguments);
}

export function renderToolTrace(tool: C.ToolSummary, tools: C.ToolSummary[] = [tool], options: { root?: C.ToolSummary; ancestors?: ReadonlySet<string>; expanded?: ReadonlySet<string> } = {}): HTMLDetailsElement {
  const root = options.root ?? tool, ancestors = options.ancestors ?? new Set<string>();
  const children = toolChildren(tools, tool).filter(child => !ancestors.has(child.id) && child.id !== tool.id), codemode = tool.name === "codemode";
  const info = executionReference(tools, tool), content = el("div", { className: "message-block-content" });
  const box = el("details", { className: "message-block trace-tool execution-tool" + (codemode ? " execution-group" : ""), "data-tool": tool.id, open: options.expanded?.has(tool.id) ?? false }, [
    el("summary", {}, [
      el("span", { className: "execution-title" }, [el("strong", { text: codemode ? "CodeMode" : tool.name }),
        codemode ? el("span", { className: "execution-names", text: info.label || (tool.status === "running" ? "等待内部调用…" : "没有内部工具记录") })
          : tool.argumentPreview ? el("span", { className: "execution-argument", text: tool.argumentPreview }) : null]),
      el("span", { className: "execution-state" }, [codemode ? el("small", { text: info.calls ? info.calls + " 次内部调用" : "暂无内部记录" }) : null,
        info.failures ? el("span", { className: "pill bad", text: info.failures + " 次内部异常" }) : null,
        el("small", { text: tool.endedAt !== null ? duration(tool.endedAt - tool.startedAt) : tool.status === "running" ? "执行中" : "耗时未记录" }), requestPill(tool.status)]),
    ]), content,
  ]);
  if (tool.id !== root.id) {
    const span = Math.max(1, (root.endedAt ?? Date.now()) - root.startedAt), offset = Math.max(0, tool.startedAt - root.startedAt);
    const length = Math.max(0, (tool.endedAt ?? Date.now()) - tool.startedAt);
    box.querySelector("summary")?.append(el("span", { className: "execution-timing", title: "相对脚本开始 +" + duration(offset) }, [
      el("span", { style: "margin-left:" + Math.min(100, offset / span * 100) + "%;width:" + Math.max(0, Math.min(100 - offset / span * 100, length / span * 100)) + "%" }),
    ]));
  }
  let built = false;
  box.addEventListener("toggle", async () => {
    if (!box.open || built) return;
    built = true;
    if (codemode || children.length) {
      const seen = new Set(ancestors); seen.add(tool.id);
      content.append(el("p", { className: "muted small", text: "缩进表示父子调用；时间条表示相对开始时间，可重叠。内部结果仅供排查，未计入模型上下文。" }));
      if (children.length) content.append(el("div", { className: "execution-children" }, [paginatedBlock("execution:" + tool.id, children.map(child => renderToolTrace(child, tools, { root, ancestors: seen, expanded: options.expanded })))]));
      else content.append(el("p", { className: "muted small", text: "本次没有内部工具记录，可能只执行了脚本，或旧记录未采集 / 已清理。" }));
      content.append(toolSection(tool, codemode ? "脚本源码" : "调用参数", codemode ? scriptSource : detail => structuredPart(detail.arguments)),
        toolSection(tool, tool.parentCallId ? "返回给调用方的内容" : "返回给模型的内容", detail => el("div", {}, [structuredPart(detail.result),
          detail.structuredResult ? structuredPart(detail.structuredResult) : null])));
      return;
    }
    const epoch = cs.epoch;
    content.replaceChildren(el("p", { className: "muted small", text: "正在读取工具详情…" }));
    try { const detail = await readTool(tool); if (box.isConnected && epoch === cs.epoch) content.replaceChildren(toolPayload(detail)); }
    catch (error) { built = false; if (box.isConnected) content.replaceChildren(el("p", { text: "读取失败，折叠后可重试。" })); fail(error); }
  });
  return box;
}
export function renderToolForest(tools: C.ToolSummary[], key: string, focusId?: string) {
  const roots = toolRoots(tools), selected = roots.find(root => executionTools(tools, root).some(tool => tool.id === focusId));
  const ordered = selected ? [selected, ...roots.filter(root => root.id !== selected.id)] : roots;
  const nodes = ordered.map(root => renderToolTrace(root, tools));
  if (selected && nodes[0]) nodes[0].open = true;
  return paginatedBlock(key, nodes);
}
export function executionLink(reference: ExecutionReference) {
  const host = el("div", { className: "context-execution" }), button = el("button", { type: "button", className: "request-link",
    text: "查看原执行组" + (reference.calls ? " · " + reference.calls + " 次内部调用" : "") + (reference.failures ? " · " + reference.failures + " 次异常" : "") });
  host.append(button);
  button.addEventListener("click", async () => {
    button.disabled = true; const epoch = cs.epoch;
    try {
      const data = await readApi(ToolExecution, "GET", "/admin/tools/" + reference.id + "/execution");
      if (!host.isConnected || epoch !== cs.epoch) return;
      host.replaceChildren(el("p", { className: "muted small", text: "以下是产生该结果的执行记录；本次输入的字符数只统计上方模型实际收到的内容。" }), renderToolForest(data.tools, "context-execution:" + reference.id, data.rootId));
      const sourceRequestId = data.sourceRequestId;
      if (sourceRequestId) host.prepend(el("button", { className: "request-link", type: "button", text: "定位到发起调用的模型请求", onclick: () => openRequest(sourceRequestId, { execution: data.rootId }) }));
    } catch { button.disabled = false; button.textContent = "执行记录读取失败或已清理，点击重试"; }
  });
  return host;
}
