import type { ImageOptions } from "../../src/media/gen/image-options.js";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Harness, ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dispatcher, IMAGE_FALLBACK_REPLY, MAX_ATTEMPTS } from "../../src/agent/dispatch.js";
import { DispatchDoc, TicketDoc } from "../../src/agent/docs.js";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { openHarness } from "../../src/agent/harness.js";
import { createTasks, MAX_REPLY_ATTEMPTS } from "../../src/agent/tasks.js";
import { imageFilenamePrefix, UnknownJobError, type ImageBackend, type ImageSubmission, type ReconcileProgress } from "../../src/media/gen/image-gen.js";
import { IMAGE_FAILURE_REPLIES, IMAGE_SUCCESS_REPLY } from "../../src/agent/replies.js";
import { IMAGE_USAGE_REPLY } from "../../src/agent/router.js";
import type { InboundMessage, ReplyTicketRecord } from "../../src/channel/types.js";
import { ContextStore } from "../../src/context/store.js";
import { tmp } from "./helpers.js";

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

/** Channel 桩：记录 reply，维护生图票据状态。 */
class BridgeStub {
  replies: { ticket: string; text: string; images?: string[] }[] = [];
  status = new Map<string, ReplyTicketRecord["status"]>();
  pending: ReplyTicketRecord[] = [];
  abandoned: string[] = [];
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
  async abandonTicket(ticket: string) {
    this.abandoned.push(ticket);
    if ((this.status.get(ticket) ?? "pending") === "pending") this.status.set(ticket, "uncertain");
  }
  /** 票据 seq（开票顺序）：可预设；未预设的在首次读取时按递增顺序分配 */
  seqs = new Map<string, number>();
  nextSeq = 1000;
  listCalls: { limit?: number; after?: number }[] = [];
  seqOf(ticket: string): number {
    let s = this.seqs.get(ticket) ?? this.pending.find((r) => r.ticket_id === ticket)?.seq;
    if (s === undefined) this.seqs.set(ticket, (s = this.nextSeq++));
    return s;
  }
  records = new Map<string, InboundMessage>();
  async getTicket(ticket: string) {
    if (this.getTicketFailures > 0) {
      this.getTicketFailures--;
      throw new Error("db locked");
    }
    const msg = this.records.get(ticket);
    return { ticket_id: ticket, seq: this.seqOf(ticket),
      message_type: msg?.message_type ?? "private", user_id: msg?.user_id ?? OWNER, group_id: msg?.group_id ?? null,
      source_message_id: msg?.message_id ?? "1", source_nickname: msg?.nickname ?? "测试", source_text: msg?.text ?? "",
      ...this.pending.find(r => r.ticket_id === ticket),
      status: this.status.get(ticket) ?? "pending" } as ReplyTicketRecord;
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
  /** 按提示词延迟 submit（模拟慢任务），并记录起止事件 */
  delays = new Map<string, number>();
  events: string[] = [];
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
    this.events.push(`start:${opts.prompt}`);
    if (this.fail) throw this.fail;
    if (this.hangSubmit) await untilAbort(signal);
    const delay = this.delays.get(opts.prompt);
    if (delay) await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delay);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
    });
    this.events.push(`end:${opts.prompt}`);
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

interface RigOptions {
  concurrency?: number;
}

interface Rig {
  dir: string;
  harness: Harness;
  dispatcher: Dispatcher;
  bridge: BridgeStub;
  image: ImageStub;
  store: ContextStore;
  reopen(): Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.harness.close(ctx).catch(() => undefined);
    r.store.close();
  }
});

async function makeRig(o: RigOptions = {}, shared?: Pick<Rig, "dir" | "bridge" | "image" | "store">): Promise<Rig> {
  const dir = shared?.dir ?? tmp("cs-dispatch-");
  const bridge = shared?.bridge ?? new BridgeStub();
  const image = shared?.image ?? new ImageStub();
  const store = shared?.store ?? new ContextStore(dir);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const tasks = createTasks({
    getBridge: () => bridge,
    imageBackend: image,
    imagesDir: path.join(dir, "images"),
    replyRetryDelayMs: 10,
    imageCollectDelayMs: 10,
  });
  const harness = await openHarness({ models, extension: createCsAgentExtension(tasks), dbFile: path.join(dir, "agent.sqlite") }, ctx);
  const dispatcher = new Dispatcher({ harness, bridge, tasks, concurrency: o.concurrency ?? 2, history: store, retryDelayMs: 10 });
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  dispatcher.dispatch = (msg, ticket) => { bridge.records.set(ticket, msg); return dispatch(msg, ticket); };
  // 与 main.ts 一致：重开时先 recover() 再开启调度（测试里由 recover 后的 waitForTask 开启）
  if (!shared) harness.resume();
  const rig: Rig = {
    dir, harness, dispatcher, bridge, image, store,
    async reopen() {
      const next = await makeRig(o, rig);
      rigs.splice(rigs.indexOf(next), 1);
      Object.assign(rig, { harness: next.harness, dispatcher: next.dispatcher });
    },
  };
  rigs.push(rig);
  return rig;
}

