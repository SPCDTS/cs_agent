import { mediaFixture } from "../context/media-fixture.js";
import type { MediaRecall } from "../../src/context/media.js";
import { ContextUsageStore } from "../../src/agent/context-usage.js";
import { piContextCapacity } from "../../src/agent/pi-context-usage.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { trace } from "../../src/obs/trace.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { CompactionEntry, defineDoc, MemoryStorage, type Harness, type JsonObject, type ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBackend, PiThreadsArchiveDoc } from "../../src/agent/backends/pi.js";
import { createBackendSelector } from "../../src/agent/backends/select.js";
import { BackendTimeoutError, type AgentRequest } from "../../src/agent/backends/types.js";
import { DeepSeekWeb, publicPageUrl } from "../../src/agent/pi-tools/web.js";
import { DEFAULT_PI_PROMPT, PiPromptLoader } from "../../src/agent/pi-tools/prompt.js";
import { PiRequestDoc } from "../../src/agent/pi-tools/request.js";
import { ContextStore } from "../../src/context/store.js";
import { TRANSPARENT_PNG, type ImageBackend } from "../../src/agent/image-gen.js";
import { closeAgentHarnesses } from "../../src/agent/shutdown.js";
import { TicketDoc, DispatchDoc } from "../../src/agent/docs.js";
import { Dispatcher } from "../../src/agent/dispatch.js";
import { createTasks } from "../../src/agent/tasks.js";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { openHarness } from "../../src/agent/harness.js";
import { loadConfig } from "../../src/config.js";
import type { InboundMessage, ReplyTicketRecord } from "../../src/qq/types.js";
import { tmp } from "./helpers.js";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const handleContext = () => ({ signal: new AbortController().signal, onEvent: vi.fn() });
const request = (ticket: string, owner = false): AgentRequest => ({
  ticket, scope: owner ? "private:1" : "group:7", access: owner ? "all" : "group:7", threadKey: owner ? "owner" : "group:7",
  source: { type: owner ? "private" : "group", user_id: "1", group_id: owner ? null : "7", nickname: "测试者" }, text: "查一下", time: 1_760_000_000,
});
const inbound = (id: string, group: string | null, text: string): InboundMessage => ({
  message_id: id, message_type: group ? "group" : "private", group_id: group, user_id: "1", self_id: "2", nickname: "测试者",
  time: Math.floor(Date.now() / 1000), text, route_text: text, truncated: false, mentioned_self: !!group, images: [], segments: [],
});
const reply = (text = "完成") => fauxAssistantMessage(text);
const call = (name: string, args: JsonObject = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const results = (ctx: TranscriptContext) => ctx.messages.filter(m => m.role === "toolResult").map(m => JSON.stringify(m.content)).join("\n");

async function setup(steps: FauxResponseStep[], opts: { dir?: string; timeoutMs?: number; fetch?: typeof fetch; disk?: boolean; reserveTokens?: number; backgroundTokens?: number; mediaRecall?: Pick<MediaRecall, "recall"> } = {}) {
  const dir = opts.dir ?? tmp("cs-pi-");
  const contextUsage = new ContextUsageStore(dir);
  cleanup.push(() => contextUsage.close());
  const store = new ContextStore(dir);
  cleanup.push(() => store.close());
  const faux = fauxProvider({ models: [{ id: "test", contextWindow: 200_000 }], tokensPerSecond: Infinity });
  faux.setResponses(steps);
  const models = createModels(); models.setProvider(faux.provider);
  const imageBackend = {
    name: "fake-comfy", submit: vi.fn(async () => "image-job"),
    collect: vi.fn(async (_id: string, outDir: string) => {
      await fs.mkdir(outDir, { recursive: true }); const file = path.join(outDir, "result.png");
      await fs.writeFile(file, TRANSPARENT_PNG); return [file];
    }),
    reconcile: vi.fn(async () => ({ images: [] as string[] })), clearReferences: vi.fn(async () => {}),
  } satisfies Pick<ImageBackend, "name" | "submit" | "collect" | "reconcile" | "clearReferences">;
  const http = opts.fetch ?? vi.fn(async () => Response.json({ results: [{ title: "资料", date: "2026-10-18", summary: "摘要", url: "https://example.com", rerank_score: 1 }] })) as typeof fetch;
  const web = new DeepSeekWeb({ apiKey: "test-only", fetch: http, backoffMs: 1, resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  const model = faux.getModel();
  const pi = await PiBackend.open({ dataDir: dir, models, model: { provider: model.provider, modelId: model.id },
    mediaRecall: opts.mediaRecall,
    thinkingLevel: "off", store, contextUsage, imageBackend, web, timeoutMs: opts.timeoutMs,
    reserveTokens: opts.reserveTokens, backgroundTokens: opts.backgroundTokens,
    ...(opts.disk ? {} : { storage: new MemoryStorage() }),
  });
  cleanup.push(() => pi.close());
  return { pi, dir, store, contextUsage, faux, http, imageBackend, models };
}

describe("pi durable backend", () => {
  it("qq_image 绑定请求范围，独立五次限额，结果仅有路径文本", async () => {
    let seen: TranscriptContext | undefined;
    const recall = vi.fn(async () => ({ text: "图1: /data/media/ab/test.png（1×1）", images: [{ path: "/data/media/ab/test.png", width: 1, height: 1 }] }));
    const s = await setup([...Array.from({ length: 6 }, () => call("qq_image", { message_id: "123" })), call("qq_recent"),
      ctx => { seen = ctx; return reply(); }], { mediaRecall: { recall } });
    await s.pi.handle(request("recall"), handleContext());
    expect(recall).toHaveBeenCalledTimes(5);
    expect(recall).toHaveBeenCalledWith({ kind: "scope", scope: "group:7" }, "123", expect.any(AbortSignal));
    expect(results(seen!)).toContain("本轮召回次数已用完");
    expect(results(seen!)).toContain("/data/media/ab/test.png");
    const returned = seen!.messages.filter(m => m.role === "toolResult" && m.toolName === "qq_image");
    expect(returned.every(m => m.role === "toolResult" && m.content.every(c => c.type === "text"))).toBe(true);
    expect(results(seen!)).toContain("没有记录");
  });
  it("calls web_search through the faux model, then returns the final answer and source header", async () => {
    let seen: TranscriptContext | undefined;
    const s = await setup([call("web_search", { query: "CS2", count: 3 }), ctx => { seen = ctx; return reply("查到了"); }]);
    expect(await s.pi.handle({ ...request("search"), quote: { message_id: "123", nickname: "友人", text: "此前的问题" } }, handleContext())).toEqual({ text: "查到了", images: [] });
    expect(results(seen!)).toContain("资料 / 2026-10-18 / 摘要 / https://example.com");
    expect(JSON.stringify(seen!.messages)).toContain("[来源] 群 7");
    expect(JSON.stringify(seen!.messages)).toContain("[引用 #123] 友人: 此前的问题");
    const init = vi.mocked(s.http).mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({ query: "CS2", count: 3, need_content: false });
  });

  it("binds history access for each scope request; groups never read private rows", async () => {
    const seen: string[] = [];
    const final = (ctx: TranscriptContext) => { seen.push(results(ctx)); return reply(); };
    const s = await setup([call("qq_recent"), final, call("qq_search", { query: "另群" }), final,
      call("qq_message", { message_id: "private" }), final, call("qq_recent"), final]);
    s.store.ingest(inbound("private", null, "私人秘密"));
    s.store.ingest(inbound("group", "7", "本群消息"));
    s.store.ingest(inbound("other", "8", "另群记录"));
    await s.pi.handle(request("group7"), handleContext());
    expect(seen[0]).toContain("本群消息"); expect(seen[0]).not.toContain("私人秘密"); expect(seen[0]).not.toContain("另群记录");
    await s.pi.handle({ ...request("group8"), scope: "group:8", access: "group:8", source: { ...request("x").source, group_id: "8" } }, handleContext());
    expect(seen[1]).toContain("另群记录");
    await s.pi.handle(request("private-denied"), handleContext());
    expect(seen[2]).toContain("没有这条消息"); expect(seen[2]).not.toContain("私人秘密");
    await s.pi.handle(request("owner", true), handleContext()); expect(seen[3]).toContain("私人秘密");
  });

  it("历史参考图按请求范围校验，允许本群与 owner，拒绝别群和未登记路径", async () => {
    let seen = "";
    const s = await setup([]);
    const media = await mediaFixture(s.store, s.dir, "group:7");
    const foreign = path.join(s.dir, "outside.png"); await fs.writeFile(foreign, TRANSPARENT_PNG);
    s.faux.setResponses([call("generate_image", { prompt: "编辑", reference_images: [media] }), reply(),
      call("generate_image", { prompt: "编辑", reference_images: [media] }), ctx => { seen = results(ctx); return reply(); },
      call("generate_image", { prompt: "编辑", reference_images: [foreign] }), reply(),
      call("generate_image", { prompt: "编辑", reference_images: [media] }), reply()]);
    await s.pi.handle(request("media-own"), handleContext());
    expect(s.imageBackend.submit).toHaveBeenCalledWith(expect.objectContaining({ reference_images: [media] }), expect.anything(), expect.anything());
    await s.pi.handle({ ...request("media-other"), scope: "group:8", access: "group:8", threadKey: "group:8" }, handleContext());
    expect(seen).toContain("范围");
    await s.pi.handle(request("media-outside"), handleContext());
    expect(s.imageBackend.submit).toHaveBeenCalledTimes(1);
    await s.pi.handle(request("media-owner", true), handleContext());
    expect(s.imageBackend.submit).toHaveBeenCalledTimes(2);
  });

  it("writes generated files under the ticket/call directory and returns validated attachments", async () => {
    const s = await setup([call("generate_image", { prompt: "写着“你好”的海报", aspect: "16:9", count: 2 }), reply("图片好了")]);
    const out = await s.pi.handle(request("image"), handleContext());
    expect(out.images).toEqual([await fs.realpath(path.join(s.dir, "images", "image", "call-1", "result.png"))]);
    expect(s.imageBackend.submit.mock.calls).toHaveLength(1);
    expect(s.imageBackend.collect).toHaveBeenCalledOnce();
  });

  it("interrupted image tool retries collect the persisted job with exactly one submit", async () => {
    const s = await setup([], { disk: true });
    const ref = path.join(s.dir, "incoming", "image-retry", "ref.png");
    await fs.mkdir(path.dirname(ref), { recursive: true }); await fs.writeFile(ref, TRANSPARENT_PNG);
    let collecting = false;
    s.imageBackend.collect.mockImplementation(async (_id, _dir, ...extra: unknown[]) => {
      collecting = true;
      const signal = extra[0] as AbortSignal;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("interrupted");
    });
    s.faux.setResponses([call("generate_image", { prompt: "编辑", reference_images: [ref] })]);
    const pending = s.pi.handle({ ...request("image-retry"), images: [ref] }, handleContext()).catch(() => undefined);
    await vi.waitFor(() => expect(collecting).toBe(true));
    const id = (await s.pi.readThreadIds())["group:7"] as ConversationId;
    expect((await s.pi.harness.snapshot(PiRequestDoc, id, context))?.imageJobs?.[0]).toMatchObject({ ordinal: 1, prompt_id: "image-job", status: "submitted" });
    await s.pi.close(); await pending;
    expect(s.imageBackend.clearReferences).not.toHaveBeenCalled();
    const restarted = await setup([call("generate_image", { prompt: "模型重试" }), reply("完成")], { disk: true, dir: s.dir });
    const result = await restarted.pi.handle({ ...request("image-retry"), images: [ref] }, handleContext());
    expect(result.images).toHaveLength(1);
    expect(s.imageBackend.submit).toHaveBeenCalledOnce(); expect(restarted.imageBackend.submit).not.toHaveBeenCalled();
    expect(restarted.imageBackend.collect).toHaveBeenCalledWith("image-job", expect.stringContaining("call-1"), expect.any(AbortSignal), expect.objectContaining({ prompt: "编辑" }));
    expect(restarted.imageBackend.clearReferences).toHaveBeenCalledOnce();
  });

  it("reconciles an image intent when the submit response was lost instead of submitting again", async () => {
    const s = await setup([call("generate_image", { prompt: "猫" }), call("generate_image", { prompt: "重试" }), reply()]);
    s.imageBackend.submit.mockImplementation(async () => {
      const id = (await s.pi.readThreadIds())["group:7"] as ConversationId;
      expect((await s.pi.harness.snapshot(PiRequestDoc, id, context))?.imageJobs?.[0]).toMatchObject({ ordinal: 1, status: "intent", options: { prompt: "猫" } });
      throw new Error("response lost after remote accept");
    });
    s.imageBackend.reconcile.mockImplementation(async (...args: unknown[]) => {
      const dir = args[1] as string;
      const file = path.join(dir, "reconciled.png"); await fs.writeFile(file, TRANSPARENT_PNG);
      return { images: [file] };
    });
    expect((await s.pi.handle(request("image-intent"), handleContext())).images).toHaveLength(1);
    expect(s.imageBackend.submit).toHaveBeenCalledOnce(); expect(s.imageBackend.reconcile).toHaveBeenCalledOnce();
  });

  it("accepts only the current ticket incoming references and cleans uploads", async () => {
    let seen = "";
    const s = await setup([]);
    const own = path.join(s.dir, "incoming", "refs", "ref.png");
    const other = path.join(s.dir, "incoming", "other", "ref.png");
    for (const file of [own, other]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, TRANSPARENT_PNG); }
    s.faux.setResponses([call("generate_image", { prompt: "编辑", reference_images: [other] }), ctx => { seen = results(ctx); return reply(); },
      call("generate_image", { prompt: "编辑", reference_images: [own] }), reply()]);
    await s.pi.handle({ ...request("bad-refs"), images: [] }, handleContext());
    expect(seen).toMatch(/参考图/); expect(s.imageBackend.submit).not.toHaveBeenCalled();
    await s.pi.handle({ ...request("refs"), images: [own] }, handleContext());
    expect(s.imageBackend.submit).toHaveBeenCalledOnce(); expect(s.imageBackend.clearReferences).toHaveBeenCalledOnce();
    await expect(fs.access(path.join(s.dir, "images", "refs", "call-1", "remote-uploads.json"))).rejects.toThrow();
  });

  it.each(["web_search", "fetch_page", "generate_image", "history"])("enforces the %s cap through ToolTask hooks", async kind => {
    let seen = "";
    const names = kind === "history" ? ["qq_recent", "qq_search", "qq_message"] : [kind];
    const cap = kind === "generate_image" ? 2 : 4;
    const args: Record<string, JsonObject> = { web_search: { query: "资料" }, fetch_page: { url: "https://example.com" }, generate_image: { prompt: "猫" }, qq_recent: {}, qq_search: { query: "资料" }, qq_message: { message_id: "1" } };
    const steps = Array.from({ length: cap + 1 }, (_, i) => { const name = names[i % names.length]!; return call(name, args[name]); });
    const http = vi.fn(async () => Response.json(kind === "fetch_page" ? { content: "正文" } : { results: [] })) as typeof fetch;
    const s = await setup([...steps, ctx => { seen = results(ctx); return reply(); }], { fetch: http });
    await s.pi.handle(request("caps"), handleContext());
    expect(seen).toContain("已达到本轮调用上限");
    if (kind === "generate_image") expect(s.imageBackend.submit).toHaveBeenCalledTimes(cap);
    else if (kind !== "history") expect(http).toHaveBeenCalledTimes(cap);
    s.faux.appendResponses([call(names[0]!, args[names[0]!]), reply()]);
    await s.pi.handle(request("fresh-cap"), handleContext());
    if (kind === "generate_image") expect(s.imageBackend.submit).toHaveBeenCalledTimes(cap + 1);
  });

  it("isolates owner/scope memories while same-thread turns serialize", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let started = false;
    const seen: string[] = [];
    const s = await setup([async ctx => { seen.push(JSON.stringify(ctx)); started = true; await gate; return reply("owner-first"); },
      ctx => { seen.push(JSON.stringify(ctx)); return reply("shared"); }, ctx => { seen.push(JSON.stringify(ctx)); return reply("owner-second"); }]);
    const first = s.pi.handle({ ...request("first", true), text: "OWNER_ONLY" }, handleContext());
    await vi.waitFor(() => expect(started).toBe(true));
    const second = s.pi.handle({ ...request("second", true), text: "NEXT_OWNER" }, handleContext());
    const parallel = await s.pi.handle({ ...request("parallel"), text: "SHARED_ONLY" }, handleContext());
    expect(parallel.text).toBe("shared"); expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain("OWNER_ONLY");
    release(); await first; await second;
    expect(seen[2]).toContain("OWNER_ONLY"); expect(seen[2]).not.toContain("SHARED_ONLY");
    const ids = await s.pi.readThreadIds(); expect(ids.owner).not.toBe(ids["group:7"]);
    expect(JSON.parse(await fs.readFile(path.join(s.dir, "pi-threads.json"), "utf8"))).toEqual(ids);
  });

  it("isolates two groups and owner transcripts with durable per-scope conversations", async () => {
    const seen: string[] = [];
    const inspect = (ctx: TranscriptContext) => { seen.push(JSON.stringify(ctx.messages)); return reply(); };
    const s = await setup([inspect, inspect, inspect, inspect]);
    await s.pi.handle({ ...request("g7"), text: "GROUP_SEVEN_SECRET" }, handleContext());
    await s.pi.handle({ ...request("g8"), scope: "group:8", access: "group:8", text: "GROUP_EIGHT_SECRET" }, handleContext());
    await s.pi.handle({ ...request("o1", true), text: "OWNER_SECRET" }, handleContext());
    await s.pi.handle(request("g7-again"), handleContext());
    expect(seen[1]).not.toContain("GROUP_SEVEN_SECRET");
    expect(seen[2]).not.toMatch(/GROUP_SEVEN_SECRET|GROUP_EIGHT_SECRET/);
    expect(seen[3]).toContain("GROUP_SEVEN_SECRET");
    expect(seen[3]).not.toMatch(/GROUP_EIGHT_SECRET|OWNER_SECRET/);
    expect(new Set(Object.values(await s.pi.readThreadIds())).size).toBe(3);
    expect(await s.pi.threadHealth()).toEqual({ count: 3, keys: ["group:7", "group:8", "owner"] });
    await expect(s.pi.handle({ ...request("bad-access"), access: "all" }, handleContext())).rejects.toThrow("非法访问范围");
  });

  it("retires the legacy shared mapping once and preserves owner on migration", async () => {
    const s = await setup([reply(), reply()], { disk: true });
    await s.pi.handle(request("legacy-owner", true), handleContext());
    await s.pi.handle(request("legacy-group"), handleContext());
    const ids = await s.pi.readThreadIds();
    const legacy = defineDoc<{ owner: number | null; shared: number | null }>({
      kind: "cs.pi.threads", version: 1, scope: "session", initial: () => ({ owner: null, shared: null }),
    });
    await s.pi.harness.commit(async tx => {
      const doc = await tx.doc(legacy);
      Object.assign(doc, { owner: ids.owner, shared: ids["group:7"] });
      delete (doc as Record<string, unknown>)["group:7"];
    }, context);
    await s.pi.close();
    const reopened = await setup([reply()], { dir: s.dir, disk: true });
    expect(await reopened.pi.readThreadIds()).toEqual({ owner: ids.owner });
    await reopened.pi.handle(request("new-group"), handleContext());
    expect((await reopened.pi.readThreadIds())["group:7"]).not.toBe(ids["group:7"]);
    expect((await reopened.pi.readThreadIds()).shared).toBeUndefined();
  });

  it("reuses requestId receipts after another request and after SQLite reopen", async () => {
    const s = await setup([reply("first"), reply("second")], { disk: true });
    await s.pi.handle(request("once"), handleContext());
    await s.pi.handle(request("next"), handleContext());
    expect((await s.pi.handle(request("once"), handleContext())).text).toBe("first");
    expect(s.faux.state.callCount).toBe(2);
    const ids = await s.pi.readThreadIds(); await s.pi.close();
    await fs.unlink(path.join(s.dir, "pi-threads.json"));
    const reopened = await setup([], { dir: s.dir, disk: true });
    expect(await reopened.pi.readThreadIds()).toEqual(ids);
    expect((await reopened.pi.handle(request("once"), handleContext())).text).toBe("first");
    expect(reopened.faux.state.callCount).toBe(0);
  });

  it("hot-loads agent.md without overwriting existing text", async () => {
    const seen: string[] = [];
    const inspect = (ctx: TranscriptContext) => { seen.push(JSON.stringify(ctx)); return reply(); };
    const s = await setup([inspect, inspect]);
    const file = path.join(s.dir, "prompts", "agent.md");
    expect(await fs.readFile(file, "utf8")).toBe(DEFAULT_PI_PROMPT);
    await s.pi.handle(request("prompt1"), handleContext());
    await fs.writeFile(file, "新系统提示：简短中文。", "utf8");
    const future = new Date(Date.now() + 2000); await fs.utimes(file, future, future);
    await s.pi.handle(request("prompt2"), handleContext());
    expect(seen[1]).toContain("新系统提示：简短中文。");
    expect(await new PiPromptLoader(s.dir).read()).toBe("新系统提示：简短中文。");
  });

  it("resumes an interrupted safe tool with its original request binding before a new same-scope turn", async () => {
    let started = false;
    const http: typeof fetch = async (_url, init) => {
      started = true;
      await new Promise<void>(resolve => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted");
    };
    const s = await setup([call("web_search", { query: "旧请求" })], { disk: true, fetch: http });
    const pending = s.pi.handle(request("interrupted"), handleContext()).catch(() => undefined);
    await vi.waitFor(() => expect(started).toBe(true));
    const id = (await s.pi.readThreadIds())["group:7"] as ConversationId;
    expect((await s.pi.harness.snapshot(PiRequestDoc, id, context))?.access).toBe("group:7");
    await s.pi.close(); await pending;
    let resumed: TranscriptContext | undefined;
    const r = await setup([ctx => { resumed = ctx; return reply("旧请求完成"); }, reply("新请求完成")], { disk: true, dir: s.dir });
    const next = r.pi.handle(request("new"), handleContext());
    expect((await r.pi.handle(request("interrupted"), handleContext())).text).toBe("旧请求完成");
    expect((await next).text).toBe("新请求完成");
    expect(results(resumed!)).toContain("资料"); expect(r.http).toHaveBeenCalledOnce();
    expect((await r.pi.harness.snapshot(PiRequestDoc, id, context))?.access).toBe("group:7");
  });

  it("automatically compacts long-lived history with configured thresholds", async () => {
    const contexts: string[] = [];
    const respond = (ctx: TranscriptContext) => {
      const text = JSON.stringify(ctx); contexts.push(text);
      return reply(text.includes("context summarization assistant") ? "压缩摘要：保留历史事实" : "正常回答");
    };
    const s = await setup(Array.from({ length: 10 }, () => respond), { reserveTokens: 150_000, backgroundTokens: 0 });
    // 第一轮后累计超过 50k tokens；保留最近 20k tokens，第二轮自动阻塞压缩。
    await s.pi.handle({ ...request("long1"), text: "历史事实。".repeat(50_000) }, handleContext());
    await s.pi.handle({ ...request("long2"), text: "近期材料。".repeat(20_000) }, handleContext());
    const id = (await s.pi.readThreadIds())["group:7"] as ConversationId;
    const conv = (await s.pi.harness.conversation(id, context))!;
    await conv.waitForIdle(context);
    const view = await conv.context(context);
    expect(view.entries.some(e => e.kind === "pi.compaction")).toBe(true);
    expect(contexts.some(c => c.includes("context summarization assistant"))).toBe(true);
    await vi.waitFor(() => expect(s.contextUsage.get("pi", "group:7")!.lastCompactionAt).toBeTypeOf("number"));
    expect(s.contextUsage.get("pi", "group:7")).toMatchObject({ turns: 2, compaction: { background: 50000, reserve: 50000 } });
  });

  it("aborts timed-out turns before releasing the mutex", async () => {
    let aborted = false;
    const s = await setup([async (_ctx, opts) => {
      await new Promise<void>(r => {
        if (opts?.signal?.aborted) { aborted = true; r(); }
        else opts?.signal?.addEventListener("abort", () => { aborted = true; r(); }, { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }, reply("next")], { timeoutMs: 100 });
    await expect(s.pi.handle(request("timeout"), handleContext())).rejects.toBeInstanceOf(BackendTimeoutError);
    expect(aborted).toBe(true);
    expect((await s.pi.handle(request("after-timeout"), handleContext())).text).toBe("next");
    const inspection = await s.pi.harness.inspect(context); expect(inspection.tasks).toHaveLength(0);
  });

  it("cancels a queued request without submitting it", async () => {
    let release!: () => void; let started = false;
    const gate = new Promise<void>(r => { release = r; });
    const s = await setup([async () => { started = true; await gate; return reply(); }]);
    const first = s.pi.handle(request("blocking"), handleContext());
    await vi.waitFor(() => expect(started).toBe(true));
    const cancel = new AbortController();
    const queued = s.pi.handle(request("cancelled"), { ...handleContext(), signal: cancel.signal });
    cancel.abort(); await expect(queued).rejects.toThrow();
    release(); await first; expect(s.faux.state.callCount).toBe(1);
  });

  it.each(["model", "tool"])("resumes after coordinated ticket/pi shutdown during %s with exactly one answer", async phase => {
    let started = false;
    const wait = async (signal?: AbortSignal | null) => {
      started = true;
      await new Promise<void>(resolve => signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true }));
    };
    const s = await setup(phase === "model" ? [async (_ctx, opts) => {
      await wait(opts?.signal); return fauxAssistantMessage("", { stopReason: "aborted" });
    }] : [call("web_search", { query: "恢复测试" })], { disk: true, fetch: async (_url, init) => {
      await wait(init?.signal); throw new Error("aborted");
    } });
    const replies: string[] = [];
    const bridge = {
      getTicket: async (ticket: string) => ({ ticket_id: ticket, status: replies.length ? "sent" : "pending", seq: 1 }) as ReplyTicketRecord,
      listPendingTickets: async () => [],
      reply: async (_ticket: string, text: string) => { replies.push(text); return { message_id: "one", already_sent: false, message_type: "group" as const, target_id: "7" }; },
    };
    const bootTickets = async (backend: typeof s) => {
      const tasks = createTasks({ getBridge: () => bridge, imageBackend: backend.imageBackend, imagesDir: path.join(s.dir, "images"),
        backends: createBackendSelector({ defaultBackend: "pi", overrides: {}, backends: { pi: backend.pi } }), codexReplyMode: "direct" });
      const harness = await openHarness({ models: backend.models, extension: createCsAgentExtension(tasks), dbFile: path.join(s.dir, "tickets.sqlite") }, context);
      cleanup.push(() => harness.close(context));
      return { harness, dispatcher: new Dispatcher({ harness, bridge, tasks, concurrency: 2, retryDelayMs: 1 }) };
    };
    const t = await bootTickets(s);
    const pending = t.dispatcher.dispatch(inbound("shutdown", "7", "原始输入"), "shutdown");
    await vi.waitFor(() => expect(started).toBe(true));
    const ticketId = (await t.harness.snapshot(DispatchDoc, context))!.pending.shutdown!.conversationId as ConversationId;
    await closeAgentHarnesses(t.harness, s.pi); await pending;
    expect(replies).toEqual([]);
    const restarted = await setup([reply("恢复后的唯一回答")], { disk: true, dir: s.dir });
    const t2 = await bootTickets(restarted);
    await t2.dispatcher.recover(); t2.harness.resume(); await t2.dispatcher.idle();
    expect(replies).toEqual(["恢复后的唯一回答"]);
    expect((await t2.harness.snapshot(TicketDoc, ticketId, context))?.agentResult).toMatchObject({ ok: true, text: "恢复后的唯一回答" });
    expect(restarted.faux.state.callCount).toBe(1);
  });

  it.each([false, true])("persists a fresh request id before retrying an existing aborted receipt exactly once; crash before submit=%s", async crash => {
    let started = false;
    const s = await setup([async (_ctx, opts) => {
      started = true;
      await new Promise<void>(resolve => opts?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }], { disk: true });
    const cancel = new AbortController();
    const pending = s.pi.handle({ ...request("legacy-abort"), text: "原始输入" }, { ...handleContext(), signal: cancel.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(started).toBe(true)); cancel.abort(); await pending;
    const conv = (await s.pi.harness.conversation((await s.pi.readThreadIds())["group:7"] as ConversationId, context))!;
    await conv.waitForIdle(context);
    await conv.commit(async tx => { (await tx.doc(PiRequestDoc, conv.id)).deadline = Date.now() - 1000; }, context);
    await s.pi.close();
    const restarted = await setup([ctx => { expect(JSON.stringify(ctx.messages)).toContain("原始输入"); return reply("恢复完成"); }], { disk: true, dir: s.dir });
    const ticketHarness = await openHarness({ models: restarted.models, extension: createCsAgentExtension(createTasks({
      getBridge: () => { throw new Error("unused"); }, imageBackend: restarted.imageBackend, imagesDir: path.join(s.dir, "images"),
      backends: createBackendSelector({ defaultBackend: "pi", overrides: {}, backends: { pi: restarted.pi } }), codexReplyMode: "direct",
    })), storage: new MemoryStorage() }, context);
    cleanup.push(() => ticketHarness.close(context));
    const ticket = await ticketHarness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const persistPiTurn = async (state: { requestId: string; retries: number }) => {
      expect(restarted.faux.state.callCount).toBe(0);
      await ticket.commit(async tx => { (await tx.doc(TicketDoc, ticket.id)).piTurn = state; }, context);
      if (crash) throw new Error("crash before submit");
    };
    const retry = restarted.pi.handle(request("legacy-abort"), { ...handleContext(), persistPiTurn });
    if (crash) await expect(retry).rejects.toThrow("crash before submit");
    else expect((await retry).text).toBe("恢复完成");
    const piTurn = (await ticketHarness.snapshot(TicketDoc, ticket.id, context))!.piTurn!;
    expect(piTurn).toEqual({ requestId: "legacy-abort#r1", retries: 1 });
    expect((await restarted.pi.handle(request("legacy-abort"), { ...handleContext(), piTurn, persistPiTurn })).text).toBe("恢复完成");
    expect(restarted.faux.state.callCount).toBe(1);
  });

  it("AGENT_BACKEND=pi dispatches through durable tasks and attaches images to the original ticket", async () => {
    const s = await setup([call("generate_image", { prompt: "猫" }), reply("# 图片好了 @你")]);
    const cfg = loadConfig({ AGENT_BACKEND: "pi", DATA_DIR: s.dir });
    const replies: { ticket: string; text: string; images?: string[] }[] = [];
    let sent = false;
    const bridge = {
      getTicket: async (ticket: string) => ({ ticket_id: ticket, status: sent ? "sent" : "pending", seq: 1 }) as ReplyTicketRecord,
      listPendingTickets: async () => [],
      reply: async (ticket: string, text: string, images?: string[]) => { replies.push({ ticket, text, images }); sent = true;
        return { message_id: "reply-id", already_sent: false, message_type: "group" as const, target_id: "7" }; },
    };
    const tasks = createTasks({ getBridge: () => bridge, imageBackend: s.imageBackend, imagesDir: path.join(s.dir, "images"),
      backends: createBackendSelector({ defaultBackend: cfg.AGENT_BACKEND, overrides: cfg.backendOverrides, backends: { pi: s.pi } }),
      codexReplyMode: "relay", owner: "1", store: s.store,
    });
    const harness: Harness = await openHarness({ models: s.models, extension: createCsAgentExtension(tasks), storage: new MemoryStorage() }, context);
    cleanup.push(() => harness.close(context));
    const dispatcher = new Dispatcher({ harness, bridge, tasks, concurrency: 2, retryDelayMs: 1 });
    await dispatcher.dispatch(inbound("message", "7", "请画只猫"), "dispatch-pi"); await dispatcher.idle();
    expect(replies).toHaveLength(1); expect(replies[0]!.ticket).toBe("dispatch-pi");
    expect(replies[0]!.text).toBe("图片好了 ＠你"); expect(replies[0]!.images).toHaveLength(1);
    expect(s.faux.state.callCount).toBe(2);
  });
});

describe("DeepSeek tools", () => {
  it("sorts rerank_score and bounds search/fetch output", async () => {
    const http = vi.fn().mockResolvedValueOnce(Response.json({ results: [
      { title: "低", rerank_score: 1 }, { title: "高", rerank_score: 2, summary: "字".repeat(3000) },
    ] })).mockResolvedValueOnce(Response.json({ data: { content: "文".repeat(5000) } }));
    const web = new DeepSeekWeb({ apiKey: "fake", fetch: http, resolve: async () => [{ address: "8.8.8.8", family: 4 }] });
    const search = await web.search("关键词"); expect(search.startsWith("高")).toBe(true); expect(search.length).toBeLessThanOrEqual(2500);
    expect((await web.page("https://example.com")).length).toBeLessThanOrEqual(4000);
  });
  it("retries 429 once and never retries other 4xx", async () => {
    const http = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(Response.json({ results: [] }));
    await new DeepSeekWeb({ apiKey: "fake", fetch: http, backoffMs: 1 }).search("q"); expect(http).toHaveBeenCalledTimes(2);
    for (const status of [400, 401, 403, 404, 429]) {
      const failed = vi.fn(async () => new Response("secret body", { status }));
      await expect(new DeepSeekWeb({ apiKey: "fake", fetch: failed, backoffMs: 1 }).search("q")).rejects.toThrow(`HTTP ${status}`);
      expect(failed).toHaveBeenCalledTimes(status === 429 ? 2 : 1);
    }
  });
  it.each(["file:///data/secrets", "http://localhost", "http://host.docker.internal", "http://127.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "https://user:pass@example.com", "http://10.1.2.3", "http://169.254.169.254"])("rejects private URL %s before HTTP", async url => {
    await expect(publicPageUrl(url)).rejects.toThrow();
  });
  it("rejects DNS answers containing any private address", async () => {
    await expect(publicPageUrl("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }, { address: "192.168.1.1", family: 4 }])).rejects.toThrow(/内部网络/);
  });
});

describe("pi resetThread", () => {
  it("archives the conversation mapping; the next message starts a new conversation", async () => {
    const s = await setup([reply("一"), reply("二")]);
    await s.pi.handle(request("before"), handleContext());
    const before = (await s.pi.readThreadIds())["group:7"];
    expect(before).toBeTypeOf("number");
    expect(await s.pi.resetThread("group:7")).toBe(before);
    expect(s.contextUsage.get("pi", "group:7")).toMatchObject({ usedTokens: 0, cachedTokens: 0, turns: 0, source: "estimate", windowTokens: 200000 });
    expect((await s.pi.readThreadIds())["group:7"]).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(s.dir, "pi-threads.json"), "utf8"))).not.toHaveProperty("group:7");
    const archive = (await fs.readFile(path.join(s.dir, "pi-threads-archive.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    expect(archive).toEqual([expect.objectContaining({ key: "group:7", conversation: before })]);
    await s.pi.handle(request("after"), handleContext());
    const after = (await s.pi.readThreadIds())["group:7"];
    expect(after).toBeTypeOf("number"); expect(after).not.toBe(before);
    expect(await s.pi.resetThread("private:5")).toBeNull();
    await expect(s.pi.resetThread("../etc")).rejects.toThrow("非法会话键");
  });
});


describe("pi 重置事务与归档轮换", () => {
  it("SQLite 归档追加失败会回滚映射清空并报告错误", async () => {
    const s = await setup([reply()], { disk: true });
    await s.pi.handle(request("before-failure"), handleContext());
    const before = await s.pi.readThreadIds();
    const commit = s.pi.harness.commit.bind(s.pi.harness);
    const fail = vi.spyOn(s.pi.harness, "commit").mockImplementationOnce((change, ctx) => commit(async tx => {
      const doc = tx.doc.bind(tx);
      const proxy = new Proxy(tx, { get(target, key, receiver) {
        if (key === "doc") return (...args: unknown[]) => {
          if (args[0] === PiThreadsArchiveDoc) throw new Error("archive append failed");
          return Reflect.apply(doc, tx, args);
        };
        return Reflect.get(target, key, receiver);
      } });
      return change(proxy);
    }, ctx));
    try { await expect(s.pi.resetThread("group:7")).rejects.toThrow("archive append failed"); }
    finally { fail.mockRestore(); }
    expect(await s.pi.readThreadIds()).toEqual(before);
    expect((await s.pi.harness.snapshot(PiThreadsArchiveDoc, context))?.rows).toEqual([]);
    expect(JSON.parse(await fs.readFile(path.join(s.dir, "pi-threads.json"), "utf8"))).toEqual(before);
    await s.pi.close();
    const restarted = await setup([], { dir: s.dir, disk: true });
    expect(await restarted.pi.readThreadIds()).toEqual(before);
    expect((await restarted.pi.harness.snapshot(PiThreadsArchiveDoc, context))?.rows).toEqual([]);
  });

  it("提交后 JSON/JSONL 镜像写入失败，重启从 SQLite 修复且不重复归档", async () => {
    const s = await setup([reply()], { disk: true });
    await s.pi.handle(request("mirror-failure"), handleContext());
    const before = await s.pi.readThreadIds();
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(new Error("mirror write failed"));
    try { expect(await s.pi.resetThread("group:7")).toBe(before["group:7"]); }
    finally { rename.mockRestore(); }
    expect(await s.pi.readThreadIds()).toEqual({});
    expect(JSON.parse(await fs.readFile(path.join(s.dir, "pi-threads.json"), "utf8"))).toEqual(before);
    expect((await s.pi.harness.snapshot(PiThreadsArchiveDoc, context))?.rows).toHaveLength(1);
    await s.pi.close();
    const restarted = await setup([], { dir: s.dir, disk: true });
    expect(await restarted.pi.readThreadIds()).toEqual({});
    expect(JSON.parse(await fs.readFile(path.join(s.dir, "pi-threads.json"), "utf8"))).toEqual({});
    const rows = (await fs.readFile(path.join(s.dir, "pi-threads-archive.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toEqual([expect.objectContaining({ conversation: before["group:7"] })]);
    expect(await restarted.pi.resetThread("group:7")).toBeNull();
    expect((await restarted.pi.harness.snapshot(PiThreadsArchiveDoc, context))?.rows).toHaveLength(1);
  });

  it("导入旧归档及后续重置只保留最新 200 条，重启不重复导入", async () => {
    const dir = tmp("pi-archive-rotation-");
    const rows = Array.from({ length: 205 }, (_, i) => ({ key: "group:7", conversation: 10000 + i, archived_at: new Date(i * 1000).toISOString(), reason: "legacy" }));
    await fs.writeFile(path.join(dir, "pi-threads-archive.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const s = await setup([reply()], { dir, disk: true });
    expect((await s.pi.harness.snapshot(PiThreadsArchiveDoc, context))?.rows).toEqual(rows.slice(-200));
    await s.pi.handle(request("rotate"), handleContext());
    const id = (await s.pi.readThreadIds())["group:7"];
    await s.pi.resetThread("group:7");
    const archive = (await s.pi.harness.snapshot(PiThreadsArchiveDoc, context))!.rows;
    expect(archive).toHaveLength(200);
    expect(archive[0]).toEqual(rows[6]); expect(archive.at(-1)?.conversation).toBe(id);
    const file = path.join(dir, "pi-threads-archive.jsonl");
    expect((await fs.readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual(archive);
    await s.pi.close();
    await fs.writeFile(file, JSON.stringify(rows[0]) + "\n", "utf8");
    const reopened = await setup([], { dir, disk: true });
    expect((await reopened.pi.harness.snapshot(PiThreadsArchiveDoc, context))?.rows).toEqual(archive);
    expect((await fs.readFile(file, "utf8")).trim().split("\n")).toHaveLength(200);
  });
});


describe("pi 上下文占用", () => {
  it("缺失用量文件时恢复 faux 会话历史与压缩时间，重开不调用模型", async () => {
    const s = await setup([call("web_search", { query: "history" }), reply("第一轮"), reply("第二轮")], { disk: true });
    await s.pi.handle(request("history-one"), handleContext());
    await s.pi.handle(request("history-two"), handleContext());
    const conv = (await s.pi.harness.conversation((await s.pi.readThreadIds())["group:7"] as ConversationId, context))!;
    const messages = (await conv.context(context)).entries.flatMap(e => e.model ?? []).filter(m => m.role === "assistant");
    const last = messages.at(-1)!;
    const compactedAt = last.timestamp + 1;
    await conv.commit(async tx => {
      // 用量位于第二页，且已被压缩移出活动快照。
      for (let i = 0; i < 260; i++) await tx.appendEntry(conv.id, { kind: "test.bookkeeping" });
      await tx.appendEntry(conv.id, { kind: CompactionEntry.kind, head: "self",
        model: [{ role: "user", content: "历史摘要", timestamp: compactedAt }], data: { reason: "manual" } });
    }, context);
    await s.pi.close(); await s.contextUsage.close();
    await fs.unlink(path.join(s.dir, "context-usage.json"));
    const restarted = await setup([reply("恢复后的新回合")], { dir: s.dir, disk: true });
    expect(restarted.contextUsage.get("pi", "group:7")).toMatchObject({ turns: 3, source: "turn",
      usedTokens: last.usage.input + last.usage.cacheRead + last.usage.cacheWrite, cachedTokens: last.usage.cacheRead,
      updatedAt: last.timestamp, lastCompactionAt: compactedAt, windowTokens: 200000,
      compaction: piContextCapacity(200000).compaction });
    expect(restarted.faux.state.callCount).toBe(0);
    await restarted.pi.handle(request("history-three"), handleContext());
    await vi.waitFor(() => expect(restarted.contextUsage.get("pi", "group:7")!.turns).toBe(4));
    await restarted.pi.resetThread("group:7");
    expect(restarted.contextUsage.get("pi", "group:7")).toMatchObject({ usedTokens: 0, turns: 0, source: "estimate" });
    expect(restarted.contextUsage.get("pi", "group:7")!.lastCompactionAt).toBeUndefined();
  });

  it("从 assistant 条目取输入与缓存，每次模型回合更新，重复回执不重复计数", async () => {
    const tool = call("web_search", { query: "usage" });
    const answer = reply("完成采集");
    const s = await setup([tool, answer], { reserveTokens: 16000, backgroundTokens: 32000 });
    const events: { ticket: string; detail: Record<string, unknown> }[] = [];
    const untap = trace.tap(e => { if (e.stage === "context_usage" && e.detail.source === "turn") events.push(e); });
    try {
      await s.pi.handle(request("usage-turn"), handleContext());
      const conv = (await s.pi.harness.conversation((await s.pi.readThreadIds())["group:7"] as ConversationId, context))!;
      const messages = (await conv.context(context)).entries.flatMap(e => e.model ?? []).filter(m => m.role === "assistant");
      expect(messages).toHaveLength(2);
      const actual = messages[1]!.usage;
      expect(actual.cacheRead).toBeGreaterThan(0);
      await vi.waitFor(() => expect(s.contextUsage.get("pi", "group:7")).toMatchObject({
        usedTokens: actual.input + actual.cacheRead + actual.cacheWrite, cachedTokens: actual.cacheRead, windowTokens: 200000, turns: 2, source: "turn",
        compaction: { background: 152000, reserve: 184000 },
      }));
      expect(events.map(e => [e.ticket, e.detail.usedTokens])).toEqual(messages.map(m => ["usage-turn", m.usage.input + m.usage.cacheRead + m.usage.cacheWrite]));
      await s.pi.handle(request("usage-turn"), handleContext());
      expect(s.contextUsage.get("pi", "group:7")!.turns).toBe(2);
      await s.contextUsage.flush();
      expect(new ContextUsageStore(s.dir).all()).toEqual(s.contextUsage.all());
      await s.pi.resetThread("group:7");
      expect(s.contextUsage.get("pi", "group:7")).toMatchObject({ usedTokens: 0, turns: 0, source: "estimate" });
      expect(s.contextUsage.get("pi", "group:7")!.lastCompactionAt).toBeUndefined();
    } finally { untap(); }
  });

  it("deepseek-flash 使用 pi-ai 的 1000000 窗口与默认实际压缩位置", () => {
    const model = builtinModels().getModel("deepseek", "deepseek-flash")!;
    expect(piContextCapacity(model.contextWindow)).toEqual({ windowTokens: 1000000,
      compaction: { background: 950848, reserve: 983616 } });
    expect(piContextCapacity(model.contextWindow, 16384, 0).compaction).toEqual({ background: 983616, reserve: 983616 });
  });
});
