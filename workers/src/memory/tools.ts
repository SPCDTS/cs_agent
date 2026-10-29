import type { Context } from "@earendil-works/chord/context";
import type { Static } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { memoryParameters, memoryDescriptions, type MemoryTool } from "./contracts";
import { MemoryStore } from "./store";
import { bounded, formatMemoryLine, renderLines } from "./render";
import { containsSecret } from "./secrets";
import { parseMemoryTime, parseClearableTime } from "./time";

export type MemoryBinding = { ns: string; owner: boolean; userId: string; turnId: string; scope: string; messageId: string };
export function memoryToolNames(ns: string): MemoryTool[] {
  // P1b 的权限比 Docker 更窄：只有 owner 私聊提供写工具，其他 DO 仅召回本会话。
  return ns === "owner" ? ["mem_search", "mem_remember", "mem_update", "mem_forget", "mem_profile"] : ["mem_search"];
}
const memoryEvent = (store: MemoryStore, kind: "memory_recall" | "memory_write", detail: object) =>
  store.db.run("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail));

/** mem_search 的检索与审计；子 agent 经父线程 RPC 只读检索时走同一段。 */
export async function searchMemory(store: MemoryStore, args: Static<typeof memoryParameters.mem_search>): Promise<string> {
  if (args.query !== undefined && !args.query.trim()) throw new Error("query 不能为空");
  const rows = await store.search(args), { text, shown } = renderLines(rows);
  if (args.query) await store.touchRecall(shown.map(row => row.id));
  await memoryEvent(store, "memory_recall", { tool: "mem_search", returned_count: shown.length, dropped_count: rows.length - shown.length, chars: text.length });
  return bounded(text);
}

export function createMemoryTools(store: MemoryStore, binding: (api: ToolExecutionApi, context: Context) => Promise<MemoryBinding | undefined>) {
  const event = (kind: "memory_recall" | "memory_write", detail: object) => memoryEvent(store, kind, detail);
  async function run(api: ToolExecutionApi, context: Context, write: boolean, action: (b: MemoryBinding) => Promise<string>) {
    try {
      const b = await binding(api, context);
      if (!b || b.ns !== store.ns) throw new Error("本轮身份未确证，不能访问记忆；本轮请勿重试。");
      // 即使工具可见性或恢复时配置发生变化，执行入口也重新核验实际回合权限。
      if (write) {
        if (!b.owner || b.ns !== "owner") throw new Error("本轮只有本会话记忆的只读权限；本轮请勿重试。");
        await store.takeToolWrite(b.turnId);
      }
      return { output: [{ type: "text" as const, text: bounded(await action(b)) }] };
    } catch (error) {
      return { isError: true, output: [{ type: "text" as const, text: bounded(error instanceof Error ? error.message : "记忆操作失败") }] };
    }
  }
  function check(...texts: (string | undefined)[]) {
    if (texts.some(text => text !== undefined && containsSecret(text))) throw new Error("内容包含凭据样式的信息，拒绝写入记忆。请删除凭据后再调用。");
  }
  const tools = [
    defineTool({ name: "mem_search", description: memoryDescriptions.mem_search, parameters: memoryParameters.mem_search, replay: "safe",
      execute: (args, api, context) => run(api, context, false, () => searchMemory(store, args)) }),
    defineTool({ name: "mem_remember", description: memoryDescriptions.mem_remember, parameters: memoryParameters.mem_remember, replay: "unsafe",
      execute: (args, api, context) => run(api, context, true, async b => {
        check(args.text, args.subject);
        if (args.subject && /^(?:group|private):/.test(args.subject)) throw new Error("P1b 只允许写入 owner 命名空间，不支持通过 subject 跨会话写入。");
        if (args.due_at !== undefined && args.kind !== "commitment") throw new Error("due_at 只用于 kind=commitment；episode 的事件日期请填 since。");
        const result = await store.remember({ text: args.text, kind: args.kind, subject: args.subject,
          since: args.since === undefined ? null : parseMemoryTime(args.since, "since"),
          due_at: args.due_at === undefined ? null : parseMemoryTime(args.due_at, "due_at"), author: `qq:${b.userId}`,
          source_scope: b.scope, source_message_id: b.messageId, source_turn_id: b.turnId, confidence: 1 }, { supersedes: args.supersedes });
        await event("memory_write", { tool: "mem_remember", written: result.duplicate ? 0 : 1, superseded: result.superseded ? 1 : 0 });
        return (result.duplicate ? "已有相同的记忆，未重复记录：" : "已记住：") + formatMemoryLine(result.row)
          + (result.superseded ? `（取代 #${result.superseded.id}）` : "");
      }) }),
    defineTool({ name: "mem_update", description: memoryDescriptions.mem_update, parameters: memoryParameters.mem_update, replay: "unsafe",
      execute: (args, api, context) => run(api, context, true, async b => {
        check(args.text, args.subject);
        const row = await store.update(args.id, { text: args.text, subject: args.subject,
          until: parseClearableTime(args.until, "until"), due_at: parseClearableTime(args.due_at, "due_at"), done_at: parseClearableTime(args.done_at, "done_at") }, `qq:${b.userId}`);
        await event("memory_write", { tool: "mem_update", written: 1 });
        return "已更新：" + formatMemoryLine(row);
      }) }),
    defineTool({ name: "mem_forget", description: memoryDescriptions.mem_forget, parameters: memoryParameters.mem_forget, replay: "unsafe",
      execute: (args, api, context) => run(api, context, true, async b => {
        check(args.reason);
        if (!args.reason.trim()) throw new Error("须写明遗忘原因");
        await store.forget(args.id, `qq:${b.userId}`, args.reason);
        await event("memory_write", { tool: "mem_forget", written: 1 });
        return `已遗忘 #${args.id}（只做标记，版本保留）。`;
      }) }),
    defineTool({ name: "mem_profile", description: memoryDescriptions.mem_profile, parameters: memoryParameters.mem_profile, replay: "unsafe",
      execute: (args, api, context) => run(api, context, true, async () => {
        const result = await store.writeProfile(args.text, args.revision);
        if (!result.ok) throw new Error(`画像已被修改，当前 revision=${result.current.revision}，当前内容如下；在此基础上修改后重新提交：\n${result.current.text}`);
        await event("memory_write", { tool: "mem_profile", bytes: new TextEncoder().encode(result.current.text).byteLength });
        return `画像已保存（revision=${result.current.revision}），下一轮起进入提示。`;
      }) }),
  ];
  return tools.filter(tool => memoryToolNames(store.ns).some(name => name === tool.name));
}
