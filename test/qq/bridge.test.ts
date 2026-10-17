import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQQBridge, ticketIdFor, type InboundMessage, type QQBridge, type QQBridgeConfig } from "../../src/qq/index.js";
import { FakeOneBot, groupEvent, privateEvent, SELF_ID, TOKEN, waitFor } from "./fake-onebot.js";

const OWNER = "20001";
const STRANGER = "29999";
const GROUP = "30001";
const OTHER_GROUP = "39999";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);

let server: FakeOneBot;
let dataDir: string;
let imageRoot: string;
let bridge: QQBridge;
let received: { message: InboundMessage; ticket: string }[];
let errors: Error[];

function config(overrides: Partial<QQBridgeConfig> = {}): QQBridgeConfig {
  return {
    httpUrl: server.httpUrl, wsUrl: server.wsUrl, token: TOKEN,
    allowUsers: [OWNER], allowGroups: [GROUP], groupMentions: true,
    timeoutMs: 2000, dataDir, imageRoot, ...overrides,
  };
}

async function startBridge(overrides: Partial<QQBridgeConfig> = {}): Promise<QQBridge> {
  const b = createQQBridge(config(overrides), { reconnectBaseMs: 50, heartbeatMs: 60000 });
  b.on("message", (message, ticket) => received.push({ message, ticket }));
  b.on("error", e => errors.push(e));
  const connected = new Promise<void>(resolve => b.on("connection", resolve));
  await b.start();
  await connected;
  return b;
}

/** 推送一组事件，再推送一条必定触发的哨兵消息，等它到达以确认前面的事件已处理完。 */
async function pushAndFlush(...events: unknown[]): Promise<InboundMessage[]> {
  const before = received.length;
  for (const e of events) server.push(e);
  const sentinel = privateEvent(OWNER, "sentinel");
  server.push(sentinel);
  await waitFor(() => received.some(r => r.message.message_id === String(sentinel.message_id)), 5000, "sentinel");
  return received.slice(before).map(r => r.message).filter(m => m.text !== "sentinel");
}

async function triggerPrivate(text = "hello"): Promise<{ message: InboundMessage; ticket: string }> {
  const event = privateEvent(OWNER, text);
  server.push(event);
  await waitFor(() => received.some(r => r.message.message_id === String(event.message_id)));
  return received.find(r => r.message.message_id === String(event.message_id))!;
}

beforeEach(async () => {
  server = new FakeOneBot();
  await server.start();
  dataDir = mkdtempSync(join(tmpdir(), "qq-data-"));
  imageRoot = mkdtempSync(join(tmpdir(), "qq-images-"));
  received = [];
  errors = [];
  bridge = await startBridge();
});

afterEach(async () => {
  await bridge.stop();
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(imageRoot, { recursive: true, force: true });
});

describe("connection", () => {
  it("connects with bearer token and reports status", async () => {
    expect(server.wsAuthFailures).toBe(0);
    const status = bridge.status();
    expect(status.ws_connected).toBe(true);
    expect(status.self_id).toBe(SELF_ID);
    expect(status.disconnect_count).toBe(0);
    expect(server.calls[0]?.authorization).toBe("Bearer " + TOKEN);
    expect(existsSync(join(dataDir, "qq-bridge.sqlite"))).toBe(true);
  });

  it("reconnects after the server closes the socket", async () => {
    const reasons: string[] = [];
    bridge.on("disconnect", r => reasons.push(r));
    const reconnected = new Promise<void>(resolve => bridge.on("connection", resolve));
    server.dropAll();
    await waitFor(() => reasons.length === 1, 5000, "disconnect");
    expect(reasons[0]).toBe("server going away");
    await reconnected;
    expect(server.connections).toBe(2);
    expect(bridge.status()).toMatchObject({ ws_connected: true, disconnect_count: 1 });
    const got = await pushAndFlush(privateEvent(OWNER, "after reconnect"));
    expect(got.map(m => m.text)).toEqual(["after reconnect"]);
  });

  it("throttles reconnect errors: one per outage, then at most one per interval", async () => {
    const quietErrors: Error[] = [];
    const quiet = createQQBridge(config({ token: "bad-token" }), { reconnectBaseMs: 5, reconnectMaxMs: 5, heartbeatMs: 60000 });
    quiet.on("error", e => quietErrors.push(e));
    const before = server.wsAuthFailures;
    await quiet.start();
    await waitFor(() => server.wsAuthFailures - before >= 6, 5000, "reconnect attempts");
    await quiet.stop();
    expect(quietErrors.filter(e => e.message.includes("WebSocket")).length).toBe(1);

    const noisyErrors: Error[] = [];
    const noisy = createQQBridge(config({ token: "bad-token" }),
      { reconnectBaseMs: 5, reconnectMaxMs: 5, heartbeatMs: 60000, downReportIntervalMs: 0 });
    noisy.on("error", e => noisyErrors.push(e));
    const mark = server.wsAuthFailures;
    await noisy.start();
    await waitFor(() => server.wsAuthFailures - mark >= 3, 5000, "reconnect attempts");
    await noisy.stop();
    expect(noisyErrors.filter(e => e.message.includes("WebSocket")).length).toBeGreaterThanOrEqual(3);
  });

  it("reports connected→down once, not on every retry", async () => {
    const reasons: string[] = [];
    bridge.on("disconnect", r => reasons.push(r));
    server.dropAll();
    await waitFor(() => reasons.length === 1, 5000, "disconnect");
    expect(errors.filter(e => e.message.includes("连接断开")).length).toBe(1);
  });

  it("survives malformed frames", async () => {
    const got = await pushAndFlush("not json{", "[]", JSON.stringify({ post_type: "meta_event" }));
    expect(got).toEqual([]);
    expect(errors.length).toBe(1);
    expect(bridge.status().last_event_at).not.toBeNull();
  });
});

