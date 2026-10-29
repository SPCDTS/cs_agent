import type { Models } from "@earendil-works/pi-ai";
import { CODEX_PROVIDER } from "./codex-login";
import { MODEL_PROVIDERS } from "./models";
import { isRecord } from "./policy";

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";
/** Codex 后端托管的工具：由 ChatGPT 订阅执行，不是我们的函数工具。 */
export type HostedTool = { type: "web_search" } | { type: "image_generation"; size: ImageSize; quality: "medium" };
export type HostedFailure = "login_required" | "rejected" | "timeout" | "upstream" | "not_searched" | "no_image";
export class HostedToolError extends Error {
  constructor(readonly code: HostedFailure) { super(code); }
}
export type HostedResult = { text: string; calls: Record<string, unknown>[] };

/** 代答用的 Codex 模型：var CODEX_SEARCH_MODEL 优先，否则由注册表按目录挑。 */
export function hostedModelId(models: Models, override?: string): string | undefined {
  return override?.trim() || MODEL_PROVIDERS[CODEX_PROVIDER]?.searchModel?.(models.getModels(CODEX_PROVIDER));
}

/**
 * 对 Codex 发一次独立补全并只开一个托管工具，不经 Harness、不进会话历史。
 * 这次请求没有函数工具，代答的模型不会再调用我们的 web_search，也就没有套娃。
 */
export async function runHostedTool(models: Models, prompt: string, tool: HostedTool,
  options: { signal?: AbortSignal; timeoutMs: number; modelId?: string }): Promise<HostedResult> {
  const id = hostedModelId(models, options.modelId), model = id ? models.getModel(CODEX_PROVIDER, id) : undefined;
  if (!model) throw new HostedToolError("upstream");
  // 凭据解不开（例如换了 OAUTH_STORE_KEY）与没登录一样，都要主人去面板重新登录。
  if (!await models.checkAuth(CODEX_PROVIDER).catch(() => undefined)) throw new HostedToolError("login_required");
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const callType = `${tool.type}_call`, calls: Record<string, unknown>[] = [];
  let status: number | undefined;
  const result = await models.complete(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, {
    // 不设推理强度时 pi-ai 发 none，部分模型在最低推理下不接受托管工具。
    signal, transport: "sse", reasoningEffort: "low",
    // 托管工具不在 pi-ai 的工具模型里，只能在发出前追加到请求体。
    onPayload: payload => isRecord(payload) ? { ...payload, tools: [...Array.isArray(payload.tools) ? payload.tools : [], tool] } : undefined,
    onResponse: response => { status = response.status; },
    // pi-ai 只把 message / reasoning / function_call 落进结果，托管工具的输出项要从原始事件里取。
    onProviderStreamEvent: event => {
      if (isRecord(event) && event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === callType) calls.push(event.item);
    },
  });
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    if (deadline.aborted) throw new HostedToolError("timeout");
    if (status === 401) throw new HostedToolError("login_required");
    // 4xx（限流除外）是后端不接受这个请求，例如订阅不允许运行该托管工具；其余都按暂时故障处理。
    if (status !== undefined && status >= 400 && status < 500 && status !== 429) throw new HostedToolError("rejected");
    throw new HostedToolError("upstream");
  }
  return { text: result.content.flatMap(block => block.type === "text" ? [block.text] : []).join(""), calls };
}
