import { defineExtension, GenerationTask, hook, ToolTask, type HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { Env } from "../env";
import { boundedText } from "./snapshot";
import type { RequestBinding, ToolTrace } from "./types";

/** 宿主回合身份在每次请求前捕获；工具身份随 task memo 持久化，重启后仍可配对。 */
export function requestTrace(env: Env, thread: string, resolve: (api: HookApi, context: Context) => Promise<RequestBinding | undefined>) {
  let binding: RequestBinding | undefined;
  const save = (trace: ToolTrace) => env.REQUESTS.getByName("main").recordTool(trace).catch(() => {
    console.error({ event: "tool_trace_failed", id: trace.id });
  });
  const extension = defineExtension({ name: "cs.request-trace", hooks: [
    hook(GenerationTask, { beforeRequest: async (_request, api, context) => {
      binding = undefined;
      try { binding = await resolve(api, context); } catch { console.error({ event: "request_binding_failed" }); }
    } }),
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        try {
          const current = await resolve(api, context);
          if (!current) return;
          const memo = await api.memo("cs.trace", { binding: current, id: crypto.randomUUID(), at: Date.now() }, context);
          await save({ id: memo.id, thread, binding: memo.binding, callId: call.id, ...(call.parent ? { parentCallId: call.parent.callId } : {}),
            name: call.name, startedAt: memo.at, endedAt: null, status: "running", arguments: boundedText(JSON.stringify(call.arguments, null, 2)) });
        } catch { console.error({ event: "tool_trace_start_failed" }); }
      },
      afterTool: async (call, result, api, context) => {
        try {
          const memo = await api.memo<{ binding: RequestBinding; id: string; at: number }>("cs.trace", context);
          if (!memo) return;
          const output = result.output?.map(part => part.type === "text" ? part.text : "[图片内容省略]").join("\n");
          const text = output ?? result.diagnostics?.map(d => d.message).join("\n") ?? "[工具未提供结果正文]";
          await save({ id: memo.id, thread, binding: memo.binding, callId: call.id, ...(call.parent ? { parentCallId: call.parent.callId } : {}),
            name: call.name, startedAt: memo.at, endedAt: Date.now(), status: result.isError ? "error" : "done",
            arguments: boundedText(JSON.stringify(call.arguments, null, 2)), result: boundedText(text) });
        } catch { console.error({ event: "tool_trace_end_failed" }); }
      },
    }),
  ] });
  return { extension, binding: () => binding };
}
