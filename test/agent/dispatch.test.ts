import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { Dispatcher, FALLBACK_REPLY, MAX_ATTEMPTS } from "../../src/agent/dispatch.js";
import { DispatchDoc, TicketDoc } from "../../src/agent/docs.js";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { openHarness } from "../../src/agent/harness.js";
import { CodexRunner } from "../../src/agent/codex-runner.js";
import { CodexBackend } from "../../src/agent/backends/codex.js";
import { createBackendSelector, PiBackendStub } from "../../src/agent/backends/select.js";
import type { AgentBackend, BackendName } from "../../src/agent/backends/types.js";
import { createTasks, MAX_REPLY_ATTEMPTS } from "../../src/agent/tasks.js";
import type { ImageBackend } from "../../src/agent/image-gen.js";
import { AGENT_FAILURE_REPLIES, IMAGE_FAILURE_REPLIES, IMAGE_SUCCESS_REPLY } from "../../src/agent/replies.js";
import { IMAGE_USAGE_REPLY } from "../../src/agent/router.js";
import type { ReplyMode } from "../../src/agent/reply-postprocess.js";
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
    segments: [{ type: "text", data: { text } }],
  };
}

/** 生图桩：写一张 PNG；可挂起（模拟生成中崩溃）或失败。 */
class ImageStub implements Pick<ImageBackend, "generate" | "name"> {
  readonly name = "stub";
  calls: string[] = [];
  fail: Error | undefined;
  /** 写完文件后挂起，直到 signal 中止 */
  hangAfterWrite = false;
  async generate(prompt: string, outDir: string, signal?: AbortSignal) {
    this.calls.push(prompt);
    if (this.fail) throw this.fail;
    mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, `out_${this.calls.length}.png`);
    writeFileSync(f, PNG);
    if (this.hangAfterWrite) {
      await new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
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
  overrides?: Record<string, BackendName>;
  replyMode?: ReplyMode;
  codexEnv?: Record<string, string>;
  relay?: boolean;
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
    backends,
    owner: OWNER,
    store,
    codexReplyMode: o.replyMode ?? "direct",
    models,
    relayModel: faux.getModel(),
    replyRetryDelayMs: 10,
  });
  const harness = await openHarness({ models, extension: createCsAgentExtension(tasks), dbFile: path.join(dir, "agent.sqlite") }, ctx);
  const dispatcher = new Dispatcher({ harness, bridge, tasks, concurrency: o.concurrency ?? 2, history: store, codexEffort: "high" });
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

