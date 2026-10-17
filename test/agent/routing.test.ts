import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import { MemoryStorage, type Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { Dispatcher, FALLBACK_REPLY, MAX_ATTEMPTS } from "../../src/agent/dispatch.js";
import { DispatchDoc } from "../../src/agent/docs.js";
import { createCsAgentExtension, SYSTEM_PROMPT } from "../../src/agent/extension.js";
import { openHarness } from "../../src/agent/harness.js";
import { CodexRunner, createAskCodexTool } from "../../src/agent/tools/ask-codex.js";
import { createGenerateImageTool, type ImageBackend } from "../../src/agent/tools/generate-image.js";
import { createReplyQQTool } from "../../src/agent/tools/reply-qq.js";
import type { InboundMessage, ReplyTicketRecord } from "../../src/qq/types.js";
import { FIXTURES, tmp } from "./helpers.js";
import { ContextStore } from "../../src/context/store.js";

const ctx = BACKGROUND_CONTEXT;

/** QQBridge 桩：记录 reply，维护票据状态。 */
class BridgeStub {
  replies: { ticket: string; text: string; images?: string[] }[] = [];
  status = new Map<string, ReplyTicketRecord["status"]>();
  pending: ReplyTicketRecord[] = [];
  /** >0 时 getTicket 抛错（模拟 SQLite 等基础设施故障），每次调用减 1 */
  getTicketFailures = 0;
  /** true 时 reply 在发送前失败（票据保持 pending） */
  replyDown = false;
  async reply(ticket: string, text: string, images?: string[]) {
    if (this.replyDown) throw new Error("NapCat unreachable");
    const already = this.status.get(ticket) === "sent";
    if (!already) this.replies.push({ ticket, text, images });
    this.status.set(ticket, "sent");
    return { already_sent: already, message_id: "m1", message_type: "private" as const, target_id: "1" };
  }
  async getTicket(ticket: string) {
    if (this.getTicketFailures > 0) {
      this.getTicketFailures--;
      throw new Error("db locked");
    }
    return { ticket_id: ticket, status: this.status.get(ticket) ?? "pending" } as ReplyTicketRecord;
  }
  async listPendingTickets() {
    return this.pending.filter((r) => (this.status.get(r.ticket_id) ?? "pending") === "pending");
  }
}

function ticketRecord(ticket: string, text: string): ReplyTicketRecord {
  return {
    ticket_id: ticket, self_id: "1", user_id: "10000001", group_id: null, message_type: "private",
    source_message_id: "900", source_nickname: "tester", source_text: text,
    created_at: "2026-10-17T00:00:00.000Z", status: "pending",
  };
}

function inbound(text: string, id = "100"): InboundMessage {
  return {
    message_id: id,
    time: 0,
    message_type: "private",
    user_id: "10000001",
    group_id: null,
    self_id: "1",
    nickname: "tester",
    text,
    truncated: false,
    mentioned_self: false,
    segments: [{ type: "text", data: { text } }],
  };
}

/** 从请求上下文中找最后一条工具结果文本。 */
function lastToolResult(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "toolResult") {
      return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    }
  }
  return "";
}

interface Rig {
  harness: Harness;
  dispatcher: Dispatcher;
  bridge: BridgeStub;
  faux: ReturnType<typeof fauxProvider>;
  toolCalls: string[];
  imageCalls: string[];
  dir: string;
  store: ContextStore;
}

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.harness.close(ctx);
  rig?.store.close();
  rig = undefined;
});

async function makeRig(getPrompt?: () => string): Promise<Rig> {
  const dir = tmp();
  const store = new ContextStore(dir);
  const bridge = new BridgeStub();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const imageCalls: string[] = [];
  const backend: ImageBackend = {
    name: "stub",
    selfCheck: async () => ({}),
    close: async () => {},
    generate: async (prompt, outDir) => {
      imageCalls.push(prompt);
      mkdirSync(outDir, { recursive: true });
      const f = path.join(outDir, "out.png");
      writeFileSync(f, "png");
      return [f];
    },
  };
  const codex = new CodexRunner({
    command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"),
    workspaceDir: path.join(dir, "ws"),
    sessionFile: path.join(dir, "codex-session.json"),
    sandbox: "workspace-write",
    timeoutMs: 10_000,
    env: { FAKE_CODEX_LOG: path.join(dir, "codex-calls.jsonl") },
  });
  const extension = createCsAgentExtension([
    createGenerateImageTool(backend, path.join(dir, "images")),
    createAskCodexTool(codex, { owner: "10000001", store }),
    createReplyQQTool(() => bridge, path.join(dir, "images")),
  ], getPrompt);
  const harness = await openHarness({ models, extension, storage: new MemoryStorage() }, ctx);
  harness.resume();
  const dispatcher = new Dispatcher({
    harness,
    bridge,
    model: { provider: "faux", modelId: faux.getModel().id },
    concurrency: 2,
    history: store,
  });
  const toolCalls: string[] = [];
  return { harness, dispatcher, bridge, faux, toolCalls, imageCalls, dir, store };
}

