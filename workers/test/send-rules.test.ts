import { env, SELF, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SendRules } from "../src/send-rules";
import { action, connect, reply, sendPrivate } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); await reset(); });

describe("durable send rules", () => {
  it("accepts six concurrent sends and rejects the seventh without counting it", async () => {
    const { socket, frames } = await connect(sockets);
    const settled = Promise.allSettled(Array.from({ length: 7 }, (_, n) => sendPrivate(`消息${n}`)));
    for (let i = 0; i < 6; i++) reply(socket, (await action(frames, i, "send_private_msg")).echo, 90000000 + i);
    const results = await settled;
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(6);
    const failure = results.find(result => result.status === "rejected");
    expect(failure?.status === "rejected" ? String(failure.reason) : "").toContain("发送过快");
    expect(frames).toHaveLength(6);
    expect(await runInDurableObject(env.BRIDGE.getByName("napcat"), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM send_log").one().n)).toBe(6);
  });

  it("rejects 4001 characters before sending and permits exactly 4000", async () => {
    const { socket, frames } = await connect(sockets);
    await expect(sendPrivate("字".repeat(4001))).rejects.toThrow("4000");
    expect(frames).toEqual([]);
    const sending = sendPrivate("字".repeat(4000));
    reply(socket, (await action(frames, 0, "send_private_msg")).echo);
    expect(await sending).toEqual({ message_id: "90000001" });
    expect(await runInDurableObject(env.BRIDGE.getByName("napcat"), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM send_log").one().n)).toBe(1);
  });

  it("persists the hourly breaker, exposes it in healthz and resets the expired window", async () => {
    await connect(sockets);
    const bridge = env.BRIDGE.getByName("napcat");
    await runInDurableObject(bridge, (_instance, state) => {
      for (let i = 0; i < 60; i++) state.storage.sql.exec("INSERT INTO send_log(scope, at) VALUES (?, ?)", "private:10000003", Date.now() - 120_000);
    });
    await expect(sendPrivate("第61条")).rejects.toThrow("暂停本会话发送 60 分钟");
    await evictDurableObject(bridge);
    const status = await bridge.status();
    expect(status.sendRules).toMatchObject([{ scope: "private:10000003", reason: "每小时超过 60 条" }]);
    const breaker = status.sendRules[0];
    expect(breaker.until - breaker.tripped_at).toBe(3600_000);
    expect(await (await SELF.fetch("https://test/healthz")).json()).toMatchObject({ sendRules: status.sendRules });
    await expect(sendPrivate("再试")).rejects.toThrow("发送已熔断");
    const reset = await runInDurableObject(bridge, (_instance, state) => {
      const rules = new SendRules(state.storage);
      return { accepted: rules.accept("private:10000003", "到期", breaker.until + 1), breakers: rules.breakers(breaker.until + 1),
        count: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM send_log").one().n };
    });
    expect(reset).toEqual({ accepted: undefined, breakers: [], count: 1 });
  });

  it("trips the global minute breaker across scopes and blocks other chats for ten minutes", async () => {
    const result = await runInDurableObject(env.BRIDGE.getByName("napcat"), (_instance, state) => {
      const rules = new SendRules(state.storage), now = Date.now();
      const accepted = Array.from({ length: 30 }, (_, i) => rules.accept(`group:${200000001 + Math.floor(i / 6)}`, "成功", now));
      const rejected = rules.accept("private:10000003", "第31条", now);
      return { accepted, rejected, another: rules.accept("group:200000006", "另一群", now + 1), breakers: rules.breakers(now),
        count: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM send_log").one().n };
    });
    expect(result.accepted.every(value => value === undefined)).toBe(true);
    expect(result.rejected).toContain("暂停全部发送 10 分钟");
    expect(result.another).toContain("全部会话发送已熔断");
    expect(result.breakers[0].until - result.breakers[0].tripped_at).toBe(600_000);
    expect(result.count).toBe(30);
  });
});
