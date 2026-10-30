import type { Api, Context, Model, AssistantMessageEventStream, StreamOptions } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Env } from "../env";
import { snapshot, responseSnapshot, errorSummary } from "./snapshot";
import type { RequestDetail, RequestScope } from "./types";

/** 不消费流；终态 Promise 与 Harness 的事件迭代互不争抢。认证选项不进入采集数据。 */
export function captureModels(base: MutableModels, env: Env, ctx: Pick<DurableObjectState, "waitUntil">, scope: RequestScope): MutableModels {
  const observe = (model: Model<Api>, context: Context, start: (notice: (event: unknown) => void, response: (status: number) => void) => AssistantMessageEventStream, purpose = scope.purpose) => {
    const startedAt = Date.now();
    let reported = false;
    let httpStatus: number | undefined;
    const stream = start(event => {
      if (!event || typeof event !== "object") return;
      const value = event as { usage?: unknown; response?: { usage?: unknown } };
      const usage = value.usage ?? value.response?.usage;
      if (usage && typeof usage === "object" && Object.values(usage).some(n => typeof n === "number")) reported = true;
    }, status => { httpStatus = status; });
    const terminal = stream.result().then(result => ({ result, endedAt: Date.now() }));
    let detail: RequestDetail;
    try {
      detail = { request: { ...scope, purpose, id: crypto.randomUUID(), startedAt, endedAt: null, provider: model.provider, model: model.id,
        status: "running", contextWindow: model.contextWindow, inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null,
        reasoningTokens: null, durationMs: null }, context: snapshot(context) };
    } catch { console.error({ event: "request_capture_failed" }); return stream; }
    const store = env.REQUESTS.getByName("main");
    const save = (value: RequestDetail) => store.record(value).catch(() => { console.error({ event: "request_record_failed", id: value.request.id }); });
    ctx.waitUntil((async () => {
      await save(detail);
      const { result, endedAt } = await terminal, u = result.usage;
      const measured = reported || [u.input, u.output, u.cacheRead, u.cacheWrite].some(n => Number.isFinite(n) && n > 0);
      await save({ ...detail, response: responseSnapshot(result), request: { ...detail.request, endedAt, durationMs: endedAt - startedAt,
        status: result.stopReason === "error" ? "error" : result.stopReason === "aborted" ? "aborted" : "done", stopReason: result.stopReason,
        ...(result.errorMessage ? { error: errorSummary(result.errorMessage, httpStatus) } : {}),
        ...(measured ? { inputTokens: u.input + u.cacheRead + u.cacheWrite, outputTokens: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoningTokens: u.reasoning ?? null } : {}) } });
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
