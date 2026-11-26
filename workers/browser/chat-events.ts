import { el } from "./dom";

// 旧会话只保留 renderEventInput 生成的可展示文本，可能止于单条事件中途。
type EventItem = { ref: string; actor: string; title: string; time: string; summary: string };
type EventBatch = { source: string; count: number; items: EventItem[]; extra: number; tail: string };

function readBatch(source: string, text: string): EventBatch | undefined {
  const lines = text.split("\n");
  const header = /^\[外部事件\] ([\w:-]+) · (?:新邮件|事件) (\d+) 件 · \d\d-\d\d \d\d:\d\d（北京时间）$/.exec(lines[0] ?? "");
  if (!header || (source !== "event" && source !== header[1])) return;
  const batch: EventBatch = { source: header[1]!, count: Number(header[2]), items: [], extra: 0, tail: "" };
  let index = 1;
  while (index < lines.length) {
    const line = lines[index]!;
    const overflow = /^\[另有 (\d+) 件未展开\]$/.exec(line);
    if (overflow && index === lines.length - 1) {
      batch.extra = Number(overflow[1]);
      break;
    }
    const row = /^(\d+)\. ref=(.*?) · 主题：(.*) · (\d\d-\d\d \d\d:\d\d)$/.exec(line);
    const snippet = lines[index + 1];
    if (!row || row[3]!.includes(" · 主题：") || Number(row[1]) !== batch.items.length + 1 || !snippet?.startsWith("   ")) {
      batch.tail = lines.slice(index).join("\n");
      break;
    }
    const [ref = "", ...sender] = row[2]!.split(" · ");
    batch.items.push({ ref, actor: sender.join(" · "), title: row[3]!, time: row[4]!, summary: snippet.slice(3) });
    index += 2;
  }
  return batch;
}

function githubRef(ref: string) {
  // 只为 Webhook 生成的 GitHub 仓库地址建立外链。其他引用按文本保留。
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[\w.-]+)(?:\/(pull|issues|actions\/runs|commit|releases)(?:\/([a-zA-Z0-9]+))?)?(?:#[\w-]+)?$/.exec(ref);
  if (!match || match[1]!.split("/").some(part => part === "." || part === "..")) return;
  const [, repo, type, id] = match;
  const labels: Record<string, string> = { pull: "PR #", issues: "Issue #", "actions/runs": "Run #", commit: "Commit ", releases: "Releases" };
  const label = type ? labels[type] + (type === "commit" ? id?.slice(0, 7) ?? "" : id ?? "") : "";
  return { repo: repo!, link: el("a", { href: ref, target: "_blank", rel: "noopener noreferrer", text: [repo, label].filter(Boolean).join(" · ") }) };
}

function eventItem(source: string, item: EventItem) {
  const target = source === "github" ? githubRef(item.ref) : undefined;
  const title = target && item.title.startsWith(target.repo + ": ") ? item.title.slice(target.repo.length + 2) : item.title;
  const context = source === "gmail" ? item.actor : target?.link ?? item.ref;
  const action = source === "github" ? githubAction(item.summary) : undefined;
  const excerpt = action ? action.excerpt : item.summary;
  return el("li", { className: "event-item" }, [
    el("div", { className: "event-byline" }, [
      context ? el("span", {}, [context]) : null,
      el("time", { title: "事件时间（北京时间）", text: item.time }),
    ]),
    el("h4", { text: title || (source === "gmail" ? "（无主题）" : "（无标题）") }),
    excerpt ? el("p", { text: excerpt }) : null,
    action || source !== "gmail" && item.actor ? el("div", { className: "event-activity" }, [
      action ? el("span", { className: "event-action " + action.tone, text: action.label }) : null,
      item.actor ? el("small", { text: item.actor }) : null,
    ]) : null,
  ]);
}

// 这些动作由 GitHub 来源放在摘要开头。未知动作或结论继续显示原文。
const actionLabels = new Map([["opened", "已打开"], ["reopened", "已重新打开"], ["closed", "已关闭"], ["published", "已发布"],
  ["created", "已创建"], ["submitted", "已提交"], ["edited", "已编辑"], ["completed", "已完成"], ["ready_for_review", "待评审"]]);
function githubAction(summary: string) {
  if (summary === "Repository push") return { label: "已推送", excerpt: "", tone: "" };
  const [prefix, ...rest] = summary.split(": ");
  const [verb, ...detail] = prefix!.split(" ");
  const label = actionLabels.get(verb!);
  if (!label) return;
  const result = detail.join(" ");
  if (verb === "completed" && (result === "success" || result === "failure")) {
    return { label: result === "success" ? "运行成功" : "运行失败", tone: result === "success" ? "ok" : "bad", excerpt: rest.join(": ") };
  }
  return { label: [label, result].filter(Boolean).join(" · "), tone: "", excerpt: rest.join(": ") };
}

export function eventContent(source: string, text: string, key: string, open: boolean): HTMLElement | undefined {
  const batch = readBatch(source, text);
  if (!batch) return;
  const unit = source === "gmail" ? "封邮件" : "条事件";
  const partial = batch.items.length < batch.count;
  return el("div", { className: "event-batch" }, [
    batch.count > 1 || source === "event" || partial ? el("div", { className: "event-count",
      text: [source === "event" ? batch.source : "", partial ? "已展示 " + batch.items.length + " / " + batch.count + " " + unit : batch.count + " " + unit].filter(Boolean).join(" · ") }) : null,
    batch.items.length ? el("ul", { className: "event-items" }, batch.items.slice(0, 2).map(item => eventItem(source, item))) : null,
    batch.items.length > 2 ? el("details", { className: "event-more", "data-entry": key, open }, [
      el("summary", { text: "其余 " + (batch.items.length - 2) + " " + unit }),
      el("ul", { className: "event-items" }, batch.items.slice(2).map(item => eventItem(source, item))),
    ]) : null,
    batch.tail ? el("pre", { className: "event-remainder", text: batch.tail }) : null,
    batch.extra ? el("small", { className: "event-count", text: "另有 " + batch.extra + " 件未展开" }) : null,
  ]);
}
