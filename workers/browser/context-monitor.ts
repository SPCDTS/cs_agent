import { $, bjTime, el } from "./app";
import { readApi } from "./api";
import { cs, compact, nf } from "./console";
import { openRequest, percent } from "./request-detail";
import { ContextTimeline, type ContextRequestSummary } from "../src/requests/context-types";

let expanded = false, version = 0, loading = false, updatedAt = 0, signature = "";
let cursor: string | undefined, next: string | undefined, pages: (string | undefined)[] = [];
let points: ContextRequestSummary[] = [];
const target = () => cs.chat.thread + "/" + (cs.chat.kind === "thread" ? "thread" : cs.chat.id);

export function resetContextMonitor(clear = false) {
  version++; loading = false; updatedAt = 0; signature = ""; cursor = next = undefined; pages = []; points = [];
  if (clear) expanded = false;
  $("context-monitor-body").hidden = !expanded;
  $("context-monitor-toggle").setAttribute("aria-expanded", String(expanded));
  $("context-monitor-toggle").textContent = expanded ? "收起趋势" : "展开趋势";
  $("context-monitor-note").textContent = cs.chat.kind === "subagent" ? "当前子 agent 的独立上下文" : "当前主会话的上下文";
  $("context-monitor-chart").replaceChildren();
  $("context-monitor-selection").replaceChildren();
  if (!clear) void refreshContextMonitor(true);
}

export async function refreshContextMonitor(force = false) {
  if (!expanded || cs.view !== "chat" || document.hidden || loading || !force && (cursor || Date.now() - updatedAt < 10_000)) return;
  const requestVersion = ++version, scope = target(), epoch = cs.epoch;
  loading = true;
  $("context-monitor-note").textContent = "正在读取上下文用量…";
  const query = new URLSearchParams({ thread: cs.chat.thread, actor: cs.chat.kind === "thread" ? "thread" : cs.chat.id });
  if (cursor) query.set("cursor", cursor);
  try {
    const data = await readApi(ContextTimeline, "GET", "/admin/context-timeline?" + query);
    if (requestVersion !== version || scope !== target() || epoch !== cs.epoch) return;
    updatedAt = Date.now(); next = data.next; points = data.points;
    $("context-monitor-older").disabled = !next; $("context-monitor-newer").disabled = !pages.length;
    $("context-monitor-note").textContent = points.length ? "第 " + (pages.length + 1) + " 组 · " + points.length + " 次请求 · 输入 token 为上游实测" : "当前 agent 尚无模型请求记录";
    const changed = JSON.stringify(points);
    if (changed !== signature) { signature = changed; drawContextTrend(); }
  } catch {
    if (requestVersion === version) $("context-monitor-note").textContent = "上下文用量读取失败，点击刷新重试。";
  } finally { if (requestVersion === version) loading = false; }
}

const svgElement = (tag: string, attributes: Record<string, string>, text?: string) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};
function selection(point: ContextRequestSummary) {
  $("context-monitor-selection").replaceChildren(el("div", {}, [
    el("strong", { text: nf(point.inputTokens) + " 输入 token" }),
    el("span", { className: "muted small", text: " / " + compact(point.contextWindow) + " 窗口 · 缓存 " + percent(point.inputTokens && point.cacheRead !== null ? point.cacheRead / point.inputTokens : null) + " · " + point.model }),
  ]), el("button", { className: "btn compact", type: "button", text: "查看请求详情", onclick: () => openRequest(point.id) }));
}
export function drawContextTrend() {
  const host = $("context-monitor-chart"); host.replaceChildren();
  if (!points.length) return;
  const width = Math.max(240, host.clientWidth), height = 188, left = 51, right = width - 20, top = 14, bottom = 151;
  const first = points[0]!, last = points.at(-1)!;
  const maximum = Math.max(1, ...points.map(point => Math.max(point.inputTokens ?? 0, point.contextWindow)));
  const x = (point: ContextRequestSummary) => points.length === 1 ? (left + right) / 2 : left + points.indexOf(point) / (points.length - 1) * (right - left);
  const y = (value: number) => bottom - value / maximum * (bottom - top);
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, width: String(width), height: String(height), role: "img", "aria-label": "当前 agent 逐次请求的输入 token；虚线为上下文窗口，金色标记为已应用的压缩" });
  for (const value of [0, maximum / 2, maximum]) {
    svg.append(svgElement("line", { x1: String(left), x2: String(right), y1: String(y(value)), y2: String(y(value)), class: "context-grid" }),
      svgElement("text", { x: String(left - 7), y: String(y(value) + 4), "text-anchor": "end", class: "context-axis" }, compact(value)));
  }
  let path = "", connected = false;
  points.forEach((point, index) => {
    if (point.inputTokens === null) { connected = false; return; }
    path += (connected ? "L" : "M") + x(point) + " " + y(point.inputTokens) + " "; connected = true;
    const previous = points[index - 1], head = point.metrics?.head;
    if (previous?.metrics && head?.kind === "compaction" && head.id !== previous.metrics.head?.id) svg.append(
      svgElement("line", { x1: String(x(point)), x2: String(x(point)), y1: String(top), y2: String(bottom), class: "context-compaction-line" }),
      svgElement("text", { x: String(Math.min(right - 55, x(point) + 5)), y: String(top + 12), class: "context-axis" }, "应用压缩"));
  });
  const windowPath = points.map((point, index) => (index ? "L" : "M") + x(point) + " " + y(point.contextWindow)).join(" ");
  svg.append(svgElement("path", { d: windowPath, class: "context-window", fill: "none" }), svgElement("path", { d: path, class: "context-line", fill: "none" }));
  for (const [point, anchor] of [[first, "start"], [last, "end"]] as const) svg.append(svgElement("text", { x: String(x(point)), y: String(height - 7), "text-anchor": anchor, class: "context-axis" }, width < 420 ? bjTime(point.startedAt).slice(-5) : bjTime(point.startedAt)));
  host.append(svg);
  points.forEach(point => {
    const label = bjTime(point.startedAt) + " · 输入 " + nf(point.inputTokens) + (point.inputTokens === null ? "（未返回用量）" : " token");
    const button = el("button", { className: "context-point" + (point.inputTokens === null ? " unmeasured" : ""), type: "button",
      style: `left:${x(point) / width * 100}%;top:${point.inputTokens === null ? bottom : y(point.inputTokens)}px`, "aria-label": label, title: label,
      onclick: () => { selection(point); void openRequest(point.id); } });
    button.addEventListener("focus", () => selection(point)); host.append(button);
  });
  selection(last);
}

export function initContextMonitor() {
  $("context-monitor-toggle").addEventListener("click", () => {
    expanded = !expanded; $("context-monitor-body").hidden = !expanded;
    $("context-monitor-toggle").setAttribute("aria-expanded", String(expanded));
    $("context-monitor-toggle").textContent = expanded ? "收起趋势" : "展开趋势";
    if (expanded) { drawContextTrend(); void refreshContextMonitor(true); }
  });
  $("context-monitor-refresh").addEventListener("click", () => { cursor = next = undefined; pages = []; void refreshContextMonitor(true); });
  $("context-monitor-older").addEventListener("click", () => { if (next && !loading) { pages.push(cursor); cursor = next; void refreshContextMonitor(true); } });
  $("context-monitor-newer").addEventListener("click", () => { if (pages.length && !loading) { cursor = pages.pop(); void refreshContextMonitor(true); } });
  new ResizeObserver(() => { if (expanded && cs.view === "chat") drawContextTrend(); }).observe($("context-monitor-chart"));
}