describe("auth and trigger rules", () => {
  it("owner private triggers; stranger private does not", async () => {
    const got = await pushAndFlush(privateEvent(STRANGER, "hi"), privateEvent(OWNER, "owner says hi"));
    expect(got.map(m => [m.user_id, m.text])).toEqual([[OWNER, "owner says hi"]]);
  });

  it("allowed group requires a real @ segment", async () => {
    const got = await pushAndFlush(
      groupEvent(GROUP, STRANGER, "no mention", false),
      groupEvent(GROUP, STRANGER, `@bot [CQ:at,qq=${SELF_ID}] text only`, false),
      groupEvent(GROUP, STRANGER, "real mention", true),
    );
    expect(got.map(m => m.text)).toEqual([`[at] real mention`]);
    expect(got[0]).toMatchObject({ group_id: GROUP, mentioned_self: true, nickname: "card-" + STRANGER });
  });

  it("non-allowed group member cannot trigger even with @; owner can anywhere", async () => {
    const got = await pushAndFlush(
      groupEvent(OTHER_GROUP, STRANGER, "stranger", true),
      groupEvent(OTHER_GROUP, OWNER, "owner", true),
    );
    expect(got.map(m => m.user_id)).toEqual([OWNER]);
  });

  it("groupMentions=false disables group triggers", async () => {
    await bridge.stop();
    bridge = await startBridge({ groupMentions: false });
    const got = await pushAndFlush(groupEvent(GROUP, OWNER, "x", true));
    expect(got).toEqual([]);
  });

  it("drops self-echo", async () => {
    const got = await pushAndFlush(privateEvent(SELF_ID, "echo"), groupEvent(GROUP, SELF_ID, "echo", true));
    expect(got).toEqual([]);
  });
});

describe("dedupe and tickets", () => {
  it("dedupes repeated events in memory and across restarts", async () => {
    const event = privateEvent(OWNER, "once");
    const first = await pushAndFlush(event, event);
    expect(first.length).toBe(1);

    await bridge.stop();
    bridge = await startBridge();
    const again = await pushAndFlush(event);
    expect(again).toEqual([]);
  });

  it("persists a pending ticket with deterministic id before emitting", async () => {
    const { message, ticket } = await triggerPrivate();
    expect(ticket).toBe(ticketIdFor(message));
    const record = await bridge.getTicket(ticket);
    expect(record).toMatchObject({
      ticket_id: ticket, self_id: SELF_ID, user_id: OWNER, group_id: null,
      message_type: "private", source_message_id: message.message_id, source_text: "hello", status: "pending",
    });
  });

  it("lists pending tickets in creation order and drops them once sent", async () => {
    const a = await triggerPrivate("first");
    const b = await triggerPrivate("second");
    let pending = await bridge.listPendingTickets();
    expect(pending.map(p => [p.ticket_id, p.source_text])).toEqual([[a.ticket, "first"], [b.ticket, "second"]]);
    expect((await bridge.listPendingTickets(1)).length).toBe(1);
    await bridge.reply(a.ticket, "ok");
    pending = await bridge.listPendingTickets();
    expect(pending.map(p => p.ticket_id)).toEqual([b.ticket]);
  });
});

