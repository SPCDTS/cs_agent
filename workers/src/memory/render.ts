import type { MemoryRow } from "./types";
import type { MemoryStore } from "./store";
import { formatBeijingTime } from "./time";
const scopeLabel = (scope: string) => scope.startsWith("group:") ? "群 " + scope.slice(6) : scope.startsWith("private:") ? "私聊 " + scope.slice(8) : scope;
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

const fence = (text: string) => text.replace(/<\/memory\s*>/gi, "</memory_>");
export async function renderMemorySection(store: MemoryStore): Promise<string | undefined> {
  const profile = await store.profile();
  // P1b brief 要求画像为空时不渲染；未完成承诺仍可通过 mem_search 查看。
  if (!profile.text.trim()) return undefined;
  const commitments = await store.openCommitments();
  const parts = [`<memory ns="${store.ns}" profile_revision="${profile.revision}">`, fence(profile.text)];
  if (commitments.length) parts.push("", "未完成的承诺：", ...commitments.map(row => {
    const timing = memoryTiming(row);
    return `- #${row.id}${timing ? ` (${timing})` : ""} ${fence(row.text)}`;
  }));
  return [...parts, "</memory>"].join("\n");
}
export function renderLines(rows: readonly MemoryRow[]): { text: string; shown: MemoryRow[] } {
  const lines: string[] = [], shown: MemoryRow[] = [];
  let used = 0;
  for (const row of rows) {
    const line = formatMemoryLine(row);
    if (used + line.length + 41 > 2500) break;
    lines.push(line); shown.push(row); used += line.length + 1;
  }
  if (shown.length < rows.length) lines.push(`（另有 ${rows.length - shown.length} 条未显示，请缩小范围）`);
  return { text: lines.join("\n") || "没有找到匹配的记忆。", shown };
}
export function bounded(text: string): string { return text.length <= 2500 ? text : text.slice(0, 2490).replace(/[\uD800-\uDBFF]$/, "") + "\n…（已截断）"; }
