import type { Api, Context, Model, AssistantMessageEventStream, StreamOptions } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Env } from "../env";
import { snapshot, responseSnapshot, errorSummary } from "./snapshot";
import type { RequestBinding, RequestDetail, RequestScope } from "./types";

function hasCacheMetric(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => keys.includes(key) && typeof item === "number"
    || typeof item === "object" && item !== null && hasCacheMetric(item, keys));
}

/** 不消费流；终态 Promise 与 Harness 的事件迭代互不争抢。认证选项不进入采集数据。 */
export function captureModels(base: MutableModels, env: Env, ctx: Pick<DurableObjectState, "waitUntil">, scope: RequestScope, binding?: () => RequestBinding | undefined, origin?: (context: Context) => import("./context-source").ContextOrigin | undefined): MutableModels {
  const observe = (model: Model<Api>, context: Context, start: (notice: (event: unknown) => void, response: (status: number) => void) => AssistantMessageEventStream, purpose = scope.purpose) => {
    const startedAt = Date.now();
    let reported = false;
    let cacheReported = false, cacheWriteReported = false;
    const requestBinding = purpose === "conversation" || purpose === "subagent" ? binding?.() : undefined;
    let httpStatus: number | undefined;
    const stream = start(event => {
      if (!event || typeof event !== "object") return;
      const value = event as { usage?: unknown; response?: { usage?: unknown } };
      const usage = value.usage ?? value.response?.usage;
      if (usage && typeof usage === "object" && Object.values(usage).some(n => typeof n === "number")) reported = true;
      cacheReported ||= hasCacheMetric(usage, ["cached_tokens", "cache_read_input_tokens", "prompt_cache_hit_tokens", "cacheReadInputTokens", "cacheRead"]);
      cacheWriteReported ||= hasCacheMetric(usage, ["cache_creation_input_tokens", "cacheWriteInputTokens", "cacheWrite"]);
    }, status => { httpStatus = status; });
    const terminal = stream.result().then(result => ({ result, endedAt: Date.now() }));
    let detail: RequestDetail;
    try {
      const captured = snapshot(context, purpose === "conversation" || purpose === "subagent" ? origin?.(context) : undefined);
      detail = { request: { ...scope, purpose, ...(requestBinding ? { binding: requestBinding } : {}), id: crypto.randomUUID(), startedAt, endedAt: null, provider: model.provider, model: model.id,
        status: "running", contextWindow: model.contextWindow, inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null,
        reasoningTokens: null, durationMs: null, contextMetrics: captured.analysis?.metrics }, context: captured };
    } catch { console.error({ event: "request_capture_failed" }); return stream; }
    const store = env.REQUESTS.getByName("main");
    const save = (value: RequestDetail) => store.record(value).catch(() => { console.error({ event: "request_record_failed", id: value.request.id }); });
    ctx.waitUntil((async () => {
      await save(detail);
      const { result, endedAt } = await terminal, u = result.usage;
      const measured = reported || [u.input, u.output, u.cacheRead, u.cacheWrite].some(n => Number.isFinite(n) && n > 0);
      await save({ ...detail, response: responseSnapshot(result), request: { ...detail.request, endedAt, durationMs: endedAt - startedAt,
        status: result.stopReason === "error" ? "error" : result.stopReason === "aborted" ? "aborted" : "done", stopReason: result.stopReason,
        toolCalls: result.content.flatMap(block => block.type === "toolCall" ? [{ id: block.id, name: block.name }] : []),
        ...(result.errorMessage ? { error: errorSummary(result.errorMessage, httpStatus) } : {}),
        ...(measured ? { inputTokens: u.input + u.cacheRead + u.cacheWrite, outputTokens: u.output,
          cacheRead: cacheReported || u.cacheRead > 0 ? u.cacheRead : null, cacheWrite: cacheWriteReported || u.cacheWrite > 0 ? u.cacheWrite : null,
          reasoningTokens: u.reasoning ?? null } : {}) } });
    })().catch(() => { console.error({ event: "request_capture_failed", id: detail.request.id }); }));
    return stream;
  };
  const events = (notice: (event: unknown) => void, response: (status: number) => void, options?: StreamOptions) => ({
    onResponse: async (value: Parameters<NonNullable<StreamOptions["onResponse"]>>[0], model: Model<Api>) => { response(value.status); await options?.onResponse?.(value, model); },
    onProviderStreamEvent: async (event: unknown, model: Model<Api>) => { notice(event); await options?.onProviderStreamEvent?.(event, model); } });
  const stream: MutableModels["stream"] = (m, c, o) => observe(m, c, (notice, response) => base.stream<Api>(m, c, { ...o, ...events(notice, response, o) }));
  const streamSimple: MutableModels["streamSimple"] = (m, c, o) => observe(m, c, (notice, response) => base.streamSimple(m, c, { ...o, ...events(notice, response, o) }));
  const complete: MutableModels["complete"] = (m, c, o) => stream(m, c, o).result();
  const completeSimple: MutableModels["completeSimple"] = (m, c, o) => observe(m, c, (notice, response) => base.streamSimple(m, c, { ...o, ...events(notice, response, o) }), "compaction").result();
  const overrides = { stream, streamSimple, complete, completeSimple };
  return new Proxy(base, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
