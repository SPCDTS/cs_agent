import type { ImageOptions } from "../../src/media/gen/image-options.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createImageGenServer } from "../../src/mcp/image-gen-server.js";
import { HttpImageBackend } from "../../src/media/gen/image-gen.js";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { Harness, ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dispatcher, FALLBACK_REPLY, MAX_ATTEMPTS } from "../../src/agent/dispatch.js";
import { DispatchDoc, TicketDoc } from "../../src/agent/docs.js";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { openHarness } from "../../src/agent/harness.js";
import { CodexRunner } from "../../src/agent/codex/runner.js";
import { CodexBackend } from "../../src/agent/backends/codex.js";
import { createBackendSelector, PiBackendStub } from "../../src/agent/backends/select.js";
import type { AgentBackend, BackendName } from "../../src/agent/backends/types.js";
import { createTasks, MAX_REPLY_ATTEMPTS } from "../../src/agent/tasks.js";
import { imageFilenamePrefix, UnknownJobError, type ImageBackend, type ImageSubmission, type ReconcileProgress } from "../../src/media/gen/image-gen.js";
import { AGENT_FAILURE_REPLIES, IMAGE_FAILURE_REPLIES, IMAGE_SUCCESS_REPLY } from "../../src/agent/replies.js";
import { IMAGE_USAGE_REPLY } from "../../src/agent/router.js";
import type { InboundMessage, ReplyTicketRecord } from "../../src/qq/types.js";
import { ContextStore } from "../../src/context/store.js";
import { FIXTURES, tmp } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;
const OWNER = "10000001";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

/** QQBridge 桩：记录 reply，维护票据状态。 */
class BridgeStub {
  replies: { ticket: string; text: string; images?: string[] }[] = [];
  status = new Map<string, ReplyTicketRecord["status"]>();
  pending: ReplyTicketRecord[] = [];
  getTicketFailures = 0;
  prepareIncoming?: (ticket: string) => Promise<ReplyTicketRecord | null>;
  /** true 时 reply 在发送前失败（票据保持 pending） */
  replyDown = false;
  /** >0 时接下来的 reply 在发送前失败，每次减 1 */
  failBeforeSend = 0;
  /** 设置后 reply 挂起直到它被 resolve/reject（模拟进程在发送中途关闭） */
  hang: ReturnType<typeof deferred<void>> | undefined;
  calls = 0;
  async reply(ticket: string, text: string, images?: string[]) {
    this.calls++;
    if (this.hang) {
      const h = this.hang;
      this.hang = undefined;
      await h.promise; // reject 时抛出，未发送
    }
    if (this.replyDown) throw new Error("NapCat unreachable");
    if (this.failBeforeSend > 0) {
      this.failBeforeSend--;
      throw new Error("get_login_info timeout");
    }
    const already = this.status.get(ticket) === "sent";
    if (!already) this.replies.push({ ticket, text, images });
    this.status.set(ticket, "sent");
    return { already_sent: already, message_id: `m-${ticket}`, message_type: "private" as const, target_id: "1" };
  }
  /** 票据 seq（admit 顺序）：可预设；未预设的在首次读取时按递增顺序分配 */
  seqs = new Map<string, number>();
  nextSeq = 1000;
  listCalls: { limit?: number; after?: number }[] = [];
  seqOf(ticket: string): number {
    let s = this.seqs.get(ticket) ?? this.pending.find((r) => r.ticket_id === ticket)?.seq;
    if (s === undefined) this.seqs.set(ticket, (s = this.nextSeq++));
    return s;
  }
  async getTicket(ticket: string) {
    if (this.getTicketFailures > 0) {
      this.getTicketFailures--;
      throw new Error("db locked");
    }
    return { ticket_id: ticket, seq: this.seqOf(ticket), status: this.status.get(ticket) ?? "pending" } as ReplyTicketRecord;
  }
  async listPendingTickets(limit = 200, after = 0) {
    this.listCalls.push({ limit, after });
    return this.pending
      .filter((r) => (this.status.get(r.ticket_id) ?? "pending") === "pending" && r.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }
}

function inbound(text: string, opts: { id?: string; group?: string; user?: string; routeText?: string } = {}): InboundMessage {
  return {
    route_text: opts.routeText ?? text,
    message_id: opts.id ?? "100",
    time: 1_760_000_000,
    message_type: opts.group ? "group" : "private",
    user_id: opts.user ?? OWNER,
    group_id: opts.group ?? null,
    self_id: "1",
    nickname: "tester",
    text,
    truncated: false,
    mentioned_self: !!opts.group,
    images: [], segments: [{ type: "text", data: { text } }],
  };
}

const untilAbort = (signal?: AbortSignal) =>
  new Promise<never>((_r, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

/** 生图桩：submit 记录提示词并返回 prompt_id；collect 按 prompt_id 写一张 PNG。可挂起（模拟崩溃）、失败或报告任务未知。 */
class ImageStub implements Pick<ImageBackend, "submit" | "collect" | "reconcile" | "name"> {
  readonly name = "stub";
  /** 每次 submit 的提示词（= 提交到 ComfyUI 的次数） */
  calls: string[] = [];
  options: ImageOptions[] = [];
  collects: string[] = [];
  collectTimeouts = 0;
  cleared: unknown[] = [];
  async clearReferences(uploads: unknown) { this.cleared.push(uploads); }
  fail: Error | undefined;
  /** 写完文件后挂起，直到 signal 中止 */
  hangAfterWrite = false;
  /** 下一次 collect 在写文件前挂起，直到 signal 中止 */
  hangCollect = false;
  /** 这些 prompt_id 的 collect 报告服务端不认识 */
  unknown = new Set<string>();
  /** collect 不写任何文件（或只写非图片文件） */
  writeNothing = false;
  hangSubmit = false;
  prefixes: (string | undefined)[] = [];
  reconciliations: ImageSubmission[] = [];
  recoveredAt: "history" | "queue" | "probe" | undefined;
  reconcileFail: Error | undefined;
  async submit(opts: ImageOptions, options?: ImageSubmission, signal?: AbortSignal) {
    this.calls.push(opts.prompt);
    this.options.push(opts);
    this.prefixes.push(options?.filenamePrefix);
    if (this.fail) throw this.fail;
    if (this.hangSubmit) await untilAbort(signal);
    return `pid-${this.calls.length}`;
  }
  async reconcile(options: ImageSubmission, outDir: string, _signal?: AbortSignal, onStep?: ReconcileProgress) {
    this.reconciliations.push(options);
    for (const step of ["history", "queue", "probe"] as const) {
      await onStep?.({ step, status: "started" });
      if (this.reconcileFail) throw this.reconcileFail;
      if (this.recoveredAt === step) {
        const prompt_id = step === "probe" ? undefined : "pid-1";
        const filename = `${options.filenamePrefix}_00001_.png`;
        await onStep?.({ step, status: "matched", ...(prompt_id ? { prompt_id } : {}), filenames: [filename] });
        mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, filename);
        writeFileSync(file, PNG);
        return { ...(prompt_id ? { prompt_id } : {}), images: [file] };
      }
      await onStep?.({ step, status: "empty" });
    }
    return { images: [] };
  }
  async collect(promptId: string, outDir: string, signal?: AbortSignal) {
    this.collects.push(promptId);
    if (this.collectTimeouts-- > 0) throw new Error("生图超时");
    if (this.hangCollect) {
      this.hangCollect = false;
      await untilAbort(signal);
    }
    if (this.unknown.has(promptId)) throw new UnknownJobError(promptId);
    mkdirSync(outDir, { recursive: true });
    if (this.writeNothing) {
      writeFileSync(path.join(outDir, "fake.png"), "not really a png, just text padding padding padding");
      return [path.join(outDir, "fake.png")];
    }
    const f = path.join(outDir, `out_${this.calls.length}.png`);
    writeFileSync(f, PNG);
    if (this.hangAfterWrite) await untilAbort(signal);
    return [f];
  }
}

/** agent 后端桩：记录事件，可按文本设置延迟。 */
class BackendStub implements AgentBackend {
  readonly name = "codex" as const;
  events: string[] = [];
  requests: Parameters<AgentBackend["handle"]>[0][] = [];
  delays = new Map<string, number>();
  async handle(req: Parameters<AgentBackend["handle"]>[0], ctx?: Parameters<AgentBackend["handle"]>[1]) {
    this.requests.push(req);
    this.events.push(`start:${req.text}`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.delays.get(req.text) ?? 5);
      ctx?.signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
    });
    this.events.push(`end:${req.text}`);
    return { text: `## 答复\n**${req.text}** ok @all` };
  }
}

interface RigOptions {
  concurrency?: number;
  codex?: AgentBackend;
  codexEffort?: string;
  overrides?: Record<string, BackendName>;
  codexEnv?: Record<string, string>;
}

