import { bjTime, duration, el } from "./app";
import { readApi } from "./api";
import { compact, cs, nf } from "./console";
import { ContextInspection, totalChars, type ContextCategory, type ContextItem, type ContextTotals } from "../src/requests/context-types";
import * as C from "./request-contracts";
import { messageContent, openRequest, percent, structuredPart } from "./request-detail";
import { renderToolTrace } from "./trace";
import { ADMIN_PAGE_SIZE } from "../src/admin/pagination";
import { paginatedBlock } from "./pagination";

const categories: { id: ContextCategory; label: string }[] = [
  { id: "result", label: "工具结果" }, { id: "assistant", label: "助手消息" }, { id: "summary", label: "历史摘要" },
  { id: "tools", label: "工具定义" }, { id: "system", label: "系统提示" }, { id: "user", label: "用户消息" },
];
const categoryLabel = (id: ContextCategory) => categories.find(category => category.id === id)?.label ?? id;
const note = (text: string) => el("p", { className: "context-note", text });
const button = (text: string, onclick: () => void, className = "btn compact") => el("button", { type: "button", className, text, onclick });

export function deferredContextPart(requestId: string, item: Pick<ContextItem, "id" | "label" | "chars" | "truncated" | "bodyAvailable">) {
  const content = el("div", { className: "message-block-content" });
  const box = el("details", { className: "message-block context-part", "data-context-part": item.id }, [
    el("summary", {}, [el("span", { text: item.label }), el("small", { text: nf(item.chars) + " 字符" + (item.truncated ? " · 正文截断" : "") })]), content,
  ]);
  let loaded = false;
  box.addEventListener("toggle", async () => {
    if (!box.open || loaded) return;
    if (!item.bodyAvailable) { content.replaceChildren(note("这部分正文未保留；统计包含截断前的完整字符数。")); return; }
    loaded = true; const epoch = cs.epoch;
    content.replaceChildren(el("p", { className: "muted small", text: "正在读取正文…" }));
    try {
      const result = await readApi(C.ContextBody, "GET", "/admin/requests/" + encodeURIComponent(requestId) + "/context/" + item.id);
      if (!box.isConnected || epoch !== cs.epoch) return;
      content.replaceChildren(messageContent(result.part, new Map(result.paired.map(pair => [pair.id, pair.part]))));
      if (result.part.truncated) content.prepend(note("正文已截断；上方字符数为截断前的大小。"));
    } catch {
      loaded = false;
      content.replaceChildren(note("正文读取失败或已过保留期，折叠后可重试。"));
    }
  });
  return box;
}

function itemList(items: ContextItem[], requestId: string, preview = false) {
  const host = el("div", { className: "context-items" }); let page = 0, all = !preview;
  const render = () => {
    const ordered = all ? items : [...items].sort((a, b) => b.chars - a.chars), size = all ? ADMIN_PAGE_SIZE : 4;
    const shown = ordered.slice(page * size, page * size + size);
    host.replaceChildren(...shown.map(item => deferredContextPart(requestId, item)));
    if (!items.length) host.append(el("p", { className: "muted small", text: "没有这一类内容" }));
    if (all) {
      const prev = button("上一页", () => { page--; render(); }), next = button("下一页", () => { page++; render(); });
      prev.disabled = page === 0; next.disabled = (page + 1) * size >= items.length;
      host.append(el("div", { className: "pager" }, [el("span", { className: "muted small", text: "共 " + items.length + " 项 · 第 " + (page + 1) + " 页 · 每页 10 项" }), el("div", { className: "row" }, [prev, next])]));
    } else host.append(el("div", { className: "pager" }, [el("span", { className: "muted small", text: "显示最大的 " + shown.length + " 项 / 共 " + items.length + " 项" }), button("查看全部", () => { all = true; page = 0; render(); })]));
  };
  render(); return host;
}

type Rect = { id: ContextCategory; value: number; x: number; y: number; w: number; h: number };
export function contextRects(totals: ContextTotals): Rect[] {
  const values = categories.map(category => ({ id: category.id, value: totals[category.id] })).filter(item => item.value > 0).sort((a, b) => b.value - a.value);
  const divide = (items: typeof values, x: number, y: number, w: number, h: number): Rect[] => {
    if (!items.length) return [];
    if (items.length === 1) return [{ ...items[0]!, x, y, w, h }];
    const total = items.reduce((sum, item) => sum + item.value, 0);
    let count = 1, size = items[0]!.value;
    while (count < items.length - 1 && Math.abs(total / 2 - size - items[count]!.value) < Math.abs(total / 2 - size)) size += items[count++]!.value;
    const ratio = size / total;
    return w >= h ? [...divide(items.slice(0, count), x, y, w * ratio, h), ...divide(items.slice(count), x + w * ratio, y, w * (1 - ratio), h)]
      : [...divide(items.slice(0, count), x, y, w, h * ratio), ...divide(items.slice(count), x, y + h * ratio, w, h * (1 - ratio))];
  };
  return divide(values, 0, 0, 100, 100);
}

