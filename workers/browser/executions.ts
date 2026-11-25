import { executionNodes, exportExecution, type TreeNode } from "./execution-tree";
import { $, el, input } from "./dom";
import { bjTime, duration, fail } from "./app";
import { consoleView, cs, nf, purposes, statuses } from "./console";
import { readApi } from "./api";
import { openRequest, toolPayload } from "./request-detail";
import { ToolDetail } from "./request-contracts";
import {
  ExecutionAnalysis,
  PiPage,
  TraceDetail,
  TracePage,
  type Observation,
  type PiSpan,
  type TraceSummary,
} from "../src/requests/execution-contracts";

let revision = 0,
  selection = 0,
  until = 0,
  next: string | undefined;
let cursors: (string | undefined)[] = [];
type ExecutionScope = Partial<Record<"thread" | "actor" | "turn" | "model" | "purpose" | "status", string>>;
let scope: ExecutionScope = {};
let focusRecord: string | undefined;
function setScope(value: ExecutionScope) {
  scope = value;
  const labels = [value.thread, value.actor, value.turn, value.model, purposes[value.purpose ?? ""], statuses[value.status ?? ""]].filter(Boolean);
  $("execution-scope-label").textContent = labels.join(" · ");
  $("execution-scope").hidden = !labels.length;
}
export function openExecutions({record, range = "720", ...criteria}: ExecutionScope & {record?: string; range?: string}) {
  setScope(criteria);
  focusRecord = record;
  input("execution-search").value = record ?? "";
  input("execution-range").value = range;
  input("execution-outcome").value = "";
  consoleView("executions");
}
const hint = (text: string) => el("p", { className: "execution-hint", text });
const button = (text: string, action: () => void) =>
  el("button", { className: "request-link", type: "button", text, onclick: action });
const rate = (cached: number | null, total: number | null) =>
  cached === null || !total ? "—" : ((100 * cached) / total).toFixed(1) + "%";
const money = (n: number | null) => (n === null ? "—" : "$" + n.toLocaleString("en-US", { maximumFractionDigits: 5 }));
const timeRange = (started: number, ended: number | null) =>
  ended === null ? "进行中" : duration(Math.max(0, ended - started));
function metric(name: string, value: string) {
  return el("div", {}, [el("small", { text: name }), el("strong", { text: value })]);
}
function status(s: TraceSummary) {
  return s.failures ? "含异常" : s.running ? "进行中" : "已记录操作完成";
}
function pageButton(id: string, disabled: boolean) {
  ($(id) as HTMLButtonElement).disabled = disabled;
}

export function resetExecutions() {
  focusRecord = undefined;
  setScope({});
  revision++;
  selection++;
  cursors = [];
  next = undefined;
  $("execution-list").replaceChildren();
  $("execution-detail").replaceChildren();
  input("execution-search").value = "";
}
export async function loadExecutions(reset = true) {
  if (reset) {
    until = Date.now();
    cursors = [undefined];
  }
  const version = ++revision;
  selection++;
  next = undefined;
  const list = $("execution-list"),
    detail = $("execution-detail");
  list.replaceChildren(hint("正在查询…"));
  detail.replaceChildren();
  pageButton("execution-next", true);
  pageButton("execution-prev", cursors.length <= 1);
  const params = new URLSearchParams({
    since: String(until - Number(input("execution-range").value) * 3600000),
    until: String(until),
    q: input("execution-search").value.trim(),
    outcome: input("execution-outcome").value,
  });
  const cursor = cursors.at(-1);
  for (const [key, value] of Object.entries(scope)) if (value) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  try {
    const page = await readApi(TracePage, "GET", "/admin/agent-traces?" + params);
    if (version !== revision || cs.view !== "executions") return;
    next = page.next;
    pageButton("execution-next", !next);
    list.replaceChildren();
    if (!page.traces.length) {
      list.append(hint("当前条件下没有执行记录"));
      return;
    }
    for (const item of page.traces) {
      const node = el("button", { className: "execution-item", type: "button" }, [
        el("span", { className: "row" }, [
          el("strong", { text: item.thread }),
          el("small", { text: status(item), className: item.failures ? "error" : "" }),
        ]),
        el("code", { text: item.root }),
        el("small", { text: bjTime(item.started) + " · " + item.requests + " 次模型 · " + item.tools + " 次工具" }),
      ]);
      node.onclick = () => {
        for (const sibling of list.children) sibling.removeAttribute("aria-current");
        node.setAttribute("aria-current", "true");
        void selectExecution(item);
      };
      list.append(node);
    }
    (list.firstElementChild as HTMLButtonElement).click();
  } catch (error) {
    if (version === revision) {
      list.replaceChildren(hint("查询失败，可重新查询"));
      fail(error);
    }
  }
}