/** 包装 factory：记录本轮模型发起的工具调用。 */
function recording(r: Rig, f: FauxResponseFactory): FauxResponseFactory {
  return async (...args) => {
    const msg = await f(...args);
    for (const c of msg.content) if (c.type === "toolCall") r.toolCalls.push(c.name);
    return msg;
  };
}

describe("routing via faux provider", () => {
  it("image request → generate_image then reply_qq only, images attached, run terminates", async () => {
    rig = await makeRig();
    const r = rig;
    let systemPrompt = "";
    r.faux.setResponses([
      recording(r, (context) => {
        const sys = context.messages.find((m) => (m.role as string) === "system") as any;
        systemPrompt = JSON.stringify(sys ?? context.messages);
        return fauxAssistantMessage(fauxToolCall("generate_image", { prompt: "a cute cat, watercolor" }), { stopReason: "toolUse" });
      }),
      recording(r, (context) => {
        const { image_paths } = JSON.parse(lastToolResult(context.messages));
        return fauxAssistantMessage(fauxToolCall("reply_qq", { text: "图片生成好了", image_paths }), { stopReason: "toolUse" });
      }),
    ]);
    await r.dispatcher.dispatch(inbound("画一只水彩风格的可爱猫"), "ticket-img");
    expect(r.toolCalls).toEqual(["generate_image", "reply_qq"]);
    expect(r.imageCalls).toEqual(["a cute cat, watercolor"]);
    expect(r.bridge.replies).toHaveLength(1);
    expect(r.bridge.replies[0]).toMatchObject({ ticket: "ticket-img", text: "图片生成好了" });
    expect(r.bridge.replies[0]!.images).toEqual([realpathSync(path.join(r.dir, "images", "ticket-img", "out.png"))]);
    // terminate: 不再发起第三次模型请求
    expect(r.faux.state.callCount).toBe(2);
    expect(r.faux.getPendingResponseCount()).toBe(0);
    expect(systemPrompt).toContain("纯粹生图请求");
  });

  it("general request → ask_codex then reply_qq only; prompt carries source annotation", async () => {
    rig = await makeRig();
    const r = rig;
    r.faux.setResponses([
      recording(r, () =>
        fauxAssistantMessage(fauxToolCall("ask_codex", { prompt: "解释一下 TCP 三次握手", reasoning_effort: "medium" }), { stopReason: "toolUse" }),
      ),
      recording(r, (context) =>
        fauxAssistantMessage(fauxToolCall("reply_qq", { text: lastToolResult(context.messages) }), { stopReason: "toolUse" }),
      ),
    ]);
    await r.dispatcher.dispatch(inbound("TCP 三次握手是什么？"), "ticket-gen");
    expect(r.toolCalls).toEqual(["ask_codex", "reply_qq"]);
    expect(r.imageCalls).toEqual([]);
    expect(r.bridge.replies).toEqual([{ ticket: "ticket-gen", text: "answer to: 解释一下 TCP 三次握手", images: [] }]);
    expect(r.faux.state.callCount).toBe(2);
    // 意图模型选择的推理强度原样传给 codex
    const codexCalls = readFileSync(path.join(r.dir, "codex-calls.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const start = codexCalls.find((c) => c.phase === "start");
    expect(start.argv).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="medium"']));
  });

  it("user message content carries QQ source header; same ticket dispatched twice runs once", async () => {
    rig = await makeRig();
    const r = rig;
    let userText = "";
    r.faux.setResponses([
      recording(r, (context) => {
        const u = context.messages.find((m) => m.role === "user")!;
        userText = typeof u.content === "string" ? u.content : u.content.map((c: any) => c.text ?? "").join("");
        return fauxAssistantMessage(fauxToolCall("reply_qq", { text: "好的" }), { stopReason: "toolUse" });
      }),
    ]);
    await Promise.all([
      r.dispatcher.dispatch(inbound("你好"), "ticket-dup"),
      r.dispatcher.dispatch(inbound("你好"), "ticket-dup"),
    ]);
    await r.dispatcher.idle();
    expect(userText).toContain("[QQ 私聊，发送者 tester(10000001)]");
    expect(userText).toContain("你好");
    expect(r.bridge.replies).toHaveLength(1);
    expect(r.faux.state.callCount).toBe(1);
  });

  it("a second business tool call is refused by the guard", async () => {
    rig = await makeRig();
    const r = rig;
    let secondResult = "";
    r.faux.setResponses([
      recording(r, () => fauxAssistantMessage(fauxToolCall("generate_image", { prompt: "a dog" }), { stopReason: "toolUse" })),
      recording(r, () => fauxAssistantMessage(fauxToolCall("generate_image", { prompt: "another dog" }), { stopReason: "toolUse" })),
      recording(r, (context) => {
        secondResult = lastToolResult(context.messages);
        return fauxAssistantMessage(fauxToolCall("reply_qq", { text: "好了" }), { stopReason: "toolUse" });
      }),
    ]);
    await r.dispatcher.dispatch(inbound("画一只狗"), "ticket-guard");
    expect(r.imageCalls).toEqual(["a dog"]);
    expect(secondResult).toContain("禁止再次调用");
    expect(r.bridge.replies).toHaveLength(1);
  });

  it("model ends without reply_qq → one fallback reply", async () => {
    rig = await makeRig();
    const r = rig;
    r.faux.setResponses([fauxAssistantMessage(fauxText("我直接回答了"))]);
    await r.dispatcher.dispatch(inbound("hi"), "ticket-fb");
    expect(r.bridge.replies).toEqual([{ ticket: "ticket-fb", text: FALLBACK_REPLY, images: undefined }]);
  });

  it("reply_qq rejects an image path not produced by this conversation; model can retry", async () => {
    rig = await makeRig();
    const r = rig;
    const foreignDir = path.join(r.dir, "images", "other-ticket");
    mkdirSync(foreignDir, { recursive: true });
    const foreign = path.join(foreignDir, "x.png");
    writeFileSync(foreign, "png");
    let firstResult = "";
    r.faux.setResponses([
      recording(r, () => fauxAssistantMessage(fauxToolCall("generate_image", { prompt: "a cat" }), { stopReason: "toolUse" })),
      recording(r, () =>
        fauxAssistantMessage(fauxToolCall("reply_qq", { text: "给你", image_paths: [foreign] }), { stopReason: "toolUse" }),
      ),
      recording(r, (context) => {
        firstResult = lastToolResult(context.messages);
        return fauxAssistantMessage(fauxToolCall("reply_qq", { text: "图片生成好了" }), { stopReason: "toolUse" });
      }),
    ]);
    await r.dispatcher.dispatch(inbound("画猫"), "ticket-foreign");
    expect(firstResult).toContain("图片路径不合法");
    expect(r.bridge.replies).toEqual([{ ticket: "ticket-foreign", text: "图片生成好了", images: [] }]);
  });

  it("clears the dispatch index once the ticket is replied", async () => {
    rig = await makeRig();
    const r = rig;
    r.faux.setResponses([fauxAssistantMessage(fauxToolCall("reply_qq", { text: "好" }), { stopReason: "toolUse" })]);
    await r.dispatcher.dispatch(inbound("hi"), "ticket-clear");
    expect((await r.harness.snapshot(DispatchDoc, ctx))?.pending).toEqual({});
  });

  it("infra error keeps the dispatch index with attempts; recover gives up at the limit with one fallback", async () => {
    rig = await makeRig();
    const r = rig;
    r.faux.setResponses([fauxAssistantMessage(fauxText("没有回复"))]);
    r.bridge.getTicketFailures = 1;
    await r.dispatcher.dispatch(inbound("hi"), "ticket-infra");
    let pending = (await r.harness.snapshot(DispatchDoc, ctx))?.pending ?? {};
    expect(pending["ticket-infra"]?.attempts).toBe(1);
    expect(r.bridge.replies).toEqual([]);

    await r.harness.commit(async (tx) => {
      (await tx.doc(DispatchDoc)).pending["ticket-infra"]!.attempts = MAX_ATTEMPTS;
    }, ctx);
    // 兜底在发送前失败：票据仍 pending，索引保留（下次启动再试）
    r.bridge.replyDown = true;
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    pending = (await r.harness.snapshot(DispatchDoc, ctx))?.pending ?? {};
    expect(pending["ticket-infra"]).toBeDefined();

    r.bridge.replyDown = false;
    const calls = r.faux.state.callCount;
    await r.dispatcher.recover();
    await r.dispatcher.idle();
    expect(r.faux.state.callCount).toBe(calls); // 不再运行模型
    expect(r.bridge.replies).toEqual([{ ticket: "ticket-infra", text: FALLBACK_REPLY, images: undefined }]);
    expect((await r.harness.snapshot(DispatchDoc, ctx))?.pending).toEqual({});
  });

  it("recover re-dispatches a pending ticket that has no dispatch index (crash after admit)", async () => {
    rig = await makeRig();
    const r = rig;
    let userText = "";
    r.faux.setResponses([
      recording(r, (context) => {
        const u = context.messages.find((m) => m.role === "user")!;
        userText = typeof u.content === "string" ? u.content : u.content.map((c: any) => c.text ?? "").join("");
        return fauxAssistantMessage(fauxToolCall("reply_qq", { text: "收到" }), { stopReason: "toolUse" });
      }),
    ]);
    r.bridge.pending = [ticketRecord("ticket-orphan", "帮我看看这段代码"), ticketRecord("ticket-old", "")];
    expect(await r.dispatcher.recover()).toBe(2);
    await r.dispatcher.idle();
    expect(userText).toContain("[QQ 私聊，发送者 tester(10000001)]");
    expect(userText).toContain("帮我看看这段代码");
    expect(r.bridge.replies).toContainEqual({ ticket: "ticket-orphan", text: "收到", images: [] });
    // 迁移前无原文的旧票据只发兜底
    expect(r.bridge.replies).toContainEqual({ ticket: "ticket-old", text: FALLBACK_REPLY, images: undefined });
    expect(r.faux.state.callCount).toBe(1);
    expect(await r.dispatcher.recover()).toBe(0);
  });

  it("system prompt getter is consulted on every model request (hot reload)", async () => {
    let current = "PROMPT-MARKER-ONE";
    rig = await makeRig(() => current);
    const r = rig;
    const seen: string[] = [];
    const reply = (text: string): FauxResponseFactory => (context) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxToolCall("reply_qq", { text }), { stopReason: "toolUse" });
    };
    r.faux.setResponses([reply("一"), reply("二")]);
    await r.dispatcher.dispatch(inbound("a", "201"), "ticket-p1");
    current = "PROMPT-MARKER-TWO";
    await r.dispatcher.dispatch(inbound("b", "202"), "ticket-p2");
    expect(seen[0]).toContain("PROMPT-MARKER-ONE");
    expect(seen[1]).toContain("PROMPT-MARKER-TWO");
    expect(seen[1]).not.toContain("PROMPT-MARKER-ONE");
  });

  it("system prompt states the untrusted-content and one-tool rules", () => {
    expect(SYSTEM_PROMPT).toContain("不可信");
    expect(SYSTEM_PROMPT).toContain("恰好调用一次 reply_qq");
    expect(SYSTEM_PROMPT).toContain("reasoning_effort");
  });
});

