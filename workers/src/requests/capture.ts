import type { Api, Context, Model, AssistantMessageEventStream, StreamOptions } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Env } from "../env";
import { agentSearchOption, hostedSearchSteps, responseAlarmWaitMs } from "../models";
import { argumentPreview } from "./tool-snapshot";
import { snapshot, responseSnapshot, errorSummary, boundedText } from "./snapshot";
import type { RequestBinding, RequestDetail, RequestScope } from "./types";
import { classifyError } from "../shared/diagnostics";

function hasCacheMetric(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => keys.includes(key) && typeof item === "number"
    || typeof item === "object" && item !== null && hasCacheMetric(item, keys));
}

/** 不消费流；终态 Promise 与 Harness 的事件迭代互不争抢。认证选项不进入采集数据。 */
export function captureModels(base: MutableModels, env: Env, ctx: Pick<DurableObjectState, "waitUntil">, scope: RequestScope, binding?: () => RequestBinding | undefined, origin?: (context: Context) => import("./context-source").ContextOrigin | undefined): MutableModels {
  const observe = (model: Model<Api>, context: Context, start: (notice: (event: unknown) => void, response: (res: Parameters<NonNullable<StreamOptions["onResponse"]>>[0]) => void) => AssistantMessageEventStream, purpose = scope.purpose) => {
    const startedAt = Date.now();
    let reported = false;
    let cacheReported = false, cacheWriteReported = false;
    let firstEventAt: number | undefined, alarmWaitMs: number | undefined;
    const requestBinding = purpose === "conversation" || purpose === "subagent" ? binding?.() : undefined;
    let httpStatus: number | undefined;
    const stream = start(event => {
      if (!event || typeof event !== "object") return;
      firstEventAt ??= Date.now();
      const value = event as { usage?: unknown; response?: { usage?: unknown } };
      const usage = value.usage ?? value.response?.usage;
      if (usage && typeof usage === "object" && Object.values(usage).some(n => typeof n === "number")) reported = true;
      cacheReported ||= hasCacheMetric(usage, ["cached_tokens", "cache_read_input_tokens", "prompt_cache_hit_tokens", "cacheReadInputTokens", "cacheRead"]);
      cacheWriteReported ||= hasCacheMetric(usage, ["cache_creation_input_tokens", "cacheWriteInputTokens", "cacheWrite"]);
    }, res => {
      httpStatus = res.status;
      if (res instanceof Response) alarmWaitMs = responseAlarmWaitMs(res);
    });
    const terminal = stream.result().then(result => ({ result, endedAt: Date.now() }));
    let detail: RequestDetail;
    try {
      const captured = snapshot(context, purpose === "conversation" || purpose === "subagent" ? origin?.(context) : undefined);
      detail = { request: { ...scope, purpose, ...(requestBinding ? { binding: requestBinding } : {}), id: crypto.randomUUID(), startedAt, endedAt: null, provider: model.provider, model: model.id,
        status: "running", contextWindow: model.contextWindow, inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null,
        reasoningTokens: null, durationMs: null, contextMetrics: captured.analysis?.metrics }, context: captured };
    } catch (error) { console.error({ event: "request_capture_failed", thread: scope.thread, actor: scope.actor, turnId: requestBinding?.turnId, ...classifyError(error) }); return stream; }
    const store = env.REQUESTS.getByName("main");
    const save = (value: RequestDetail) => store.record(value).catch(error => {
      console.error({ event: "request_record_failed", id: value.request.id, thread: scope.thread, turnId: requestBinding?.turnId, ...classifyError(error) });
    });
    ctx.waitUntil((async () => {
      await save(detail);
      const { result, endedAt } = await terminal, u = result.usage;
      const measured = reported || [u.input, u.output, u.cacheRead, u.cacheWrite].some(n => Number.isFinite(n) && n > 0);
      // 上游调用 ID 只用于协议回放；管理页在一次模型请求内关联搜索。
      const searches = hostedSearchSteps(result).map(step => ({ ...step, callId: `${detail.request.id}:${step.item.id}` }));
      if (requestBinding) {
        for (const { item, callId, startedAt, endedAt } of searches) {
          const { sources, ...action } = item.action ?? {};
          const result = { status: item.status, sources: sources ?? item.sources ?? item.results, page: item.page, error: item.error };
          await store.recordTool({ id: crypto.randomUUID(), thread: scope.thread, actor: scope.actor, binding: requestBinding,
            callId, name: "web_search", startedAt, endedAt, argumentPreview: argumentPreview(action),
            status: item.status === "completed" ? "done" : item.status === "failed" ? "error" : "interrupted",
            arguments: boundedText(JSON.stringify(action, null, 2)), result: boundedText(JSON.stringify(result, null, 2)) })
            .catch(error => console.error({ event: "tool_trace_failed", id: detail.request.id, thread: scope.thread, turnId: requestBinding.turnId, ...classifyError(error) }));
        }
      }
      const costTotal = u.cost?.total;
      const costUsd = typeof costTotal === "number" && Number.isFinite(costTotal) && costTotal >= 0 ? costTotal : null;
      await save({ ...detail, response: responseSnapshot(result), request: { ...detail.request, endedAt, durationMs: endedAt - startedAt,
        ttftMs: firstEventAt !== undefined ? Math.max(0, firstEventAt - startedAt) : null,
        ...(alarmWaitMs !== undefined ? { alarmWaitMs } : {}),
        status: result.stopReason === "error" ? "error" : result.stopReason === "aborted" ? "aborted" : "done", stopReason: result.stopReason,
        toolCalls: [...searches.map(({ callId }) => ({ id: callId, name: "web_search" })),
          ...result.content.flatMap(block => block.type === "toolCall" ? [{ id: block.id, name: block.name }] : [])],
        ...(result.errorMessage ? { error: errorSummary(result.errorMessage, httpStatus) } : {}),
        ...(measured ? { inputTokens: u.input + u.cacheRead + u.cacheWrite, outputTokens: u.output,
          cacheRead: cacheReported || u.cacheRead > 0 ? u.cacheRead : null, cacheWrite: cacheWriteReported || u.cacheWrite > 0 ? u.cacheWrite : null,
          reasoningTokens: u.reasoning ?? null, costUsd } : {}) } });
    })().catch(error => { console.error({ event: "request_capture_failed", id: detail.request.id, thread: scope.thread, turnId: requestBinding?.turnId, ...classifyError(error) }); }));
    return stream;
  };
  const events = (notice: (event: unknown) => void, response: (res: Parameters<NonNullable<StreamOptions["onResponse"]>>[0]) => void, options?: StreamOptions) => ({
    onResponse: async (value: Parameters<NonNullable<StreamOptions["onResponse"]>>[0], model: Model<Api>) => { response(value); await options?.onResponse?.(value, model); },
    onProviderStreamEvent: async (event: unknown, model: Model<Api>) => { notice(event); await options?.onProviderStreamEvent?.(event, model); } });
  const search = scope.purpose === "conversation" || scope.purpose === "subagent" ? agentSearchOption : {};
  const stream: MutableModels["stream"] = (m, c, o) => observe(m, c, (notice, response) => base.stream<Api>(m, c, { ...o, ...search, ...events(notice, response, o) }));
  const streamSimple: MutableModels["streamSimple"] = (m, c, o) => observe(m, c, (notice, response) => base.streamSimple(m, c, { ...o, ...search, ...events(notice, response, o) }));
  const complete: MutableModels["complete"] = (m, c, o) => stream(m, c, o).result();
  const completeSimple: MutableModels["completeSimple"] = (m, c, o) => observe(m, c, (notice, response) => base.streamSimple(m, c, { ...o, ...events(notice, response, o) }), "compaction").result();
  const overrides = { stream, streamSimple, complete, completeSimple };
  return new Proxy(base, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