describe("reply", () => {
  it("sends private reply, then returns already_sent on repeat", async () => {
    const { ticket } = await triggerPrivate();
    const result = await bridge.reply(ticket, "answer");
    expect(result).toMatchObject({ already_sent: false, message_type: "private", target_id: OWNER });
    const sends = server.sendCalls();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.action).toBe("send_private_msg");
    expect(sends[0]!.body).toEqual({ user_id: Number(OWNER), message: [{ type: "text", data: { text: "answer" } }] });

    const again = await bridge.reply(ticket, "answer");
    expect(again).toEqual({ ...result, already_sent: true });
    expect(server.sendCalls()).toHaveLength(1);
    const record = await bridge.getTicket(ticket);
    expect(record).toMatchObject({ status: "sent", reply_message_id: result.message_id });
    expect(record?.sent_at).toBeTruthy();
    expect(record?.attempted_at).toBeTruthy();
  });

  it("group reply prepends a real at segment and newline", async () => {
    const event = groupEvent(GROUP, STRANGER, "q", true);
    server.push(event);
    await waitFor(() => received.length === 1);
    const { ticket } = received[0]!;
    const result = await bridge.reply(ticket, "a");
    expect(result).toMatchObject({ message_type: "group", target_id: GROUP });
    const send = server.sendCalls()[0]!;
    expect(send.action).toBe("send_group_msg");
    expect(send.body).toEqual({
      group_id: Number(GROUP),
      message: [{ type: "at", data: { qq: STRANGER } }, { type: "text", data: { text: "\na" } }],
    });
  });

  it("marks uncertain on HTTP failure and never retries", async () => {
    const { ticket } = await triggerPrivate();
    server.override = c => (c.action === "send_private_msg" ? { http: 500 } : undefined);
    await expect(bridge.reply(ticket, "x")).rejects.toMatchObject({ uncertain: true, message: expect.stringMatching(/uncertain/) });
    expect((await bridge.getTicket(ticket))?.status).toBe("uncertain");
    server.override = null;
    await expect(bridge.reply(ticket, "x")).rejects.toThrow(/uncertain/);
    expect(server.sendCalls()).toHaveLength(1);
  });

  it("marks uncertain on retcode failure", async () => {
    const { ticket } = await triggerPrivate();
    server.override = c => (c.action === "send_private_msg" ? { body: { status: "failed", retcode: 100 } } : undefined);
    await expect(bridge.reply(ticket, "x")).rejects.toThrow();
    expect((await bridge.getTicket(ticket))?.status).toBe("uncertain");
  });

  it("rejects concurrent reply on the same ticket", async () => {
    const { ticket } = await triggerPrivate();
    server.override = c => (c.action === "send_private_msg" ? { delayMs: 300, body: { status: "ok", retcode: 0, data: { message_id: 1 } } } : undefined);
    const first = bridge.reply(ticket, "one");
    await expect(bridge.reply(ticket, "two")).rejects.toThrow(/正在回复/);
    await expect(first).resolves.toMatchObject({ already_sent: false, message_id: "1" });
    expect(server.sendCalls()).toHaveLength(1);
  });

  it("refuses when NapCat login account differs; ticket stays pending", async () => {
    const { ticket } = await triggerPrivate();
    server.loginUserId = "10002";
    await expect(bridge.reply(ticket, "x")).rejects.toThrow(/账号/);
    expect((await bridge.getTicket(ticket))?.status).toBe("pending");
    expect(server.sendCalls()).toHaveLength(0);
  });

  it("validates text and ticket", async () => {
    const { ticket } = await triggerPrivate();
    await expect(bridge.reply(ticket, "")).rejects.toThrow();
    await expect(bridge.reply(ticket, "x".repeat(4001))).rejects.toThrow();
    await expect(bridge.reply("nothex", "x")).rejects.toThrow(/凭据/);
    await expect(bridge.reply("a".repeat(64), "x")).rejects.toThrow(/不存在/);
  });

  it("attaches validated images as base64 segments", async () => {
    const { ticket } = await triggerPrivate();
    const path = join(imageRoot, "out.png");
    writeFileSync(path, PNG);
    await bridge.reply(ticket, "pic", [path]);
    expect(server.sendCalls()[0]!.body.message).toEqual([
      { type: "text", data: { text: "pic" } },
      { type: "image", data: { file: "base64://" + PNG.toString("base64") } },
    ]);
  });

  it("image validation failure leaves ticket pending and sends nothing", async () => {
    const { ticket } = await triggerPrivate();
    const bad = join(imageRoot, "bad.png");
    writeFileSync(bad, "this is not an image file");
    const outsideDir = mkdtempSync(join(tmpdir(), "qq-outside-"));
    const outside = join(outsideDir, "x.png");
    writeFileSync(outside, PNG);
    try {
      await expect(bridge.reply(ticket, "x", [bad])).rejects.toThrow(/PNG/);
      await expect(bridge.reply(ticket, "x", [outside])).rejects.toThrow(/目录/);
      const ok = join(imageRoot, "ok.png");
      writeFileSync(ok, PNG);
      await expect(bridge.reply(ticket, "x", [ok, ok, ok, ok, ok])).rejects.toThrow(/4/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
    expect((await bridge.getTicket(ticket))?.status).toBe("pending");
    expect(server.sendCalls()).toHaveLength(0);
  });
});

describe("send", () => {
  it("sends plain text to group and private", async () => {
    await expect(bridge.send("group", GROUP, "ops")).resolves.toMatchObject({ message_id: expect.any(String) });
    await bridge.send("private", OWNER, "ops2");
    expect(server.sendCalls().map(c => [c.action, c.body])).toEqual([
      ["send_group_msg", { group_id: Number(GROUP), message: [{ type: "text", data: { text: "ops" } }] }],
      ["send_private_msg", { user_id: Number(OWNER), message: [{ type: "text", data: { text: "ops2" } }] }],
    ]);
    await expect(bridge.send("private", "0123", "x")).rejects.toThrow();
  });

  it("send failure is reported as uncertain", async () => {
    server.override = () => ({ http: 503 });
    await expect(bridge.send("private", OWNER, "x")).rejects.toMatchObject({ uncertain: true });
  });
});
