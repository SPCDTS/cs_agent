/** faux 模型脚本的通用小工具（resident-fixture 与直接用 Harness 的测试共用，不引入整套常驻装置）。 */
import { fauxAssistantMessage, fauxToolCall, getSystemMessageText, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { JsonObject } from "@earendil-works/pi-durable";
import { DEFAULT_SUBAGENT_INSTRUCTIONS } from "../../src/agent/pi-tools/subagent.js";

export const text = (m: Message | undefined) => !m ? "" : m.role === "system" ? getSystemMessageText(m)
  : typeof m.content === "string" ? m.content : m.content.map(c => c.type === "text" ? c.text : "").join("");
export const lastUser = (ctx: TranscriptContext) => text(ctx.messages.filter(m => m.role === "user").at(-1));
export const isChild = (ctx: TranscriptContext) => ctx.messages.some(m => m.role === "system" && text(m).includes(DEFAULT_SUBAGENT_INSTRUCTIONS));
export const call = (...calls: [string, JsonObject][]) => fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: "toolUse" });
export const reply = (body = "好的") => fauxAssistantMessage(body);
export const toolResults = (ctx: TranscriptContext) => ctx.messages.filter(m => m.role === "toolResult").map(m => text(m));

/**
 * 像真模型一样先用 tool_search 加载延迟的 MCP 业务工具：提供了 tool_search 而业务工具都未加载时先搜一次；
 * 交给脚本的上下文去掉搜索往返，脚本照旧从本轮提供的工具里取名字。
 */
export function withToolSearch<A extends unknown[], R>(brain: (ctx: TranscriptContext, ...rest: A) => R) {
  const isSearch = (m: Message) => m.role === "toolResult" ? m.toolName === "tool_search"
    : m.role === "assistant" && m.content.some(c => c.type === "toolCall" && c.name === "tool_search");
  return (ctx: TranscriptContext, ...rest: A): R | ReturnType<typeof call> => {
    const offered = getCurrentTools(ctx.messages).map(t => t.name);
    const last = ctx.messages.findLast(m => m.role !== "system");
    if (last?.role === "user" && offered.includes("tool_search") && !offered.some(n => /^mcp_/.test(n) && !/^mcp_(refresh_tools|list_resources|read_resource)$/.test(n))) {
      return call(["tool_search", { query: "mcp", limit: 50 }]);
    }
    return brain({ ...ctx, messages: ctx.messages.filter(m => !isSearch(m)) }, ...rest);
  };
}

/** 可中止的闸门：faux 回应等它打开；生成被中止时随之拒绝，避免关闭 harness 时挂起。 */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  let entered = 0;
  return { open, get entered() { return entered; }, wait: (signal?: AbortSignal) => {
    entered++;
    return new Promise<void>((resolve, reject) => {
      void opened.then(resolve);
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  } };
}

/** 每 10 ms 检查一次直到条件成立（检查抛错视为未成立）。 */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await Promise.resolve().then(check).catch(() => false)) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
