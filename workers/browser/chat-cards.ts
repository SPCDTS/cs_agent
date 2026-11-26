import { bjTime, bytes } from "./app";
import { el } from "./dom";
import { eventContent, readBatch } from "./chat-events";
import { githubLabels } from "./chat-github";
import { icon } from "./chat-icon";
import { chatProse } from "./chat-prose";
import type { Asset, ChatMessage } from "./request-contracts";

const sources = {
  gmail: "Gmail 邮件", github: "GitHub 事件", event: "外部事件", qq: "QQ", web: "网页",
  model: "模型回答（非投递回执）", "agent-in": "Agent 收件", "agent-out": "Agent 发件", subagent: "子任务报告",
} as const;

function attachment(ref: Asset, download: (asset: Asset) => void) {
  return el("button", { type: "button", className: "chat-file", onclick: () => download(ref),
    "aria-label": "下载 " + ref.name }, [
    icon("file"), el("span", {}, [el("strong", { text: ref.name }), el("small", { text: bytes(ref.bytes) })]), icon("download"),
  ]);
}

function reportContent(text: string) {
  const header = /^\[子 agent (完成|失败|超时)\] id=(\S+) 任务：([^\n]*)\n/.exec(text);
  if (!header) return;
  return el("div", { className: "chat-report" }, [
    el("small", { className: header[1] === "完成" ? "report-done" : "report-error", text: "任务" + header[1] }),
    el("small", { className: "muted", text: "任务 ID " + header[2] }),
    el("h4", { text: header[3] }), chatProse(text.slice(header[0].length)),
  ]);
}

// QQ 历史里这些标记是消息的文字表示，只有 assets 中的条目能下载。
function qqContent(text: string) {
  const labels: Record<string, string> = { image: "图片", file: "文件", record: "语音", audio: "音频", video: "视频", face: "表情", forward: "合并转发", reply: "引用" };
  const body = el("div", { className: "chat-literal" });
  let offset = 0;
  for (const match of text.matchAll(/\[(image|file|record|audio|video|face|forward|reply)\]/g)) {
    body.append(text.slice(offset, match.index), el("span", { className: "chat-media-label", text: labels[match[1]!], title: match[0] }));
    offset = match.index + match[0].length;
  }
  if (!offset) return;
  body.append(text.slice(offset));
  return body;
}

export function chatCard(m: ChatMessage, status: string, download: (asset: Asset) => void, batchOpen: boolean) {
  const source = Object.hasOwn(sources, m.source) ? m.source as keyof typeof sources : undefined;
  const external = source === "gmail" || source === "github" || source === "event";
  const system = external || source === "agent-in" || source === "agent-out" || source === "subagent";
  const batch = external ? readBatch(source, m.text) : undefined;
  const kind = batch?.count === 1 && batch.items.length === 1 ? batch.items[0]?.github?.kind : undefined;
  const label = kind ? "GitHub · " + githubLabels[kind] : source ? sources[source] : "未知来源";
  const author = m.role === "assistant" ? "助手" : m.name || "用户";
  const mark = kind && kind !== "repository" ? kind : external ? source : source === "subagent" ? "subagent" : system ? "agent" : "chat";
  const statusTone = m.status === "failed" || m.status === "error" ? " bad" :
    m.status === "waiting" || m.status === "queued" || m.status === "unconfirmed" ? " warn" : "";
  const name = !system ? author : source === "agent-in" || source === "agent-out" ? m.name : "";
  const recordedAt = bjTime(m.at);
  const times = batch && batch.time !== recordedAt
    ? "批次 " + batch.time + " · 记录 " + (batch.time.slice(0, 5) === recordedAt.slice(0, 5) ? recordedAt.slice(6) : recordedAt)
    : recordedAt;
  const meta = el("header", { className: "message-meta" }, [
    el("span", { className: "message-source" }, [icon(mark), system ? label : name]),
    (system ? name : label) ? el("span", { className: "message-channel", text: system ? name : label }) : null,
    el("time", { title: "北京时间", text: times }),
    status ? el("span", { className: "message-status" + statusTone, text: status }) : null,
  ]);
  let content;
  if (external && batch) content = eventContent(source, batch, m.id, batchOpen);
  if (source === "subagent") content = reportContent(m.text);
  if (source === "qq") content = qqContent(m.text);
  if (!content && m.text) {
    if (!external && (m.role === "assistant" || system)) {
      content = chatProse(m.text);
    } else content = el("div", { className: "chat-literal", text: m.text });
  }
  return el("article", { className: "chat-message " + (system ? "system" : m.role === "assistant" ? "assistant" : "user"),
    "data-source": source ?? "unknown", "data-github-kind": kind }, [
    meta, el("div", { className: "chat-body" }, [
      content,
      m.assets.length ? el("div", { className: "chat-files" }, m.assets.map(ref => attachment(ref, download))) : null,
    ]),
  ]);
}
