import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream, type AssistantMessage, type StreamOptions } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { captureModels } from "../src/requests/capture";
import { snapshot, errorSummary } from "../src/requests/snapshot";
import type { RequestDetail, RequestQuery } from "../src/requests/types";
import worker from "../src/index";
afterEach(() => reset());
const query = (): RequestQuery => ({ since: Date.now() - 86400_000, until: Date.now() + 1000, limit: 40 });
function detail(id: string, at = Date.now()): RequestDetail {
  return { request: { id, startedAt: at, endedAt: at + 10, thread: "owner", actor: "thread", purpose: "conversation", provider: "faux", model: "test",
    status: "done", inputTokens: 14, outputTokens: 3, cacheRead: 5, cacheWrite: 2, reasoningTokens: 2, durationMs: 10, contextWindow: 1000 },
    context: snapshot({ messages: [{ role: "user", content: "你好", timestamp: at }] }) };
}
describe("request observability", () => {
  it("counts every stream/complete once, keeps stream events and usage semantics, and redacts secrets", async () => {
    const faux = fauxProvider({ models: [{ id: "test" }] }), base = createModels();
    const message = { ...fauxAssistantMessage("ok"), usage: { input: 7, output: 3, cacheRead: 5, cacheWrite: 2, reasoning: 2, totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const make = () => { const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); return stream; };
    base.setProvider({ ...faux.provider, stream: make, streamSimple: make });
    const pending: Promise<unknown>[] = [];
    const models = captureModels(base, env, { waitUntil: p => { pending.push(p); } }, { thread: "owner", actor: "thread", purpose: "conversation" });
    const input = { messages: [{ role: "user" as const, content: "Authorization: Bearer never-store-this", timestamp: Date.now() }] };
    const stream = models.streamSimple(faux.models[0], input);
    const events = []; for await (const event of stream) events.push(event.type);
    expect(events).toEqual(["start", "done"]); expect((await stream.result()).content).toEqual(message.content);
    await models.complete(faux.models[0], input);
    await models.completeSimple(faux.models[0], input);
    await models.stream(faux.models[0], input).result();
    await Promise.all(pending);
    const store = env.REQUESTS.getByName("main"), page = await store.list(query());
    expect(page.requests).toHaveLength(4);
    for (const r of page.requests) expect(r).toMatchObject({ inputTokens: 14, outputTokens: 3, cacheRead: 5, cacheWrite: 2, reasoningTokens: 2, status: "done" });
    expect(page.requests.filter(r => r.purpose === "compaction")).toHaveLength(1);
    const captured = await store.detail(page.requests[0].id);
    expect(JSON.stringify(captured)).not.toContain("never-store-this");
    expect(captured?.context?.messages[0].text).toContain("已隐藏");
    expect((await store.usage(query())).summary).toMatchObject({ requests: 4, measured: 4, inputTokens: 56, outputTokens: 12 });
  });
  it("distinguishes provider-reported zero from missing usage on failure", async () => {
    const faux = fauxProvider({ models: [{ id: "test" }] }), base = createModels();
    let reported = false;
    const make = (_m: unknown, _c: unknown, options?: StreamOptions) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = fauxAssistantMessage("", { stopReason: "error",
        errorMessage: "<html><head><style>" + ".hidden{display:none}".repeat(100) + "</style></head><body><h1>Request blocked</h1><p>Contact support.</p></body></html>" });
      void (async () => {
        await options?.onResponse?.({ status: 403, headers: { "content-type": "text/html", "set-cookie": "never-store-cookie" } }, faux.models[0]);
        if (reported) await options?.onProviderStreamEvent?.({ usage: { prompt_tokens: 0, completion_tokens: 0 } }, faux.models[0]);
        stream.push({ type: "error", reason: "error", error: message });
      })();
      return stream;
    };
    base.setProvider({ ...faux.provider, stream: make, streamSimple: make });
    const pending: Promise<unknown>[] = [];
    const models = captureModels(base, env, { waitUntil: p => { pending.push(p); } }, { thread: "owner", actor: "thread", purpose: "background" });
    const statuses: number[] = [];
    await models.complete(faux.models[0], { messages: [] }, { onResponse: value => { statuses.push(value.status); } }); await Promise.all(pending);
    reported = true; await models.completeSimple(faux.models[0], { messages: [] }); await Promise.all(pending);
    const rows = (await env.REQUESTS.getByName("main").list(query())).requests;
    expect(rows.map(r => r.inputTokens)).toEqual([0, null]);
    expect(rows.every(r => r.status === "error")).toBe(true);
    expect(rows.map(r => r.error)).toEqual(["HTTP 403 · Request blocked\nContact support.", "HTTP 403 · Request blocked\nContact support."]);
    expect(statuses).toEqual([403]);
    expect(JSON.stringify(rows)).not.toContain("never-store-cookie");
  });
  it("keeps ordinary errors readable and redacts credentials before formatting", () => {
    expect(errorSummary("invalid model", 400)).toBe("HTTP 400 · invalid model");
    expect(errorSummary("Authorization: Bearer never-store-this", 401)).toBe("HTTP 401 · [含凭据的内容已隐藏]");
  });
  it("deduplicates terminal writes, pages without overlap, filters and ages details independently", async () => {
    const store = env.REQUESTS.getByName("main"), a = detail(crypto.randomUUID()), b = detail(crypto.randomUUID());
    await store.record(a); await store.record(b); await store.record(a);
    await store.record({ ...a, request: { ...a.request, status: "running", endedAt: null, inputTokens: null } });
    const first = await store.list({ ...query(), limit: 1 });
    const second = await store.list({ ...query(), limit: 1, before: first.next });
    expect(first.requests.map(r => r.id)).toEqual([b.request.id]); expect(second.requests.map(r => r.id)).toEqual([a.request.id]);
    expect(second.requests[0].status).toBe("done");
    expect((await store.list({ ...query(), thread: "group:123" })).requests).toEqual([]);
    const old = detail(crypto.randomUUID(), Date.now() - 8 * 86400_000); await store.record(old);
    expect((await store.detail(old.request.id))?.detailAvailable).toBe(false);
    expect((await store.usage({ ...query(), since: Date.now() - 10 * 86400_000 })).summary.requests).toBe(3);
    await runInDurableObject(store, (_instance, state) => { expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM request_details").one().n).toBe(2); });
  });
  it("guards every new route and validates queries", async () => {
    for (const path of ["/admin/requests", "/admin/usage", "/admin/requests/"+crypto.randomUUID(), "/admin/threads/owner/chat"]) {
      expect((await worker.fetch(new Request("https://test"+path), { ...env, ADMIN_TOKEN:"test" })).status).toBe(401);
    }
    const call = (path: string) => worker.fetch(new Request("https://test"+path, { headers:{Authorization:"Bearer test"} }), { ...env, ADMIN_TOKEN:"test" });
    for (const q of ["status=unexpected", "since=NaN", "limit=101", "thread=other", "since=0&until=9999999999999"]) expect((await call("/admin/requests?"+q)).status).toBe(400);
    expect((await call("/admin/usage")).status).toBe(200);
  });
});