describe("context store hooks", () => {
  const all = { kind: "all" } as const;
  const bot = (r: Rig) => r.store.recent(all, { limit: 10 }).filter((row) => row.is_self === 1);

  it("image request: pending row on admit, then prompt + image count + excerpt on reply", async () => {
    rig = await makeRig();
    const r = rig;
    let pendingSeen: string | null = null;
    r.faux.setResponses([
      () => {
        pendingSeen = bot(r)[0]?.status ?? null;
        return fauxAssistantMessage(fauxToolCall("generate_image", { prompt: "a cute dog, photorealistic" }), { stopReason: "toolUse" });
      },
      (context) => {
        const { image_paths } = JSON.parse(lastToolResult(context.messages));
        return fauxAssistantMessage(fauxToolCall("reply_qq", { text: "图片生成好了", image_paths }), { stopReason: "toolUse" });
      },
    ]);
    await r.dispatcher.dispatch(inbound("画一只狗", "300"), "ticket-h1");
    expect(pendingSeen).toBe("处理中");
    expect(bot(r)).toEqual([
      expect.objectContaining({
        scope: "private:10000001", ticket: "ticket-h1", action: "generate_image", detail: "a cute dog, photorealistic",
        text: "图片生成好了", image_count: 1, status: "已回复", reply_to_id: "300",
      }),
    ]);
  });

  it("codex request records the reasoning effort", async () => {
    rig = await makeRig();
    const r = rig;
    r.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("ask_codex", { prompt: "今晚有cs比赛吗", reasoning_effort: "high" }), { stopReason: "toolUse" }),
      (context) => fauxAssistantMessage(fauxToolCall("reply_qq", { text: lastToolResult(context.messages) }), { stopReason: "toolUse" }),
    ]);
    await r.dispatcher.dispatch(inbound("今晚有cs比赛吗", "301"), "ticket-h2");
    expect(bot(r)[0]).toMatchObject({ action: "ask_codex", detail: "high", status: "已回复" });
  });

  it("fallback marks the row 失败; a failed business tool marks it 失败 even if a reply was sent", async () => {
    rig = await makeRig();
    const r = rig;
    r.faux.setResponses([fauxAssistantMessage(fauxText("没调用工具"))]);
    await r.dispatcher.dispatch(inbound("hi", "302"), "ticket-h3");
    expect(bot(r).find((b) => b.ticket === "ticket-h3")).toMatchObject({ action: "fallback", status: "失败", text: FALLBACK_REPLY });

    r.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("ask_codex", { prompt: "x", reasoning_effort: "low" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxToolCall("reply_qq", { text: "处理失败了" }), { stopReason: "toolUse" }),
    ]);
    writeFileSync(path.join(r.dir, "codex-session.json"), JSON.stringify({ thread_id: "flaky-1" }));
    await r.dispatcher.dispatch(inbound("问个问题", "303"), "ticket-h4");
    expect(bot(r).find((b) => b.ticket === "ticket-h4")).toMatchObject({ action: "ask_codex", status: "失败", text: "处理失败了" });
  });

  it("history errors never break dispatch", async () => {
    rig = await makeRig();
    const r = rig;
    r.store.close(); // 之后所有写入都会抛错
    r.faux.setResponses([fauxAssistantMessage(fauxToolCall("reply_qq", { text: "好" }), { stopReason: "toolUse" })]);
    await r.dispatcher.dispatch(inbound("hi", "304"), "ticket-h5");
    expect(r.bridge.replies).toEqual([{ ticket: "ticket-h5", text: "好", images: [] }]);
  });
});

