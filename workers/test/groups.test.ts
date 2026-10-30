import { env, SELF, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { action, connect, event, input, reply } from "./helpers";

const sockets: WebSocket[] = [];
const group = () => env.THREAD.getByName("group:200000001");
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); await reset(); });

describe("group conversations", () => {
  it("ingests allowed group chatter without starting Pi and persists the cached group name", async () => {
    const { socket, frames } = await connect(sockets);
    socket.send(JSON.stringify(event(1, "普通聊天", 10000004, 200000001)));
    await expect.poll(() => env.BRIDGE.getByName("napcat").status()).toMatchObject({ threads: ["group:200000001"] });
    await group().stats();
    await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec("SELECT text FROM messages").toArray()))
      .toEqual([{ text: "普通聊天" }]);
    expect(await group().stats()).toMatchObject({ inbound: { queued: 0, done: 0, failed: 0 }, outbox: 0 });
    expect(await runInDurableObject(group(), (_instance, state) => state.storage.sql.exec("SELECT scope, name FROM scope_names").toArray()))
      .toEqual([{ scope: "group:200000001", name: "测试群" }]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ action: "get_group_info" });
  });

  it("replies to a real group mention with at, records self history, and deduplicates across eviction", async () => {
    const { socket, frames } = await connect(sockets);
    const raw = event(2, "帮忙", 10000004, 200000001, true);
    socket.send(JSON.stringify(raw));
    const frame = await action(frames);
    expect(frame.params).toEqual({ group_id: "200000001", message: [
      { type: "at", data: { qq: "10000004" } }, { type: "text", data: { text: "echo: [@你]帮忙" } },
    ] });
    reply(socket, frame.echo);
    await expect.poll(() => group().stats()).toMatchObject({ inbound: { done: 1 }, outbox: 1 });
    const rows = await runInDurableObject(group(), (_instance, state) => ({
      messages: state.storage.sql.exec("SELECT scope, message_id, is_self, reply_to_id FROM messages ORDER BY id").toArray(),
      entries: state.storage.sql.exec("SELECT * FROM pi_entries").toArray(),
    }));
    expect(rows.messages).toEqual([
      { scope: "group:200000001", message_id: "2", is_self: 0, reply_to_id: null },
      { scope: "group:200000001", message_id: "90000001", is_self: 1, reply_to_id: "2" },
    ]);
    expect(JSON.stringify(rows.entries)).toContain("本回合的人：群成员 成员10000004(10000004)，会话：群 测试群(200000001)");
    expect(JSON.stringify(rows.entries)).toContain("绝不透露凭据");
    await evictDurableObject(env.BRIDGE.getByName("napcat"));
    await evictDurableObject(group());
    socket.send(JSON.stringify(raw));
    socket.send(JSON.stringify(event(3, "接着聊", 10000004, 200000001)));
    await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(3);
    expect(frames).toHaveLength(2);
    expect(await group().submit(input(2, "帮忙", 10000004, 200000001, true))).toEqual({ deduped: true });
    expect(await (await SELF.fetch("https://test/healthz")).json()).toMatchObject({ threads: ["group:200000001"], sendRules: [], thread: { outbox: 0 } });
  });

  it("ignores disallowed groups and admits allowUsers private messages", async () => {
    const { socket, frames } = await connect(sockets);
    socket.send(JSON.stringify(event(4, "不允许的群", 10000004, 200000002, true)));
    socket.send(JSON.stringify(event(5, "白名单私聊")));
    const frame = await action(frames, 0, "send_private_msg");
    expect(frame.params.user_id).toBe("10000003");
    reply(socket, frame.echo);
    await expect.poll(() => env.THREAD.getByName("private:10000003").stats()).toMatchObject({ inbound: { done: 1 } });
    expect(await env.BRIDGE.getByName("napcat").status()).toMatchObject({ ignored: 1, threads: ["private:10000003"] });
    expect(frames).toHaveLength(1);
  });

  it("queues different senders in arrival order and keeps each turn identity and at target", async () => {
    const { socket, frames } = await connect(sockets);
    const thread = group();
    const first = thread.submit(input(10, "一", 10000004, 200000001, true));
    const one = await action(frames);
    const second = thread.submit(input(11, "二", 10000005, 200000001, true));
    const third = thread.submit(input(12, "三", 10000006, 200000001, true));
    await expect.poll(() => thread.stats()).toMatchObject({ inbound: { queued: 3 } });
    reply(socket, one.echo, 90000010);
    const two = await action(frames, 1);
    expect(two.params.message?.[0]?.data.qq).toBe("10000005");
    reply(socket, two.echo, 90000011);
    const three = await action(frames, 2);
    expect(three.params.message?.[0]?.data.qq).toBe("10000006");
    reply(socket, three.echo, 90000012);
    expect(await Promise.all([first, second, third])).toEqual([{ status: "done" }, { status: "done" }, { status: "done" }]);
    const entries = await runInDurableObject(thread, (_instance, state) => state.storage.sql.exec("SELECT * FROM pi_entries").toArray());
    for (const id of [10000004, 10000005, 10000006]) expect(JSON.stringify(entries)).toContain(`群成员 成员${id}(${id})`);
  });

  it("submits same-sender followups with steer while the current tool is waiting", async () => {
    const { socket, frames } = await connect(sockets);
    const thread = group();
    const first = thread.submit(input(20, "一", 10000004, 200000001, true));
    const one = await action(frames);
    const second = thread.submit(input(21, "补充", 10000004, 200000001, true));
    await expect.poll(() => runInDurableObject(thread, (_instance, state) => state.storage.sql.exec("SELECT when_busy FROM inbound WHERE platform_message_id = '21'").toArray()))
      .toEqual([{ when_busy: "steer" }]);
    reply(socket, one.echo, 90000020);
    const two = await action(frames, 1);
    expect(one.params.message?.[0]?.data.qq).toBe("10000004");
    expect(two.params.message?.some(segment => segment.type === "at")).toBe(false);
    reply(socket, two.echo, 90000021);
    expect(await Promise.all([first, second])).toEqual([{ status: "done" }, { status: "done" }]);
    const submissions = await runInDurableObject(thread, (_instance, state) => state.storage.sql.exec<{ answer: number }>("SELECT json_extract(record, '$.answer') AS answer FROM pi_submissions ORDER BY id").toArray());
    // 插话与原输入由同一个最终 answer 结算，确实加入了当前回合。
    expect(submissions).toHaveLength(2);
    expect(submissions[0].answer).toBe(submissions[1].answer);
  });

  it("refreshes group names only after the six-hour cache expires", async () => {
    const { socket, frames } = await connect(sockets);
    socket.send(JSON.stringify(event(30, "第一条", 10000004, 200000001)));
    await group().stats();
    await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(1);
    const bridge = env.BRIDGE.getByName("napcat");
    const cache = await runInDurableObject(bridge, (_instance, state) => state.storage.get<{ name: string; expires: number }>("group:200000001"));
    expect(cache?.expires).toBeGreaterThan(Date.now() + 5 * 3600_000);
    await runInDurableObject(bridge, (_instance, state) => state.storage.put("group:200000001", { name: "旧名", expires: 0 }));
    socket.send(JSON.stringify(event(31, "第二条", 10000004, 200000001)));
    await action(frames, 1, "get_group_info");
    await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(2);
    expect(frames).toHaveLength(2);
  });

  it("does not let a same-sender followup overtake an already queued member", async () => {
    const { socket, frames } = await connect(sockets);
    const thread = group();
    const first = thread.submit(input(40, "一", 10000004, 200000001, true));
    const one = await action(frames);
    const second = thread.submit(input(41, "二", 10000005, 200000001, true));
    const third = thread.submit(input(42, "三", 10000004, 200000001, true));
    await expect.poll(() => runInDurableObject(thread, (_instance, state) => state.storage.sql.exec("SELECT when_busy FROM inbound WHERE platform_message_id = '42'").toArray()))
      .toEqual([{ when_busy: "followUp" }]);
    reply(socket, one.echo, 90000040);
    const two = await action(frames, 1);
    expect(two.params.message?.[0]?.data.qq).toBe("10000005");
    reply(socket, two.echo, 90000041);
    const three = await action(frames, 2);
    expect(three.params.message?.[0]?.data.qq).toBe("10000004");
    reply(socket, three.echo, 90000042);
    expect(await Promise.all([first, second, third])).toEqual([{ status: "done" }, { status: "done" }, { status: "done" }]);
  });

  it("bounds bridge deduplication to 5000 and health thread listings to 50", async () => {
    const { socket } = await connect(sockets);
    const bridge = env.BRIDGE.getByName("napcat");
    await runInDurableObject(bridge, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let i = 0; i < 5000; i++) state.storage.sql.exec("INSERT INTO seen(key) VALUES (?)", `old:${i}`);
        for (let i = 0; i < 60; i++) state.storage.sql.exec("INSERT INTO threads(key, seen_at) VALUES (?, ?)", `group:${200000010 + i}`, i);
      });
    });
    socket.send(JSON.stringify(event(50, "新的上下文", 10000004, 200000001)));
    await expect.poll(() => bridge.status()).toMatchObject({ threads: expect.arrayContaining(["group:200000001"]) });
    expect((await bridge.status()).threads).toHaveLength(50);
    expect(await runInDurableObject(bridge, (_instance, state) => ({
      count: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM seen").one().n,
      oldest: state.storage.sql.exec<{ key: string }>("SELECT key FROM seen ORDER BY id LIMIT 1").one().key,
    }))).toEqual({ count: 5000, oldest: "old:1" });
    await group().stats();
    await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(1);
  });
});