interface Rig {
  dir: string;
  harness: Harness;
  dispatcher: Dispatcher;
  bridge: BridgeStub;
  image: ImageStub;
  backend: BackendStub;
  store: ContextStore;
  faux: ReturnType<typeof fauxProvider>;
  reopen(): Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.harness.close(ctx).catch(() => undefined);
    r.store.close();
  }
});

async function makeRig(o: RigOptions = {}, shared?: Pick<Rig, "dir" | "bridge" | "image" | "backend" | "store">): Promise<Rig> {
  const dir = shared?.dir ?? tmp("cs-dispatch-");
  const bridge = shared?.bridge ?? new BridgeStub();
  const image = shared?.image ?? new ImageStub();
  const backend = shared?.backend ?? new BackendStub();
  const store = shared?.store ?? new ContextStore(dir);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const backends = createBackendSelector({
    defaultBackend: "codex",
    overrides: o.overrides ?? {},
    backends: { codex: o.codex ?? backend, pi: new PiBackendStub() },
  });
  const tasks = createTasks({
    getBridge: () => bridge,
    imageBackend: image,
    imagesDir: path.join(dir, "images"),
    ticketsDir: path.join(dir, "tickets"),
    backends,
    owner: OWNER,
    store,
    replyRetryDelayMs: 10,
    imageCollectDelayMs: 10,
  });
  const harness = await openHarness({ models, extension: createCsAgentExtension(tasks), dbFile: path.join(dir, "agent.sqlite") }, ctx);
  const dispatcher = new Dispatcher({ harness, bridge, tasks, concurrency: o.concurrency ?? 2, history: store, codexEffort: o.codexEffort ?? "high", retryDelayMs: 10 });
  // 与 main.ts 一致：重开时先 recover() 再开启调度（测试里由 recover 后的 waitForTask 开启）
  if (!shared) harness.resume();
  const rig: Rig = {
    dir, harness, dispatcher, bridge, image, backend, store, faux,
    async reopen() {
      const next = await makeRig(o, rig);
      rigs.splice(rigs.indexOf(next), 1);
      Object.assign(rig, { harness: next.harness, dispatcher: next.dispatcher, faux: next.faux });
    },
  };
  rigs.push(rig);
  return rig;
}

const pendingIndex = async (r: Rig) => (await r.harness.snapshot(DispatchDoc, ctx))?.pending ?? {};
const imgDir = (r: Rig, ticket: string) => path.join(r.dir, "images", ticket);
const bot = (r: Rig) => r.store.recent({ kind: "all" }, { limit: 20 }).filter((row) => row.is_self === 1);

/** 模拟 Codex 回合留下的 MCP 清单，图片只在 lateImages 阶段写入。 */
function leavePendingImages(r: Rig, ticket: string, count = 1) {
  const handle = r.backend.handle.bind(r.backend);
  r.backend.handle = async (...args) => {
    const jobs = Array.from({ length: count }, (_, i) => {
      const callDir = path.join(imgDir(r, ticket), `call-${i + 1}`);
      mkdirSync(callDir, { recursive: true });
      return { prompt_id: `late-${i + 1}`, backend: "stub", filenamePrefix: `cs-${ticket}-${i + 1}`,
        options: { prompt: "慢图", size: "2mp", aspect: "16:9" }, callDir, submittedAt: Date.now() };
    });
    writeFileSync(path.join(imgDir(r, ticket), "pending-jobs.json"), JSON.stringify(jobs), "utf8");
    return handle(...args);
  };
}