const pendingIndex = async (r: Rig) => (await r.harness.snapshot(DispatchDoc, ctx))?.pending ?? {};
const imgDir = (r: Rig, ticket: string) => path.join(r.dir, "images", ticket);
const bot = (r: Rig) => r.store.recent({ kind: "all" }, { limit: 20 }).filter((row) => row.is_self === 1);
const orphan = (ticket_id: string, seq: number, source_text: string, user_id = OWNER): ReplyTicketRecord => ({
  ticket_id, seq, self_id: "1", user_id, group_id: null, message_type: "private", source_message_id: String(seq),
  source_nickname: "tester", source_text, source_route_text: source_text, created_at: "2026-10-17T00:00:00.000Z", status: "pending",
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

describe("ordering (§4.7)", () => {
  it("same scope is FIFO; different scopes run in parallel", async () => {
    const r = await makeRig({ concurrency: 2 });
    r.image.delays.set("A1", 150);
    await Promise.all([
      r.dispatcher.dispatch(inbound("奶龙:A1", { group: "1", user: OWNER, id: "1" }), "t-a1"),
      r.dispatcher.dispatch(inbound("奶龙:A2", { group: "1", user: "42", id: "2" }), "t-a2"),
      r.dispatcher.dispatch(inbound("奶龙:B1", { group: "2", user: OWNER, id: "3" }), "t-b1"),
    ]);
    const ev = r.image.events;
    // B1 在 A1 运行期间完成（并行）；A2 在 A1 结束（且回复发出）之后才开始
    expect(ev.indexOf("end:B1")).toBeLessThan(ev.indexOf("end:A1"));
    expect(ev.indexOf("start:A2")).toBeGreaterThan(ev.indexOf("end:A1"));
    const order = r.bridge.replies.map((x) => x.ticket);
    expect(order.indexOf("t-a1")).toBeLessThan(order.indexOf("t-a2"));
  });

  it("concurrency limit applies across scopes", async () => {
    const r = await makeRig({ concurrency: 1 });
    r.image.delays.set("A", 60);
    await Promise.all([
      r.dispatcher.dispatch(inbound("奶龙:A", { group: "1", user: "42", id: "1" }), "t-a"),
      r.dispatcher.dispatch(inbound("奶龙:B", { group: "2", user: "42", id: "2" }), "t-b"),
    ]);
    expect(r.image.events).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("a ticket holds its scope head until terminal: the next one waits while the head is retried (R4/R5)", async () => {
    const r = await makeRig({ concurrency: 2 });
    r.bridge.failBeforeSend = MAX_REPLY_ATTEMPTS + 1; // R1 第 1 次尝试的回复与兜底都在发送前失败
    await Promise.all([
      r.dispatcher.dispatch(inbound("奶龙:R1", { group: "1", user: "42", id: "1" }), "t-r1"),
      r.dispatcher.dispatch(inbound("奶龙:R2", { group: "1", user: "42", id: "2" }), "t-r2"),
    ]);
    expect(r.bridge.replies.map((x) => x.ticket)).toEqual(["t-r1", "t-r2"]);
    // R1 的生图只提交一次（重试复用 imageResult）；R2 在 R1 回复发出之后才开始
    expect(r.image.events).toEqual(["start:R1", "end:R1", "start:R2", "end:R2"]);
    expect(await pendingIndex(r)).toEqual({});
  });

  it("bridge down: head is marked failed after the cap (fallback attempted) and the scope moves on; restart does not re-run it (R4/R5)", async () => {
    const r = await makeRig({ concurrency: 2 });
    r.bridge.replyDown = true;
    await Promise.all([
      r.dispatcher.dispatch(inbound("奶龙:F1", { group: "1", user: "42", id: "1" }), "t-f1"),
      r.dispatcher.dispatch(inbound("奶龙:F2", { group: "1", user: "42", id: "2" }), "t-f2"),
    ]);
    expect(r.image.events).toEqual(["start:F1", "end:F1", "start:F2", "end:F2"]);
    const idx = await pendingIndex(r);
    expect(idx["t-f1"]).toMatchObject({ state: "failed", givenUp: true, attempts: MAX_ATTEMPTS + 1 });
    expect(idx["t-f2"]).toMatchObject({ state: "failed" });

    // 重启：failed 条目不再处理，也不会被对账当作孤儿重跑
    r.bridge.replyDown = false;
    r.bridge.pending = (["t-f1", "t-f2"] as const).map((t, i) => ({
      ...orphan(t, r.bridge.seqOf(t), `奶龙:F${i + 1}`, "42"), group_id: "1", message_type: "group" as const,
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
    r.bridge.pending = [orphan("old-empty", 1, "")];
    await r.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      Object.assign(await tx.doc(TicketDoc, id), { ticket: "new-indexed", text: "奶龙:新图", route: "image", prefix: "奶龙:", prompt: "新图",
        imageOptions: { prompt: "新图" }, source: { type: "private", user_id: OWNER, group_id: null, nickname: "tester" } });
      (await tx.doc(DispatchDoc)).pending["new-indexed"] = { conversationId: id, scope: `private:${OWNER}`, ticketSeq: 2, attempts: 0 };
    } }, ctx);
    r.bridge.replyDown = true;
    const orig = r.bridge.reply.bind(r.bridge);
    let firstEntry: unknown;
    r.bridge.reply = async (ticket, text, images) => {
      if (r.bridge.replyDown) {
        firstEntry = (await pendingIndex(r))[ticket];
        expect(r.image.calls).toHaveLength(0);
        try { return await orig(ticket, text, images); }
        finally { r.bridge.replyDown = false; }
      }
      return orig(ticket, text, images);
    };
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(firstEntry).toMatchObject({ fallbackOnly: true, attempts: 1, ticketSeq: 1 });
    expect(r.bridge.replies.map(x => x.ticket)).toEqual(["old-empty", "new-indexed"]);
    expect(r.bridge.replies[0]!.text).toBe(IMAGE_FALLBACK_REPLY);
    expect(r.image.calls).toEqual(["新图"]);
    expect(await pendingIndex(r)).toEqual({});
  });

  it("empty-source fallback persists its retry cap and is not retried after restart (F3)", async () => {
    const r = await makeRig();
    r.bridge.pending = [orphan("empty-cap", 1, "")];
    r.bridge.replyDown = true;
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect((await pendingIndex(r))["empty-cap"]).toMatchObject({ fallbackOnly: true, givenUp: true, state: "failed", attempts: MAX_ATTEMPTS + 1 });
    expect(r.bridge.calls).toBe(MAX_ATTEMPTS + 1);
    expect(r.image.calls).toHaveLength(0);
    await r.harness.close(ctx);
    await r.reopen();
    r.bridge.replyDown = false;
    expect(await r.dispatcher.recover()).toBe(0);
    expect(r.bridge.replies).toHaveLength(0);
  });

  it("crash after send before the task commit: recovery does not resend, keeps images and clears the index (F6)", async () => {
    const r = await makeRig();
    const ticket = "sent-before-commit";
    const orig = r.bridge.reply.bind(r.bridge);
    r.bridge.reply = async (id, text, images, opts?: { signal?: AbortSignal }) => {
      await orig(id, text, images);
      return untilAbort(opts?.signal); // 已发送但 replyPhase 尚未提交
    };
    const first = r.dispatcher.dispatch(inbound("奶龙:hi"), ticket);
    await vi.waitFor(() => expect(r.bridge.status.get(ticket)).toBe("sent"));
    await r.harness.close(ctx);
    await first;
    r.bridge.reply = orig;
    await r.reopen();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(existsSync(path.join(imgDir(r, ticket), "out_1.png"))).toBe(true);
    expect(r.bridge.replies).toHaveLength(1);
    expect(r.image.calls).toHaveLength(1);
    expect(await pendingIndex(r)).toEqual({});
  });

  it("same ticket dispatched twice runs once", async () => {
    const r = await makeRig();
    await Promise.all([r.dispatcher.dispatch(inbound("奶龙:hi"), "t-dup"), r.dispatcher.dispatch(inbound("奶龙:hi"), "t-dup")]);
    await r.dispatcher.dispatch(inbound("奶龙:hi"), "t-dup");
    expect(r.image.calls).toHaveLength(1);
    expect(r.bridge.replies).toHaveLength(1);
  });

  it("at the attempt cap the live task is aborted and settled before the single fallback; no further side effects (R3)", async () => {
    const r = await makeRig();
    r.image.hangCollect = true;
    const first = r.dispatcher.dispatch(inbound("奶龙:hi"), "t-cap");
    while (r.image.collects.length === 0) await new Promise((res) => setTimeout(res, 5));
    await r.harness.close(ctx); // 进程在收取中退出：任务仍为活任务
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
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.image.calls).toHaveLength(1);
    expect(statusAtFallback).toEqual(["terminal"]);
    expect(r.bridge.replies).toEqual([{ ticket: "t-cap", text: IMAGE_FALLBACK_REPLY, images: undefined }]);
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
    expect(r.bridge.replies.map((x) => x.text)).toEqual([IMAGE_FALLBACK_REPLY]); // 只有兜底，任务本身没有发送
  });

  it("recover re-dispatches a pending ticket that has no dispatch index (crash after open)", async () => {
    const r = await makeRig();
    r.bridge.pending = [orphan("t-orphan", 1, "奶龙:补派发")];
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.image.calls).toEqual(["补派发"]);
    expect(r.bridge.replies).toHaveLength(1);
  });

  it("recovery merge-sorts indexed and orphan tickets by ticket seq: an older orphan runs before a newer indexed ticket (R6)", async () => {
    const r = await makeRig({ concurrency: 2 });
    r.bridge.seqs.set("t-indexed", 50);
    r.image.hangCollect = true;
    const first = r.dispatcher.dispatch(inbound("奶龙:新消息", { id: "2" }), "t-indexed");
    while (r.image.collects.length === 0) await new Promise((res) => setTimeout(res, 5));
    await r.harness.close(ctx); // 进程在生图中退出：索引保留
    await first.catch(() => undefined);
    r.bridge.pending = [orphan("t-old-orphan", 10, "奶龙:老消息")];
    await r.reopen();
    expect((await pendingIndex(r))["t-indexed"]).toMatchObject({ ticketSeq: 50 });
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.bridge.replies.map((x) => x.ticket)).toEqual(["t-old-orphan", "t-indexed"]);
    expect(r.image.calls).toEqual(["新消息", "老消息"]);
  });

  it("recovery pages listPendingTickets until exhausted (>200 orphans) (R7)", async () => {
    const r = await makeRig({ concurrency: 4 });
    r.bridge.pending = Array.from({ length: 250 }, (_, i) => orphan(`t-o${i}`, i + 1, "", String(10_000 + i)));
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

describe("部署前遗留的票据（第 2 阶段起 agent 不再走派发器）", () => {
  it.each(["message", "scheduled"] as const)("遗留 %s 派发条目在恢复时退役：任务中止、索引清除、不发送", async kind => {
    const r = await makeRig();
    const ticket = kind === "scheduled" ? "run_" + "a".repeat(40) : "legacy-agent";
    const task = await r.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      Object.assign(await tx.doc(TicketDoc, id), { ticket, text: "帮我查一下", route: "agent",
        source: { type: "private", user_id: OWNER, group_id: null, nickname: "tester" } });
      (await tx.doc(DispatchDoc)).pending[ticket] = { conversationId: id, scope: `private:${OWNER}`, ticketSeq: 1, attempts: 1,
        ...(kind === "scheduled" ? { kind } : {}) };
    } }, ctx);
    expect(task.id).toBeTruthy();
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(await pendingIndex(r)).toEqual({});
    expect(r.bridge.replies).toEqual([]);
    expect(r.image.calls).toEqual([]);
    expect(r.bridge.abandoned).toEqual(kind === "scheduled" ? [] : [ticket]);
  });

  it("遗留 agent 派发条目的活任务在恢复时被中止", async () => {
    const r = await makeRig();
    r.image.hangCollect = true;
    const first = r.dispatcher.dispatch(inbound("奶龙:旧任务"), "legacy-live");
    while (r.image.collects.length === 0) await new Promise((res) => setTimeout(res, 5));
    await r.harness.close(ctx);
    await first.catch(() => undefined);
    await r.reopen();
    const entry = (await pendingIndex(r))["legacy-live"]!;
    // 假装这是部署前的 agent 票据
    await r.harness.commit(async tx => { (await tx.doc(TicketDoc, entry.conversationId as ConversationId)).route = "agent"; }, ctx);
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    const task = await r.harness.waitForTask(entry.taskId as never, ctx);
    expect(task.state.outcome.status).toBe("aborted");
    expect(await pendingIndex(r)).toEqual({});
    expect(r.bridge.abandoned).toEqual(["legacy-live"]);
    expect(r.bridge.replies).toEqual([]);
  });

  it("没有索引、正文不是生图前缀的孤儿票据结束为 uncertain，不派发", async () => {
    const r = await makeRig();
    r.bridge.pending = [orphan("legacy-orphan", 1, "你好呀"), orphan("image-orphan", 2, "奶龙:猫")];
    expect(await r.dispatcher.recover()).toBe(1);
    await r.dispatcher.idle();
    expect(r.bridge.abandoned).toEqual(["legacy-orphan"]);
    expect(r.bridge.status.get("legacy-orphan")).toBe("uncertain");
    expect(r.image.calls).toEqual(["猫"]);
    expect(r.bridge.replies.map(x => x.ticket)).toEqual(["image-orphan"]);
  });
});
