import { AsyncLocalStorage } from "node:async_hooks";
import { env, SELF, runDurableObjectAlarm, runInDurableObject, evictDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MODEL_PROVIDERS } from "../src/models";
import { ThreadDO } from "../src/thread";
import { threadView } from "../src/admin/read-views";
import { MemoryExtractor, MEMORY_EXTRACT_PROMPT } from "../src/memory/extractor";
import { normalizeMessage } from "../src/policy";
import { adminHealth, input as helperInput } from "./helpers";

describe("worker bridge", () => {
  const sockets: WebSocket[] = [];
  const Action = Type.Object({
    action: Type.Literal("send_private_msg"), echo: Type.String(),
    params: Type.Object({ user_id: Type.String(), message: Type.Array(Type.Object({ type: Type.Literal("text"), data: Type.Object({ text: Type.String() }) })) }),
  });
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  
  // Vitest 的 rejects 会继续调用 then；先 await RPC thenable，避免运行时把链上的拒绝报成未处理。
  async function sendPrivate(text: string) {
    return await env.BRIDGE.getByName("napcat").sendPrivate("10000001", text);
  }
  
  async function connect(query = false) {
    const response = await SELF.fetch(`https://test/onebot${query ? "?access_token=t" : ""}`, {
      headers: query ? { Upgrade: "websocket" } : { Upgrade: "websocket", Authorization: "Bearer t" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("missing websocket");
    socket.accept();
    sockets.push(socket);
    const frames: unknown[] = [];
    socket.addEventListener("message", event => { frames.push(JSON.parse(String(event.data))); });
    return { socket, frames };
  }
  
  function message(messageId: number, text = "你好", userId = 10000001) {
    return { post_type: "message", message_type: "private", self_id: 42, user_id: userId,
      message_id: messageId, time: 1700000000,
      message: [{ type: "text", data: { text } }] };
  }
  
  function input(messageId: string, text: string, userId = "10000001") {
    const value = normalizeMessage(message(Number(messageId), text, Number(userId)));
    if (!value) throw new Error("invalid fixture");
    return value;
  }
  
  async function action(frames: unknown[], index = 0) {
    await expect.poll(() => frames.length, { timeout: 5000 }).toBeGreaterThan(index);
    const frame = frames[index];
    if (!Check(Action, frame)) throw new Error("invalid OneBot action");
    return frame;
  }
  
  function reply(socket: WebSocket, echo: string, messageId = 99) {
    socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: messageId }, echo }));
  }
  
  async function inboundStatus(id: string) {
    return runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
      state.storage.sql.exec<{ status: string }>("SELECT status FROM inbound WHERE platform_message_id = ?", id).toArray()[0]?.status,
    );
  }
  
  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of sockets.splice(0)) socket.close();
    await reset();
  });
  
  describe("OneBot reverse WebSocket", () => {
    it("rejects absent/wrong tokens before upgrade and accepts both token transports", async () => {
      for (const headers of [new Headers(), new Headers({ Authorization: "Bearer wrong" })]) {
        expect((await SELF.fetch("https://test/onebot", { headers })).status).toBe(401);
      }
      expect((await SELF.fetch("https://test/onebot?access_token=wrong", { headers: { Upgrade: "websocket" } })).status).toBe(401);
      await connect();
      await connect(true);
      expect((await SELF.fetch("https://test/onebot", { headers: { Authorization: "Bearer t" } })).status).toBe(426);
      expect((await SELF.fetch("https://test/spike")).status).toBe(404);
    });
  
    it("runs Pi, sends text segments, persists the receipt, and deduplicates redelivery", async () => {
      const { socket, frames } = await connect();
      socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "lifecycle", self_id: 42 }));
      const event = message(1);
      event.message.push({ type: "text", data: { text: "，主人" } });
      socket.send(JSON.stringify(event));
      const frame = await action(frames);
      expect(frame.params).toEqual({ user_id: "10000001", message: [{ type: "text", data: { text: "echo: 你好，主人" } }] });
      reply(socket, frame.echo);
      await expect.poll(() => inboundStatus("1")).toBe("done");
      const outbox = await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
        state.storage.sql.exec("SELECT message_id, text FROM outbox").toArray());
      expect(outbox).toEqual([{ message_id: "99", text: "echo: 你好，主人" }]);
      expect(await (await adminHealth()).json()).toMatchObject({
        overall: "ready", bridge: { connected: true, selfId: "42", ignored: 0 }, model: { provider: "faux", id: "test" },
      });
      socket.send(JSON.stringify(event));
      expect(await env.THREAD.getByName("owner").submit(input("1", "重复", "10000001"))).toEqual({ deduped: true });
      await pause(1000);
      expect(frames).toHaveLength(1);
    });
  
    it("ignores unauthorized private and group messages, and survives malformed frames", async () => {
      const { socket, frames } = await connect();
      socket.send("{broken");
      socket.send(JSON.stringify(message(2, "stranger", 20000002)));
      socket.send(JSON.stringify({ ...message(3, "stranger", 20000002), message_type: "group", group_id: 200000002 }));
      socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 43 }));
      await expect.poll(() => env.BRIDGE.getByName("napcat").status()).toMatchObject({ connected: true, selfId: "43", ignored: 2 });
      expect(frames).toEqual([]);
    });
  
    it("restores the hibernating connection and durable deduplication after eviction", async () => {
      const { socket, frames } = await connect();
      socket.send(JSON.stringify({ post_type: "meta_event", self_id: 42 }));
      await expect.poll(() => env.BRIDGE.getByName("napcat").status()).toMatchObject({ selfId: "42" });
      await evictDurableObject(env.BRIDGE.getByName("napcat"));
      socket.send(JSON.stringify(message(4, "休眠后")));
      const frame = await action(frames);
      expect(frame.params.message[0]?.data.text).toBe("echo: 休眠后");
      reply(socket, frame.echo);
      await expect.poll(() => inboundStatus("4")).toBe("done");
      await evictDurableObject(env.THREAD.getByName("owner"));
      expect(await env.THREAD.getByName("owner").submit(input("4", "重复", "10000001"))).toEqual({ deduped: true });
      socket.send(JSON.stringify(message(5, "第二轮")));
      const second = await action(frames, 1);
      expect(second.params.message[0]?.data.text).toBe("echo: 第二轮");
      reply(socket, second.echo, 100);
      await expect.poll(() => inboundStatus("5")).toBe("done");
    });
  
    it("keeps each queued input bound to its own recipient", async () => {
      const { socket, frames } = await connect();
      const thread = env.THREAD.getByName("owner");
      const first = thread.submit(input("6", "first", "10000001"));
      const frame = await action(frames);
      const second = thread.submit(input("7", "second", "10000002"));
      expect(frame.params.user_id).toBe("10000001");
      reply(socket, frame.echo);
      const next = await action(frames, 1);
      expect(next.params).toMatchObject({ user_id: "10000002", message: [{ data: { text: "echo: second" } }] });
      reply(socket, next.echo, 100);
      expect(await Promise.all([first, second])).toEqual([{ status: "done" }, { status: "done" }]);
    });
  
    it("queues delivery while disconnected without writing a successful outbox receipt", async () => {
      await expect(sendPrivate("offline")).rejects.toThrow("channel_down");
      expect(await env.THREAD.getByName("owner").submit(input("8", "offline", "10000001"))).toEqual({ status: "done" });
      const rows = await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) => ({
        sent: state.storage.sql.exec("SELECT * FROM outbox").toArray(),
        intents: state.storage.sql.exec("SELECT state FROM outgoing_intents").toArray(),
      }));
      expect(rows.sent).toEqual([]);
      expect(rows.intents).toEqual([{ state: "queued" }]);
    });
  
    it("replaces the old connection and rejects its pending API call", async () => {
      const old = await connect();
      const call = sendPrivate("pending");
      const rejected = expect(call).rejects.toThrow("onebot_disconnected");
      await action(old.frames);
      const current = await connect();
      await rejected;
      const next = env.BRIDGE.getByName("napcat").sendPrivate("10000001", "new");
      const frame = await action(current.frames);
      reply(current.socket, frame.echo);
      expect(await next).toEqual({ message_id: "99" });
      expect(await env.BRIDGE.getByName("napcat").status()).toMatchObject({ connected: true });
    });
  
    it("correlates echo responses and rejects nonzero retcode", async () => {
      const { socket, frames } = await connect();
      const call = sendPrivate("failure");
      const rejected = expect(call).rejects.toThrow("onebot_failed");
      const frame = await action(frames);
      reply(socket, "unrelated");
      socket.send(JSON.stringify({ status: "failed", retcode: 100, data: null, echo: frame.echo }));
      await rejected;
    });
  
    it("times out an unanswered action after 15 seconds", async () => {
      const { frames, socket } = await connect();
      const sent = new Promise<void>(resolve => socket.addEventListener("message", () => resolve(), { once: true }));
      await runInDurableObject(env.BRIDGE.getByName("napcat"), async instance => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          let settled = false;
          const call = instance.sendPrivate("10000001", "timeout").finally(() => { settled = true; });
          const rejected = expect(call).rejects.toThrow("onebot_timeout");
          await sent;
          await vi.advanceTimersByTimeAsync(14_999);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          await rejected;
        } finally { vi.useRealTimers(); }
      });
      await action(frames);
      expect(frames).toHaveLength(1);
    });
  });
});