describe("agent lateImages", () => {
  it("MCP 在 submit 与 collect 之间退出，意图和回执已落盘，lateImages 收取且不重提", async () => {
    const r = await makeRig(), ticket = "mcp-killed";
    const dir = imgDir(r, ticket);
    let submits = 0;
    const marker = () => JSON.parse(readFileSync(path.join(dir, "pending-jobs.json"), "utf8"));
    const backend = {
      name: "stub", selfCheck: async () => ({}), close: async () => {}, generate: async () => [], reconcile: r.image.reconcile.bind(r.image),
      submit: async () => { submits++; expect(marker()[0]).toMatchObject({ status: "intent", options: { prompt: "猫" } }); return "accepted"; },
      collect: async () => { expect(marker()[0]).toMatchObject({ status: "submitted", prompt_id: "accepted" }); throw new Error("process interrupted"); },
    };
    const { server, dispose } = createImageGenServer({ dataDir: r.dir, ticketDir: dir, createBackend: () => backend });
    const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "test", version: "0" });
    await server.connect(a); await client.connect(b);
    r.backend.handle = async () => {
      await client.callTool({ name: "generate_image", arguments: { prompt: "猫" } });
      await client.close(); await dispose();
      return { text: "正文保留" };
    };
    await r.dispatcher.dispatch(inbound("画图"), ticket);
    expect(submits).toBe(1); expect(r.image.calls).toEqual([]); expect(r.image.collects).toEqual(["accepted"]);
    expect(r.bridge.replies[0]).toMatchObject({ text: "正文保留", images: [expect.any(String)] });
  });

  it("count=4 下载一张后崩溃，重启仅下载剩余三张并完成整个批次", async () => {
    const r = await makeRig(), ticket = "partial-batch";
    const dir = path.join(imgDir(r, ticket), "call-1");
    const downloads: string[] = []; let interrupted = false; let resumed = false;
    const fake = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/history/batch") return Response.json({ batch: { status: { completed: true }, outputs: {
        "9": { images: ["one.png", "two.png", "three.png", "four.png"].map(filename => ({ filename })) },
      } } });
      expect(url.pathname).toBe("/view");
      const filename = url.searchParams.get("filename")!;
      if (!resumed && filename === "two.png") { interrupted = true; return untilAbort(init?.signal ?? undefined); }
      downloads.push(filename); return new Response(PNG);
    });
    r.backend.handle = async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(imgDir(r, ticket), "pending-jobs.json"), JSON.stringify([{
        prompt_id: "batch", filenamePrefix: "cs-batch", backend: "http", options: { prompt: "猫", count: 4 }, callDir: dir, submittedAt: Date.now(), status: "submitted",
      }]), "utf8");
      return { text: "四张图" };
    };
    const backend = new HttpImageBackend({ baseUrl: "http://comfy.test", timeoutMs: 10000, pollMs: 1 });
    r.image.collect = backend.collect.bind(backend);
    try {
      const pending = r.dispatcher.dispatch(inbound("画图"), ticket);
      await vi.waitFor(() => expect(interrupted).toBe(true));
      expect(JSON.parse(readFileSync(path.join(dir, "image-files.json"), "utf8")).map((f: { downloaded: boolean }) => f.downloaded)).toEqual([true, false, false, false]);
      expect(readdirSync(dir).filter(f => f.endsWith(".png"))).toEqual(["one.png"]);
      await r.harness.close(ctx); await pending; resumed = true;
      await r.reopen(); await r.dispatcher.recover(); await r.dispatcher.idle();
      expect(downloads).toEqual(["one.png", "two.png", "three.png", "four.png"]);
      expect(r.image.calls).toEqual([]); expect(r.bridge.replies[0]?.images).toHaveLength(4);
      expect(JSON.parse(readFileSync(path.join(dir, "image-files.json"), "utf8")).every((f: { downloaded: boolean }) => f.downloaded)).toBe(true);
      expect(readdirSync(dir).some(f => f.endsWith(".tmp"))).toBe(false);
    } finally { fake.mockRestore(); }
  });

  it.each(["invalid-json", "oversize", "too-many", "long-field", "directory"])("坏 marker 隔离并保留正文和附件失败说明：%s", async mode => {
    const r = await makeRig(), ticket = "bad-marker";
    const dir = imgDir(r, ticket), marker = path.join(dir, "pending-jobs.json");
    r.backend.handle = async () => {
      mkdirSync(dir, { recursive: true });
      const job = { prompt_id: "id", filenamePrefix: "prefix", backend: "stub", options: { prompt: "猫" }, callDir: path.join(dir, "call-1"), submittedAt: Date.now() };
      if (mode === "directory") mkdirSync(marker);
      else writeFileSync(marker, mode === "invalid-json" ? "{" : mode === "oversize" ? " ".repeat(65537) : mode === "too-many"
        ? JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ ...job, filenamePrefix: "p" + i })))
        : JSON.stringify([{ ...job, prompt_id: "x".repeat(257) }]), "utf8");
      return { text: "成功的原始正文" };
    };
    await r.dispatcher.dispatch(inbound("画图"), ticket);
    expect(r.bridge.replies[0]?.text).toBe("成功的原始正文\n附件收取失败，部分图片未能发送。");
    expect(readdirSync(dir).filter(f => f.startsWith("pending-jobs.json.bad-"))).toHaveLength(1);
    expect(existsSync(marker)).toBe(false); expect(r.image.collects).toEqual([]); expect(r.image.calls).toEqual([]);
  });

  it("慢 Comfy 经 MCP 交接后由 lateImages 收取，回复带上回合后下载的图片", async () => {
    const r = await makeRig(), ticket = "mcp-late";
    let ready = false, posts = 0, downloads = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://comfy.test");
      const json = (v: unknown) => new Response(JSON.stringify(v));
      if (url.pathname === "/prompt") { expect(init?.method).toBe("POST"); posts++; return json({ prompt_id: "slow" }); }
      if (url.pathname === "/history/slow") return json(ready ? { slow: { status: { completed: true }, outputs: {
        "9": { images: [{ filename: "late.png" }] } } } } : {});
      if (url.pathname === "/queue") return json({ queue_running: [[0, "slow"]] });
      expect(url.pathname).toBe("/view"); downloads++; return new Response(PNG);
    });
    const backend = new HttpImageBackend({ baseUrl: "http://comfy.test", timeoutMs: 1000, pollMs: 1 });
    const { server, dispose } = createImageGenServer({ dataDir: r.dir, ticketDir: imgDir(r, ticket), waitMs: 50, createBackend: () => backend });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await server.connect(a); await client.connect(b);
    r.backend.handle = async () => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "慢图", aspect: "16:9" } });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.content)).toContain("仍在生成");
      expect(downloads).toBe(0);
      ready = true;
      return { text: "图片稍后发送" };
    };
    r.image.collect = backend.collect.bind(backend);
    try {
      await r.dispatcher.dispatch(inbound("画图"), ticket);
      expect(posts).toBe(1); expect(downloads).toBe(1);
      expect(r.bridge.replies[0]).toMatchObject({ text: "图片稍后发送", images: [realpathSync(path.join(imgDir(r, ticket), "call-1", "late.png"))] });
      expect(existsSync(path.join(imgDir(r, ticket), "pending-jobs.json"))).toBe(false);
    } finally { await client.close(); await dispose(); fetch.mockRestore(); }
  });

  it("延期保留 options 和每任务进度，两个 call 目录图片都加入回复", async () => {
    const r = await makeRig(), ticket = "late-extensions";
    leavePendingImages(r, ticket, 2); r.image.collectTimeouts = 1;
    const collect = r.image.collect.bind(r.image);
    r.image.collect = async (id, dir, signal, options?: ImageOptions) => {
      expect(options).toMatchObject({ size: "2mp", aspect: "16:9" });
      const entry = (await pendingIndex(r))[ticket]!;
      const doc = await r.harness.snapshot(TicketDoc, entry.conversationId as ConversationId, ctx);
      expect((await r.harness.getTask(entry.taskId as never, ctx))?.state).toMatchObject({ checkpoint: { phase: "lateImages" } });
      expect(doc?.lateImageJobs?.find(j => j.prompt_id === id)?.deadline).toBeGreaterThan(Date.now());
      if (id === "late-2") expect(doc?.lateImageJobs?.[0]).toMatchObject({ extensions: 1, result: { ok: true } });
      return collect(id, dir, signal);
    };
    await r.dispatcher.dispatch(inbound("画图"), ticket);
    expect(r.image.collects).toEqual(["late-1", "late-1", "late-2"]);
    expect(r.image.calls).toEqual([]);
    expect(r.bridge.replies[0]?.images).toHaveLength(2);
  });

  it("lateImages 完成后回复前崩溃，重启不再 collect 或下载", async () => {
    const r = await makeRig(), ticket = "late-restart";
    leavePendingImages(r, ticket);
    const reply = r.bridge.reply.bind(r.bridge);
    let waiting = false;
    r.bridge.reply = async (_id, _text, _images, opts?: { signal?: AbortSignal }) => {
      waiting = true; return untilAbort(opts?.signal);
    };
    const run = r.dispatcher.dispatch(inbound("画图"), ticket);
    await vi.waitFor(() => expect(waiting).toBe(true));
    expect(existsSync(path.join(imgDir(r, ticket), "pending-jobs.json"))).toBe(false);
    const entry = (await pendingIndex(r))[ticket]!;
    expect((await r.harness.snapshot(TicketDoc, entry.conversationId as ConversationId, ctx))?.lateImageJobs?.[0]?.result?.ok).toBe(true);
    await r.harness.close(ctx); await run;
    r.bridge.reply = reply;
    await r.reopen(); await r.dispatcher.recover(); await r.dispatcher.idle();
    expect(r.image.collects).toEqual(["late-1"]);
    expect(r.backend.requests).toHaveLength(1);
    expect(r.bridge.replies[0]?.images).toHaveLength(1);
  });

  it.each([false, true])("unknown 任务先对账、不重提，找到输出=%s", async recovered => {
    const r = await makeRig(), ticket = "late-unknown";
    leavePendingImages(r, ticket); r.image.unknown.add("late-1");
    if (recovered) r.image.recoveredAt = "history";
    await r.dispatcher.dispatch(inbound("画图"), ticket);
    expect(r.image.calls).toEqual([]);
    expect(r.image.reconciliations).toEqual([expect.objectContaining({ filenamePrefix: `cs-${ticket}-1`, imageOptions: expect.objectContaining({ size: "2mp" }) })]);
    expect(r.bridge.replies[0]?.images).toHaveLength(recovered ? 1 : 0);
    expect(r.bridge.replies[0]?.text.includes("有一张图生成超时未能发送")).toBe(!recovered);
    expect(existsSync(path.join(imgDir(r, ticket), "pending-jobs.json"))).toBe(!recovered);
  });

  it.each([false, true])("lateImages 中断后继续原任务，下载已完成=%s，参考图留到收取结束", async written => {
    const r = await makeRig(), ticket = "late-interrupted";
    leavePendingImages(r, ticket);
    const handle = r.backend.handle.bind(r.backend);
    const manifest = path.join(imgDir(r, ticket), "call-1", "remote-uploads.json");
    r.backend.handle = async (...args) => {
      const result = await handle(...args);
      writeFileSync(manifest, JSON.stringify([{ name: "ref.png", subfolder: ticket + "-call-1" }]), "utf8");
      return result;
    };
    r.image.hangAfterWrite = written; r.image.hangCollect = !written;
    const run = r.dispatcher.dispatch(inbound("画图"), ticket);
    await vi.waitFor(() => {
      expect(r.image.collects).toHaveLength(1);
      if (written) expect(existsSync(path.join(imgDir(r, ticket), "call-1", "out_0.png"))).toBe(true);
    });
    expect(r.image.cleared).toEqual([]); expect(existsSync(manifest)).toBe(true);
    await r.harness.close(ctx); await run;
    r.image.hangAfterWrite = false;
    await r.reopen(); await r.dispatcher.recover(); await r.dispatcher.idle();
    expect(r.image.collects).toHaveLength(2); // 没有完整文件清单时不能因一张图片存在就跳过收取
    expect(r.image.calls).toEqual([]);
    expect(r.bridge.replies[0]?.images).toHaveLength(1);
    expect(r.image.cleared).toEqual([[{ name: "ref.png", subfolder: ticket + "-call-1" }]]);
    expect(existsSync(manifest)).toBe(false);
  });

  it("延期耗尽只追加一次失败说明，其他任务的图片仍发送", async () => {
    const r = await makeRig(), ticket = "late-exhausted";
    leavePendingImages(r, ticket, 2); r.image.collectTimeouts = 3;
    await r.dispatcher.dispatch(inbound("画图"), ticket);
    expect(r.image.collects).toEqual(["late-1", "late-1", "late-1", "late-2"]);
    expect(r.bridge.replies[0]?.images).toHaveLength(1);
    expect(r.bridge.replies[0]?.text.match(/有一张图生成超时未能发送/g)).toHaveLength(1);
  });
});

