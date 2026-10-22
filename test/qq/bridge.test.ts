import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQQBridge, inboundKey, type QQBridgeConfig } from "../../src/qq/index.js";
import type { InboundMessage, Channel } from "../../src/channel/types.js";
import { FakeOneBot, groupEvent, privateEvent, SELF_ID, TOKEN, waitFor } from "./fake-onebot.js";

const OWNER = "20001";
const STRANGER = "29999";
const GROUP = "30001";
const OTHER_GROUP = "39999";

let server: FakeOneBot;
let dataDir: string;
let imageRoot: string;
let bridge: Channel;
let received: { message: InboundMessage; key: string }[];
let errors: Error[];

function config(overrides: Partial<QQBridgeConfig> = {}): QQBridgeConfig {
  return {
    httpUrl: server.httpUrl, wsUrl: server.wsUrl, token: TOKEN,
    allowUsers: [OWNER], allowGroups: [GROUP], groupMentions: true,
    timeoutMs: 2000, dataDir, imageRoot, ...overrides,
  };
}

async function startBridge(overrides: Partial<QQBridgeConfig> = {}): Promise<Channel> {
  const b = createQQBridge(config(overrides), { reconnectBaseMs: 50, heartbeatMs: 60000 });
  b.on("message", (message, key) => received.push({ message, key }));
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
  await Promise.all(bridge.inbox.listInbound("queued").map(r => bridge.prepareIncoming?.(r.key)));
  return received.slice(before).map(r => r.message).filter(m => m.text !== "sentinel");
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


describe("文件上传", () => {
  it.each(["private", "group"] as const)("%s 使用 base64 和清洗文件名，不传 folder", async type => {
    server.override = call => call.action.startsWith("upload_") ? { body: { status: "ok", retcode: 0, data: { file_id: "file-id" } } } : undefined;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const file = Buffer.alloc(2 * 1024 * 1024, 1);
      expect(await bridge.uploadFile(type, type === "private" ? OWNER : GROUP, file, "../报\u0000告.txt".replace("\\u0000", "\u0000"))).toEqual({ file_id: "file-id" });
      const call = server.calls.find(c => c.action === "upload_" + type + "_file")!;
      expect(call.body).toEqual({ [type === "private" ? "user_id" : "group_id"]: Number(type === "private" ? OWNER : GROUP), file: "base64://" + file.toString("base64"), name: "报告.txt" });
      expect(timeout).toHaveBeenLastCalledWith(34_000);
    } finally { timeout.mockRestore(); }
  });

  it("超时最多 120 秒；缺少 file_id 或 API 失败视为不确定", async () => {
    const custom = createQQBridge(config({ timeoutMs: 119_000 }));
    server.override = call => call.action.startsWith("upload_") ? { body: { status: "ok", retcode: 0, data: {} } } : undefined;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await expect(custom.uploadFile("private", OWNER, Buffer.from("x"), "a.txt")).rejects.toThrow("不确定");
      expect(timeout).toHaveBeenLastCalledWith(120_000);
      server.override = call => call.action.startsWith("upload_") ? { http: 500 } : undefined;
      await expect(bridge.uploadFile("private", OWNER, Buffer.from("x"), "a.txt")).rejects.toThrow("不要重试");
    } finally { timeout.mockRestore(); }
  });
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

  it("reconnects after the server closes the socket; reports connected→down once, not on every retry", async () => {
    const reasons: string[] = [];
    bridge.on("disconnect", r => reasons.push(r));
    const reconnected = new Promise<void>(resolve => bridge.on("connection", resolve));
    server.dropAll();
    await waitFor(() => reasons.length === 1, 5000, "disconnect");
    expect(reasons[0]).toBe("server going away");
    expect(errors.filter(e => e.message.includes("连接断开")).length).toBe(1);
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

describe("dedupe and inbound keys", () => {
  it("dedupes repeated events in memory and across restarts", async () => {
    const event = privateEvent(OWNER, "once");
    const first = await pushAndFlush(event, event);
    expect(first.length).toBe(1);

    await bridge.stop();
    bridge = await startBridge();
    const again = await pushAndFlush(event);
    expect(again).toEqual([]);
  });

  it("persists a queued input with deterministic key before emitting", async () => {
    const event = privateEvent(OWNER, "hello");
    server.push(event);
    await waitFor(() => received.some(r => r.message.message_id === String(event.message_id)));
    const { message, key } = received.find(r => r.message.message_id === String(event.message_id))!;
    expect(key).toBe(inboundKey(message));
    expect(bridge.inbox.getInbound(key)).toMatchObject({
      key, kind: "user", self_id: SELF_ID, user_id: OWNER, group_id: null, scope: "private:" + OWNER, thread_key: "private:" + OWNER,
      message_type: "private", message_id: message.message_id, text: "hello", state: "queued",
    });
  });

});

describe("send", () => {
  it("sends plain text to group and private", async () => {
    await expect(bridge.sendOps("group", GROUP, "ops")).resolves.toMatchObject({ message_id: expect.any(String) });
    await bridge.sendOps("private", OWNER, "ops2");
    expect(server.sendCalls().map(c => [c.action, c.body])).toEqual([
      ["send_group_msg", { group_id: Number(GROUP), message: [{ type: "text", data: { text: "ops" } }] }],
      ["send_private_msg", { user_id: Number(OWNER), message: [{ type: "text", data: { text: "ops2" } }] }],
    ]);
    await expect(bridge.sendOps("private", "0123", "x")).rejects.toThrow();
  });

  it("send failure is reported as uncertain", async () => {
    server.override = () => ({ http: 503 });
    await expect(bridge.sendOps("private", OWNER, "x")).rejects.toMatchObject({ uncertain: true });
  });
});

describe("raw / recall feed", () => {
  it("emits raw for every allowed-scope message (triggered or not) before message; skips other scopes and self echo", async () => {
    const raws: InboundMessage[] = [];
    const order: string[] = [];
    bridge.on("raw", m => { raws.push(m); order.push("raw:" + m.message_id); });
    bridge.on("message", m => order.push("msg:" + m.message_id));
    const plain = groupEvent(GROUP, STRANGER, "随便聊聊", false);
    const mention = groupEvent(GROUP, STRANGER, "画只猫", true);
    const otherGroup = groupEvent(OTHER_GROUP, OWNER, "别的群", true);
    const stranger = privateEvent(STRANGER, "陌生人私聊");
    const echo = groupEvent(GROUP, SELF_ID, "自回声", false);
    await pushAndFlush(plain, mention, otherGroup, stranger, echo);
    const ids = raws.map(m => m.message_id);
    expect(ids).toContain(String(plain.message_id));
    expect(ids).toContain(String(mention.message_id));
    expect(ids).not.toContain(String(otherGroup.message_id));
    expect(ids).not.toContain(String(stranger.message_id));
    expect(ids).not.toContain(String(echo.message_id));
    const m = String(mention.message_id);
    expect(order.indexOf("raw:" + m)).toBeLessThan(order.indexOf("msg:" + m));
  });

  it("emits recall for group_recall / friend_recall in allowed scope only", async () => {
    const recalls: [string, string][] = [];
    bridge.on("recall", (scope, id) => recalls.push([scope, id]));
    await pushAndFlush(
      { post_type: "notice", notice_type: "group_recall", group_id: Number(GROUP), user_id: Number(STRANGER), operator_id: Number(STRANGER), message_id: 777, self_id: Number(SELF_ID) },
      { post_type: "notice", notice_type: "group_recall", group_id: Number(OTHER_GROUP), user_id: 1, message_id: 778, self_id: Number(SELF_ID) },
      { post_type: "notice", notice_type: "friend_recall", user_id: Number(OWNER), message_id: 779, self_id: Number(SELF_ID) },
      { post_type: "notice", notice_type: "friend_recall", user_id: Number(STRANGER), message_id: 780, self_id: Number(SELF_ID) },
    );
    expect(recalls).toEqual([["group:" + GROUP, "777"], ["private:" + OWNER, "779"]]);
  });

  it("a throwing raw listener does not block triggering", async () => {
    bridge.on("raw", () => { throw new Error("db down"); });
    const got = await pushAndFlush(privateEvent(OWNER, "still works"));
    expect(got.map(m => m.text)).toEqual(["still works"]);
    expect(errors.some(e => e.message.includes("db down"))).toBe(true);
  });
});

it("不在 allowUsers 中的第二 owner 仍触发、入库、接收原账号回复与撤回通知", async () => {
  await bridge.stop();
  const secondary = "10000002";
  bridge = await startBridge({ allowUsers: [], owners: [OWNER, secondary] });
  const raw = vi.fn(), recall = vi.fn();
  bridge.on("raw", raw); bridge.on("recall", recall);
  const messages = await pushAndFlush(privateEvent(secondary, "第二账号"), privateEvent(STRANGER, "陌生人"));
  expect(messages.map(message => message.user_id)).toEqual([secondary]);
  expect(raw.mock.calls.map(([message]) => message.user_id)).toContain(secondary);
  expect(raw.mock.calls.some(([message]) => message.user_id === STRANGER)).toBe(false);
  const receivedMessage = received.find(row => row.message.user_id === secondary)!;
  // owner 的多个账号共用 owner 线程，回复地址仍是原账号。
  expect(bridge.inbox.getInbound(receivedMessage.key)).toMatchObject({ thread_key: "owner", scope: "private:" + secondary });
  const row = bridge.outbox.reserveOutbox({ key: "owner:r1", thread_key: "owner", turn_id: null, input_key: receivedMessage.key,
    text: "回复第二账号", images: [], files: [], message_type: "private", target_id: secondary, mention_user_id: null });
  expect(await bridge.send(row.key, { message_type: "private", target_id: secondary }, "回复第二账号"))
    .toMatchObject({ target_id: secondary, message_type: "private", already_sent: false });
  server.push({ post_type: "notice", notice_type: "friend_recall", user_id: secondary, message_id: "recalled-owner" });
  server.push({ post_type: "notice", notice_type: "friend_recall", user_id: STRANGER, message_id: "recalled-stranger" });
  await pushAndFlush();
  expect(recall.mock.calls).toEqual([["private:" + secondary, "recalled-owner"]]);
});