describe("rule router → image path", () => {
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

  it("task fails (reply down) and fallback fails → index kept; rerun after restart skips generation and sends once", async () => {
    const r = await makeRig();
    r.bridge.replyDown = true;
    await r.dispatcher.dispatch(inbound("奶龙:森林"), "t-rerun");
    expect(r.bridge.calls).toBe(MAX_REPLY_ATTEMPTS + 1); // 任务内 3 次 + 兜底 1 次，全部在发送前失败
    expect(r.bridge.replies).toEqual([]);
    expect((await pendingIndex(r))["t-rerun"]?.attempts).toBe(1);

    r.bridge.replyDown = false;
    await r.harness.close(ctx);
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.image.calls).toEqual(["森林"]);
    expect(r.bridge.replies).toHaveLength(1);
    expect(r.bridge.replies[0]!.text).toBe(IMAGE_SUCCESS_REPLY);
    expect(await pendingIndex(r)).toEqual({});
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
  it("non-prefixed message → agent backend with scope/access/threadKey; reply is sanitized (direct)", async () => {
    const r = await makeRig();
    await r.dispatcher.dispatch(inbound("今晚有比赛吗", { group: "200000001", user: "42" }), "t-agent");
    expect(r.image.calls).toEqual([]);
    expect(r.backend.requests[0]).toMatchObject({
      ticket: "t-agent", scope: "group:200000001", access: "group:200000001", threadKey: "shared", text: "今晚有比赛吗",
    });
    expect(r.bridge.replies).toEqual([{ ticket: "t-agent", text: "答复\n今晚有比赛吗 ok ＠all", images: [] }]);
    expect(bot(r)[0]).toMatchObject({ action: "ask_codex", detail: "high", status: "已回复" });
  });

  it("owner private → access all / owner thread", async () => {
    const r = await makeRig();
    await r.dispatcher.dispatch(inbound("hi"), "t-owner");
    expect(r.backend.requests[0]).toMatchObject({ access: "all", threadKey: "owner", scope: `private:${OWNER}` });
  });

  it("relay mode: the intent model's reformatted text is sent (sanitized again)", async () => {
    const r = await makeRig({ replyMode: "relay" });
    r.faux.setResponses([fauxAssistantMessage(fauxText("整理后的答复 @某人"))]);
    await r.dispatcher.dispatch(inbound("问个问题"), "t-relay");
    expect(r.bridge.replies[0]!.text).toBe("整理后的答复 ＠某人");
    expect(r.faux.state.callCount).toBe(1);
  });

  it("relay failure falls back to sanitize only", async () => {
    const r = await makeRig({ replyMode: "relay" });
    r.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" })]);
    await r.dispatcher.dispatch(inbound("问"), "t-relay-fail");
    expect(r.bridge.replies[0]!.text).toBe("答复\n问 ok ＠all");
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
    const codex = new CodexBackend({ runner, imagesDir: path.join(dir, "images"), reasoningEffort: "medium" });
    const r = await makeRig({ codex }, { dir, bridge: new BridgeStub(), image: new ImageStub(), backend: new BackendStub(), store: new ContextStore(dir) });
    await r.dispatcher.dispatch(inbound("画一张图并配一句话", { group: "200000001", user: "42" }), "t-codex-e2e");
    const start = readFileSync(logFile, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)).find((c) => c.phase === "start");
    expect(start.argv).toEqual(expect.arrayContaining(["-c", 'mcp_servers.qq_context.env.QQ_ACCESS="group:200000001"']));
    expect(start.argv).toEqual(expect.arrayContaining(["-c", `mcp_servers.image_gen.env.IMAGE_TICKET_DIR="${imgDir(r, "t-codex-e2e")}"`]));
    expect(start.argv).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="medium"']));
    expect(start.stdin.split("\n")[0]).toMatch(/^\[来源\] 群 200000001 · tester\(42\) · /);
    const reply = r.bridge.replies[0]!;
    expect(reply.text).toBe("画好了");
    expect(reply.images).toHaveLength(4);
    expect(reply.images!.every((f) => f.endsWith(".png"))).toBe(true);
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

  it("recovery respects scope FIFO (seq order)", async () => {
    const r = await makeRig({ concurrency: 2 });
    r.bridge.replyDown = true;
    // 三条都失败（回复不可用）且兜底失败 → 索引保留
    await r.dispatcher.dispatch(inbound("R1", { group: "1", user: "42", id: "1" }), "t-r1");
    await r.dispatcher.dispatch(inbound("R2", { group: "1", user: "42", id: "2" }), "t-r2");
    expect(Object.keys(await pendingIndex(r)).sort()).toEqual(["t-r1", "t-r2"]);
    r.bridge.replyDown = false;
    r.backend.events = [];
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.bridge.replies.map((x) => x.ticket)).toEqual(["t-r1", "t-r2"]);
    // 已有 agentResult：重跑不再调用后端
    expect(r.backend.events).toEqual([]);
  });
});

describe("dispatcher bookkeeping", () => {
  it("same ticket dispatched twice runs once", async () => {
    const r = await makeRig();
    await Promise.all([r.dispatcher.dispatch(inbound("hi"), "t-dup"), r.dispatcher.dispatch(inbound("hi"), "t-dup")]);
    await r.dispatcher.dispatch(inbound("hi"), "t-dup");
    expect(r.backend.requests).toHaveLength(1);
    expect(r.bridge.replies).toHaveLength(1);
  });

  it("infra error keeps the index with attempts; recover gives up at the limit with one fallback", async () => {
    const r = await makeRig();
    r.bridge.getTicketFailures = 2; // 任务后 fallbackIfUnreplied 读不到票据
    r.bridge.replyDown = true;
    await r.dispatcher.dispatch(inbound("hi"), "t-infra");
    expect((await pendingIndex(r))["t-infra"]?.attempts).toBe(1);
    await r.harness.commit(async (tx) => {
      (await tx.doc(DispatchDoc)).pending["t-infra"]!.attempts = MAX_ATTEMPTS;
    }, ctx);
    r.bridge.replyDown = false;
    const before = r.backend.requests.length;
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.backend.requests.length).toBe(before);
    expect(r.bridge.replies).toEqual([{ ticket: "t-infra", text: FALLBACK_REPLY, images: undefined }]);
    expect(await pendingIndex(r)).toEqual({});
    expect(bot(r).find((b) => b.ticket === "t-infra")).toMatchObject({ action: "fallback", status: "失败" });
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
