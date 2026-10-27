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
 * 像真模型一样经 codemode 调 MCP 业务工具：脚本可调的工具（codemode 段列出的）补进交给脚本的上下文，
 * 脚本直接调用业务工具时改写成同 id 的 codemode 调用 `return await tools.<名称>(参数)`。
 */
export function withCodemode<A extends unknown[]>(brain: (ctx: TranscriptContext, ...rest: A) => Message | Promise<Message>) {
  const business = (name: string) => /^mcp_/.test(name) && !/^mcp_(refresh_tools|list_resources|read_resource)$/.test(name);
  return async (ctx: TranscriptContext, ...rest: A): Promise<Message> => {
    const section = ctx.messages.map(m => (m as { sections?: Record<string, string> }).sections?.codemode).findLast(Boolean) ?? "";
    const scripted = [...section.matchAll(/### `(mcp_[^`]+)`\n([^\n]*)/g)].map(([, name, description]) =>
      ({ name: name!, description: description!, parameters: { type: "object", properties: {} } }));
    const offered = getCurrentTools(ctx.messages).some(t => t.name === "codemode") && scripted.length
      ? [...ctx.messages, { role: "system", content: "", toolsAdded: scripted, timestamp: 0 } as unknown as Message] : ctx.messages;
    const out = await brain({ ...ctx, messages: offered }, ...rest);
    if (out.role !== "assistant") return out;
    return { ...out, content: out.content.map(c => c.type === "toolCall" && business(c.name)
      ? { ...c, name: "codemode", arguments: { code: `return await tools.${c.name}(${JSON.stringify(c.arguments)});` } } : c) };
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