async function selectExecution(summary: TraceSummary) {
  const version = ++selection;
  const host = $("execution-detail");
  host.replaceChildren(
    el("div", { className: "section-head" }, [
      el("h2", { className: "h2", text: summary.thread }),
      el("code", { text: summary.root }),
    ]),
    el("div", { className: "execution-metrics" }, [
      metric("窗口内跨度", duration(summary.last - summary.started)),
      metric("模型 / 子 agent", summary.requests + " / " + summary.children),
      metric("缓存命中", rate(summary.cached, summary.cacheInput)),
      metric("已计价成本", money(summary.cost)),
    ]),
    el("p", {
      className: "small muted",
      text: `输入 ${nf(summary.input)} · 输出 ${nf(summary.output)} token · 缓存可测 ${summary.measured}/${summary.requests} · 可计价 ${summary.priced}/${summary.requests}`,
    }),
  );
  const analysis = el("details", { className: "execution-analysis" }, [
    el("summary", { text: "按 agent、模型与首轮 / 续轮分析" }),
  ]);
  const analysisBody = el("div", { className: "scroll" });
  analysis.append(analysisBody);
  host.append(analysis);
  let analysisLoading = false;
  analysis.ontoggle = async () => {
    if (!analysis.open || analysisLoading || analysisBody.childElementCount) return;
    analysisLoading = true;
    try {
      const params = new URLSearchParams({ thread: summary.thread, root: summary.root });
      const result = await readApi(ExecutionAnalysis, "GET", "/admin/agent-traces/analysis?" + params);
      if (!analysis.isConnected) return;
      const table = el("table", { className: "console-table" });
      table.append(
        el("thead", {}, [
          el(
            "tr",
            {},
            ["Agent / 模型", "回合内顺序", "调用", "输入 / 输出", "缓存命中", "可测", "平均耗时", "已计价成本"].map((text) =>
              el("th", { text }),
            ),
          ),
        ]),
      );
      const body = el("tbody");
      table.append(body);
      for (const g of result.groups) {
        const cells = [
          (g.actor === "thread" ? "主 agent" : g.actor.slice(0, 8)) + " / " + g.model,
          g.round === "first" ? "首轮" : "续轮",
          String(g.n),
          nf(g.input) + " / " + nf(g.output),
          rate(g.cached, g.cacheInput),
          g.measured + "/" + g.n,
          duration(g.ms === null ? null : Math.round(g.ms)),
          money(g.cost) + " (" + g.priced + "/" + g.n + ")",
        ];
        body.append(
          el(
            "tr",
            {},
            cells.map((text) => el("td", { text })),
          ),
        );
      }
      analysisBody.append(table);
      if (result.more) analysisBody.append(hint("仅展示前 100 个分组"));
    } catch (error) {
      if (analysis.isConnected) fail(error);
    } finally {
      analysisLoading = false;
    }
  };
  const tree = el("div", { className: "execution-tree" }),
    more = el("button", { className: "btn compact", type: "button", text: "加载更多节点" }),
    inspect = el("div", { className: "execution-evidence" });
  host.append(tree, more, inspect);
  more.hidden = true;
  const all: Observation[] = [];
  let cursor: string | undefined;
  let target = focusRecord;
  async function load() {
    more.disabled = true;
    const params = new URLSearchParams({ thread: summary.thread, root: summary.root });
    try {
      do {
        if (cursor) params.set("cursor", cursor);
        const part = await readApi(TraceDetail, "GET", "/admin/agent-traces/detail?" + params);
        if (version !== selection || cs.view !== "executions") return;
        all.push(...part.observations);
        cursor = part.next;
        if (!target || part.observations.some(row => row.id === target)) break;
      } while (cursor);
      more.hidden = cursor === undefined;
      renderTree(tree, all, summary, inspect);
      if (target) {
        const node = Array.from(tree.querySelectorAll<HTMLButtonElement>("[data-observation]")).find(b => b.dataset.observation === target);
        if (node) { node.click(); node.scrollIntoView?.({block:"nearest"}); }
        target = undefined;
      }
    } catch (error) {
      if (version === selection) {
        more.hidden = false;
        more.textContent = "重试加载";
        fail(error);
      }
    } finally {
      more.disabled = false;
    }
  }
  const download = button("导出执行链路 · OTLP JSON", async () => {
    download.disabled = true;
    download.textContent = "正在导出…";
    const active = () => version === selection && cs.view === "executions" && host.isConnected;
    try {
      const observations: Observation[] = [],
        native: PiSpan[] = [];
      const inputs = new Map<string, { actor: string; input: string }>();
      let next: string | undefined;
      do {
        const params = new URLSearchParams({ thread: summary.thread, root: summary.root });
        if (next) params.set("cursor", next);
        const page = await readApi(TraceDetail, "GET", "/admin/agent-traces/detail?" + params);
        if (!active()) return;
        observations.push(...page.observations);
        for (const row of page.observations) {
          for (const source of [row, row.target]) {
            if (source?.inputId)
              inputs.set(JSON.stringify([source.actor, source.inputId]), { actor: source.actor, input: source.inputId });
          }
        }
        next = page.next;
      } while (next);
      for (const source of inputs.values()) {
        const params = new URLSearchParams({ thread: summary.thread, ...source });
        let before: number | undefined;
        do {
          if (before) params.set("before", String(before));
          const page = await readApi(PiPage, "GET", "/admin/agent-traces/runtime?" + params);
          if (!active()) return;
          native.push(...page.spans);
          before = page.next;
        } while (before);
      }
      const packet = await exportExecution(summary, observations, native);
      if (!active()) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(packet)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "agent-trace.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (active()) fail(error);
    } finally {
      download.disabled = false;
      download.textContent = "导出执行链路 · OTLP JSON";
    }
  });
  host.append(download);
  more.onclick = () => void load();
  await load();
}
function renderTree(box: HTMLElement, rows: Observation[], summary: TraceSummary, inspect: HTMLElement) {
  const nodes = executionNodes(rows);
  const children = new Map<string, TreeNode[]>();
  for (const n of nodes.values()) {
    const parent = n.parent && nodes.has(n.parent) ? n.parent : "";
    const list = children.get(parent) ?? [];
    list.push(n);
    children.set(parent, list);
  }
  const earliest = Math.min(summary.started, ...rows.map((r) => r.started)),
    latest = Math.max(summary.last, ...rows.map((r) => r.ended ?? r.started));
  box.replaceChildren(
    el("div", { className: "execution-axis" }, [
      el("strong", { text: "调用树" }),
      el("span", { text: "0 ───── " + duration(latest - earliest) }),
    ]),
  );
  const seen = new Set<string>();
  function draw(node: TreeNode, depth: number) {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const bar = el("span", { className: "execution-bar" }),
      width = Math.max(1, latest - earliest);
    bar.style.marginLeft = Math.min(99, (100 * (node.start - earliest)) / width) + "%";
    bar.style.width = Math.max(0.8, (100 * ((node.end ?? latest) - node.start)) / width) + "%";
    const title = el("span", { className: "execution-node-title", text: node.title });
    title.style.paddingLeft = Math.min(7, depth) * 12 + "px";
    const row = el("button", { type: "button", className: "execution-node " + node.kind, title: node.title }, [
      title,
      el("span", { className: "execution-track" }, [bar]),
      el("small", { text: timeRange(node.start, node.end) }),
    ]);
    if (node.kind !== "agent" && node.row) row.dataset.observation = node.row.id;
    row.onclick = () => {
      box.querySelector('[aria-current="true"]')?.removeAttribute("aria-current");
      row.setAttribute("aria-current","true");
      if (node.row) showEvidence(inspect, node.row, node.kind, summary.thread);
    };
    box.append(row);
    for (const child of children.get(node.id) ?? []) draw(child, depth + 1);
  }
  for (const n of children.get("") ?? []) draw(n, 0);
  for (const n of nodes.values()) if (!seen.has(n.id)) draw(n, 0);
  if (!rows.length) box.append(hint("该执行的明细已过期"));
}
function showEvidence(host: HTMLElement, r: Observation, kind: string, thread: string) {
  const inner = el("div", {}),
    body = el("div", {});
  host.replaceChildren(inner);
  inner.append(
    el("h3", { text: kind === "agent" ? r.turn : r.label }),
    el("p", {
      className: "small muted",
      text: [r.actor, r.inputId, statuses[r.status] ?? r.status].filter(Boolean).join(" · "),
    }),
  );
  if (kind === "model") {
    inner.append(
      el("div", { className: "execution-metrics" }, [
        metric("输入 / 输出", nf(r.input) + " / " + nf(r.output)),
        metric("缓存读 / 写", nf(r.cached) + " / " + nf(r.written)),
        metric("首事件 / 调度等待", duration(r.firstEvent) + " / " + duration(r.alarmWait)),
        metric("推理 token", nf(r.reasoning)),
      ]),
      button("查看上下文、输入与输出", () => void openRequest(r.id)),
    );
    if (r.target) {
      const target = { ...r, actor: r.target.actor, inputId: r.target.inputId };
      inner.append(button("查看派出子任务的 Pi 记录", () => void runtime(body, thread, target)));
    }
    if (r.inputId) inner.append(button("查看本次模型调用的原生 span", () => void runtime(body, thread, r, true)));
  }
  if (kind === "turn" && r.timing)
    inner.append(
      el("div", { className: "execution-metrics" }, [
        metric("入队等待", duration(r.timing.queue)),
        metric("首次输出", duration(r.timing.firstVisible)),
        metric("投递等待", duration(r.timing.delivery)),
      ]),
    );
  if (kind === "tool")
    inner.append(
      button("查看工具参数与结果", async () => {
        try {
          const detail = await readApi(ToolDetail, "GET", "/admin/tools/" + encodeURIComponent(r.id));
          if (inner.isConnected) body.replaceChildren(toolPayload(detail));
        } catch (error) {
          if (inner.isConnected) fail(error);
        }
      }),
    );
  if (r.target) {
    const target = { ...r, actor: r.target.actor, inputId: r.target.inputId };
    inner.append(button("查看派出子任务的 Pi 记录", () => void runtime(body, thread, target)));
  }
  if (r.inputId) inner.append(button("查看本次输入的 Pi 阶段与事件", () => void runtime(body, thread, r)));
  inner.append(body);
}
async function runtime(host: HTMLElement, thread: string, r: Observation, onlyModel = false) {
  const box = el("div", {});
  host.replaceChildren(box);
  const data: PiSpan[] = [];
  async function load(before?: number) {
    const p = new URLSearchParams({ thread, actor: r.actor, input: r.inputId });
    if (before) p.set("before", String(before));
    if (onlyModel) p.set("request", r.id);
    try {
      const page = await readApi(PiPage, "GET", "/admin/agent-traces/runtime?" + p);
      if (!box.isConnected) return;
      data.push(...page.spans);
      box.replaceChildren();
      for (const s of data.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))) {
        const d = el("details", { className: "execution-span" }, [
          el("summary", { text: s.name + " · " + (s.attrs.phase ?? s.status) + " · " + duration(s.ended - s.started) }),
          el("code", { text: "Trace " + s.trace + " / Span " + s.id + (s.parent ? " / Parent " + s.parent : "") }),
          el("pre", { text: JSON.stringify(s.attrs, null, 2) }),
        ]);
        for (const event of s.events)
          d.append(
            el("div", { text: "+" + (event.at - s.started) + " ms · " + event.name + " " + JSON.stringify(event.attrs) }),
          );
        for (const link of s.links) d.append(el("code", { text: "关联 " + link.trace + " / " + link.id }));
        if (s.omitted) d.append(hint("有 " + s.omitted + " 项采集明细被省略"));
        box.append(d);
      }
      if (!data.length) box.append(hint("暂无 Pi 阶段记录（历史数据、尚未结算或已过期）"));
      if (page.next) {
        const more = button("更多 Pi 阶段", () => {
          more.disabled = true;
          void load(page.next);
        });
        box.append(more);
      }
    } catch (error) {
      if (box.isConnected) {
        box.replaceChildren(hint("Pi 阶段读取失败"));
        fail(error);
      }
    }
  }
  await load();
}
export function initExecutions() {
  $("execution-scope-clear").addEventListener("click", () => { setScope({}); void loadExecutions(); });
  $("execution-filters").addEventListener("submit", (event) => {
    event.preventDefault();
    focusRecord = undefined;
    void loadExecutions();
  });
  $("execution-prev").addEventListener("click", () => {
    if (cursors.length > 1) {
      cursors.pop();
      void loadExecutions(false);
    }
  });
  $("execution-next").addEventListener("click", () => {
    if (next) {
      cursors.push(next);
      void loadExecutions(false);
    }
  });
}
