import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { markMessageRecalled, recall, withReplyContext } from "../src/context";
import { normalizeMessage } from "../src/policy";
import * as models from "../src/models";
import { MODEL_PROVIDERS } from "../src/models";
import { threadWithBindings } from "./thread-fixture";
import { action, connect, event, input, reply } from "./helpers";

describe("message context", () => {
  const sockets: WebSocket[] = [];
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); await reset(); vi.restoreAllMocks(); });
  
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
      vi.spyOn(models, "openModels").mockImplementation(() => {
        const registry = createModels();
        registry.setProvider(faux.provider);
        return registry;
      });
      const thread = env.THREAD.getByName("owner");
      const running = runInDurableObject(thread, async (_instance, state) => {
        // 替换模型边界，Thread、工具执行和 SQLite 均使用真实实现。
        const instance = threadWithBindings(_instance, state, env);
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
      expect(JSON.stringify(result.entries)).toContain("text: expected at most 4000 characters");
      expect(JSON.stringify(result.entries)).toContain("发送过快");
      expect(result.sent).toBe(0);
      expect(await runInDurableObject(thread, (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n)).toBe(0);
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
});

describe("quote context", () => {
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  function quotedInput() {
    const message = normalizeMessage({ ...event(2, "1", 10000001), message: [
      { type: "reply", data: { id: 1 } }, { type: "text", data: { text: "1" } },
    ] });
    if (!message) throw new Error("invalid_fixture");
    return message;
  }
  
  it.each(["文字", "图片"])("%s引用进入真实Thread回合，qq_context可按ID读原文", async kind => {
    const body = "这是一条完整原消息。".repeat(20) + "尾部重点";
    const original = normalizeMessage({ ...event(1, body, 10000001), ...(kind === "图片" ? {
      message: [{ type: "image", data: { url: "https://multimedia.nt.qq.com.cn/image.png" } }],
    } : {}) });
    if (!original) throw new Error("invalid_fixture");
    const thread = env.THREAD.getByName("owner");
    await thread.ingest(input(1, "另一个私聊的正文", 10000002));
    await thread.ingest(original);
    let modelInput = "", toolResult = "";
    const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const respond: FauxResponseFactory = async ctx => {
      faux.setResponses([respond]);
      const last = ctx.messages.at(-1);
      if (last?.role === "toolResult") {
        toolResult = JSON.stringify(last.content);
        return fauxAssistantMessage("done");
      }
      const user = ctx.messages.findLast(message => message.role === "user");
      modelInput = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
      return fauxAssistantMessage(fauxToolCall("qq_context", { message_id: "2" }), { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
    vi.spyOn(MODEL_PROVIDERS.faux, "create").mockReturnValue(faux.provider);
    expect(await thread.submit(quotedInput())).toEqual({ status: "done" });
    expect(modelInput).toContain('[引用消息（同一QQ会话）]');
    expect(modelInput).toContain('"message_id":"1"');
    expect(modelInput).toContain(kind === "文字" ? body : '"text":"[image]"');
    expect(modelInput).toContain('[当前消息]\n[reply]1');
    expect(modelInput).not.toContain("另一个私聊的正文");
    expect(toolResult).toContain(kind === "文字" ? "尾部重点" : "[image]");
    expect(toolResult).toContain("[message_id:2]");
    await runInDurableObject(thread, async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      expect(await recall(db, "private:10000001", { limit: 1 })).toContain("[reply_to_id:1]");
      expect(await db.get("SELECT text FROM messages WHERE scope=? AND message_id=?", "private:10000001", "2")).toEqual({ text: "[reply]1" });
    });
  });
  
  it("原消息未保存或已撤回时明确标注，不带出其他私聊原文", async () => {
    const thread = env.THREAD.getByName("owner");
    await thread.ingest(input(1, "另一个私聊的正文", 10000002));
    await thread.ingest(quotedInput());
    await runInDurableObject(thread, async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      const text = await withReplyContext(db, "private:10000001", "2", "[reply]1");
      expect(text).toContain("原消息未保存在当前会话中");
      expect(text).not.toContain("另一个私聊的正文");
    });
    await thread.ingest(input(1, "撤回前的正文", 10000001));
    await runInDurableObject(thread, async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      await markMessageRecalled(db, "private:10000001", "1");
      const text = await withReplyContext(db, "private:10000001", "2", "[reply]1");
      expect(text).toContain("原消息已撤回");
      expect(text).not.toContain("撤回前的正文");
      expect(await recall(db, "private:10000001", { message_id: "1" })).toBe("[message_id:1 已撤回]");
    });
  });
});