describe("rule router → image path", () => {
  it('上传前 TicketDoc 清单已落盘，终态票据重启仍重做覆盖', async () => {
    const r = await makeRig(), ticket = 'cleanup-restart';
    const incoming = path.join(r.dir, 'incoming', ticket); mkdirSync(incoming, { recursive: true });
    const ref = path.join(incoming, '1.png'); writeFileSync(ref, PNG);
    const message = inbound('奶龙: 改色'); message.images = [ref];
    const submit = r.image.submit.bind(r.image);
    r.image.submit = async (...args) => {
      const entry = (await pendingIndex(r))[ticket]!;
      expect((await r.harness.snapshot(TicketDoc, entry.conversationId as ConversationId, ctx))?.remoteUploads)
        .toEqual([{ name: '1.png', subfolder: ticket }]);
      return submit(...args);
    };
    r.image.hangCollect = true;
    const run = r.dispatcher.dispatch(message, ticket);
    await vi.waitFor(() => expect(r.image.collects).toHaveLength(1));
    await r.harness.close(ctx); await run;
    r.bridge.status.set(ticket, 'sent'); await r.reopen();
    await r.dispatcher.recover(); await r.dispatcher.idle();
    expect(r.image.cleared).toEqual([[{ name: '1.png', subfolder: ticket }]]);
    expect(r.image.calls).toHaveLength(1); expect(await pendingIndex(r)).toEqual({});
  });
  it('恢复等待 A 附件时 B 可派发，A 同 scope 后续仍保序', async () => {
    const r = await makeRig(), gate = deferred<ReplyTicketRecord | null>();
    const make = (id: string, user: string, seq: number): ReplyTicketRecord => ({ ticket_id: id, seq,
      self_id: '1', user_id: user, group_id: null, message_type: 'private', source_message_id: id,
      source_nickname: 'tester', source_text: id, source_route_text: id, created_at: new Date().toISOString(), status: 'pending',
      ...(id === 'A1' ? { attachments: [{ status: 'pending', file: 'one' }] } : {}) });
    r.bridge.pending = [make('A1','10',1),make('A2','10',2),make('B1','20',3)];
    r.bridge.prepareIncoming = async ticket => ticket === 'A1' ? gate.promise : r.bridge.pending.find(x => x.ticket_id === ticket)!;
    await r.dispatcher.recover();
    await vi.waitFor(() => expect(r.bridge.replies.map(x => x.ticket)).toEqual(['B1']));
    gate.resolve({ ...r.bridge.pending[0]!, attachments: [{ status: 'skipped', file: 'one' }] });
    await r.dispatcher.idle(); expect(r.bridge.replies.map(x => x.ticket)).toEqual(['B1','A1','A2']);
  });
  it('假 Comfy 慢任务第二次 collect 成功，不重新 submit', async () => {
    const r = await makeRig(); r.image.collectTimeouts = 1;
    await r.dispatcher.dispatch(inbound('奶龙: 慢图'), 'late-image');
    expect(r.image.calls).toHaveLength(1); expect(r.image.collects).toEqual(['pid-1','pid-1']);
    expect(r.bridge.replies[0]?.text).toBe(IMAGE_SUCCESS_REPLY);
  });
  it('假 Comfy 延期两次后仍运行，才返回超时失败', async () => {
    const r = await makeRig(); r.image.collectTimeouts = 9;
    await r.dispatcher.dispatch(inbound('奶龙: 超慢图'), 'too-late-image');
    expect(r.image.calls).toHaveLength(1); expect(r.image.collects).toHaveLength(3);
    expect(r.bridge.replies[0]?.text).toBe(IMAGE_FAILURE_REPLIES.timeout);
  });
  it('延期检查点保存 running/deadline，重启后继续原 prompt_id', async () => {
    const r = await makeRig(); r.image.collectTimeouts = 1;
    const original = r.image.collect.bind(r.image);
    let waiting = false;
    r.image.collect = async (...args) => {
      if (!r.image.collectTimeouts) { waiting = true; await untilAbort(args[2]); }
      return original(...args);
    };
    const run = r.dispatcher.dispatch(inbound('奶龙: 重启慢图'), 'late-restart');
    await vi.waitFor(() => expect(waiting).toBe(true));
    const entry = (await pendingIndex(r))['late-restart']!;
    const doc = await r.harness.snapshot(TicketDoc, entry.conversationId as ConversationId, ctx);
    expect(doc?.imageJob).toMatchObject({ status: 'running', extensions: 1, prompt_id: 'pid-1' });
    expect(doc?.imageJob?.deadline).toBeGreaterThan(Date.now());
    await r.harness.close(ctx); await run;
    r.image.collect = original; await r.reopen(); await r.dispatcher.recover(); await r.dispatcher.idle();
    expect(r.image.calls).toHaveLength(1); expect(r.bridge.replies[0]?.text).toBe(IMAGE_SUCCESS_REPLY);
  });
  it('v2 参数随任务传入，孤儿票据恢复后仍带本票据参考图', async () => {
    const r = await makeRig(); const ticket = 'v2-recovered';
    const incoming = path.join(r.dir, 'incoming', ticket);
    mkdirSync(incoming, { recursive: true }); const ref = path.join(incoming, '1.png'); writeFileSync(ref, PNG);
    r.bridge.pending = [{ ticket_id: ticket, seq: 1, self_id: '1', user_id: OWNER, group_id: null, message_type: 'private',
      source_message_id: '900', source_nickname: 'tester', source_text: '奶龙: 横 2mp x3 改红色[image]',
      source_route_text: '奶龙: 横 2mp x3 改红色', source_images: [ref], created_at: '2026-10-17T00:00:00.000Z', status: 'pending' }];
    await r.dispatcher.recover(); await r.dispatcher.idle();
    expect(r.image.options).toEqual([{ prompt: '改红色', aspect: '16:9', size: '2mp', count: 3, reference_images: [realpathSync(ref)] }]);
    expect(r.image.prefixes).toEqual(['cs-v2-recovered-1']);
  });

  it("奶龙: prefix → one generation with the raw prompt, fixed success reply with the image, route stored", async () => {
    const r = await makeRig();
    await r.dispatcher.dispatch(inbound("  奶龙：一只戴墨镜的柴犬，赛博朋克", { id: "300" }), "t-img");
    expect(r.image.calls).toEqual(["一只戴墨镜的柴犬，赛博朋克"]);
    expect(r.backend.requests).toEqual([]);
    expect(r.bridge.replies).toEqual([
      { ticket: "t-img", text: IMAGE_SUCCESS_REPLY, images: [realpathSync(path.join(imgDir(r, "t-img"), "out_1.png"))] },
    ]);
    expect(await pendingIndex(r)).toEqual({});
    // completeReply(action=generate_image, detail=prompt)
    expect(bot(r)[0]).toMatchObject({
      ticket: "t-img", action: "generate_image", detail: "一只戴墨镜的柴犬，赛博朋克", image_count: 1, status: "已回复", text: IMAGE_SUCCESS_REPLY,
    });
  });

  it("group message routes on the bridge's route_text (leading at segment skipped); TicketDoc keeps text, records route and prefix", async () => {
    const r = await makeRig();
    let conversation = 0;
    await r.dispatcher.dispatch(inbound("[at] 奶龙:画一只猫", { group: "200000001", user: "42", routeText: " 奶龙:画一只猫" }), "t-grp");
    const convs = await r.harness.commit((tx) => tx.scanConversations({}, 10), ctx);
    for (const c of convs.items) {
      const doc = await r.harness.snapshot(TicketDoc, c.id, ctx);
      if (doc?.ticket === "t-grp") conversation = c.id;
    }
    const doc = await r.harness.snapshot(TicketDoc, conversation as never, ctx);
    expect(doc).toMatchObject({ text: "[at] 奶龙:画一只猫", route: "image", prefix: "奶龙:", prompt: "画一只猫" });
    expect(r.image.calls).toEqual(["画一只猫"]);
  });

  it("a literal '[at]' typed by the user is not skipped: routes to the agent (R10)", async () => {
    const r = await makeRig();
    await r.dispatcher.dispatch(inbound("[at] 奶龙:猫", { group: "200000001", user: "42", routeText: "[at] 奶龙:猫" }), "t-literal");
    expect(r.image.calls).toEqual([]);
    expect(r.backend.requests.map((q) => q.text)).toEqual(["[at] 奶龙:猫"]);
  });

  it("empty prompt → fixed usage reply, no generation", async () => {
    const r = await makeRig();
    await r.dispatcher.dispatch(inbound("奶龙：   "), "t-usage");
    expect(r.image.calls).toEqual([]);
    expect(r.bridge.replies).toEqual([{ ticket: "t-usage", text: IMAGE_USAGE_REPLY, images: [] }]);
  });

  it("generation failure → category template, row marked 失败", async () => {
    const r = await makeRig();
    r.image.fail = new Error("fetch failed: ECONNREFUSED 127.0.0.1:8188");
    await r.dispatcher.dispatch(inbound("奶龙:x"), "t-down");
    r.image.fail = new Error("生图超时");
    await r.dispatcher.dispatch(inbound("奶龙:y", { id: "101" }), "t-slow");
    expect(r.bridge.replies.map((x) => x.text)).toEqual([IMAGE_FAILURE_REPLIES.unavailable, IMAGE_FAILURE_REPLIES.timeout]);
    expect(bot(r).find((b) => b.ticket === "t-down")).toMatchObject({ action: "generate_image", status: "失败" });
  });

  it("reply fails once before sending → retried inside the task: exactly one generation, one send", async () => {
    const r = await makeRig();
    r.bridge.failBeforeSend = 1;
    await r.dispatcher.dispatch(inbound("奶龙:一朵花"), "t-retry");
    expect(r.image.calls).toHaveLength(1);
    expect(r.bridge.calls).toBe(2);
    expect(r.bridge.replies).toHaveLength(1);
    expect(r.bridge.replies[0]!.text).toBe(IMAGE_SUCCESS_REPLY);
    expect(await pendingIndex(r)).toEqual({});
  });

  it("crash between generate and reply → reopen resumes at reply: one generation, one send", async () => {
    const r = await makeRig();
    const hang = deferred();
    r.bridge.hang = hang;
    const first = r.dispatcher.dispatch(inbound("奶龙:一只鲸鱼"), "t-crash");
    while (r.bridge.calls === 0) await new Promise((res) => setTimeout(res, 5));
    // 进程关闭：先关 harness，再让挂起的发送以错误返回（未发送，票据仍 pending）
    const closing = r.harness.close(ctx);
    hang.reject(new Error("process exiting"));
    await closing;
    await first;
    expect(r.bridge.replies).toEqual([]);

    await r.reopen();
    expect(Object.keys(await pendingIndex(r))).toEqual(["t-crash"]);
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.image.calls).toEqual(["一只鲸鱼"]);
    expect(r.bridge.replies).toHaveLength(1);
    expect(r.bridge.replies[0]).toMatchObject({ ticket: "t-crash", text: IMAGE_SUCCESS_REPLY });
    expect(await pendingIndex(r)).toEqual({});
  });

  it("crash after the image was written but before the checkpoint → reopen reuses it, no second generation", async () => {
    const r = await makeRig();
    r.image.hangAfterWrite = true;
    const first = r.dispatcher.dispatch(inbound("奶龙:雪山"), "t-mid");
    while (r.image.calls.length === 0) await new Promise((res) => setTimeout(res, 5));
    await r.harness.close(ctx);
    await first;
    r.image.hangAfterWrite = false;
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.image.calls).toHaveLength(1);
    expect(r.bridge.replies).toHaveLength(1);
    expect(r.bridge.replies[0]!.images).toEqual([realpathSync(path.join(imgDir(r, "t-mid"), "out_1.png"))]);
  });

  it("task fails and the fallback fails before sending → retried at the head of the scope; generation not repeated (R4)", async () => {
    const r = await makeRig();
    r.bridge.failBeforeSend = MAX_REPLY_ATTEMPTS + 1; // 第 1 次尝试：任务内 3 次 + 兜底 1 次，全部在发送前失败
    await r.dispatcher.dispatch(inbound("奶龙:森林"), "t-rerun");
    expect(r.bridge.calls).toBe(MAX_REPLY_ATTEMPTS + 2);
    expect(r.image.calls).toEqual(["森林"]);
    expect(r.bridge.replies).toEqual([{ ticket: "t-rerun", text: IMAGE_SUCCESS_REPLY, images: [expect.stringMatching(/out_1\.png$/)] }]);
    expect(await pendingIndex(r)).toEqual({});
  });

  it("crash between submit and collect → recovery collects the persisted prompt_id, no second submit (R2)", async () => {
    const r = await makeRig();
    r.image.hangCollect = true;
    const first = r.dispatcher.dispatch(inbound("奶龙:灯塔"), "t-sub");
    while (r.image.collects.length === 0) await new Promise((res) => setTimeout(res, 5));
    await r.harness.close(ctx);
    await first.catch(() => undefined);
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.image.calls).toEqual(["灯塔"]);
    expect(r.image.collects).toEqual(["pid-1", "pid-1"]);
    expect(r.bridge.replies).toHaveLength(1);
    expect(r.bridge.replies[0]!.text).toBe(IMAGE_SUCCESS_REPLY);
  });

  it("unknown job with no probed outputs resubmits once; repeated absence reaches the cap (F2)", async () => {
    const r = await makeRig();
    r.image.unknown.add("pid-1");
    await r.dispatcher.dispatch(inbound("奶龙:a", { id: "1" }), "t-unk1");
    expect(r.image.calls).toEqual(["a", "a"]);
    expect(r.bridge.replies[0]!.text).toBe(IMAGE_SUCCESS_REPLY);

    r.image.unknown.add("pid-3").add("pid-4");
    await r.dispatcher.dispatch(inbound("奶龙:b", { id: "2" }), "t-unk2");
    expect(r.image.calls).toEqual(["a", "a", "b", "b"]);
    expect(r.bridge.replies[1]!.text).toBe(IMAGE_FAILURE_REPLIES.failed);
    expect(r.image.reconciliations.map(x => x.filenamePrefix)).toEqual(["cs-t-unk1-1", "cs-t-unk2-1", "cs-t-unk2-2"]);
  });

  it("history pruned but output files exist: unknown job probes outputs without resubmitting (F2)", async () => {
    const r = await makeRig();
    r.image.unknown.add("pid-1");
    r.image.recoveredAt = "probe";
    await r.dispatcher.dispatch(inbound("奶龙:保留图片"), "pruned");
    expect(r.image.calls).toHaveLength(1);
    expect(r.image.reconciliations).toEqual([expect.objectContaining({ attempt: 1, filenamePrefix: "cs-pruned-1", count: 1 })]);
    expect(r.bridge.replies[0]).toMatchObject({ text: IMAGE_SUCCESS_REPLY, images: [expect.stringMatching(/cs-pruned-1_00001_\.png$/)] });
  });

  it.each(["history", "queue", "probe"] as const)("crash in submit response window adopts %s evidence without resubmitting (F1)", async recoveredAt => {
    const r = await makeRig();
    const ticket = "abcdef123456" + "0".repeat(52);
    r.image.hangSubmit = true;
    const first = r.dispatcher.dispatch(inbound("奶龙:提交后崩溃"), ticket);
    await vi.waitFor(() => expect(r.image.calls).toHaveLength(1));
    const id = (await pendingIndex(r))[ticket]!.conversationId as never;
    expect(await r.harness.snapshot(TicketDoc, id, ctx)).toMatchObject({ submitIntent: { attempt: 1, filenamePrefix: "cs-abcdef123456-1" } });
    expect((await r.harness.snapshot(TicketDoc, id, ctx))?.imageJob).toBeUndefined();
    await r.harness.close(ctx);
    await first;
    r.image.hangSubmit = false;
    r.image.recoveredAt = recoveredAt;
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    const doc = await r.harness.snapshot(TicketDoc, id, ctx);
    expect(doc?.imageReconciliation?.at(-1)).toMatchObject({ attempt: 1, step: recoveredAt, status: "matched" });
    if (recoveredAt !== "probe") expect(doc?.imageJob).toMatchObject({ prompt_id: "pid-1", submits: 1 });
    expect(r.image.calls).toHaveLength(1);
    expect(r.image.prefixes).toEqual(["cs-abcdef123456-1"]);
    expect(r.bridge.replies[0]!.text).toBe(IMAGE_SUCCESS_REPLY);
  });

  it("submit intent with no history, queue or output retries with the next prefix and persists each step (F1)", async () => {
    const r = await makeRig();
    r.image.hangSubmit = true;
    const first = r.dispatcher.dispatch(inbound("奶龙:未执行"), "missing");
    await vi.waitFor(() => expect(r.image.calls).toHaveLength(1));
    const id = (await pendingIndex(r))["missing"]!.conversationId as never;
    await r.harness.close(ctx);
    await first;
    r.image.hangSubmit = false;
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.image.prefixes).toEqual([imageFilenamePrefix("missing", 1), imageFilenamePrefix("missing", 2)]);
    const doc = await r.harness.snapshot(TicketDoc, id, ctx);
    expect(doc?.submitIntent?.attempt).toBe(2);
    expect(doc?.imageReconciliation?.map(s => `${s.step}:${s.status}`)).toEqual(["history:started", "history:empty", "queue:started", "queue:empty", "probe:started", "probe:empty"]);
  });

  it("reconciliation unavailable is not evidence to resubmit (F1/F2)", async () => {
    const r = await makeRig();
    r.image.unknown.add("pid-1");
    r.image.reconcileFail = new Error("fetch failed");
    await r.dispatcher.dispatch(inbound("奶龙:断网"), "offline");
    expect(r.image.calls).toHaveLength(1);
    expect(r.bridge.replies[0]!.text).toBe(IMAGE_FAILURE_REPLIES.unavailable);
  });

  it("two crashes before prompt_id persistence exhaust the submit cap without a third submit (F1)", async () => {
    const r = await makeRig();
    r.image.hangSubmit = true;
    const first = r.dispatcher.dispatch(inbound("奶龙:两次中断"), "twice");
    await vi.waitFor(() => expect(r.image.calls).toHaveLength(1));
    await r.harness.close(ctx);
    await first;
    await r.reopen();
    await r.dispatcher.recover();
    await vi.waitFor(() => expect(r.image.calls).toHaveLength(2));
    await r.harness.close(ctx);
    await r.dispatcher.idle();
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.image.prefixes).toEqual(["cs-twice-1", "cs-twice-2"]);
    expect(r.image.reconciliations.map(s => s.filenamePrefix)).toEqual(["cs-twice-1", "cs-twice-2"]);
    expect(r.bridge.replies[0]!.text).toBe(IMAGE_FAILURE_REPLIES.failed);
  });

  it("no validated image under the ticket dir = generation failure, even if the backend returned paths (R8)", async () => {
    const r = await makeRig();
    r.image.writeNothing = true;
    await r.dispatcher.dispatch(inbound("奶龙:空"), "t-noimg");
    expect(r.bridge.replies).toEqual([{ ticket: "t-noimg", text: IMAGE_FAILURE_REPLIES.failed, images: [] }]);
  });

  it("uncertain send is never retried: task fails, no fallback (ticket already terminal)", async () => {
    const r = await makeRig();
    const orig = r.bridge.reply.bind(r.bridge);
    r.bridge.reply = async (ticket: string, text: string, images?: string[]) => {
      r.bridge.calls++;
      r.bridge.status.set(ticket, "uncertain");
      throw new Error("QQ 回复结果不确定");
    };
    await r.dispatcher.dispatch(inbound("奶龙:海"), "t-unc");
    expect(r.bridge.calls).toBe(1);
    expect(await pendingIndex(r)).toEqual({});
    r.bridge.reply = orig;
  });
});

