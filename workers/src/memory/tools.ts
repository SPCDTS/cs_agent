import type { Context } from "@earendil-works/chord/context";
import type { Static } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { memoryParameters, memoryDescriptions, type MemoryTool } from "./contracts";
import { MemoryStore } from "./store";
import { bounded, formatMemoryLine, renderLines } from "./render";
import { materialKeywords } from "./extractor";
import { containsSecret } from "./secrets";
import { parseMemoryTime, parseClearableTime } from "./time";
import { isMemoryNs, type MemoryInput } from "./types";

export type MemoryBinding = { ns: string; owner: boolean; userId: string; turnId: string; scope: string; messageId: string;
  origin: "message" | "web" | "schedule" | "event" | "subagent" };
export type MemoryToolOptions = { rememberInNamespace?: (
  ns: string, input: Omit<MemoryInput, "ns">, options: { supersedes?: number }, binding: MemoryBinding
) => ReturnType<MemoryStore["remember"]> };
export function memoryToolNames(ns: string): MemoryTool[] {
  return isMemoryNs(ns) ? ["mem_search", "mem_remember", "mem_update", "mem_forget", "mem_profile"] : ["mem_search"];
}
/** 输入由宿主确证，执行时仍按来源与本会话范围核对；自动事件与子 agent 一律只读。 */
export function canWriteMemory(binding: MemoryBinding, profile = false): boolean {
  if (!["message", "web", "schedule"].includes(binding.origin) || !isMemoryNs(binding.ns) || !binding.userId || !binding.turnId) return false;
  if (profile && !binding.owner) return false;
  if (binding.ns === "owner") return binding.owner && (binding.origin === "web" || binding.scope === `private:${binding.userId}`);
  if (binding.scope !== binding.ns) return false;
  return !binding.ns.startsWith("private:") || binding.origin === "web" || binding.ns === `private:${binding.userId}`;
}
const memoryEvent = (store: MemoryStore, kind: "memory_recall" | "memory_write", detail: object) =>
  store.db.run("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail));

/** mem_search 的检索与审计；子 agent 经父线程 RPC 只读检索时走同一段。 */
export async function searchMemory(store: MemoryStore, args: Static<typeof memoryParameters.mem_search>): Promise<string> {
  if (args.query !== undefined && !args.query.trim()) throw new Error("query 不能为空");
  let rows = await store.search(args), fallback = false;
  if(!rows.length && args.query) {
    const hits = new Map<number,{row:typeof rows[number];matches:number}>();
    for(const term of materialKeywords(args.query,6))for(const row of await store.search({...args,query:term,limit:20})) {
      const hit=hits.get(row.id);hits.set(row.id,{row,matches:(hit?.matches??0)+1});
    }
    rows=[...hits.values()].sort((a,b)=>b.matches-a.matches || Number(a.row.author==="extractor")-Number(b.row.author==="extractor") || b.row.updated_at-a.row.updated_at).slice(0,args.limit??10).map(h=>h.row);
    fallback=rows.length>0;
  }
  const {text,shown}=renderLines(rows);
  if (args.query) await store.touchRecall(shown.map(row => row.id));
  await memoryEvent(store, "memory_recall", { tool: "mem_search", returned_count: shown.length, dropped_count: rows.length - shown.length, ids:shown.map(r=>r.id), fallback, chars: text.length });
  return bounded((fallback?"未找到完整短语，以下仅为关键词相关记忆，请核对是否适用：\n":"")+text);
}

export function createMemoryTools(store: MemoryStore, binding: (api: ToolExecutionApi, context: Context) => Promise<MemoryBinding | undefined>, options: MemoryToolOptions = {}) {
  const event = (kind: "memory_recall" | "memory_write", detail: object) => memoryEvent(store, kind, detail);
  async function run(api: ToolExecutionApi, context: Context, write: boolean | "profile", action: (b: MemoryBinding) => Promise<string>) {
    try {
      const b = await binding(api, context);
      if (!b || b.ns !== store.ns) throw new Error("本轮身份未确证，不能访问记忆；本轮请勿重试。");
      // 即使工具可见性或恢复时配置发生变化，执行入口也重新核验实际回合权限。
      if (write) {
        if (!canWriteMemory(b, write === "profile")) throw new Error(write === "profile" ? "画像只能在 owner 本人的回合修改；本轮请勿重试。" : "本轮只有本会话记忆的只读权限；本轮请勿重试。");
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
        if (args.due_at !== undefined && args.kind !== "commitment") throw new Error("due_at 只用于 kind=commitment；episode 的事件日期请填 since。");
        const input: Omit<MemoryInput, "ns"> = { text: args.text, kind: args.kind, subject: args.subject,
          since: args.since === undefined ? null : parseMemoryTime(args.since, "since"),
          due_at: args.due_at === undefined ? null : parseMemoryTime(args.due_at, "due_at"), author: `qq:${b.userId}`,
          source_scope: b.scope, source_message_id: b.messageId, source_turn_id: b.turnId, confidence: 1 };
        const target = b.ns === "owner" && args.subject && /^(?:group|private):[1-9][0-9]{0,19}$/.test(args.subject) ? args.subject : undefined;
        let result: Awaited<ReturnType<MemoryStore["remember"]>>;
        if (target) {
          if (!b.owner || b.origin !== "message" || b.scope !== `private:${b.userId}` || !options.rememberInNamespace) throw new Error("本轮不支持通过 subject 跨会话写入。");
          result = await options.rememberInNamespace(target, input, { supersedes: args.supersedes }, b);
        } else result = await store.remember(input, { supersedes: args.supersedes });
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
      execute: (args, api, context) => run(api, context, "profile", async () => {
        const result = await store.writeProfile(args.text, args.revision);
        if (!result.ok) throw new Error(`画像已被修改，当前 revision=${result.current.revision}，当前内容如下；在此基础上修改后重新提交：\n${result.current.text}`);
        await event("memory_write", { tool: "mem_profile", bytes: new TextEncoder().encode(result.current.text).byteLength });
        return `画像已保存（revision=${result.current.revision}），下一轮起进入提示。`;
      }) }),
  ];
  return tools.filter(tool => memoryToolNames(store.ns).some(name => name === tool.name));
}