export function contextInspector(detail: C.RequestDetail) {
  const host = el("section", { className: "context-inspector" }, [note("正在读取上下文分析…")]), epoch = cs.epoch;
  void readApi(ContextInspection, "GET", "/admin/requests/" + encodeURIComponent(detail.request.id) + "/context").then(data => {
    if (host.isConnected && epoch === cs.epoch) renderInspector(host, detail, data);
  }).catch(() => { if (host.isConnected && epoch === cs.epoch) host.replaceChildren(note("上下文分析读取失败，请重新打开请求。")); });
  return host;
}

function renderInspector(host: HTMLElement, detail: C.RequestDetail, data: ContextInspection) {
  const r = data.current, analysis = data.analysis, previous = data.previous;
  const reset = r.metrics?.head?.kind === "reset" && r.metrics.head.id !== previous?.metrics?.head?.id;
  const comparable = !!previous && previous.model === r.model && previous.provider === r.provider && !reset;
  const delta = comparable && previous.inputTokens !== null && r.inputTokens !== null && previous.inputTokens > 0 ? (r.inputTokens - previous.inputTokens) / previous.inputTokens : null;
  const overview = el("div", { className: "context-request-meta" }, [
    el("span", { text: "窗口占用 " + percent(r.inputTokens !== null && r.contextWindow > 0 ? r.inputTokens / r.contextWindow : null) + " / " + compact(r.contextWindow) }),
    el("span", { text: "较前次 " + (delta === null ? "—" : (delta > 0 ? "+" : "") + percent(delta)) }),
    previous ? button("前一次请求", () => { void openRequest(previous.id); }, "request-link") : null,
  ]);
  const tabs = el("nav", { className: "context-tabs", "aria-label": "请求分析" }), content = el("div", { className: "context-tab-body" });
  type Tab = "composition" | "diff" | "compaction" | "output" | "raw";
  let active: Tab = "composition", category: ContextCategory | undefined;
  const buttons = new Map<Tab, HTMLButtonElement>();
  const show = (tab: Tab) => {
    active = tab; for (const [key, node] of buttons) node.setAttribute("aria-pressed", String(tab === key));
    content.replaceChildren();
    if (tab === "raw") { renderRaw(content, detail.request.id); return; }
    if (tab === "output") {
      if (detail.responseAvailable || detail.response) content.append(deferredContextPart(r.id, { id: "response", label: "本次模型输出", chars: detail.response?.chars ?? 0, truncated: false, bodyAvailable: true }));
      else content.append(note(detail.request.status === "running" ? "模型仍在生成。" : "本次模型输出未保留。"));
      if (detail.tools.length) content.append(el("h3", { text: "调用后的工具执行" }), paginatedBlock("context-tools:" + r.id, detail.tools.map(renderToolTrace)));
      else if (detail.request.toolCalls?.length) content.append(note("这次模型返回了工具调用；执行明细尚未采集，输入里的工具结果可在上下文组成中查看。"));
      return;
    }
    if (!analysis) {
      content.append(note(detail.detailAvailable ? "这条旧记录没有采集逐项统计。可在原始快照中查看当时保留的内容；新请求将显示完整分析。" : "分析详情已过保留期或被容量清理，请求用量仍可查看。")); return;
    }
    const metrics = analysis.metrics;
    if (tab === "diff") {
      if (!data.comparison) { content.append(note("前一次请求的明细未采集或已清理，无法还原逐项变化。")); return; }
      const comparison = data.comparison;
      const added = comparison.added.reduce((n, item) => n + item.chars, 0), removed = comparison.removed.reduce((n, item) => n + item.chars, 0);
      content.append(el("div", { className: "context-diff-stats" }, [
        el("div", {}, ["新增 / 替换后", el("strong", { text: "+" + nf(added) })]),
        el("div", {}, ["移除 / 替换前", el("strong", { text: "−" + nf(removed) })]),
        el("div", {}, ["保持不变", el("strong", { text: nf(comparison.kept) })]),
      ]), note(comparison.reset ? "上下文已重置；这里展示重置前后的字符变化。" : comparison.compactionApplied ? "本次首次使用新的历史摘要；这里对比同一 agent 的相邻请求。" : "按内容指纹配对；修改显示为移除旧内容并加入新内容。单位为字符。"));
      if (!comparable) content.append(note("模型切换或上下文重置，不计算输入 token 的变化率。"));
      content.append(el("h3", { text: "新增或修改后的内容" }), itemList(comparison.added, r.id), el("h3", { text: "移除或修改前的内容" }), itemList(comparison.removed, previous?.id ?? r.id));
      return;
    }
    if (tab === "compaction") {
      const head = metrics.head;
      if (head?.kind !== "compaction") { content.append(note(head?.kind === "reset" ? "本次上下文来自会话重置，没有应用压缩摘要。" : "本次请求未携带已确认的压缩摘要。")); return; }
      const plan = head.plan;
      content.append(note(data.comparison?.compactionApplied ? "这是应用该摘要后的首次已记录请求。" : data.comparison ? "本次继续使用这份历史摘要；不代表每一轮都发生了压缩。" : "本次包含引擎确认的历史摘要；缺少前次明细，无法判定是否首次使用。"));
      const phases: [string, string][] = [["选择压缩范围", plan ? bjTime(plan.startedAt) : "开始时间未采集"], ["摘要生成", head.at ? bjTime(head.at) : "时间未采集"], ["用于本次请求", bjTime(r.startedAt)]];
      content.append(el("ol", { className: "context-compaction-phases" }, phases.map(([name, value]) => el("li", {}, [el("strong", { text: name }), el("span", { text: value })]))));
      const rows: [string, number | undefined][] = [["被摘要替换的历史", plan?.summarizedChars], ["生成的历史摘要", metrics.chars.summary],
        ["本次仍保留的消息", metrics.retainedChars], ["范围选定后新增的消息", metrics.addedChars], ["系统提示与工具定义", metrics.chars.system + metrics.chars.tools]];
      content.append(el("dl", { className: "context-ledger" }, rows.map(([label, value]) => el("div", {}, [el("dt", { text: label }), el("dd", { text: nf(value) + (value === undefined ? "（未采集）" : " 字符") })]))));
      if (plan) content.append(note("选择时保留 " + plan.retainedMessages + " 条消息、" + nf(plan.retainedChars) + " 字符；从选定范围到生成摘要耗时 " + duration(Math.max(0, head.at - plan.startedAt)) + "。"));
      const summarySize = metrics.chars.summary, messagesSize = summarySize + (metrics.retainedChars ?? 0) + (metrics.addedChars ?? 0);
      if (metrics.retainedChars !== undefined && metrics.addedChars !== undefined && messagesSize) content.append(el("div", { className: "context-allocation", "aria-label": "摘要、保留消息和新增消息的字符占比" }, [
        el("span", { className: "category-summary", style: "flex:" + summarySize, title: "摘要 " + nf(summarySize) }),
        el("span", { className: "category-assistant", style: "flex:" + metrics.retainedChars, title: "保留 " + nf(metrics.retainedChars) }),
        el("span", { className: "category-result", style: "flex:" + metrics.addedChars, title: "新增 " + nf(metrics.addedChars) }),
      ]));
      const big = analysis.items.filter(item => item.category === "result").sort((a, b) => b.chars - a.chars)[0];
      if (big) { content.append(el("h3", { text: "压缩后最大的工具结果" }), deferredContextPart(r.id, big)); }
      return;
    }
    const total = totalChars(metrics.chars), map = el("div", { className: "context-treemap", "aria-label": "按字符数划分上下文组成" });
    const choose = (value: ContextCategory) => { category = category === value ? undefined : value; show(active); };
    for (const rect of contextRects(metrics.chars)) {
      const label = categoryLabel(rect.id), small = rect.w < 14 || rect.h < 32;
      map.append(el("button", { type: "button", className: "context-tile category-" + rect.id + (small ? " context-tile-small" : ""),
        style: `left:${rect.x}%;top:${rect.y}%;width:${rect.w}%;height:${rect.h}%`, "aria-pressed": String(category === rect.id),
        "aria-label": label + " " + nf(rect.value) + " 字符", title: label + " · " + nf(rect.value) + " 字符", onclick: () => choose(rect.id) }, [
        el("span", { text: label }), el("strong", { text: compact(rect.value) }), el("small", { text: percent(total ? rect.value / total : null) }),
      ]));
    }
    content.append(el("div", { className: "panel-title" }, [el("h3", { text: "什么占了上下文" }), el("span", { className: "muted small", text: nf(total) + " 字符 · 点击筛选" })]), map,
      el("div", { className: "context-legend" }, categories.map(item => button(item.label + " " + compact(metrics.chars[item.id]), () => choose(item.id), "context-category category-" + item.id))),
      el("p", { className: "muted small", text: "字符数统计归一化文本，不等同于 token；图片和推理正文只保留占位。图片 " + metrics.imageCount + " 张。" }));
    content.append(el("div", { className: "panel-title" }, [el("h3", { text: category ? categoryLabel(category) : "占用最大的内容" }),
      category ? button("清除筛选", () => { category = undefined; show(active); }, "request-link") : null]));
    content.append(itemList(analysis.items.filter(item => !category || item.category === category), r.id, !category));
  };
  for (const [id, label] of [["composition", "上下文组成"], ["diff", "前后变化"], ["compaction", "压缩过程"], ["output", "输出与工具"], ["raw", "原始快照"]] as const) {
    const node = button(label, () => show(id), "context-tab"); buttons.set(id, node); tabs.append(node);
  }
  host.replaceChildren(overview, tabs, content); show(active);
}

function renderRaw(host: HTMLElement, id: string) {
  const epoch = cs.epoch, result = el("div", {}, [note("正在读取原始快照…")]); host.append(result);
  void readApi(C.RequestDetail, "GET", "/admin/requests/" + encodeURIComponent(id)).then(value => {
    if (!result.isConnected || epoch !== cs.epoch) return;
    result.replaceChildren(structuredPart({ text: JSON.stringify(value, null, 2) }));
  }).catch(() => { if (result.isConnected && epoch === cs.epoch) result.replaceChildren(note("原始快照读取失败。")); });
}