describe("agent alarm dispatch", () => {
  const input = helperInput;
  afterEach(async () => { vi.restoreAllMocks(); await reset(); });
  
  it("persists input before execution, keeps history passive, and runs tool continuations from the alarm", async () => {
    const origin = new AsyncLocalStorage<string>();
    const starts: (string | undefined)[] = [];
    const provider = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const respond: FauxResponseFactory = transcript => {
      provider.setResponses([respond]);
      if (transcript.messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith(MEMORY_EXTRACT_PROMPT))) return fauxAssistantMessage("[]");
      starts.push(origin.getStore());
      return starts.length === 1
        ? fauxAssistantMessage(fauxToolCall("qq_context", {}), { stopReason: "toolUse" })
        : fauxAssistantMessage("已完成上下文检索");
    };
    provider.setResponses([respond]);
    vi.spyOn(MODEL_PROVIDERS.faux, "create").mockReturnValue(provider.provider);
    const thread = env.THREAD.getByName("owner");
    const alarm = ThreadDO.prototype.alarm;
    const delivery = vi.spyOn(ThreadDO.prototype, "alarm").mockResolvedValue();
    const pending = thread.submit(input(601, "读取上下文", 10000001));
    await expect.poll(() => delivery.mock.calls.length).toBeGreaterThan(0);
    expect(await runInDurableObject(thread, (_instance, state) =>
      state.storage.sql.exec("SELECT status,when_busy FROM inbound").toArray())).toEqual([{ status: "queued", when_busy: null }]);
    await thread.syncAdminView("owner");
    await threadView(env, "owner").sessionHistory("owner");
    expect(starts).toEqual([]);
    delivery.mockImplementation(function (this: ThreadDO) { return origin.run("alarm", () => alarm.call(this)); });
    await runInDurableObject(thread, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
    await runDurableObjectAlarm(thread);
    expect(await pending).toEqual({ status: "done" });
    expect(starts).toEqual(["alarm", "alarm"]);
    expect(await thread.submit(input(601, "重复投递", 10000001))).toEqual({ deduped: true });
    await runDurableObjectAlarm(thread);
    expect(starts).toHaveLength(2);
    await expect.poll(() => runInDurableObject(thread, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });
  
  it("accepts another message while background memory extraction is waiting", async () => {
    const extracting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(MemoryExtractor.prototype, "drain").mockImplementationOnce(async () => {
      extracting.resolve(); await release.promise;
    });
    const provider = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    provider.setResponses([fauxAssistantMessage("第一轮完成"), fauxAssistantMessage("第二轮完成")]);
    vi.spyOn(MODEL_PROVIDERS.faux, "create").mockReturnValue(provider.provider);
    const thread = env.THREAD.getByName("owner");
    try {
      expect(await thread.submit(input(602, "第一条", 10000001))).toEqual({ status: "done" });
      await extracting.promise;
      expect(await thread.submit(input(603, "第二条", 10000001))).toEqual({ status: "done" });
    } finally { release.resolve(); }
  });
});