describe("agent path", () => {
  it("non-prefixed message → agent backend with scope/access/threadKey; reply is sent as-is", async () => {
    const r = await makeRig();
    await r.dispatcher.dispatch(inbound("今晚有比赛吗", { group: "200000001", user: "42" }), "t-agent");
    expect(r.image.calls).toEqual([]);
    expect(r.backend.requests[0]).toMatchObject({
      ticket: "t-agent", scope: "group:200000001", access: "group:200000001", threadKey: "group:200000001", text: "今晚有比赛吗",
    });
    expect(r.bridge.replies).toEqual([{ ticket: "t-agent", text: "## 答复\n**今晚有比赛吗** ok @all", images: [] }]);
    expect(bot(r)[0]).toMatchObject({ action: "ask_codex", detail: "high", status: "已回复" });
  });

  it("owner private → access all / owner thread", async () => {
    const r = await makeRig();
    await r.dispatcher.dispatch(inbound("hi"), "t-owner");
    expect(r.backend.requests[0]).toMatchObject({ access: "all", threadKey: "owner", scope: `private:${OWNER}` });
  });

  it("codex 原始答复原样发送，意图模型不会被调用", async () => {
    const r = await makeRig();
    r.faux.setResponses([fauxAssistantMessage(fauxText("不应发送的改写"))]);
    await r.dispatcher.dispatch(inbound("问个问题"), "sanitize-only");
    expect(r.bridge.replies[0]!.text).toBe("## 答复\n**问个问题** ok @all");
    expect(r.faux.state.callCount).toBe(0);
  });

  it.each([false, true])("旧 TicketDoc 的 codexReplyMode 在重开后可读取、恢复并原样发送；已有后端结果=%s", async completed => {
    const r = await makeRig();
    const legacySettings = JSON.parse('{"backend":"codex","codexReasoningEffort":"low","codexReplyMode":"relay"}');
    const conversation = await r.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      Object.assign(await tx.doc(TicketDoc, id), { ticket: "legacy", text: "旧消息", route: "agent",
        source: { type: "private", user_id: OWNER, group_id: null, nickname: "tester" }, settings: legacySettings,
        ...(completed ? { agentResult: { ok: true, backend: "codex", text: "## 旧回答 @all", images: [] } } : {}) });
      (await tx.doc(DispatchDoc)).pending.legacy = { conversationId: id, scope: "private:" + OWNER, ticketSeq: 1, attempts: 0 };
    } }, ctx);
    await r.harness.close(ctx);
    await r.reopen();
    expect((await r.harness.snapshot(TicketDoc, conversation.id, ctx))?.settings).toEqual(legacySettings);
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.bridge.replies[0]!.text).toBe(completed ? "## 旧回答 @all" : "## 答复\n**旧消息** ok @all");
    expect(r.backend.requests).toHaveLength(completed ? 0 : 1);
    expect(r.faux.state.callCount).toBe(0);
    expect(await pendingIndex(r)).toEqual({});
  });

  it("override selects the pi stub → failure template, row marked 失败", async () => {
    const r = await makeRig({ overrides: { "group:7": "pi" } });
    await r.dispatcher.dispatch(inbound("hello", { group: "7", user: "42" }), "t-pi");
    await r.dispatcher.dispatch(inbound("hello", { group: "8", user: "42", id: "101" }), "t-codex");
    expect(r.bridge.replies.find((x) => x.ticket === "t-pi")!.text).toBe(AGENT_FAILURE_REPLIES.failed);
    expect(r.bridge.replies.find((x) => x.ticket === "t-codex")!.text).toContain("ok");
    expect(r.backend.requests.map((q) => q.ticket)).toEqual(["t-codex"]);
    expect(bot(r).find((b) => b.ticket === "t-pi")).toMatchObject({ status: "失败" });
  });

  it("codex backend end to end via fake codex: QQ_ACCESS, IMAGE_TICKET_DIR, configured effort; ≤4 collected images attached", async () => {
    const dir = tmp("cs-dispatch-codex-");
    const logFile = path.join(dir, "codex-calls.jsonl");
    const runner = new CodexRunner({
      command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
      codexHome: path.join(dir, "codex"),
      workspaceDir: path.join(dir, "ws"),
      threadsFile: path.join(dir, "codex-threads.json"),
      sandbox: "workspace-write",
      timeoutMs: 10_000,
      env: { FAKE_CODEX_LOG: logFile, FAKE_CODEX_IMAGES: "5", FAKE_CODEX_TEXT: "```\n画好了\n```" },
    });
    const codex = new CodexBackend({ runner, imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets"), reasoningEffort: "medium" });
    const r = await makeRig({ codex, codexEffort: "medium" }, { dir, bridge: new BridgeStub(), image: new ImageStub(), backend: new BackendStub(), store: new ContextStore(dir) });
    await r.dispatcher.dispatch(inbound("画一张图并配一句话", { group: "200000001", user: "42" }), "t-codex-e2e");
    const start = readFileSync(logFile, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)).find((c) => c.phase === "start");
    expect(start.argv).toEqual(expect.arrayContaining(["-c", 'mcp_servers.qq_context.env.QQ_ACCESS="group:200000001"']));
    expect(start.argv).toEqual(expect.arrayContaining(["-c", `mcp_servers.image_gen.env.IMAGE_TICKET_DIR="${imgDir(r, "t-codex-e2e")}"`]));
    expect(start.argv).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="medium"']));
    expect(start.stdin.split("\n")[0]).toMatch(/^\[来源\] 群 200000001 · tester\(42\) · /);
    const reply = r.bridge.replies[0]!;
    expect(reply.text).toBe("```\n画好了\n```");
    expect(reply.images).toHaveLength(4);
    expect(reply.images!.every((f) => f.endsWith(".png"))).toBe(true);
  });

  /** 真实 CodexBackend + 假 codex；env 对象在每次启动 codex 时读取，测试中可修改。 */
  function codexRig(dir: string, env: Record<string, string>) {
    const runner = new CodexRunner({
      command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
      codexHome: path.join(dir, "codex"),
      workspaceDir: path.join(dir, "ws"),
      threadsFile: path.join(dir, "codex-threads.json"),
      sandbox: "workspace-write",
      timeoutMs: 120_000,
      env,
    });
    return new CodexBackend({ runner, imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets"), reasoningEffort: "medium" });
  }
  const codexStarts = (logFile: string) =>
    readFileSync(logFile, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((c) => c.phase === "start").length;

  it("crash after codex wrote its output but before the agentResult commit → recovery reuses the file; codex runs exactly once (R1)", async () => {
    const dir = tmp("cs-dispatch-r1-");
    const logFile = path.join(dir, "codex-calls.jsonl");
    const env: Record<string, string> = { FAKE_CODEX_LOG: logFile, FAKE_CODEX_TEXT: "已完成的回答", FAKE_CODEX_SLEEP_AFTER_OUT_MS: "60000" };
    const codex = codexRig(dir, env);
    const r = await makeRig({ codex }, { dir, bridge: new BridgeStub(), image: new ImageStub(), backend: new BackendStub(), store: new ContextStore(dir) });
    const outFile = path.join(dir, "tickets", "t-r1", "codex-last.txt");
    const first = r.dispatcher.dispatch(inbound("问一下"), "t-r1");
    while (!existsSync(outFile)) await new Promise((res) => setTimeout(res, 10));
    await r.harness.close(ctx); // codex 回合已写出结果，但任务还没提交 agentResult
    await first.catch(() => undefined);
    env.FAKE_CODEX_SLEEP_AFTER_OUT_MS = "0";
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(codexStarts(logFile)).toBe(1);
    expect(r.bridge.replies).toEqual([{ ticket: "t-r1", text: "已完成的回答", images: [] }]);
    expect(existsSync(path.join(dir, "tickets", "t-r1"))).toBe(false); // 回复后清理票据工作目录
  });

  it("crash mid-turn (marker, no output) → logged as interrupted and re-asked exactly once (R1)", async () => {
    const dir = tmp("cs-dispatch-r1b-");
    const logFile = path.join(dir, "codex-calls.jsonl");
    const env: Record<string, string> = { FAKE_CODEX_LOG: logFile, FAKE_CODEX_TEXT: "第二次的回答", FAKE_CODEX_SLEEP_MS: "60000" };
    const codex = codexRig(dir, env);
    const r = await makeRig({ codex }, { dir, bridge: new BridgeStub(), image: new ImageStub(), backend: new BackendStub(), store: new ContextStore(dir) });
    const first = r.dispatcher.dispatch(inbound("问二"), "t-r1b");
    while (!existsSync(logFile)) await new Promise((res) => setTimeout(res, 10));
    await r.harness.close(ctx);
    await first.catch(() => undefined);
    env.FAKE_CODEX_SLEEP_MS = "0";
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(codexStarts(logFile)).toBe(2);
    expect(r.bridge.replies).toEqual([{ ticket: "t-r1b", text: "第二次的回答", images: [] }]);
  });

  it("backend timeout → timeout template", async () => {
    const { BackendTimeoutError } = await import("../../src/agent/backends/types.js");
    const slow: AgentBackend = { name: "codex", handle: async () => { throw new BackendTimeoutError("codex 超时"); } };
    const r = await makeRig({ codex: slow });
    await r.dispatcher.dispatch(inbound("x"), "t-timeout");
    expect(r.bridge.replies[0]!.text).toBe(AGENT_FAILURE_REPLIES.timeout);
  });
});

describe("ordering (§4.7)", () => {
  it("same scope is FIFO; different scopes run in parallel", async () => {
    const r = await makeRig({ concurrency: 2 });
    r.backend.delays.set("A1", 150);
    const all = [
      r.dispatcher.dispatch(inbound("A1", { group: "1", user: "42", id: "1" }), "t-a1"),
      r.dispatcher.dispatch(inbound("A2", { group: "1", user: "42", id: "2" }), "t-a2"),
      r.dispatcher.dispatch(inbound("B1", { group: "2", user: "42", id: "3" }), "t-b1"),
    ];
    await Promise.all(all);
    const ev = r.backend.events;
    // B1 在 A1 运行期间完成（并行）；A2 在 A1 结束（且回复发出）之后才开始
    expect(ev.indexOf("end:B1")).toBeLessThan(ev.indexOf("end:A1"));
    expect(ev.indexOf("start:A2")).toBeGreaterThan(ev.indexOf("end:A1"));
    const order = r.bridge.replies.map((x) => x.ticket);
    expect(order.indexOf("t-a1")).toBeLessThan(order.indexOf("t-a2"));
  });

  it("image and agent messages of one scope share the FIFO", async () => {
    const r = await makeRig({ concurrency: 4 });
    r.backend.delays.set("慢", 100);
    await Promise.all([
      r.dispatcher.dispatch(inbound("慢", { id: "1" }), "t-slow"),
      r.dispatcher.dispatch(inbound("奶龙:快", { id: "2" }), "t-fast"),
    ]);
    expect(r.bridge.replies.map((x) => x.ticket)).toEqual(["t-slow", "t-fast"]);
  });

  it("concurrency limit applies across scopes", async () => {
    const r = await makeRig({ concurrency: 1 });
    r.backend.delays.set("A", 60);
    await Promise.all([
      r.dispatcher.dispatch(inbound("A", { group: "1", user: "42", id: "1" }), "t-a"),
      r.dispatcher.dispatch(inbound("B", { group: "2", user: "42", id: "2" }), "t-b"),
    ]);
    expect(r.backend.events).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("a ticket holds its scope head until terminal: the next one waits while the head is retried (R4/R5)", async () => {
    const r = await makeRig({ concurrency: 2 });
    r.bridge.failBeforeSend = MAX_REPLY_ATTEMPTS + 1; // R1 第 1 次尝试的回复与兜底都在发送前失败
    await Promise.all([
      r.dispatcher.dispatch(inbound("R1", { group: "1", user: "42", id: "1" }), "t-r1"),
      r.dispatcher.dispatch(inbound("R2", { group: "1", user: "42", id: "2" }), "t-r2"),
    ]);
    expect(r.bridge.replies.map((x) => x.ticket)).toEqual(["t-r1", "t-r2"]);
    // R1 的后端只调用一次（重试复用 agentResult）；R2 在 R1 回复发出之后才开始
    expect(r.backend.events).toEqual(["start:R1", "end:R1", "start:R2", "end:R2"]);
    expect(await pendingIndex(r)).toEqual({});
  });

  it("bridge down: head is marked failed after the cap (fallback attempted) and the scope moves on; restart does not re-run it (R4/R5)", async () => {
    const r = await makeRig({ concurrency: 2 });
    r.bridge.replyDown = true;
    await Promise.all([
      r.dispatcher.dispatch(inbound("F1", { group: "1", user: "42", id: "1" }), "t-f1"),
      r.dispatcher.dispatch(inbound("F2", { group: "1", user: "42", id: "2" }), "t-f2"),
    ]);
    expect(r.backend.events).toEqual(["start:F1", "end:F1", "start:F2", "end:F2"]);
    const idx = await pendingIndex(r);
    expect(idx["t-f1"]).toMatchObject({ state: "failed", givenUp: true, attempts: MAX_ATTEMPTS + 1 });
    expect(idx["t-f2"]).toMatchObject({ state: "failed" });
    expect(bot(r).find((b) => b.ticket === "t-f1")).toMatchObject({ status: "失败" });

    // 重启：failed 条目不再处理，也不会被对账当作孤儿重跑
    r.bridge.replyDown = false;
    r.bridge.pending = (["t-f1", "t-f2"] as const).map((t, i) => ({
      ticket_id: t, seq: r.bridge.seqOf(t), self_id: "1", user_id: "42", group_id: "1", message_type: "group" as const,
      source_message_id: String(i + 1), source_nickname: "tester", source_text: `F${i + 1}`, created_at: "2026-10-17T00:00:00.000Z", status: "pending" as const,
    }));
    await r.harness.close(ctx);
    await r.reopen();
    expect(await r.dispatcher.recover()).toBe(0);
    await r.dispatcher.idle();
    expect(r.bridge.replies).toEqual([]);
  });
});

describe("dispatcher bookkeeping", () => {
  it("empty-source orphan holds FIFO while the bridge is down, then replies old before new (F3)", async () => {
    const r = await makeRig();
    r.bridge.pending = [{
      ticket_id: "old-empty", seq: 1, self_id: "1", user_id: OWNER, group_id: null, message_type: "private",
      source_message_id: "1", source_nickname: "tester", source_text: "", created_at: "2026-10-17T00:00:00.000Z", status: "pending",
    }];
    await r.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      Object.assign(await tx.doc(TicketDoc, id), { ticket: "new-indexed", text: "新消息", route: "agent", source: { type: "private", user_id: OWNER, group_id: null, nickname: "tester" } });
      (await tx.doc(DispatchDoc)).pending["new-indexed"] = { conversationId: id, scope: `private:${OWNER}`, ticketSeq: 2, attempts: 0 };
    } }, ctx);
    r.bridge.replyDown = true;
    const orig = r.bridge.reply.bind(r.bridge);
    let firstEntry: unknown;
    r.bridge.reply = async (ticket, text, images) => {
      if (r.bridge.replyDown) {
        firstEntry = (await pendingIndex(r))[ticket];
        expect(r.backend.requests).toHaveLength(0);
        try { return await orig(ticket, text, images); }
        finally { r.bridge.replyDown = false; }
      }
      return orig(ticket, text, images);
    };
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(firstEntry).toMatchObject({ fallbackOnly: true, attempts: 1, ticketSeq: 1 });
    expect(r.bridge.replies.map(x => x.ticket)).toEqual(["old-empty", "new-indexed"]);
    expect(r.backend.requests.map(x => x.ticket)).toEqual(["new-indexed"]);
    expect(await pendingIndex(r)).toEqual({});
  });

  it("empty-source fallback persists its retry cap and is not retried after restart (F3)", async () => {
    const r = await makeRig();
    r.bridge.pending = [{
      ticket_id: "empty-cap", seq: 1, self_id: "1", user_id: OWNER, group_id: null, message_type: "private",
      source_message_id: "1", source_nickname: "tester", source_text: "", created_at: "2026-10-17T00:00:00.000Z", status: "pending",
    }];
    r.bridge.replyDown = true;
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect((await pendingIndex(r))["empty-cap"]).toMatchObject({ fallbackOnly: true, givenUp: true, state: "failed", attempts: MAX_ATTEMPTS + 1 });
    expect(r.bridge.calls).toBe(MAX_ATTEMPTS + 1);
    expect(r.backend.requests).toHaveLength(0);
    await r.harness.close(ctx);
    await r.reopen();
    r.bridge.replyDown = false;
    expect(await r.dispatcher.recover()).toBe(0);
    expect(r.bridge.replies).toHaveLength(0);
  });

  it("crash after send before cleanup: recovery removes ticket workdir and keeps images (F6)", async () => {
    const r = await makeRig();
    const ticket = "sent-before-cleanup";
    const workdir = path.join(r.dir, "tickets", ticket);
    mkdirSync(workdir, { recursive: true });
    writeFileSync(path.join(workdir, "codex-last.txt"), "answer");
    mkdirSync(imgDir(r, ticket), { recursive: true });
    writeFileSync(path.join(imgDir(r, ticket), "keep.png"), PNG);
    const orig = r.bridge.reply.bind(r.bridge);
    r.bridge.reply = async (id, text, images, opts?: { signal?: AbortSignal }) => {
      await orig(id, text, images);
      return untilAbort(opts?.signal); // 已发送但 replyPhase 尚未清理 / 提交
    };
    const first = r.dispatcher.dispatch(inbound("hi"), ticket);
    await vi.waitFor(() => expect(r.bridge.status.get(ticket)).toBe("sent"));
    await r.harness.close(ctx);
    await first;
    expect(existsSync(workdir)).toBe(true);
    r.bridge.reply = orig;
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(existsSync(workdir)).toBe(false);
    expect(existsSync(path.join(imgDir(r, ticket), "keep.png"))).toBe(true);
    expect(r.bridge.replies).toHaveLength(1);
    expect(await pendingIndex(r)).toEqual({});
  });

  it.each(["uncertain", "sending", "failed", "given-up"])("terminal reconciliation cleans %s workdir idempotently (F6)", async status => {
    const r = await makeRig();
    const ticket = "cleanup-" + status;
    const workdir = path.join(r.dir, "tickets", ticket);
    mkdirSync(workdir, { recursive: true });
    writeFileSync(path.join(workdir, "codex-last.txt"), "answer");
    if (status === "uncertain" || status === "sending") r.bridge.status.set(ticket, status);
    else r.bridge.replyDown = true;
    await r.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      (await tx.doc(DispatchDoc)).pending[ticket] = { conversationId: id, scope: `private:${OWNER}`, attempts: 0,
        ...(status === "failed" ? { state: "failed" as const } : {}), ...(status === "given-up" ? { givenUp: true } : {}) };
    } }, ctx);
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(existsSync(workdir)).toBe(false);
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(existsSync(workdir)).toBe(false);
  });

  it("same ticket dispatched twice runs once", async () => {
    const r = await makeRig();
    await Promise.all([r.dispatcher.dispatch(inbound("hi"), "t-dup"), r.dispatcher.dispatch(inbound("hi"), "t-dup")]);
    await r.dispatcher.dispatch(inbound("hi"), "t-dup");
    expect(r.backend.requests).toHaveLength(1);
    expect(r.bridge.replies).toHaveLength(1);
  });

  it("at the attempt cap the live task is aborted and settled before the single fallback; no further side effects (R3)", async () => {
    const r = await makeRig();
    r.backend.delays.set("hi", 60_000);
    const first = r.dispatcher.dispatch(inbound("hi"), "t-cap");
    while (r.backend.requests.length === 0) await new Promise((res) => setTimeout(res, 5));
    await r.harness.close(ctx); // 进程在后端运行中退出：任务仍为活任务
    await first.catch(() => undefined);
    await r.reopen();
    await r.harness.commit(async (tx) => {
      (await tx.doc(DispatchDoc)).pending["t-cap"]!.attempts = MAX_ATTEMPTS;
    }, ctx);
    const taskId = (await pendingIndex(r))["t-cap"]!.taskId!;
    const statusAtFallback: string[] = [];
    const orig = r.bridge.reply.bind(r.bridge);
    r.bridge.reply = async (ticket: string, text: string, images?: string[]) => {
      statusAtFallback.push((await r.harness.getTask(taskId as never, ctx))!.state.status);
      return orig(ticket, text, images);
    };
    r.backend.delays.delete("hi");
    const before = r.backend.requests.length;
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.backend.requests.length).toBe(before);
    expect(statusAtFallback).toEqual(["terminal"]);
    expect(r.bridge.replies).toEqual([{ ticket: "t-cap", text: FALLBACK_REPLY, images: undefined }]);
    expect(await pendingIndex(r)).toEqual({});
    expect(bot(r).find((b) => b.ticket === "t-cap")).toMatchObject({ action: "fallback", status: "失败" });
  });

  it("a task phase that finds the dispatch entry given up ends failed without side effects (R3)", async () => {
    const r = await makeRig();
    const gate = deferred();
    r.image.unknown.add("pid-1");
    const origCollect = r.image.collect.bind(r.image);
    r.image.collect = async (id: string, out: string, signal?: AbortSignal) => {
      await gate.promise;
      return origCollect(id, out, signal);
    };
    const run = r.dispatcher.dispatch(inbound("奶龙:船"), "t-gone");
    while (r.image.calls.length === 0) await new Promise((res) => setTimeout(res, 5));
    // 并发的 giveUp 已标记条目；collect 随后报告任务未知 → 重新提交前的检查拦下
    await r.harness.commit(async (tx) => {
      (await tx.doc(DispatchDoc)).pending["t-gone"]!.givenUp = true;
    }, ctx);
    gate.resolve();
    await run;
    expect(r.image.calls).toEqual(["船"]); // 没有第二次提交
    expect(r.bridge.replies.map((x) => x.text)).toEqual([FALLBACK_REPLY]); // 只有兜底，任务本身没有发送
  });

  it("recover re-dispatches a pending ticket that has no dispatch index (crash after admit)", async () => {
    const r = await makeRig();
    r.bridge.pending = [{
      ticket_id: "t-orphan", seq: 1, self_id: "1", user_id: OWNER, group_id: null, message_type: "private",
      source_message_id: "900", source_nickname: "tester", source_text: "奶龙:补派发",
      created_at: "2026-10-17T00:00:00.000Z", status: "pending",
    }];
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.image.calls).toEqual(["补派发"]);
    expect(r.bridge.replies).toHaveLength(1);
  });

  it("recovery merge-sorts indexed and orphan tickets by bridge seq: an older orphan runs before a newer indexed ticket (R6)", async () => {
    const r = await makeRig({ concurrency: 2 });
    r.bridge.seqs.set("t-indexed", 50);
    r.backend.delays.set("新消息", 60_000);
    const first = r.dispatcher.dispatch(inbound("新消息", { id: "2" }), "t-indexed");
    while (r.backend.requests.length === 0) await new Promise((res) => setTimeout(res, 5));
    await r.harness.close(ctx); // 进程在后端运行中退出：索引保留
    await first.catch(() => undefined);

    r.backend.delays.delete("新消息");
    r.bridge.pending = [{
      ticket_id: "t-old-orphan", seq: 10, self_id: "1", user_id: OWNER, group_id: null, message_type: "private",
      source_message_id: "1", source_nickname: "tester", source_text: "老消息", source_route_text: "老消息",
      created_at: "2026-10-17T00:00:00.000Z", status: "pending",
    }];
    await r.reopen();
    expect((await pendingIndex(r))["t-indexed"]).toMatchObject({ ticketSeq: 50 });
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.bridge.replies.map((x) => x.ticket)).toEqual(["t-old-orphan", "t-indexed"]);
    const starts = r.backend.events.filter((e) => e.startsWith("start:"));
    expect(starts.slice(-2)).toEqual(["start:老消息", "start:新消息"]);
  });

  it("recovery pages listPendingTickets until exhausted (>200 orphans) (R7)", async () => {
    const r = await makeRig({ concurrency: 4 });
    r.bridge.pending = Array.from({ length: 250 }, (_, i) => ({
      ticket_id: `t-o${i}`, seq: i + 1, self_id: "1", user_id: String(10_000 + i), group_id: null, message_type: "private" as const,
      source_message_id: String(i), source_nickname: "n", source_text: "", created_at: "2026-10-17T00:00:00.000Z", status: "pending" as const,
    }));
    expect(await r.dispatcher.recover()).toBe(250);
    await r.dispatcher.idle();
    expect(r.bridge.replies).toHaveLength(250);
    expect(new Set(r.bridge.replies.map((x) => x.ticket)).size).toBe(250);
    expect(r.bridge.listCalls.map((c) => c.after)).toEqual([0, 200]);
  });

  it("history errors never break dispatch", async () => {
    const r = await makeRig();
    r.store.close();
    await r.dispatcher.dispatch(inbound("奶龙:x"), "t-hist");
    expect(r.bridge.replies).toHaveLength(1);
    r.store = new ContextStore(r.dir);
  });
});
