/**
 * 记忆的文本渲染（docs/MEMORY-DESIGN.md §6、§7）：工具输出的条目行，与两个后端共用的提示段
 * （画像全文 + 未完成承诺前 10 条）。空画像且无承诺时不渲染。
 */
import type { ProfileStore } from "../../context/memory/profile.js";
import type { MemoryStore } from "../../context/memory/store.js";
import { isMemoryNs, type MemoryRow } from "../../context/memory/types.js";
import { scopeLabel } from "../../context/access.js";
import { log } from "../../shared/log.js";
import { formatBeijingTime } from "../schedule/tool-schema.js";

/** 提示段里未完成承诺的条数上限 */
export const MEMORY_PROMPT_COMMITMENTS = 10;

/** 北京时间，固定写 YYYY-MM-DD，非零点时带 HH:mm；不依赖当前时间，提示段文本不会因跨年而变。 */
function when(sec: number): string {
  const full = formatBeijingTime(sec * 1000);
  return full.endsWith(" 00:00") ? full.slice(0, 10) : full;
}
const day = (sec: number) => formatBeijingTime(sec * 1000).slice(0, 10);

/** 条目的时效说明（括号内），没有时为空。 */
export function memoryTiming(row: Pick<MemoryRow, "kind" | "since" | "until" | "due_at" | "done_at">): string {
  if (row.kind === "commitment" && row.done_at !== null) return `已完成 ${when(row.done_at)}`;
  if (row.kind === "commitment" && row.due_at !== null) return `截止 ${when(row.due_at)}`;
  if (row.kind === "episode" && row.since !== null) return row.until !== null ? `${day(row.since)} 至 ${day(row.until)}` : day(row.since);
  if (row.since !== null && row.until !== null) return `${day(row.since)} 至 ${day(row.until)}`;
  if (row.since !== null) return `${day(row.since)} 起`;
  if (row.until !== null) return `至 ${day(row.until)}`;
  return "";
}

/** 工具输出的一行：`#id [kind] (时效) 正文 ← 来源 会话 #消息`；非 active 的状态写在种类后。 */
export function formatMemoryLine(row: MemoryRow, label: (scope: string) => string = scopeLabel): string {
  const timing = memoryTiming(row);
  const source = row.source_scope ? `${label(row.source_scope)}${row.source_message_id ? ` #${row.source_message_id}` : ""}`
    : row.author === "dashboard" ? "面板" : "";
  return `#${row.id} [${row.kind}${row.status === "active" ? "" : "·" + row.status}]${timing ? ` (${timing})` : ""} ${row.text}${source ? ` ← 来源 ${source}` : ""}`;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string, detail: Record<string, unknown>): void {
  if (warned.has(key)) return;
  if (warned.size >= 1000) warned.clear();
  warned.add(key);
  log.warn(message, detail);
}

/** 正文里的结束标记换掉，避免提前闭合段落。 */
const fence = (text: string) => text.replace(/<\/memory\s*>/gi, "</memory_>");

/**
 * 提示段（§7）：画像原文 + 未完成的承诺（按 due_at 升序、无截止的在后，前 10 条）。
 * 内容只取决于画像与承诺；两者不变时文本逐字不变，pi 的提示缓存与 codex 的受管文件都据此不重写。
 */
export async function renderMemorySection(deps: { store: MemoryStore; profiles: ProfileStore }, ns: string): Promise<string | undefined> {
  if (!isMemoryNs(ns)) return undefined;
  let profile: { text: string; revision: string };
  try {
    const read = await deps.profiles.read(ns);
    // 超过 4 KiB（运维手改）不注入：渲染为空，每个版本只告警一次；mem_profile 会提示重写。
    if (read.oversize) warnOnce(`${ns}:${read.revision}`, "memory profile over 4 KiB, not injected", { ns, revision: read.revision });
    profile = read.oversize ? { text: "", revision: read.revision } : read;
  } catch (error) {
    warnOnce(`${ns}:${(error as Error).message}`, "memory profile unreadable", { ns, error });
    profile = { text: "", revision: "unreadable" };
  }
  const commitments = deps.store.openCommitments(ns, MEMORY_PROMPT_COMMITMENTS);
  const text = profile.text.replace(/\s+$/, "");
  if (!text.trim() && !commitments.length) return undefined;
  const parts = [`<memory ns="${ns}" profile_revision="${profile.revision}">`];
  if (text.trim()) parts.push(fence(text));
  if (commitments.length) {
    if (text.trim()) parts.push("");
    parts.push("未完成的承诺：", ...commitments.map(row => {
      const timing = memoryTiming(row);
      return `- #${row.id}${timing ? ` (${timing})` : ""} ${fence(row.text)}`;
    }));
  }
  parts.push("</memory>");
  return parts.join("\n");
}
