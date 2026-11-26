import { bjTime, bytes } from "./app";
import { el } from "./dom";
import { eventContent } from "./chat-events";
import { chatProse } from "./chat-prose";
import type { Asset, ChatMessage } from "./request-contracts";

const sources = {
  gmail: "Gmail 邮件", github: "GitHub 事件", event: "外部事件", qq: "QQ", web: "网页",
  model: "模型回答（非投递回执）", "agent-in": "Agent 收件", "agent-out": "Agent 发件", subagent: "子任务报告",
} as const;

const paths = {
  gmail: "M3 6h18v13H3z M3 7l9 7 9-7",
  github: "M6 8v8 M9 18h4a5 5 0 005-5V8 M6 3a2.5 2.5 0 100 5 2.5 2.5 0 000-5 M6 16a2.5 2.5 0 100 5 2.5 2.5 0 000-5 M18 3a2.5 2.5 0 100 5 2.5 2.5 0 000-5",
  event: "M4 5h16v14H4z M7 10h3l2-3 2 7 2-4h2",
  chat: "M4 4h16v13H9l-5 4z M8 9h8 M8 12h5",
  agent: "M3 7h15m-4-4 4 4-4 4 M21 17H6m4-4-4 4 4 4",
  subagent: "M4 4h6v5H4z M14 15h6v5h-6z M7 9v8h7",
  file: "M5 3h9l5 5v13H5z M14 3v6h5 M8 14h8 M8 17h5",
  download: "M12 3v12m-5-5 5 5 5-5 M4 16v4h16v-4",
} as const;

function icon(key: keyof typeof paths) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", paths[key]);
  svg.append(path);
  return svg;
}

function attachment(ref: Asset, download: (asset: Asset) => void) {
  return el("button", { type: "button", className: "chat-file", onclick: () => download(ref),
    "aria-label": "下载 " + ref.name }, [
    icon("file"), el("span", {}, [el("strong", { text: ref.name }), el("small", { text: bytes(ref.bytes) })]), icon("download"),
  ]);
}

function reportContent(text: string) {
  const header = /^\[子 agent (完成|失败|超时)\] id=\S+ 任务：([^\n]*)\n/.exec(text);
  if (!header) return;
  return el("div", { className: "chat-report" }, [
    el("small", { className: header[1] === "完成" ? "report-done" : "report-error", text: "任务" + header[1] }),
    el("h4", { text: header[2] }), chatProse(text.slice(header[0].length)),
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

export function rawMessage(key: string, text: string, open: boolean) {
  return el("details", { className: "chat-original", "data-entry": key, open }, [
    el("summary", { text: "查看原文" }), el("pre", { text }),
  ]);
}

export function chatCard(m: ChatMessage, status: string, download: (asset: Asset) => void, expanded: ReadonlySet<string | undefined>) {
  const source = Object.hasOwn(sources, m.source) ? m.source as keyof typeof sources : undefined;
  const external = source === "gmail" || source === "github" || source === "event";
  const system = external || source === "agent-in" || source === "agent-out" || source === "subagent";
  const label = source ? sources[source] : "未知来源";
  const author = m.role === "assistant" ? "助手" : m.name || "用户";
  const mark = external ? source : source === "subagent" ? "subagent" : system ? "agent" : "chat";
  const statusTone = m.status === "failed" || m.status === "error" ? " bad" :
    m.status === "waiting" || m.status === "queued" || m.status === "unconfirmed" ? " warn" : "";
  const name = !system ? author : source === "agent-in" || source === "agent-out" ? m.name : "";
  const meta = el("header", { className: "message-meta" }, [
    el("span", { className: "message-source" }, [icon(mark), system ? label : name]),
    (system ? name : label) ? el("span", { className: "message-channel", text: system ? name : label }) : null,
    el("time", { title: "会话记录时间（北京时间）", text: bjTime(m.at) }),
    status ? el("span", { className: "message-status" + statusTone, text: status }) : null,
  ]);
  let content;
  if (external) content = eventContent(source, m.text, "batch:" + m.id, expanded.has("batch:" + m.id));
  if (source === "subagent") content = reportContent(m.text);
  if (source === "qq") content = qqContent(m.text);
  let showOriginal = !!content;
  if (!content && m.text) {
    if (!external && (m.role === "assistant" || system)) {
      content = chatProse(m.text);
      showOriginal = content.textContent !== m.text;
    } else content = el("div", { className: "chat-literal", text: m.text });
  }
  return el("article", { className: "chat-message " + (system ? "system" : m.role === "assistant" ? "assistant" : "user"),
    "data-source": source ?? "unknown" }, [
    meta, el("div", { className: "chat-body" }, [
      content,
      m.assets.length ? el("div", { className: "chat-files" }, m.assets.map(ref => attachment(ref, download))) : null,
      showOriginal ? rawMessage(m.id, m.text, expanded.has(m.id)) : null,
    ]),
  ]);
}
