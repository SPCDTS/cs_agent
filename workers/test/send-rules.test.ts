import { env, SELF, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SendRules } from "../src/send-rules";
import { cleanOutgoing } from "../src/send-clean";
import { action, adminHealth, connect, input, reply, sendPrivate } from "./helpers";

describe("send rules suite", () => {
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
  
    it("persists the hourly breaker, exposes it in authenticated health and resets the expired window", async () => {
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
      expect(await (await adminHealth()).json()).toMatchObject({ sendRules: status.sendRules });
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
});

describe("send clean suite", () => {
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await reset();
  });
  
  describe("cleanOutgoing", () => {
    it("turns Markdown links into plain text with the URL in full-width parentheses", () => {
      expect(cleanOutgoing("详见[官方文档](https://developers.cloudflare.com/workers/?utm_source=openai)。"))
        .toBe("详见官方文档（https://developers.cloudflare.com/workers/）。");
      expect(cleanOutgoing("[https://a.example/x](https://a.example/x?utm_source=openai)")).toBe("https://a.example/x");
    });
  
    it("drops utm_* parameters from bare and parenthesised URLs and keeps everything else", () => {
      expect(cleanOutgoing("来源 (https://a.example/p?id=1&utm_source=openai)")).toBe("来源 (https://a.example/p?id=1)");
      expect(cleanOutgoing("见 https://a.example/s?utm_source=openai&utm_medium=x#top，谢谢")).toBe("见 https://a.example/s#top，谢谢");
      expect(cleanOutgoing("搜 https://a.example/s?q=%E4%B8%AD+文&b=1 即可")).toBe("搜 https://a.example/s?q=%E4%B8%AD+文&b=1 即可");
      const plain = "[注意] 价格(含税)为 [100] 元；数组 a[0](1)";
      expect(cleanOutgoing(plain)).toBe(plain);
    });
  
    it("strips hosted search PUA citation markers, preserves entity labels, and cleans adjacent URLs", () => {
      expect(cleanOutgoing("不是丢进JS运行时就能跑的服务。\uE200cite\uE202turn226540search0\uE201\n\n还要注意持久化。\uE200cite\uE202turn226540search2\uE202turn876495view0\uE201"))
        .toBe("不是丢进JS运行时就能跑的服务。\n\n还要注意持久化。");
      expect(cleanOutgoing("removed in v0.71.0 \uE200cite\uE202turn0view0\uE201. According to docs \uE200cite\uE202turn0search1\uE201 it works"))
        .toBe("removed in v0.71.0. According to docs it works");
      expect(cleanOutgoing("可用 \uE200entity\uE202[\"software\",\"Cloudflare Workers\",0]\uE201 部署，详见 https://developers.cloudflare.com/workers/?utm_source=openai\uE200cite\uE202turn0view0\uE201"))
        .toBe("可用 Cloudflare Workers 部署，详见 https://developers.cloudflare.com/workers/");
      expect(cleanOutgoing("截断尾部 \uE200cite\uE202turn99search")).toBe("截断尾部");
    });
  
    it("is applied to send_message before the text reaches NapCat", async () => {
      const { socket, frames } = await connect(sockets);
      // 测试配置的 faux 模型把输入原样回显成 send_message。
      const running = env.THREAD.getByName("owner").submit(input(1, "看[这里](https://a.example/d?utm_source=openai)\uE200cite\uE202turn1search0\uE201", 10000001));
      const frame = await action(frames, 0, "send_private_msg");
      expect(frame.params.message?.[0]?.data.text).toBe("echo: 看这里（https://a.example/d）");
      reply(socket, frame.echo);
      expect(await running).toEqual({ status: "done" });
    });
  });
});
