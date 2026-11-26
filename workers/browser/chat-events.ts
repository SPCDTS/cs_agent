import { el } from "./dom";
import { githubTarget, githubItem, type GitHubTarget } from "./chat-github";

// 旧会话只保留 renderEventInput 生成的可展示文本，可能止于单条事件中途。
export type EventItem = { ref: string; actor: string; title: string; time: string; summary: string; github?: GitHubTarget };
type EventBatch = { source: string; count: number; time: string; items: EventItem[]; extra: number; tail: string };

export function readBatch(source: string, text: string): EventBatch | undefined {
  const lines = text.split("\n");
  const header = /^\[外部事件\] ([\w:-]+) · (?:新邮件|事件) (\d+) 件 · (\d\d-\d\d \d\d:\d\d)（北京时间）$/.exec(lines[0] ?? "");
  if (!header || (source !== "event" && source !== header[1])) return;
  const batch: EventBatch = { source: header[1]!, count: Number(header[2]), time: header[3]!, items: [], extra: 0, tail: "" };
  let index = 1;
  while (index < lines.length) {
    const line = lines[index]!;
    // 空批次仍有批次头与汇总行之间的换行。
    if (index === 1 && batch.count === 0 && line === "") { index++; continue; }
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
    batch.items.push({ ref, actor: sender.join(" · "), title: row[3]!, time: row[4]!, summary: snippet.slice(3),
      github: batch.source === "github" ? githubTarget(ref) : undefined });
    index += 2;
  }
  return batch;
}

function eventItem(source: string, item: EventItem) {
  if (item.github) return githubItem(item, item.github);
  const context = source === "gmail" ? item.actor : item.ref;
  return el("li", { className: "event-item" }, [
    el("div", { className: "event-byline" }, [
      el("span", {}, [context, source === "gmail" && item.ref ? el("small", { text: (context ? " · " : "") + "邮件 ID " + item.ref }) : null]),
      el("time", { title: "事件时间（北京时间）", text: item.time }),
    ]),
    el("h4", { text: item.title || (source === "gmail" ? "（无主题）" : "（无标题）") }),
    item.summary ? el("p", { text: item.summary }) : null,
    source !== "gmail" && item.actor ? el("small", { text: item.actor }) : null,
  ]);
}

export function eventContent(source: string, batch: EventBatch, key: string, open: boolean): HTMLElement {
  const unit = source === "gmail" ? "封邮件" : "条事件";
  const partial = batch.items.length < batch.count;
  const metadata: string[] = [];
  if (source === "event") metadata.push(batch.source);
  if (batch.count !== 1 || partial) metadata.push((partial ? "已展示 " + batch.items.length + " / " : "") + batch.count + " " + unit);
  return el("div", { className: "event-batch" }, [
    metadata.length ? el("div", { className: "event-count", text: metadata.join(" · ") }) : null,
    batch.items.length ? el("ul", { className: "event-items" }, batch.items.slice(0, 2).map(item => eventItem(source, item))) : null,
    batch.items.length > 2 ? el("details", { className: "event-more", "data-entry": key, open }, [
      el("summary", { text: "其余 " + (batch.items.length - 2) + " " + unit }),
      el("ul", { className: "event-items" }, batch.items.slice(2).map(item => eventItem(source, item))),
    ]) : null,
    batch.tail ? el("pre", { className: "event-remainder", text: batch.tail }) : null,
    batch.extra ? el("small", { className: "event-count", text: "另有 " + batch.extra + " 件未展开" }) : null,
  ]);
}
