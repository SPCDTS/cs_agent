import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { recall } from "../src/context";
import * as models from "../src/models";
import { ThreadDO } from "../src/thread";
import { action, connect, input, reply } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const socket of sockets.splice(0)) socket.close(); await reset(); });

describe("per-thread message context", () => {
  it("searches trigram and two-character Chinese terms with before and scope isolation", async () => {
    const thread = env.THREAD.getByName("owner");
    await thread.ingest(input(1, "战术讨论烟雾弹", 10000001));
    await thread.ingest(input(2, "今晚讨论比赛", 10000001));
    await thread.ingest(input(3, "另一个账号的烟雾弹", 10000002));
    await thread.ingest(input(1, "重复不覆盖", 10000001));
    const result = await runInDurableObject(thread, async (_instance, state) => {
      const database = new DurableObjectSqliteDatabase(state.storage);
      return { search: await recall(database, "private:10000001", { query: "烟雾弹" }),
        short: await recall(database, "private:10000001", { query: "比赛" }),
        before: await recall(database, "private:10000001", { before: 1700000002 }),
        recent: await recall(database, "private:10000001", { limit: 1 }),
        wildcard: await recall(database, "private:10000001", { query: "%" }),
        quotes: await recall(database, "private:10000001", { query: '" OR *' }),
        count: await database.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages") };
    });
    expect(result.search).toContain("11-15 06:13 成员10000001(10000001): 战术讨论烟雾弹");
    expect(result.search).not.toContain("另一个账号");
    expect(result.short).toContain("今晚讨论比赛");
    expect(result.before).not.toContain("今晚");
    expect(result.recent).not.toContain("烟雾弹");
    expect(result.wildcard).toContain("未找到");
    expect(result.quotes).toContain("未找到");
    expect(result.count?.n).toBe(3);
  });

  it("maintains FTS triggers on update/delete and caps recall to fifty messages", async () => {
    const thread = env.THREAD.getByName("group:200000001");
    for (let i = 1; i <= 55; i++) await thread.ingest(input(i, "烟雾弹", 10000004, 200000001));
    const result = await runInDurableObject(thread, async (_instance, state) => {
      const database = new DurableObjectSqliteDatabase(state.storage);
      await database.run("UPDATE messages SET text='闪光弹' WHERE message_id='1'");
      const updated = await recall(database, "group:200000001", { query: "闪光弹" });
      await database.run("DELETE FROM messages WHERE message_id='1'");
      return { updated, deleted: await recall(database, "group:200000001", { query: "闪光弹" }),
        count: (await recall(database, "group:200000001", { limit: 999 })).split("\n").length };
    });
    expect(result.updated).toContain("闪光弹");
    expect(result.deleted).toContain("未找到");
    expect(result.count).toBe(50);
  });

  it("executes the read-only qq_context tool inside Pi with current-turn scope and owner identity", async () => {
    const { socket, frames } = await connect(sockets);
    const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const respond: FauxResponseFactory = transcript => {
      faux.setResponses([respond]);
      const last = transcript.messages.at(-1);
      if (last?.role === "toolResult" && last.toolName === "qq_context") {
        const text = last.content.filter(block => block.type === "text").map(block => block.text).join("");
        return fauxAssistantMessage(fauxToolCall("send_message", { text }), { stopReason: "toolUse" });
      }
      if (last?.role === "toolResult") return fauxAssistantMessage("done");
      return fauxAssistantMessage(fauxToolCall("qq_context", { query: "烟雾弹", limit: 50 }), { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
    vi.spyOn(models, "openModels").mockImplementation(async () => {
      const registry = createModels();
      registry.setProvider(faux.provider);
      return { models: registry, selection: { provider: "faux", id: "test" } };
    });
    const thread = env.THREAD.getByName("owner");
    const running = runInDurableObject(thread, async (_instance, state) => {
      // 替换模型边界，Thread、工具执行和 SQLite 均使用真实实现。
      const instance = new ThreadDO(state, env);
      await instance.ingest(input(1, "本会话烟雾弹", 10000001));
      await instance.ingest(input(2, "另一会话烟雾弹", 10000002));
      return instance.submit(input(3, "请回忆烟雾弹", 10000001));
    });
    const frame = await action(frames, 0, "send_private_msg");
    expect(frame.params.message?.[0]?.data.text).toContain("本会话烟雾弹");
    expect(frame.params.message?.[0]?.data.text).not.toContain("另一会话");
    reply(socket, frame.echo);
    expect(await running).toEqual({ status: "done" });
    const entries = await runInDurableObject(thread, (_instance, state) => state.storage.sql.exec("SELECT * FROM pi_entries").toArray());
    expect(JSON.stringify(entries)).toContain("本回合的人：owner 成员10000001(10000001)，会话：私聊(10000001)");
    expect(JSON.stringify(entries)).toContain("qq_context");
  });

  it("returns send-rule rejections to the model without self history or outbox receipts", async () => {
    await connect(sockets);
    const thread = env.THREAD.getByName("private:10000003");
    expect(await thread.submit(input(1, "字".repeat(4000)))).toEqual({ status: "done" });
    await runInDurableObject(env.BRIDGE.getByName("napcat"), (_instance, state) => {
      for (let i = 0; i < 6; i++) state.storage.sql.exec("INSERT INTO send_log(scope, at) VALUES ('private:10000003', ?)", Date.now());
    });
    expect(await thread.submit(input(2, "第七条"))).toEqual({ status: "done" });
    const result = await runInDurableObject(thread, (_instance, state) => ({
      entries: state.storage.sql.exec("SELECT * FROM pi_entries").toArray(),
      sent: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE is_self = 1").one().n,
    }));
    expect(JSON.stringify(result.entries)).toContain("单条文字必须为 1～4000 字符");
    expect(JSON.stringify(result.entries)).toContain("发送过快");
    expect(result.sent).toBe(0);
    expect(await thread.stats()).toMatchObject({ outbox: 0 });
  });

  it("migrates the P0 inbound table without losing request IDs or replaying completed inputs", async () => {
    const thread = env.THREAD.getByName("owner");
    await runInDurableObject(thread, (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE inbound (message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, received_at INTEGER NOT NULL, status TEXT NOT NULL)");
      state.storage.sql.exec("INSERT INTO inbound VALUES ('1', '10000001', '旧记录', 1700000000, 'done')");
    });
    expect(await thread.submit(input(1, "重复", 10000001))).toEqual({ deduped: true });
    const rows = await runInDurableObject(thread, (_instance, state) => state.storage.sql.exec("SELECT message_id, platform_message_id, chat_kind, chat_id FROM inbound").toArray());
    expect(rows).toEqual([{ message_id: "1", platform_message_id: "1", chat_kind: "private", chat_id: "10000001" }]);
  });
});