describe("ask_codex context injection", () => {
  const codexStarts = (r: Rig) =>
    readFileSync(path.join(r.dir, "codex-calls.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((c) => c.phase === "start");
  const askThenReply = (r: Rig) => [
    () => fauxAssistantMessage(fauxToolCall("ask_codex", { prompt: "那明天呢", reasoning_effort: "low" }), { stopReason: "toolUse" }),
    (context: { messages: Message[] }) =>
      fauxAssistantMessage(fauxToolCall("reply_qq", { text: lastToolResult(context.messages) }), { stopReason: "toolUse" }),
  ];

  it("group message: QQ_ACCESS=group:<id>, §3.2 header with the quoted message looked up from the store", async () => {
    rig = await makeRig();
    const r = rig;
    const quoted = { ...inbound("今晚有cs比赛吗", "400"), message_type: "group" as const, group_id: "200000001", user_id: "20001", nickname: "小明" };
    r.store.ingest(quoted);
    const msg: InboundMessage = {
      ...inbound("那明天呢", "401"), message_type: "group", group_id: "200000001", user_id: "20002", nickname: "De",
      time: Math.floor(new Date(2026, 9, 17, 22, 41).getTime() / 1000),
      segments: [{ type: "reply", data: { id: "400" } }, { type: "text", data: { text: "那明天呢" } }],
    };
    r.store.ingest(msg);
    r.faux.setResponses(askThenReply(r) as never);
    await r.dispatcher.dispatch(msg, "ticket-q1");
    const [start] = codexStarts(r);
    expect(start.argv).toEqual(expect.arrayContaining(["-c", 'mcp_servers.qq_context.env.QQ_ACCESS="group:200000001"']));
    expect(start.stdin).toBe("[来源] 群 200000001 · De(20002) · 2026-10-17 22:41\n[引用] 小明: 今晚有cs比赛吗\n那明天呢");
  });

  it("owner private → QQ_ACCESS=all; other private → private:<qq>; no quote line without a reply segment", async () => {
    rig = await makeRig();
    const r = rig;
    r.faux.setResponses([...askThenReply(r), ...askThenReply(r)] as never);
    await r.dispatcher.dispatch(inbound("那明天呢", "402"), "ticket-q2");
    await r.dispatcher.dispatch({ ...inbound("那明天呢", "403"), user_id: "555666" }, "ticket-q3");
    const [owner, other] = codexStarts(r);
    expect(owner.argv).toEqual(expect.arrayContaining(['mcp_servers.qq_context.env.QQ_ACCESS="all"']));
    expect(other.argv).toEqual(expect.arrayContaining(['mcp_servers.qq_context.env.QQ_ACCESS="private:555666"']));
    expect(owner.stdin).toMatch(/^\[来源\] 私聊 · tester\(10000001\) · \d{4}-\d\d-\d\d \d\d:\d\d\n那明天呢$/);
  });
});
